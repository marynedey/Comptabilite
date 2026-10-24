// Service worker : met l'application en cache pour qu'elle marche hors ligne.
// Les données (base SQLite) ne passent jamais par ici : elles restent dans
// l'IndexedDB du navigateur et dans les fichiers .sqlite sauvegardés.
const VERSION = 'mc-app-2.0.0'; // = VERSION de js/app.js
const FICHIERS = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'js/app.js',
  'vendor/sql-wasm.js', 'vendor/sql-wasm.wasm', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-192.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
];

// Pas de skipWaiting automatique : la nouvelle version attend que l'app la
// demande (bandeau « Nouvelle version »), pour ne jamais recharger en pleine saisie.
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FICHIERS.map(f => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('message', e => {
  if (e.data === 'installer') self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(cles => Promise.all(cles.filter(k => k.startsWith('mc-app-') && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Les fichiers d'une version ne changent pas : on sert toujours le cache de
// cette version (le réseau seulement pour ce qui n'y est pas).
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const enCache = await cache.match(req, { ignoreSearch: req.mode === 'navigate' })
      || (req.mode === 'navigate' && await cache.match('./'));
    return enCache || fetch(req);
  })());
});
