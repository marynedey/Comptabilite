# Mes comptes — notes pour Claude

App web de comptes personnels, en français, hors ligne. Publiée sur https://marynedey.github.io/Comptabilite/
(GitHub Pages, par le workflow après fusion dans `main`). Voir `README.md` pour l'organisation détaillée.

## Architecture
- Pas de build, pas de serveur, pas de dépendance à l'exécution. `index.html` charge dans l'ordre
  `vendor/sql-wasm.js`, `vendor/pdf.min.js`, puis `js/app.js` (script classique, **pas** un module :
  le HTML appelle des fonctions globales via `onclick=…`).
- Données : base SQLite (sql.js) gardée dans IndexedDB (`mescomptes`) ; sauvegarde/chargement par fichier
  `.sqlite`. **Aucune donnée personnelle dans le dépôt** (un test l'interdit).
- `sw.js` : cache de l'app pour le hors-ligne. Pas de `skipWaiting` automatique : l'app affiche le bandeau
  `#maj` et n'active la nouvelle version qu'au clic (après `flushIDB()`), pour ne jamais recharger en pleine saisie.
  Compléter `FICHIERS` quand on ajoute/renomme un fichier (un test le vérifie).
- Sauvegarde NAS : `serveur-nas/sauvegarde.py` (Python stdlib, `GET /ping`, `PUT /sauvegardes/comptes_….sqlite`,
  jeton Bearer, CORS limité à l'app). Côté app : `nasConfig` (localStorage `mc.nas`, jamais dans la base),
  `nasEnvoyer`, sauvegarde en attente dans IndexedDB (`nas-attente`, seule la plus récente) renvoyée par `nasRelancer`.
  Installation chez l'utilisatrice : VM OpenMediaVault sous Proxmox, tunnel Cloudflare (voir `serveur-nas/LISEZMOI.md`).
- `vendor/` : sql.js 1.10.3 et pdf.js 3.11.174, tels quels (ne pas modifier).

## Versions
À **chaque** changement de l'app : `npm run nouvelle-version -- correction|fonctionnalite|majeure`
(met à jour `VERSION` dans `js/app.js` et `mc-app-X.Y.Z` dans `sw.js`). Le contrôle « Version augmentée »
échoue sinon. Ne plus mettre de numéro dans les noms de fichiers.

## Tests (obligatoires pour fusionner dans `main`)
- `npm test` : `tests/charger-app.mjs` exécute `js/app.js` dans Node (DOM factice, vrai SQLite) ; les fonctions
  globales sont des propriétés du contexte. Ajouter un test dans `tests/logique.test.mjs` pour toute logique
  nouvelle ou corrigée. `js/app.js` doit garder `boot();` seul sur sa dernière ligne utile.
- `npm run test:navigateur` : Playwright. Dans une session cloud, utiliser le Chromium installé :
  `CHROMIUM=/opt/pw-browsers/chromium npm run test:navigateur`.
- Avant de pousser : `npm test`, `npm run test:navigateur`, `npm run verifier-version`.
