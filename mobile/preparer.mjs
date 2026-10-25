// Copie l'app web du dépôt dans www/ : c'est ce que l'APK contient (« cap sync » le recopie ensuite
// dans le projet Android). Mêmes fichiers que ceux publiés sur GitHub Pages, sauf le service worker :
// dans l'appli, le code est dans l'APK et c'est l'appli qui propose les nouvelles versions.
import { cpSync, rmSync, mkdirSync } from 'node:fs';

const racine = new URL('../', import.meta.url);
const www = new URL('www/', import.meta.url);
rmSync(www, { recursive: true, force: true });
mkdirSync(www);
for (const f of ['index.html', 'manifest.webmanifest', 'css', 'js', 'vendor', 'icons'])
  cpSync(new URL(f, racine), new URL(f, www), { recursive: true });
console.log('App web copiée dans mobile/www/');
