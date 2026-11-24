const CACHE = 'octominds-apps-v19';
const SHELL = ['/assets/session.js?v=1', '/teachers', '/apps/teachers/teachers.js?v=1', '/apps/teachers/teachers.css?v=1', '/parents', '/apps/parents/parents.css?v=pwa-1', '/apps/parents/parents.js?v=teacher-1', '/apps/parents/parents-pwa.js?v=1', '/parents.webmanifest', '/apps/parents/parents-calendar.js?v=1', '/apps/parents/parents-feeds.js?v=2', '/assets/octominds-icon-512.png', '/assets/octominds-icon-192.png', '/assets/octominds-logo-horizontal.png', '/apps/parents/parents-gallery.js?v=7', '/apps/parents/parents-gallery-preview.js?v=2', '/apps/parents/parents-preview.js?v=6', '/', '/school', '/apps/school/school.css?v=family-enrollment-1', '/apps/school/school.js?v=teacher-1', '/apps/inventory/workspace.css?v=inventory-10', '/apps/inventory/operations.css?v=inventory-12', '/apps/inventory/routes.css?v=inventory-14', '/apps/inventory/premium.css?v=inventory-16', '/apps/inventory/app.js?v=session-1', '/apps/inventory/pages.js?v=faster-load-1', '/manifest.webmanifest'];
self.addEventListener('install', (event) => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
  await self.skipWaiting();
})()));
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key.startsWith('octominds-apps-') && key !== CACHE).map((key) => caches.delete(key)));
  await self.clients.claim();
})()));

async function offlineShell(shell) {
  const cached = await caches.match(shell, { cacheName: CACHE });
  if (!cached || shell !== '/parents') return cached;
  const html = (await cached.text()).replace('<body>', '<body data-offline-launch>');
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/health' || url.pathname === '/ready' || url.pathname === '/config.js') {
    event.respondWith(fetch(event.request));
    return;
  }
  if (event.request.headers?.has('range') || event.request.headers?.has('authorization')) return;
  if (event.request.mode === 'navigate') {
    const shell = url.pathname.startsWith('/parents') ? '/parents'
      : ['/teachers', '/teachers/', '/teachers.html'].includes(url.pathname) ? '/teachers'
      : ['/school', '/school/', '/school.html'].includes(url.pathname) ? '/school' : '/';
    event.respondWith(fetch(event.request).catch(() => offlineShell(shell)));
    return;
  }
  // Precached public assets are identical for browser requests with or without an Origin header.
  const precached = SHELL.includes(url.pathname + url.search);
  event.respondWith(caches.match(event.request, { cacheName: CACHE, ignoreVary: precached }).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok && response.status !== 206) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {}));
    }
    return response;
  })));
});
