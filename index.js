import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import express from 'express';
import { execSync } from 'child_process';
import { Client, GatewayIntentBits, Partials, ActivityType } from 'discord.js';
import { fetchVintedItems, fetchSellerProfile } from './src/vintedApi.js';
import { sendDiscordAlert, SLASH_COMMANDS, handleInteraction, handleMessage } from './src/discord.js';

dotenv.config();

// Tenter d'installer automatiquement le navigateur au démarrage
try {
  console.log('[BOT] Initialisation et vérification des dépendances du navigateur...');
  execSync('npx playwright install chromium', { stdio: 'inherit' });
  console.log('[BOT] Navigateur prêt !');
} catch (err) {
  console.error('[BOT] Note d\'initialisation du navigateur :', err.message);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.join(__dirname, 'config.json');

// S'assurer que le fichier config.json existe
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('[BOT] Le fichier config.json est manquant. Création d\'un fichier par défaut...');
  const defaultConfig = {
    webhookUrl: "ENTREZ_VOTRE_WEBHOOK_DISCORD_ICI",
    checkIntervalMs: 5000,
    botStatus: {
      text: "Snipe Vinted 🎯",
      type: "Watching",
      presence: "online"
    },
    premiumConfig: {
      enabled: true,
      requiredRole: "Premium",
      whitelistedUsers: []
    },
    searches: [],
    antiScam: {
      enabled: true,
      minFeedbackCount: 1,
      maxPriceForZeroFeedback: 15
    },
    freeAlertDelayMs: 180000,
    excludedKeywords: ["boite", "boîte", "fausse", "copie", "recherche", "facture", "fake", "wtb", "wtt"]
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2), 'utf-8');
}

/**
 * Nettoie une chaîne pour faciliter la comparaison (minuscules et sans accents).
 */
function cleanString(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // Supprime les diacritiques (accents)
}

/**
 * Vérifie si le titre de l'article contient des mots exclus.
 * @param {string} title - Le titre de l'article
 * @param {Array<string>} keywords - La liste des mots-clés exclus
 * @returns {string|null} Le mot-clé ayant causé le blocage, ou null s'il est sain
 */
function checkExcludedKeywords(title, keywords) {
  if (!keywords || keywords.length === 0) return null;
  const cleanTitle = cleanString(title);
  
  for (const kw of keywords) {
    if (!kw) continue;
    const cleanKw = cleanString(kw);
    if (cleanTitle.includes(cleanKw)) {
      return kw;
    }
  }
  return null;
}

/**
 * Vérifie si le vendeur de l'article est suspecté de scam.
 * @param {Object} item - L'article Vinted
 * @param {Object} antiScamConfig - Paramètres du filtre anti-scam
 * @returns {string|null} Le motif du blocage anti-scam, ou null s'il est sain
 */
function checkAntiScam(item, antiScamConfig) {
  if (!antiScamConfig || !antiScamConfig.enabled) return null;
  
  const user = item.user || {};
  const feedbackCount = user.feedback_count || 0;
  const itemPrice = parseFloat(item.price?.amount || item.price || 0);

  // Règle unique intelligente : 0 avis ET prix élevé = potentiel scam
  // Un vendeur avec 0 avis peut légitimement vendre, sauf si le prix est suspect
  if (feedbackCount === 0 && itemPrice > antiScamConfig.maxPriceForZeroFeedback) {
    return `Profil à 0 avis vendant à un prix élevé (${itemPrice.toFixed(2)} € > seuil ${antiScamConfig.maxPriceForZeroFeedback} €)`;
  }

  return null;
}

// File d'attente pour les alertes différées (canal public gratuit)
const delayedAlertsQueue = [];

/**
 * Traite et envoie les alertes différées qui ont dépassé leur heure d'attente.
 */
async function processDelayedAlerts() {
  const now = Date.now();
  const readyAlerts = delayedAlertsQueue.filter(alert => now >= alert.sendAt);
  
  if (readyAlerts.length > 0) {
    console.log(`[⏱️ RETARDATEUR] ${readyAlerts.length} alertes prêtes pour le salon public.`);
  }

  for (const alert of readyAlerts) {
    const idx = delayedAlertsQueue.indexOf(alert);
    if (idx !== -1) {
      delayedAlertsQueue.splice(idx, 1);
    }
  }

  for (const alert of readyAlerts) {
    try {
      console.log(`[⏱️ ENVOI DIFFÉRÉ] Article ${alert.item.id} ("${alert.item.title}") envoyé avec succès après délai.`);
      await sendDiscordAlert(alert.webhookUrl, alert.item, alert.options);
      await sleep(500);
    } catch (err) {
      console.error(`[⏱️ ENVOI DIFFÉRÉ] Impossible d'envoyer l'alerte différée :`, err.message);
    }
  }
}

