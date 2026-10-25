# Mes comptes

Application web de gestion des comptes et d'analyse, **hors ligne** : les données (base SQLite) restent
dans le navigateur de l'appareil et dans les fichiers `.sqlite` que tu sauvegardes. Rien n'est envoyé
nulle part, et le dépôt ne contient que le code.

**Adresse : https://marynedey.github.io/Comptabilite/**

Sur téléphone ou tablette : ouvrir l'adresse dans Chrome, puis menu ⋮ → « Ajouter à l'écran d'accueil »
(ou « Installer l'application »). Elle s'ouvre ensuite comme une appli, même sans réseau.

## Appli Android

Sur Android, « Mes comptes » existe aussi en vraie appli (dossier `mobile/`, faite avec Capacitor) :
le même code que le site, mais rangé dans l'APK. Elle s'ouvre et marche sans réseau dès le premier
lancement, sans barre de navigateur.

- **Installer** : ouvrir https://marynedey.github.io/Comptabilite/android/ dans Chrome sur le téléphone
  (page d'installation : bouton de téléchargement de `mes-comptes-X.Y.Z.apk` et marche à suivre).
- **Reprendre ses comptes** (une fois) : l'appli a son propre stockage. Dans Chrome, **Sauvegarder** ;
  dans l'appli, **Charger une sauvegarde**. L'appli le propose à sa première ouverture.
- **Sauvegarder** dans l'appli : le fichier `comptes_….sqlite` va dans **Téléchargements**.
- **Mises à jour** : à chaque version publiée, l'appli affiche « Nouvelle version · Mettre à jour /
  Plus tard ». « Mettre à jour » télécharge la nouvelle version et Android demande confirmation ;
  les données sont gardées. « Plus tard » : elle sera reproposée au prochain lancement. La première fois,
  Android demande d'autoriser « Mes comptes » à installer ses mises à jour.
- **Données** : elles restent sur le téléphone (pas de sauvegarde Google automatique de l'appli).

Le site (PC, Chrome/Edge) ne change pas.

### Comment c'est construit

- `mobile/preparer.mjs` copie l'app web dans `mobile/www/` (sans `sw.js` : dans l'appli, c'est elle qui
  propose les mises à jour), puis `cap sync` la range dans le projet Android `mobile/android/`.
- Module natif `MesComptesPlugin.java`, volontairement limité : écrire une sauvegarde (nom
  `comptes_….sqlite` uniquement) dans Téléchargements, installer une mise à jour venue de
  `https://marynedey.github.io/Comptabilite/android/` uniquement.
- La version de l'APK est celle de `js/app.js` (`versionCode` = X·10000 + Y·100 + Z) : une seule commande
  `npm run nouvelle-version` pour les deux. Un changement dans `mobile/` demande aussi une nouvelle version.
- Le contrôle « Appli Android » construit l'APK sur chaque PR (téléchargeable dans l'onglet *Actions*,
  *Artifacts*) ; après fusion, l'APK (`android/mes-comptes-X.Y.Z.apk`), `android/version.json` et la page
  d'installation (`mobile/installer.html` → `android/index.html`) sont publiés avec le site.

### Clé de signature

Android n'accepte une mise à jour que si elle est signée par la **même clé** que l'appli installée.
La clé n'est jamais dans le dépôt : *Settings → Secrets and variables → Actions* :
`ANDROID_CLE` (fichier `.jks` en base64) et `ANDROID_CLE_MOT_DE_PASSE` (alias `mes-comptes`).
Sans ces secrets, l'APK est construit sans signature et n'est pas publié.
Si la clé est perdue ou changée : dans l'appli, Sauvegarder, désinstaller, installer la nouvelle appli,
Charger la sauvegarde.

## Passer de l'ancien fichier `comptes_vXX.html` à l'adresse

Chaque adresse a son propre stockage : les données de l'ancien fichier ne sont pas visibles
automatiquement à la nouvelle adresse.
1. Dans l'ancien fichier : **Sauvegarder** (télécharge `comptes_….sqlite`).
2. À l'adresse : **Charger une sauvegarde** → choisir ce fichier.

## Mises à jour

Une nouvelle version publiée s'installe toute seule en arrière-plan. Un bandeau
« Nouvelle version de l'application · Mettre à jour » apparaît : un appui recharge l'app sans rien perdre
(sinon elle est utilisée au prochain lancement). La version est affichée en haut de la barre latérale.

### Publier une modification

1. Travailler sur une branche, ouvrir une PR vers `main`.
2. Augmenter la version (une seule commande, met à jour `js/app.js` et `sw.js`) :
   ```
   npm run nouvelle-version -- correction       # 2.0.0 → 2.0.1  (bug corrigé)
   npm run nouvelle-version -- fonctionnalite   # 2.0.0 → 2.1.0  (nouveauté)
   npm run nouvelle-version -- majeure          # 2.0.0 → 3.0.0  (changement incompatible)
   ```
3. Les tests tournent sur la PR. Quand tout est vert : fusionner.
4. Après la fusion, les tests repassent sur `main` puis l'app est **publiée automatiquement**
   (≈ 2 min) et la version est étiquetée (`v2.0.1`…, onglet *Tags*).

Les numéros de version sont dans le code, plus dans le nom du fichier ; l'historique est celui de git.

## Organisation

| Chemin | Rôle |
|---|---|
| `index.html` | structure de la page |
| `css/app.css` | styles (clair / sombre) |
| `js/app.js` | toute l'application ; `VERSION` en haut du fichier |
| `sw.js` | service worker : met l'app en cache pour le hors-ligne, propose les mises à jour |
| `manifest.webmanifest`, `icons/` | installation sur l'écran d'accueil (`icons/icone.svg` = dessin d'origine) |
| `vendor/` | bibliothèques tierces, non modifiées : sql.js 1.10.3 (MIT) et pdf.js 3.11.174 (Apache 2.0) |
| `tests/` | tests (voir ci-dessous) |
| `mobile/` | appli Android (Capacitor) : `preparer.mjs`, `capacitor.config.json`, projet `android/`, module natif `MesComptesPlugin.java` |
| `outils/` | `version.mjs` (changer de version), `verifier-version.mjs` (contrôle des PR), `verifier-syntaxe.cjs` (syntaxe des scripts) |

Pas d'étape de build : les fichiers sont publiés tels quels.

## Tests

```
npm ci                       # une fois (installe Playwright, pour les tests seulement)
npm test                     # rapide : logique de l'app + cohérence des fichiers
npm run test:navigateur      # parcours complets dans Chromium
npm run verifier-version     # la version a-t-elle augmenté ?
npm run serveur              # voir l'app en local : http://localhost:8000
```

- `npm test` charge `js/app.js` dans Node avec le vrai moteur SQLite : montants, dates, import QIF,
  récurrences (échéances créées, prévisionnel, solde), lecture d'un relevé PDF, rapprochement, CSV Amex,
  migration de base ; plus : versions identiques dans `js/app.js` et `sw.js`, tous les fichiers en cache
  hors ligne, aucune base `.sqlite`/relevé dans le dépôt.
- `npm run test:navigateur` : démarrage sans erreur, saisie d'une opération, conservation après
  rechargement, sauvegarde `.sqlite` puis chargement dans un autre navigateur, lecture d'un PDF,
  fonctionnement hors ligne, bandeau de nouvelle version (sans perte de saisie), largeur sur téléphone.

Sur chaque PR, trois contrôles : **Tests unitaires**, **Parcours navigateur**, **Version augmentée**.

## Réglages GitHub (une seule fois)

1. **Publication** : *Settings → Pages → Build and deployment → Source : GitHub Actions*.
   GitHub Pages n'est gratuit que pour un dépôt **public** (le dépôt ne contient que le code, aucune
   donnée) ; sinon il faut un compte GitHub Pro.
2. **Protéger `main`** : *Settings → Rules → Rulesets → New branch ruleset* :
   cible `main` (*Include default branch*), cocher *Restrict deletions*, *Block force pushes*,
   *Require a pull request before merging* et *Require status checks to pass* avec
   « Tests unitaires », « Parcours navigateur », « Version augmentée » (et « Appli Android »).
