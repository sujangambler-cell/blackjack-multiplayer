const CACHE_NAME = 'casino-x-v25';

// Files to cache for offline use
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/poker.css',
  '/game.js',
  '/favicon.svg',
  '/icon-192.svg',
  '/icon-512.svg',
  '/manifest.json'
];

// Install — cache all core assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch — network first, fall back to cache
// WebSocket requests are never intercepted
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never intercept WebSocket upgrades or API calls
  if (event.request.headers.get('upgrade') === 'websocket') return;
  if (url.pathname.startsWith('/ws')) return;

  // For navigation requests serve index.html from cache if offline
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match('/index.html')
      )
    );
    return;
  }

  // Network first for everything else, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache fresh responses for static assets
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
