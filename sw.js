// Offline-Cache. Bei neuer Version CACHE hochzählen → App zeigt „Neue Version – Neu laden“.
const CACHE = 'fw-einkauf-v2';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'katalog.json'];

self.addEventListener('install', (e) => {
  // cache: 'reload' → frisch vom Server, nicht aus dem Browser-Cache
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Sofort aus dem Cache (schnell auch bei schlechtem Netz im Laden), im Hintergrund still aktualisieren.
// Den großen Katalog nicht bei jedem Start neu laden – der kommt mit der nächsten Version (CACHE hochzählen).
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const refresh = () => fetch(e.request).then(async (res) => {
      if (res.ok) await c.put(e.request, res.clone());
      return res;
    });
    if (hit) {
      if (!url.pathname.endsWith('katalog.json')) e.waitUntil(refresh().catch(() => {}));
      return hit;
    }
    return refresh().catch(async () => (await c.match('index.html')) || Response.error());
  }));
});
