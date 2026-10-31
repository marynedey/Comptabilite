// Parcours complets dans Chromium : l'app servie comme sur GitHub Pages.
// Lancer : npm run test:navigateur
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const RACINE = new URL('../../', import.meta.url).pathname;
const VERSION = readFileSync(join(RACINE, 'js/app.js'), 'utf8').match(/VERSION = '([\d.]+)'/)[1];

/* ---------- serveur statique (sous-dossier, comme marynedey.github.io/Comptabilite/) ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.json': 'application/json' };
let serveur, BASE;
let versionPubliee = null; // simule la publication d'une nouvelle version (sw.js + js/app.js)

before(async () => {
  serveur = createServer((req, res) => {
    let chemin = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!chemin.startsWith('/Comptabilite/')) { res.writeHead(404); return res.end(); }
    chemin = normalize(chemin.slice('/Comptabilite/'.length) || 'index.html');
    if (chemin === 'android/' || chemin === 'android/index.html') chemin = 'mobile/installer.html'; // publiée là par le workflow
    const fichier = join(RACINE, chemin);
    if (chemin.startsWith('..') || !existsSync(fichier) || statSync(fichier).isDirectory()) { res.writeHead(404); return res.end(); }
    let corps = readFileSync(fichier);
    if (versionPubliee && (chemin === 'sw.js' || chemin === 'js/app.js'))
      corps = corps.toString().replaceAll(VERSION, versionPubliee);
    res.writeHead(200, { 'content-type': TYPES[extname(fichier)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(corps);
  });
  await new Promise(r => serveur.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${serveur.address().port}/Comptabilite/`;
});
after(() => serveur.close());

/* ---------- outils ---------- */
async function ouvrir({ preparer, ...options } = {}) {
  // CHROMIUM : chemin d'un Chromium déjà installé (sinon celui de Playwright, cf. tests.yml).
  const navigateur = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : { channel: 'chromium' });
  const contexte = await navigateur.newContext({ locale: 'fr-FR', acceptDownloads: true, ...options });
  if (preparer) await preparer(contexte);
  const page = await contexte.newPage();
  page.erreurs = [];
  page.on('pageerror', e => page.erreurs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') page.erreurs.push(m.text()); });
  await allerA(page);
  return { navigateur, contexte, page };
}
async function allerA(page) {
  await page.goto(BASE);
  await demarree(page);
}
// « À jour » : l'indicateur est caché sur téléphone, on lit son texte
const aJour = page => page.waitForFunction(() => /À jour/.test(document.getElementById('status-txt').textContent));
const demarree = page => page.waitForFunction(() => /opérations/.test(document.getElementById('brandver')?.textContent || ''), null, { timeout: 30000 });
const swActif = page => page.evaluate(async () => { await navigator.serviceWorker.ready; return !!navigator.serviceWorker.controller; });

/* La fenêtre d'opération place le curseur dans « Destinataire » 30 ms après son ouverture (sauf écran tactile) :
   taper avant ferait atterrir le texte dans le mauvais champ (un humain n'est jamais aussi rapide). */
async function fenetreOperationPrete(page) {
  await page.locator('#overlay #i-dest').waitFor({ state: 'visible' });
  await page.waitForFunction(() => ecranTactile() || document.activeElement === document.getElementById('i-dest'));
  if (await page.evaluate(() => ecranTactile())) await page.waitForTimeout(80); // téléphone : le curseur peut aller dans le montant
}
async function ajouterOperation(page, { dest, montant, date, cat }) {
  await page.keyboard.press('a');
  await fenetreOperationPrete(page);
  await page.fill('#i-dest', dest);
  await page.fill('#i-cat0', cat);
  await page.click('#i-date', { clickCount: 3 });
  await page.keyboard.type(date.replaceAll('/', ''));
  await page.fill('#i-montant', montant);
  await page.click('#overlay button.primary:has-text("Enregistrer")');
  await page.locator('#overlay #i-dest').waitFor({ state: 'hidden' });
}

/* ---------- parcours ---------- */

