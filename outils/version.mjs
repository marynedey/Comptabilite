// Change la version de l'app, au même endroit dans js/app.js et sw.js.
// Usage : npm run nouvelle-version -- correction | fonctionnalite | majeure
import { readFileSync, writeFileSync } from 'node:fs';

const fichier = f => new URL('../' + f, import.meta.url);
const app = readFileSync(fichier('js/app.js'), 'utf8');
const [x, y, z] = app.match(/VERSION = '(\d+)\.(\d+)\.(\d+)'/).slice(1).map(Number);
const nouvelle = {
  correction: `${x}.${y}.${z + 1}`,
  fonctionnalite: `${x}.${y + 1}.0`,
  majeure: `${x + 1}.0.0`,
}[process.argv[2]];
if (!nouvelle) {
  console.error('Usage : npm run nouvelle-version -- correction | fonctionnalite | majeure');
  process.exit(1);
}
writeFileSync(fichier('js/app.js'), app.replace(/VERSION = '[\d.]+'/, `VERSION = '${nouvelle}'`));
const sw = readFileSync(fichier('sw.js'), 'utf8');
writeFileSync(fichier('sw.js'), sw.replace(/VERSION = 'mc-app-[\d.]+'/, `VERSION = 'mc-app-${nouvelle}'`));
console.log(`Version ${x}.${y}.${z} → ${nouvelle}`);
