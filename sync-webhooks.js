import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.join(__dirname, 'config.json');
const WEBHOOKS_PATH = path.join(__dirname, 'discord-webhooks.json');

if (!fs.existsSync(CONFIG_PATH) || !fs.existsSync(WEBHOOKS_PATH)) {
  console.error('Fichiers manquants pour la synchronisation.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const webhooksData = JSON.parse(fs.readFileSync(WEBHOOKS_PATH, 'utf-8'));
const webhooks = webhooksData.webhooks;

// Webhook général
config.webhookUrl = webhooks['🛍️・toutes-alertes'] || config.webhookUrl;

// Mapping des salons
const mapping = {
  'nike': '👟・nike',
  'adidas': '👟・adidas',
  'jordan': '👟・jordan',
  'corteiz': '💀・corteiz',
  'supreme': '🟥・supreme',
  'trapstar': '⭐・trapstar',
  'stussy': '🎱・stussy',
  'carhartt': '🛠️・carhartt',
  'ralph lauren': '🐴・ralph-lauren',
  'lacoste': '🐊・lacoste',
  'stone island': '🧭・stone-island',
  'the north face': '🏔️・the-north-face',
  'moncler': '❄️・moncler',
  'palm angels': '🌴・palm-angels',
  'arc\'teryx': '🦖・arcteryx',
  'oakley': '🕶️・oakley',
  'diesel': '👖・diesel',
  'patagonia': '🌲・patagonia',
  'new balance': '👟・new-balance'
};

if (config.searches) {
  config.searches = config.searches.map(search => {
    const nameLower = search.name.toLowerCase();
    
    // Trouver la clé de mapping correspondante
    let foundKey = Object.keys(mapping).find(key => nameLower.includes(key));
    if (foundKey) {
      const channelName = mapping[foundKey];
      if (webhooks[channelName]) {
        search.webhook = webhooks[channelName];
        console.log(`✅ Synchronisé : ${search.name} -> ${channelName}`);
      }
    }
    return search;
  });
}

fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
console.log('🎉 Synchronisation de config.json terminée avec succès !');
