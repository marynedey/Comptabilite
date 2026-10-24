// Vérifie la syntaxe des fichiers JavaScript tels que le navigateur les lit :
// des scripts classiques (pas des modules ; `node --check` les prendrait pour
// des modules à cause de "type": "module" dans package.json).
const { readFileSync } = require('node:fs');
const { Script } = require('node:vm');
let erreurs = 0;
for (const f of process.argv.slice(2)) {
  try { new Script(readFileSync(f, 'utf8'), { filename: f }); }
  catch (e) { erreurs++; console.error(`${f} : ${e.message}\n${e.stack.split('\n')[0]}`); }
}
process.exit(erreurs ? 1 : 0);
