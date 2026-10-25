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

/* ---------- appli Android (mobile/) ---------- */
const plugin = () => lire('mobile/android/app/src/main/java/io/github/marynedey/comptes/MesComptesPlugin.java');
const motifJava = nom => new RegExp('^(?:' + plugin().match(new RegExp(nom + ' = Pattern\\.compile\\("([^"]+)"\\)'))[1].replaceAll('\\\\', '\\') + ')$');

test('appli Android : sa version vient de js/app.js et tient dans le versionCode d\'Android', () => {
  const [x, y, z] = lire('js/app.js').match(/VERSION = '(\d+)\.(\d+)\.(\d+)'/).slice(1).map(Number);
  assert.ok(y < 100 && z < 100, 'versionCode = X*10000 + Y*100 + Z : Y et Z doivent rester sous 100');
  assert.match(lire('mobile/android/app/build.gradle'), /file\('\.\.\/\.\.\/\.\.\/js\/app\.js'\)/);
});

test('appli Android : le module natif accepte le nom de sauvegarde de l\'app, et rien d\'autre', () => {
  const nom = motifJava('NOM_SAUVEGARDE');
  assert.match('comptes_2026-10-25_18h05m09.sqlite', nom); // nom fabriqué par sauvegarder()
  assert.match('comptes_2026-10-25_18h05m09s.sqlite', nom); // anciennes versions
  assert.match(lire('js/app.js'), /const nom='comptes_'\+stamp\+'\.sqlite';/);
  for (const autre of ['comptes_2026-10-25_18h05m09.sqlite.apk', '../comptes_2026-10-25_18h05m09s.sqlite', 'notes.txt'])
    assert.doesNotMatch(autre, nom);
});

test('appli Android : les mises à jour ne viennent que du site de l\'app', () => {
  const adresse = motifJava('ADRESSE_MAJ');
  const site = lire('js/app.js').match(/const SITE_APPLI='([^']+)'/)[1];
  assert.match(site + 'mes-comptes-2.1.0.apk', adresse);
  for (const autre of ['https://marynedey.github.io/Comptabilite/android/../x.apk', 'http://marynedey.github.io/Comptabilite/android/a.apk',
    'https://marynedey.github.io.exemple.fr/Comptabilite/android/a.apk'])
    assert.doesNotMatch(autre, adresse);
});

test('appli Android : l\'APK contient les mêmes fichiers que le site', () => {
  const publies = lire('.github/workflows/tests.yml').match(/cp -r (index\.html[^\n]*) _site\//)[1].split(/\s+/);
  const copies = JSON.parse(lire('mobile/preparer.mjs').match(/for \(const f of (\[[^\]]+\])/)[1].replaceAll("'", '"'));
  assert.deepEqual(copies.sort(), publies.filter(f => f !== 'sw.js').sort());
});
