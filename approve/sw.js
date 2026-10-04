// Kevo home-screen app: lets Android install the app. Pages always load fresh from the network;
// the last copy is kept only so the app still opens (instead of a browser error) with no signal.
const CACHE = 'kevo-shell-v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || e.request.mode !== 'navigate') return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put('shell', copy)).catch(() => {});
      return res;
    }).catch(() => caches.open(CACHE).then(c => c.match('shell')))
  );
});
