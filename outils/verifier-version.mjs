// Vérifie qu'une PR qui modifie l'app augmente sa version (X.Y.Z).
// Usage : node outils/verifier-version.mjs [branche de base, défaut origin/main]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const base = process.argv[2] || 'origin/main';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const lireVersion = texte => (texte.match(/VERSION = '(\d+)\.(\d+)\.(\d+)'/) || []).slice(1).map(Number);

// Fichiers qui composent l'app publiée (les tests et la doc ne comptent pas).
const APP = /^(index\.html|manifest\.webmanifest|sw\.js|css\/|js\/|vendor\/|icons\/)/;
const modifies = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(f => APP.test(f));
if (!modifies.length) {
  console.log('Aucun fichier de l\'app modifié : pas besoin de changer de version.');
  process.exit(0);
}

let avant = [];
try { avant = lireVersion(git('show', `${base}:js/app.js`)); } catch { /* première version découpée */ }
const apres = lireVersion(readFileSync(new URL('../js/app.js', import.meta.url), 'utf8'));
const k = [0, 1, 2].find(i => apres[i] !== avant[i]);
const plusGrand = apres.length === 3 && (avant.length !== 3 || (k !== undefined && apres[k] > avant[k]));

console.log(`Fichiers de l'app modifiés : ${modifies.join(', ')}`);
console.log(`Version : ${avant.join('.') || '(aucune)'} → ${apres.join('.') || '?'}`);
if (!plusGrand) {
  console.error('\nLa version doit augmenter : npm run nouvelle-version -- correction | fonctionnalite | majeure');
  process.exit(1);
}
console.log('OK : la version a augmenté.');
