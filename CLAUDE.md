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
  Module natif limité (nom de sauvegarde et adresse de mise à jour vérifiés, plus `verrouDisponible` / `deverrouiller` :
  fenêtre d'Android empreinte, visage ou code, androidx.biometric ; `fondBarres` : fond clair / sombre derrière les
  barres d'Android selon le thème de l'app, `majBarresAppli`) : ne pas l'élargir sans en parler.
  Verrouillage (`REGLAGES.verrou`, `verrouDelai` en min) : écran `#verrou` à l'ouverture et au retour après le délai
  (`doitVerrouiller`) ; le va-et-vient pendant la fenêtre d'Android ne compte pas (`verrouEnCours`). Rien sur PC.
  APK construit par le job « Appli Android » ; signé avec les secrets `ANDROID_CLE`, `ANDROID_CLE_MOT_DE_PASSE`.
  Le SDK Android n'est pas téléchargeable dans une session cloud (dl.google.com bloqué) : construire via Actions.
- Guide (vue `guide`, Plus › Guide sur téléphone, barre latérale sur PC) : `sectionsGuide(mob)`, une rubrique repliable par
  écran, mots adaptés au téléphone ou au PC. **Le mettre à jour** quand une fonction visible change.
  « Rechercher une mise à jour » (Plus, bas des Réglages) : `rechercherMaj` (service worker, ou `version.json` dans l'appli).
- Réglages de l’appareil (vue `reglages`, rubriques repliables `<details>` : titre + résumé d’une ligne + flèche) : jamais dans la table `meta` (elle part dans les sauvegardes).
  Dossier de sauvegarde : `idbPutKey('dossierSauvegarde', handle)` sur PC, SharedPreferences côté natif dans l'appli.
  Chrome 153 de la session cloud plante en relisant un FileSystemHandle depuis IndexedDB (bogue du navigateur) :
  le parcours « réglages (PC) » passe sur GitHub (Chromium de Playwright).
- Une seule fenêtre à la fois sur PC (`prendreLaFenetre`, verrou `navigator.locks`) : chaque fenêtre réécrit toute
  la base, deux fenêtres s'écraseraient. La 2e affiche « déjà ouvert » sans ouvrir la base.
- Interface téléphone (`body.mobile`, `estTelephone()` : appli Android, ou écran tactile sans souris) : en-tête
  `#m-entete` (liste déroulante des comptes), onglets `#m-onglets` (Opérations, Analyse, Échéances, Plus), vue `plus`.
  Le PC (souris ou pavé tactile) garde la barre latérale ; la tablette prend l'interface du téléphone (centrée,
  720 px max). L'appli dessine sous la barre d'état d'Android (`viewport-fit=cover`) : tout élément fixé en haut
  ajoute `env(safe-area-inset-top)`. Retour (Android ou navigateur) ferme d'abord fenêtre / feuille ouverte (`fermerFeuilles`,
  aussi sur `popstate`). Feuille ou fenêtre ouverte : `main` ne défile plus derrière.
- Opération rapprochée : seul son montant total est figé (`saveOp` le vérifie) ; catégories, ventilation (même total),
  destinataire, date, commentaire restent modifiables, depuis la fiche comme depuis le formulaire.
- Catégories sur téléphone : montant total (opérations effectives, tous comptes) et nombre d'opérations ; toucher une
  catégorie ouvre `#m-catana` (`renderAnalyseCategorie`, état `CA`) : par mois (12 derniers) ou par année, sous-catégories,
  opérations. Il est sous la fenêtre de saisie et la fiche (z-index), qui s'ouvrent par-dessus.
- Tiers et catégories se renomment ou se fusionnent (`renommerTiersDb`, `fusionnerTiersDb`, `renommerCategorieDb`,
  `fusionnerCategoriesDb`) : `cat_path`, `hay` des opérations et échéances suivent. Une catégorie ne fusionne qu'avec une
  catégorie du même niveau (même parent) : ses sous-catégories s'ajoutent au même niveau, celles au nom identique
  fusionnent ; on choisit le nom gardé. Téléphone : appui long sur une catégorie ou un tiers → Renommer / Fusionner
  (`menuCategorie`, `menuTiers`).
- Montants et textes qui ne doivent pas passer à la ligne (anneau, comparaisons de l'analyse, total d'une catégorie) :
  `ajusterTaille` réduit la police ; mesurer sur un écran affiché (pas `hidden`).
- Plein écran dans l'appli : pas `requestFullscreen` ; barres d'Android cachées par SystemBars (`barresAppliCachees`).
- Fluidité : l'écran affiché se garde dans `localStorage` (`mc.nav`), jamais dans la base (sinon réécriture complète de la
  base à chaque navigation) ; soldes du jour de la liste calculés pour les seules lignes affichées (`soldesApres`) ;
  pas de `:hover` sans `@media (hover:hover)` (il reste collé au doigt sur Android) ; pas de sélecteur `[style*=…]`
  dans un `:has()` (recalcul de toute la page à chaque changement de style).
- Barres (analyse, analyse d'une catégorie) : hauteurs en px (`hauteurBarre`), pas en % (pas toujours suivi sur Android).
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
