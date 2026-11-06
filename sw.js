// IcebergView — кеш файлів застосунку (щоб відкривався швидко й без інтернету).
// Дані банку тут НЕ кешуються: запити до monobank завжди йдуть напряму в мережу.
const V = 'iceberg-0.2.3';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/logic.js', 'js/mono.js', 'js/vault.js', 'js/plan.js', 'js/scan.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/icon-maskable-512.png', 'icons/hero-480.jpg'];

self.addEventListener('install', e => e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;   // monobank — повз кеш
  // спершу мережа (щоб оновлення приходили одразу), без мережі — з кешу
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(V).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
