// Offline support: network first (so uploaded updates show up right away),
// falling back to the cached copy when there is no connection.
const CACHE = 'macro-tracker-v1';
const SHELL = ['./', './index.html', './styles.css', './app.js', './config.js', './manifest.webmanifest', './icon-192.png', './apple-touch-icon.png'];
const SCANNER = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(SHELL);
    try { await c.add(SCANNER); } catch (_) { /* cached later on first use */ }
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const mine = url.origin === self.location.origin || req.url === SCANNER;
  if (!mine) return; // APIs (Google, Gemini, USDA, Open Food Facts) always go straight to the network
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
