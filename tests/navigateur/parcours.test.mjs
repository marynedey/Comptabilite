// Parcours complets dans Chromium : l'app servie comme sur GitHub Pages.
// Lancer : npm run test:navigateur
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdtempSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
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
async function ouvrir(options = {}) {
  // CHROMIUM : chemin d'un Chromium déjà installé (sinon celui de Playwright, cf. tests.yml).
  const navigateur = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : { channel: 'chromium' });
  const contexte = await navigateur.newContext({ locale: 'fr-FR', acceptDownloads: true, ...options });
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

async function ajouterOperation(page, { dest, montant, date, cat }) {
  await page.keyboard.press('a');
  await page.locator('#overlay #i-dest').waitFor({ state: 'visible' });
  // l'app place le curseur dans « Destinataire » juste après l'ouverture : attendre avant de remplir
  await page.waitForFunction(() => document.activeElement?.id === 'i-dest');
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
    assert.match(telechargement.suggestedFilename(), /^comptes_\d{4}-\d{2}-\d{2}_\d{2}h\d{2}m\d{2}\.sqlite$/);
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

/* ---------- sauvegarde sur le NAS (vrai service serveur-nas/sauvegarde.py) ---------- */
const JETON_NAS = 'jeton-du-nas-0123456789';
async function demarrerNas(dossier, port) {
  const nas = spawn('python3', [join(RACINE, 'serveur-nas/sauvegarde.py')], {
    env: { ...process.env, DOSSIER: dossier, JETON: JETON_NAS, PORT: String(port), ORIGINE: new URL(BASE).origin },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((ok, ko) => { nas.stdout.on('data', d => /Sauvegardes/.test(d) && ok()); nas.on('exit', c => ko(new Error('NAS arrêté : ' + c))); });
  return nas;
}
const sauvegardesNas = dossier => readdirSync(dossier).filter(f => /^comptes_.*\.sqlite$/.test(f));

test('NAS : réglage testé, « Sauvegarder » écrit dans le dossier ; NAS injoignable → téléchargement puis envoi au retour', async () => {
  const dossier = mkdtempSync(join(tmpdir(), 'nas-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  let nas = await demarrerNas(dossier, port);
  const { navigateur, page } = await ouvrir();
  try {
    // Réglages : mauvais jeton refusé au test, bon jeton accepté, enregistré.
    await page.click('button:has-text("Sauvegarde NAS")');
    await page.fill('#nas-url', `http://127.0.0.1:${port}/`);
    await page.fill('#nas-jeton', 'mauvais-jeton');
    await page.click('#dlgFoot button:has-text("Tester")');
    await page.waitForFunction(() => /Jeton refusé/.test(document.getElementById('nas-res').textContent));
    await page.fill('#nas-jeton', JETON_NAS);
    await page.click('#dlgFoot button:has-text("Tester")');
    await page.waitForFunction(() => /joignable, jeton accepté/.test(document.getElementById('nas-res').textContent));
    await page.click('#dlgFoot button:has-text("Enregistrer")');
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('mc.nas'))).url, `http://127.0.0.1:${port}`);

    // Sauvegarder : directement sur le NAS, aucun téléchargement.
    await ajouterOperation(page, { dest: 'Librairie', montant: '15', date: '08/01/26', cat: 'Loisirs' });
    let telechargements = 0;
    page.on('download', () => telechargements++);
    await page.click('button[onclick="sauvegarder()"]');
    await page.waitForFunction(() => /Sauvegardé sur le NAS/.test(document.getElementById('toast').textContent));
    const [premier] = sauvegardesNas(dossier);
    assert.ok(premier, 'fichier écrit sur le NAS');
    assert.equal(readFileSync(join(dossier, premier)).subarray(0, 15).toString(), 'SQLite format 3');
    assert.equal(telechargements, 0);
    assert.match(await page.textContent('#status-txt'), /À jour/);

    // NAS éteint (pas de VPN) : le fichier est téléchargé, la sauvegarde attend.
    nas.kill(); await new Promise(r => nas.once('exit', r));
    await ajouterOperation(page, { dest: 'Cinéma', montant: '9', date: '09/01/26', cat: 'Loisirs' });
    await page.waitForTimeout(1100); // nom de fichier à la seconde : différent du premier
    const [telechargement] = await Promise.all([page.waitForEvent('download'), page.click('button[onclick="sauvegarder()"]')]);
    await page.waitForFunction(() => /NAS injoignable/.test(document.getElementById('toast').textContent));
    assert.equal(sauvegardesNas(dossier).length, 1);
    assert.ok(await page.evaluate(async () => !!(await idbGetKey('nas-attente'))));

    // Le NAS revient : au retour dans l'app, la sauvegarde en attente part toute seule.
    nas = await demarrerNas(dossier, port);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => /en attente envoyée au NAS/.test(document.getElementById('toast').textContent));
    assert.deepEqual(sauvegardesNas(dossier).sort(), [premier, telechargement.suggestedFilename()].sort());
    assert.equal(await page.evaluate(async () => await idbGetKey('nas-attente')), null);
    // le jeton n'est jamais dans la base (donc jamais dans une sauvegarde)
    assert.equal(await page.evaluate(() => scal("SELECT COUNT(*) FROM meta WHERE valeur LIKE '%jeton-du-nas%'")), 0);
    assert.deepEqual(page.erreurs.filter(e => !/Failed to load resource|ERR_CONNECTION_REFUSED/.test(e)), []);
  } finally { nas.kill(); await navigateur.close(); }
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
