/* Saksham Wallet — offline service worker
   ------------------------------------------------------------------
   This is the one part of the app that cannot live inside index.html:
   a service worker must be fetched as its own script from the same
   origin, so the wallet is now two files instead of one.

   Strategy, per kind of request:

     navigation (the page)  network first, cache fallback
         Keeps you on the newest upload whenever you have signal, and
         serves the last good copy when you don't. Cache-first would be
         faster but would show a stale app after every re-upload.

     same-origin assets     cache first, refreshed in the background

     fonts + CDN libraries  cache first, stored on first successful use
         So Tesseract (receipts), SheetJS (Excel) and jsQR (QR scan)
         keep working offline once they have been used once online.

     exchange rates         never cached
         Stale rates are worse than no rates — the app already carries a
         bundled fallback table and its own cache in IndexedDB.
*/
const VERSION   = 'wallet-v2.9.0';
const CORE      = VERSION + '-core';
const RUNTIME   = VERSION + '-runtime';
const CORE_URLS = ['./', './index.html'];

/* rates must always be live-or-fallback, never served from here */
const NEVER_CACHE = [
  'open.er-api.com',
  '@fawazahmed0/currency-api'
];
const isRates = url => NEVER_CACHE.some(p => url.includes(p));

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CORE)
      .then(c => c.addAll(CORE_URLS))
      .then(() => self.skipWaiting())      // a new upload takes over promptly
      .catch(() => self.skipWaiting())     // a missing core file must not wedge install
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CORE && k !== RUNTIME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* let the page ask what's going on, or force a clean refetch */
self.addEventListener('message', e => {
  const msg = e.data && e.data.type;
  if (msg === 'PING') {
    e.source && e.source.postMessage({ type: 'PONG', version: VERSION });
  } else if (msg === 'CLEAR') {
    e.waitUntil(
      caches.keys()
        .then(keys => Promise.all(keys.map(k => caches.delete(k))))
        .then(() => e.source && e.source.postMessage({ type: 'CLEARED' }))
    );
  }
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = req.url;
  if (isRates(url)) return;                          // straight to the network

  /* the page itself */
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CORE).then(c => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match('./index.html').then(hit => hit || caches.match('./'))
        )
    );
    return;
  }

  const sameOrigin = url.startsWith(self.location.origin);

  /* fonts and the lazily-loaded libraries: cache first, fill on first use */
  if (!sameOrigin) {
    event.respondWith(
      caches.match(req).then(hit => {
        if (hit) return hit;
        return fetch(req).then(res => {
          /* opaque responses are fine to store — they replay just as opaquely */
          if (res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(RUNTIME).then(c => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => hit);
      })
    );
    return;
  }

  /* everything else on our own origin */
  event.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(RUNTIME).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
