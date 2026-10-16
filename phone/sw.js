// Offline app shell (stale-while-revalidate) + best-effort periodic background check.
import { runBackgroundCheck } from './js/background.js';

const CACHE = 'series-tracker-shell-v6';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'css/style.css', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/apple-touch-icon.png', 'js/app.js', 'js/authors.js', 'js/background.js', 'js/check.js', 'js/covers.js', 'js/db.js', 'js/format.js', 'js/hardcover.js',
  'js/importer.js', 'js/recs.js', 'js/parse.js', 'js/ratelimit.js', 'js/store-base.js', 'js/store-idb.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;   // Hardcover/cover requests go straight to the network
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request, { cache: 'no-cache' }).then((r) => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'check-series') e.waitUntil(runBackgroundCheck(self.registration).catch(() => {}));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => (cs.length ? cs[0].focus() : self.clients.openWindow(e.notification.data?.url ?? './'))));
});
