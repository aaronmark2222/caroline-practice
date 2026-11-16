// Caroline Practice service worker: keeps the app itself on the device so it opens
// with no connection (same approach as TSP Work). Online it always fetches fresh
// files (network first) and refreshes the saved copy; offline it serves the saved
// copy. Practice audio and data are saved by app.js (Cache Storage / localStorage).
// Supabase, Cloudflare R2 and the local CarolineSync bridge are never touched.
const SHELL = 'cp-app-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(['./', './index.html']).catch(() => {})));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  const ours = url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
  if (!ours && url.hostname !== 'esm.sh') return;

  if (url.hostname === 'esm.sh') {
    // Pinned library versions never change: saved copy first.
    event.respondWith(caches.open(SHELL).then((c) => c.match(req)).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  event.respondWith(fetch(req).then((res) => {
    if (res.ok && !url.pathname.endsWith('sw.js')) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
    return res;
  }).catch(async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req);
    if (hit) return hit;
    if (req.mode === 'navigate') return (await cache.match('./index.html', { ignoreSearch: true })) || (await cache.match('./')) || Response.error();
    // Same file with a different ?v= (e.g. app.js?v=…): the newest saved one.
    return (await cache.match(req, { ignoreSearch: true })) || Response.error();
  }));
});
