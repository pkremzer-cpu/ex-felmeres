/* Ex-felmérés – offline réteg. Csak a programfájlokat gyorsítótárazza; adat NEM kerül ide (az IndexedDB-ben van).
   v1.4: a szövegfelismerő nagy, változatlan fájljai (motor + modellek, ~25 MB) külön, tartalom-verziós gyorsítótárban vannak,
   így az app-frissítés nem tölti le őket újra. A letöltést a felhasználó indítja (Beállítás › 4.) – a telepítés NEM várja,
   így lassú hálózaton sem késik az offline-kész app-héj, és mobilneten nincs kéretlen 25 MB-os letöltés. */
const VERSION = "exf-1.4.0";
const OCR_CACHE = "exf-ocr-ort1.20.1-ppocrv3";
const ASSETS = ["./", "./index.html", "./app.css", "./logic.js", "./app.js", "./vendor/jszip.min.js", "./manifest.webmanifest",
  "./icons/icon-180.png", "./icons/icon-192.png", "./icons/icon-512.png", "./ocr/ocr-worker.js", "./ocr/ocr-core.js"];
const OCR_BIG = ["./ocr/ort-bundle.min.js", "./ocr/ort-wasm-simd-threaded.wasm", "./ocr/det.onnx", "./ocr/rec.onnx", "./ocr/cls.onnx", "./ocr/keys.txt"];
const BIG_PATHS = new Set(OCR_BIG.map(u => new URL(u, self.location.href).pathname));
self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: "reload" })))));
  // Nincs skipWaiting: frissítés csak a felhasználó jóváhagyásával (az app üzenetére), munka közben nem cserél.
});
self.addEventListener("message", e => { if (e.data === "SKIP_WAITING") self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== OCR_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== self.location.origin) return;
  const target = BIG_PATHS.has(u.pathname) ? OCR_CACHE : VERSION;
  // először a saját (cél-)gyorsítótár, így egy régi gyorsítótárban maradt azonos URL nem kerülhet elé
  e.respondWith(caches.open(target).then(c => c.match(req, { ignoreSearch: true })).then(h => h || caches.match(req, { ignoreSearch: true })).then(hit => hit || fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(target).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => BIG_PATHS.has(u.pathname) ? Response.error() : caches.match("./index.html"))));
});
