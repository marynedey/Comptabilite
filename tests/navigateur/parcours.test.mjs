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
const demarree = page => page.waitForFunction(() => /opérations/.test(document.getElementById('brandver')?.textContent || ''), null, { timeout: 30000 });
const swActif = page => page.evaluate(async () => { await navigator.serviceWorker.ready; return !!navigator.serviceWorker.controller; });

// La fenêtre place le curseur dans « Destinataire » 30 ms après s'être ouverte (PC) : attendre ce moment,
// sinon ce placement peut arriver en pleine saisie et le texte part dans le mauvais champ.
async function fenetreOperationPrete(page) {
  await page.locator('#overlay #i-dest').waitFor({ state: 'visible' });
  await page.waitForFunction(() => ecranTactile() || document.activeElement === document.getElementById('i-dest'));
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
    const [telechargement] = await Promise.all([page.waitForEvent('download'), page.click('button[onclick="sauvegarder()"]')]);
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
    for (const vue of ['registre', 'analyse', 'graphiques', 'tiers', 'categories', 'recurrences', 'corbeille']) {
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
    await page.click('button[onclick="sauvegarder()"]');
    await page.locator('#status-txt:has-text("À jour")').waitFor();
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

test('appli Android : sauvegarde refusée par Android → pas comptée comme faite', async () => {
  const { navigateur, page } = await ouvrirAppli();
  try {
    await page.click('#dlgFoot button:has-text("Plus tard")');
    await page.evaluate(() => { window.Capacitor.nativePromise = (p, m) => m === 'enregistrer' ? Promise.reject(new Error('disque plein')) : Promise.resolve({}); });
    await ajouterOperation(page, { dest: 'Pharmacie', montant: '12', date: '06/01/26', cat: 'Santé' });
    await page.click('button[onclick="sauvegarder()"]');
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
    await page.evaluate(() => setView('reglages'));
    assert.match(await page.textContent('#rg-dossier'), /Téléchargements/);
    await page.click('#rg-btns button:has-text("Choisir un dossier")');
    await page.locator('#rg-dossier:has-text("Comptes")').waitFor();

    await allerA(page); // le choix est gardé sur l'appareil
    await ajouterOperation(page, { dest: 'Boulangerie du coin', montant: '4,50', date: '05/01/26', cat: 'Alimentation' });
    await page.click('button[onclick="sauvegarder()"]');
    await page.locator('#status-txt:has-text("À jour")').waitFor();
    assert.match(await texteToast(page), /^Sauvegarde enregistrée dans « Comptes » : comptes_.*\.sqlite$/);
    const [fichier] = await fichiersDuDossier(page);
    assert.match(fichier, /^comptes_.*\.sqlite$/);

    // Le dossier n'existe plus : l'app propose Téléchargements.
    await page.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('Comptes', { recursive: true }));
    await ajouterOperation(page, { dest: 'Pharmacie', montant: '12', date: '06/01/26', cat: 'Santé' });
    await page.click('button[onclick="sauvegarder()"]');
    await page.locator('#dlgBack.show #dlgMsg:has-text("« Comptes » n’est pas accessible")').waitFor();
    const [telechargement] = await Promise.all([page.waitForEvent('download'), page.click('#dlgFoot button:has-text("Enregistrer dans Téléchargements")')]);
    assert.match(telechargement.suggestedFilename(), /^comptes_.*\.sqlite$/);
    await page.locator('#status-txt:has-text("À jour")').waitFor();
    assert.match(await texteToast(page), /dans « Téléchargements »/);

    // Revenir à Téléchargements.
    await page.evaluate(() => setView('reglages'));
    await page.click('#rg-defaut');
    await page.locator('#rg-dossier:has-text("Téléchargements")').waitFor();
    assert.equal(await page.isVisible('#rg-defaut'), false);
    assert.deepEqual(page.erreurs, []);
  } finally { await navigateur.close(); }
});

test('réglages : navigateur sans choix de dossier → expliqué, sauvegarde dans Téléchargements', async () => {
  const { navigateur, page } = await ouvrir({ preparer: c => c.addInitScript(() => { delete window.showDirectoryPicker; }) });
  try {
    await page.evaluate(() => setView('reglages'));
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
    await page.evaluate(() => setView('reglages'));
    await page.click('#rg-btns button:has-text("Choisir un dossier")');
    await page.locator('#rg-dossier:has-text("Mes sauvegardes")').waitFor();

    await ajouterOperation(page, { dest: 'Boulangerie du coin', montant: '4,50', date: '05/01/26', cat: 'Alimentation' });
    await page.click('button[onclick="sauvegarder()"]');
    await page.locator('#status-txt:has-text("À jour")').waitFor();
    assert.equal((await appels(page, 'enregistrer'))[0].dossier, true);
    assert.match(await texteToast(page), /dans « Mes sauvegardes »/);

    // Android refuse (autorisation retirée…) : on propose Téléchargements.
    await page.evaluate(() => {
      const avant = window.Capacitor.nativePromise;
      window.Capacitor.nativePromise = (p, m, o) => m === 'enregistrer' && o.dossier ? Promise.reject(new Error('le dossier choisi n’est plus autorisé')) : avant(p, m, o);
    });
    await ajouterOperation(page, { dest: 'Pharmacie', montant: '12', date: '06/01/26', cat: 'Santé' });
    await page.click('button[onclick="sauvegarder()"]');
    await page.click('#dlgFoot button:has-text("Enregistrer dans Téléchargements")');
    await page.locator('#status-txt:has-text("À jour")').waitFor();
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