// Cache pour stocker les articles vus : Map(articleId -> dernierPrixConnu)
// Permet de détecter à la fois les nouveaux articles ET les baisses de prix.
const seenItems = new Map();
let isFirstRun = true;

let activeDiscordClient = null;

/**
 * Met à jour le statut du bot Discord en fonction de la configuration.
 */
function updateBotStatus(client, config) {
  if (!client || !client.user) return;
  const statusConfig = config.botStatus || {
    text: "Snipe Vinted 🎯",
    type: "Watching",
    presence: "online"
  };

  const text = statusConfig.text || "Snipe Vinted 🎯";
  const presence = statusConfig.presence || "online";
  
  let typeValue = ActivityType.Watching;
  switch (statusConfig.type?.toLowerCase()) {
    case 'playing':
      typeValue = ActivityType.Playing;
      break;
    case 'streaming':
      typeValue = ActivityType.Streaming;
      break;
    case 'listening':
      typeValue = ActivityType.Listening;
      break;
    case 'watching':
      typeValue = ActivityType.Watching;
      break;
    case 'competing':
      typeValue = ActivityType.Competing;
      break;
    case 'custom':
      typeValue = ActivityType.Custom;
      break;
  }

  try {
    client.user.setPresence({
      activities: [{ name: text, type: typeValue }],
      status: presence
    });
  } catch (error) {
    console.error(`[DISCORD] Impossible de mettre à jour le statut :`, error.message);
  }
}

/**
 * Pause l'exécution pendant un nombre donné de millisecondes.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Boucle principale de surveillance.
 */
