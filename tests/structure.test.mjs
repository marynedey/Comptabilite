// Cohérence des fichiers publiés : version, service worker, manifeste.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const lire = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const dossier = d => readdirSync(new URL('../' + d, import.meta.url)).map(f => d + f);

test('le service worker porte la même version que l\'app', () => {
  const app = lire('js/app.js').match(/VERSION = '(\d+\.\d+\.\d+)'/)[1];
  const sw = lire('sw.js').match(/VERSION = 'mc-app-(\d+\.\d+\.\d+)'/)[1];
  assert.equal(sw, app, 'changer la version avec « npm run nouvelle-version » (met à jour js/app.js et sw.js)');
});

test('le service worker met en cache tous les fichiers de l\'app (hors ligne)', () => {
  const sw = lire('sw.js');
  const fichiers = ['index.html', 'manifest.webmanifest', ...dossier('css/'), ...dossier('js/'), ...dossier('vendor/'),
    ...dossier('icons/').filter(f => f.endsWith('.png'))];
  for (const f of fichiers) assert.ok(sw.includes(`'${f}'`), `${f} manque dans FICHIERS (sw.js)`);
  for (const f of sw.match(/FICHIERS = \[([^\]]*)\]/)[1].match(/'[^']+'/g).map(s => s.slice(1, -1)))
    assert.ok(f === './' || existsSync(new URL('../' + f, import.meta.url)), `${f} est dans FICHIERS (sw.js) mais n'existe pas`);
});

test('tout ce que charge index.html existe', () => {
  const html = lire('index.html');
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map(m => m[1]);
  assert.ok(refs.includes('js/app.js') && refs.includes('vendor/sql-wasm.js'));
  for (const r of refs) assert.ok(existsSync(new URL('../' + r, import.meta.url)), `${r} introuvable`);
});

test('manifeste : id propre à l\'app, icônes présentes', () => {
  const m = JSON.parse(lire('manifest.webmanifest'));
  assert.equal(m.start_url, './');
  // L'id est lu depuis la racine du site (pas depuis le dossier) : « ./ » donnerait
  // https://marynedey.github.io/, le même id que l'app Recettes, et Chrome croirait
  // l'app déjà installée.
  assert.equal(new URL(m.id, 'https://marynedey.github.io/').href, 'https://marynedey.github.io/Comptabilite/');
  for (const i of m.icons) assert.ok(existsSync(new URL('../' + i.src, import.meta.url)), `${i.src} manque`);
});

test('aucune base de données ni sauvegarde dans le dépôt', () => {
  const interdits = /\.(sqlite|db|qif|csv|pdf)$/i;
  const parcourir = d => readdirSync(new URL('../' + d, import.meta.url), { withFileTypes: true })
    .filter(e => !['.git', 'node_modules', 'test-results'].includes(e.name))
    .flatMap(e => e.isDirectory() ? parcourir(d + e.name + '/') : [d + e.name]);
  assert.deepEqual(parcourir('').filter(f => interdits.test(f)), []);
});
