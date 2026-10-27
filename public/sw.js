const CACHE = 'octominds-clean-urls-v1';
const SHELL = ['/', '/school', '/school.css?v=clean-urls-1', '/school.js?v=clean-urls-1', '/workspace.css?v=inventory-10', '/operations.css?v=inventory-12', '/routes.css?v=inventory-14', '/premium.css?v=inventory-16', '/app.js?v=clean-urls-1', '/pages.js?v=clean-urls-1', '/manifest.webmanifest'];
self.addEventListener('install', (event) => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
  await self.skipWaiting();
})()));
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/health' || url.pathname === '/ready' || url.pathname === '/config.js') {
    event.respondWith(fetch(event.request));
    return;
  }
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match(['/school', '/school/', '/school.html'].includes(url.pathname) ? '/school' : '/')));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  })));
});