test('démarrage : version affichée, compte par défaut, aucune erreur', async () => {
  const { navigateur, page } = await ouvrir();
  try {
    assert.match(await page.textContent('#brandver'), new RegExp(`Application v${VERSION.replaceAll('.', '\\.')}`));
    assert.match(await page.textContent('#acctlist'), /Compte courant/);
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('saisie d\'une opération : visible, gardée après rechargement, sauvegarde puis rechargement dans un autre navigateur', async () => {
  const { navigateur, page } = await ouvrir();
  try {
    await ajouterOperation(page, { dest: 'Boulangerie du coin', montant: '4,50', date: '05/01/26', cat: 'Alimentation' });
    assert.match(await page.textContent('#v-registre'), /Boulangerie du coin/);
    assert.match(await page.textContent('#status-txt'), /1 modification non sauvegardée/);

    // Les données restent dans le navigateur (IndexedDB).
    await page.waitForTimeout(1200); // écriture différée (0,9 s)
    await allerA(page);
    assert.match(await page.textContent('#v-registre'), /Boulangerie du coin/);
    assert.match(await page.textContent('#brandver'), /1 opérations/);

    // Sauvegarde : fichier .sqlite téléchargé.
    const [telechargement] = await Promise.all([page.waitForEvent('download'), page.click('button[onclick="sauvegarder()"]:visible')]);
    assert.match(telechargement.suggestedFilename(), /^comptes_\d{4}-\d{2}-\d{2}_\d{2}h\d{2}m\d{2}s?\.sqlite$/);
    const fichier = await telechargement.path();
    assert.match(await page.textContent('#status-txt'), /À jour/);

    // Un autre navigateur (autre appareil) : charger la sauvegarde.
    const autre = await ouvrir();
    try {
      assert.doesNotMatch(await autre.page.textContent('#v-registre'), /Boulangerie du coin/);
      await autre.page.setInputFiles('#fileDb', fichier);
      await autre.page.click('#dlgFoot button:has-text("Charger ce fichier")');
      await autre.page.waitForFunction(() => /Boulangerie du coin/.test(document.getElementById('v-registre').textContent));
      assert.deepEqual(autre.page.erreurs, []);
    } finally { await autre.navigateur.close(); }
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('relevé PDF : pdf.js et son worker lisent le texte', async () => {
  const { navigateur, page } = await ouvrir();
  try {
    const pdf = pdfMinimal(['C/C EUROCOMPTE N 00012345601 en euros', '05/01/2026 PAIEMENT CB BOULANGERIE 4,50']);
    const texte = await page.evaluate(async b64 => {
      const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const pages = await lirePdf(buf);
      return pages.flat().map(i => i.str).join(' | ');
    }, pdf.toString('base64'));
    assert.match(texte, /EUROCOMPTE/);
    assert.match(texte, /BOULANGERIE 4,50/);
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('hors ligne : l\'app s\'ouvre sans réseau, avec ses données', async () => {
  const { navigateur, contexte, page } = await ouvrir();
  try {
    assert.ok(await swActif(page) || (await allerA(page), await swActif(page)), 'service worker actif');
    await ajouterOperation(page, { dest: 'Marché', montant: '12', date: '06/01/26', cat: 'Alimentation' });
    await page.waitForTimeout(1200);
    await contexte.setOffline(true);
    await allerA(page);
    assert.match(await page.textContent('#v-registre'), /Marché/);
    // le lecteur de PDF aussi est disponible hors ligne
    assert.ok(await page.evaluate(async () => (await lirePdf(new Uint8Array(0)).catch(e => e.name)) === 'InvalidPDFException'));
  } finally { await navigateur.close(); }
});

test('page d\'installation de l\'appli : pas remplacée par l\'app quand le service worker est actif', async () => {
  const { navigateur, page } = await ouvrir();
  try {
    assert.ok(await swActif(page) || (await allerA(page), await swActif(page)), 'service worker actif');
    await page.goto(BASE + 'android/');
    assert.match(await page.title(), /Installer Mes comptes/);
    assert.equal(await page.getAttribute('a.bouton', 'href'), 'mes-comptes-__VERSION__.apk');
  } finally { await navigateur.close(); }
});

test('nouvelle version publiée : bandeau, mise à jour sans perdre la saisie', async () => {
  const { navigateur, page } = await ouvrir();
  try {
    if (!await swActif(page)) await allerA(page);
    await ajouterOperation(page, { dest: 'Pharmacie', montant: '8,20', date: '07/01/26', cat: 'Santé' });
    assert.ok(await page.isHidden('#maj'));

    versionPubliee = '99.0.0';
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await page.locator('#maj').waitFor({ state: 'visible' });
    // rien n'a été rechargé tout seul
    assert.match(await page.textContent('#brandver'), new RegExp(`v${VERSION.replaceAll('.', '\\.')}`));

    await Promise.all([page.waitForEvent('load'), page.click('#maj button')]);
    await demarree(page);
    assert.match(await page.textContent('#brandver'), /Application v99\.0\.0/);
    assert.match(await page.textContent('#v-registre'), /Pharmacie/, 'la saisie faite juste avant est gardée');
    assert.ok(await page.isHidden('#maj'));
    assert.deepEqual(page.erreurs, []);
  } finally { versionPubliee = null; await navigateur.close(); }
});

test('téléphone : rien ne dépasse en largeur', async () => {
  const { navigateur, page } = await ouvrir({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  try {
    for (const vue of ['registre', 'analyse', 'graphiques', 'tiers', 'categories', 'recurrences', 'corbeille', 'plus', 'reglages']) {
      await page.evaluate(v => setView(v), vue);
      const deborde = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(deborde <= 0, `${vue} : ${deborde}px de trop en largeur`);
    }
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

/* ---------- appli Android : le pont Capacitor et le module natif sont simulés ---------- */
const SITE_APPLI = 'https://marynedey.github.io/Comptabilite/android/';
function fauxCapacitor() {
  window.__appels = [];
  window.__natif = { peutInstaller: { ok: false } }; // réponses du faux module natif
  window.Capacitor = {
    isNativePlatform: () => true,
    nativePromise: (plugin, methode, options) => { window.__appels.push([plugin, methode, options]); return Promise.resolve(window.__natif[methode] || {}); },
    nativeCallback: (plugin, methode, options, rappel) => { window.__appels.push([plugin, methode, options]); window.__retourAndroid = rappel; },
  };
}
const appels = (page, methode) => page.evaluate(m => window.__appels.filter(a => a[1] === m).map(a => a[2]), methode);
const ouvrirAppli = () => ouvrir({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  preparer: async contexte => {
    await contexte.addInitScript(fauxCapacitor);
    await contexte.route(SITE_APPLI + 'version.json', r => r.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: { version: '9.9.9', apk: SITE_APPLI + 'mes-comptes-9.9.9.apk' } }));
  },
});

test('appli Android : bienvenue, pas de service worker, sauvegarde native, mise à jour proposée, Retour', async () => {
  const { navigateur, page } = await ouvrirAppli();
  try {
    // Première ouverture (aucune opération) : on explique comment reprendre ses comptes de Chrome.
    await page.locator('#dlgBack.show #dlgTitle:has-text("Bienvenue")').waitFor();
    await page.click('#dlgFoot button:has-text("Plus tard")');
    assert.equal(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(r => r.length)), 0);
    assert.equal(await page.getAttribute('#fileDb', 'accept'), null); // sinon Android n'ouvre pas le choix de fichier
    assert.equal(await page.isVisible('#btn-fs'), false);

    // Nouvelle version publiée : bandeau ; d'abord l'autorisation d'Android, puis l'installation.
    await page.locator('#maj-appli:has-text("9.9.9")').waitFor();
    // le bandeau : même écart au-dessus des onglets qu'en dessous du bouton +
    const bd = await page.locator('#maj-appli').boundingBox(), fab = await page.locator('.m-fab').boundingBox(), ong = await page.locator('#m-onglets').boundingBox();
    assert.ok(Math.abs((bd.y - (fab.y + fab.height)) - (ong.y - (bd.y + bd.height))) <= 2, 'écarts égaux');
    await page.click('#maj-appli button:has-text("Mettre à jour")');
    await page.click('#dlgFoot button:has-text("Ouvrir le réglage")');
    assert.equal((await appels(page, 'autoriserInstallation')).length, 1);
    assert.deepEqual(await appels(page, 'installer'), []);
    await page.evaluate(() => { window.__natif.peutInstaller = { ok: true }; });
    await page.click('#maj-appli button:has-text("Mettre à jour")');
    await page.waitForFunction(() => window.__appels.some(a => a[1] === 'installer'));
    assert.deepEqual(await appels(page, 'installer'), [{ url: SITE_APPLI + 'mes-comptes-9.9.9.apk' }]);
    await page.click('#maj-appli button:has-text("Plus tard")');
    assert.equal(await page.isVisible('#maj-appli'), false);

    // Sauvegarde : le fichier part au module natif (Téléchargements), pas en téléchargement.
    await ajouterOperation(page, { dest: 'Boulangerie du coin', montant: '4,50', date: '05/01/26', cat: 'Alimentation' });
    await page.click('button[onclick="sauvegarder()"]:visible');
    await aJour(page);
    const [sauvegarde] = await appels(page, 'enregistrer');
    assert.match(sauvegarde.nom, /^comptes_\d{4}-\d{2}-\d{2}_\d{2}h\d{2}m\d{2}s?\.sqlite$/);
    assert.equal(Buffer.from(sauvegarde.donnees, 'base64').subarray(0, 15).toString(), 'SQLite format 3');

    // Retour d'Android : ferme une fenêtre ouverte ; sinon, demande avant de quitter.
    await page.evaluate(() => window.__retourAndroid({ canGoBack: false }));
    await page.locator('#dlgBack.show #dlgTitle:has-text("Quitter")').waitFor();
    await page.evaluate(() => window.__retourAndroid({ canGoBack: false }));
    await page.locator('#dlgBack.show').waitFor({ state: 'hidden' });
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('appli Android : fond et icônes des barres d\'Android selon le thème de l\'app, pas celui du téléphone', async () => {
  const { navigateur, page } = await ouvrirAppli();
  try {
    await page.locator('#dlgBack.show #dlgTitle:has-text("Bienvenue")').waitFor();
    await page.click('#dlgFoot button:has-text("Plus tard")');
    const dernier = async m => (await appels(page, m)).at(-1);
    // téléphone en clair, app en « Automatique » : fond clair, icônes foncées
    assert.deepEqual(await dernier('fondBarres'), { sombre: false });
    assert.deepEqual(await dernier('setStyle'), { style: 'LIGHT' });
    // app en sombre sur un téléphone en clair : fond sombre, icônes claires (c'était illisible)
    await page.evaluate(() => changerReglage('theme', 'sombre'));
    assert.deepEqual(await dernier('fondBarres'), { sombre: true });
    assert.deepEqual(await dernier('setStyle'), { style: 'DARK' });
    // « Automatique » : suit le téléphone quand il change de mode
    await page.evaluate(() => changerReglage('theme', 'auto'));
    assert.deepEqual(await dernier('fondBarres'), { sombre: false });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => window.__appels.filter(a => a[1] === 'fondBarres').at(-1)[2].sombre === true);
    assert.deepEqual(await dernier('setStyle'), { style: 'DARK' });
    // plein écran de l'évolution : les barres d'Android se cachent, puis reviennent ; en paysage, tout l'écran
    await page.setViewportSize({ width: 900, height: 400 });
    await page.evaluate(() => grPleinEcran(true));
    assert.equal(await page.locator('#v-graphiques').evaluate(e => Math.round(e.getBoundingClientRect().width)), 900, 'pas la largeur « tablette »');
    assert.equal((await appels(page, 'hide')).length, 1);
    await page.evaluate(() => grPleinEcran(false));
    assert.equal((await appels(page, 'show')).length, 1);
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('appli Android : verrouillage par empreinte ou code — activé après confirmation, à l\'ouverture, au retour, Retour', async () => {
  const { navigateur, page } = await ouvrirAppli();
  const fermerBienvenue = async () => {
    await page.locator('#dlgBack.show #dlgTitle:has-text("Bienvenue")').waitFor();
    await page.click('#dlgFoot button:has-text("Plus tard")');
  };
  try {
    await fermerBienvenue();
    await page.evaluate(() => setView('reglages'));
    assert.equal(await page.isVisible('#rg-verrou'), true);
    await page.click('#rg-verrou summary');
    assert.match(await page.textContent('#rg-verrou-resume'), /Désactivé/);
    // téléphone sans verrouillage d'écran : expliqué, rien ne change
    await page.evaluate(() => { window.__natif.verrouDisponible = { ok: false }; });
    await page.click('#rg-verrou-on');
    await page.locator('#dlgBack.show #dlgTitle:has-text("Verrouillage")').waitFor();
    await page.click('#dlgFoot button');
    assert.equal(await page.isChecked('#rg-verrou-on'), false);
    // activer : Android confirme d'abord l'identité
    await page.evaluate(() => { window.__natif.verrouDisponible = { ok: true }; window.__natif.deverrouiller = { ok: true }; });
    await page.click('#rg-verrou-on');
    await page.waitForFunction(() => REGLAGES.verrou === true);
    assert.deepEqual(await appels(page, 'deverrouiller'), [{ titre: 'Activer le verrouillage' }]);
    assert.equal(await page.isChecked('#rg-verrou-on'), true);
    assert.match(await page.textContent('#rg-verrou-resume'), /Empreinte ou code · après 5 min/);
    await page.click('#rg-verrou-delai button:has-text("Tout de suite")');
    assert.match(await page.textContent('#rg-verrou-resume'), /tout de suite/);

    // à l'ouverture : tout est caché, Android est appelé ; refusé → on reste verrouillé
    await page.reload();
    await page.locator('#verrou:not([hidden])').waitFor();
    await page.waitForFunction(() => window.__appels.some(a => a[1] === 'deverrouiller'));
    await page.locator('#verrou-msg:has-text("Non confirmé")').waitFor();
    assert.equal(await page.isVisible('#verrou'), true);
    // Retour d'Android sur l'écran verrouillé : l'appli passe en arrière-plan, rien ne s'ouvre
    await page.evaluate(() => window.__retourAndroid({ canGoBack: false }));
    assert.equal((await appels(page, 'minimizeApp')).length, 1);
    await page.evaluate(() => { window.__natif.deverrouiller = { ok: true }; });
    await page.click('#verrou button:has-text("Déverrouiller")');
    await page.locator('#verrou').waitFor({ state: 'hidden' });
    await fermerBienvenue();

    // au retour dans l'appli (ici : tout de suite)
    const premierPlan = visible => page.evaluate(v => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => !v });
      document.dispatchEvent(new Event('visibilitychange'));
    }, visible);
    await premierPlan(false);
    assert.equal(await page.isVisible('#verrou'), false); // rien ne se voit avant le retour
    await page.evaluate(() => { window.__natif.deverrouiller = {}; }); // Android ne confirme pas (annulé)
    await premierPlan(true);
    await page.locator('#verrou-msg:has-text("Non confirmé")').waitFor();
    await page.evaluate(() => { window.__natif.deverrouiller = { ok: true }; });
    await page.click('#verrou button:has-text("Déverrouiller")');
    await page.locator('#verrou').waitFor({ state: 'hidden' });
    // 5 min : un aller-retour rapide ne verrouille pas
    await page.evaluate(() => changerReglage('verrouDelai', 5));
    await premierPlan(false); await premierPlan(true);
    assert.equal(await page.isVisible('#verrou'), false);

    // désactiver : confirmation aussi
    await page.evaluate(() => setView('reglages'));
    if (await page.getAttribute('#rg-verrou', 'open') === null) await page.click('#rg-verrou summary');
    await page.click('#rg-verrou-on');
    await page.waitForFunction(() => REGLAGES.verrou === false);
    assert.equal((await appels(page, 'deverrouiller')).at(-1).titre, 'Désactiver le verrouillage');
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('appli Android : Retour ferme d\'abord la feuille des filtres, puis la fiche d\'une opération', async () => {
  const { navigateur, page } = await ouvrirAppli();
  try {
    await page.click('#dlgFoot button:has-text("Plus tard")');
    await page.click('.m-filtrer');
    await page.locator('#f-zone').waitFor({ state: 'visible' });
    await page.evaluate(() => window.__retourAndroid({ canGoBack: true }));
    await page.locator('#f-zone').waitFor({ state: 'hidden' });
    await page.click('#m-ajouter');
    await page.locator('#overlay #i-dest').waitFor({ state: 'visible' });
    await page.evaluate(() => window.__retourAndroid({ canGoBack: true }));
    await page.locator('#overlay #i-dest').waitFor({ state: 'hidden' });
    assert.equal(await page.isVisible('#v-registre'), true);
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('appli Android : sauvegarde refusée par Android → pas comptée comme faite', async () => {
  const { navigateur, page } = await ouvrirAppli();
  try {
    await page.click('#dlgFoot button:has-text("Plus tard")');
    await page.evaluate(() => { window.Capacitor.nativePromise = (p, m) => m === 'enregistrer' ? Promise.reject(new Error('disque plein')) : Promise.resolve({}); });
    await ajouterOperation(page, { dest: 'Pharmacie', montant: '12', date: '06/01/26', cat: 'Santé' });
    await page.click('button[onclick="sauvegarder()"]:visible');
    await page.locator('#dlgBack.show #dlgMsg:has-text("disque plein")').waitFor();
    assert.match(await page.textContent('#status-txt'), /1 modification non sauvegardée/);
  } finally { await navigateur.close(); }
});

test('catégories : en changeant de catégorie, l\'ancienne sous-catégorie est vidée ; toucher le champ montre toute la liste', async () => {
  const { navigateur, page } = await ouvrir();
  try {
    await ajouterOperation(page, { dest: 'Supermarché', montant: '10', date: '05/01/26', cat: 'Alimentation' });
    await page.evaluate(() => { upsertCategorie('Alimentation : Courses'); upsertCategorie('Loisirs : Cinéma'); });
    await page.keyboard.press('a');
    await fenetreOperationPrete(page);
    await page.fill('#i-cat0', 'Alimentation');
    await page.fill('#i-cat1', 'Courses');
    // toucher la catégorie : le champ se vide (la liste entière s'affiche), l'ancien texte reste en indication
    await page.click('#i-cat0');
    assert.equal(await page.inputValue('#i-cat0'), '');
    assert.equal(await page.getAttribute('#i-cat0', 'placeholder'), 'Alimentation');
    await page.keyboard.type('Loisirs');
    await page.click('#i-montant');
    assert.equal(await page.inputValue('#i-cat1'), '', 'Courses n\'est pas une sous-catégorie de Loisirs');
    // toucher puis repartir sans rien choisir : rien ne change
    await page.click('#i-cat0');
    await page.click('#i-montant');
    assert.equal(await page.inputValue('#i-cat0'), 'Loisirs');
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('analyse « Cette année » : moyenne = total ÷ nombre de mois depuis janvier (le 26 octobre : 10 mois)', async () => {
  const { navigateur, page } = await ouvrir({ preparer: c => c.clock.setFixedTime(new Date('2026-10-26T10:00:00')) });
  try {
    const texte = await page.evaluate(() => {
      for (let m = 1; m <= 10; m++)
        run("INSERT INTO operation(compte_id,date_operation,montant,cat_path,statut,supprime,previsionnel) VALUES(?,?,?,?,'pointe',0,0)",
          [state.acc, '2026-' + String(m).padStart(2, '0') + '-01', -100000, 'Test']);
      setView('analyse'); setPeriode('an', 'annee');
      return document.getElementById('v-analyse').innerText;
    });
    assert.match(texte, /Moyenne 1\s000,00\s€ \/ mois/);
    assert.match(texte, /Toutes les dépenses/);
  } finally { await navigateur.close(); }
});

test('dupliquer une opération : mêmes informations, datée d\'aujourd\'hui, l\'originale ne change pas', async () => {
  const { navigateur, page } = await ouvrir({ preparer: c => c.clock.setFixedTime(new Date('2026-10-26T10:00:00')) });
  try {
    await ajouterOperation(page, { dest: 'Loyer', montant: '650', date: '05/10/26', cat: 'Logement' });
    const id = await page.evaluate(() => scal("SELECT id FROM operation WHERE supprime=0"));
    await page.evaluate(i => openModal(i), id);
    await fenetreOperationPrete(page);
    await page.fill('#i-comm', 'octobre');
    await page.click('#overlay button:has-text("Dupliquer")');
    assert.match(await page.textContent('#modal-title'), /copie/);
    assert.equal(await page.inputValue('#i-dest'), 'Loyer');
    assert.equal(await page.inputValue('#i-cat0'), 'Logement');
    assert.equal(await page.inputValue('#i-montant'), '650,00');
    assert.equal(await page.inputValue('#i-comm'), 'octobre');
    assert.equal(await page.inputValue('#i-date'), '26/10/26');
    assert.equal(await page.isVisible('#btn-dup'), false);
    await page.click('#overlay button.primary:has-text("Enregistrer")');
    await page.locator('#overlay #i-dest').waitFor({ state: 'hidden' });
    const ops = await page.evaluate(() => qy("SELECT date_operation d,montant m,statut s,commentaire c FROM operation WHERE supprime=0 ORDER BY id"));
    assert.deepEqual(ops.map(o => [o.d, o.m, o.s, o.c || '']), [['2026-10-05', -65000, 'non_pointe', ''], ['2026-10-26', -65000, 'non_pointe', 'octobre']]);
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

/* ---------- téléphone : onglets en bas, liste des comptes, écran Plus ---------- */
const TELEPHONE = { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

test('téléphone : 4 onglets en bas, plus de barre latérale ; chaque écran allume son onglet', async () => {
  const { navigateur, page } = await ouvrir(TELEPHONE);
  try {
    assert.equal(await page.evaluate(() => document.body.classList.contains('mobile')), true);
    assert.equal(await page.isVisible('aside'), false);
    assert.equal(await page.isVisible('.topbar'), false);
    const onglet = () => page.textContent('#m-onglets button.on');
    assert.match(await onglet(), /Opérations/);
    for (const [o, vue, nom] of [['analyse', 'v-analyse', 'Analyse'], ['recurrences', 'v-recurrences', 'Échéances'], ['plus', 'v-plus', 'Plus'], ['registre', 'v-registre', 'Opérations']]) {
      await page.click(`#m-onglets button[data-o="${o}"]`);
      assert.equal(await page.isVisible('#' + vue), true, vue);
      assert.match(await onglet(), new RegExp(nom));
    }
    // un écran sans onglet (Catégories, depuis Plus) garde « Plus » allumé, avec son titre en haut
    await page.click('#m-onglets button[data-o="plus"]');
    await page.click('#plus-groupes button:has-text("Catégories")');
    assert.equal(await page.isVisible('#v-categories'), true);
    assert.match(await onglet(), /Plus/);
    assert.equal(await page.textContent('#m-titre'), 'Catégories');
    // « Retour » revient à Plus
    await page.goBack();
    assert.equal(await page.isVisible('#v-plus'), true);
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('téléphone : la petite flèche ouvre la liste déroulante des comptes', async () => {
  const { navigateur, page } = await ouvrir(TELEPHONE);
  try {
    await page.evaluate(() => { run("INSERT INTO compte(nom,type,solde_initial,date_ouverture) VALUES('Livret A','epargne',420000,'2026-01-01')"); render(); });
    assert.equal(await page.textContent('#m-compte-nom'), 'Compte courant');
    await page.click('#m-compte-btn');
    assert.equal(await page.isVisible('#m-comptes'), true);
    assert.match(await page.textContent('#m-comptes button:has-text("Livret A")'), /4\s200,00\s€/);
    await page.click('#m-comptes button:has-text("Livret A")');
    assert.equal(await page.isVisible('#m-comptes'), false);
    assert.equal(await page.textContent('#m-compte-nom'), 'Livret A');
    assert.equal(await page.evaluate(() => scal('SELECT nom FROM compte WHERE id=?', [state.acc])), 'Livret A');
    // un toucher à côté referme la liste, et ne fait rien d'autre : ni l'opération, ni l'onglet touchés dessous
    await page.evaluate(() => { run("INSERT INTO operation(compte_id,date_operation,montant,cat_path,statut,supprime,previsionnel,tiers_id,hay) VALUES(?,?,?,?,'non_pointe',0,0,?,?)",
      [state.acc, todayISO(), -450, 'Alimentation', upsertTiers('Boulangerie'), makeHay('Boulangerie', 'Alimentation', null, '', -450, todayISO())]); render(); });
    const toucher = async sel => { const b = await page.locator(sel).first().boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); };
    await page.click('#m-compte-btn');
    await toucher('#m-ops .m-op .m-op-corps');
    assert.equal(await page.isVisible('#m-comptes'), false);
    assert.equal(await page.isVisible('#m-fiche'), false, 'la fiche ne s\'ouvre pas');
    await page.click('#m-compte-btn');
    await toucher('#m-onglets button[data-o="analyse"]');
    assert.equal(await page.isVisible('#m-comptes'), false);
    assert.equal(await page.evaluate(() => state.view), 'registre', 'l\'onglet ne change pas');
    // pareil pour la feuille des filtres et une fenêtre qui se ferme à côté
    await page.evaluate(() => ouvrirFiltres());
    await toucher('#m-ops .m-op .m-op-corps');
    assert.equal(await page.evaluate(() => document.body.classList.contains('filtres-ouverts')), false);
    assert.equal(await page.isVisible('#m-fiche'), false);
    await page.evaluate(() => { dlgOpen({ title: 'Essai', msg: '', fermeDehors: true, buttons: [{ t: 'Fermer', v: true }] }); });
    await page.locator('#dlgBack.show').waitFor();
    await toucher('#m-onglets button[data-o="analyse"]');
    await page.locator('#dlgBack.show').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => state.view), 'registre');
    // ensuite, un toucher fait ce qu'il doit
    await toucher('#m-onglets button[data-o="analyse"]');
    assert.equal(await page.evaluate(() => state.view), 'analyse');
    assert.equal(await page.textContent('#m-compte-nom'), 'Livret A'); // l'analyse suit le compte choisi
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('téléphone, filtres : nombre d\'opérations tout à gauche, dates sur une ligne sans déborder, glisser vers le bas ferme', async () => {
  const { navigateur, page } = await ouvrirTelephone();
  try {
    await opsExemple(page);
    // le nombre d'opérations tout à gauche, « Filtrer » tout à droite, sur la même ligne
    const nb = await page.locator('#m-nb-ops').boundingBox(), f = await page.locator('.m-filtrer').boundingBox(), soldes = await page.locator('#m-soldes').boundingBox();
    assert.ok(Math.abs(nb.x - soldes.x) < 6, 'tout à gauche');
    assert.ok(Math.abs((nb.y + nb.height / 2) - (f.y + f.height / 2)) < 4, 'même ligne');
    assert.ok(f.x + f.width > soldes.x + soldes.width - 6, 'Filtrer tout à droite');
    // « fin du mois prochain » + « Dates… » : tout reste dans une colonne, la feuille défile
    await page.click('.m-filtrer');
    await page.selectOption('#f-horizon', 'finmoisprochain');
    await page.click('#f-periode-wrap button[data-m="perso"]');
    const feuille = page.locator('#f-zone');
    const larg = await feuille.evaluate(e => [e.scrollWidth, e.clientWidth]);
    assert.ok(larg[0] <= larg[1], 'pas de 2e colonne');
    const de = await page.locator('#f-from').boundingBox(), a = await page.locator('#f-to').boundingBox();
    assert.ok(Math.abs(de.y - a.y) < 2 && de.x < a.x, 'du … au … sur une ligne');
    const voir = await page.locator('#m-voir').boundingBox(), zone = await feuille.boundingBox();
    assert.ok(voir.x >= zone.x && voir.x + voir.width <= zone.x + zone.width + 1, '« Voir » dans la feuille');
    // glisser la poignée vers le bas : la feuille suit, puis se ferme ; un petit glissement la remet en place
    const glisser = (dy, sel) => page.evaluate(async ([dy, sel]) => {
      const el = document.querySelector(sel), r = el.getBoundingClientRect(), x = r.left + 20, y = r.top + 5;
      const t = yy => new Touch({ identifier: 1, target: el, clientX: x, clientY: yy });
      el.dispatchEvent(new TouchEvent('touchstart', { touches: [t(y)], bubbles: true, cancelable: true }));
      for (let i = 1; i <= 5; i++) el.dispatchEvent(new TouchEvent('touchmove', { touches: [t(y + dy * i / 5)], bubbles: true, cancelable: true }));
      await new Promise(r => requestAnimationFrame(() => r())); // la feuille suit le doigt à l'image suivante
      const suit = document.getElementById('f-zone').style.transform;
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t(y + dy)], bubbles: true, cancelable: true }));
      return suit;
    }, [dy, sel]);
    await feuille.evaluate(e => { e.scrollTop = 0; });
    assert.equal(await glisser(40, '.m-feuille-tete'), 'translate3d(0px, 40px, 0px)');
    assert.equal(await page.evaluate(() => document.body.classList.contains('filtres-ouverts')), true, 'petit glissement : reste ouverte');
    assert.equal(await feuille.evaluate(e => e.style.transform), '');
    await glisser(200, '.m-feuille-tete');
    assert.equal(await page.evaluate(() => document.body.classList.contains('filtres-ouverts')), false);
    // feuille défilée : glisser vers le bas au milieu la fait défiler, sans la fermer
    await feuille.waitFor({ state: 'hidden' }); // fin de l'animation de fermeture
    await page.setViewportSize({ width: 390, height: 560 }); // petit écran : la feuille défile
    await page.click('.m-filtrer');
    await feuille.evaluate(e => { e.scrollTop = 80; });
    assert.equal(await feuille.evaluate(e => e.scrollTop), 80);
    assert.equal(await glisser(200, '#f-statuts'), '');
    assert.equal(await page.evaluate(() => document.body.classList.contains('filtres-ouverts')), true);
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('téléphone, retours d\'affichage : bulle au-dessus des boutons, « Annuler », anneau, barres d\'une catégorie, tiers, fusion', async () => {
  const { navigateur, page } = await ouvrirTelephone();
  try {
    await page.evaluate(() => {
      const ins = (d, m, dest, cat) => {
        run("INSERT INTO operation(compte_id,date_operation,montant,cat_path,statut,supprime,previsionnel,tiers_id,hay) VALUES(?,?,?,?,'pointe',0,0,?,?)",
          [state.acc, d, m, cat, upsertTiers(dest), makeHay(dest, cat, null, '', m, d)]);
        run('INSERT INTO ventilation(operation_id,categorie_id,montant) VALUES(?,?,?)', [scal('SELECT MAX(id) FROM operation'), upsertCategorie(cat), m]);
      };
      for (let i = 0; i < 10; i++) ins('2026-' + String(i + 1).padStart(2, '0') + '-05', -7802930, 'Notaire', 'Maison : Travaux');
      ins('2026-10-20', -450, 'Boulangerie', 'Alimentation');
      ins('2026-10-10', -50000, 'Quincaillerie', 'Maison');   // directement dans « Maison » (sans sous-catégorie)
      invalidateCaches(); render();
    });
    // la bulle passe au-dessus du bouton + et des onglets
    await page.evaluate(() => toast('Sauvegarde enregistrée dans « Comptes » : comptes_2026-10-30_14h55m11.sqlite'));
    await page.waitForTimeout(350); // fin de l'animation d'apparition
    const bulle = await page.locator('#toast').boundingBox(), plus = await page.locator('.m-fab').boundingBox(), onglets = await page.locator('#m-onglets').boundingBox();
    assert.ok(bulle.y + bulle.height <= plus.y, 'au-dessus du bouton +');
    await page.click('#m-onglets button[data-o="plus"]');
    await page.evaluate(() => toast('Essai'));
    await page.waitForTimeout(350);
    const b2 = await page.locator('#toast').boundingBox();
    assert.ok(b2.y + b2.height <= onglets.y, 'au-dessus des onglets');
    await page.click('#m-onglets button[data-o="registre"]');
    // modifier une opération : « Annuler » (et pas « Passer en annulé »), pas de trait sous la sous-sous-catégorie
    await ligne(page, 'Boulangerie').locator('.m-op-corps').click();
    await page.click('#m-fiche button:has-text("Modifier")');
    assert.equal(await page.textContent('#btn-ann'), 'Annuler');
    assert.equal(await page.locator('#i-cat2').evaluate(e => getComputedStyle(e.closest('.field')).borderBottomStyle), 'none');
    await page.click('#overlay .m-fermer');
    await page.locator('#m-fiche:not([hidden])').waitFor(); await page.click('#m-fiche .mf-retour'); // le formulaire fermé ramène à la fiche
    // analyse sur l'année : le grand total tient dans l'anneau
    await page.click('#m-onglets button[data-o="analyse"]');
    await page.selectOption('#m-analyse .ma-mois-centre select', 'annee');
    const centre = page.locator('#m-analyse .ma-centre b');
    assert.match(await centre.textContent(), /702\s263,70/); // janvier → septembre (année en cours)
    assert.ok(await centre.evaluate(e => e.scrollWidth <= document.querySelector('#m-analyse .ma-anneau svg').getBoundingClientRect().width * 0.6 + 1), 'dans le trou de l\'anneau');
    // comparaisons « … vs 2025 » : toujours sur une ligne, quitte à écrire plus petit
    const lignesComp = await page.locator('#m-analyse .ma-ligne small').evaluateAll(es => es.map(e => [e.textContent, e.scrollWidth - e.clientWidth, e.getBoundingClientRect().height]));
    assert.ok(lignesComp.every(([, deb, h]) => deb <= 1 && h < 22), 'une ligne : ' + JSON.stringify(lignesComp));
    assert.match(lignesComp[0][0], /vs 2025$/); // sans répéter « (janv. → sept.) »
    // le détail d'une catégorie, par mois : la barre choisie ne bouge que depuis la moitié gauche
    await page.selectOption('#m-analyse .ma-mois-centre select', 'mois');
    await page.locator('#m-analyse .ma-ligne', { hasText: 'Maison' }).click();
    const barres = () => page.locator('#m-analyse .ma-barres button').evaluateAll(bs => bs.map(b => b.getAttribute('aria-label').split(' :')[0] + (b.getAttribute('aria-current') ? '*' : '')));
    // 7 barres : la barre choisie au milieu (4e), sauf vers le mois en cours qu'on ne dépasse pas
    assert.deepEqual(await barres(), ['Avril 2026', 'Mai 2026', 'Juin 2026', 'Juillet 2026', 'Août 2026', 'Septembre 2026', 'Octobre 2026*']);
    await page.click('#m-analyse .ma-barres button[aria-label^="Août 2026"]');        // moitié droite : rien ne bouge
    assert.deepEqual(await barres(), ['Avril 2026', 'Mai 2026', 'Juin 2026', 'Juillet 2026', 'Août 2026*', 'Septembre 2026', 'Octobre 2026']);
    await page.click('#m-analyse .ma-barres button[aria-label^="Mai 2026"]');         // moitié gauche : mai au milieu
    assert.deepEqual(await barres(), ['Février 2026', 'Mars 2026', 'Avril 2026', 'Mai 2026*', 'Juin 2026', 'Juillet 2026', 'Août 2026']);
    assert.ok(await page.locator('#m-analyse .ma-barres button').first().evaluate(b => b.getAnimations().length > 0), 'les barres glissent');
    assert.match(await page.locator('#m-analyse .ma-ecart').textContent(), /(vs|comme en) \d{2}\/\d{4}$/); // « 09/2026 », pas « septembre 2026 »
    // l'écart à droite du montant, sur une ligne
    assert.ok(await page.locator('#m-analyse .ma-total').evaluate(t => t.scrollWidth <= t.clientWidth), 'écart sur la ligne du montant');
    // « Sans sous-catégorie » s'ouvre comme une sous-catégorie ; pas de liste d'opérations sous les sous-catégories
    await page.evaluate(() => anaMobileAller('2026-10'));
    assert.deepEqual(await page.locator('#m-analyse .ma-h').allTextContents(), ['Sous-catégories']);
    await page.locator('#m-analyse .ma-ligne', { hasText: 'Sans sous-catégorie' }).click();
    assert.equal(await page.locator('#m-analyse .ma-tete h2').textContent(), 'Sans sous-catégorie');
    assert.deepEqual(await page.locator('#m-analyse .ma-h').allTextContents(), ['Opérations (1)']);
    assert.match(await page.textContent('#m-analyse .ma-liste'), /Quincaillerie/);
    await page.click('#m-analyse .ma-tete button');
    assert.equal(await page.locator('#m-analyse .ma-tete h2').textContent(), 'Maison');
    // « vs … » n'est jamais coupé
    await page.click('#m-analyse .ma-tete button');
    assert.ok(await page.locator('#m-analyse .ma-ligne small .nw').count() > 0);
    // analyse de « Maison » (écran Catégories) : le grand montant ne chevauche pas la moyenne
    await page.evaluate(() => { setView('categories'); voirAnalyseCategorie(upsertCategorieLecture('Maison')); });
    const lt = page.locator('#m-catana .ca-ligne');
    assert.ok(await lt.evaluate(l => l.querySelector('b').getBoundingClientRect().right <= l.querySelector('.ca-moy').getBoundingClientRect().left), 'pas de chevauchement');
    assert.ok(await lt.evaluate(l => l.scrollWidth <= l.clientWidth), 'la moyenne n\'est pas coupée');
    // une longue liste de sous-catégories n'écrase pas la zone des barres
    await page.evaluate(() => { for (let i = 0; i < 15; i++) { const cat = 'Maison : Sous ' + i;
      run("INSERT INTO operation(compte_id,date_operation,montant,cat_path,statut,supprime,previsionnel,tiers_id,hay) VALUES(?,?,?,?,'pointe',0,0,?,'')", [state.acc, '2026-10-0' + (1 + i % 9), -100, cat, upsertTiers('T' + i)]);
      run('INSERT INTO ventilation(operation_id,categorie_id,montant) VALUES(?,?,?)', [scal('SELECT MAX(id) FROM operation'), upsertCategorie(cat), -100]); }
      renderAnalyseCategorie(); });
    assert.equal(await page.locator('#m-catana .ca-barres').evaluate(e => Math.round(e.getBoundingClientRect().height)), 140, 'hauteur des barres gardée');
    // « Sans sous-catégorie » s'ouvre comme une sous-catégorie, avec ses seules opérations
    assert.deepEqual(await page.locator('#m-catana .ma-h').allTextContents(), ['Sous-catégories']);
    await page.locator('#m-catana .ma-ligne', { hasText: 'Sans sous-catégorie' }).click();
    assert.equal(await page.locator('#m-catana h2').textContent(), 'Sans sous-catégorie');
    assert.match(await page.locator('#m-catana .ca-titre small').textContent(), /Maison/);
    assert.deepEqual(await page.locator('#m-catana .ma-h').allTextContents(), ['Opérations (1)']);
    assert.match(await page.textContent('#m-catana .ma-liste'), /Quincaillerie/);
    await page.evaluate(() => fermerAnalyseCategorie());
    // tiers : les trois tris sur une ligne
    await page.evaluate(() => setView('tiers'));
    const ys = await page.locator('#m-tiers .mg-tris button').evaluateAll(bs => bs.map(b => Math.round(b.getBoundingClientRect().top)));
    assert.equal(new Set(ys).size, 1, 'une seule ligne');
    const larg = await page.locator('#m-tiers .mg-tris').evaluate(e => { const b = [...e.children].map(x => x.getBoundingClientRect()); return [b[0].left, b[b.length - 1].right, e.getBoundingClientRect().left, e.getBoundingClientRect().right]; });
    assert.ok(Math.abs(larg[0] - larg[2]) < 2 && Math.abs(larg[1] - larg[3]) < 2, 'toute la largeur');
    assert.equal(await page.locator('#m-tiers .mg-lettre, #m-tiers .mg-plus').count(), 0, 'ni lettre ni « ⋯ »');
    // renommer / fusionner une catégorie : la fenêtre tient dans l'écran ; « son opération rejoint »
    await page.evaluate(() => { upsertCategorie('Une catégorie au nom vraiment très long : avec une sous-catégorie qui ne finit pas'); setView('categories'); });
    await page.locator('#m-categories .mg-nom', { hasText: 'Alimentation' }).dispatchEvent('pointerdown', { clientX: 10, clientY: 10 }); // appui long
    await page.locator('#dlgBack.show #dlgTitle:has-text("Alimentation")').waitFor();
    assert.deepEqual(await page.locator('#dlgFoot button').allTextContents(), ['Fusionner…', 'Renommer…']); // pas Supprimer : elle a une opération
    await page.click('#dlgFoot button:has-text("Fusionner…")');
    await page.locator('#dlgBack.show #dlgTitle:has-text("Fusionner « Alimentation »")').waitFor();
    // seulement les catégories du même niveau ; le nom proposé devient le sien, l'ancien reste à un toucher
    assert.deepEqual(await page.locator('#mc-avec option').allTextContents(), ['— choisir une catégorie —', 'Maison', 'Une catégorie au nom vraiment très long']);
    await page.selectOption('#mc-avec', { label: 'Maison' });
    assert.equal(await page.inputValue('#mc-nom'), 'Maison');
    await page.click('#mc-noms button:has-text("Alimentation")');
    assert.equal(await page.inputValue('#mc-nom'), 'Alimentation');
    assert.ok(await page.locator('#dlgBack .dlg').evaluate(d => d.scrollWidth <= d.clientWidth), 'pas plus large que l\'écran');
    assert.match(await page.textContent('#dlgBody'), /son opération rejoint l’autre catégorie/);
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('téléphone, retours : échéance touchée → son champ, erreur visible, croix de recherche, liste de la répartition, barres', async () => {
  const { navigateur, page } = await ouvrirTelephone();
  try {
    await paieVentilee(page);
    // croix de la recherche : assez grande pour le doigt
    await page.fill('#f-search', 'TBF');
    const croix = await page.locator('#f-clear').boundingBox();
    assert.ok(croix.width >= 40 && croix.height >= 40, 'croix ' + croix.width + '×' + croix.height);
    await page.click('#f-clear');
    // répartition : toucher un montant de la fiche → ce montant ; la liste des catégories est celle de l'app
    await ligne(page, 'TBF').first().locator('.m-op-corps').click();
    // toucher la catégorie d'une ligne → sa catégorie ; toucher son montant → ce montant
    await page.locator('#m-fiche .mf-infos button').nth(1).locator('span').first().click();
    await page.waitForFunction(() => document.activeElement === document.querySelectorAll('#vent-list .vent-l')[1].querySelectorAll('input')[0]);
    await page.click('#overlay .m-fermer');
    await page.locator('#m-fiche:not([hidden])').waitFor(); await page.click('#m-fiche .mf-retour'); // le formulaire fermé ramène à la fiche
    await ligne(page, 'TBF').first().locator('.m-op-corps').click();
    await page.locator('#m-fiche .mf-infos button').nth(1).locator('span.num').click();
    await page.waitForFunction(() => document.activeElement === document.querySelectorAll('#vent-list .vent-l')[1].querySelectorAll('input')[1]);
    const cat = page.locator('#vent-list .vent-l').first().locator('input').first();
    assert.equal(await cat.getAttribute('list'), null, 'pas la liste d\'Android');
    await cat.fill('salaire');
    const liste = page.locator('#vent-box .cat-sugg');
    await liste.locator('button', { hasText: 'Traitements et salaires : Salaire net' }).waitFor();
    const lb = await liste.boundingBox(), cb = await cat.boundingBox();
    assert.ok(lb.y + lb.height <= cb.y + 1, 'au-dessus du champ');
    await liste.locator('button', { hasText: 'Traitements et salaires : Salaire net' }).click();
    assert.equal(await cat.inputValue(), 'Traitements et salaires : Salaire net');
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelectorAll('#vent-list .vent-l')[0].querySelectorAll('input')[1]), true, 'puis son montant');
    await page.click('#overlay .m-fermer');
    await page.locator('#m-fiche:not([hidden])').waitFor(); await page.click('#m-fiche .mf-retour'); // le formulaire fermé ramène à la fiche
    // échéance : toucher une ligne du détail → la fenêtre sur ce champ ; répartition fausse → message visible
    await page.evaluate(() => { upsertCategorie('Loisirs : Sport'); upsertCategorie('Loisirs : Cinéma');
      run("INSERT INTO recurrence(compte_id,type,montant,tiers,cat_path,frequence,intervalle,jour,date_debut,prochaine,creer_en,ventil) VALUES(?,'debit',-3000,'Club','Loisirs : Sport','mensuelle',1,1,'2026-09-01','2026-11-01','previsionnel',?)",
        [state.acc, JSON.stringify([{ cat: 'Loisirs : Sport', montant: -2000 }, { cat: 'Loisirs : Cinéma', montant: -1000 }])]);
      ongletMobile('recurrences'); });
    await page.click('#m-echeances .me-item:has-text("Club")');
    await page.click('#dlgBody button.me-info:has-text("Fréquence")');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'rc-f');
    await page.click('#dlgFoot button:has-text("Annuler")');
    await page.click('#m-echeances .me-item:has-text("Club")');
    await page.click('#dlgBody button.me-info:has-text("Montant")');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'rc-m');
    await page.fill('#rc-m', '35,00');
    await page.click('#dlgFoot button:has-text("Enregistrer")');
    await page.locator('#toast.show:has-text("La répartition")').waitFor();
    assert.ok(await page.evaluate(() => +getComputedStyle(document.getElementById('toast')).zIndex > +getComputedStyle(document.getElementById('dlgBack')).zIndex), 'au-dessus de la fenêtre');
    assert.equal(await page.isVisible('#dlgBack.show'), true, 'la fenêtre reste ouverte pour corriger');
    await page.click('#dlgFoot button:has-text("Annuler")');
    // analyse d'une catégorie : barres proportionnelles (septembre 2 300 € plus haut que rien), total et moyenne sur une ligne
    await page.evaluate(() => setView('categories'));
    await page.locator('#m-categories .mg-nom', { hasText: 'Traitements et salaires' }).click();
    const h = await page.locator('#m-catana .ca-barres span').evaluateAll(es => es.map(e => e.getBoundingClientRect().height));
    assert.ok(h[10] > 80 && h[11] > 80 && h[9] <= 2, 'hauteurs ' + h.join(','));
    // choisir la période : rien avant la fenêtre → ‹ grisé ; une opération de 2025 → ‹ recule de 12 mois
    assert.equal(await page.locator('#m-catana .ca-fenetre button[aria-label="Période précédente"]').isDisabled(), true);
    assert.equal(await page.locator('#m-catana .ca-fenetre button[aria-label="Période suivante"]').isDisabled(), true);
    await page.evaluate(() => {
      run("INSERT INTO operation(compte_id,date_operation,montant,cat_path,statut,supprime,previsionnel,tiers_id,hay) VALUES(?,?,?,?,'rapproche',0,0,?,?)",
        [state.acc, '2025-06-25', 210000, 'Traitements et salaires : Prime', upsertTiers('TBF'), '']);
      run('INSERT INTO ventilation(operation_id,categorie_id,montant) VALUES(?,?,?)', [scal('SELECT MAX(id) FROM operation'), upsertCategorie('Traitements et salaires : Prime'), 210000]);
      renderAnalyseCategorie(); });
    // ‹ fait défiler les barres d'un mois à la fois ; s'arrête au mois de la première opération
    const prec = '#m-catana .ca-fenetre button[aria-label="Période précédente"]', suiv = '#m-catana .ca-fenetre button[aria-label="Période suivante"]';
    await page.click(prec);
    assert.match(await page.textContent('#m-catana .ca-fenetre'), /oct\. 2025 – sept\. 2026/);
    assert.match(await page.textContent('#m-catana .ca-total'), /Septembre 2026\+2\s300,00\s€/);
    for (let i = 0; i < 4; i++) await page.click(prec);
    assert.match(await page.textContent('#m-catana .ca-fenetre'), /juin 2025 – mai 2026/);
    assert.equal(await page.locator(prec).isDisabled(), true);
    await page.click('#m-catana .ca-barres button[aria-label^="Juin 2025"]');
    assert.match(await page.textContent('#m-catana .ca-total'), /Juin 2025\+2\s100,00\s€/);
    assert.match(await page.textContent('#m-catana .ca-moy'), /moyenne \+175,00\s€ \/ mois/); // fenêtre passée : 2 100 ÷ 12
    await page.click('#m-catana .ca-barres button[aria-label^="Décembre 2025"]');
    await page.click(suiv);                                                                     // décembre reste choisi tant qu'il est visible
    assert.match(await page.textContent('#m-catana .ca-total'), /Décembre 2025/);
    for (let i = 0; i < 4; i++) await page.click(suiv);
    assert.match(await page.textContent('#m-catana .ca-fenetre'), /nov\. 2025 – oct\. 2026/);
    assert.equal(await page.locator(suiv).isDisabled(), true);
    const ligneTot = page.locator('#m-catana .ca-ligne');
    assert.ok(await ligneTot.evaluate(l => l.scrollWidth <= l.clientWidth), 'sur une ligne');
    const mt = await ligneTot.locator('>b').boundingBox(), moy = await ligneTot.locator('.ca-moy').boundingBox();
    assert.ok(Math.abs((mt.y + mt.height / 2) - (moy.y + moy.height / 2)) < 4, 'centrés sur le montant');
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('téléphone : écran Plus — sauvegarde en attente, sauvegarder, outils', async () => {
  const { navigateur, page } = await ouvrir(TELEPHONE);
  try {
    await ajouterOperation(page, { dest: 'Boulangerie du coin', montant: '4,50', date: '05/01/26', cat: 'Alimentation' });
    assert.equal(await page.isVisible('#m-point'), true); // point orange sur le bouton Sauvegarder
    await page.click('#m-onglets button[data-o="plus"]');
    assert.match(await page.textContent('#plus-sauvegarde'), /1 modification non sauvegardée/);
    const [telechargement] = await Promise.all([page.waitForEvent('download'), page.click('#plus-sauvegarde button:has-text("Sauvegarder")')]);
    assert.match(telechargement.suggestedFilename(), /^comptes_.*\.sqlite$/);
    await page.locator('#plus-sauvegarde:has-text("Tout est sauvegardé")').waitFor();
    assert.equal(await page.isVisible('#m-point'), false);
    for (const nom of ['Pointer avec un relevé PDF', 'Importer un fichier QIF', 'Tiers', 'Corbeille', 'Réglages', 'Annuler la dernière modification'])
      assert.equal(await page.isVisible(`#plus-groupes button:has-text("${nom}")`), true, nom);
    assert.deepEqual(await page.locator('#plus-groupes .m-groupe-h').allTextContents(), ['Pointer et importer', 'Organiser', 'Revenir en arrière', 'Appli']);
    // charger une sauvegarde : l'icône à côté de « Sauvegarder », en haut
    assert.equal(await page.locator('#plus-groupes button:has-text("Charger une sauvegarde")').count(), 0);
    const charger = await page.locator('#m-charger').boundingBox(), sauver = await page.locator('#m-sauver').boundingBox();
    assert.ok(Math.abs(charger.y - sauver.y) < 2 && charger.x < sauver.x, 'à gauche de Sauvegarder');
    const [choix] = await Promise.all([page.waitForEvent('filechooser'), page.click('#m-charger')]);
    assert.equal(await choix.element().evaluate(e => e.id), 'fileDb');
    assert.match(await page.textContent('#plus-version'), new RegExp(VERSION.replaceAll('.', '\\.')));
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

/* opérations d'exemple (le 26/10/2026) */
async function opsExemple(page) {
  await page.evaluate(() => {
    const ins = (d, m, dest, cat, st, pv) => run("INSERT INTO operation(compte_id,date_operation,montant,cat_path,statut,supprime,previsionnel,tiers_id,hay) VALUES(?,?,?,?,?,0,?,?,?)",
      [state.acc, d, m, cat, st, pv, upsertTiers(dest), makeHay(dest, cat, null, '', m, d)]);
    ins('2026-10-26', -450, 'Boulangerie', 'Alimentation', 'non_pointe', 0);
    ins('2026-10-26', 210000, 'Salaire', 'Revenus', 'pointe', 0);
    ins('2026-10-25', -5830, 'Supermarché', 'Alimentation : Courses', 'rapproche', 0);
    ins('2026-10-28', -6200, 'Électricité', 'Logement', 'non_pointe', 1);
    ins('2026-09-20', -1200, 'Pharmacie', 'Santé', 'pointe', 0);
    invalidateCaches(); render();
  });
}
const ouvrirTelephone = () => ouvrir({ ...TELEPHONE, preparer: c => c.clock.setFixedTime(new Date('2026-10-26T10:00:00')) });
const statutDe = (page, dest) => page.evaluate(n => qy("SELECT o.statut s,o.previsionnel pv FROM operation o JOIN tiers t ON t.id=o.tiers_id WHERE t.nom=?", [n])[0], dest);
const ligne = (page, dest) => page.locator('#m-ops .m-op', { hasText: dest });

test('téléphone, opérations : liste par jour, la barre de statut à gauche pointe / dépointe', async () => {
  const { navigateur, page } = await ouvrirTelephone();
  try {
    await opsExemple(page);
    assert.deepEqual(await page.locator('#m-ops .m-jour > span:first-child').allTextContents(),
      ['Mercredi 28 octobre', 'Aujourd’hui', 'Hier', 'Dimanche 20 septembre']);
    assert.match(await page.textContent('#m-soldes'), /2\s025,20\s€/); // solde réel
    // « Rapprocher » à droite du solde réel, sur la même ligne
    const solde = await page.locator('#m-soldes .ms-reel').boundingBox(), rap = await page.locator('#m-soldes .ms-rapprocher').boundingBox();
    assert.ok(rap.x > solde.x + solde.width - 1 && rap.y < solde.y + solde.height && rap.y + rap.height > solde.y, 'Rapprocher à droite du solde');
    await ligne(page, 'Boulangerie').locator('.m-st').click();
    assert.equal((await statutDe(page, 'Boulangerie')).s, 'pointe');
    await ligne(page, 'Boulangerie').locator('.m-st').click();
    assert.equal((await statutDe(page, 'Boulangerie')).s, 'non_pointe');
    await ligne(page, 'Supermarché').locator('.m-st').click(); // rapprochée : verrouillée
    assert.equal((await statutDe(page, 'Supermarché')).s, 'rapproche');
    assert.match(await page.textContent('#toast'), /déjà rapprochée/);
    await ligne(page, 'Électricité').locator('.m-st').click(); // prévisionnelle : confirmée
    assert.equal((await statutDe(page, 'Électricité')).pv, 0);
    // toucher la ligne ouvre sa fiche ; le bouton + ajoute une opération
    await ligne(page, 'Salaire').locator('.m-op-corps').click();
    assert.equal(await page.isVisible('#m-fiche'), true);
    await page.click('#m-fiche button[aria-label="Retour"]');
    await page.click('#m-ajouter');
    assert.equal(await page.textContent('#modal-title'), 'Nouvelle opération');
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('téléphone, opérations : recherche dans l\'écran, filtres dans la feuille du bas, mois ‹ ›', async () => {
  const { navigateur, page } = await ouvrirTelephone();
  try {
    await opsExemple(page);
    assert.equal(await page.isVisible('#m-recherche #f-search'), true);
    await page.click('#f-search');                     // un vrai toucher (sans lui, l'app retire le clavier)
    await page.keyboard.type('boul');
    await page.waitForFunction(() => document.querySelectorAll('#m-ops .m-op').length === 1);
    assert.match(await page.textContent('#m-ops'), /Boulangerie/);
    await page.click('#f-clear');                      // × : effacer la recherche
    await page.waitForFunction(() => document.querySelectorAll('#m-ops .m-op').length === 5);

    assert.equal(await page.isVisible('#f-zone'), false);
    await page.click('.m-filtrer');
    await page.locator('#f-zone').waitFor({ state: 'visible' });
    await page.click('#f-zone .schip[data-s="pointe"]');           // décocher « Pointé »
    assert.match(await page.textContent('#m-voir'), /Voir 3 opérations/);
    assert.ok((await page.locator('#m-mois').boundingBox()).y > (await page.locator('#f-statuts').boundingBox()).y, 'mois avec la période, sous les statuts');
    await page.click('#m-mois button[aria-label="Mois précédent"]'); // septembre
    assert.match(await page.textContent('#m-mois-nom'), /Septembre 2026/);
    await page.click('#f-zone .schip[data-s="pointe"]');           // recocher
    await page.click('#m-voir');
    await page.locator('#f-zone').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.locator('#m-filtres-actifs .m-puce').allTextContents(), ['Septembre 2026✕']);
    assert.match(await page.textContent('.m-filtrer'), /Filtrer · 1/);
    assert.deepEqual(await page.locator('#m-ops .m-op-nom').allTextContents(), ['Pharmacie']);
    await page.click('#m-filtres-actifs button[aria-label="Retirer le filtre Septembre 2026"]');
    assert.equal(await page.locator('#m-ops .m-op').count(), 5);
    // « À pointer » de la carte des soldes : seulement les non pointées
    await page.click('#m-soldes button[aria-label="Afficher les opérations à pointer"]');
    assert.deepEqual(await page.locator('#m-ops .m-op-nom').allTextContents(), ['Boulangerie']);
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('téléphone, fiche d\'une opération : montant en grand, statut en information, Modifier / Dupliquer / Corbeille', async () => {
  const { navigateur, page } = await ouvrirTelephone();
  try {
    await opsExemple(page);
    await ligne(page, 'Boulangerie').locator('.m-op-corps').click();
    const fiche = page.locator('#m-fiche');
    assert.match(await fiche.locator('.mf-montant').textContent(), /^-4,50\s€$/);
    assert.match(await fiche.textContent(), /Lundi 26 octobre 2026 · Compte courant/);
    assert.match(await fiche.locator('.mf-statut').textContent(), /Non pointé/);
    assert.match(await fiche.locator('.mf-infos').textContent(), /CatégorieAlimentation/);
    // le statut se change ici aussi d'un toucher
    await fiche.locator('button.mf-statut').click();
    assert.match(await fiche.locator('.mf-statut').textContent(), /^Pointé/);
    await fiche.locator('button.mf-statut').click();
    assert.match(await fiche.locator('.mf-statut').textContent(), /^Non pointé/);
    // toucher le montant : le formulaire s'ouvre sur le montant
    await fiche.locator('button.mf-montant').click();
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'i-montant');
    await page.click('#overlay .m-fermer');
    await page.locator('#m-fiche:not([hidden])').waitFor(); await page.click('#m-fiche .mf-retour'); // le formulaire fermé ramène à la fiche
    await ligne(page, 'Boulangerie').locator('.m-op-corps').click();
    // Modifier : la fenêtre d'opération, remplie
    await fiche.locator('button:has-text("Modifier")').click();
    assert.equal(await page.isVisible('#m-fiche'), false);
    assert.equal(await page.inputValue('#i-dest'), 'Boulangerie');
    await page.click('#overlay .m-fermer');
    await page.locator('#m-fiche:not([hidden])').waitFor(); await page.click('#m-fiche .mf-retour'); // le formulaire fermé ramène à la fiche
    // Dupliquer : une nouvelle opération, datée d'aujourd'hui
    await ligne(page, 'Pharmacie').locator('.m-op-corps').click();
    await fiche.locator('button:has-text("Dupliquer")').click();
    assert.match(await page.textContent('#modal-title'), /copie/);
    assert.equal(await page.inputValue('#i-dest'), 'Pharmacie');
    assert.equal(await page.inputValue('#i-date'), '26/10/26');
    await page.click('#overlay .m-fermer');
    // Corbeille, après confirmation
    await ligne(page, 'Boulangerie').locator('.m-op-corps').click();
    await fiche.locator('button:has-text("Mettre à la corbeille")').click();
    await page.click('#dlgFoot button:has-text("Mettre à la corbeille")');
    await fiche.waitFor({ state: 'hidden' });
    assert.equal(await ligne(page, 'Boulangerie').count(), 0);
    // rapprochée : modifiable sauf le montant, pas de corbeille
    await ligne(page, 'Supermarché').locator('.m-op-corps').click();
    assert.match(await fiche.locator('.mf-statut').textContent(), /Rapproché — son montant ne peut plus être modifié/);
    assert.equal(await fiche.locator('button:has-text("Modifier")').count(), 1);
    assert.equal(await fiche.locator('button.mf-montant').count(), 0);
    assert.equal(await fiche.locator('button:has-text("corbeille")').count(), 0);
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

// Ouvre les réglages et déplie une rubrique (elles sont repliées : une ligne chacune).
const reglages = async (page, id) => {
  await page.evaluate(() => setView('reglages'));
  if (await page.getAttribute('#' + id, 'open') === null) await page.click('#' + id + ' summary');
};

test('réglages d\'affichage : recherche en bas, thème, montants masqués — gardés sur l\'appareil', async () => {
  const { navigateur, page } = await ouvrirTelephone();
  try {
    await ajouterOperation(page, { dest: 'Boulangerie', montant: '4,50', date: '25/10/26', cat: 'Alimentation' });
    await reglages(page, 'rg-barres');
    // barres de recherche en bas : juste au-dessus des onglets, pour toutes les recherches
    await page.click('#rg-recherche button[data-v="bas"]');
    await page.evaluate(() => setView('registre'));
    const haut = async sel => (await page.locator(sel).boundingBox()).y;
    assert.ok(await haut('#f-search') > 650, 'recherche des opérations en bas');
    await page.evaluate(() => setView('tiers'));
    assert.ok(await haut('#ti-search') > 650, 'recherche des tiers en bas');
    // thème sombre forcé
    await reglages(page, 'rg-affichage');
    await page.click('#rg-theme button[data-v="sombre"]');
    assert.equal(await page.getAttribute('html', 'data-theme'), 'sombre');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(20, 23, 26)');
    // montants masqués à l'ouverture
    await page.check('#rg-masquer');
    await page.waitForTimeout(1200);   // la base est écrite (0,9 s) avant de rouvrir
    await allerA(page);
    await page.waitForFunction(() => state.view === 'reglages'); // l'app rouvre sur le dernier écran visité
    await page.evaluate(() => setView('registre'));
    assert.equal(await page.getAttribute('html', 'data-theme'), 'sombre');
    assert.ok(await haut('#f-search') > 650);
    assert.equal(await page.evaluate(() => document.body.classList.contains('montants-masques')), true);
    assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('#m-soldes .ms-reel')).filter), /blur/);
    await page.click('#m-entete .m-oeil');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#m-soldes .ms-reel')).filter), 'none');
    // retour à l'automatique
    await page.evaluate(() => setView('reglages'));
    assert.equal(await page.textContent('#rg-affichage-resume'), 'Sombre · montants masqués');
    assert.equal(await page.textContent('#rg-barres-resume'), 'En bas');
    await reglages(page, 'rg-affichage');
    await page.click('#rg-theme button[data-v="auto"]');
    assert.equal(await page.getAttribute('html', 'data-theme'), null);
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('réglages sur PC : pas de rubrique « barres de recherche » (elle ne concerne que le téléphone)', async () => {
  const { navigateur, page } = await ouvrir();
  try {
    await page.evaluate(() => setView('reglages'));
    // rubriques repliées : une ligne chacune (titre + résumé), le détail se déroule au toucher
    assert.equal(await page.isVisible('#rg-theme'), false);
    assert.equal(await page.textContent('#rg-sauvegarde-resume'), 'Téléchargements');
    assert.match(await page.textContent('#rg-version'), /^Mes comptes · version \d+\.\d+\.\d+$/);
    await page.click('#rg-affichage summary');
    assert.equal(await page.isVisible('#rg-theme'), true);
    assert.equal(await page.isVisible('#rg-barres'), false);
  } finally { await navigateur.close(); }
});

/* une paie rapprochée, répartie entre deux catégories aux noms longs */
async function paieVentilee(page) {
  await page.evaluate(() => {
    const op = (d, m, dest, cat, lignes) => {
      run("INSERT INTO operation(compte_id,date_operation,montant,cat_path,statut,supprime,previsionnel,tiers_id,hay) VALUES(?,?,?,?,'rapproche',0,0,?,?)",
        [state.acc, d, m, cat, upsertTiers(dest), makeHay(dest, cat, null, '', m, d)]);
      const id = scal('SELECT MAX(id) FROM operation');
      lignes.forEach(([c, v]) => run('INSERT INTO ventilation(operation_id,categorie_id,montant) VALUES(?,?,?)', [id, upsertCategorie(c), v]));
    };
    op('2026-10-24', 231676, 'TBF', 'Traitements et salaires : Salaire net',
      [['Traitements et salaires : Salaire net', 264273], ['Impôts : Impôt sur le revenu prélèvement à la source', -32597]]);
    op('2026-09-25', 230000, 'TBF', 'Traitements et salaires : Prime', [['Traitements et salaires : Prime', 230000]]);
    invalidateCaches(); render();
  });
}

test('téléphone, opération rapprochée ventilée : la fiche tient dans l\'écran, la répartition se modifie, pas le total', async () => {
  const { navigateur, page } = await ouvrirTelephone();
  try {
    await paieVentilee(page);
    await ligne(page, 'TBF').first().locator('.m-op-corps').click();
    const fiche = page.locator('#m-fiche');
    // rien ne déborde : les libellés longs passent à la ligne, les montants restent entiers
    assert.ok(await fiche.evaluate(f => f.scrollWidth <= f.clientWidth), 'pas de défilement horizontal');
    const montants = fiche.locator('.mf-infos span.num');
    assert.equal(await montants.count(), 2);
    for (const h of await montants.evaluateAll(es => es.map(e => e.getBoundingClientRect().height))) assert.ok(h < 30, 'montant sur une ligne');
    assert.equal(await fiche.locator('button.mf-montant').count(), 0); // le total ne se touche pas
    // toucher une ligne de la répartition : le formulaire, montant verrouillé, répartition modifiable
    await fiche.locator('.mf-infos button').first().locator('span.num').click(); // son montant
    assert.equal(await page.isVisible('#m-fiche'), false);
    assert.equal(await page.locator('#i-montant').evaluate(e => e.readOnly), true);
    // le curseur se place dans le montant de la ligne touchée (30 ms après l'ouverture) : l'attendre avant d'écrire
    await page.waitForFunction(() => document.activeElement === document.querySelectorAll('#vent-list .vent-l')[0].querySelectorAll('input')[1]);
    // le clavier s'ouvre (dans l'appli, Android rétrécit la page) : le montant remonte juste au-dessus d'Enregistrer
    await page.setViewportSize({ width: 390, height: 544 });
    await page.waitForFunction(() => { const a = document.activeElement.getBoundingClientRect(), p = document.querySelector('#overlay .modal-foot').getBoundingClientRect();
      return a.bottom <= p.top && a.top >= 0; }, null, { timeout: 3000 });
    await page.setViewportSize({ width: 390, height: 844 });
    const champs = page.locator('#vent-list .vent-l input[inputmode="decimal"]');
    await champs.nth(0).fill('2640,00');
    await champs.nth(1).fill('-323,24');
    assert.match(await page.textContent('#vent-tot'), /équilibré/);
    await page.click('#overlay button:has-text("Enregistrer")');
    await page.click('#dlgFoot button:has-text("Confirmer la modification")');
    await page.waitForFunction(() => !document.getElementById('overlay').classList.contains('show'));
    assert.deepEqual(await page.evaluate(() => [...qy("SELECT v.montant m FROM ventilation v JOIN operation o ON o.id=v.operation_id WHERE o.date_operation='2026-10-24' ORDER BY v.montant DESC").map(r => r.m)]), [264000, -32324]);
    assert.equal(await page.evaluate(() => scal("SELECT montant FROM operation WHERE date_operation='2026-10-24'")), 231676);
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('téléphone, catégories : montant total ; toucher une catégorie → son analyse par mois, par année', async () => {
  const { navigateur, page } = await ouvrirTelephone();
  try {
    await paieVentilee(page);
    await page.evaluate(() => setView('categories'));
    const c = page.locator('#m-categories .mg-cat', { hasText: 'Traitements et salaires' });
    assert.match(await c.locator('.mg-nb').textContent(), /\+4\s942,73\s€2 op\./);
    assert.match(await page.locator('#m-categories .mg-cat', { hasText: 'Impôts' }).locator('.mg-nb').textContent(), /-325,97\s€1 op\./);
    await c.locator('.mg-nom').click();
    const a = page.locator('#m-catana');
    await a.waitFor();
    assert.equal(await a.locator('h2').textContent(), 'Traitements et salaires');
    assert.match(await a.locator('.ca-titre').textContent(), /\+4\s942,73\s€ · 2 opérations en tout/);
    // par mois : 12 barres, le mois en cours choisi ; la moyenne des mois passés
    assert.equal(await a.locator('.ca-barres button').count(), 12);
    assert.match(await a.locator('.ca-total').textContent(), /Octobre 2026 \(en cours\)\+2\s642,73\s€/);
    assert.match(await a.locator('.ca-moy').textContent(), /moyenne \+209,09\s€ \/ mois/);
    await a.locator('.ca-barres button[aria-label^="Septembre 2026"]').click();
    assert.match(await a.locator('.ca-total').textContent(), /Septembre 2026\+2\s300,00\s€/);
    assert.deepEqual(await a.locator('.ma-h').allTextContents(), ['Sous-catégories']); // pas de liste d'opérations à ce niveau
    // par année
    await a.locator('button:has-text("Par année")').click();
    assert.equal(await a.locator('.ca-barres button').count(), 1);
    assert.match(await a.locator('.ca-total').textContent(), /2026 \(en cours\)\+4\s942,73\s€/);
    // une sous-catégorie, puis retour
    await a.locator('.ma-ligne[onclick^="caDescendre"]', { hasText: 'Prime' }).click();
    assert.equal(await a.locator('h2').textContent(), 'Prime');
    await page.evaluate(() => fermerFeuilles()); // Retour d'Android
    assert.equal(await a.locator('h2').textContent(), 'Traitements et salaires');
    // une opération (dans sa sous-catégorie) : sa fiche s'ouvre par-dessus
    await a.locator('.ma-ligne[onclick^="caDescendre"]', { hasText: 'Salaire net' }).click();
    assert.deepEqual(await a.locator('.ma-h').allTextContents(), ['Opérations (1)']);
    await a.locator('.ma-liste .ma-ligne', { hasText: 'TBF' }).first().click();
    assert.equal(await page.isVisible('#m-fiche'), true);
    await page.click('#m-fiche .mf-retour');
    await page.evaluate(() => fermerFeuilles());
    // « Voir les opérations » : la liste filtrée sur la catégorie
    await a.locator('button:has-text("Voir les opérations")').click();
    await page.waitForFunction(() => state.view === 'registre');
    assert.equal(await page.isVisible('#m-catana'), false);
    assert.equal(await page.locator('#m-ops .m-op').count(), 2);
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('téléphone, analyse : le mois en anneau, comparé au mois choisi ; une catégorie en détail ; évolution', async () => {
  const { navigateur, page } = await ouvrirTelephone();
  try {
    await page.evaluate(() => {
      const ins = (d, m, dest, cat) => run("INSERT INTO operation(compte_id,date_operation,montant,cat_path,statut,supprime,previsionnel,tiers_id) VALUES(?,?,?,?,'pointe',0,0,?)",
        [state.acc, d, m, cat, upsertTiers(dest)]);
      ins('2026-10-05', -60000, 'Loyer', 'Logement'); ins('2026-10-12', -30000, 'Supermarché', 'Alimentation : Courses');
      ins('2026-10-14', -10000, 'Boulangerie', 'Alimentation : Boulangerie'); ins('2026-10-28', 200000, 'Salaire', 'Revenus');
      ins('2026-09-05', -60000, 'Loyer', 'Logement'); ins('2026-09-12', -20000, 'Supermarché', 'Alimentation : Courses');
      ins('2026-05-05', -50000, 'Loyer', 'Logement');
    });
    await page.click('#m-onglets button[data-o="analyse"]');
    const a = page.locator('#m-analyse');
    assert.match(await a.locator('.ma-mois-centre b').textContent(), /Octobre 2026/);
    assert.match(await a.locator('.ma-centre b').textContent(), /1\s000,00\s€/);
    assert.equal(await a.locator('.ma-ecart').textContent(), '+25 %');           // 1 000 € contre 800 € en septembre
    assert.deepEqual(await a.locator('.ma-ligne .ma-nom').evaluateAll(es => es.map(e => e.firstChild.textContent)), ['Logement', 'Alimentation']);
    // comparer avec un autre mois, n'importe lequel
    await a.locator('select[aria-label="Comparer avec"]').selectOption('2026-05');
    assert.equal(await a.locator('.ma-ecart').textContent(), '+100 %');
    // une catégorie en détail : sous-catégories, opérations, puis la fiche
    await a.locator('.ma-ligne', { hasText: 'Alimentation' }).click();
    assert.equal(await a.locator('h2').textContent(), 'Alimentation');
    assert.match(await a.locator('.ma-total b').textContent(), /400,00\s€/);
    assert.deepEqual(await a.locator('.ma-h').allTextContents(), ['Sous-catégories']); // les opérations : dans chaque sous-catégorie
    await a.locator('.ma-ligne', { hasText: 'Boulangerie' }).click();
    assert.deepEqual(await a.locator('.ma-h').allTextContents(), ['Opérations (1)']);
    await a.locator('.ma-ligne', { hasText: 'Boulangerie' }).click();
    assert.equal(await page.isVisible('#m-fiche'), true);
    await page.click('#m-fiche button[aria-label="Retour"]');
    await a.locator('button[aria-label="Retour"]').click();
    await a.locator('button[aria-label="Retour"]').click();
    // mois précédent, revenus, évolution
    await a.locator('button[aria-label="Période précédente"]').click();
    assert.match(await a.locator('.ma-mois-centre b').textContent(), /Septembre 2026/);
    await a.locator('.m-ana-seg button:has-text("Revenus")').click();
    assert.match(await a.textContent(), /Aucune rentrée en septembre 2026/);
    // évolution : la courbe du solde dans l'écran Analyse (plus l'ancien écran Graphiques)
    await a.locator('.m-ana-seg button:has-text("Évolution")').click();
    assert.equal(await page.isVisible('#v-graphiques'), false);
    assert.match(await page.textContent('#m-onglets button.on'), /Analyse/);
    assert.match(await a.locator('.ev-solde b').textContent(), /−2\s300,00\s€|-2\s300,00\s€/);
    assert.match(await a.locator('.ev-solde span').textContent(), /2\s300,00\s€ en 12 mois/);
    assert.match(await a.locator('.ev-legende .prevu').textContent(), /Prévu : −?-?300,00\s€/); // salaire du 28 octobre
    assert.equal(await a.locator('.ev-axe span').first().textContent(), 'fin oct. 2025');
    await a.locator('select[aria-label="Période"]').selectOption('annee');
    assert.match(await a.locator('.ev-solde span').textContent(), /depuis le 1er janvier/);
    // barres par mois : revenus / dépenses du mois touché
    // une vue à la fois : Courbe ou Barres
    assert.equal(await a.locator('.ev-barres').count(), 0);
    await a.locator('.ev-vue button:has-text("Barres")').click();
    assert.equal(await a.locator('.ev-courbe').count(), 0);
    assert.ok((await a.locator('.ev-barres').boundingBox()).height >= 280, 'barres en grand');
    assert.equal(await a.locator('.ev-barres button').count(), 10);   // janvier → octobre
    assert.match(await a.locator('.ev-detail').textContent(), /Octobre 2026.*1\s000,00\s€/);
    await a.locator('.ev-barres button').nth(8).click();
    assert.match(await a.locator('.ev-detail').textContent(), /Septembre 2026.*800,00\s€/);
    // patrimoine : tous les comptes
    await a.locator('.ev-portee button:has-text("Patrimoine")').click();
    assert.match(await a.locator('.ev-solde small').textContent(), /Patrimoine/);
    // plein écran (paysage) : l'ancienne courbe détaillée ; en sortant, retour ici
    await a.locator('button:has-text("Plein écran")').click();
    assert.equal(await page.evaluate(() => document.body.classList.contains('gr-plein')), true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => state.view === 'analyse' && !document.body.classList.contains('gr-plein'));
    assert.equal(await a.locator('.ev-portee button[aria-selected="true"]').textContent(), 'Patrimoine');
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('téléphone, échéances : ce mois-ci / ensuite, reste à payer ; toucher → modifier, suspendre', async () => {
  const { navigateur, page } = await ouvrirTelephone();
  try {
    await page.evaluate(() => {
      const ins = (tiers, m, p, j) => run("INSERT INTO recurrence(compte_id,type,montant,tiers,cat_path,frequence,intervalle,jour,date_debut,prochaine,creer_en) VALUES(?,?,?,?,'Logement','mensuelle',1,?,?,?,'previsionnel')",
        [state.acc, m < 0 ? 'debit' : 'credit', m, tiers, j, p, p]);
      ins('Loyer', -60000, '2026-10-30', 30); ins('Électricité', -6200, '2026-10-28', 28); ins('Salaire', 200000, '2026-11-05', 5);
    });
    await page.click('#m-onglets button[data-o="recurrences"]');
    const e = page.locator('#m-echeances');
    assert.equal(await page.isVisible('#rec-rows'), false);   // le tableau du PC est caché
    assert.deepEqual(await e.locator('.ma-h').allTextContents(), ['Ce mois-ci', 'Ensuite']);
    assert.deepEqual(await e.locator('.me-liste').first().locator('.me-nom').evaluateAll(es => es.map(x => x.firstChild.textContent)), ['Électricité', 'Loyer']);
    assert.match(await e.locator('.me-totaux').textContent(), /662,00\s€.*\+0,00\s€/);
    // toucher une échéance : son détail, puis suspendre
    await e.locator('.me-item', { hasText: 'Loyer' }).click();
    await page.locator('#dlgBack.show #dlgBody:has-text("Chaque mois")').waitFor();
    await page.click('#dlgFoot button:has-text("Suspendre")');
    await e.locator('.ma-h:has-text("Suspendues")').waitFor();
    assert.match(await e.locator('.me-totaux').textContent(), /62,00\s€/);
    // nouvelle échéance : le formulaire habituel
    await e.locator('.me-nouvelle').click();
    await page.locator('#dlgBack.show').waitFor();
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('téléphone, relevé PDF : trois tuiles qui filtrent (retrouvées / à vérifier / absentes), cases, Appliquer', async () => {
  const { navigateur, page } = await ouvrirTelephone();
  try {
    await page.evaluate(() => {
      const rel = (date, montant, libelle) => ({ date, montant, libelle });
      const app = (id, date, montant, dest) => ({ id, date, montant, dest, cat: 'Divers', statut: 'non_pointe' });
      REL = { comptes: [state.acc], idx: 0, compteId: state.acc, filtre: null,
        relCompte: { titre: 'Relevé du 25 octobre', ops: [], soldes: [] },
        res: {
          rapproches: [{ on: true, rel: rel('2026-10-20', -4500, 'CB BOULANGERIE'), app: app(1, '2026-10-20', -4500, 'Boulangerie'), ecartJours: 0 },
                       { on: true, rel: rel('2026-10-21', -2000, 'CB CINEMA'), app: app(2, '2026-10-21', -2000, 'Cinéma'), ecartJours: 0 }],
          deja: [{ on: false, rel: rel('2026-10-02', 210000, 'VIR SALAIRE'), app: app(3, '2026-10-02', 210000, 'Salaire'), ecartJours: 0 }],
          proches: [{ on: true, rel: rel('2026-10-24', -1230, 'PHARMACIE'), app: app(4, '2026-10-24', -1200, 'Pharmacie'), ecartJours: 0, ecartMontant: -30 }],
          aCreer: [{ on: true, rel: rel('2026-10-24', -250, 'FRAIS TENUE DE COMPTE'), prop: { tiers: 'Banque', cat: 'Frais bancaires' } }],
          ignores: [] } };
      setView('releve');
    });
    const tuiles = page.locator('#rl-chips .rm-tuile');
    assert.deepEqual(await tuiles.allTextContents(), ['3retrouvées', '1à vérifier', '1absente']);
    const corps = page.locator('#rl-corps');
    assert.deepEqual(await corps.locator('.ma-h').allTextContents(), ['À vérifier : montant ou date un peu différents', 'Absentes de tes comptes']);
    assert.match(await corps.locator('.rm-pied .primary').textContent(), /Appliquer : 3 pointées, 1 créée/);
    // toucher la tuile verte : seulement les retrouvées
    await tuiles.first().click();
    assert.deepEqual(await corps.locator('.ma-h').allTextContents(), ['Retrouvées dans tes comptes']);
    assert.equal(await corps.locator('.rm-ligne').count(), 3);
    await corps.locator('.rm-ligne', { hasText: 'Cinéma' }).locator('input').uncheck();
    assert.match(await corps.locator('.rm-pied .primary').textContent(), /Appliquer : 2 pointées, 1 créée/);
    // retoucher la tuile : tout revient
    await page.locator('#rl-chips .rm-tuile').first().click();
    assert.equal(await page.locator('#rl-corps .ma-h').count(), 2);
    // « ⋯ » : les autres actions
    await page.locator('#rl-corps .rm-ligne', { hasText: 'Pharmacie' }).locator('.rm-plus').click();
    await page.locator('#dlgBack.show #dlgFoot button:has-text("Modifier l’opération")').waitFor();
    await page.keyboard.press('Escape');
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('téléphone, gestion : tiers (tri, toucher → opérations), catégories (déplier), corbeille (restaurer, vider)', async () => {
  const { navigateur, page } = await ouvrirTelephone();
  try {
    await opsExemple(page);
    // tiers
    await page.evaluate(() => setView('tiers'));
    const t = page.locator('#m-tiers');
    assert.equal(await page.isVisible('#ti-rows'), false);
    await t.locator('button:has-text("A → Z")').click();
    assert.deepEqual((await t.locator('.me-nom').evaluateAll(es => es.map(x => x.firstChild.textContent))).slice(0, 2), ['Boulangerie', 'Électricité']);
    await t.locator('button:has-text("Montant le plus élevé")').click();
    assert.equal(await t.locator('.me-nom').first().evaluate(x => x.firstChild.textContent), 'Salaire');
    await t.locator('.me-item', { hasText: 'Pharmacie' }).click();
    await page.waitForFunction(() => state.view === 'registre');
    assert.equal(await page.inputValue('#f-search'), 'Pharmacie');
    assert.equal(await page.locator('#m-ops .m-op').count(), 1);
    // catégories : repliées, la flèche déplie
    await page.evaluate(() => { document.getElementById('f-search').value = ''; upsertCategorie('Alimentation : Courses'); upsertCategorie('Santé'); setView('categories'); });
    const c = page.locator('#m-categories');
    assert.equal(await c.locator('.mg-nom', { hasText: 'Courses' }).count(), 0);
    await c.locator('button[aria-label="Déplier Alimentation"]').click();
    assert.equal(await c.locator('.mg-nom', { hasText: 'Courses' }).count(), 1);
    // et la même flèche la replie
    await c.locator('button[aria-label="Replier Alimentation"]').click();
    assert.equal(await c.locator('.mg-nom', { hasText: 'Courses' }).count(), 0, 'repliée');
    // pendant une recherche, tout ce qui correspond est déplié… et la flèche replie aussi
    await page.fill('#cat-search', 'a');
    await page.evaluate(() => renderCategories());
    assert.equal(await c.locator('.mg-nom', { hasText: 'Courses' }).count(), 1, 'dépliée par la recherche');
    await c.locator('button[aria-label="Replier Alimentation"]').click();
    assert.equal(await c.locator('.mg-nom', { hasText: 'Courses' }).count(), 0, 'repliée pendant la recherche');
    await c.locator('button[aria-label="Déplier Alimentation"]').click();
    assert.equal(await c.locator('.mg-nom', { hasText: 'Courses' }).count(), 1);
    // la croix vide la recherche (absente quand le champ est vide), assez grande pour le doigt
    const croix = page.locator('#v-categories .croix');
    assert.ok(await croix.isVisible(), 'croix visible avec du texte');
    const cb = await croix.boundingBox(), sb = await page.locator('#cat-search').boundingBox();
    assert.ok(cb.width >= 44 && cb.x + cb.width <= sb.x + sb.width + 1, 'croix dans le champ, 44 px');
    await croix.click();
    assert.equal(await page.inputValue('#cat-search'), '');
    assert.ok(!(await croix.isVisible()), 'croix cachée champ vide');
    assert.equal(await c.locator('.mg-nom', { hasText: 'Courses' }).count(), 0, 'liste revenue sans recherche');
    // corbeille : restaurer, vider
    await page.evaluate(() => { run("UPDATE operation SET supprime=1,date_suppression='2026-10-22 10:00:00' WHERE tiers_id IN (SELECT id FROM tiers WHERE nom IN ('Pharmacie','Boulangerie'))"); setView('corbeille'); });
    const b = page.locator('#m-corbeille');
    assert.equal(await b.locator('.mg-ligne').count(), 2);
    // Restaurer et la poubelle l'un sous l'autre
    const rb = await b.locator('.mg-ligne').first().locator('.mg-restaurer').boundingBox(), pb = await b.locator('.mg-ligne').first().locator('.mg-icone').boundingBox();
    assert.ok(pb.y >= rb.y + rb.height - 1 && Math.abs((pb.x + pb.width / 2) - (rb.x + rb.width / 2)) < 2, 'l\'un sous l\'autre');
    await b.locator('.mg-ligne', { hasText: 'Pharmacie' }).locator('.mg-restaurer').click();
    assert.equal(await b.locator('.mg-ligne').count(), 1);
    await b.locator('button:has-text("Vider la corbeille")').click();
    await page.click('#dlgFoot button:has-text("Tout supprimer")');
    await b.locator('.m-vide:has-text("vide")').waitFor();
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('téléphone, saisie : plein écran, montant en grand en haut, statut rappelé en modification, Enregistrer en bas', async () => {
  const { navigateur, page } = await ouvrirTelephone();
  try {
    await page.click('#m-ajouter');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'i-montant');   // directement dans le montant
    const y = async sel => (await page.locator(sel).boundingBox()).y;
    assert.ok(await y('#i-montant') < await y('#seg'), 'montant au-dessus du type');
    assert.ok(await y('#seg') < await y('#i-dest'), 'type au-dessus du destinataire');
    assert.equal(await page.isVisible('#i-statut'), false);
    const m = await page.locator('#i-montant').boundingBox();
    assert.ok(Math.abs(m.x + m.width / 2 - 195) < 3, 'montant centré');
    const enr = await page.locator('#overlay button.primary:has-text("Enregistrer")').boundingBox();
    assert.ok(enr.y + enr.height <= 844 && enr.y > 700, 'Enregistrer en bas de l\'écran');
    await page.fill('#i-montant', '4,50'); await page.fill('#i-dest', 'Boulangerie'); await page.fill('#i-cat0', 'Alimentation');
    await page.click('#overlay button.primary:has-text("Enregistrer")');
    await page.locator('#overlay.show').waitFor({ state: 'hidden' });
    // modification : le statut est rappelé, pour information
    await ligne(page, 'Boulangerie').locator('.m-op-corps').click();
    await page.click('#m-fiche button:has-text("Modifier")');
    await fenetreOperationPrete(page);
    assert.equal(await page.textContent('#modal-title'), 'Modifier l’opération');
    assert.equal(await page.textContent('#i-statut'), 'Non pointé');
    await page.click('#overlay .m-fermer');
    await page.locator('#m-fiche:not([hidden])').waitFor(); await page.click('#m-fiche .mf-retour'); // le formulaire fermé ramène à la fiche
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('téléphone, retours : Retour ferme le formulaire, prévisionnel lié à la période, statut à 3 états, nombre d\'opérations', async () => {
  const { navigateur, page } = await ouvrirTelephone();
  try {
    await opsExemple(page);
    assert.equal(await page.textContent('#m-nb-ops'), '5 opérations');
    // Retour du navigateur (ou du clavier) avec le formulaire ouvert : il se ferme, l'écran derrière ne change pas
    await page.evaluate(() => { setView('analyse'); setView('registre'); });
    await page.click('#m-ajouter');
    await fenetreOperationPrete(page);
    await page.evaluate(() => history.back());
    await page.locator('#overlay.show').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => state.view), 'registre');
    // prévisionnel « fin du mois prochain » → période jusqu'au 30 novembre ; « Ce mois » n'est plus possible
    await page.click('.m-filtrer');
    await page.selectOption('#f-horizon', 'finmoisprochain');
    assert.equal(await page.inputValue('#f-periode'), 'perso');
    assert.equal(await page.inputValue('#f-to'), '30/11/26');
    assert.equal(await page.isDisabled('#f-periode-wrap .pchip[data-m="mois"]'), true);
    await page.selectOption('#f-horizon', 'finmois');
    assert.equal(await page.inputValue('#f-periode'), 'mois');
    assert.equal(await page.evaluate(() => document.querySelector('#f-horizon option[value="finmoisprochain"]').disabled), true);
    await page.click('#m-voir');
    // statut : l'opération prévisionnelle garde 3 états tant qu'on reste dessus
    const st = () => statutDe(page, 'Électricité');
    await ligne(page, 'Électricité').locator('.m-st').click();
    assert.deepEqual({ ...(await st()) }, { s: 'non_pointe', pv: 0 });
    await ligne(page, 'Électricité').locator('.m-st').click();
    assert.equal((await st()).s, 'pointe');
    await ligne(page, 'Électricité').locator('.m-st').click();
    assert.deepEqual({ ...(await st()) }, { s: 'non_pointe', pv: 1 });   // de nouveau prévisionnelle
    await ligne(page, 'Électricité').locator('.m-st').click();          // confirmée
    await ligne(page, 'Boulangerie').locator('.m-st').click();          // une autre : la 1re n'a plus que 2 états
    await ligne(page, 'Électricité').locator('.m-st').click();
    await ligne(page, 'Électricité').locator('.m-st').click();
    assert.deepEqual({ ...(await st()) }, { s: 'non_pointe', pv: 0 });
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('téléphone, saisie : la liste des catégories s\'ouvre au-dessus du champ ; appui long sur un compte pour le modifier', async () => {
  const { navigateur, page } = await ouvrirTelephone();
  try {
    await page.evaluate(() => { upsertCategorie('Alimentation : Courses'); upsertCategorie('Alimentation : Boulangerie'); upsertCategorie('Loisirs'); });
    await page.click('#m-ajouter');
    await fenetreOperationPrete(page);
    await page.click('#i-cat0');
    const liste = page.locator('#cat-sugg');
    await liste.waitFor();
    const l = await liste.boundingBox(), c = await page.locator('#i-cat0').boundingBox();
    assert.ok(l.y + l.height <= c.y + 1, 'la liste est au-dessus du champ');
    await liste.locator('button:has-text("Alimentation")').click();
    assert.equal(await page.inputValue('#i-cat0'), 'Alimentation');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'i-cat1');   // on passe à la sous-catégorie
    assert.deepEqual(await page.locator('#cat-sugg button').allTextContents(), ['Boulangerie', 'Courses']);
    await page.click('#overlay .m-fermer');
    // appui long sur un compte de la liste déroulante : sa fenêtre de modification
    await page.click('#m-compte-btn');
    const b = page.locator('#m-comptes button[data-id]').first();
    await b.dispatchEvent('pointerdown', { clientX: 10, clientY: 10 });
    await page.locator('#dlgBack.show #dlgTitle:has-text("Modifier le compte")').waitFor();
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('téléphone, gestion : renommer un tiers, fusionner une catégorie', async () => {
  const { navigateur, page } = await ouvrirTelephone();
  try {
    await opsExemple(page);
    await page.evaluate(() => setView('tiers'));
    await page.locator('#m-tiers .me-item', { hasText: 'Pharmacie' }).dispatchEvent('pointerdown', { clientX: 10, clientY: 10 }); // appui long
    await page.click('#dlgFoot button:has-text("Renommer…")');
    assert.equal(await page.locator('#mt-avec').count(), 0);
    await page.fill('#mt-nom', 'Pharmacie du centre');
    await page.click('#dlgFoot button:has-text("Enregistrer")');
    await page.locator('#m-tiers .me-nom:has-text("Pharmacie du centre")').waitFor();
    await page.evaluate(() => { upsertCategorie('Alimentation'); const id = upsertCategorie('Courses'); run("UPDATE ventilation SET categorie_id=? WHERE operation_id=(SELECT id FROM operation WHERE cat_path='Alimentation : Courses')", [id]); run("UPDATE operation SET cat_path='Courses' WHERE cat_path='Alimentation : Courses'"); setView('categories'); });
    // appui long sur une catégorie : menu Renommer / Fusionner ; le « ⋯ » a disparu (plus de place pour les montants)
    assert.equal(await page.locator('#m-categories .mg-plus').count(), 0);
    await page.locator('#m-categories .mg-nom', { hasText: 'Courses' }).dispatchEvent('pointerdown', { clientX: 10, clientY: 10 });
    await page.click('#dlgFoot button:has-text("Fusionner…")');
    await page.selectOption('#mc-avec', { label: 'Alimentation' });
    await page.click('#dlgFoot button:has-text("Fusionner")');
    await page.locator('#dlgBack.show #dlgTitle:has-text("Fusionner")').waitFor();
    await page.click('#dlgFoot button:has-text("Fusionner")');
    await page.waitForFunction(() => scal("SELECT COUNT(*) FROM categorie WHERE libelle='Courses' AND parent_id IS NULL") === 0);
    assert.equal(await page.evaluate(() => scal("SELECT cat_path FROM operation o JOIN tiers t ON t.id=o.tiers_id WHERE t.nom='Supermarché'")), 'Alimentation');
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('téléphone, échéance : même présentation que la saisie (montant en haut, plein écran), enregistrée', async () => {
  const { navigateur, page } = await ouvrirTelephone();
  try {
    await page.evaluate(() => { upsertCategorie('Loisirs : Sport');
      run("INSERT INTO recurrence(compte_id,type,montant,tiers,cat_path,frequence,intervalle,jour,date_debut,prochaine,creer_en) VALUES(?,'debit',-3000,'Salle de sport','Loisirs : Sport','mensuelle',1,1,'2026-09-01','2026-11-01','previsionnel')", [state.acc]);
      ongletMobile('recurrences'); });
    await page.locator('#m-echeances .me-item', { hasText: 'Salle de sport' }).click();
    await page.click('#dlgFoot button:has-text("Modifier")');
    await page.locator('#rc-m').waitFor();
    const y = async sel => (await page.locator(sel).boundingBox()).y;
    assert.ok(await y('#rc-m') < await y('#rc-seg') && await y('#rc-seg') < await y('#rc-t') && await y('#rc-t') < await y('#rc-cpt'), 'montant, type, destinataire, puis compte');
    assert.ok((await page.locator('#dlgBack .dlg').boundingBox()).width >= 389, 'plein écran');
    await page.waitForFunction(() => document.getElementById('rc-sugg'));   // branchée à l'ouverture de la fenêtre
    await page.click('#rc-c1');
    await page.locator('#rc-sugg button:has-text("Sport")').waitFor();
    await page.fill('#rc-m', '35');
    await page.click('#dlgFoot button:has-text("Enregistrer")');
    await page.waitForFunction(() => scal("SELECT montant FROM recurrence WHERE tiers='Salle de sport'") === -3500);
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('deux fenêtres : la 2e dit « déjà ouvert », fait signe à la 1re, et démarre quand la 1re se ferme', async () => {
  const { navigateur, contexte, page } = await ouvrir();
  try {
    const autre = await contexte.newPage();
    autre.erreurs = [];
    autre.on('pageerror', e => autre.erreurs.push(e.message));
    await autre.goto(BASE);
    await autre.locator('#deja-ouvert:has-text("déjà ouvert")').waitFor();
    assert.doesNotMatch(await autre.textContent('#brandver'), /opérations/); // la base n'est pas ouverte ici

    await autre.click('#deja-ouvert button:has-text("Afficher la fenêtre ouverte")');
    await page.waitForFunction(() => document.title.includes('est ici'), null, { polling: 'raf' });

    await page.close();
    await demarree(autre); // l'autre fenêtre est fermée : celle-ci démarre
    assert.equal(await autre.isVisible('#deja-ouvert'), false);
    assert.deepEqual(autre.erreurs, []);
  } finally { await navigateur.close(); }
});

/* ---------- Réglages : dossier de sauvegarde ---------- */
// Le choix de dossier du navigateur est simulé par un dossier de l'espace privé du site (vrai
// FileSystemDirectoryHandle, gardé dans IndexedDB comme le vrai).
function fauxChoixDeDossier() {
  window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Comptes', { create: true });
}
const fichiersDuDossier = page => page.evaluate(async () => {
  const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('Comptes');
  const noms = [];
  for await (const [nom] of d.entries()) noms.push(nom);
  return noms;
});
const texteToast = page => page.textContent('#toast');

test('réglages (PC) : sauvegarde dans le dossier choisi, gardé après rechargement ; dossier disparu → Téléchargements', async () => {
  const { navigateur, page } = await ouvrir({ preparer: c => c.addInitScript(fauxChoixDeDossier) });
  try {
    await reglages(page, 'rg-sauvegarde');
    assert.match(await page.textContent('#rg-dossier'), /Téléchargements/);
    await page.click('#rg-btns button:has-text("Choisir un dossier")');
    await page.locator('#rg-dossier:has-text("Comptes")').waitFor();

    await allerA(page); // le choix est gardé sur l'appareil
    await ajouterOperation(page, { dest: 'Boulangerie du coin', montant: '4,50', date: '05/01/26', cat: 'Alimentation' });
    await page.click('button[onclick="sauvegarder()"]:visible');
    await aJour(page);
    assert.match(await texteToast(page), /^Sauvegarde enregistrée dans « Comptes » : comptes_.*\.sqlite$/);
    const [fichier] = await fichiersDuDossier(page);
    assert.match(fichier, /^comptes_.*\.sqlite$/);

    // Le dossier n'existe plus : l'app propose Téléchargements.
    await page.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('Comptes', { recursive: true }));
    await ajouterOperation(page, { dest: 'Pharmacie', montant: '12', date: '06/01/26', cat: 'Santé' });
    await page.click('button[onclick="sauvegarder()"]:visible');
    await page.locator('#dlgBack.show #dlgMsg:has-text("« Comptes » n’est pas accessible")').waitFor();
    const [telechargement] = await Promise.all([page.waitForEvent('download'), page.click('#dlgFoot button:has-text("Enregistrer dans Téléchargements")')]);
    assert.match(telechargement.suggestedFilename(), /^comptes_.*\.sqlite$/);
    await aJour(page);
    assert.match(await texteToast(page), /dans « Téléchargements »/);

    // Revenir à Téléchargements.
    await reglages(page, 'rg-sauvegarde');
    await page.click('#rg-defaut');
    await page.locator('#rg-dossier:has-text("Téléchargements")').waitFor();
    assert.equal(await page.isVisible('#rg-defaut'), false);
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('réglages : navigateur sans choix de dossier → expliqué, sauvegarde dans Téléchargements', async () => {
  const { navigateur, page } = await ouvrir({ preparer: c => c.addInitScript(() => { delete window.showDirectoryPicker; }) });
  try {
    await reglages(page, 'rg-sauvegarde');
    assert.match(await page.textContent('#rg-note'), /ne permet pas de choisir un dossier/);
    assert.equal(await page.isVisible('#rg-btns'), false);
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('réglages (appli Android) : dossier choisi par Android, sauvegarde dedans, sinon Téléchargements', async () => {
  const { navigateur, page } = await ouvrirAppli();
  try {
    await page.click('#dlgFoot button:has-text("Plus tard")');
    await page.evaluate(() => { window.__natif.choisirDossier = window.__natif.dossier = { nom: 'Mes sauvegardes' }; });
    await reglages(page, 'rg-sauvegarde');
    await page.click('#rg-btns button:has-text("Choisir un dossier")');
    await page.locator('#rg-dossier:has-text("Mes sauvegardes")').waitFor();
    assert.equal(await page.textContent('#rg-sauvegarde-resume'), 'Mes sauvegardes');

    await ajouterOperation(page, { dest: 'Boulangerie du coin', montant: '4,50', date: '05/01/26', cat: 'Alimentation' });
    await page.click('button[onclick="sauvegarder()"]:visible');
    await aJour(page);
    assert.equal((await appels(page, 'enregistrer'))[0].dossier, true);
    assert.match(await texteToast(page), /dans « Mes sauvegardes »/);

    // Android refuse (autorisation retirée…) : on propose Téléchargements.
    await page.evaluate(() => {
      const avant = window.Capacitor.nativePromise;
      window.Capacitor.nativePromise = (p, m, o) => m === 'enregistrer' && o.dossier ? Promise.reject(new Error('le dossier choisi n’est plus autorisé')) : avant(p, m, o);
    });
    await ajouterOperation(page, { dest: 'Pharmacie', montant: '12', date: '06/01/26', cat: 'Santé' });
    await page.click('button[onclick="sauvegarder()"]:visible');
    await page.click('#dlgFoot button:has-text("Enregistrer dans Téléchargements")');
    await aJour(page);
    const derniere = (await appels(page, 'enregistrer')).at(-1);
    assert.equal(derniere.dossier, undefined);
    assert.match(await texteToast(page), /dans « Téléchargements »/);
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

/* ---------- PDF minimal (une page, une ligne de texte par élément) ---------- */
function pdfMinimal(lignes) {
  const flux = 'BT /F1 11 Tf ' + lignes.map((l, i) => `1 0 0 1 40 ${700 - i * 20} Tm (${l}) Tj`).join(' ') + ' ET';
  const objets = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${flux.length} >>\nstream\n${flux}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const positions = objets.map((o, i) => { const p = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return p; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n` + positions.map(p => String(p).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
