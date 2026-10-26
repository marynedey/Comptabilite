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
- Appli Android : `mobile/` (Capacitor 8). L'APK contient l'app web (copiée par `mobile/preparer.mjs`, sans
  `sw.js`) ; `js/app.js` détecte l'appli (`enAppli()`) : pas de service worker, sauvegarde par le module natif
  `MesComptes` (Téléchargements), mise à jour proposée d'après `android/version.json` publié avec le site.
  Module natif limité (nom de sauvegarde et adresse de mise à jour vérifiés) : ne pas l'élargir sans en parler.
  APK construit par le job « Appli Android » ; signé avec les secrets `ANDROID_CLE`, `ANDROID_CLE_MOT_DE_PASSE`.
  Le SDK Android n'est pas téléchargeable dans une session cloud (dl.google.com bloqué) : construire via Actions.
- Réglages de l’appareil (vue `reglages`, rubriques repliables `<details>` : titre + résumé d’une ligne + flèche) : jamais dans la table `meta` (elle part dans les sauvegardes).
  Dossier de sauvegarde : `idbPutKey('dossierSauvegarde', handle)` sur PC, SharedPreferences côté natif dans l'appli.
  Chrome 153 de la session cloud plante en relisant un FileSystemHandle depuis IndexedDB (bogue du navigateur) :
  le parcours « réglages (PC) » passe sur GitHub (Chromium de Playwright).
- Une seule fenêtre à la fois sur PC (`prendreLaFenetre`, verrou `navigator.locks`) : chaque fenêtre réécrit toute
  la base, deux fenêtres s'écraseraient. La 2e affiche « déjà ouvert » sans ouvrir la base.
- Interface téléphone (`body.mobile`, `estTelephone()` : appli Android, ou écran tactile < 600 px) : en-tête
  `#m-entete` (liste déroulante des comptes), onglets `#m-onglets` (Opérations, Analyse, Échéances, Plus), vue `plus`.
  Le PC et la tablette gardent la barre latérale. Les écrans sont refaits pour le téléphone un par un (une PR chacun).
- Réglages d'affichage (`REGLAGES` : thème auto/clair/sombre, barres de recherche en haut/bas, montants masqués à
  l'ouverture) : `localStorage` `mc.reglages` de l'appareil. Thème forcé = `html[data-theme]` ; toute couleur sombre
  ajoutée au CSS doit l'être pour `@media (prefers-color-scheme: dark){:root:not([data-theme="clair"])…}` ET
  `:root[data-theme="sombre"]`.
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
