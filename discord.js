import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { EmbedBuilder, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';

const VINTED_DOMAIN = 'https://www.vinted.fr';

/**
 * Transforme un titre en slug URL Vinted (fallback si l'API ne renvoie pas item.url).
 */
function toItemSlug(title) {
  return (title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Extrait le chemin canonique /items/{id}-{slug} depuis l'URL Vinted.
 */
function getItemActionPath(itemUrl, item) {
  try {
    const pathname = new URL(itemUrl).pathname.replace(/\/$/, '');

    if (pathname.includes('/items/')) {
      return pathname;
    }

    const match = pathname.match(/(\d+)(?:-[^/]+)?$/);
    if (match) {
      const suffix = pathname.slice(pathname.lastIndexOf(`/${match[1]}`));
      return `/items${suffix}`;
    }

    const slug = toItemSlug(item.title);
    return slug ? `/items/${item.id}-${slug}` : `/items/${item.id}`;
  } catch {
    const slug = toItemSlug(item.title);
    return slug ? `/items/${item.id}-${slug}` : `/items/${item.id}`;
  }
}

/**
 * Construit les URLs Vinted (annonce, achat, message) à partir des données API.
 * Vinted a supprimé les anciennes routes /transaction/buy et /want_it (404).
 * Le site utilise désormais /member/signup/select_type avec des paramètres d'action.
 * @param {Object} item - Article Vinted
 * @returns {{ itemUrl: string, buyUrl: string, messageUrl: string, offerUrl: string }}
 */
function buildVintedActionUrls(item) {
  let itemUrl;

  if (item.url) {
    itemUrl = item.url.startsWith('http')
      ? item.url
      : `${VINTED_DOMAIN}${item.url.startsWith('/') ? item.url : `/${item.url}`}`;
  } else if (item.path) {
    const path = item.path.startsWith('/') ? item.path : `/${item.path}`;
    itemUrl = `${VINTED_DOMAIN}${path}`;
  } else {
    const slug = toItemSlug(item.title);
    itemUrl = slug
      ? `${VINTED_DOMAIN}/items/${item.id}-${slug}`
      : `${VINTED_DOMAIN}/items/${item.id}`;
  }

  const itemPath = getItemActionPath(itemUrl, item);
  const encodedRefUrl = encodeURIComponent(itemPath);
  const sellerId = item.user?.id;

  const buyUrl = `${VINTED_DOMAIN}/member/signup/select_type?button_name=buy&ch=item&ref_url=${encodedRefUrl}&source=checkout`;

  const messageUrl = sellerId
    ? `${VINTED_DOMAIN}/member/signup/select_type?button_name=message&ch=item&receiver_id=${sellerId}&ref_url=${encodedRefUrl}&source=wantit`
    : itemUrl;

  const offerUrl = sellerId
    ? `${VINTED_DOMAIN}/member/signup/select_type?button_name=offer&ch=item&receiver_id=${sellerId}&ref_url=${encodedRefUrl}&source=offer`
    : itemUrl;

  return { itemUrl, buyUrl, messageUrl, offerUrl };
}

/**
 * Génère des étoiles emoji basées sur la note positive du vendeur (échelle de 0 à 1 ou de 0 à 5).
 * @param {number} rating - Note positive (ex: 0.95 pour 95% ou 4.8 pour 4.8/5)
 * @returns {string} Chaîne d'étoiles (ex: ⭐⭐⭐⭐⭐)
 */
function getRatingStars(rating) {
  if (!rating) return 'Pas d\'évaluations';
  
  // Si le rating est sous forme de pourcentage (entre 0 et 1)
  let scoreOutOfFive = rating;
  if (rating <= 1) {
    scoreOutOfFive = rating * 5;
  }
  
  const rounded = Math.round(scoreOutOfFive);
  return '⭐'.repeat(Math.max(1, Math.min(5, rounded)));
}

/**
 * Extrait et formate le prix d'un champ prix Vinted.
 * @param {*} priceField - Objet ou valeur prix
 * @returns {{ amount: string, currency: string, raw: number }}
 */
function parsePrice(priceField) {
  if (!priceField) return { amount: 'N/A', currency: '€', raw: 0 };
  const rawAmount = typeof priceField === 'object' ? priceField.amount : priceField;
  const currency = typeof priceField === 'object' && priceField.currency_code === 'EUR' ? '€' : (typeof priceField === 'object' ? priceField.currency_code : '€');
  const parsed = parseFloat(rawAmount || 0);
  return {
    amount: parsed ? `${parsed.toFixed(2)} ${currency}` : 'N/A',
    currency,
    raw: parsed
  };
}

/**
 * Envoie une alerte produit Vinted sur Discord via un Webhook.
 * Supporte les pings de rôles, le bouton de négociation, et les alertes de baisse de prix.
 * 
 * @param {string} webhookUrl - L'URL du Webhook Discord
 * @param {Object} item - L'objet article retourné par l'API Vinted
 * @param {Object} [options={}] - Options avancées
 * @param {string} [options.ping] - Texte de ping à envoyer avant l'embed (ex: "@everyone", "<@&1234567890>")
 * @param {Object} [options.priceDrop] - Infos de baisse de prix, si applicable
 * @param {number} [options.priceDrop.oldPrice] - Ancien prix
 * @param {number} [options.priceDrop.newPrice] - Nouveau prix
 */
export async function sendDiscordAlert(webhookUrl, item, options = {}) {
  try {
    const { itemUrl, buyUrl, messageUrl, offerUrl } = buildVintedActionUrls(item);

    // Extraire l'URL de l'image de façon robuste
    let imageUrl = '';
    if (item.photo && item.photo.url) {
      imageUrl = item.photo.url;
    } else if (item.photos && item.photos[0] && item.photos[0].url) {
      imageUrl = item.photos[0].url;
    }
    
    const price = parsePrice(item.price);
    const totalPrice = parsePrice(item.total_item_price);

    const brand = item.brand_title || 'Sans marque';
    const size = item.size_title || 'N/A';
    const title = item.title || 'Sans titre';
    
    // Infos vendeur
    const sellerName = item.user?.login || 'Inconnu';
    const sellerFeedback = item.user?.feedback_count ? `(${item.user.feedback_count} avis)` : '(0 avis)';
    const sellerStars = getRatingStars(item.user?.positive_feedback_rating);

    // --- Déterminer le type d'alerte ---
    const isPriceDrop = !!(options.priceDrop);

    // Couleur de l'embed : vert pour baisse de prix, cyan Vinted par défaut
    const embedColor = isPriceDrop ? 0x2ecc71 : 0x00c1b7;

    // Titre de l'embed
    let embedTitle;
    if (isPriceDrop) {
      const oldP = options.priceDrop.oldPrice.toFixed(2);
      const newP = options.priceDrop.newPrice.toFixed(2);
      const pct = (((options.priceDrop.oldPrice - options.priceDrop.newPrice) / options.priceDrop.oldPrice) * 100).toFixed(0);
      embedTitle = `📉 BAISSE DE PRIX (-${pct}%) • ${title}`;
    } else {
      embedTitle = `🆕 ${title}`;
    }

    // Construire les champs de l'embed
    const fields = [];

    // Champ prix (avec ancien prix barré pour les baisses)
    if (isPriceDrop) {
      fields.push({
        name: '💰 Prix',
        value: `~~${options.priceDrop.oldPrice.toFixed(2)} €~~ → **${options.priceDrop.newPrice.toFixed(2)} €**`,
        inline: true
      });
    } else {
      fields.push({
        name: '💰 Prix',
        value: totalPrice.raw ? `**${price.amount}**\n*(Total : ${totalPrice.amount})*` : `**${price.amount}**`,
        inline: true
      });
    }

    fields.push(
      { name: '🏷️ Marque', value: brand, inline: true },
      { name: '📐 Taille', value: size, inline: true },
      {
        name: '👤 Vendeur',
        value: `${sellerName} ${sellerFeedback}\n${sellerStars}`,
        inline: false
      },
      {
        name: '⚡ Actions',
        value: 'Utilisez les **boutons** sous ce message pour acheter ou négocier.',
        inline: false
      }
    );

    const embed = {
      title: embedTitle,
      url: itemUrl,
      color: embedColor,
      thumbnail: imageUrl ? { url: imageUrl } : undefined,
      fields,
      footer: {
        text: isPriceDrop ? 'Vinted Sniper Bot • Alerte Baisse de Prix' : 'Vinted Sniper Bot • Nouvelle Annonce'
      },
      timestamp: new Date().toISOString()
    };

    // Construire le payload (avec ping optionnel en "content")
    const payload = {
      embeds: [embed],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: 'Acheter en 1-clic',
              url: buyUrl
            },
            {
              type: 2,
              style: 5,
              label: 'Négocier',
              url: offerUrl
            },
            {
              type: 2,
              style: 5,
              label: 'Message vendeur',
              url: messageUrl
            },
            {
              type: 2,
              style: 5,
              label: 'Voir l\'annonce',
              url: itemUrl
            }
          ]
        }
      ]
    };

    // Si un ping est configuré, on l'envoie comme contenu textuel (avant l'embed)
    if (options.ping && options.ping.trim() !== '') {
      payload.content = options.ping;
    }

    await axios.post(webhookUrl, payload, {
      headers: { 'Content-Type': 'application/json' }
    });

    const alertType = isPriceDrop ? '📉 BAISSE' : '🆕 NOUVEAU';
    console.log(`[DISCORD] ${alertType} • Alerte envoyée pour l'article ${item.id} (${title} - ${price.amount})`);
  } catch (error) {
    console.error(`[DISCORD] Échec de l'envoi de l'alerte sur Discord:`, error.message);
  }
}

