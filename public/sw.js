const CACHE = 'octominds-apps-v17';
const SHELL = ['/assets/session.js?v=1', '/parents', '/apps/parents/parents.css?v=family-pages-1', '/apps/parents/parents.js?v=family-pages-1', '/apps/parents/parents-calendar.js?v=1', '/apps/parents/parents-feeds.js?v=1', '/assets/octominds-icon-512.png', '/assets/octominds-icon-192.png', '/assets/octominds-logo-horizontal.png', '/apps/parents/parents-gallery.js?v=6', '/apps/parents/parents-gallery-preview.js?v=2', '/apps/parents/parents-preview.js?v=6', '/', '/school', '/apps/school/school.css?v=family-enrollment-1', '/apps/school/school.js?v=guardian-1', '/apps/inventory/workspace.css?v=inventory-10', '/apps/inventory/operations.css?v=inventory-12', '/apps/inventory/routes.css?v=inventory-14', '/apps/inventory/premium.css?v=inventory-16', '/apps/inventory/app.js?v=session-1', '/apps/inventory/pages.js?v=faster-load-1', '/manifest.webmanifest'];
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
    event.respondWith(fetch(event.request).catch(() => caches.match(url.pathname.startsWith('/parents') ? '/parents' : ['/school', '/school/', '/school.html'].includes(url.pathname) ? '/school' : '/')));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  })));
});
