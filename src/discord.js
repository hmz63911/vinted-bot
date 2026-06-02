import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { Jimp } from 'jimp';
import { EmbedBuilder, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ChannelType, ButtonBuilder, ButtonStyle } from 'discord.js';

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
  if (!rating) return '';
  
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
    const condition = item.status || item.status_title || 'Non spécifié';
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

    // 1. Champ Prix
    if (isPriceDrop) {
      fields.push({
        name: '💰 Prix',
        value: `~~${options.priceDrop.oldPrice.toFixed(2)} €~~ → **${options.priceDrop.newPrice.toFixed(2)} €**`,
        inline: true
      });
    } else {
      fields.push({
        name: '💰 Prix',
        value: `**${price.amount}**`,
        inline: true
      });
    }

    // 2. Champ Marque
    fields.push({
      name: '🏷️ Marque',
      value: brand,
      inline: true
    });

    // 3. Champ Taille et État combinés
    fields.push({
      name: '📐 Taille • ✨ État',
      value: `${size} • ${condition}`,
      inline: true
    });

    // 4. Champ Vendeur épuré sur une seule ligne
    let sellerFeedbackText = '';
    if (item.user?.feedback_count) {
      if (sellerStars) {
        sellerFeedbackText = `(${sellerStars} • ${item.user.feedback_count} avis)`;
      } else {
        sellerFeedbackText = `(${item.user.feedback_count} avis)`;
      }
    } else {
      sellerFeedbackText = `(Aucun avis)`;
    }

    fields.push({
      name: '👤 Vendeur',
      value: `**${sellerName}** ${sellerFeedbackText}`,
      inline: false
    });

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

function saveReviews(configPath, reviews) {
  const reviewsPath = path.join(path.dirname(configPath), 'reviews.json');
  try {
    fs.writeFileSync(reviewsPath, JSON.stringify(reviews, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DISCORD] Erreur lors de l\'enregistrement des avis:', err.message);
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
    name: 'close',
    description: '🔒 Ferme le ticket actuel et supprime le salon'
  },
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
  },
  {
    name: 'studio',
    description: '🎨 Studio IA : Détoure votre vêtement et applique un fond professionnel d\'annonce',
    options: [
      {
        name: 'image',
        description: 'Photo de votre vêtement (prise sur un lit, cintre, sol...)',
        type: 11, // ATTACHMENT
        required: true
      },
      {
        name: 'fond',
        description: 'Le type de fond professionnel à appliquer derrière le vêtement',
        type: 3, // STRING
        required: false,
        choices: [
          { name: 'Transparent (détourage uniquement)', value: 'transparent' },
          { name: 'Studio Blanc (fond épuré blanc)', value: 'blanc' },
          { name: 'Plancher Bois (parquet scandinave)', value: 'bois' },
          { name: 'Béton Industriel (style loft moderne)', value: 'beton' }
        ]
      }
    ]
  }
];

