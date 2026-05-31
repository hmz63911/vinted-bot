import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// Ajouter le plugin stealth pour contourner Cloudflare
chromium.use(stealthPlugin());

/**
 * Lit un proxy au hasard depuis config.json et le prépare pour Playwright.
 */
function getPlaywrightProxy() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const proxies = config.proxies || [];
    if (proxies.length === 0) return null;
    
    const randomProxy = proxies[Math.floor(Math.random() * proxies.length)];
    if (!randomProxy) return null;
    
    let proxyStr = randomProxy;
    if (!proxyStr.startsWith('http://') && !proxyStr.startsWith('https://')) {
      proxyStr = 'http://' + proxyStr;
    }
    
    const url = new URL(proxyStr);
    const proxyConfig = {
      server: `${url.protocol}//${url.host}`
    };
    if (url.username) {
      proxyConfig.username = decodeURIComponent(url.username);
    }
    if (url.password) {
      proxyConfig.password = decodeURIComponent(url.password);
    }
    return proxyConfig;
  } catch (error) {
    return null;
  }
}

/**
 * Lance un navigateur invisible pour charger la page d'accueil de Vinted et récupérer
 * les cookies de session ainsi que le User-Agent nécessaires pour faire des requêtes API directes.
 * @returns {Promise<{cookieString: string, userAgent: string}>}
 */
export async function getVintedSession() {
  console.log('[SESSION] Démarrage du navigateur furtif pour récupérer une session Vinted...');
  
  const proxy = getPlaywrightProxy();
  const launchOptions = { headless: true };
  if (proxy) {
    launchOptions.proxy = proxy;
    console.log(`[SESSION] Utilisation du proxy pour le navigateur : ${proxy.server}`);
  }
  
  const browser = await chromium.launch(launchOptions);

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();

    // Bloquer les images et les ressources lourdes pour aller plus vite
    await page.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2}', route => route.abort());

    // Aller sur Vinted (on cible vinted.fr)
    await page.goto('https://www.vinted.fr', { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Attendre un peu que Cloudflare et les scripts de base s'exécutent (3 secondes)
    await page.waitForTimeout(3000);

    // Récupérer le User-Agent réel utilisé par Playwright
    const userAgent = await page.evaluate(() => navigator.userAgent);

    // Récupérer tous les cookies du contexte
    const cookies = await context.cookies();
    
    if (cookies.length === 0) {
      throw new Error("Aucun cookie récupéré de Vinted. Blocage potentiel par Cloudflare.");
    }

    // Formater les cookies sous forme de chaîne 'Nom=Valeur; Nom2=Valeur2'
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    console.log(`[SESSION] Session récupérée avec succès (${cookies.length} cookies trouvés).`);
    
    await browser.close();
    
    return {
      cookieString,
      userAgent
    };
  } catch (error) {
    console.error('[SESSION] Erreur lors de la récupération de la session Vinted:', error.message);
    try {
      await browser.close();
    } catch (_) {}
    throw error;
  }
}
