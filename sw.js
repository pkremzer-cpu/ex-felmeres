/* Ex-felmérés – offline réteg. Csak a programfájlokat gyorsítótárazza; adat NEM kerül ide (az IndexedDB-ben van). */
const VERSION = "exf-1.3.0";
const ASSETS = ["./", "./index.html", "./app.css", "./logic.js", "./app.js", "./vendor/jszip.min.js", "./manifest.webmanifest",
  "./icons/icon-180.png", "./icons/icon-192.png", "./icons/icon-512.png"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: "reload" })))));
  // Nincs skipWaiting: frissítés csak a felhasználó jóváhagyásával (az app üzenetére), munka közben nem cserél.
});
self.addEventListener("message", e => { if (e.data === "SKIP_WAITING") self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match("./index.html"))));
});