export async function cleanupDuplicateCategories(guild, configPath) {
  try {
    const channels = await guild.channels.fetch();
    const tickets = getTickets(configPath);
    
    // 1. Nettoyer les catégories doublons
    const categories = channels.filter(c => 
      c.type === ChannelType.GuildCategory && 
      (c.name === '🎫 TICKETS' || c.name.toLowerCase().includes('tickets'))
    );

    let mainCategory = null;
    if (categories.size > 0) {
      const sorted = [...categories.values()].sort((a, b) => a.id.localeCompare(b.id));
      mainCategory = sorted[0];
      
      if (categories.size > 1) {
        console.log(`[DISCORD] Détection de ${categories.size} catégories de tickets en doublon. Nettoyage...`);
        for (let i = 1; i < sorted.length; i++) {
          const duplicateCat = sorted[i];
          const children = channels.filter(c => c.parentId === duplicateCat.id);
          for (const [, child] of children) {
            try {
              await child.setParent(mainCategory.id);
              console.log(`[DISCORD] Déplacement du salon #${child.name} vers la catégorie principale.`);
            } catch (err) {
              console.error(`[DISCORD] Échec du déplacement de #${child.name}:`, err.message);
            }
          }
          try {
            await duplicateCat.delete();
            console.log(`[DISCORD] Catégorie doublon ${duplicateCat.name} supprimée.`);
          } catch (err) {
            console.error(`[DISCORD] Échec de la suppression de la catégorie doublon:`, err.message);
          }
        }
      }
    }

    // 2. Nettoyer les salons ticket-xxx orphelins (non actifs et plus de 12 heures)
    const ticketChannels = channels.filter(c => c.type === ChannelType.GuildText && c.name.startsWith('ticket-'));
    const now = Date.now();
    const TWELVE_HOURS = 12 * 60 * 60 * 1000;

    for (const [, ch] of ticketChannels) {
      const isActive = tickets.some(t => t.channelId === ch.id);
      if (!isActive) {
        const createdAt = (Number(BigInt(ch.id) >> 22n) + 1420070400000);
        if (now - createdAt > TWELVE_HOURS) {
          try {
            await ch.delete();
            console.log(`[DISCORD] Salon ticket orphelin #${ch.name} supprimé automatiquement.`);
          } catch (err) {
            console.error(`[DISCORD] Échec de la suppression de #${ch.name}:`, err.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('[DISCORD] Erreur lors du nettoyage du système de tickets:', err.message);
  }
}

let ticketsCategoryPromise = null;

async function getOrCreateTicketsCategory(guild, channels) {
  // 1. Chercher dans les salons existants
  let category = channels.find(c => 
    c.type === ChannelType.GuildCategory && 
    (c.name === '🎫 TICKETS' || c.name.toLowerCase().includes('tickets'))
  );
  if (category) return category;

  // 2. Si déjà en cours de création, attendre la fin
  if (ticketsCategoryPromise) {
    return await ticketsCategoryPromise;
  }

  // 3. Sinon, créer la catégorie et stocker la promesse
  ticketsCategoryPromise = (async () => {
    try {
      const cat = await guild.channels.create({
        name: '🎫 TICKETS',
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          {
            id: guild.id,
            deny: [PermissionFlagsBits.ViewChannel]
          }
        ]
      });
      return cat;
    } finally {
      ticketsCategoryPromise = null;
    }
  })();

  return await ticketsCategoryPromise;
}

/**
 * Traite les interactions de commandes Slash et de boutons.
 * @param {import('discord.js').ChatInputCommandInteraction|import('discord.js').ButtonInteraction} interaction 
 * @param {string} configPath 
 */
export async function handleInteraction(interaction, configPath) {
  // Gestion de la soumission de formulaire (Modal)
  if (interaction.isModalSubmit()) {
    const { customId } = interaction;

    if (customId === 'modal_laisser_avis') {
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

    if (customId === 'modal_admin_add_search') {
      const name = interaction.fields.getTextInputValue('input_search_name');
      let url = interaction.fields.getTextInputValue('input_search_url');
      const ping = interaction.fields.getTextInputValue('input_search_ping') || '';
      const webhook = interaction.fields.getTextInputValue('input_search_webhook') || '';

      if (!url.startsWith('http')) {
        return interaction.reply({ content: '❌ L\'URL fournie doit commencer par `http` ou `https`.', ephemeral: true });
      }

      try {
        const urlObj = new URL(url);
        if (!urlObj.hostname.includes('vinted.')) {
          return interaction.reply({ content: '❌ L\'URL fournie n\'est pas une URL Vinted valide.', ephemeral: true });
        }
        if (urlObj.searchParams.get('order') !== 'newest_first') {
          urlObj.searchParams.set('order', 'newest_first');
          url = urlObj.toString();
        }
      } catch {
        return interaction.reply({ content: '❌ Impossible de valider le format de l\'URL.', ephemeral: true });
      }

      let config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!config.searches) config.searches = [];

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
          .setTimestamp();
        return interaction.reply({ embeds: [embed], ephemeral: true });
      } catch (err) {
        return interaction.reply({ content: `❌ Échec de la sauvegarde : ${err.message}`, ephemeral: true });
      }
    }

    if (customId === 'modal_admin_remove_search') {
      const target = interaction.fields.getTextInputValue('input_remove_target');
      let config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
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
          .setTimestamp();
        return interaction.reply({ embeds: [embed], ephemeral: true });
      } catch (err) {
        return interaction.reply({ content: `❌ Échec de la sauvegarde : ${err.message}`, ephemeral: true });
      }
    }

    if (customId === 'modal_admin_config_scam') {
      const minFeedbackStr = interaction.fields.getTextInputValue('input_scam_min_feedback');
      const maxPriceStr = interaction.fields.getTextInputValue('input_scam_max_price');

      const minFeedback = parseInt(minFeedbackStr.trim(), 10);
      const maxPrice = parseFloat(maxPriceStr.trim());

      if (isNaN(minFeedback) || isNaN(maxPrice)) {
        return interaction.reply({ content: '❌ Les valeurs doivent être des nombres valides.', ephemeral: true });
      }

      let config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!config.antiScam) config.antiScam = {};
      config.antiScam.minFeedbackCount = minFeedback;
      config.antiScam.maxPriceForZeroFeedback = maxPrice;

      try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        return interaction.reply({
          content: `🛡️ **Configuration Anti-Scam mise à jour !**\n• Seuil avis minimum : \`${minFeedback}\`\n• Prix max sans avis : \`${maxPrice} €\``,
          ephemeral: true
        });
      } catch (err) {
        return interaction.reply({ content: `❌ Échec de la configuration : ${err.message}`, ephemeral: true });
      }
    }

    if (customId === 'modal_admin_edit_excluded') {
      const kwInput = interaction.fields.getTextInputValue('input_excluded_keywords');
      const list = kwInput.split(',').map(w => w.trim()).filter(w => w.length > 0);

      let config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      config.excludedKeywords = list;

      try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        return interaction.reply({
          content: `🚫 **Mots exclus mis à jour !**\nNouveaux mots-clés : ${list.map(w => `\`${w}\``).join(', ') || '*Aucun*'}`,
          ephemeral: true
        });
      } catch (err) {
        return interaction.reply({ content: `❌ Échec de la sauvegarde : ${err.message}`, ephemeral: true });
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
          content: 'ℹ️ **Info** : Vous avez déjà accepté le règlement et possédez le rôle `👤 Membre` ! Tous les salons vous sont déjà accessibles.',
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
        
        // Détection de l'erreur d'autorisation Discord (hiérarchie des rôles)
        if (err.message.includes('Missing Permissions') || err.code === 50013) {
          const hierarchyEmbed = new EmbedBuilder()
            .setTitle('🛠️ CONFIGURATION DISCORD DU BOT REQUISE (HIÉRARCHIE DES RÔLES)')
            .setDescription(
              '⚠️ **Le rôle `👤 Membre` n\'a pas pu vous être attribué en raison des permissions de rôle Discord.**\n\n' +
              'Pour des raisons de sécurité, Discord interdit à un robot d\'attribuer un rôle placé au-dessus ou au même niveau que lui dans la hiérarchie.\n\n' +
              '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
              '**👉 COMMENT LE CRÉATEUR DU SERVEUR PEUT RÉSOUDRE CELA EN 15 SECONDES :**\n\n' +
              '1️⃣ • Allez dans les **Paramètres du serveur** > **Rôles**.\n' +
              '2️⃣ • Recherchez le rôle de votre Bot (nommé `HMZbot` ou `Vinted Sniper`).\n' +
              '3️⃣ • **Cliquez et glissez ce rôle tout en haut** de la liste des rôles (en tout cas au-dessus du rôle `👤 Membre`).\n' +
              '4️⃣ • Cliquez sur **Enregistrer les modifications** en bas.\n\n' +
              '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
              '🔄 *Une fois cela fait, recliquez sur le bouton pour entrer instantanément !*'
            )
            .setColor(0xe74c3c)
            .setFooter({ text: 'HMZ Assistant de Configuration • Diagnostic Système' })
            .setTimestamp();

          return interaction.reply({
            embeds: [hierarchyEmbed],
            ephemeral: true
          });
        }

        return interaction.reply({
          content: `❌ **Erreur** : Impossible de vous attribuer le rôle : ${err.message}. Veuillez contacter un administrateur.`,
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

      // Récupérer la liste fraîche des salons directement depuis Discord (évite les doublons dus au cache)
      let channels;
      try {
        channels = await guild.channels.fetch();
      } catch (e) {
        channels = guild.channels.cache;
      }

      const tickets = getTickets(configPath);
      const cleanUsername = user.username.toLowerCase().slice(0, 15);
      
      // Chercher si le salon de ticket existe déjà physiquement
      const existingChannel = channels.find(c => c.name === `ticket-${cleanUsername}` && c.type === ChannelType.GuildText);
      if (existingChannel) {
        try {
          await existingChannel.delete();
          console.log(`[DISCORD] Ancien salon ticket #${existingChannel.name} supprimé pour faire place à un nouveau.`);
          
          // Retirer également de tickets.json si présent
          const oldIdx = tickets.findIndex(t => t.channelId === existingChannel.id);
          if (oldIdx !== -1) {
            tickets.splice(oldIdx, 1);
          }
        } catch (err) {
          console.warn(`[DISCORD] Impossible de supprimer l'ancien salon ticket #${existingChannel.name} :`, err.message);
        }
      }

      // Récupérer ou créer la catégorie de tickets de façon sécurisée (anti-doublon)
      let ticketsCategory;
      try {
        ticketsCategory = await getOrCreateTicketsCategory(guild, channels);
      } catch (err) {
        return interaction.reply({
          content: `❌ Impossible de créer la catégorie des tickets : ${err.message}`,
          ephemeral: true
        });
      }

      try {
        const ticketChannel = await guild.channels.create({
          name: `ticket-${user.username.slice(0, 15)}`,
          type: ChannelType.GuildText,
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

        const ticketRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('btn_parler_humain')
            .setLabel('🙋 Parler à un Humain')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('btn_fermer_ticket')
            .setLabel('🔒 Fermer le Ticket')
            .setStyle(ButtonStyle.Danger)
        );

        // Essayer d'envoyer le message de bienvenue avec retry (gère la latence de propagation des permissions Discord)
        let sentWelcome = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await ticketChannel.send({ content: `${user}`, embeds: [welcomeEmbed], components: [ticketRow] });
            sentWelcome = true;
            break;
          } catch (sendErr) {
            console.warn(`[DISCORD] Tentative ${attempt}/3 d'envoi du message de bienvenue échouée dans #${ticketChannel.name}:`, sendErr.message);
            if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }

        if (!sentWelcome) {
          // Fallback : si l'envoi échoue toujours, on tente d'envoyer un texte simple pour informer l'utilisateur
          try {
            await ticketChannel.send({ content: `Bonjour ${user} ! Bienvenue dans votre ticket d'assistance. Utilisez la commande \`/close\` si vous souhaitez fermer ce salon.` });
          } catch (_) {}
        }

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

      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('btn_fermer_ticket')
          .setLabel('🔒 Fermer le Ticket')
          .setStyle(ButtonStyle.Danger)
      );

      await interaction.reply({ embeds: [humanEmbed], components: [closeRow] });

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

    if (customId === 'btn_fermer_ticket') {
      const tickets = getTickets(configPath);
      const ticketIdx = tickets.findIndex(t => t.channelId === interaction.channelId);

      const isTicketChannel = interaction.channel.name && interaction.channel.name.startsWith('ticket-');
      const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);

      if (ticketIdx === -1 && !isTicketChannel) {
        return interaction.reply({
          content: '❌ Ce salon n\'est pas un ticket actif enregistré.',
          ephemeral: true
        });
      }

      let isCreator = false;
      if (ticketIdx !== -1) {
        const ticket = tickets[ticketIdx];
        isCreator = ticket.userId === interaction.user.id;
        tickets.splice(ticketIdx, 1);
        saveTickets(configPath, tickets);
      } else {
        // Fallback si non enregistré dans tickets.json mais s'appelle ticket-xxx
        const usernamePart = interaction.channel.name.replace('ticket-', '').toLowerCase();
        isCreator = interaction.user.username.toLowerCase().startsWith(usernamePart) || 
                    usernamePart.startsWith(interaction.user.username.toLowerCase().slice(0, 10));
      }

      if (!isCreator && !isAdmin) {
        return interaction.reply({
          content: '❌ Seul l\'administrateur ou la personne qui a ouvert ce ticket peut le fermer.',
          ephemeral: true
        });
      }

      // Supprimer le ticket de la liste si trouvé tardivement (sécurité supplémentaire)
      if (ticketIdx !== -1) {
        const checkIndex = tickets.findIndex(t => t.channelId === interaction.channelId);
        if (checkIndex !== -1) {
          tickets.splice(checkIndex, 1);
          saveTickets(configPath, tickets);
        }
      }

      await interaction.reply({
        content: '🔒 **Ticket Fermé**\nCe salon sera supprimé automatiquement dans **5 secondes**...'
      });

      setTimeout(async () => {
        try {
          await interaction.channel.delete();
        } catch (err) {
          console.error('[DISCORD] Impossible de supprimer le salon du ticket :', err.message);
        }
      }, 5000);

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

    // ═══════════════════════════════════════════════════
    //  BOUTONS DU TABLEAU DE BORD D'ADMINISTRATION
    // ═══════════════════════════════════════════════════

    // Vérifier les permissions d'administration pour les boutons d'admin
    if (customId.startsWith('btn_admin_')) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
          content: '❌ **Accès refusé** : Seuls les administrateurs peuvent utiliser la table de contrôle !',
          ephemeral: true
        });
      }
    }

    if (customId === 'btn_admin_list_searches') {
      const searches = config.searches || [];
      if (searches.length === 0) {
        return interaction.reply({ content: '🔍 Aucune recherche configurée dans `config.json`. Ajoutez-en une avec le bouton **➕ Ajouter** !', ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setTitle('📋 Liste des Recherches Surveillées')
        .setColor(0x00c1b7)
        .setDescription(
          searches.map((s, idx) => {
            const pingStr = s.ping ? ` • Mention : \`${s.ping}\`` : '';
            const whStr = s.webhook ? ` • [Salon Dédié]` : ' • [Global Webhook]';
            const statusIcon = s.enabled !== false ? '🟢' : '🔴';
            return `${statusIcon} **${idx + 1}. ${s.name}**\n📍 [Lien Vinted](${s.url})${pingStr}${whStr}`;
          }).join('\n\n')
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (customId === 'btn_admin_add_search') {
      const modal = new ModalBuilder()
        .setCustomId('modal_admin_add_search')
        .setTitle('Ajouter un Scan Vinted 🎯');

      const nameInput = new TextInputBuilder()
        .setCustomId('input_search_name')
        .setLabel('Nom descriptif (ex: Nike Air Max)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Nom du produit ou marque...')
        .setRequired(true);

      const urlInput = new TextInputBuilder()
        .setCustomId('input_search_url')
        .setLabel('URL Vinted complète')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('https://www.vinted.fr/catalog?catalog[]=...&order=newest_first')
        .setRequired(true);

      const pingInput = new TextInputBuilder()
        .setCustomId('input_search_ping')
        .setLabel('Ping Rôle / @everyone (Optionnel)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Ex: @everyone, ou <@&ID_ROLE>')
        .setRequired(false);

      const webhookInput = new TextInputBuilder()
        .setCustomId('input_search_webhook')
        .setLabel('Webhook Discord Salon Dédié (Optionnel)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('https://discord.com/api/webhooks/...')
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(nameInput),
        new ActionRowBuilder().addComponents(urlInput),
        new ActionRowBuilder().addComponents(pingInput),
        new ActionRowBuilder().addComponents(webhookInput)
      );

      try {
        await interaction.showModal(modal);
      } catch (err) {
        console.error('[DISCORD] Erreur modal admin-add:', err.message);
      }
      return;
    }

    if (customId === 'btn_admin_remove_search') {
      const modal = new ModalBuilder()
        .setCustomId('modal_admin_remove_search')
        .setTitle('Supprimer un Scan Vinted 🗑️');

      const targetInput = new TextInputBuilder()
        .setCustomId('input_remove_target')
        .setLabel('Numéro d\'index (ex: 1) ou nom exact')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Entrez le chiffre ou le nom exact à retirer...')
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(targetInput));

      try {
        await interaction.showModal(modal);
      } catch (err) {
        console.error('[DISCORD] Erreur modal admin-remove:', err.message);
      }
      return;
    }

    if (customId === 'btn_admin_toggle_scam') {
      if (!config.antiScam) config.antiScam = {};
      const nextState = !config.antiScam.enabled;
      config.antiScam.enabled = nextState;

      try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        return interaction.reply({
          content: `🛡️ **Filtre Anti-Scam** mis à jour : ${nextState ? '🟢 **ACTIVÉ**' : '🔴 **DÉSACTIVÉ**'} !`,
          ephemeral: true
        });
      } catch (err) {
        return interaction.reply({ content: `❌ Échec : ${err.message}`, ephemeral: true });
      }
    }

    if (customId === 'btn_admin_config_scam') {
      const modal = new ModalBuilder()
        .setCustomId('modal_admin_config_scam')
        .setTitle('Configuration Seuils Anti-Scam 🛡️');

      const scam = config.antiScam || { minFeedbackCount: 1, maxPriceForZeroFeedback: 15 };

      const minFeedbackInput = new TextInputBuilder()
        .setCustomId('input_scam_min_feedback')
        .setLabel('Nombre d\'avis minimum requis')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Ex: 1')
        .setValue(String(scam.minFeedbackCount || 1))
        .setRequired(true);

      const maxPriceInput = new TextInputBuilder()
        .setCustomId('input_scam_max_price')
        .setLabel('Prix maximum autorisé sans avis (en €)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Ex: 15')
        .setValue(String(scam.maxPriceForZeroFeedback || 15))
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(minFeedbackInput),
        new ActionRowBuilder().addComponents(maxPriceInput)
      );

      try {
        await interaction.showModal(modal);
      } catch (err) {
        console.error('[DISCORD] Erreur modal scam-config:', err.message);
      }
      return;
    }

    if (customId === 'btn_admin_edit_excluded') {
      const modal = new ModalBuilder()
        .setCustomId('modal_admin_edit_excluded')
        .setTitle('Éditer les Mots Exclus 🚫');

      const listStr = (config.excludedKeywords || []).join(', ');

      const kwInput = new TextInputBuilder()
        .setCustomId('input_excluded_keywords')
        .setLabel('Liste noire (séparée par des virgules)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('boite, fausse, fake, wtb, wtt...')
        .setValue(listStr)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(kwInput));

      try {
        await interaction.showModal(modal);
      } catch (err) {
        console.error('[DISCORD] Erreur modal edit-excluded:', err.message);
      }
      return;
    }

    if (customId === 'btn_admin_setup_roles') {
      const embed = new EmbedBuilder()
        .setTitle('🎭 ABONNEMENT AUX ALERTES VINTED')
        .setDescription(
          'Bienvenue ! Personnalisez votre expérience en choisissant les marques qui vous intéressent.\n\n' +
          'Cliquez sur les boutons ci-dessous pour **ajouter** ou **retirer** le rôle associé et recevoir les pings correspondants lors des alertes.'
        )
        .setColor(0x00c1b7)
        .setFooter({ text: 'OMEGA | HUB • Système d\'Auto-Rôles' });

      const row1 = {
        type: 1,
        components: [
          { type: 2, style: 2, label: 'Nike', emoji: { name: '👟' }, custom_id: 'role_Nike' },
          { type: 2, style: 2, label: 'Adidas', emoji: { name: '👟' }, custom_id: 'role_Adidas' },
          { type: 2, style: 2, label: 'Jordan', emoji: { name: '👟' }, custom_id: 'role_Jordan' },
          { type: 2, style: 2, label: 'New Balance', emoji: { name: '👟' }, custom_id: 'role_New Balance' },
          { type: 2, style: 2, label: 'Supreme', emoji: { name: '🟥' }, custom_id: 'role_Supreme' }
        ]
      };

      const row2 = {
        type: 1,
        components: [
          { type: 2, style: 2, label: 'Corteiz', emoji: { name: '💀' }, custom_id: 'role_Corteiz' },
          { type: 2, style: 2, label: 'Trapstar', emoji: { name: '⭐' }, custom_id: 'role_Trapstar' },
          { type: 2, style: 2, label: 'Stussy', emoji: { name: '🎱' }, custom_id: 'role_Stussy' },
          { type: 2, style: 2, label: 'Carhartt', emoji: { name: '🛠️' }, custom_id: 'role_Carhartt' },
          { type: 2, style: 2, label: 'Oakley', emoji: { name: '🕶️' }, custom_id: 'role_Oakley' }
        ]
      };

      const row3 = {
        type: 1,
        components: [
          { type: 2, style: 2, label: 'Ralph Lauren', emoji: { name: '🐴' }, custom_id: 'role_Ralph Lauren' },
          { type: 2, style: 2, label: 'Lacoste', emoji: { name: '🐊' }, custom_id: 'role_Lacoste' },
          { type: 2, style: 2, label: 'Diesel', emoji: { name: '👖' }, custom_id: 'role_Diesel' },
          { type: 2, style: 2, label: 'Stone Island', emoji: { name: '🧭' }, custom_id: 'role_Stone Island' }
        ]
      };

      const row4 = {
        type: 1,
        components: [
          { type: 2, style: 2, label: 'The North Face', emoji: { name: '🏔️' }, custom_id: 'role_The North Face' },
          { type: 2, style: 2, label: 'Patagonia', emoji: { name: '🌲' }, custom_id: 'role_Patagonia' },
          { type: 2, style: 2, label: 'Moncler', emoji: { name: '❄️' }, custom_id: 'role_Moncler' },
          { type: 2, style: 2, label: 'Palm Angels', emoji: { name: '🌴' }, custom_id: 'role_Palm Angels' },
          { type: 2, style: 2, label: 'Arc\'teryx', emoji: { name: '🦖' }, custom_id: 'role_Arcteryx' }
        ]
      };

      const row5 = {
        type: 1,
        components: [
          { type: 2, style: 3, label: 'Baisses de Prix', emoji: { name: '📉' }, custom_id: 'role_Baisses de Prix' },
          { type: 2, style: 1, label: 'Alertes Vinted', emoji: { name: '🔔' }, custom_id: 'role_Alertes Vinted' }
        ]
      };

      try {
        await interaction.channel.send({ embeds: [embed], components: [row1, row2, row3, row4, row5] });
        return interaction.reply({ content: '✅ Le panneau d\'auto-rôles interactif a été envoyé !', ephemeral: true });
      } catch (err) {
        return interaction.reply({ content: `❌ Impossible d'envoyer le message : ${err.message}`, ephemeral: true });
      }
    }

    if (customId === 'btn_admin_status') {
      const uptimeSeconds = Math.floor(process.uptime());
      const hours = Math.floor(uptimeSeconds / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const seconds = uptimeSeconds % 60;
      const uptimeStr = `${hours}h ${minutes}m ${seconds}s`;

      const activeSearches = (config.searches || []).filter(s => s.enabled !== false).length;
      const totalSearches = (config.searches || []).length;

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
        .setTimestamp();

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ═══════════════════════════════════════════════════
    //  BOUTONS DU STUDIO IA (FOND & DETOURAGE)
    // ═══════════════════════════════════════════════════

    if (customId === 'btn_studio_blanc') {
      const apiKey = process.env.REMOVE_BG_API_KEY;
      if (!apiKey) {
        // Envoi de l'alerte explicative aux admins uniquement
        const adminChannel = interaction.guild.channels.cache.find(c => c.name.includes('config-bot') || c.name.includes('logs'));
        if (adminChannel) {
          const apiEmbed = new EmbedBuilder()
            .setTitle('🚨 ALERTE ADMIN : CONFIGURATION STUDIO IA REQUISE')
            .setDescription(
              'Un membre a tenté d\'utiliser le **Studio IA**, mais votre clé d\'API n\'est pas encore configurée !\n\n' +
              'Pour l\'activer de manière 100 % gratuite et transparente pour vos clients :\n\n' +
              '1️⃣ • Créez un compte gratuit sur le site [Remove.bg](https://www.remove.bg/).\n' +
              '2️⃣ • Allez sur votre profil pour générer une **Clé d\'API gratuite** (50 détourages offerts/mois).\n' +
              '3️⃣ • Ajoutez-la dans votre fichier `.env` :\n' +
              '   * Variable : `REMOVE_BG_API_KEY`\n' +
              '   * Valeur : *votre_clé_api*\n\n' +
              '*Une fois configurée, le détourage fonctionnera automatiquement en arrière-plan sans que vos clients ne sachent quel service externe vous utilisez !*'
            )
            .setColor(0xe74c3c)
            .setTimestamp();
          await adminChannel.send({ content: '@everyone', embeds: [apiEmbed] }).catch(() => {});
        }

        return interaction.reply({
          content: '❌ **Le Studio IA est temporairement indisponible.** Veuillez réessayer plus tard ou contacter l\'administration.',
          ephemeral: true
        });
      }

      // Répondre immédiatement de manière éphémère pour éviter le timeout de 3 secondes de Discord
      await interaction.reply({
        content: '⏳ **Initialisation de la session privée...** *(Veuillez patienter)*',
        ephemeral: true
      });

      try {
        // 1. Tenter d'ouvrir la discussion DM avec l'utilisateur
        const dmChannel = await interaction.user.createDM();
        
        await dmChannel.send({
          content: `📸 **Studio IA - Photo Studio Blanc**\n\nVeuillez envoyer la photo de votre vêtement dans notre discussion privée **dans les 60 prochaines secondes**.\n\n*🔒 Cette discussion est 100% privée : personne d'autre sur le serveur ne verra votre photo brute ni votre image finale !*`
        });

        // 2. Si l'envoi en DM a réussi, mettre à jour la réponse initiale de manière éphémère
        await interaction.editReply({
          content: `📥 **Je vous ai envoyé un message privé !** Veuillez ouvrir nos messages privés pour y envoyer votre photo de vêtement en toute confidentialité.`
        });

        // Démarrer le collector sur le canal DM privé
        const filter = m => m.author.id === interaction.user.id && m.attachments.size > 0;
        const collector = dmChannel.createMessageCollector({ filter, time: 60000, max: 1 });

        collector.on('collect', async m => {
          // Notification de traitement en DM
          const processingMsg = await dmChannel.send({
            content: `⏳ Traitement de votre vêtement par l'IA en cours...`
          });

          const attachment = m.attachments.first();

          try {
            console.log(`[STUDIO IA] Téléchargement du fichier depuis DM : ${attachment.url}`);

            // 1. Télécharger l'image en mémoire
            const downloadResponse = await axios.get(attachment.url, { responseType: 'arraybuffer' });
            const imageBuffer = Buffer.from(downloadResponse.data);
            const base64Image = imageBuffer.toString('base64');

            // Supprimer le message d'origine du DM pour la propreté
            try {
              await m.delete();
            } catch (_) {}

            console.log(`[STUDIO IA] Envoi Base64 à l'API Remove.bg...`);

            // 2. Appel à l'API Remove.bg
            const response = await axios.post('https://api.remove.bg/v1.0/removebg', 
              {
                image_file_b64: base64Image,
                size: 'auto'
              },
              {
                headers: {
                  'X-Api-Key': apiKey,
                  'Content-Type': 'application/json'
                },
                responseType: 'arraybuffer'
              }
            );

            const transparentBuffer = Buffer.from(response.data);

            // 3. Instancier Jimp pour le vêtement détouré
            const itemImage = await Jimp.read(transparentBuffer);
            const w = itemImage.bitmap.width;
            const h = itemImage.bitmap.height;

            // 4. Générer la version Studio Blanc
            const bgBlanc = new Jimp({ width: w, height: h, color: 0xFFFFFFFF });
            bgBlanc.composite(itemImage, 0, 0);
            const blancBuffer = await bgBlanc.getBuffer('image/png');

            const filename = `studio_blanc_${Date.now()}.png`;

            // 5. Préparer l'Embed privé
            const embed = new EmbedBuilder()
              .setTitle('⬜ VOTRE PHOTO STUDIO BLANC EST PRÊTE !')
              .setDescription(
                `Bravo ! Votre photo a été traitée avec succès par notre IA !\n\n` +
                `🔹 **Fond appliqué** : \`STUDIO BLANC\` (Épuré et ultra-crédible)\n\n` +
                `💡 *Cette photo est maintenant parfaitement optimisée pour vendre votre article 10x plus vite sur Vinted en toute confidentialité !*`
              )
              .setColor(0x2ecc71)
              .setImage(`attachment://${filename}`)
              .setFooter({ text: 'Studio IA Premium • Confidentialité Absolue' })
              .setTimestamp();

            // Supprimer le message d'attente
            await processingMsg.delete().catch(() => {});

            // Envoyer l'image finale en DM
            const sentMessage = await dmChannel.send({
              embeds: [embed],
              files: [{ attachment: blancBuffer, name: filename }]
            });

            // Récupérer l'URL Discord de la pièce jointe
            const attachmentUrl = sentMessage.attachments.first()?.url;
            if (attachmentUrl) {
              const downloadRow = {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 5,
                    label: '📥 Télécharger Photo Studio Blanc',
                    url: attachmentUrl
                  }
                ]
              };
              await sentMessage.edit({ components: [downloadRow] }).catch(() => {});
            }

          } catch (err) {
            console.error('[STUDIO IA] Erreur de traitement privé :', err.message);
            let errorMsg = err.message;
            if (err.response && err.response.data) {
              try {
                const errMsg = Buffer.from(err.response.data).toString('utf-8');
                const errObj = JSON.parse(errMsg);
                errorMsg = errObj.errors?.[0]?.title || errorMsg;
              } catch (_) {}
            }
            await processingMsg.delete().catch(() => {});
            await dmChannel.send({
              content: `❌ Échec du traitement de la photo : ${errorMsg}`
            });
          }
        });

        collector.on('end', collected => {
          if (collected.size === 0) {
            dmChannel.send({
              content: `⌛ **Temps écoulé !** Vous n'avez pas envoyé de photo dans les 60 secondes. Veuillez recliquer sur le bouton sur le serveur pour recommencer.`
            }).catch(() => {});
          }
        });

      } catch (err) {
        // En cas d'erreur lors de l'ouverture du DM (DMs fermés par l'utilisateur)
        console.warn(`[STUDIO IA] Impossible d'envoyer un DM à ${interaction.user.tag}:`, err.message);
        await interaction.editReply({
          content: `❌ **Impossible de vous envoyer un message privé.**\n\nPour des raisons de **confidentialité absolue**, le traitement s'effectue entièrement en message privé.\n\n` +
                   `**Comment autoriser les messages privés ?**\n` +
                   `1️⃣ Clic droit sur l'icône de notre serveur Discord.\n` +
                   `2️⃣ Allez dans **Paramètres de confidentialité**.\n` +
                   `3️⃣ Activez l'option **"Autoriser les messages privés provenant des membres du serveur"**.\n` +
                   `4️⃣ Recliquez sur le bouton **Générer ma Photo Studio Blanc** !`
        });
      }

      return;
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'close') {
    const tickets = getTickets(configPath);
    const ticketIdx = tickets.findIndex(t => t.channelId === interaction.channel.id);

    const isTicketChannel = interaction.channel.name && interaction.channel.name.startsWith('ticket-');
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator) || 
                    interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);

    if (ticketIdx === -1 && !isTicketChannel) {
      return interaction.reply({
        content: '❌ Ce salon n\'est pas un ticket actif.',
        ephemeral: true
      });
    }

    let isCreator = false;
    if (ticketIdx !== -1) {
      const ticket = tickets[ticketIdx];
      isCreator = ticket.userId === interaction.user.id;
    } else {
      const usernamePart = interaction.channel.name.replace('ticket-', '').toLowerCase();
      isCreator = interaction.user.username.toLowerCase().startsWith(usernamePart) || 
                  usernamePart.startsWith(interaction.user.username.toLowerCase().slice(0, 10));
    }

    if (!isCreator && !isAdmin) {
      return interaction.reply({
        content: '❌ Seul l\'administrateur, un modérateur ou le créateur du ticket peut le fermer.',
        ephemeral: true
      });
    }

    // Supprimer de la liste
    if (ticketIdx !== -1) {
      tickets.splice(ticketIdx, 1);
      saveTickets(configPath, tickets);
    }

    await interaction.reply({
      content: '🔒 **Ticket Fermé**\nCe salon sera supprimé automatiquement dans **5 secondes**...'
    });

    setTimeout(async () => {
      try {
        await interaction.channel.delete();
      } catch (err) {
        console.error('[DISCORD] Impossible de supprimer le salon du ticket via commande :', err.message);
      }
    }, 5000);

    return;
  }

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
        { type: 2, style: 2, label: 'New Balance', emoji: { name: '👟' }, custom_id: 'role_New Balance' },
        { type: 2, style: 2, label: 'Supreme', emoji: { name: '🟥' }, custom_id: 'role_Supreme' }
      ]
    };

    // Boutons de rôles Streetwear 2
    const row2 = {
      type: 1,
      components: [
        { type: 2, style: 2, label: 'Corteiz', emoji: { name: '💀' }, custom_id: 'role_Corteiz' },
        { type: 2, style: 2, label: 'Trapstar', emoji: { name: '⭐' }, custom_id: 'role_Trapstar' },
        { type: 2, style: 2, label: 'Stussy', emoji: { name: '🎱' }, custom_id: 'role_Stussy' },
        { type: 2, style: 2, label: 'Carhartt', emoji: { name: '🛠️' }, custom_id: 'role_Carhartt' },
        { type: 2, style: 2, label: 'Oakley', emoji: { name: '🕶️' }, custom_id: 'role_Oakley' }
      ]
    };

    // Boutons de rôles Luxe / Chic
    const row3 = {
      type: 1,
      components: [
        { type: 2, style: 2, label: 'Ralph Lauren', emoji: { name: '🐴' }, custom_id: 'role_Ralph Lauren' },
        { type: 2, style: 2, label: 'Lacoste', emoji: { name: '🐊' }, custom_id: 'role_Lacoste' },
        { type: 2, style: 2, label: 'Diesel', emoji: { name: '👖' }, custom_id: 'role_Diesel' },
        { type: 2, style: 2, label: 'Stone Island', emoji: { name: '🧭' }, custom_id: 'role_Stone Island' }
      ]
    };

    // Boutons de rôles Luxe / Outdoor
    const row4 = {
      type: 1,
      components: [
        { type: 2, style: 2, label: 'The North Face', emoji: { name: '🏔️' }, custom_id: 'role_The North Face' },
        { type: 2, style: 2, label: 'Patagonia', emoji: { name: '🌲' }, custom_id: 'role_Patagonia' },
        { type: 2, style: 2, label: 'Moncler', emoji: { name: '❄️' }, custom_id: 'role_Moncler' },
        { type: 2, style: 2, label: 'Palm Angels', emoji: { name: '🌴' }, custom_id: 'role_Palm Angels' },
        { type: 2, style: 2, label: 'Arc\'teryx', emoji: { name: '🦖' }, custom_id: 'role_Arcteryx' }
      ]
    };

    // Autres pings
    const row5 = {
      type: 1,
      components: [
        { type: 2, style: 3, label: 'Baisses de Prix', emoji: { name: '📉' }, custom_id: 'role_Baisses de Prix' },
        { type: 2, style: 1, label: 'Alertes Vinted', emoji: { name: '🔔' }, custom_id: 'role_Alertes Vinted' }
      ]
    };

    try {
      await interaction.channel.send({ embeds: [embed], components: [row1, row2, row3, row4, row5] });
      return interaction.reply({ content: '✅ Le panneau d\'auto-rôles interactif a été envoyé avec succès dans ce salon !', ephemeral: true });
    } catch (err) {
      return interaction.reply({ content: `❌ Impossible d'envoyer le message : ${err.message}`, ephemeral: true });
    }
  }

  // --- COMMANDE STUDIO IA ---
  if (commandName === 'studio') {
    const attachment = interaction.options.getAttachment('image');
    const fond = interaction.options.getString('fond') || 'transparent';

    // 1. Différer la réponse car l'appel à l'API d'IA prend du temps
    await interaction.deferReply({ ephemeral: false });

    // 2. Vérifier la clé API Remove.bg
    const apiKey = process.env.REMOVE_BG_API_KEY;
    if (!apiKey) {
      // Envoi de l'alerte explicative aux admins uniquement
      const adminChannel = interaction.guild.channels.cache.find(c => c.name.includes('config-bot') || c.name.includes('logs'));
      if (adminChannel) {
        const apiEmbed = new EmbedBuilder()
          .setTitle('🚨 ALERTE ADMIN : CONFIGURATION STUDIO IA REQUISE')
          .setDescription(
            'Un membre a tenté d\'utiliser le **Studio IA**, mais votre clé d\'API n\'est pas encore configurée !\n\n' +
            'Pour l\'activer de manière 100 % gratuite et transparente pour vos clients :\n\n' +
            '1️⃣ • Créez un compte gratuit sur le site [Remove.bg](https://www.remove.bg/).\n' +
            '2️⃣ • Allez sur votre profil pour générer une **Clé d\'API gratuite** (50 détourages offerts/mois).\n' +
            '3️⃣ • Ajoutez-la sur **Render.com** (onglet *Environment*) :\n' +
            '   * Variable : `REMOVE_BG_API_KEY`\n' +
            '   * Valeur : *votre_clé_api*\n\n' +
            '*Une fois configurée, le détourage fonctionnera automatiquement en arrière-plan sans que vos clients ne sachent quel service externe vous utilisez !*'
          )
          .setColor(0xe74c3c)
          .setTimestamp();
        await adminChannel.send({ content: '@everyone', embeds: [apiEmbed] }).catch(() => {});
      }

      return interaction.editReply({
        content: '❌ **Le Studio IA est temporairement indisponible.** Veuillez réessayer plus tard ou contacter l\'administration.'
      });
    }

    try {
      console.log(`[STUDIO IA] Téléchargement local de la photo de vêtement : ${attachment.url}`);

      // 1. Télécharger l'image directement en mémoire
      const downloadResponse = await axios.get(attachment.url, { responseType: 'arraybuffer' });
      const imageBuffer = Buffer.from(downloadResponse.data);
      const base64Image = imageBuffer.toString('base64');

      console.log(`[STUDIO IA] Envoi Base64 de la photo à l'API Remove.bg...`);

      // 2. Appel de l'API avec le fichier encodé en Base64
      const response = await axios.post('https://api.remove.bg/v1.0/removebg', 
        {
          image_file_b64: base64Image,
          size: 'auto'
        },
        {
          headers: {
            'X-Api-Key': apiKey,
            'Content-Type': 'application/json'
          },
          responseType: 'arraybuffer'
        }
      );

      const transparentBuffer = Buffer.from(response.data);
      let finalBuffer = transparentBuffer;

      // 4. Appliquer le fond choisi par l'utilisateur
      if (fond !== 'transparent') {
        console.log(`[STUDIO IA] Fusion de l'image détourée sur le fond : ${fond}...`);
        const itemImage = await Jimp.read(transparentBuffer);
        const w = itemImage.bitmap.width;
        const h = itemImage.bitmap.height;

        let bgImage;
        if (fond === 'blanc') {
          bgImage = new Jimp({ width: w, height: h, color: 0xFFFFFFFF }); // Fond blanc uni
        } else if (fond === 'bois') {
          bgImage = await Jimp.read('https://images.unsplash.com/photo-1533090161767-e6ffed986c88?q=80&w=800'); // Texture plancher bois pure
          bgImage.cover({ w, h });
        } else if (fond === 'beton') {
          bgImage = await Jimp.read('https://images.unsplash.com/photo-1531685250784-7569952593d2?q=80&w=800'); // Texture béton industriel pure
          bgImage.cover({ w, h });
        }

        if (bgImage) {
          bgImage.composite(itemImage, 0, 0);
          finalBuffer = await bgImage.getBuffer('image/png');
        }
      }

      // 5. Envoyer le fichier final traité sur Discord
      const filename = `studio_${fond}_${Date.now()}.png`;
      const embed = new EmbedBuilder()
        .setTitle('🎨 Vêtement détouré par Studio IA')
        .setDescription(
          `Votre photo a été traitée avec succès par notre Intelligence Artificielle !\n\n` +
          `🔹 **Fond appliqué** : \`${fond.toUpperCase()}\`\n\n` +
          `💡 *Cette photo est maintenant optimisée pour maximiser le taux de clics et vendre votre vêtement 10x plus vite sur Vinted !*`
        )
        .setColor(0x2ecc71)
        .setImage(`attachment://${filename}`)
        .setFooter({ text: 'Studio IA • Détourage Intelligent' })
        .setTimestamp();

      return interaction.editReply({
        embeds: [embed],
        files: [{ attachment: finalBuffer, name: filename }]
      });

    } catch (err) {
      console.error('[STUDIO IA] Erreur de détourage :', err.message);
      let errorMsg = err.message;
      if (err.response && err.response.data) {
        try {
          const errMsg = Buffer.from(err.response.data).toString('utf-8');
          const errObj = JSON.parse(errMsg);
          errorMsg = errObj.errors?.[0]?.title || errorMsg;
        } catch (_) {}
      }

      return interaction.editReply({
        content: `❌ **Erreur Studio IA** : Impossible de détourer l'image (${errorMsg}). Assurez-vous d'avoir envoyé un format d'image valide.`
      });
    }
  }

}

