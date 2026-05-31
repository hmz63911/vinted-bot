# 🎯 Vinted Sniper Discord Bot (v1.0)

Un bot de surveillance et d'alerte ultra-rapide (latence < 1s) qui envoie les nouvelles annonces Vinted directement sur ton salon Discord avec des liens d'achat sécurisés en 1-Clic.

---

## ⚡ Caractéristiques

* **Performance Sniper** : Requêtes API ultra-rapides en arrière-plan (réponse en 200ms au lieu de 5 secondes avec un navigateur complet).
* **Furtivité Anti-Détection** : Utilise Playwright Stealth pour récupérer discrètement les cookies de session et contourner Cloudflare.
* **Achat 1-Clic Ultra-Rapide** : Chaque alerte Discord possède un lien pré-rempli qui ouvre ton navigateur ou ton application directement sur l'écran final de validation de paiement. Tu n'as plus qu'à cliquer sur "Confirmer" !
* **Initialisation sans Spam** : Au démarrage, le bot met en cache les articles existants sans t'envoyer 100 notifications inutiles. Il ne t'alerte que pour les nouveautés publiées après le lancement.

---

## 🚀 Guide de Démarrage Rapide

### 1. Prérequis
Toutes les dépendances et navigateurs requis ont déjà été installés et préconfigurés par ton assistant IA.

### 2. Configuration du Webhook Discord
1. Ouvre ton serveur Discord personnel.
2. Va dans les **Paramètres du salon** où tu souhaites recevoir les offres.
3. Clique sur **Intégrations** -> **Webhooks** -> **Créer un webhook**.
4. Personnalise le nom (ex: "Vinted Sniper") et copie l'**URL du Webhook**.

### 3. Configurer le Bot
Ouvre le fichier [config.json](file:///C:/Users/facil/.gemini/antigravity/scratch/vinted-bot/config.json) et :
1. Remplace `"ENTREZ_VOTRE_WEBHOOK_DISCORD_ICI"` par l'URL que tu viens de copier.
2. Ajoute ou modifie tes URL de recherche Vinted cibles dans le tableau `searches`.

#### 💡 Comment obtenir une URL de recherche cible ?
1. Va sur [Vinted.fr](https://www.vinted.fr).
2. Applique tes filtres préférés (Marque, Taille, Prix max, etc.).
3. **Important** : Trie les résultats par **"Plus récent"** (tri chronologique).
4. Copie l'adresse complète depuis ton navigateur (ex: `https://www.vinted.fr/catalog?search_text=nike&price_to=30&order=newest_first`).
5. Colle cette URL dans le champ `url` d'une recherche dans le fichier `config.json`.

### 4. Lancer le Bot
Ouvre ton terminal dans le dossier du bot et exécute :
```bash
npm start
```
Le bot va initialiser le cache, récupérer la session de contournement Cloudflare, puis commencer son travail de sniper en tâche de fond !

---

## 🛡️ Conseils pour éviter les blocages

* **Intervalle de rafraîchissement** : Par défaut, la fréquence de scrutation `checkIntervalMs` est fixée à `5000` (5 secondes). C'est parfait si tu as 1 ou 2 URLs. Si tu configures plus de 5 URLs, nous te conseillons d'augmenter cet intervalle à `8000` ou `10000` pour ne pas déclencher le rate-limiting de Vinted.
* **Sécurité du compte** : Ce bot n'a pas accès à tes identifiants Vinted, il est donc 100% sûr pour ton compte bancaire et ton profil !
