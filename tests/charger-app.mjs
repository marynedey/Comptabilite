// Charge js/app.js dans Node, sans navigateur, pour tester sa logique.
// Le DOM est remplacé par un objet « bouche-trou » qui accepte tout ;
// la base est le vrai moteur SQLite (vendor/sql-wasm.js + .wasm).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const RACINE = new URL('../', import.meta.url);
const lire = f => readFileSync(new URL(f, RACINE));

// Objet qui répond à tout : propriétés, appels, itération, conversion en texte.
function boucheTrou() {
  const f = function () {};
  return new Proxy(f, {
    get(_, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then') return undefined; // pas une promesse
      if (k === 'length') return 0;
      return boucheTrou();
    },
    set: () => true,
    apply: () => boucheTrou(),
    construct: () => boucheTrou(),
  });
}

export async function chargerApp() {
  const document = boucheTrou();
  const ctx = {
    console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    document, window: boucheTrou(), navigator: {}, location: { protocol: 'file:' },
    history: boucheTrou(), indexedDB: boucheTrou(), matchMedia: () => ({ matches: false, addEventListener() {} }),
    getComputedStyle: () => boucheTrou(), requestAnimationFrame: () => 0, ResizeObserver: class { observe() {} },
    URL, Blob, TextDecoder, TextEncoder, Intl, atob, btoa, WebAssembly,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // Comme dans index.html : sql.js d'abord, dans le même contexte que l'app.
  vm.runInContext(lire('vendor/sql-wasm.js').toString(), ctx, { filename: 'vendor/sql-wasm.js' });
  const SQL = await ctx.initSqlJs({ wasmBinary: lire('vendor/sql-wasm.wasm') });
  // `boot()` (dernière ligne) attend le navigateur : on l'enlève et on prépare la base nous-mêmes.
  const source = lire('js/app.js').toString();
  if (!/\nboot\(\);\n/.test(source)) throw new Error('js/app.js doit se terminer par l\'appel « boot(); » sur sa propre ligne');
  const code = source.replace(/\nboot\(\);\n/, '\n');
  // Les `let`/`const` du script ne deviennent pas des propriétés du contexte :
  // on expose ceux dont les tests ont besoin.
  vm.runInContext(code + `
;globalThis.__app = {
  get db(){return db;}, set db(v){db=v;}, get state(){return state;},
  SCHEMA, initDb(S){db=new S.Database();db.run(SCHEMA);migrer();}
};`, ctx, { filename: 'js/app.js' });
  ctx.__app.initDb(SQL);
  return ctx;
}
