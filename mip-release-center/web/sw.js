// 앱 화면(셸)을 PC에 받아 두어, 서버에 닿지 않을 때도 앱을 열 수 있게 한다.
// 항상 서버 것을 먼저 쓰고, 닿지 않을 때만 받아 둔 것을 쓴다. API 응답은 저장하지 않는다.

const CACHE = 'mrc-shell-v1';
const SHELL = [
  '/', '/styles/tokens.css', '/styles/app.css', '/icon.svg', '/manifest.webmanifest',
  '/js/theme-boot.js', '/js/main.js',
  '/js/lib/api.js', '/js/lib/components.js', '/js/lib/consts.js', '/js/lib/dom.js', '/js/lib/icons.js',
  '/js/lib/net.js', '/js/lib/store.js', '/js/lib/sync.js', '/js/lib/ui.js',
  '/js/views/audit.js', '/js/views/docs.js', '/js/views/home.js', '/js/views/login.js',
  '/js/views/release.js', '/js/views/send.js', '/js/views/sync.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then((hit) => hit ?? Response.error()))
  );
});