async function monitorLoop() {
  console.log(`\n[BOT] Début de la surveillance...`);
  
  while (true) {
    try {
      // Traiter en priorité les alertes retardées prêtes
      await processDelayedAlerts();
      // Charger dynamiquement la configuration à chaque cycle pour appliquer les changements du fichier config.json à chaud
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      
      // Mettre à jour dynamiquement le statut du bot
      if (activeDiscordClient) {
        updateBotStatus(activeDiscordClient, config);
      }

      const webhookUrl = config.webhookUrl;
      const checkIntervalMs = config.checkIntervalMs || 5000;
      const searches = config.searches || [];
      const antiScam = config.antiScam || { enabled: false, minFeedbackCount: 0, maxPriceForZeroFeedback: 0 };
      const excludedKeywords = config.excludedKeywords || [];

      // Ne parcourir que les recherches activées
      const activeSearches = searches.filter(s => s.enabled !== false);

      if (activeSearches.length === 0) {
        console.log('[BOT] Aucune recherche active configurée dans config.json.');
        await sleep(3000);
        continue;
      }

      for (const search of activeSearches) {
        console.log(`[BOT] Analyse de la recherche: "${search.name}"...`);
        
        try {
          const items = await fetchVintedItems(search.url);
          let newItemsCount = 0;
          let priceDropCount = 0;

          // Vinted retourne les plus récents en premier
          // On parcourt de bas en haut (plus ancien au plus récent)
          for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            const currentPrice = parseFloat(item.price?.amount || item.price || 0);
            
            // --- CAS 1 : ARTICLE DÉJÀ VU → Vérifier la baisse de prix ---
            if (seenItems.has(item.id)) {
              const previousPrice = seenItems.get(item.id);
              // Si le prix a baissé, c'est une alerte de baisse de prix
              if (currentPrice > 0 && previousPrice > 0 && currentPrice < previousPrice) {
                // Mettre à jour le prix dans le cache
                seenItems.set(item.id, currentPrice);
                
                if (!isFirstRun) {
                  priceDropCount++;
                  const dropPct = (((previousPrice - currentPrice) / previousPrice) * 100).toFixed(0);
                  console.log(`[📉 BAISSE] Article ${item.id} ("${item.title}") : ${previousPrice.toFixed(2)} € → ${currentPrice.toFixed(2)} € (-${dropPct}%)`);
                  
                  const dropOptions = {
                    ping: search.ping || '',
                    priceDrop: {
                      oldPrice: previousPrice,
                      newPrice: currentPrice
                    }
                  };

                  // 1. Envoi instantané au salon Premium (Webhook spécifique)
                  if (search.webhook && search.webhook !== 'ENTREZ_VOTRE_WEBHOOK_DISCORD_ICI') {
                    console.log(`[⚡ PREMIUM BAISSE] Envoi immédiat baisse de prix pour l'article ${item.id} dans #${search.name}`);
                    await sendDiscordAlert(search.webhook, item, dropOptions);
                  }

                  // 2. Envoi retardé au salon Public (Webhook global #toutes-alertes)
                  if (webhookUrl && webhookUrl !== 'ENTREZ_VOTRE_WEBHOOK_DISCORD_ICI') {
                    const delayMs = config.freeAlertDelayMs || 180000; // 3 minutes
                    const sendAt = Date.now() + delayMs;
                    console.log(`[⏱️ RETARDATEUR BAISSE] Baisse de prix article ${item.id} mise en file d'attente pour le salon public (envoi dans ${delayMs / 1000}s).`);
                    delayedAlertsQueue.push({
                      webhookUrl,
                      item,
                      options: {
                        ping: '', 
                        priceDrop: dropOptions.priceDrop
                      },
                      sendAt
                    });
                  }

                  await sleep(500);
                }
              } else {
                // Prix identique ou augmenté → mettre à jour silencieusement
                seenItems.set(item.id, currentPrice);
              }
              continue;
            }
            
            // --- CAS 2 : NOUVEL ARTICLE ---
            seenItems.set(item.id, currentPrice);
            
            // Appliquer les filtres de sécurité (Option B)
            const blockKeyword = checkExcludedKeywords(item.title, excludedKeywords);
            if (blockKeyword) {
              console.log(`[FILTRE MOT EXCLU] Article ${item.id} ("${item.title}") ignoré car il contient le mot exclus "${blockKeyword}".`);
              continue;
            }

            // Enrichir les données vendeur avec le vrai profil (avis, note, etc.)
            if (item.user?.id) {
              const realProfile = await fetchSellerProfile(item.user.id);
              if (realProfile) {
                item.user.feedback_count = realProfile.feedback_count ?? item.user.feedback_count;
                item.user.positive_feedback_rating = realProfile.positive_feedback_rating ?? item.user.positive_feedback_rating;
                item.user.login = realProfile.login ?? item.user.login;
              }
            }

            const blockScamReason = checkAntiScam(item, antiScam);
            if (blockScamReason) {
              console.log(`[FILTRE ANTI-SCAM] Article ${item.id} ("${item.title}") ignoré: ${blockScamReason}.`);
              continue;
            }

            // Ne pas notifier au premier lancement pour éviter le spam des anciens articles
            if (!isFirstRun) {
              newItemsCount++;
              
              // 1. Envoi instantané au salon Premium (Webhook spécifique)
              if (search.webhook && search.webhook !== 'ENTREZ_VOTRE_WEBHOOK_DISCORD_ICI') {
                console.log(`[⚡ PREMIUM INSTANTANÉ] Envoi immédiat pour l'article ${item.id} dans #${search.name}`);
                await sendDiscordAlert(search.webhook, item, {
                  ping: search.ping || ''
                });
              }

              // 2. Envoi retardé au salon Public (Webhook global #toutes-alertes)
              if (webhookUrl && webhookUrl !== 'ENTREZ_VOTRE_WEBHOOK_DISCORD_ICI') {
                const delayMs = config.freeAlertDelayMs || 180000; // 3 minutes
                const sendAt = Date.now() + delayMs;
                console.log(`[⏱️ RETARDATEUR] Article ${item.id} mis en file d'attente pour le salon public (envoi dans ${delayMs / 1000}s).`);
                delayedAlertsQueue.push({
                  webhookUrl,
                  item,
                  options: { ping: '' }, 
                  sendAt
                });
              }
              
              // Respecter le débit limite de Discord
              await sleep(500);
            }
          }

          if (isFirstRun) {
            console.log(`[BOT] "${search.name}" initialisé. ${items.length} articles mis en cache.`);
          } else {
            if (newItemsCount > 0) console.log(`[BOT] 🆕 ${newItemsCount} nouvelles offres détectées pour "${search.name}" !`);
            if (priceDropCount > 0) console.log(`[BOT] 📉 ${priceDropCount} baisses de prix détectées pour "${search.name}" !`);
            if (newItemsCount === 0 && priceDropCount === 0) console.log(`[BOT] Aucun changement pour "${search.name}".`);
          }

        } catch (searchError) {
          console.error(`[ERREUR] Impossible d'analyser la recherche "${search.name}":`, searchError.message);
        }

        // Pause entre chaque URL de recherche pour ne pas saturer l'API de Vinted
        await sleep(1500);
      }

      if (isFirstRun) {
        isFirstRun = false;
        console.log('[BOT] ✅ Initialisation terminée. Prêt à repérer les nouvelles offres et les baisses de prix !');
      }

      // Nettoyage préventif : limiter la taille du cache pour éviter les fuites mémoire
      if (seenItems.size > 10000) {
        const entriesToDelete = seenItems.size - 5000;
        const iterator = seenItems.keys();
        for (let i = 0; i < entriesToDelete; i++) {
          seenItems.delete(iterator.next().value);
        }
        console.log(`[CACHE] Nettoyage préventif : ${entriesToDelete} anciens articles supprimés du cache (taille actuelle : ${seenItems.size}).`);
      }

      // Attendre l'intervalle configuré avant le prochain scan global
      console.log(`[BOT] En veille pendant ${checkIntervalMs / 1000} secondes avant le prochain scan...`);
      await sleep(checkIntervalMs);

    } catch (globalError) {
      console.error('[ERREUR GLOBAL] Une erreur est survenue dans la boucle principale:', globalError.message);
      await sleep(5000);
    }
  }
}