// ═══════════════════════════════════════════════════
//  CHATBOT DE SERVICE CLIENTS & SUPPORT
// ═══════════════════════════════════════════════════

export async function handleMessage(message, configPath) {
  if (message.author.bot) return;

  let tickets = getTickets(configPath);
  let ticket = tickets.find(t => t.channelId === message.channel.id);

  // Auto-récupération auto-guérissante si le salon s'appelle ticket-xxx mais n'est pas dans tickets.json
  if (!ticket && message.channel.name && message.channel.name.startsWith('ticket-')) {
    let userId = null;
    let username = message.channel.name.replace('ticket-', '');
    
    // Essayer de trouver le créateur du ticket (en lisant les permission overwrites)
    if (message.channel.permissionOverwrites) {
      const memberOverwrites = message.channel.permissionOverwrites.cache.filter(
        o => o.type === 1 && o.id !== message.client.user.id
      ); // type 1 is Member
      if (memberOverwrites.size > 0) {
        userId = memberOverwrites.first().id;
      }
    }
    
    ticket = {
      channelId: message.channel.id,
      userId: userId || message.author.id,
      username: username,
      mode: 'bot',
      timestamp: new Date().toISOString()
    };
    tickets.push(ticket);
    saveTickets(configPath, tickets);
    console.log(`[DISCORD] Auto-restauration du ticket pour le salon ${message.channel.name} dans tickets.json`);
  }

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

  const ticketRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_parler_humain')
      .setLabel('🙋 Parler à un Humain')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('btn_fermer_ticket')
      .setLabel('🔒 Fermer le Ticket')
      .setStyle(ButtonStyle.Danger)
  );

  try {
    await message.reply({ embeds: [embed], components: [ticketRow] });
  } catch (err) {
    console.error('[DISCORD] Impossible d\'envoyer la réponse du chatbot:', err.message);
  }
}

