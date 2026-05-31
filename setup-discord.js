/**
 * 🛠️ SCRIPT DE SETUP AUTOMATIQUE DU SERVEUR DISCORD
 * 
 * Ce script configure automatiquement un serveur Discord pour le Vinted Sniper Bot :
 * - Crée les catégories, salons, et rôles
 * - Configure les permissions
 * - Envoie les messages de bienvenue
 * 
 * Usage : node setup-discord.js <ID_DU_SERVEUR>
 * 
 * Pour trouver l'ID du serveur : Paramètres Discord > Avancé > Mode développeur
 * Puis clic droit sur le serveur > "Copier l'identifiant du serveur"
 */

import { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.argv[2];

function isValidDiscordToken(token) {
  if (!token) return false;
  return token.length > 50 && token.includes('.');
}

if (!GUILD_ID) {
  console.error('❌ Usage : node setup-discord.js <ID_DU_SERVEUR>');
  console.error('   Pour trouver l\'ID : clic droit sur le serveur > "Copier l\'identifiant"');
  process.exit(1);
}

if (!isValidDiscordToken(TOKEN)) {
  console.error('❌ [ERREUR] Le Token Discord dans votre fichier .env est absent ou invalide !');
  console.error('   Jeton actuel dans .env : ' + (TOKEN ? `"${TOKEN.substring(0, 8)}..."` : 'aucun'));
  console.error('\n🛠️  COMMENT OBTENIR UN TOKEN VALIDE :');
  console.error('   1. Connectez-vous sur le Portail Développeurs Discord :');
  console.error('      ➡️ https://discord.com/developers/applications');
  console.error('   2. Créez un projet ("New Application") et nommez-le (ex: "Vinted Sniper").');
  console.error('   3. Menu "Bot" (à gauche) -> Cliquez sur "Add Bot".');
  console.error('   4. Activez "Message Content Intent" sous la section "Privileged Gateway Intents".');
  console.error('   5. Cliquez sur "Reset Token" pour générer votre jeton de connexion et copiez-le.');
  console.error('   6. Ouvrez le fichier .env de votre projet et mettez-y votre token :');
  console.error('      DISCORD_BOT_TOKEN=VOTRE_TOKEN_ICI');
  console.error('\n   Une fois cela fait, relancez cette commande !');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

// ═══════════════════════════════════════════════════
//  CONFIGURATION DU SERVEUR
// ═══════════════════════════════════════════════════

const ROLES = [
  { name: '👑 Admin', color: '#e74c3c', hoist: true, permissions: [PermissionFlagsBits.Administrator] },
  { name: '👑 Premium', color: '#f1c40f', hoist: true, mentionable: true },
  { name: '🔔 Alertes Vinted', color: '#00c1b7', hoist: true, mentionable: true },
  { name: '👟 Nike', color: '#ff6b35', hoist: false, mentionable: true },
  { name: '👟 Adidas', color: '#3498db', hoist: false, mentionable: true },
  { name: '👟 Jordan', color: '#e74c3c', hoist: false, mentionable: true },
  { name: '🐴 Ralph Lauren', color: '#1a3c6e', hoist: false, mentionable: true },
  { name: '🐊 Lacoste', color: '#27ae60', hoist: false, mentionable: true },
  { name: '💀 Corteiz', color: '#2c3e50', hoist: false, mentionable: true },
  { name: '🟥 Supreme', color: '#e74c3c', hoist: false, mentionable: true },
  { name: '🧭 Stone Island', color: '#f1c40f', hoist: false, mentionable: true },
  { name: '⭐ Trapstar', color: '#9b59b6', hoist: false, mentionable: true },
  { name: '🎱 Stussy', color: '#1abc9c', hoist: false, mentionable: true },
  { name: '🏔️ The North Face', color: '#e67e22', hoist: false, mentionable: true },
  { name: '🛠️ Carhartt', color: '#d35400', hoist: false, mentionable: true },
  { name: '❄️ Moncler', color: '#95a5a6', hoist: false, mentionable: true },
  { name: '🌴 Palm Angels', color: '#bdc3c7', hoist: false, mentionable: true },
  { name: '🦖 Arc\'teryx', color: '#34495e', hoist: false, mentionable: true },
  { name: '📉 Baisses de Prix', color: '#2ecc71', hoist: false, mentionable: true },
  { name: '👤 Membre', color: '#95a5a6', hoist: false },
];

const CATEGORIES_AND_CHANNELS = [
  {
    name: '📋 INFORMATIONS',
    channels: [
      { name: '📜・règles', type: 'text', readOnly: true },
      { name: '📢・annonces', type: 'text', readOnly: true },
      { name: '🤖・statut-bot', type: 'text', readOnly: true },
      { name: '⭐・avis-membres', type: 'text', readOnly: true },
      { name: '🙋・support', type: 'text', readOnly: true },
    ]
  },
  {
    name: '👟 STREETWEAR & SPORTS',
    premiumOnly: true,
    channels: [
      { name: '👟・nike', type: 'text', readOnly: true },
      { name: '👟・adidas', type: 'text', readOnly: true },
      { name: '👟・jordan', type: 'text', readOnly: true },
      { name: '💀・corteiz', type: 'text', readOnly: true },
      { name: '🟥・supreme', type: 'text', readOnly: true },
      { name: '⭐・trapstar', type: 'text', readOnly: true },
      { name: '🎱・stussy', type: 'text', readOnly: true },
      { name: '🛠️・carhartt', type: 'text', readOnly: true },
    ]
  },
  {
    name: '🐊 CHIC & LUXE',
    premiumOnly: true,
    channels: [
      { name: '🐴・ralph-lauren', type: 'text', readOnly: true },
      { name: '🐊・lacoste', type: 'text', readOnly: true },
      { name: '🧭・stone-island', type: 'text', readOnly: true },
      { name: '🏔️・the-north-face', type: 'text', readOnly: true },
      { name: '❄️・moncler', type: 'text', readOnly: true },
      { name: '🌴・palm-angels', type: 'text', readOnly: true },
      { name: '🦖・arcteryx', type: 'text', readOnly: true },
    ]
  },
  {
    name: '🛍️ AUTRES ALERTES',
    channels: [
      { name: '📉・baisses-de-prix', type: 'text', readOnly: true, premiumOnly: true },
      { name: '🛍️・toutes-alertes', type: 'text', readOnly: true },
    ]
  },
  {
    name: '💬 COMMUNAUTÉ',
    channels: [
      { name: '💬・général', type: 'text', readOnly: false },
      { name: '🔍・demandes', type: 'text', readOnly: false },
      { name: '⭐・bons-plans', type: 'text', readOnly: false },
    ]
  },
  {
    name: '⚙️ ADMINISTRATION',
    channels: [
      { name: '🔧・config-bot', type: 'text', adminOnly: true },
      { name: '📊・logs', type: 'text', adminOnly: true },
    ]
  }
];

// ═══════════════════════════════════════════════════
//  LOGIQUE DE SETUP
// ═══════════════════════════════════════════════════

client.once('ready', async () => {
  console.log(`\n✅ Bot connecté en tant que ${client.user.tag}`);
  
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    console.error(`❌ Serveur avec l'ID ${GUILD_ID} introuvable. Le bot est-il bien invité sur le serveur ?`);
    console.error(`   Lien d'invitation : https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot`);
    process.exit(1);
  }

  console.log(`📍 Serveur trouvé : ${guild.name}`);
  console.log('═══════════════════════════════════════');
  console.log('  🛠️  CONFIGURATION EN COURS...');
  console.log('═══════════════════════════════════════\n');

  try {
    // --- ÉTAPE 1 : Supprimer les salons par défaut ---
    console.log('[1/5] 🗑️  Nettoyage des salons par défaut...');
    const existingChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildCategory);
    for (const [, channel] of existingChannels) {
      try {
        await channel.delete();
      } catch (e) {
        console.warn(`   ⚠️  Impossible de supprimer #${channel.name}: ${e.message}`);
      }
    }
    console.log('   ✅ Nettoyage terminé.\n');

    // --- ÉTAPE 2 : Créer les rôles ---
    console.log('[2/5] 🎭 Création des rôles...');
    const createdRoles = {};
    for (const roleConfig of ROLES) {
      // Vérifier si le rôle existe déjà
      let role = guild.roles.cache.find(r => r.name === roleConfig.name);
      if (!role) {
        role = await guild.roles.create({
          name: roleConfig.name,
          color: roleConfig.color,
          hoist: roleConfig.hoist || false,
          mentionable: roleConfig.mentionable || false,
          permissions: roleConfig.permissions || [],
        });
      }
      createdRoles[roleConfig.name] = role;
      console.log(`   ✅ Rôle créé : ${roleConfig.name}`);
    }
    console.log('');

    // --- ÉTAPE 3 : Créer les catégories et salons ---
    console.log('[3/5] 📁 Création des catégories et salons...');
    const createdChannels = {};
    
    for (const category of CATEGORIES_AND_CHANNELS) {
      const categoryPermissions = [];

      if (category.premiumOnly) {
        categoryPermissions.push({
          id: guild.id, // @everyone
          deny: [PermissionFlagsBits.ViewChannel],
        });
        if (createdRoles['👑 Admin']) {
          categoryPermissions.push({
            id: createdRoles['👑 Admin'].id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
          });
        }
        if (createdRoles['👑 Premium']) {
          categoryPermissions.push({
            id: createdRoles['👑 Premium'].id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [PermissionFlagsBits.SendMessages],
          });
        }
      }

      // Créer la catégorie
      const cat = await guild.channels.create({
        name: category.name,
        type: ChannelType.GuildCategory,
        permissionOverwrites: categoryPermissions,
      });
      console.log(`   📁 Catégorie : ${category.name} (${category.premiumOnly ? '👑 PREMIUM' : '🔓 PUBLIQUE'})`);

      for (const ch of category.channels) {
        const permissionOverwrites = [];

        if (ch.adminOnly) {
          permissionOverwrites.push({
            id: guild.id, // @everyone
            deny: [PermissionFlagsBits.ViewChannel],
          });
          if (createdRoles['👑 Admin']) {
            permissionOverwrites.push({
              id: createdRoles['👑 Admin'].id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
            });
          }
        } 
        else if (ch.premiumOnly || category.premiumOnly) {
          permissionOverwrites.push({
            id: guild.id, // @everyone
            deny: [PermissionFlagsBits.ViewChannel],
          });
          if (createdRoles['👑 Admin']) {
            permissionOverwrites.push({
              id: createdRoles['👑 Admin'].id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
            });
          }
          if (createdRoles['👑 Premium']) {
            permissionOverwrites.push({
              id: createdRoles['👑 Premium'].id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
              deny: [PermissionFlagsBits.SendMessages],
            });
          }
        }
        else {
          if (ch.readOnly) {
            permissionOverwrites.push({
              id: guild.id, // @everyone
              deny: [PermissionFlagsBits.SendMessages],
              allow: [PermissionFlagsBits.ViewChannel],
            });
          }
        }

        const channel = await guild.channels.create({
          name: ch.name,
          type: ChannelType.GuildText,
          parent: cat.id,
          permissionOverwrites,
        });
        createdChannels[ch.name] = channel;
        console.log(`      💬 #${ch.name}`);
      }
    }
    console.log('');

    // --- ÉTAPE 4 : Envoyer les messages de bienvenue ---
    console.log('[4/5] 📨 Envoi des messages de bienvenue...');

    // Message dans #règles
    const reglesChannel = createdChannels['📜・règles'];
    if (reglesChannel) {
      const reglesEmbed = new EmbedBuilder()
        .setTitle('📜 Règles du Serveur')
        .setColor(0x00c1b7)
        .setDescription(
          '**Bienvenue sur le serveur Vinted Sniper Bot !**\n\n' +
          'Ce serveur reçoit automatiquement les meilleures offres Vinted en temps réel.\n\n' +
          '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
          '**1️⃣** • Les salons **🔔 ALERTES VIP** (Nike, Jordan, Corteiz...) sont réservés aux membres Premium.\n\n' +
          '**2️⃣** • Le salon **🛍️・toutes-alertes** est public mais reçoit les alertes avec **3 minutes de retard**.\n\n' +
          '**3️⃣** • Cliquez sur **ACHETER EN 1-CLIC** dans les alertes pour accéder directement à la page d\'achat Vinted.\n\n' +
          '**4️⃣** • Cliquez sur **ENVOYER UN MESSAGE** pour négocier le prix avec le vendeur.\n\n' +
          '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
          '🚀 *Débloquez l\'accès Premium pour recevoir toutes les alertes instantanément à la seconde près !*'
        )
        .setFooter({ text: 'Vinted Sniper Bot v2.0 PRO' })
        .setTimestamp();

      const payRow = {
        type: 1,
        components: [
          {
            type: 2,
            style: 5, // LINK
            label: '👑 Obtenir l\'Accès Premium VIP',
            url: 'https://whop.com/joined/hmz6391/products/bot-vinted-cf/'
          }
        ]
      };

      await reglesChannel.send({ embeds: [reglesEmbed], components: [payRow] });
      console.log('   ✅ Message envoyé dans #📜・règles');
    }



    // Message dans #statut-bot
    const statutChannel = createdChannels['🤖・statut-bot'];
    if (statutChannel) {
      const statutEmbed = new EmbedBuilder()
        .setTitle('🤖 Statut du Bot')
        .setColor(0x2ecc71)
        .setDescription(
          '**Le bot est actif et surveille Vinted en continu.**\n\n' +
          '🔍 **Recherches actives :**\n' +
          '> 👟 Nike Air Max (< 40€)\n' +
          '> 🐴 Ralph Lauren (Taille M)\n\n' +
          '⚡ **Fonctionnalités actives :**\n' +
          '> ✅ Détection de nouveaux articles\n' +
          '> ✅ Détection de baisses de prix\n' +
          '> ✅ Filtre anti-scam (vrais avis vendeur)\n' +
          '> ✅ Filtre mots-clés exclus\n' +
          '> ✅ Bouton achat 1-clic + négociation\n\n' +
          '🔄 *Intervalle de scan : 5 secondes*'
        )
        .setFooter({ text: 'Vinted Sniper Bot v2.0 PRO' })
        .setTimestamp();
      await statutChannel.send({ embeds: [statutEmbed] });
      console.log('   ✅ Message envoyé dans #🤖・statut-bot');
    }

    // Message de bienvenue dans #général
    const generalChannel = createdChannels['💬・général'];
    if (generalChannel) {
      const welcomeEmbed = new EmbedBuilder()
        .setTitle('👋 Bienvenue !')
        .setColor(0x00c1b7)
        .setDescription(
          'Le serveur est prêt ! Les alertes Vinted arriveront automatiquement dans les salons **🔔 ALERTES VINTED**.\n\n' +
          '💡 **Astuce** : Activez les notifications pour ne rien manquer !'
        )
        .setTimestamp();
      await generalChannel.send({ embeds: [welcomeEmbed] });
      console.log('   ✅ Message envoyé dans #💬・général');
    }
    // Message persistant d'avis dans #⭐・avis-membres
    const avisMembresChannel = createdChannels['⭐・avis-membres'];
    if (avisMembresChannel) {
      const avisEmbed = new EmbedBuilder()
        .setTitle('⭐ VOTRE AVIS COMPTE !')
        .setDescription(
          'Vous appréciez notre bot Vinted Sniper ? Partagez votre expérience avec le reste de la communauté !\n\n' +
          'Cliquez sur le bouton ci-dessous pour laisser une note et un commentaire en quelques secondes.'
        )
        .setColor(0x00c1b7)
        .setFooter({ text: 'Vinted Sniper Bot • Avis Utilisateurs' });

      const avisRow = {
        type: 1,
        components: [
          {
            type: 2,
            style: 1, // PRIMARY
            label: '⭐ Donner mon avis',
            custom_id: 'btn_laisser_avis'
          }
        ]
      };

      await avisMembresChannel.send({ embeds: [avisEmbed], components: [avisRow] });
      console.log('   ✅ Message avec bouton d\'avis envoyé dans #⭐・avis-membres');
    }

    // Message persistant dans #🙋・support
    const supportChannel = createdChannels['🙋・support'];
    if (supportChannel) {
      const supportEmbed = new EmbedBuilder()
        .setTitle('🙋 SERVICE CLIENTS & SUPPORT')
        .setDescription(
          'Besoin d\'aide avec le Bot Sniper, votre abonnement VIP, ou une question sur son fonctionnement ?\n\n' +
          'Cliquez sur le bouton ci-dessous pour **ouvrir un ticket d\'assistance privé**.\n\n' +
          '💬 Notre **assistant virtuel intelligent** tentera de répondre instantanément à vos questions. Si sa réponse ne suffit pas, vous pourrez demander à parler à un **humain** en un clic !'
        )
        .setColor(0x00c1b7)
        .setFooter({ text: 'HMZ Vinted Sniper • Centre d\'Assistance' });

      const supportRow = {
        type: 1,
        components: [
          {
            type: 2,
            style: 1, // PRIMARY
            label: '📩 Ouvrir un Ticket',
            custom_id: 'btn_ouvrir_ticket'
          }
        ]
      };

      await supportChannel.send({ embeds: [supportEmbed], components: [supportRow] });
      console.log('   ✅ Message de support envoyé dans #🙋・support');
    }

    // Message promotionnel VIP persistant dans #🛍️・toutes-alertes
    const toutesAlertesChannel = createdChannels['🛍️・toutes-alertes'];
    if (toutesAlertesChannel) {
      const promoEmbed = new EmbedBuilder()
        .setTitle('👑 DÉBLOQUEZ L\'ACCÈS VIP INSTANTANÉ !')
        .setDescription(
          '**Marre d\'arriver trop tard sur les meilleures affaires ?** 😢\n\n' +
          'Ce salon gratuit (`#🛍️・toutes-alertes`) reçoit toutes les alertes, mais avec **3 minutes de retard**.\n' +
          'À ce moment-là, 99% des articles rentables sont déjà achetés par nos membres VIP !\n\n' +
          '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
          '**Avantages de l\'accès 👑 Premium VIP :**\n' +
          '> ⚡ **Alertes Instantanées à la seconde près** sur les salons dédiés (Nike, Jordan, Corteiz, Supreme, Stone Island...).\n' +
          '> 📉 **Détection des baisses de prix** instantanées pour négocier avant les autres.\n' +
          '> 🔔 **Abonnements personnalisés** aux marques de votre choix via boutons interactifs.\n\n' +
          '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
          'Cliquez sur le bouton ci-dessous pour débloquer vos accès VIP instantanément !'
        )
        .setColor(0xf1c40f)
        .setThumbnail('https://upload.wikimedia.org/wikipedia/commons/thumb/2/29/Vinted_logo.png/600px-Vinted_logo.png')
        .setFooter({ text: 'HMZ Vinted Sniper • Boostez vos bénéfices' });

      const promoRow = {
        type: 1,
        components: [
          {
            type: 2,
            style: 5, // LINK
            label: '👑 Devenir VIP - Accès Instantané',
            url: 'https://whop.com/joined/hmz6391/products/bot-vinted-cf/'
          }
        ]
      };

      await toutesAlertesChannel.send({ embeds: [promoEmbed], components: [promoRow] });
      console.log('   ✅ Message promotionnel VIP envoyé dans #🛍️・toutes-alertes');
    }

    console.log('');

    // Créer des webhooks pour tous les salons d'alertes
    const webhookChannels = [
      '👟・nike',
      '👟・adidas',
      '👟・jordan',
      '💀・corteiz',
      '🟥・supreme',
      '⭐・trapstar',
      '🎱・stussy',
      '🛠️・carhartt',
      '🐴・ralph-lauren',
      '🐊・lacoste',
      '🧭・stone-island',
      '🏔️・the-north-face',
      '❄️・moncler',
      '🌴・palm-angels',
      '🦖・arcteryx',
      '📉・baisses-de-prix',
      '🛍️・toutes-alertes'
    ];
    const webhooks = {};
    
    for (const chName of webhookChannels) {
      const channel = createdChannels[chName];
      if (channel) {
        const webhook = await channel.createWebhook({
          name: 'Vinted Sniper Bot',
          avatar: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/29/Vinted_logo.png/600px-Vinted_logo.png'
        });
        webhooks[chName] = webhook.url;
        console.log(`   🔗 Webhook #${chName} :`);
        console.log(`      ${webhook.url}`);
      }
    }

    // Sauvegarder les webhooks dans un fichier de référence
    const webhookConfig = {
      note: 'Webhooks générés automatiquement par setup-discord.js',
      date: new Date().toISOString(),
      webhooks
    };
    fs.writeFileSync(path.join(__dirname, 'discord-webhooks.json'), JSON.stringify(webhookConfig, null, 2), 'utf-8');

    console.log('\n═══════════════════════════════════════');
    console.log('  ✅  SETUP TERMINÉ AVEC SUCCÈS !');
    console.log('═══════════════════════════════════════');
    console.log(`\n📁 Les URLs des webhooks ont été sauvegardées dans discord-webhooks.json`);
    console.log(`\n💡 Prochaine étape :`);
    console.log(`   Copie le webhook souhaité dans ton config.json (champ "webhookUrl")`);
    console.log(`   ou configure un webhook par recherche pour cibler les salons.\n`);

  } catch (error) {
    console.error('❌ Erreur lors du setup :', error.message);
    console.error(error);
  }

  client.destroy();
  process.exit(0);
});

client.login(TOKEN).catch(err => {
  console.error('❌ Impossible de se connecter au bot Discord :', err.message);
  console.error('   Vérifie que le token dans le fichier .env est correct.');
  process.exit(1);
});