// Lancement du bot
console.log('╔═══════════════════════════════════════════════╗');
console.log('║     🎯 VINTED SNIPER DISCORD BOT v2.0 PRO    ║');
console.log('║  Détection : Nouveautés + Baisses de Prix     ║');
console.log('║  Proxies   : Rotation automatique             ║');
console.log('║  Discord   : Pings + Bouton Négocier          ║');
console.log('╚═══════════════════════════════════════════════╝');

const TOKEN = process.env.DISCORD_BOT_TOKEN;

function isValidDiscordToken(token) {
  if (!token) return false;
  return token.length > 50 && token.includes('.');
}

if (isValidDiscordToken(TOKEN)) {
  console.log('[BOT] Initialisation du client Discord interactif...');
  
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.User
    ]
  });

  client.once('ready', async () => {
    console.log(`[DISCORD] Connecté avec succès en tant que ${client.user.tag}`);
    
    activeDiscordClient = client;
    
    // Initialisation du statut
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      updateBotStatus(client, config);
      console.log(`[DISCORD] Statut initialisé avec succès.`);
    } catch (e) {
      console.error('[DISCORD] Impossible d\'initialiser le statut initial:', e.message);
    }
    
    // Enregistrer les commandes slash sur chaque serveur
    for (const guild of client.guilds.cache.values()) {
      try {
        await guild.commands.set(SLASH_COMMANDS);
        console.log(`[DISCORD] Commandes Slash installées instantanément sur : ${guild.name}`);
      } catch (err) {
        console.error(`[DISCORD] Impossible de configurer les commandes sur ${guild.name}:`, err.message);
      }
    }

    // Lancement de la boucle de scan
    monitorLoop().catch(err => {
      console.error('[FATAL] Erreur fatale dans le scanner Vinted:', err);
    });
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      await handleInteraction(interaction, CONFIG_PATH);
    } catch (interError) {
      console.error('[DISCORD] Erreur d\'interaction:', interError.message);
    }
  });

  client.on('messageCreate', async (message) => {
    try {
      await handleMessage(message, CONFIG_PATH);
    } catch (msgError) {
      console.error('[DISCORD] Erreur de traitement du message support:', msgError.message);
    }
  });

  client.login(TOKEN).catch(err => {
    console.error('[DISCORD] Échec de la connexion du Bot Discord :', err.message);
    console.log('[BOT] Repli en mode autonome (Webhook uniquement)...');
    monitorLoop().catch(err => {
      console.error('[FATAL] Erreur fatale dans le scanner Vinted:', err);
    });
  });
} else {
  console.log('[DISCORD] Token Discord absent ou invalide dans .env (Format non reconnu).');
  console.log('[DISCORD] Fonctionnement en mode autonome (Webhook uniquement).');
  console.log('[DISCORD] Pour activer le contrôle à distance, configurez un jeton de bot valide dans .env.');
  monitorLoop().catch(err => {
    console.error('[FATAL] Erreur fatale dans le scanner Vinted:', err);
  });
}

// ═══════════════════════════════════════════════════
//  SERVEUR WEB EXPRESS POUR L'HÉBERGEMENT GRATUIT 24/7
// ═══════════════════════════════════════════════════

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('🎯 Vinted Sniper Bot is active and operational! 24/7 Free Hosting Mode.');
});

app.listen(PORT, () => {
  console.log(`[SERVER] Serveur Web d'uptime démarré sur le port ${PORT}`);
});
