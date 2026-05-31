import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getVintedSession } from './session.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

let currentSession = null;
let sessionPromise = null;

/**
 * Récupère ou rafraîchit la session Vinted active (cookies et User-Agent).
 * Utilise un mécanisme de verrou (promise) pour éviter de lancer plusieurs navigateurs en même temps.
 */
async function ensureSession(forceRefresh = false) {
  if (sessionPromise) {
    return sessionPromise;
  }

  if (!currentSession || forceRefresh) {
    sessionPromise = getVintedSession().then(session => {
      currentSession = session;
      sessionPromise = null;
      return session;
    }).catch(err => {
      sessionPromise = null;
      throw err;
    });
    return sessionPromise;
  }

  return currentSession;
}

/**
 * Sélectionne un proxy aléatoire depuis la config et retourne les agents HTTP/HTTPS.
 * @returns {{ httpAgent: HttpProxyAgent, httpsAgent: HttpsProxyAgent } | null}
 */
function getAxiosProxyAgents() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const proxies = config.proxies || [];
    if (proxies.length === 0) return null;

    const proxyUrl = proxies[Math.floor(Math.random() * proxies.length)];
    if (!proxyUrl) return null;

    const fullUrl = proxyUrl.startsWith('http') ? proxyUrl : `http://${proxyUrl}`;
    console.log(`[PROXY] Requête API via proxy : ${fullUrl.replace(/\/\/.*@/, '//***:***@')}`);

    return {
      httpAgent: new HttpProxyAgent(fullUrl),
      httpsAgent: new HttpsProxyAgent(fullUrl)
    };
  } catch {
    return null;
  }
}

/**
 * Convertit une URL de recherche Vinted classique (copiée depuis le navigateur) 
 * en URL d'API Vinted interne (/api/v2/catalog/items).
 * @param {string} webUrl - L'URL copiée depuis vinted.fr/catalog
 * @returns {string} L'URL de l'API correspondante
 */
export function convertWebUrlToApiUrl(webUrl) {
  try {
    const urlObj = new URL(webUrl);
    const apiParams = new URLSearchParams();

    // Toujours s'assurer d'avoir le tri par nouveautés
    apiParams.set('order', 'newest_first');
    apiParams.set('page', '1');
    apiParams.set('per_page', '20');

    // Analyser tous les paramètres de l'URL web
    for (const [key, value] of urlObj.searchParams.entries()) {
      // Nettoyer les clés de type tableau comme brand_ids[] ou catalog[]
      let cleanKey = key.replace('[]', '');
      
      // Vinted utilise "catalog[]" dans l'URL web mais "catalog_ids" dans l'API
      if (cleanKey === 'catalog') {
        cleanKey = 'catalog_ids';
      }
      
      // Gérer les cas où il y a des clés similaires (ex: multiples brand_ids)
      if (apiParams.has(cleanKey)) {
        const existing = apiParams.get(cleanKey);
        apiParams.set(cleanKey, `${existing},${value}`);
      } else {
        apiParams.set(cleanKey, value);
      }
    }

    return `https://www.vinted.fr/api/v2/catalog/items?${apiParams.toString()}`;
  } catch (error) {
    console.error(`[API] Échec de conversion de l'URL ${webUrl}:`, error.message);
    // Si la conversion échoue, on renvoie une URL par défaut
    return 'https://www.vinted.fr/api/v2/catalog/items?order=newest_first&page=1&per_page=20';
  }
}

/**
 * Interroge l'API Vinted pour récupérer les derniers articles d'une URL de recherche.
 * @param {string} searchUrl - L'URL web ou API Vinted
 * @returns {Promise<Array>} Liste des articles trouvés
 */
export async function fetchVintedItems(searchUrl) {
  const apiUrl = searchUrl.includes('/api/v2/') ? searchUrl : convertWebUrlToApiUrl(searchUrl);
  
  let attempts = 0;
  const maxAttempts = 2;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const session = await ensureSession(attempts > 1);

      // Préparer les options de requête avec rotation de proxy
      const requestOptions = {
        headers: {
          'User-Agent': session.userAgent,
          'Cookie': session.cookieString,
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'fr-FR,fr;q=0.9',
          'Connection': 'keep-alive',
          'Referer': 'https://www.vinted.fr/catalog',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin'
        },
        timeout: 10000
      };

      // Injecter les agents proxy si disponibles
      const proxyAgents = getAxiosProxyAgents();
      if (proxyAgents) {
        requestOptions.httpAgent = proxyAgents.httpAgent;
        requestOptions.httpsAgent = proxyAgents.httpsAgent;
      }

      const response = await axios.get(apiUrl, requestOptions);

      if (response.data && response.data.items) {
        return response.data.items;
      }
      
      return [];
    } catch (error) {
      console.warn(`[API] Tentative ${attempts}/${maxAttempts} échouée pour ${apiUrl}:`, error.message);
      
      if (error.response && (error.response.status === 401 || error.response.status === 403)) {
        console.warn('[API] Session expirée ou bloquée par Cloudflare (401/403). Rafraîchissement forcé de la session au prochain essai...');
        // Forcer le rafraîchissement des cookies au prochain tour de boucle
        currentSession = null;
      } else {
        // Pour les autres erreurs (timeout, réseau, etc.), on n'insiste pas forcément
        if (attempts >= maxAttempts) throw error;
      }
    }
  }
  
  return [];
}

// --- Cache des profils vendeurs (pour ne pas re-fetch le même vendeur) ---
const sellerCache = new Map(); // Map(userId -> { data, timestamp })
const SELLER_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Récupère le profil complet d'un vendeur via l'API Vinted.
 * Les données sont cachées pendant 10 minutes pour éviter les requêtes inutiles.
 * @param {number|string} userId - L'ID du vendeur Vinted
 * @returns {Promise<Object|null>} Le profil complet du vendeur, ou null en cas d'échec
 */
export async function fetchSellerProfile(userId) {
  if (!userId) return null;

  // Vérifier le cache
  const cached = sellerCache.get(userId);
  if (cached && (Date.now() - cached.timestamp) < SELLER_CACHE_TTL) {
    return cached.data;
  }

  try {
    const session = await ensureSession();
    const profileUrl = `https://www.vinted.fr/api/v2/users/${userId}`;

    const requestOptions = {
      headers: {
        'User-Agent': session.userAgent,
        'Cookie': session.cookieString,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Referer': `https://www.vinted.fr/member/${userId}`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin'
      },
      timeout: 8000
    };

    // Injecter les agents proxy si disponibles
    const proxyAgents = getAxiosProxyAgents();
    if (proxyAgents) {
      requestOptions.httpAgent = proxyAgents.httpAgent;
      requestOptions.httpsAgent = proxyAgents.httpsAgent;
    }

    const response = await axios.get(profileUrl, requestOptions);

    if (response.data && response.data.user) {
      const profile = response.data.user;
      // Mettre en cache
      sellerCache.set(userId, { data: profile, timestamp: Date.now() });

      // Nettoyage préventif du cache vendeurs
      if (sellerCache.size > 500) {
        const now = Date.now();
        for (const [key, val] of sellerCache) {
          if (now - val.timestamp > SELLER_CACHE_TTL) sellerCache.delete(key);
        }
      }

      return profile;
    }
    return null;
  } catch (error) {
    // Ne pas encombrer les logs avec les limites de taux (429) qui sont gérées silencieusement
    if (!error.response || error.response.status !== 429) {
      console.warn(`[API] Impossible de récupérer le profil vendeur #${userId}:`, error.message);
    }
    return null;
  }
}
