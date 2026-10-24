// Service de sauvegarde du NAS (serveur-nas/sauvegarde.py), lancé pour de vrai avec Python.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const JETON = 'jeton-de-test-0123456789';
const ORIGINE = 'https://marynedey.github.io';
const SQLITE = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100, 1)]);
let dossier, service, BASE;

const portLibre = () => new Promise(r => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

before(async () => {
  dossier = mkdtempSync(join(tmpdir(), 'nas-'));
  const port = await portLibre();
  BASE = `http://127.0.0.1:${port}`;
  service = spawn('python3', [new URL('../serveur-nas/sauvegarde.py', import.meta.url).pathname], {
    env: { ...process.env, DOSSIER: dossier, JETON, PORT: String(port), GARDER: '3', TAILLE_MAX: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((ok, ko) => {
    service.stdout.on('data', d => /Sauvegardes/.test(d) && ok());
    service.on('exit', c => ko(new Error('le service s\'est arrêté : ' + c)));
  });
});
after(() => service.kill());

const envoyer = (nom, corps = SQLITE, jeton = JETON) => fetch(`${BASE}/sauvegardes/${nom}`, {
  method: 'PUT', body: corps, headers: { Authorization: `Bearer ${jeton}`, Origin: ORIGINE },
});

test('ping : jeton vérifié', async () => {
  assert.equal((await fetch(`${BASE}/ping`, { headers: { Authorization: `Bearer ${JETON}` } })).status, 200);
  assert.equal((await fetch(`${BASE}/ping`, { headers: { Authorization: 'Bearer mauvais' } })).status, 401);
  assert.equal((await fetch(`${BASE}/ping`)).status, 401);
});

test('le navigateur peut appeler le service depuis l\'app, et seulement depuis elle', async () => {
  const pre = await fetch(`${BASE}/sauvegardes/x`, { method: 'OPTIONS', headers: { Origin: ORIGINE, 'Access-Control-Request-Method': 'PUT' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGINE);
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
  assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
  const autre = await fetch(`${BASE}/ping`, { headers: { Authorization: `Bearer ${JETON}`, Origin: 'https://exemple.com' } });
  assert.equal(autre.headers.get('access-control-allow-origin'), null);
});

test('sauvegarde écrite dans le dossier, à l\'identique', async () => {
  const r = await envoyer('comptes_2026-10-24_18h00m00s.sqlite');
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGINE);
  assert.deepEqual(readFileSync(join(dossier, 'comptes_2026-10-24_18h00m00s.sqlite')), SQLITE);
  assert.deepEqual(readdirSync(dossier).filter(f => f.startsWith('.')), [], 'aucun fichier temporaire laissé');
});

test('refus : mauvais jeton, nom de fichier hors dossier, pas une base SQLite, trop gros', async () => {
  assert.equal((await envoyer('comptes_a.sqlite', SQLITE, 'mauvais')).status, 401);
  for (const nom of ['..%2F..%2Fetc%2Fpasswd', 'comptes_..%2Fx.sqlite', 'autre.sqlite', 'comptes_a.sqlite.sh'])
    assert.equal((await envoyer(nom)).status, 400, nom);
  assert.equal((await envoyer('comptes_b.sqlite', Buffer.from('pas une base'))).status, 400);
  assert.equal((await envoyer('comptes_c.sqlite', Buffer.concat([SQLITE, Buffer.alloc(1024 * 1024)]))).status, 413);
  assert.deepEqual(readdirSync(dossier).filter(f => /comptes_[abc]\.sqlite/.test(f)), []);
});

test('GARDER : seules les sauvegardes les plus récentes restent, les autres fichiers ne sont pas touchés', async () => {
  writeFileSync(join(dossier, 'notes.txt'), 'à garder');
  const vieux = Date.now() / 1000 - 1000;
  for (const f of readdirSync(dossier)) utimesSync(join(dossier, f), vieux, vieux); // envois des tests précédents
  const noms = ['comptes_1.sqlite', 'comptes_2.sqlite', 'comptes_3.sqlite', 'comptes_4.sqlite'];
  let t = Date.now() / 1000 - 100;
  for (const nom of noms) {
    assert.equal((await envoyer(nom)).status, 201);
    utimesSync(join(dossier, nom), t, t); t += 10; // dates bien distinctes
  }
  assert.equal((await envoyer('comptes_5.sqlite')).status, 201);
  assert.deepEqual(readdirSync(dossier).sort(), ['comptes_3.sqlite', 'comptes_4.sqlite', 'comptes_5.sqlite', 'notes.txt']);
});