// ═══════════════════════════════════════════════════
//  BASE DE DONNÉES DES AVIS (reviews.json)
// ═══════════════════════════════════════════════════

function getReviews(configPath) {
  const reviewsPath = path.join(path.dirname(configPath), 'reviews.json');
  if (!fs.existsSync(reviewsPath)) {
    try {
      fs.writeFileSync(reviewsPath, '[]', 'utf-8');
    } catch (_) {}
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(reviewsPath, 'utf-8'));
  } catch (err) {
    console.error('[DISCORD] Erreur lors de la lecture des avis:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════
//  BASE DE DONNÉES DES TICKETS (tickets.json)
// ═══════════════════════════════════════════════════

function getTickets(configPath) {
  const ticketsPath = path.join(path.dirname(configPath), 'tickets.json');
  if (!fs.existsSync(ticketsPath)) {
    try {
      fs.writeFileSync(ticketsPath, '[]', 'utf-8');
    } catch (_) {}
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(ticketsPath, 'utf-8'));
  } catch (err) {
    console.error('[DISCORD] Erreur lors de la lecture des tickets:', err.message);
    return [];
  }
}

function saveTickets(configPath, tickets) {
  const ticketsPath = path.join(path.dirname(configPath), 'tickets.json');
  try {
    fs.writeFileSync(ticketsPath, JSON.stringify(tickets, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DISCORD] Erreur lors de l\'enregistrement des tickets:', err.message);
  }
}

// ═══════════════════════════════════════════════════
//  COMMANDES SLASH & GESTIONNAIRE D'INTERACTION
// ═══════════════════════════════════════════════════

export const SLASH_COMMANDS = [
  {
    name: 'status',
    description: 'Affiche le statut actuel du sniper Vinted et du serveur'
  },
  {
    name: 'reviews',
    description: 'Affiche les avis des membres et les statistiques globales du bot'
  },
  {
    name: 'search-list',
    description: 'Liste toutes les recherches Vinted configurées'
  },
  {
    name: 'search-add',
    description: 'Ajoute une nouvelle recherche Vinted à surveiller',
    options: [
      {
        name: 'nom',
        description: 'Nom descriptif de la recherche (ex: Nike Air Max)',
        type: 3, // STRING
        required: true
      },
      {
        name: 'url',
        description: 'URL de recherche Vinted complète avec order=newest_first',
        type: 3, // STRING
        required: true
      },
      {
        name: 'ping',
        description: 'Mention de rôle ou d\'utilisateur lors d\'une alerte (ex: @everyone, <@&ID>)',
        type: 3, // STRING
        required: false
      },
      {
        name: 'webhook',
        description: 'URL du Webhook Discord spécifique pour cette recherche (facultatif)',
        type: 3, // STRING
        required: false
      }
    ]
  },
  {
    name: 'search-remove',
    description: 'Supprime une recherche configurée par son numéro ou son nom',
    options: [
      {
        name: 'index_ou_nom',
        description: 'Numéro de la recherche (ex: 1) ou son nom exact',
        type: 3, // STRING
        required: true
      }
    ]
  },
  {
    name: 'config-view',
    description: 'Affiche la configuration actuelle des filtres de sécurité'
  },
  {
    name: 'config-scam',
    description: 'Active ou désactive le filtre anti-scam de sécurité',
    options: [
      {
        name: 'actif',
        description: 'Mettre "true" pour activer, "false" pour désactiver',
        type: 5, // BOOLEAN
        required: true
      }
    ]
  },
  {
    name: 'setup-roles',
    description: 'Envoie le panneau interactif d\'auto-rôles avec boutons dans le salon actuel'
  }
];

/**
 * Traite les interactions de commandes Slash et de boutons.
 * @param {import('discord.js').ChatInputCommandInteraction|import('discord.js').ButtonInteraction} interaction 
 * @param {string} configPath 
 */
export async function handleInteraction(interaction, configPath) {
  // Gestion de la soumission de formulaire (Modal)
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'modal_laisser_avis') {
      const noteStr = interaction.fields.getTextInputValue('input_avis_note');
      const commentaire = interaction.fields.getTextInputValue('input_avis_commentaire');
      const user = interaction.user;

      const note = parseInt(noteStr.trim(), 10);
      if (isNaN(note) || note < 1 || note > 5) {
        return interaction.reply({
          content: '❌ **Erreur** : La note doit être un chiffre unique compris entre 1 et 5 ! Veuillez réessayer.',
          ephemeral: true
        });
      }

      // Lire les avis existants
      const reviews = getReviews(configPath);

      // Détecter si l'utilisateur a déjà laissé un avis pour le mettre à jour
      const existingIdx = reviews.findIndex(r => r.userId === user.id);

      const reviewData = {
        userId: user.id,
        username: user.username,
        avatarUrl: user.displayAvatarURL({ dynamic: true }),
        note: note,
        commentaire: commentaire,
        timestamp: new Date().toISOString()
      };

      let isUpdate = false;
      if (existingIdx !== -1) {
        reviews[existingIdx] = reviewData;
        isUpdate = true;
      } else {
        reviews.push(reviewData);
      }

      // Enregistrer
      saveReviews(configPath, reviews);

      const starsStr = '⭐'.repeat(note);
      
      // Rechercher le salon contenant "avis" (ex: avis-membres, avis, etc.)
      const avisChannel = interaction.guild.channels.cache.find(c => c.name.includes('avis'));

      if (!avisChannel) {
        return interaction.reply({
          content: '❌ Salon de destination contenant "avis" introuvable.',
          ephemeral: true
        });
      }

      const embedTitle = isUpdate 
        ? `💬 Avis mis à jour de ${user.username}`
        : `💬 Nouvel avis de ${user.username}`;

      const reviewEmbed = new EmbedBuilder()
        .setTitle(embedTitle)
        .setColor(0x00c1b7)
        .setThumbnail(user.displayAvatarURL({ dynamic: true }))
        .addFields(
          { name: '⭐ Évaluation', value: `${starsStr} (${note}/5)` },
          { name: '📝 Commentaire', value: commentaire }
        )
        .setFooter({ text: 'Vinted Sniper Bot • Avis Clients' })
        .setTimestamp();

      try {
        await avisChannel.send({ embeds: [reviewEmbed] });

        const successMsg = isUpdate
          ? `💖 Votre évaluation a été mise à jour avec succès et publiée dans ${avisChannel} !`
          : `💖 Merci beaucoup pour votre évaluation ! Elle a été publiée dans ${avisChannel}.`;

        return interaction.reply({
          content: successMsg,
          ephemeral: true
        });
      } catch (err) {
        return interaction.reply({
          content: `❌ Impossible d'envoyer votre avis : ${err.message}`,
          ephemeral: true
        });
      }
    }
    return;
  }

  // Lire la config actuelle à chaud
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (error) {
    return interaction.reply({ content: `❌ Impossible de lire le fichier config.json : ${error.message}`, ephemeral: true });
  }

  if (interaction.isButton()) {
    const { customId } = interaction;
    
    // Bouton d'acceptation du règlement pour donner le rôle Membre
    if (customId === 'btn_accepter_reglement') {
      const member = interaction.member;
      if (!member) return;

      const memberRole = interaction.guild.roles.cache.find(r => r.name === '👤 Membre');

      if (!memberRole) {
        return interaction.reply({
          content: '❌ **Erreur** : Le rôle `👤 Membre` est introuvable sur ce serveur. Veuillez contacter un administrateur.',
          ephemeral: true
        });
      }

      if (member.roles.cache.has(memberRole.id)) {
        return interaction.reply({
          content: 'ℹ️ **Info** : Vous avez déjà accepté le règlement et possédez le rôle `👤 Membre` ! Vous pouvez déjà voir tous les salons.',
          ephemeral: true
        });
      }

      try {
        await member.roles.add(memberRole);
        return interaction.reply({
          content: '✅ **Règlement accepté !** Bienvenue sur le serveur. Le rôle `👤 Membre` vous a été attribué et tous les salons publics vous sont désormais ouverts ! 🎉',
          ephemeral: true
        });
      } catch (err) {
        console.error('[DISCORD] Impossible d\'attribuer le rôle Membre :', err.message);
        return interaction.reply({
          content: `❌ **Erreur** : Impossible de vous attribuer le rôle : ${err.message}. Veuillez vérifier que le rôle du Bot est au-dessus du rôle \`👤 Membre\` dans les paramètres du serveur.`,
          ephemeral: true
        });
      }
    }

    // Déclencheur du bouton pour laisser un avis
    if (customId === 'btn_laisser_avis') {
      const modal = new ModalBuilder()
        .setCustomId('modal_laisser_avis')
        .setTitle('Évaluez le Bot Sniper 🎯');

      const noteInput = new TextInputBuilder()
        .setCustomId('input_avis_note')
        .setLabel('Note (de 1 à 5)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Ex: 5')
        .setMinLength(1)
        .setMaxLength(1)
        .setRequired(true);

      const commentaireInput = new TextInputBuilder()
        .setCustomId('input_avis_commentaire')
        .setLabel('Votre commentaire')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Ex: Le bot est super rapide, les pings fonctionnent nickel !')
        .setMinLength(5)
        .setMaxLength(1000)
        .setRequired(true);

      const firstRow = new ActionRowBuilder().addComponents(noteInput);
      const secondRow = new ActionRowBuilder().addComponents(commentaireInput);

      modal.addComponents(firstRow, secondRow);

      try {
        await interaction.showModal(modal);
      } catch (err) {
        console.error('[DISCORD] Erreur lors de l\'affichage de la modal:', err.message);
      }
      return;
    }
    if (customId === 'btn_ouvrir_ticket') {
      const guild = interaction.guild;
      const user = interaction.user;
      if (!guild) return;

      const tickets = getTickets(configPath);

      const existingTicket = tickets.find(t => t.userId === user.id);
      if (existingTicket) {
        const channel = guild.channels.cache.get(existingTicket.channelId);
        if (channel) {
          return interaction.reply({
            content: `❌ Vous avez déjà un ticket ouvert dans ${channel} !`,
            ephemeral: true
          });
        }
      }

      let ticketsCategory = guild.channels.cache.find(c => c.name === '🎫 TICKETS' && c.type === 4);
      if (!ticketsCategory) {
        try {
          ticketsCategory = await guild.channels.create({
            name: '🎫 TICKETS',
            type: 4,
            permissionOverwrites: [
              {
                id: guild.id,
                deny: [PermissionFlagsBits.ViewChannel]
              }
            ]
          });
        } catch (err) {
          return interaction.reply({
            content: `❌ Impossible de créer la catégorie des tickets : ${err.message}`,
            ephemeral: true
          });
        }
      }

      try {
        const ticketChannel = await guild.channels.create({
          name: `ticket-${user.username.slice(0, 15)}`,
          type: 0,
          parent: ticketsCategory.id,
          permissionOverwrites: [
            {
              id: guild.id,
              deny: [PermissionFlagsBits.ViewChannel]
            },
            {
              id: user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.AttachFiles
              ]
            },
            {
              id: interaction.client.user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.EmbedLinks
              ]
            }
          ]
        });

        tickets.push({
          channelId: ticketChannel.id,
          userId: user.id,
          username: user.username,
          mode: 'bot',
          timestamp: new Date().toISOString()
        });
        saveTickets(configPath, tickets);

        const welcomeEmbed = new EmbedBuilder()
          .setTitle('🤖 Assistant Virtuel HMZ Sniper')
          .setDescription(
            `Bonjour ${user} ! Bienvenue dans votre espace d'assistance privé.\n\n` +
            `Posez-moi vos questions ici (ex: *"Comment fonctionne le bot ?"*, *"Où payer ?"*, etc.). **Je répondrai instantanément !**\n\n` +
            `💡 Si ma réponse automatique ne vous satisfait pas, cliquez sur le bouton ci-dessous pour parler à un **humain**.`
          )
          .setColor(0x00c1b7)
          .setFooter({ text: 'HMZ Sniper Support • Chatbot Actif' });

        const ticketRow = {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: '🙋 Parler à un Humain',
              custom_id: 'btn_parler_humain'
            }
          ]
        };

        await ticketChannel.send({ content: `${user}`, embeds: [welcomeEmbed], components: [ticketRow] });

        return interaction.reply({
          content: `✅ Votre ticket a été créé avec succès dans ${ticketChannel} !`,
          ephemeral: true
        });
      } catch (err) {
        return interaction.reply({
          content: `❌ Impossible de créer le salon du ticket : ${err.message}`,
          ephemeral: true
        });
      }
    }

    if (customId === 'btn_parler_humain') {
      const tickets = getTickets(configPath);
      const ticketIdx = tickets.findIndex(t => t.channelId === interaction.channelId);

      if (ticketIdx === -1) {
        return interaction.reply({
          content: '❌ Ce salon n\'est pas un ticket actif enregistré.',
          ephemeral: true
        });
      }

      const ticket = tickets[ticketIdx];
      if (ticket.mode === 'human') {
        return interaction.reply({
          content: 'ℹ️ Le mode humain est déjà actif dans ce salon. Un modérateur va vous répondre.',
          ephemeral: true
        });
      }

      tickets[ticketIdx].mode = 'human';
      saveTickets(configPath, tickets);

      const humanEmbed = new EmbedBuilder()
        .setTitle('🔔 Mode Humain Activé')
        .setDescription(
          `Notre équipe d'administration et de modération a été notifiée et va prendre le relais pour vous répondre sous peu.\n\n` +
          `🤖 *L'assistant virtuel est maintenant désactivé pour ce ticket.*`
        )
        .setColor(0xe67e22)
        .setTimestamp();

      await interaction.reply({ embeds: [humanEmbed] });

      const adminChannel = interaction.guild.channels.cache.find(c => c.name.includes('config-bot') || c.name.includes('logs'));
      if (adminChannel) {
        try {
          const alertEmbed = new EmbedBuilder()
            .setTitle('🚨 ASSISTANCE HUMAINE DEMANDÉE')
            .setDescription(
              `**Ticket :** ${interaction.channel}\n` +
              `**Utilisateur :** <@${ticket.userId}> (\`${ticket.username}\`)\n\n` +
              `Veuillez vous rendre sur le salon pour lui répondre.`
            )
            .setColor(0xe74c3c)
            .setTimestamp();
          await adminChannel.send({ content: '@everyone', embeds: [alertEmbed] });
        } catch (_) {}
      }
      return;
    }

    if (customId.startsWith('role_')) {
      const roleName = customId.substring(5); // ex: "Nike"
      const guild = interaction.guild;
      if (!guild) return;

      const cleanSearchName = roleName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const role = guild.roles.cache.find(r => {
        const cleanRoleName = r.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        return cleanRoleName.includes(cleanSearchName);
      });

      if (!role) {
        return interaction.reply({ content: `❌ Rôle associé à "${roleName}" introuvable sur le serveur.`, ephemeral: true });
      }

      const member = interaction.member;
      if (!member) return;

      try {
        if (member.roles.cache.has(role.id)) {
          await member.roles.remove(role.id);
          return interaction.reply({ content: `🔴 Rôle **${role.name}** retiré ! Vous ne recevrez plus ses mentions d'alertes.`, ephemeral: true });
        } else {
          await member.roles.add(role.id);
          return interaction.reply({ content: `🟢 Rôle **${role.name}** attribué ! Vous recevrez désormais ses mentions d'alertes.`, ephemeral: true });
        }
      } catch (err) {
        return interaction.reply({ content: `❌ Impossible de modifier vos rôles. Vérifiez que le rôle du Bot est positionné au-dessus des rôles de marques dans les paramètres Discord.`, ephemeral: true });
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'status') {
    const uptimeSeconds = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = uptimeSeconds % 60;
    const uptimeStr = `${hours}h ${minutes}m ${seconds}s`;

    const activeSearches = (config.searches || []).filter(s => s.enabled !== false).length;
    const totalSearches = (config.searches || []).length;

    // Calculer les statistiques des avis
    const reviews = getReviews(configPath);
    let ratingStatsStr = 'Aucun avis';
    if (reviews.length > 0) {
      const totalRating = reviews.reduce((sum, r) => sum + r.note, 0);
      const avgRating = (totalRating / reviews.length).toFixed(1);
      const roundedAvg = Math.round(avgRating);
      const stars = '⭐'.repeat(Math.max(1, Math.min(5, roundedAvg)));
      ratingStatsStr = `${stars} **${avgRating}/5** (${reviews.length} avis)`;
    }

    const embed = new EmbedBuilder()
      .setTitle('🎯 Vinted Sniper Bot • Table de Contrôle')
      .setColor(0x00c1b7)
      .addFields(
        { name: '🟢 État du Service', value: 'Actif & Opérationnel', inline: true },
        { name: '⏱️ Uptime du Bot', value: uptimeStr, inline: true },
        { name: '⚡ Intervalle de Scan', value: `${(config.checkIntervalMs || 5000) / 1000}s`, inline: true },
        { name: '🔍 Recherches Actives', value: `**${activeSearches}** / ${totalSearches}`, inline: true },
        { name: '🛡️ Filtre Anti-Scam', value: config.antiScam?.enabled ? '✅ Actif' : '❌ Inactif', inline: true },
        { name: '🚫 Mots Exclus', value: `**${config.excludedKeywords?.length || 0}** mots`, inline: true },
        { name: '⭐ Évaluations Membres', value: ratingStatsStr, inline: false }
      )
      .setFooter({ text: 'Vinted Sniper Bot v2.0 PRO' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'reviews') {
    const reviews = getReviews(configPath);

    if (reviews.length === 0) {
      const emptyEmbed = new EmbedBuilder()
        .setTitle('⭐ AVIS & STATISTIQUES')
        .setDescription('Aucun avis n\'a encore été enregistré. Soyez le premier à donner votre avis en cliquant sur le bouton dans le salon #⭐・avis-membres !')
        .setColor(0x00c1b7)
        .setTimestamp();
      return interaction.reply({ embeds: [emptyEmbed] });
    }

    const totalReviews = reviews.length;
    const totalRating = reviews.reduce((sum, r) => sum + r.note, 0);
    const avgRating = (totalRating / totalReviews).toFixed(1);
    const roundedAvg = Math.round(avgRating);
    const avgStars = '⭐'.repeat(Math.max(1, Math.min(5, roundedAvg)));

    // Compter la répartition des notes (de 1 à 5)
    const ratingCounts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    reviews.forEach(r => {
      if (ratingCounts[r.note] !== undefined) {
        ratingCounts[r.note]++;
      }
    });

    // Générer les barres de répartition textuelles
    const barLength = 10;
    const statsLines = [];
    for (let i = 5; i >= 1; i--) {
      const count = ratingCounts[i];
      const pct = totalReviews > 0 ? (count / totalReviews) * 100 : 0;
      const filledCount = Math.round((pct / 100) * barLength);
      const emptyCount = barLength - filledCount;
      const barStr = '█'.repeat(filledCount) + '░'.repeat(emptyCount);
      statsLines.push(`**${i}★** \`[${barStr}]\` **${pct.toFixed(0)}%** (${count})`);
    }

    const statsDescription = statsLines.join('\n');

    // Récupérer les 3 derniers avis
    const sortedReviews = [...reviews].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const recentReviews = sortedReviews.slice(0, 3);

    const embed = new EmbedBuilder()
      .setTitle('⭐ ÉVALUATIONS DE LA COMMUNAUTÉ')
      .setDescription(`Voici les retours d'expérience des membres concernant le Bot Sniper Vinted.\n\n### 📈 Note Globale : ${avgStars} **${avgRating}/5** *(Basée sur ${totalReviews} avis)*\n\n${statsDescription}`)
      .setColor(0x00c1b7)
      .setTimestamp();

    recentReviews.forEach((r) => {
      const reviewStars = '⭐'.repeat(r.note);
      const formattedDate = new Date(r.timestamp).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      });
      embed.addFields({
        name: `💬 Avis de ${r.username} • ${reviewStars} (${r.note}/5)`,
        value: `> *"${r.commentaire}"*\n*Publié le ${formattedDate}*`,
        inline: false
      });
    });

    embed.setFooter({ text: 'Vinted Sniper Bot • Vos retours nous font grandir !' });

    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'search-list') {
    const searches = config.searches || [];
    if (searches.length === 0) {
      return interaction.reply({ content: '🔍 Aucune recherche configurée dans `config.json`. Ajoutez-en une avec `/search-add` !', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('📋 Liste des Recherches Surveillées')
      .setColor(0x00c1b7)
      .setDescription(
        searches.map((s, idx) => {
          const pingStr = s.ping ? ` • Mention : \`${s.ping}\`` : '';
          const whStr = s.webhook ? ` • [Salon Dédié]` : ' • [Global Webhook]';
          const statusIcon = s.enabled !== false ? '🟢' : '🔴';
          return `${statusIcon} **${idx + 1}. ${s.name}**\n📍 [Lien de recherche Vinted](${s.url})${pingStr}${whStr}`;
        }).join('\n\n')
      )
      .setFooter({ text: 'Vinted Sniper Bot v2.0 PRO' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'search-add') {
    const name = interaction.options.getString('nom');
    let url = interaction.options.getString('url');
    const ping = interaction.options.getString('ping') || '';
    const webhook = interaction.options.getString('webhook') || '';

    if (!url.startsWith('http')) {
      return interaction.reply({ content: '❌ L\'URL fournie doit commencer par `http` ou `https`.', ephemeral: true });
    }

    try {
      const urlObj = new URL(url);
      if (!urlObj.hostname.includes('vinted.')) {
        return interaction.reply({ content: '❌ L\'URL fournie n\'est pas une URL Vinted valide.', ephemeral: true });
      }

      // S'assurer que le tri est bien configuré chronologiquement pour le sniper
      if (urlObj.searchParams.get('order') !== 'newest_first') {
        urlObj.searchParams.set('order', 'newest_first');
        url = urlObj.toString();
      }
    } catch {
      return interaction.reply({ content: '❌ Impossible de valider le format de l\'URL.', ephemeral: true });
    }

    if (!config.searches) config.searches = [];

    // Vérifier si le nom existe déjà
    if (config.searches.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      return interaction.reply({ content: `❌ Une recherche avec le nom **"${name}"** existe déjà dans votre liste.`, ephemeral: true });
    }

    const newSearch = { name, url, ping, enabled: true };
    if (webhook) {
      if (!webhook.startsWith('https://discord.com/api/webhooks/')) {
        return interaction.reply({ content: '❌ L\'URL du Webhook Discord est invalide.', ephemeral: true });
      }
      newSearch.webhook = webhook;
    }

    config.searches.push(newSearch);

    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      
      const embed = new EmbedBuilder()
        .setTitle('✅ Recherche Vinted ajoutée !')
        .setColor(0x2ecc71)
        .addFields(
          { name: '📛 Nom', value: name, inline: true },
          { name: '🔔 Ping', value: ping || '*Aucun*', inline: true },
          { name: '📺 Destination', value: webhook ? 'Salon dédié (Webhook spécifique)' : 'Salon général (Webhook global)', inline: true },
          { name: '📍 Lien', value: `[Ouvrir la recherche sur Vinted](${url})`, inline: false }
        )
        .setFooter({ text: 'Le scanner prendra cette recherche en compte au prochain cycle.' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    } catch (err) {
      return interaction.reply({ content: `❌ Échec de la sauvegarde de la configuration : ${err.message}`, ephemeral: true });
    }
  }

  if (commandName === 'search-remove') {
    const target = interaction.options.getString('index_ou_nom');
    const searches = config.searches || [];

    if (searches.length === 0) {
      return interaction.reply({ content: '❌ Aucune recherche n\'est actuellement configurée.', ephemeral: true });
    }

    let indexToRemove = -1;
    const targetIndex = parseInt(target, 10);

    if (!isNaN(targetIndex) && targetIndex >= 1 && targetIndex <= searches.length) {
      indexToRemove = targetIndex - 1;
    } else {
      indexToRemove = searches.findIndex(s => s.name.toLowerCase() === target.toLowerCase());
    }

    if (indexToRemove === -1) {
      return interaction.reply({ content: `❌ Impossible de trouver la recherche avec l'index ou le nom **"${target}"**.`, ephemeral: true });
    }

    const [removed] = searches.splice(indexToRemove, 1);

    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      
      const embed = new EmbedBuilder()
        .setTitle('🗑️ Recherche supprimée')
        .setColor(0xe74c3c)
        .addFields(
          { name: '📛 Nom', value: removed.name, inline: true },
          { name: '📍 Ancienne URL', value: `[Lien Vinted](${removed.url})`, inline: true }
        )
        .setFooter({ text: 'Le cache du scanner a été mis à jour.' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    } catch (err) {
      return interaction.reply({ content: `❌ Échec de la sauvegarde de la configuration : ${err.message}`, ephemeral: true });
    }
  }

  if (commandName === 'config-view') {
    const scam = config.antiScam || { enabled: false, minFeedbackCount: 0, maxPriceForZeroFeedback: 0 };
    const excluded = config.excludedKeywords || [];

    const embed = new EmbedBuilder()
      .setTitle('🛡️ Configuration de la Sécurité Vinted')
      .setColor(0x00c1b7)
      .addFields(
        { name: 'Filtre Anti-Scam', value: scam.enabled ? '🟢 **ACTIVÉ**' : '🔴 **DÉSACTIVÉ**', inline: false },
        { name: '⭐ Seuil minimum d\'avis requis', value: `${scam.minFeedbackCount} avis`, inline: true },
        { name: '💰 Prix max autorisé à 0 avis', value: `${scam.maxPriceForZeroFeedback} €`, inline: true },
        { name: '🚫 Mots-clés exclus (évite le spam/fausses boîtes)', value: excluded.length > 0 ? excluded.map(w => `\`${w}\``).join(', ') : '*Aucun*' }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'config-scam') {
    const active = interaction.options.getBoolean('actif');
    if (!config.antiScam) config.antiScam = {};
    config.antiScam.enabled = active;

    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      return interaction.reply({ content: `🛡️ Le filtre anti-scam a été **${active ? 'activé' : 'désactivé'}** dans la configuration !` });
    } catch (err) {
      return interaction.reply({ content: `❌ Échec de l'enregistrement de la configuration : ${err.message}`, ephemeral: true });
    }
  }

  if (commandName === 'setup-roles') {
    // Vérifier si l'utilisateur est admin
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ Seuls les administrateurs peuvent lancer cette configuration.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('🎭 ABONNEMENT AUX ALERTES VINTED')
      .setDescription(
        'Bienvenue ! Personnalisez votre expérience en choisissant les marques qui vous intéressent.\n\n' +
        'Cliquez sur les boutons ci-dessous pour **ajouter** ou **retirer** le rôle associé et recevoir les pings correspondants lors des alertes.'
      )
      .setColor(0x00c1b7)
      .setFooter({ text: 'OMEGA | HUB • Système d\'Auto-Rôles' });

    // Boutons de rôles Streetwear 1
    const row1 = {
      type: 1,
      components: [
        { type: 2, style: 2, label: 'Nike', emoji: { name: '👟' }, custom_id: 'role_Nike' },
        { type: 2, style: 2, label: 'Adidas', emoji: { name: '👟' }, custom_id: 'role_Adidas' },
        { type: 2, style: 2, label: 'Jordan', emoji: { name: '👟' }, custom_id: 'role_Jordan' },
        { type: 2, style: 2, label: 'Corteiz', emoji: { name: '💀' }, custom_id: 'role_Corteiz' },
        { type: 2, style: 2, label: 'Supreme', emoji: { name: '🟥' }, custom_id: 'role_Supreme' }
      ]
    };

    // Boutons de rôles Streetwear 2
    const row2 = {
      type: 1,
      components: [
        { type: 2, style: 2, label: 'Trapstar', emoji: { name: '⭐' }, custom_id: 'role_Trapstar' },
        { type: 2, style: 2, label: 'Stussy', emoji: { name: '🎱' }, custom_id: 'role_Stussy' },
        { type: 2, style: 2, label: 'Carhartt', emoji: { name: '🛠️' }, custom_id: 'role_Carhartt' },
        { type: 2, style: 2, label: 'Stone Island', emoji: { name: '🧭' }, custom_id: 'role_Stone Island' }
      ]
    };

    // Boutons de rôles Luxe / Chic
    const row3 = {
      type: 1,
      components: [
        { type: 2, style: 2, label: 'Ralph Lauren', emoji: { name: '🐴' }, custom_id: 'role_Ralph Lauren' },
        { type: 2, style: 2, label: 'Lacoste', emoji: { name: '🐊' }, custom_id: 'role_Lacoste' },
        { type: 2, style: 2, label: 'Moncler', emoji: { name: '❄️' }, custom_id: 'role_Moncler' },
        { type: 2, style: 2, label: 'Palm Angels', emoji: { name: '🌴' }, custom_id: 'role_Palm Angels' },
        { type: 2, style: 2, label: 'Arc\'teryx', emoji: { name: '🦖' }, custom_id: 'role_Arcteryx' }
      ]
    };

    // Autres pings
    const row4 = {
      type: 1,
      components: [
        { type: 2, style: 3, label: 'Baisses de Prix', emoji: { name: '📉' }, custom_id: 'role_Baisses de Prix' },
        { type: 2, style: 1, label: 'Alertes Vinted', emoji: { name: '🔔' }, custom_id: 'role_Alertes Vinted' }
      ]
    };

    try {
      await interaction.channel.send({ embeds: [embed], components: [row1, row2, row3, row4] });
      return interaction.reply({ content: '✅ Le panneau d\'auto-rôles interactif a été envoyé avec succès dans ce salon !', ephemeral: true });
    } catch (err) {
      return interaction.reply({ content: `❌ Impossible d'envoyer le message : ${err.message}`, ephemeral: true });
    }
  }


}

// ═══════════════════════════════════════════════════
//  CHATBOT DE SERVICE CLIENTS & SUPPORT
// ═══════════════════════════════════════════════════

export async function handleMessage(message, configPath) {
  if (message.author.bot) return;

  const tickets = getTickets(configPath);
  const ticket = tickets.find(t => t.channelId === message.channel.id);

  if (!ticket) return;
  if (ticket.mode === 'human') return;

  const query = message.content.toLowerCase();
  
  let responseTitle = '🤖 Assistant Support HMZ';
  let responseText = '';
  
  if (query.includes('pay') || query.includes('achete') || query.includes('vip') || query.includes('premium') || query.includes('prix') || query.includes('abonnement')) {
    responseText = `Pour vous abonner au Bot Sniper Vinted et débloquer les alertes instantanées sur tous vos salons d'alertes, rendez-vous sur notre boutique officielle Whop :\n\n` +
                   `👉 **[https://whop.com/joined/hmz6391/products/bot-vinted-cf/](https://whop.com/joined/hmz6391/products/bot-vinted-cf/)**\n\n` +
                   `*Le rôle Premium vous sera attribué automatiquement dans la seconde qui suit le paiement !*`;
  } else if (query.includes('comment') || query.includes('marche') || query.includes('fonctionne') || query.includes('snipe')) {
    responseText = `Le Bot Sniper surveille l'API Vinted 24h/24 et 7j/7.\n\n` +
                   `1️⃣ **Détection rapide** : Il repère les nouveaux articles moins de 10 secondes après leur mise en ligne.\n` +
                   `2️⃣ **Alerte Discord** : Il les poste directement dans les salons avec des boutons d'achat direct.\n` +
                   `3️⃣ **VIP vs Public** : Le salon gratuit a un délai de 3 minutes (souvent trop tard), tandis que les salons Premium ont les alertes instantanées !`;
  } else if (query.includes('avis') || query.includes('review') || query.includes('note')) {
    responseText = `Votre avis compte énormément pour nous !\n\n` +
                   `Pour laisser une évaluation (note sur 5 et commentaire), rendez-vous dans le salon **#⭐・avis-membres** et cliquez sur le bouton unique **⭐ Donner mon avis**.`;
  } else if (query.includes('scam') || query.includes('securite') || query.includes('faux')) {
    responseText = `Le Bot intègre un filtre de sécurité intelligent :\n\n` +
                   `- **Filtre Anti-Scam** : Ignore automatiquement les articles suspects vendus par des profils à 0 évaluation si le prix dépasse un certain montant.\n` +
                   `- **Mots Exclus** : Ignore les fakes, faux cartons, ou fausses factures (configurable par l'administrateur).`;
  } else {
    responseText = `Désolé, je ne suis qu'un assistant virtuel et je n'ai pas compris votre demande. 🤖\n\n` +
                   `Voici comment je peux vous aider :\n` +
                   `- Tapez des mots-clés comme **"payer"**, **"marche"**, **"avis"** ou **"securité"** pour des réponses automatiques.\n\n` +
                   `💬 Si vous souhaitez obtenir l'aide d'une **vraie personne**, cliquez simplement sur le bouton **🙋 Parler à un Humain** ci-dessus et notre équipe vous répondra directement !`;
  }

  const embed = new EmbedBuilder()
    .setTitle(responseTitle)
    .setDescription(responseText)
    .setColor(0x00c1b7)
    .setFooter({ text: 'HMZ Support • Assistant Virtuel' })
    .setTimestamp();

  try {
    await message.reply({ embeds: [embed] });
  } catch (err) {
    console.error('[DISCORD] Impossible d\'envoyer la réponse du chatbot:', err.message);
  }
}

