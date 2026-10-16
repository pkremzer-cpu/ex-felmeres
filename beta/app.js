/* Ex-felmérés – PRJ2656-APADEO – offline-first terepi app (iPhone / Safari, kezdőképernyős webapp)
   Adattárolás: kizárólag a készüléken (IndexedDB). Kimenet: ellenőrzőösszeges ZIP-export (fotók + adatok).
   Adatvédelmi elvek:
   (1) minden módosítás azonnal, egyetlen IndexedDB-tranzakcióban (olvasás + összefésülés + írás + napló) mentődik;
   (2) a mentések sorosítva futnak (nincs versenyhelyzet), a gépelés közbeni szöveg szinkron árnyékmásolatban is megvan;
   (3) minden fotó ArrayBufferként tárolva, visszaolvasva, SHA-256-tal ellenőrizve;
   (4) az app soha nem töröl fotót véglegesen (csak "törölt" jelölés), minden változás naplózva (journal);
   (5) export: ZIP önellenőrzés után, felhasználói megosztás + megerősítés után számít exportáltnak. */
"use strict";
const APP_VERSION = "1.4.0";
// Béta-telepítés (…/beta/): KÜLÖN adatbázis és helyi kulcsok – az éles app adataihoz nem nyúlhat (azonos origó!).
const BETA = typeof location !== "undefined" && /\/beta\//.test(location.pathname);
const DB_NAME = BETA ? "exfelmeres_beta" : "exfelmeres", DB_VER = 2, LSP = BETA ? "exfb_" : "exf_";
const PART_LIMIT = (typeof window !== "undefined" && window.__EXF_PART_LIMIT) || 40 * 1024 * 1024;   // ZIP-rész max. mérete (iOS-memória miatt)
const BATCH_LIMIT = 240 * 1024 * 1024;   // egy AirDrop-kör max. fotómérete (iOS-memória)
const REMIND_PHOTOS = 40, REMIND_MIN = 60;
const MAX_EDGE = 2560, JPEG_Q = 0.85, THUMB_EDGE = 320;
const L = ExLogic;

const S = { db: null, meta: {}, devs: [], byId: new Map(), index: [], recs: new Map(), pmeta: new Map(), labels: {},
            q: "", filter: "all", circ: "all", cab: "", saveChain: Promise.resolve(), pending: null, pendingTimer: null,
            cur: null, swWaiting: null, busy: 0, updating: false, urls: [], bc: null, installId: "" };

/* ---------------- IndexedDB ---------------- */
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result, has = n => db.objectStoreNames.contains(n);
      if (!has("meta")) db.createObjectStore("meta");
      if (!has("devices")) db.createObjectStore("devices", { keyPath: "id" });
      if (!has("records")) db.createObjectStore("records", { keyPath: "id" });
      if (!has("photometa")) { const pm = db.createObjectStore("photometa", { keyPath: "pid" }); pm.createIndex("dev", "dev"); }
      if (!has("photoblob")) db.createObjectStore("photoblob");
      if (!has("thumbs")) db.createObjectStore("thumbs");
      if (!has("journal")) db.createObjectStore("journal", { autoIncrement: true });
    };
    r.onsuccess = () => { const db = r.result; db.onversionchange = () => { db.close(); alert("Az app új verziója egy másik ablakban fut – ezt az ablakot zárd be."); }; res(db); };
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error("Az adatbázis zárolva (az app egy másik ablakban is nyitva van – zárd be)."));
  });
}
function txDo(stores, mode, fn) {
  return new Promise((res, rej) => {
    let t;
    try { t = S.db.transaction(stores, mode); } catch (e) { rej(e); return; }
    let out;
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error || new Error("Tranzakció hiba"));
    t.onabort = () => rej(t.error || new Error("Tranzakció megszakadt"));
    try { out = fn(t); } catch (e) { try { t.abort(); } catch (x) {} rej(e); }
  });
}
const rq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function getAllFix(store) { let v; await txDo([store], "readonly", t => { rq(t.objectStore(store).getAll()).then(x => v = x); }); return v; }
async function getOne(store, key) { let v; await txDo([store], "readonly", t => { rq(t.objectStore(store).get(key)).then(x => v = x); }); return v; }
async function metaSet(k, v) { await txDo(["meta"], "readwrite", t => t.objectStore("meta").put(v, k)); S.meta[k] = v; }
async function loadMeta() {
  for (const k of ["inventory", "session", "lastExport", "lastTim", "defaultMode", "persist", "recent", "exports", "installId", "fullRun", "batchLimit", "exportAttempt"]) S.meta[k] = await getOne("meta", k);
  if (!S.meta.installId) await metaSet("installId", "TEL-" + uuid().slice(0, 8).toUpperCase());
  S.installId = S.meta.installId;
}
async function toBuf(v) { if (!v) return null; if (v instanceof ArrayBuffer) return v; if (v.arrayBuffer) return v.arrayBuffer(); return null; }

/* ---------------- Segédek ---------------- */
const $ = s => document.querySelector(s);
function esc(x) { return String(x === undefined || x === null ? "" : x).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function now() { return new Date().toISOString(); }
function hhmmss(d) { return new Date(d).toLocaleTimeString("hu-HU"); }
function stamp() { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map(x => x.toString(16).padStart(2, "0")).join(""); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
async function sha256(buf) { const h = await crypto.subtle.digest("SHA-256", buf); return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join(""); }
function fmtBytes(n) { if (!n && n !== 0) return "?"; const u = ["B", "kB", "MB", "GB"]; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + " " + u[i]; }
function setSave(state, txt) { const el = $("#savestate"); el.className = "savestate " + state; el.textContent = txt; }
function isStandalone() { return (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true; }
const TXT_ATTR = 'autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false"';

/* Modális ablak: az alert/confirm NEM zárható a háttérre koppintva (a várakozó ígéret mindig teljesül). */
// Modális sor: egy új ablak nem írhat felül egy nyitottat (a várakozó ígéret beragadna) – sorba áll.
let modalDismiss = null, modalOpen = false; const modalQueue = [];
function modal(html, onMount, dismiss) {
  if (modalOpen) { modalQueue.push([html, onMount, dismiss]); return; }
  modalOpen = true; $("#modalbody").innerHTML = html; $("#modal").classList.remove("hidden"); modalDismiss = dismiss || null; if (onMount) onMount($("#modalbody"));
}
function closeModal() {
  $("#modal").classList.add("hidden"); $("#modalbody").innerHTML = ""; modalDismiss = null; modalOpen = false;
  const nx = modalQueue.shift(); if (nx) setTimeout(() => modal(...nx), 0);
}
function confirmBox(title, text, okLabel, danger) {
  return new Promise(res => modal(`<h2>${esc(title)}</h2><div>${text}</div><div class="row" style="margin-top:12px"><button id="mNo" class="grow">Mégse</button><button id="mYes" class="grow ${danger ? "danger" : "primary"}">${esc(okLabel)}</button></div>`,
    b => { b.querySelector("#mNo").onclick = () => { closeModal(); res(false); }; b.querySelector("#mYes").onclick = () => { closeModal(); res(true); }; }));
}
function alertBox(title, html) { return new Promise(res => modal(`<h2>${esc(title)}</h2><div>${html}</div><button id="mOk" class="primary" style="width:100%;margin-top:12px">Rendben</button>`, b => b.querySelector("#mOk").onclick = () => { closeModal(); res(); })); }
async function busy(fn) { S.busy++; updateBanner(); try { return await fn(); } finally { S.busy--; updateBanner(); } }

/* ---------------- Rekordok mentése: sorosítva, egy tranzakcióban (olvas–összefésül–ír–naplóz) ---------------- */
function blankRec(id) { return { id, mode: S.meta.defaultMode || "reszletes", res: {}, status: "uj", rev: 0 }; }
function recOf(id) { return S.recs.get(id) || blankRec(id); }
function saveRecord(id, patch, why) {
  const run = S.saveChain.then(() => saveRecordNow(id, patch, why));
  S.saveChain = run.catch(() => {});
  return run;
}
async function saveRecordNow(id, patch, why) {
  setSave("busy", "Mentés…");
  let rec;
  try {
    // ZSO/ZSC pár: ugyanaz a módosítás UGYANABBAN a tranzakcióban a pár másik tagjára is (egy tok = egy eszköz).
    const ids = partnerOf(id) ? [id, partnerOf(id)] : [id], out = {};
    await txDo(["records", "journal"], "readwrite", t => {
      const st = t.objectStore("records");
      for (const rid of ids) {
        const g = st.get(rid);
        g.onsuccess = () => {
          const old = g.result || blankRec(rid);
          const r2 = JSON.parse(JSON.stringify(old));
          Object.assign(r2, patch);
          if (patch.res) r2.res = Object.assign({}, old.res || {}, patch.res);
          if (!("status" in patch) && ["uj", "kesz", "ertekelendo"].includes(old.status)) r2.status = "folyamatban";
          if (ids.length > 1) r2.pair = ids.find(x => x !== rid);
          r2.rev = (old.rev || 0) + 1; r2.updated = now(); r2.by = (S.meta.session || {}).name || ""; r2.tel = S.installId;
          st.put(r2); out[rid] = r2;
          t.objectStore("journal").add({ ts: r2.updated, by: r2.by, tel: S.installId, dev: rid, why: (why || "edit") + (rid !== id ? "+pair" : ""), patch, rev: r2.rev });
        };
      }
    });
    rec = out[id];
    for (const rid of ids) { S.recs.set(rid, out[rid]); if (S.bc) S.bc.postMessage({ t: "rec", id: rid }); }
    setSave("ok", "Mentve ✓ " + hhmmss(rec.updated));
    if (["zg", "zp", "tg", "tp", "tt", "tmax"].some(k => k in patch)) {
      try { const lt = Object.assign({}, S.meta.lastTim || {}); for (const k of ["zg", "zp", "tg", "tp", "tt", "tmax"]) if (k in patch) lt[k] = patch[k]; await metaSet("lastTim", lt); } catch (e) { /* kényelmi adat – a rekord már mentve */ }
    }
    return rec;
  } catch (e) {
    setSave("err", "MENTÉSI HIBA!");
    alertBox("Mentési hiba", `<p class="msg err">A módosítás NEM mentődött: ${esc(e.message || e)}</p><p>Ne zárd be az appot. Készíts exportot (Export menü), és ellenőrizd a tárhelyet.</p>`);
    throw e;
  }
}
/* Gépelés: 400 ms késleltetés + szinkron árnyékmásolat (localStorage), hogy iOS-felfüggesztéskor se vesszen el. */
function queueText(id, key, val) {
  S.pending = { id, key, val };
  try { localStorage.setItem(LSP + "pending", JSON.stringify(S.pending)); } catch (e) {}
  setSave("busy", "Gépelés…");
  clearTimeout(S.pendingTimer);
  S.pendingTimer = setTimeout(flushPending, 400);
}
S.chain = Promise.resolve();
function flushPending() {
  clearTimeout(S.pendingTimer);
  const p = S.pending; S.pending = null;
  S.chain = S.chain.then(async () => {
    if (!p) return;
    const cur = recOf(p.id);
    if ((cur[p.key] || "") !== p.val) await saveRecord(p.id, { [p.key]: p.val }, "text"); else setSave("ok", "Mentve ✓");
    try { const ls = JSON.parse(localStorage.getItem(LSP + "pending") || "null"); if (ls && ls.id === p.id && ls.key === p.key && ls.val === p.val) localStorage.removeItem(LSP + "pending"); } catch (e) {}
  }).catch(() => {});
  return S.chain;
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushPending(); });
window.addEventListener("pagehide", () => flushPending());

/* ---------------- Fotók ---------------- */
function loadImage(blob) {
  return new Promise((res, rej) => { const url = URL.createObjectURL(blob); const img = new Image();
    img.onload = () => res({ img, url }); img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("A kép nem dekódolható")); }; img.src = url; });
}
async function resizeTo(img, edge, q) {
  const w0 = img.naturalWidth, h0 = img.naturalHeight, k = Math.min(1, edge / Math.max(w0, h0));
  const w = Math.round(w0 * k), h = Math.round(h0 * k);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  const blob = await new Promise(r => c.toBlob(r, "image/jpeg", q));
  c.width = c.height = 0;
  return { blob, w, h };
}
async function processPhoto(file) {
  try {
    const { img, url } = await loadImage(file);
    const main = await resizeTo(img, MAX_EDGE, JPEG_Q);
    let thumb = null; try { thumb = (await resizeTo(img, THUMB_EDGE, 0.7)).blob; } catch (e) {}
    URL.revokeObjectURL(url);
    if (!main.blob || main.blob.size < 1000) throw new Error("üres kódolás");
    return { blob: main.blob, w: main.w, h: main.h, thumb, orig: false };
  } catch (e) {
    // Biztonsági tartalék: ha a kép nem méretezhető, az EREDETI fájl kerül mentésre (fotó nem veszhet el).
    return { blob: file, w: 0, h: 0, thumb: null, orig: true, note: String(e.message || e) };
  }
}
function photosOf(id) { const pt = partnerOf(id); return [...S.pmeta.values()].filter(p => p.dev === id || (pt && p.dev === pt)).sort((a, b) => a.ts < b.ts ? -1 : 1); }
async function addOnePhoto(devId, type, file) {
  const pr = await processPhoto(file);
  const buf = await pr.blob.arrayBuffer();
  const sha = await sha256(buf);
  const tbuf = pr.thumb ? await pr.thumb.arrayBuffer() : null;
  const n = photosOf(devId).filter(p => p.type === type).length + 1;
  const meta = { pid: uuid(), dev: devId, type, n, sha, bytes: buf.byteLength, w: pr.w, h: pr.h, ts: now(),
                 by: (S.meta.session || {}).name || "", tel: S.installId, mime: pr.orig ? (file.type || "application/octet-stream") : "image/jpeg",
                 orig: pr.orig, note: pr.note || "", verified: false, deleted: false, exported: [] };
  await txDo(["photometa", "photoblob", "thumbs", "journal"], "readwrite", t => {
    t.objectStore("photoblob").put(buf, meta.pid);              // ArrayBuffer (WebKit Blob-hiba elkerülése)
    if (tbuf) t.objectStore("thumbs").put(tbuf, meta.pid);
    t.objectStore("photometa").put(meta);
    t.objectStore("journal").add({ ts: meta.ts, by: meta.by, tel: S.installId, dev: devId, why: "photo-add", patch: { pid: meta.pid, type, sha } });
  });
  const back = await toBuf(await getOne("photoblob", meta.pid));
  meta.verified = !!back && (await sha256(back)) === sha;
  await txDo(["photometa"], "readwrite", t => t.objectStore("photometa").put(meta));
  S.pmeta.set(meta.pid, meta);
  return meta;
}
async function addPhotos(devId, type, files) {
  const fails = [], warn = [], saved = [];
  await busy(async () => {
    for (const file of files) {
      setSave("busy", "Fotó mentése…");
      try {
        const m = await addOnePhoto(devId, type, file); saved.push(m);
        if (!m.verified) fails.push(`${file.name || "fotó"}: a visszaolvasott ellenőrzőösszeg eltér`);
        if (m.orig) warn.push(`${file.name || "fotó"}: nem méretezhető (${m.note}) – az eredeti fájl mentve`);
      } catch (e) { fails.push(`${file.name || "fotó"}: ${e.name === "QuotaExceededError" ? "MEGTELT A TÁRHELY" : (e.message || e)}`); }
    }
  });
  if (fails.length) { setSave("err", "FOTÓHIBA"); await alertBox("Fotó mentési hiba", `<p class="msg err">${fails.map(esc).join("<br>")}</p><p>Fotózd újra. Ha a tárhely telt meg: exportálj most.</p>`); }
  else setSave("ok", `Fotó mentve ✓ ${hhmmss(now())}`);
  if (warn.length) await alertBox("Figyelem", `<p class="msg warn">${warn.map(esc).join("<br>")}</p>`);
  const r = recOf(devId);
  if (files.length > fails.length && ["uj", "kesz", "ertekelendo"].includes(r.status)) await saveRecord(devId, { status: "folyamatban" }, "photo");
  updateBanner();
  return saved;
}

/* ---------------- Offline szövegfelismerés (v1.4): PP-OCRv3 + ONNX Runtime Web, Web Workerben, a telefonon ----------------
   Semmi nem megy ki a telefonról. A modellek a Service Worker külön gyorsítótárában vannak (OCR_CACHE), az app-frissítés nem tölti le újra.
   Az eredmény MINDIG csak javaslat: a tervjelnél a felhasználó választ a találatok közül, az adattáblánál mezőnként hagyja jóvá. */
const OCR_CACHE = "exf-ocr-ort1.20.1-ppocrv3";
const OCR_FILES = ["ocr/ocr-worker.js", "ocr/ocr-core.js", "ocr/ort-bundle.min.js", "ocr/ort-wasm-simd-threaded.wasm", "ocr/det.onnx", "ocr/rec.onnx", "ocr/cls.onnx", "ocr/keys.txt"];
const OCR = { w: null, seq: 0, jobs: new Map(), idle: null, busy: false };
const OCR_IDLE_MS = 45000;   // a WASM-heap nem zsugorodik: tétlen worker leállítása (iOS-memória)
const OCR_TRIES = [{ detMax: 1600 }, { detMax: 1280 }];   // mérve: 1600 px detektálás ≈ 2560 px pontosság (37,1% vs 38,2%, zajon belül), fele memória
function simdOk() { try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (e) { return false; } }
function ocrKill(msg) {
  clearTimeout(OCR.idle); OCR.idle = null;
  if (OCR.w) { try { OCR.w.terminate(); } catch (e) {} OCR.w = null; }
  const js = [...OCR.jobs.values()]; OCR.jobs.clear(); for (const j of js) j.rej(new Error(msg));
}
function ocrWorker() {
  if (OCR.w) return OCR.w;
  const w = new Worker("ocr/ocr-worker.js", { type: "module" });
  w.onmessage = e => { const m = e.data || {}, j = OCR.jobs.get(m.id); if (!j) return; if (m.progress) { if (j.prog) j.prog(m.progress); return; }
    OCR.jobs.delete(m.id); if (m.ok) j.res(m); else j.rej(new Error(m.error || "ismeretlen hiba")); };
  w.onerror = e => { if (e && e.preventDefault) e.preventDefault(); ocrKill("A felismerő nem indult el" + (e && e.message ? ": " + e.message : "") + " (Beállítás › 4. Offline szövegfelismerés)"); };
  w.onmessageerror = () => ocrKill("Üzenethiba a felismerővel");
  return (OCR.w = w);
}
function ocrCall(msg, transfer, prog, timeoutMs) {
  if (!simdOk()) return Promise.reject(new Error("Ez az iOS-verzió nem támogatja az offline felismerést (WebAssembly SIMD kell: iOS 16.4 vagy újabb). Frissítsd az iOS-t, addig írd be kézzel."));
  clearTimeout(OCR.idle); OCR.idle = null;
  const arm = () => { if (!OCR.jobs.size) { clearTimeout(OCR.idle); OCR.idle = setTimeout(() => { if (!OCR.jobs.size) ocrKill("tétlen"); }, OCR_IDLE_MS); } };
  return new Promise((res, rej) => {
    const id = ++OCR.seq, to = setTimeout(() => { if (OCR.jobs.has(id)) ocrKill("Időtúllépés – a felismerés nem fejeződött be"); }, timeoutMs || 180000);
    OCR.jobs.set(id, { res: v => { clearTimeout(to); OCR.jobs.delete(id); arm(); res(v); }, rej: e => { clearTimeout(to); OCR.jobs.delete(id); arm(); rej(e); }, prog });
    try { ocrWorker().postMessage(Object.assign({ id }, msg), transfer || []); } catch (e) { OCR.jobs.delete(id); clearTimeout(to); rej(e); }
  });
}
// Kép → RGBA (hosszabb oldal ≤ MAX_EDGE, ugyanaz a felbontás, amin a pontosságot mértük)
async function blobToRGBA(blob) {
  let src = null, url = null;
  try {
    try { src = await createImageBitmap(blob); }
    catch (e) { url = URL.createObjectURL(blob); const im = new Image(); im.src = url; await im.decode(); src = im; }
    const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
    if (!w0 || !h0) throw new Error("A kép nem olvasható");
    const s = Math.min(1, MAX_EDGE / Math.max(w0, h0)), w = Math.max(1, Math.round(w0 * s)), h = Math.max(1, Math.round(h0 * s));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d", { willReadFrequently: true }); x.imageSmoothingQuality = "high"; x.drawImage(src, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h); c.width = c.height = 0;
    return d;
  } finally { if (src && src.close) src.close(); if (url) URL.revokeObjectURL(url); }
}
// Felismerés; memóriahiba / összeomlás esetén egyszer újrapróbálja kisebb detektálási felbontással
async function runOcr(blob, prog) {
  const tries = OCR_TRIES; let last = null;
  const tok = (prog && prog.tok) || {};
  for (let k = 0; k < tries.length; k++) {
    if (tok.cancelled) throw ocrCancelled();
    const d = await blobToRGBA(blob);
    if (tok.cancelled) throw ocrCancelled();
    const opt = Object.assign({}, tries[k]);
    if (k === 0 && window.__EXF_OCR_FAIL_ONCE) { window.__EXF_OCR_FAIL_ONCE = 0; opt.__fail = 1; }   // csak automata teszthez (memóriahiba-szimuláció)
    try { const r = await ocrCall({ cmd: "ocr", img: { data: d.data.buffer, width: d.width, height: d.height }, opt }, [d.data.buffer], prog); if (tok.cancelled) throw ocrCancelled(); r.reduced = k > 0; return r; }
    catch (e) {
      last = e; ocrKill("újraindítás");
      if (e.cancelled || /SIMD|nem indult el|Load failed|Failed to fetch|NetworkError|HTTP \d/.test(e.message || "")) break;   // nem memóriahiba: nincs értelme újrapróbálni
    }
  }
  throw last;
}
async function ocrMissing() {
  const miss = [];
  if (!("caches" in window)) return OCR_FILES.slice();
  for (const f of OCR_FILES) { try { if (!(await caches.match(new URL(f, location.href).href, { ignoreSearch: true }))) miss.push(f); } catch (e) { miss.push(f); } }
  return miss;
}
const OCR_BIG_FILES = OCR_FILES.slice(2);   // a programkód (worker, core) az app-gyorsítótárban verziózódik, itt csak a változatlan nagy fájlok
async function ocrDownload() {
  const miss = await ocrMissing(); if (!miss.length) return 0;
  const c = await caches.open(OCR_CACHE);
  for (const f of miss) { if (OCR_BIG_FILES.includes(f)) await c.add(new Request(f, { cache: "reload" })); else { const r = await fetch(f, { cache: "reload" }); if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); } }
  const still = await ocrMissing(); if (still.length) throw new Error("Nem minden fájl került a tárolóba: " + still.join(", "));
  return miss.length;
}
// Folyamatjelző: KÜLÖN réteg (#ocrov), nem a modális sor része – nem zár be és nem takar el más (pl. mentési hiba) ablakot.
function ocrCancelled() { const e = new Error("Megszakítva"); e.cancelled = true; return e; }
function ocrProgress(title) {
  const tok = { cancelled: false }, ov = $("#ocrov"), body = $("#ocrovbody");
  body.innerHTML = `<h2>${esc(title)}</h2><p id="ocrProg" class="muted">Előkészítés…</p><div class="progress"><div id="ocrBar" style="width:2%"></div></div>
    <p class="muted">A felismerés a telefonon fut, internet nélkül. Első használatkor a modellek betöltése néhány másodperc.</p>
    <button id="ocrCancel" style="width:100%;margin-top:8px">Mégse</button>`;
  ov.classList.remove("hidden");
  const close = () => { ov.classList.add("hidden"); body.innerHTML = ""; };
  body.querySelector("#ocrCancel").onclick = () => {
    tok.cancelled = true; close();
    const js = [...OCR.jobs.values()]; OCR.jobs.clear(); ocrKill("megszakítva"); for (const j of js) j.rej(ocrCancelled());
  };
  const LAB = { load: "Modellek betöltése", det: "Szöveg keresése a képen", rec: "Karakterfelismerés" }, BASE = { load: 0, det: 20, rec: 45 }, SPAN = { load: 20, det: 25, rec: 55 };
  const prog = p => { const el = $("#ocrProg"), bar = $("#ocrBar"); if (!el || !bar) return;
    el.textContent = `${LAB[p.stage] || p.stage}${p.n ? ` (${p.i}/${p.n})` : ""}…`;
    bar.style.width = Math.min(100, (BASE[p.stage] || 0) + (p.n ? (SPAN[p.stage] || 0) * p.i / p.n : 0)).toFixed(0) + "%"; };
  prog.tok = tok; prog.close = close;
  return prog;
}
function ocrFail(e, what) {
  if (e && e.cancelled) return Promise.resolve();
  const off = !navigator.onLine;
  return alertBox("Felismerési hiba", `<p class="msg err">${esc(e.message || e)}</p><p>${esc(what)}</p>${off ? `<p class="muted">Ha a felismerő még nincs letöltve: Beállítás › <b>4. Offline szövegfelismerés</b> (térerőnél).</p>` : ""}`);
}
function pickOcrPhoto(fn) {
  const inp = $("#ocrcam"); inp.value = "";
  inp.onchange = () => { const f = inp.files && inp.files[0]; inp.onchange = null; if (f) fn(f); };
  inp.click();
}
// 📷 Tervjel: fotó → felismerés → a leltárban legjobban illeszkedő 3 eszköz (a fotó NEM kerül mentésre)
async function ocrSearch(file) {
  if (OCR.busy) return; OCR.busy = true;
  const prog = ocrProgress("Tervjel felismerése"); let r;
  try { const pr = await processPhoto(file); if (prog.tok.cancelled) throw ocrCancelled(); r = await runOcr(pr.orig ? file : pr.blob, prog); }
  catch (e) { prog.close(); return ocrFail(e, "Próbáld újra, vagy írd be a tervjelet a keresőbe."); }
  finally { OCR.busy = false; }
  prog.close(); showTagHits(r);
}
function showTagHits(r) {
  const txt = String(r.text || "").trim(), lines = (r.lines || []).map(l => l.text).filter(t => t.trim());
  const hits = txt ? L.search(S.vis, S.index, txt, 3) : [];
  const kind = d => { const i = S.vis.indexOf(d); const k = i >= 0 ? L.matchKind(S.index[i], txt) : ""; return k === "pontos" ? '<span class="mk ok">pontos</span>' : k === "ocr" ? '<span class="mk ocr">≈ javított</span>' : '<span class="mk ocr">részleges – ellenőrizd!</span>'; };
  modal(`<h2>Tervjel – találatok</h2>
    ${hits.length ? `<p class="muted">Koppints a helyes eszközre. A címkét mindig vesd össze a találattal.</p>` : `<p class="msg warn">Nincs a leltárban illeszkedő tervjel.</p><p class="muted">Tipp: menj közelebb, a címke töltse ki a kép nagy részét, élesen, tükröződés nélkül, merőlegesen.</p>`}
    ${hits.map(d => `<button class="hit" data-hit="${esc(d.id)}" style="width:100%;margin:4px 0;text-align:left"><b>${esc(d.tag)}</b> ${kind(d)}<br><span class="muted">${esc(d.leiras || "")} · ${esc(d.szekreny || "")}</span></button>`).join("")}
    ${lines.length ? `<details style="margin-top:8px"><summary>Felismert sorok (${lines.length}) – koppintva a keresőbe kerül</summary>${lines.slice(0, 12).map((t, i) => `<button class="chip" data-line="${i}" style="margin:3px">${esc(t)}</button>`).join("")}</details>` : ""}
    <div class="row" style="margin-top:10px"><button id="mNo" class="grow">Mégse</button><button id="mAgain" class="grow primary">Új fotó</button></div>`, b => {
    b.querySelector("#mNo").onclick = closeModal;
    b.querySelector("#mAgain").onclick = () => { closeModal(); pickOcrPhoto(ocrSearch); };
    b.querySelectorAll("[data-hit]").forEach(x => x.onclick = () => { closeModal(); openDevice(x.dataset.hit); });
    b.querySelectorAll("[data-line]").forEach(x => x.onclick = () => { closeModal(); S.q = lines[+x.dataset.line]; renderHome(); });
  }, closeModal);
}
// 📷 Adattábla: fotó → MENTÉS (ADATTABLA, bizonyíték) → a mentett képből felismerés → mezőjavaslat jóváhagyásra
async function ocrPlate(id, file) {
  if (OCR.busy) return; OCR.busy = true;
  try {
    await flushPending();
    const saved = await addPhotos(id, "ADATTABLA", [file]);
    if (S.cur === id) renderDevice(id);
    // Bizonyító fotó nélkül nincs javaslat: ha a mentés vagy az ellenőrzőösszeg hibás, az addPhotos már jelzett – itt megállunk.
    if (!saved[0] || !saved[0].verified) return;
    const prog = ocrProgress("Adattábla felismerése"); let r;
    try {
      const b = await toBuf(await getOne("photoblob", saved[0].pid)); if (!b) throw new Error("A mentett fotó nem olvasható vissza");
      if (prog.tok.cancelled) throw ocrCancelled();
      r = await runOcr(new Blob([b], { type: saved[0].mime || "image/jpeg" }), prog);
    } catch (e) { prog.close(); return ocrFail(e, "A fotó mentve (ADATTABLA). Az adatokat írd be kézzel, vagy próbáld újra."); }
    prog.close();
    proposeFields(id, { text: r.text, lines: (r.lines || []).map(l => l.text), pid: saved[0].pid, reduced: r.reduced });
  } finally { OCR.busy = false; }
}
// Az Ex-jelöléshez tartozó sorok a felismert szövegből (a „Teljes Ex-jelölés” mezőbe javasolt rész)
function exLines(lines) {
  const STRONG = /(?:^|[^A-Z])E?E\s?X\s?(?:D|E|I|M|N|O|P|Q|T[ABC]|\[)|\bIP\s?[0-9X]{2}|ATEX|IECEX|\b[I1L]{1,3}\s?[123](?:\/[123])?\s?[GD]\b|\b[GD][ABC]\b(?!\s*[(\d~=.])|\bT\s?\d{2,3}\s?°?C\b/;
  const WEAK = /\bI{2,3}\s?[ABC]\b|\bT[1-6]\b/;   // csupasz „IIC T4” sor csak egy Ex-sor folytatásaként
  const U = lines.map(t => String(t).toUpperCase()), strong = U.map(t => STRONG.test(t)), keep = strong.slice();
  for (let i = 1; i < U.length; i++) if (!keep[i] && strong[i - 1] && WEAK.test(U[i])) keep[i] = true;   // csak közvetlenül egy erős Ex-sor után, láncolás nélkül
  return lines.filter((_, i) => keep[i]);
}
async function toggleDeletePhoto(pid) {
  const m = S.pmeta.get(pid); if (!m) return;
  const undo = m.deleted;
  const ok = undo ? await confirmBox("Törlés visszavonása", "A fotó ismét aktív lesz.", "Visszavonás", false)
                  : await confirmBox("Fotó törlésre jelölése", "A fotó NEM törlődik véglegesen: „törölt” jelölést kap, és az exportban is megmarad (fotok_TOROLT mappa). Folytatod?", "Jelölés", true);
  if (!ok) return;
  const upd = Object.assign({}, m, { deleted: !undo });
  await txDo(["photometa", "journal"], "readwrite", t => { t.objectStore("photometa").put(upd); t.objectStore("journal").add({ ts: now(), by: (S.meta.session || {}).name, tel: S.installId, dev: m.dev, why: "photo-del", patch: { pid, deleted: upd.deleted } }); });
  S.pmeta.set(pid, upd);
  renderDevice(m.dev);
}
async function showPhoto(pid) {
  const m = S.pmeta.get(pid); const b = await toBuf(await getOne("photoblob", pid)); if (!b) return alertBox("Hiba", "A fotó nem olvasható.");
  const url = URL.createObjectURL(new Blob([b], { type: m.mime || "image/jpeg" }));
  const close = () => { URL.revokeObjectURL(url); closeModal(); };
  modal(`<img src="${url}" alt="fotó"><div class="kv" style="margin-top:8px"><b>Típus</b><span>${esc(m.type)} #${esc(m.n)}</span><b>Idő</b><span>${esc(new Date(m.ts).toLocaleString("hu-HU"))}</span>
    <b>Méret</b><span>${esc(m.w)}×${esc(m.h)}, ${fmtBytes(m.bytes)}</span><b>Ellenőrizve</b><span>${m.verified ? "igen ✓" : "NEM"}</span><b>SHA-256</b><span class="mono">${esc(m.sha)}</span>
    <b>Állapot</b><span>${m.deleted ? "TÖRÖLT jelölésű" : "aktív"}${m.exported.length ? " · exportálva" : " · még nincs exportálva"}</span></div>
    <div class="row" style="margin-top:12px"><button id="pDel" class="grow ${m.deleted ? "" : "danger"}">${m.deleted ? "Törlés visszavonása" : "Törlésre jelöl"}</button><button id="pClose" class="grow primary">Bezár</button></div>`,
    bd => { bd.querySelector("#pClose").onclick = close; bd.querySelector("#pDel").onclick = () => { URL.revokeObjectURL(url); closeModal(); toggleDeletePhoto(pid); }; }, close);
}

/* ---------------- Állapot, szűrés ---------------- */
function devStatus(d) {
  const r = S.recs.get(d.id); if (!r || r.status === "uj") return ["new", "Nincs kezdve"];
  const nok = Object.values(r.res || {}).includes("NOK") || Object.values(L.evaluate(r)).includes("NEM FELEL MEG");
  if (r.status === "kesz") return nok ? ["nok", "Kész · NOK"] : ["done", "Kész"];
  if (r.status === "ertekelendo") return ["evl", "Értékelendő"];
  return nok ? ["nok", "Folyamatban · NOK"] : ["wip", "Folyamatban"];
}
function passFilter(d) {
  if (S.cab && d.szekreny !== S.cab) return false;
  if (S.circ === "exi" && d.exi !== "IGEN") return false;
  if (S.circ === "nonexi" && !(d.tipus !== "SZEKRENY" && d.exi !== "IGEN")) return false;
  const st = devStatus(d)[0], r = S.recs.get(d.id);
  switch (S.filter) {
    case "new": return st === "new";
    case "wip": return !!r && r.status === "folyamatban";
    case "eval": return st === "evl";
    case "done": return !!r && r.status === "kesz";
    case "nok": return st === "nok";
    case "cab": return d.tipus === "SZEKRENY";
    case "uj": return d.tipus === "UJ";
    default: return true;
  }
}
function countFor(k) { const keep = S.filter; S.filter = k; const n = S.vis.filter(passFilter).length; S.filter = keep; return n; }
// ZSO/ZSC pár (egy tok = egy eszköz): a listában csak a ZSO (elsődleges) látszik, a ZSC tagjére is rá lehet keresni.
function rebuildIndex() {
  S.byId = new Map(S.devs.map(d => [d.id, d]));
  S.pairs = L.buildPairs(S.devs);
  S.vis = S.devs.filter(d => !isSecondary(d.id));
  S.index = S.vis.map(d => L.buildIndex(d, partnerOf(d.id) ? [S.byId.get(partnerOf(d.id)).tag] : []));
}
function partnerOf(id) { return (S.pairs && S.pairs.partner[id]) || null; }
function isSecondary(id) { const p = S.pairs && S.pairs.primaryOf[id]; return !!p && p !== id; }
function primaryId(id) { return isSecondary(id) ? S.pairs.primaryOf[id] : id; }
const PAIR_IGN = ["id", "rev", "updated", "by", "tel", "pair"];
function recCore(r) { if (!r) return null; const o = {}; for (const k of Object.keys(r).sort()) if (!PAIR_IGN.includes(k)) o[k] = r[k]; return L.canon(o); }
function recEmpty(r) { return !r || (r.status === "uj" && !Object.keys(r).some(k => !PAIR_IGN.concat(["status", "mode", "res"]).includes(k) && r[k] !== "" && r[k] !== undefined) && !Object.values(r.res || {}).some(Boolean)); }
function pairConflict(id) { const p = partnerOf(id); if (!p) return false; const a = S.recs.get(id), b = S.recs.get(p); return !!a && !!b && !recEmpty(a) && !recEmpty(b) && recCore(a) !== recCore(b); }
async function copyPair(src, dst, why) {
  // src rekord tartalma → dst (saját azonosító, rev, pár-hivatkozás); egy tranzakcióban, naplózva (a régi dst érték a naplóban).
  // pair-sync: a forrás felmérési metaadatai (by/tel/updated) megmaradnak – így két telefon azonos adata nem látszik ütközésnek.
  const res = {};
  await txDo(["records", "journal"], "readwrite", t => {
    const st = t.objectStore("records"); const g1 = st.get(src);
    g1.onsuccess = () => { const s1 = g1.result; if (!s1) return; const g2 = st.get(dst);
      g2.onsuccess = () => { const old = g2.result || blankRec(dst), ts = now();
        const keep = why === "pair-sync";
        const r2 = JSON.parse(JSON.stringify(s1)); r2.id = dst; r2.pair = src; r2.rev = Math.max((old.rev || 0) + 1, s1.rev || 0);
        if (!keep) { r2.updated = ts; r2.by = (S.meta.session || {}).name || s1.by || ""; r2.tel = S.installId; }
        st.put(r2); res[dst] = r2;
        t.objectStore("journal").add({ ts, by: (S.meta.session || {}).name || "", tel: S.installId, dev: dst, why, patch: { from: src, old: g2.result || null }, rev: r2.rev });
        if (s1.pair !== dst) { const s1b = Object.assign({}, s1, { pair: dst }); st.put(s1b); res[src] = s1b; } }; };
  });
  for (const k of Object.keys(res)) S.recs.set(k, res[k]);   // memória csak sikeres commit után
}
function pairDiff(a, b) {
  const keys = [...new Set(Object.keys(a || {}).concat(Object.keys(b || {})))].filter(k => !PAIR_IGN.includes(k)).sort();
  return keys.filter(k => L.canon((a || {})[k] === undefined ? null : a[k]) !== L.canon((b || {})[k] === undefined ? null : b[k])).map(k => [k, (a || {})[k], (b || {})[k]]);
}
function pairConflictCount() { if (!S.pairs) return 0; let n = 0; for (const id of Object.keys(S.pairs.partner)) if (!isSecondary(id) && pairConflict(id)) n++; return n; }
// Indításkor / visszaállítás után: a pár hiányzó tagja megkapja a másik tag adatait (meglévő eltérő adatot NEM ír felül – azt jelzi).
async function syncPairs() {
  if (!S.pairs) return { copied: 0, conflicts: 0 };
  let copied = 0, conflicts = 0;
  for (const o of Object.keys(S.pairs.primaryOf)) {
    if (isSecondary(o)) continue; const c = partnerOf(o); const ro = S.recs.get(o), rc = S.recs.get(c);
    if (ro && !recEmpty(ro) && recEmpty(rc)) { await copyPair(o, c, "pair-sync"); copied++; }
    else if (rc && !recEmpty(rc) && recEmpty(ro)) { await copyPair(c, o, "pair-sync"); copied++; }
    else if (pairConflict(o)) conflicts++;
  }
  return { copied, conflicts };
}

/* ---------------- Beállítás ---------------- */
function renderSetup() {
  const inv = S.meta.inventory, ses = S.meta.session;
  $("#view").innerHTML = `
  <h1>Beállítás</h1>
  ${isStandalone() ? "" : `<div class="msg err"><b>Nem a főképernyőről fut!</b> Safari-fülben az iOS idővel törölheti az adatokat, és a tárhely külön van a telepített apptól.
    Telepítés: Safari <b>Megosztás › Főképernyőhöz adás</b>, majd onnan indítsd, és ott töltsd be a leltárt.</div>`}
  <div class="card"><h3>1. Leltár betöltése ${inv ? "✓" : ""}</h3>
    ${inv ? `<p class="msg ok">${esc(inv.doc)} · ${esc(inv.count)} tétel · SHA ${esc(inv.sha.slice(0, 12))}… · betöltve ${esc(new Date(inv.ts).toLocaleString("hu-HU"))}</p>` :
      `<p class="muted">Válaszd ki az <b>ICCS-2656-EXC-013-v01_app-leltar.json</b> fájlt (AirDrop / Fájlok app).</p>`}
    <button id="bInv" class="${inv ? "" : "primary"}" style="width:100%">${inv ? "Leltár frissítése" : "Leltár fájl kiválasztása"}</button></div>
  <div class="card"><h3>2. Bejárás adatai ${ses && ses.name && ses.permit ? "✓" : ""}</h3>
    <label class="f" for="sName">Felmérő neve</label><input id="sName" type="text" autocomplete="name" value="${esc(ses ? ses.name : "")}">
    <label class="f" for="sPermit">Munkavégzési / gázmentességi engedély száma (iPhone zónában)</label><input id="sPermit" type="text" ${TXT_ATTR} value="${esc(ses ? ses.permit : "")}">
    <label class="f">Alapértelmezett mód új eszköznél</label>
    <div class="seg" style="grid-template-columns:1fr 1fr"><button data-m="reszletes" class="${(S.meta.defaultMode || "reszletes") === "reszletes" ? "on SEL" : ""}">Részletes</button><button data-m="gyors" class="${S.meta.defaultMode === "gyors" ? "on SEL" : ""}">Gyors (fotó)</button></div>
    <button id="bSes" class="primary" style="width:100%;margin-top:12px">Mentés</button></div>
  <div class="card"><h3>3. Tartós tárolás</h3><p id="persistInfo" class="muted">…</p>
    <button id="bPersist" style="width:100%">Tartós tárolás kérése</button>
    <p class="muted">Telefon-azonosító: <b>${esc(S.installId)}</b> · app ${APP_VERSION}</p></div>
  <div class="card"><h3>4. Offline szövegfelismerés (📷 Tervjel, 📷 Adattábla)</h3><p id="ocrInfo" class="muted">Ellenőrzés…</p>
    <button id="bOcr" style="width:100%">Letöltés és próba (kb. 25 MB, egyszer – térerőnél)</button></div>
  ${inv && ses && ses.name && ses.permit ? `<button id="bGo" class="primary" style="width:100%">Tovább a kereséshez</button>` : ""}
  <div class="card"><h3>Visszaállítás exportból (új / csere telefon)</h3><p class="muted">Korábbi export ZIP(ek) beolvasása. Meglévő, frissebb adat nem íródik felül; minden ütközés naplózva.</p><button id="bRestore" style="width:100%">Export ZIP kiválasztása</button></div>`;
  $("#bInv").onclick = () => { const f = $("#jsonfile"); f.value = ""; f.onchange = () => f.files[0] && importInventory(f.files[0]); f.click(); };
  $("#view").querySelectorAll("[data-m]").forEach(b => b.onclick = async () => { await metaSet("defaultMode", b.dataset.m); renderSetup(); });
  $("#bSes").onclick = async () => {
    const name = $("#sName").value.trim(), permit = $("#sPermit").value.trim();
    if (!name || !permit) return alertBox("Hiányzó adat", `<p class="msg err">A felmérő neve és az engedély száma kötelező.</p>`);
    await metaSet("session", { name, permit, ts: now() });
    if (!(S.meta.persist && S.meta.persist.ok)) await requestPersist(true);
    renderSetup();
  };
  $("#bPersist").onclick = () => requestPersist(false);
  if ($("#bGo")) $("#bGo").onclick = () => go("home");
  $("#bOcr").onclick = async () => {
    const btn = $("#bOcr"), el = $("#ocrInfo"); btn.disabled = true;
    try {
      el.textContent = "Letöltés…"; const n = await ocrDownload();
      el.textContent = "Modellek betöltése a telefonon…"; const t0 = Date.now();
      await ocrCall({ cmd: "warm" }, [], p => { if (p.stage === "load") el.textContent = `Modellek betöltése (${p.i}/${p.n})…`; }, 120000);
      el.innerHTML = `<b>KÉSZ ✓</b> – offline is működik${n ? ` (most letöltve: ${n} fájl)` : ""} · betöltés ${((Date.now() - t0) / 1000).toFixed(1)} s`;
    } catch (e) { el.innerHTML = `<span class="msg err">Nem sikerült: ${esc(e.message || e)}</span> – térerőnél próbáld újra.`; }
    finally { btn.disabled = false; }
  };
  ocrMissing().then(m => { const el = $("#ocrInfo"); if (el && el.textContent === "Ellenőrzés…") el.innerHTML = !simdOk() ? `<span class="msg err">Ezen az iOS-verzión az offline felismerés nem fut (WebAssembly SIMD kell: iOS 16.4+).</span>` : m.length ? `<b>Nincs teljesen letöltve</b> (${m.length}/${OCR_FILES.length} fájl hiányzik) – koppints a gombra térerőnél.` : `<b>Letöltve ✓</b> – offline is működik. (A gomb a betöltést is kipróbálja.)`; });
  $("#bRestore").onclick = () => { const f = $("#zipfile"); f.value = ""; f.onchange = () => restoreFromZips([...f.files]); f.click(); };
  showPersist();
}
async function showPersist() {
  const el = $("#persistInfo"); if (!el) return;
  let p = false, est = {};
  try { p = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : {}; } catch (e) {}
  el.innerHTML = `Tartós tárolás: <b>${p ? "ENGEDÉLYEZVE ✓" : "nincs engedélyezve"}</b> · Használt: ${fmtBytes(est.usage)} / kvóta: ${fmtBytes(est.quota)}`;
}
async function requestPersist(quiet) {
  let ok = false; try { ok = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch (e) {}
  await metaSet("persist", { ok, ts: now() });
  if (!quiet || !ok) await alertBox("Tartós tárolás", ok ? `<p class="msg ok">Engedélyezve: a böngésző nem törli automatikusan az adatokat.</p>` :
    `<p class="msg warn">A böngésző nem adta meg. Telepítsd az appot a főképernyőre, és onnan indítva kérd újra. Addig is: exportálj szekrényenként.</p>`);
  showPersist(); updateBanner();
}
async function importInventory(file) {
  try {
    const body = JSON.parse(await file.text());
    const sha = body.sha256; delete body.sha256;
    const calc = await sha256(new TextEncoder().encode(L.canon(body)));
    if (!sha || calc !== sha) return alertBox("Sérült leltár", `<p class="msg err">Az ellenőrzőösszeg nem egyezik – a fájl sérült vagy módosított. Nem töltöttem be.</p>`);
    const prev = S.meta.inventory;
    if (prev && prev.sha !== sha && !(await confirmBox("Leltár frissítése", "Új leltárverzió. A már rögzített adatok és fotók megmaradnak (azonosító szerint).", "Frissítés", false))) return;
    await txDo(["devices", "meta", "journal"], "readwrite", t => {
      const st = t.objectStore("devices");
      for (const d of body.devices) st.put(d);
      t.objectStore("meta").put({ doc: body.doc, projekt: body.projekt, kiadas: body.kiadas, sha, count: body.devices.length, ts: now(), groups: body.groups, checks: body.checks }, "inventory");
      t.objectStore("journal").add({ ts: now(), tel: S.installId, dev: "*", why: "inventory", patch: { sha, count: body.devices.length } });
    });
    await loadAll(); await syncPairs(); renderSetup();
  } catch (e) { alertBox("Hiba", `<p class="msg err">${esc(e.message || e)}</p>`); }
}

/* ---------------- Kereső / lista ---------------- */
function renderHome() {
  const inv = S.meta.inventory;
  const eszk = S.vis.filter(d => d.tipus !== "SZEKRENY");
  const done = eszk.filter(d => (S.recs.get(d.id) || {}).status === "kesz").length;
  const started = eszk.filter(d => devStatus(d)[0] !== "new").length;
  const cabs = [...new Set(S.devs.map(d => d.szekreny))].sort();
  $("#view").innerHTML = `
  <div class="search"><div class="row" style="gap:8px"><input id="q" class="grow" type="search" inputmode="search" ${TXT_ATTR} aria-label="Keresés"
     placeholder="Keresés: tag, pl. LSHH 320 TSI, PIT220…" value="${esc(S.q)}"><button id="bScan" style="flex:0 0 auto" aria-label="Tervjel felismerése fotóról (offline)">📷 Tervjel</button></div>
   <div class="chips" id="chips"><span class="muted lbl">Állapot:</span>${[["all", "Mind"], ["new", "Nincs kezdve"], ["wip", "Folyamatban"], ["eval", "Értékelendő"], ["nok", "NOK"], ["done", "Kész"], ["cab", "Szekrények"], ["uj", "Leltáron kívüli"]]
      .map(([k, l]) => `<button class="chip ${S.filter === k ? "on" : ""}" data-f="${k}">${l} <b>${countFor(k)}</b></button>`).join("")}</div>
   <div class="chips" id="circ"><span class="muted lbl">Kör (dokumentáció):</span>${[["all", "Mind"], ["exi", "Ex i kör"], ["nonexi", "Nem Ex i kör"]]
      .map(([k, l]) => `<button class="chip ${S.circ === k ? "on" : ""}" data-c="${k}">${l}</button>`).join("")}</div>
   <select id="cab" aria-label="Szekrény / terület"><option value="">Minden szekrény / terület</option>${cabs.map(c => `<option ${S.cab === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
  <div class="row muted" style="justify-content:space-between"><span>Kész: <b>${done}</b> / ${eszk.length} · elkezdve: ${started}</span><span>${esc(inv.doc)}</span></div>
  <div class="progress"><div style="width:${eszk.length ? (100 * done / eszk.length).toFixed(1) : 0}%"></div></div>
  <ul class="list" id="res"></ul>
  <div class="bar"><button id="bNew">+ Leltáron kívüli</button><button id="bExp" class="primary">Export</button><button id="bSet" aria-label="Beállítás" style="flex:0 0 64px">⚙︎</button></div>`;
  const q = $("#q");
  q.oninput = () => { S.q = q.value; drawList(); };
  $("#bScan").onclick = () => pickOcrPhoto(ocrSearch);
  $("#chips").querySelectorAll("[data-f]").forEach(b => b.onclick = () => { S.filter = b.dataset.f; renderHome(); });
  $("#circ").querySelectorAll("[data-c]").forEach(b => b.onclick = () => { S.circ = b.dataset.c; renderHome(); });
  $("#cab").onchange = e => { S.cab = e.target.value; renderHome(); };
  $("#bNew").onclick = newDeviceForm; $("#bExp").onclick = () => go("export"); $("#bSet").onclick = () => go("setup");
  drawList();
}
function drawList() {
  let arr;
  const plain = !S.q.trim() && S.filter === "all" && !S.cab && S.circ === "all";
  if (S.q.trim()) arr = L.search(S.vis, S.index, S.q, 400).filter(passFilter).slice(0, 80);
  else if (plain) arr = [...new Set((S.meta.recent || []).map(primaryId))].map(id => S.byId.get(id)).filter(Boolean);
  else arr = S.vis.filter(passFilter).slice(0, 300);
  const head = plain ? `<li class="muted" style="padding:8px 0">Legutóbbiak – írj a keresőbe, vagy válassz szűrőt.</li>` : "";
  $("#res").innerHTML = head + (arr.length ? arr.map(d => { const [c, l] = devStatus(d); const pc = photosOf(d.id).filter(p => !p.deleted).length;
    const pt = partnerOf(d.id) ? S.byId.get(partnerOf(d.id)).tag : "", mk = S.q.trim() ? L.matchKind(S.index[S.vis.indexOf(d)], S.q) : "";
    return `<li class="item" data-id="${esc(d.id)}"><div class="grow"><div class="t">${esc(d.tag)}${mk === "pontos" ? ' <span class="mk ok">✓ pontos</span>' : mk === "ocr" ? ' <span class="mk ocr">≈ javított egyezés – ellenőrizd</span>' : ""}</div><div class="d">${pt ? `+ ${esc(pt)} · <b>egy tok</b>${pairConflict(d.id) ? " · <b>⚠ pár eltér</b>" : ""} · ` : ""}${esc(d.leiras)}${pt ? " / " + esc(S.byId.get(partnerOf(d.id)).leiras) : ""} · ${esc(d.szekreny)}${d.exi === "IGEN" ? " · <b>Ex i</b>" : ""}${pc ? ` · 📷 ${pc}` : ""}</div></div><span class="st ${c}">${esc(l)}</span></li>`; }).join("")
    : (S.q.trim() || !plain ? `<li class="muted" style="padding:12px 0">Nincs találat.${S.q.trim() ? " Ha az eszköz nincs a leltárban: <b>+ Leltáron kívüli</b>." : ""}</li>` : ""));
  $("#res").querySelectorAll("[data-id]").forEach(li => li.onclick = () => openDevice(li.dataset.id));
}
async function openDevice(id) {
  id = primaryId(id);
  const rec = (S.meta.recent || []).filter(x => x !== id); rec.unshift(id); await metaSet("recent", rec.slice(0, 30));
  S.cur = id; go("device");
}

/* ---------------- Eszköz-nézet ---------------- */
function segHtml(key, opts, val, cls) {
  return `<div class="seg ${esc(cls || "")}" data-k="${esc(key)}">${opts.map(o => { const c = val === o ? ("on " + (o === "OK" ? "OK" : o === "NOK" ? "NOK" : o === "N.A." ? "NA" : o === "NH" ? "NH" : "SEL")) : "";
    return `<button data-v="${esc(o)}" class="${c}" aria-pressed="${val === o}">${esc(o)}</button>`; }).join("")}</div>`;
}
function selHtml(key, opts, val, label) {
  return `<label class="f">${esc(label)}</label><select data-sel="${esc(key)}" aria-label="${esc(label)}"><option value="">—</option>${opts.map(o => `<option ${val === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
}
function freeUrls() { for (const u of S.urls) URL.revokeObjectURL(u); S.urls = []; }
function renderDevice(id) {
  freeUrls();
  if (isSecondary(id)) { id = primaryId(id); S.cur = id; }
  const d = S.byId.get(id); if (!d) return go("home");
  const pd = partnerOf(id) ? S.byId.get(partnerOf(id)) : null;
  const r = recOf(id), inv = S.meta.inventory, groups = Object.fromEntries(inv.groups.map(g => [g.key, g]));
  const ph = photosOf(id), ev = L.evaluate(r), isCab = d.tipus === "SZEKRENY";
  const gyors = r.mode === "gyors";
  const val = L.validate(d, r, ph, S.labels);
  const evc = v => v === "MEGFELEL" ? "M" : v === "NEM FELEL MEG" ? "N" : v === "TISZTÁZANDÓ" ? "T" : "";
  $("#view").innerHTML = `
  <button id="bBack" style="margin-bottom:8px">‹ Keresés</button>
  <h1>${esc(d.tag)}</h1>${pd ? `<div class="msg">Egy tok, egy eszköz: <b>${esc(pd.tag)}</b> (${esc(pd.id)}) – minden adat és fotó mindkét tételre vonatkozik.${pairConflict(id) ? `<br><b>⚠ Figyelem:</b> a két tag korábban eltérő adattal lett rögzítve. <button id="bPairFix">Eltérés feloldása…</button>` : ""}</div>` : ""}
  <div class="kv"><b>Azonosító</b><span>${esc(d.id)}</span><b>Leírás</b><span>${esc(d.leiras)}</span><b>Kategória</b><span>${esc(d.kat)}</span>
   <b>Szekrény</b><span>${esc(d.szekreny)}</span>${d.exi ? `<b>Ex i (rajz)</b><span>${esc(d.exi)}</span>` : ""}${d.kabel ? `<b>Kábel (rajz)</b><span>${esc(d.kabel)}</span>` : ""}
   ${d.rajz ? `<b>Rajz</b><span>${esc(d.rajz)} ${d.oldal ? "· o. " + esc(d.oldal) : ""}</span>` : ""}${d.tim ? `<b>TIM-rajz</b><span>${esc(d.tim)}</span>` : ""}
   ${d.hely ? `<b>Elhelyezés</b><span>${esc(d.hely)}</span>` : ""}${d.felho && d.felho !== "NEM" ? `<b>Rajz</b><span class="st wip">${esc(d.felho)}</span>` : ""}</div>
  <div class="seg" style="grid-template-columns:1fr 1fr;margin-top:12px" data-mode="1"><button data-v="reszletes" class="${!gyors ? "on SEL" : ""}">Részletes</button><button data-v="gyors" class="${gyors ? "on SEL" : ""}">Gyors (fotó)</button></div>

  <h2>Fotók (${ph.filter(p => !p.deleted).length})</h2>
  <div class="camgrid">${L.PHOTO_TYPES.map(t => `<button data-cam="${t.key}" class="${t.key === "ADATTABLA" ? "primary" : ""}">📷 ${esc(t.label)}</button>`).join("")}</div>
  <button id="bGal" style="width:100%;margin-top:8px">Fotó a galériából…</button>
  <div class="photos" id="photos"></div>

  ${gyors ? `<label class="f">Megjegyzés</label><textarea data-txt="megj" ${TXT_ATTR.replace('autocapitalize="characters"', 'autocapitalize="sentences"')}>${esc(r.megj || "")}</textarea>` : `
  <h2>Zóna (TIM-terv)</h2>
  <label class="f">Gázzóna</label>${segHtml("zg", L.LISTS.zg, r.zg, "z5")}
  <label class="f">Porzóna</label>${segHtml("zp", L.LISTS.zp, r.zp, "z5")}
  <div class="row" style="margin-top:8px"><button id="bOut" class="grow">Nem veszélyes tér (gáz + por)</button>${S.meta.lastTim ? `<button id="bTim" class="grow">TIM-értékek az előzőből</button>` : ""}</div>
  ${isCab ? "" : `
  <div class="row"><div class="grow">${selHtml("tg", L.LISTS.tg, r.tg, "TIM gázcsoport")}</div><div class="grow">${selHtml("tt", L.LISTS.tt, r.tt, "TIM T-osztály")}</div></div>
  <div class="row"><div class="grow">${selHtml("tp", L.LISTS.tp, r.tp, "TIM porcsoport")}</div><div class="grow"><label class="f">Por: megengedett max. °C</label><input type="text" inputmode="decimal" ${TXT_ATTR} data-txt="tmax" value="${esc(r.tmax || "")}"></div></div>
  <h2>Adattábla</h2>
  ${selHtml("mod", L.LISTS.mod, r.mod, "Védelmi mód")}
  <label class="f">Teljes Ex-jelölés (pl. II 2G Ex db IIB T4 Gb)</label><textarea data-txt="exj" rows="2" ${TXT_ATTR.replace('autocapitalize="characters"', 'autocapitalize="off"')}>${esc(r.exj || "")}</textarea>
  <div class="row" style="margin-top:6px"><button id="bExjScan" class="grow">📷 Adattábla-fotó → mezők</button><button id="bExjParse" class="grow primary">⇩ Mezők a jelölésből</button></div>
  <div class="row"><div class="grow">${selHtml("eg", L.LISTS.eg, r.eg, "EPL gáz / kat.")}</div><div class="grow">${selHtml("dg", L.LISTS.dg, r.dg, "Gázcsoport")}</div><div class="grow">${selHtml("dt", L.LISTS.dt, r.dt, "T-osztály")}</div></div>
  <div class="row"><div class="grow">${selHtml("ep", L.LISTS.ep, r.ep, "EPL por / kat.")}</div><div class="grow">${selHtml("dp", L.LISTS.dp, r.dp, "Porcsoport")}</div><div class="grow"><label class="f">Max. felületi °C (por)</label><input type="text" inputmode="decimal" ${TXT_ATTR} data-txt="dtc" value="${esc(r.dtc || "")}"></div></div>
  <label class="f">Tanúsítványszám</label><input type="text" data-txt="cert" ${TXT_ATTR} value="${esc(r.cert || "")}">
  <div class="row"><div class="grow"><label class="f">Gyártó / típus</label><input type="text" data-txt="gy" ${TXT_ATTR.replace('autocapitalize="characters"', 'autocapitalize="off"')} value="${esc(r.gy || "")}"></div><div style="width:110px"><label class="f">IP</label><input type="text" data-txt="ip" ${TXT_ATTR} value="${esc(r.ip || "")}"></div></div>
  <h3>Automatikus értékelés (60079-14:2025 Table 4 / 13 / 14)</h3>
  <div class="evalgrid"><div class="${evc(ev.fepl)}">EPL–zóna<br>${esc(ev.fepl || "—")}</div><div class="${evc(ev.fgr)}">Csoport<br>${esc(ev.fgr || "—")}</div><div class="${evc(ev.ft)}">Hőmérséklet<br>${esc(ev.ft || "—")}</div></div>`}
  <h2>Ellenőrzési csoportok (V+C)</h2>
  ${d.groups.map(k => `<div class="group"><div class="gl"><span>${esc(groups[k] ? groups[k].label : k)}</span><span class="row" style="gap:6px">${(r.res || {})[k] ? `<button class="info" data-clr="${esc(k)}" aria-label="Eredmény törlése">✕ törlés</button>` : ""}<button class="info" data-info="${esc(k)}">ⓘ mit nézek?</button></span></div>${segHtml("res." + k, L.LISTS.res, (r.res || {})[k])}</div>`).join("")}
  <button id="bAllOk" style="width:100%;margin-top:6px">Hátralévő csoportok = OK…</button>
  <label class="f">Megjegyzés / észlelés</label><textarea data-txt="megj" ${TXT_ATTR.replace('autocapitalize="characters"', 'autocapitalize="sentences"')}>${esc(r.megj || "")}</textarea>`}
  <div id="valid">${val.errors.length && r.status !== "uj" ? `<div class="msg warn"><b>A „Kész”-hez még hiányzik:</b><br>${val.errors.map(esc).join("<br>")}</div>` : ""}
   ${val.warnings.map(w => `<div class="msg warn">${esc(w)}</div>`).join("")}</div>
  <p class="muted">Állapot: <b>${esc(devStatus(d)[1])}</b> · rev. ${esc(r.rev || 0)}${r.updated ? " · " + esc(new Date(r.updated).toLocaleString("hu-HU")) : ""}${r.by ? " · " + esc(r.by) : ""}</p>
  <div class="bar"><button id="bBack2">‹ Keresés</button><button id="bDone" class="primary">${gyors ? "Kész → értékelendő" : "Kész"}</button></div>`;
  drawPhotos(id);
  if ($("#bPairFix")) $("#bPairFix").onclick = async () => {
    await flushPending(); await S.saveChain;
    const pid = partnerOf(id), a = S.recs.get(id), b2 = S.recs.get(pid), df = pairDiff(a, b2);
    const fmt = v => v === undefined || v === null || v === "" ? '<span class="muted">—</span>' : esc(typeof v === "object" ? JSON.stringify(v) : v);
    modal(`<h2>ZSO/ZSC eltérés</h2><p class="muted">Válaszd ki, melyik tag adatai legyenek érvényesek mindkettőre. A felülírt érték a naplóban megmarad.</p>
      <table class="pf"><tr><th>Mező</th><th>${esc(d.tag)}</th><th>${esc(pd.tag)}</th></tr>${df.map(([k, x, y]) => `<tr><td>${esc(k)}</td><td>${fmt(x)}</td><td>${fmt(y)}</td></tr>`).join("")}</table>
      <button id="pfA" class="primary" style="width:100%;margin-top:10px">${esc(d.tag)} adatai érvényesek</button>
      <button id="pfB" style="width:100%;margin-top:6px">${esc(pd.tag)} adatai érvényesek</button>
      <button id="mNo" style="width:100%;margin-top:6px">Mégse</button>`, bx => {
      bx.querySelector("#mNo").onclick = closeModal;
      const run = (src, dst) => { closeModal(); const job = S.saveChain.then(() => copyPair(src, dst, "pair-fix")); S.saveChain = job.catch(() => {}); job.then(() => renderDevice(id), e => alertBox("Mentési hiba", `<p class="msg err">${esc(e.message || e)}</p>`)); };
      bx.querySelector("#pfA").onclick = () => run(id, pid); bx.querySelector("#pfB").onclick = () => run(pid, id);
    });
  };
  const back = async () => { await flushPending(); freeUrls(); go("home"); };
  $("#bBack").onclick = back; $("#bBack2").onclick = back;
  $("#view").querySelectorAll("[data-cam]").forEach(b => b.onclick = () => pickPhoto(id, b.dataset.cam, "#camera"));
  $("#bGal").onclick = () => chooseTypeThen(t => pickPhoto(id, t, "#gallery"));
  $("#view").querySelector("[data-mode]").querySelectorAll("button").forEach(b => b.onclick = async () => { if (b.dataset.v !== recOf(id).mode) { await flushPending(); await saveRecord(id, { mode: b.dataset.v }, "mode"); renderDevice(id); } });
  // Szegmensgombok: az aktív gomb újbóli koppintása NEM törli az értéket (véletlen dupla koppintás elleni védelem).
  $("#view").querySelectorAll(".seg[data-k]").forEach(sg => sg.querySelectorAll("button").forEach(b => b.onclick = async () => {
    await flushPending(); const k = sg.dataset.k, v = b.dataset.v, cur = recOf(id);
    if (k.startsWith("res.")) { const g = k.slice(4); if ((cur.res || {})[g] === v) return; await saveRecord(id, { res: { [g]: v } }, "res"); }
    else { if (cur[k] === v) return; await saveRecord(id, { [k]: v }, "field"); }
    renderDevice(id);
  }));
  $("#view").querySelectorAll("[data-clr]").forEach(b => b.onclick = async () => { await flushPending(); await saveRecord(id, { res: { [b.dataset.clr]: "" } }, "res-clear"); renderDevice(id); });
  $("#view").querySelectorAll("select[data-sel]").forEach(se => se.onchange = async () => { await flushPending(); await saveRecord(id, { [se.dataset.sel]: se.value }, "field"); renderDevice(id); });
  $("#view").querySelectorAll("[data-txt]").forEach(inp => { inp.oninput = () => queueText(id, inp.dataset.txt, inp.value); inp.onblur = async () => { await flushPending(); if (["tmax", "dtc"].includes(inp.dataset.txt)) renderDevice(id); }; });
  $("#view").querySelectorAll("[data-info]").forEach(b => b.onclick = () => showInfo(b.dataset.info));
  if ($("#bExjScan")) $("#bExjScan").onclick = () => pickOcrPhoto(f => ocrPlate(id, f));   // szinkron: iOS csak felhasználói gesztusból nyit fájlválasztót (az ocrPlate maga flush-ol)
  if ($("#bExjParse")) $("#bExjParse").onclick = async () => { await flushPending(); proposeFields(id); };
  if ($("#bOut")) $("#bOut").onclick = async () => { await flushPending(); await saveRecord(id, { zg: "Nincs", zp: "Nincs" }, "outside"); renderDevice(id); };
  if ($("#bAllOk")) $("#bAllOk").onclick = async () => {
    await flushPending(); const cur = recOf(id); const rest = d.groups.filter(g => !(cur.res || {})[g]);
    if (!rest.length) return alertBox("Nincs hátralévő", "Minden csoport ki van töltve.");
    const names = rest.map(g => esc(groups[g] ? groups[g].label : g)).join("<br>");
    if (!(await confirmBox("Hátralévő csoportok = OK", `Ezek a csoportok <b>OK</b> eredményt kapnak – csak akkor erősítsd meg, ha mindegyiket ténylegesen ellenőrizted:<br><br>${names}`, "Mind ellenőriztem – OK", false))) return;
    await saveRecord(id, { res: Object.fromEntries(rest.map(g => [g, "OK"])) }, "all-ok"); renderDevice(id);
  };
  if ($("#bTim")) $("#bTim").onclick = async () => { await flushPending(); const lt = S.meta.lastTim || {}; const p = {}; for (const k of (isCab ? ["zg", "zp"] : ["zg", "zp", "tg", "tp", "tt", "tmax"])) if (lt[k] !== undefined) p[k] = lt[k]; await saveRecord(id, p, "tim-copy"); renderDevice(id); };
  $("#bDone").onclick = async () => {
    await flushPending(); const cur = recOf(id); const v = L.validate(d, cur, photosOf(id), S.labels);
    if (!v.ok) return alertBox("Még nem kész", `<div class="msg err">${v.errors.map(esc).join("<br>")}</div>`);
    if (v.warnings.length && !(await confirmBox("Figyelmeztetés", v.warnings.map(esc).join("<br>") + "<br><br>Így is lezárod?", "Lezárom", false))) return;
    await saveRecord(id, { status: cur.mode === "gyors" ? "ertekelendo" : "kesz" }, "done"); freeUrls(); go("home");
  };
}
const PF = [["mod", "Védelmi mód"], ["eg", "EPL gáz / kat."], ["dg", "Gázcsoport"], ["dt", "T-osztály"], ["ep", "EPL por / kat."], ["dp", "Porcsoport"], ["dtc", "Max. felületi °C (por)"], ["ip", "IP"], ["cert", "Tanúsítványszám"]];
function proposeFields(id, ocr) {
  const cur = recOf(id), txt = ocr ? String(ocr.text || "").trim() : String(cur.exj || "").trim();
  if (!txt) return alertBox(ocr ? "Nem olvasható szöveg" : "Nincs jelölés", ocr ? `<p class="msg warn">A fotón nem találtam olvasható szöveget.</p><p class="muted">A fotó mentve. Tipp: közelebbről, élesen, tükröződés nélkül, az adattáblára merőlegesen.</p>`
    : `<p class="msg warn">Előbb írd be a teljes Ex-jelölést a „Teljes Ex-jelölés” mezőbe, vagy használd a „📷 Adattábla-fotó → mezők” gombot.</p>`);
  const pr = L.proposeFromMarking(txt);
  if (ocr) { const ex = exLines(ocr.lines || []).join("\n"); if (ex && ex !== String(cur.exj || "").trim()) pr.fields.exj = ex; }
  const rows = PF.concat(ocr ? [["exj", "Teljes Ex-jelölés"]] : []).filter(([k]) => pr.fields[k] !== undefined).map(([k, lab]) => {
    const now_ = String(cur[k] || ""), nw = pr.fields[k], same = now_ === nw;
    return `<tr><td>${esc(lab)}</td><td>${now_ ? esc(now_) : '<span class="muted">—</span>'}</td><td><b>${esc(nw)}</b>${same ? ' <span class="mk ok">egyezik</span>' : now_ ? ' <span class="mk ocr">eltér</span>' : ""}</td>
      <td>${same ? "" : `<input type="checkbox" data-pf="${esc(k)}" ${now_ ? "" : "checked"} aria-label="${esc(lab)} átvétele">`}</td></tr>`; }).join("");
  const shown = ocr ? `<details><summary>Felismert szöveg (${(ocr.lines || []).length} sor)</summary><pre class="mono" style="white-space:pre-wrap;word-break:break-word">${esc(txt)}</pre></details>` : `<p class="muted" style="word-break:break-word">„${esc(txt)}”</p>`;
  if (!rows) return alertBox("Nincs javaslat", `<p class="msg warn">A szövegből nem olvasható ki mező.</p>${ocr ? "<p class=\"muted\">A fotó mentve (ADATTABLA). Tipp: közelebbről, élesen, merőlegesen; az Ex-jelölés sora legyen a kép közepén.</p>" + shown : ""}${pr.notes.map(n => `<p class="muted">${esc(n)}</p>`).join("")}`);
  modal(`<h2>${ocr ? "Javaslat az adattábla-fotóból" : "Javaslat a jelölésből"}</h2>${shown}${ocr && ocr.reduced ? `<p class="msg warn">Memóriakímélő (kisebb felbontású) felismerés futott – fokozottan ellenőrizd.</p>` : ""}
    <table class="pf"><tr><th>Mező</th><th>Most</th><th>Javaslat</th><th>Átvesz</th></tr>${rows}</table>
    ${pr.notes.map(n => `<p class="msg warn" style="margin:4px 0">${esc(n)}</p>`).join("")}
    <p class="muted">A javaslat a beolvasott szövegből készül – <b>a táblával összevetve</b> hagyd jóvá. Eltérő meglévő érték alapból NEM íródik felül.</p>
    <div class="row" style="margin-top:10px"><button id="mNo" class="grow">Mégse</button><button id="mYes" class="grow primary">Kijelöltek átvétele</button></div>`, b => {
    b.querySelector("#mNo").onclick = closeModal;
    b.querySelector("#mYes").onclick = async () => {
      const patch = {}; b.querySelectorAll("[data-pf]").forEach(c => { if (c.checked) patch[c.dataset.pf] = pr.fields[c.dataset.pf]; });
      closeModal();
      if (Object.keys(patch).length) { await saveRecord(id, patch, ocr ? "ocr-foto" + (ocr.pid ? ":" + ocr.pid : "") : "ocr-parse"); renderDevice(id); }
    };
  });
}
function chooseTypeThen(fn) {
  modal(`<h2>Fotó típusa</h2>${L.PHOTO_TYPES.map(t => `<button data-t="${t.key}" style="width:100%;margin:4px 0">${esc(t.label)}</button>`).join("")}<button id="mNo" style="width:100%;margin-top:8px">Mégse</button>`,
    b => { b.querySelectorAll("[data-t]").forEach(x => x.onclick = () => { closeModal(); fn(x.dataset.t); }); b.querySelector("#mNo").onclick = closeModal; }, closeModal);
}
function pickPhoto(id, type, sel) {
  const inp = $(sel); inp.value = "";
  try { localStorage.setItem(LSP + "capturing", JSON.stringify({ dev: id, type, ts: Date.now() })); } catch (e) {}
  const clear = () => { try { localStorage.removeItem(LSP + "capturing"); } catch (e) {} };
  inp.oncancel = clear;
  inp.onchange = async () => { const files = [...inp.files]; try { if (files.length) await addPhotos(id, type, files); } finally { clear(); } renderDevice(id); };
  inp.click();
}
async function drawPhotos(id) {
  const box = $("#photos"); if (!box) return; box.innerHTML = "";
  for (const m of photosOf(id)) {
    let b = await toBuf(await getOne("thumbs", m.pid));
    let type = "image/jpeg";
    if (!b) { b = await toBuf(await getOne("photoblob", m.pid)); type = m.mime || type; }
    if (!b || S.cur !== id) continue;
    const url = URL.createObjectURL(new Blob([b], { type })); S.urls.push(url);
    const el = document.createElement("div"); el.className = "ph" + (m.deleted ? " del" : "");
    el.innerHTML = `<img src="${url}" alt="${esc(m.type)} ${esc(m.n)}" loading="lazy"><span class="b">${esc(m.type)} #${esc(m.n)}</span>${m.verified ? '<span class="v">✓</span>' : '<span class="v x">!</span>'}`;
    el.onclick = () => showPhoto(m.pid); box.appendChild(el);
  }
}
function showInfo(gk) {
  const inv = S.meta.inventory, g = inv.groups.find(x => x.key === gk);
  modal(`<h2>${esc(g.label)}</h2>${g.chk.map(c => { const k = inv.checks[c]; return `<div class="card"><b>${esc(c)}</b> · ${esc(k.fok)}<br>${esc(k.tetel)}<br><span class="muted">Feltétel: ${esc(k.felt)}</span>
    <p><b>Kritérium:</b> ${esc(k.krit)}</p><p><b>Érték / távolság:</b> ${esc(k.ertek)}</p><p class="muted">${esc(k.forras)}</p></div>`; }).join("")}
    <button id="mOk" class="primary" style="width:100%">Bezár</button>`, b => b.querySelector("#mOk").onclick = closeModal, closeModal);
}
function newDeviceForm() {
  const cabs = [...new Set(S.devs.map(d => d.szekreny))].sort();
  modal(`<h2>Leltáron kívüli eszköz</h2><p class="muted">A helyszínen talált, a rajzokon nem szereplő eszköz.</p>
   <label class="f" for="nTag">Tag / felirat a helyszínen *</label><input id="nTag" type="text" ${TXT_ATTR}>
   <label class="f" for="nDesc">Leírás *</label><input id="nDesc" type="text" autocomplete="off">
   <label class="f" for="nCab">Szekrény / terület</label><select id="nCab"><option value="">(nem ismert)</option>${cabs.map(c => `<option>${esc(c)}</option>`).join("")}</select>
   <label class="f" for="nExi">Ex i kör?</label><select id="nExi"><option>NINCS ADAT</option><option>IGEN</option><option>NEM</option></select>
   <label class="f" for="nMot">Motor?</label><select id="nMot"><option>NEM</option><option>IGEN</option></select>
   <div id="nErr"></div>
   <div class="row" style="margin-top:12px"><button id="mNo" class="grow">Mégse</button><button id="mYes" class="grow primary">Létrehozás</button></div>`, b => {
    b.querySelector("#mNo").onclick = closeModal;
    const yesBtn = b.querySelector("#mYes");
    yesBtn.onclick = async () => {
      const tag = b.querySelector("#nTag").value.trim(), desc = b.querySelector("#nDesc").value.trim();
      if (!tag || !desc) { b.querySelector("#nErr").innerHTML = `<p class="msg err">A tag és a leírás kötelező.</p>`; return; }
      yesBtn.disabled = true;
      const n = S.devs.filter(d => d.tipus === "UJ").length + 1;
      const exi = b.querySelector("#nExi").value, mot = b.querySelector("#nMot").value;
      const groups = ["azon", "jelol", "eplgrt", "burk", "bevez", "kabel", "eph"].concat(exi !== "NEM" ? ["exi"] : [], mot === "IGEN" ? ["motor"] : [], ["mod"]);
      const d = { id: `UJ-${String(n).padStart(3, "0")}-${uuid().slice(0, 4).toUpperCase()}`, tag, leiras: desc, kat: "Leltáron kívüli", szekreny: b.querySelector("#nCab").value || "(nem ismert)",
                  rajz: "", oldal: "", exi, motor: mot, vfd: "NINCS ADAT", kabel: "", tim: "", felho: "", groups, tipus: "UJ", created: now(), by: (S.meta.session || {}).name, tel: S.installId };
      try {
        await txDo(["devices", "journal"], "readwrite", t => { t.objectStore("devices").put(d); t.objectStore("journal").add({ ts: now(), by: d.by, tel: S.installId, dev: d.id, why: "device-new", patch: d }); });
        S.devs.push(d); rebuildIndex(); closeModal(); openDevice(d.id);
      } catch (e) { yesBtn.disabled = false; b.querySelector("#nErr").innerHTML = `<p class="msg err">Mentési hiba: ${esc(e.message || e)}</p>`; }
    };
  });
}

/* ---------------- Export (kétlépéses: ZIP elkészítése → a megosztás felhasználói koppintásra indul) ---------------- */
function unexported() { return [...S.pmeta.values()].filter(p => !p.exported.length); }
function renderExport() {
  freeUrls();
  const un = unexported(), all = [...S.pmeta.values()];
  const unB = un.reduce((a, p) => a + p.bytes, 0), allB = all.reduce((a, p) => a + p.bytes, 0);
  const ex = S.meta.exports || [];
  const fr = S.meta.fullRun && S.meta.fullRun.id ? S.meta.fullRun : null, frLeft = fr ? (dn => all.filter(p => !dn.has(p.pid)).length)(new Set(fr.done)) : 0;
  $("#view").innerHTML = `<button id="bBack" style="margin-bottom:8px">‹ Keresés</button><h1>Mentés / export</h1>
  <div class="card"><div class="kv"><b>Fotók összesen</b><span>${all.length} db · ${fmtBytes(allB)}</span><b>Még nem exportált</b><span><b>${un.length} db · ${fmtBytes(unB)}</b></span>
    <b>Rögzített eszközök</b><span>${[...S.recs.values()].filter(r => r.status !== "uj").length}</span><b>Utolsó export</b><span>${S.meta.lastExport ? esc(new Date(S.meta.lastExport.ts).toLocaleString("hu-HU")) : "még nem volt"}</span>
    <b>Telefon</b><span>${esc(S.installId)}</span></div>
    <p id="persistInfo" class="muted"></p></div>
  <button id="bInc" class="primary" style="width:100%;margin:6px 0">Növekményes export (új fotók + minden adat)</button>
  ${fr ? `<p class="msg warn">Teljes export folyamatban: még ${frLeft} fotó van hátra.</p>` : ""}
  <button id="bFull" style="width:100%;margin:6px 0">${fr ? "Teljes export folytatása" : "Teljes export (minden fotó + minden adat)"}</button>
  ${fr ? `<button id="bFullReset" style="width:100%;margin:6px 0">Teljes export elölről</button>` : ""}
  <p class="muted">Minden ZIP tartalmazza a teljes adatállományt (data.json, CSV, napló) és a fotók SHA-256 listáját; legfeljebb ${fmtBytes(PART_LIMIT)}-os részekre bomlik.
   Az összes rész <b>egyetlen AirDrop-pal</b> megy át (egy körben legfeljebb ${fmtBytes(batchLimit())} fotó; ha több van, az app körönként halad, szükség esetén adatmentés után újraindul). A fotók csak a megerősítés után számítanak exportáltnak – az app SOHA nem törli őket.</p>
  <h3>Korábbi exportok</h3>${ex.length ? `<ul class="list">${ex.slice().reverse().map(e => `<li class="item"><div class="grow"><div class="t" style="font-size:14px">${esc(e.name)}</div><div class="d">${esc(new Date(e.ts).toLocaleString("hu-HU"))} · ${esc(e.photos)} fotó · ${esc(e.confirmed ? "megerősítve ✓" : "NEM megerősített")}</div></div></li>`).join("")}</ul>` : `<p class="muted">Nincs.</p>`}`;
  $("#bBack").onclick = () => go("home");
  const run = full => { const bs = ["#bInc", "#bFull", "#bFullReset"].map(q => $(q)).filter(Boolean); bs.forEach(b => b.disabled = true); doExport(full).finally(() => bs.forEach(b => { if (b.isConnected) b.disabled = false; })); };
  $("#bInc").onclick = () => run(false); $("#bFull").onclick = () => run(true);
  if ($("#bFullReset")) $("#bFullReset").onclick = async () => { if (await confirmBox("Teljes export elölről", "A félbehagyott teljes export állapota törlődik, és a következő teljes export újra minden fotót tartalmaz. Adat és fotó nem törlődik. Folytatod?", "Elölről")) { await metaSet("fullRun", null); renderExport(); } };
  showPersist();
}
function csvEsc(v) { v = String(v === undefined || v === null ? "" : v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function recordsCsv() {
  const inv = S.meta.inventory; const gk = inv.groups.map(g => g.key);
  const cols = ["id", "tag", "szekreny", "tipus", "mode", "status", "zg", "zp", "tg", "tp", "tt", "tmax", "mod", "exj", "eg", "ep", "dg", "dp", "dt", "dtc", "cert", "gy", "ip", "eval_epl", "eval_csoport", "eval_hom"].concat(gk.map(k => "res_" + k), ["megj", "fotok", "rev", "updated", "by", "tel"]);
  const lines = [cols.join(";")];
  for (const d of S.devs) { const r = S.recs.get(d.id); if (!r && !photosOf(d.id).length) continue; const rr = r || {}; const ev = L.evaluate(rr);
    lines.push([d.id, d.tag, d.szekreny, d.tipus, rr.mode, rr.status, rr.zg, rr.zp, rr.tg, rr.tp, rr.tt, rr.tmax, rr.mod, rr.exj, rr.eg, rr.ep, rr.dg, rr.dp, rr.dt, rr.dtc, rr.cert, rr.gy, rr.ip, ev.fepl, ev.fgr, ev.ft]
      .concat(gk.map(k => (rr.res || {})[k] || ""), [rr.megj, photosOf(d.id).filter(p => !p.deleted).length, rr.rev, rr.updated, rr.by, rr.tel]).map(csvEsc).join(";")); }
  return "﻿" + lines.join("\r\n");
}
function photoExt(m) { if (!m.orig) return "jpg"; const t = (m.mime || "").split("/")[1] || "bin"; return t.replace(/[^a-z0-9]/gi, "").slice(0, 5) || "bin"; }
function photoPath(m) {
  const d = S.byId.get(m.dev) || { szekreny: "ISMERETLEN", tag: m.dev };
  return `${m.deleted ? "fotok_TOROLT" : "fotok"}/${L.safeName(d.szekreny)}/${L.safeName(m.dev)}_${L.safeName(d.tag)}/${m.type}_${String(m.n).padStart(2, "0")}_${m.pid.slice(0, 8)}.${photoExt(m)}`;
}
async function buildPart(parts, i, exportId, full, journal) {
  const name = `ICCS-2656-EXC-013_felmeres_${exportId}_${S.installId}_${full ? "teljes" : "novekmeny"}_${i + 1}of${parts.length}.zip`;
  const zip = new JSZip(); const manifest = [];
  for (const p of parts[i]) {
    const b = await toBuf(await getOne("photoblob", p.pid));
    if (!b) { manifest.push({ pid: p.pid, error: "BLOB HIÁNYZIK" }); continue; }
    const sha = await sha256(b), path = photoPath(p);
    manifest.push({ path, pid: p.pid, dev: p.dev, type: p.type, n: p.n, sha256: sha, sha_at_capture: p.sha, match: sha === p.sha, bytes: b.byteLength, ts: p.ts, deleted: p.deleted });
    zip.file(path, b, { binary: true, compression: "STORE", date: new Date(p.ts) });
  }
  const data = { app: APP_VERSION, exportId, part: i + 1, parts: parts.length, full, ts: now(), tel: S.installId, session: S.meta.session,
                 inventory: { doc: S.meta.inventory.doc, sha: S.meta.inventory.sha }, devicesNew: S.devs.filter(d => d.tipus === "UJ"),
                 records: [...S.recs.values()], photos: [...S.pmeta.values()].map(p => Object.assign({}, p, { path: photoPath(p) })), journal };
  const dataTxt = JSON.stringify(data); const dataSha = await sha256(new TextEncoder().encode(dataTxt));
  zip.file("data.json", dataTxt); zip.file("records.csv", recordsCsv());
  zip.file("manifest.json", JSON.stringify({ exportId, tel: S.installId, part: i + 1, parts: parts.length, data_sha256: dataSha, photos: manifest }, null, 1));
  zip.file("OLVASSEL.txt", `ICCS-2656-EXC-013 terepi export\r\nExport: ${exportId}, ${i + 1}/${parts.length} rész, ${full ? "teljes" : "növekményes"}\r\nTelefon: ${S.installId}\r\nFelmérő: ${(S.meta.session || {}).name}\r\nEngedély: ${(S.meta.session || {}).permit}\r\nFotók ebben a részben: ${parts[i].length}\r\nEllenőrzés: műhely-importáló (SHA-256).\r\n`);
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE", mimeType: "application/zip" });
  // Önellenőrzés: a kész ZIP visszaolvasása, minden fotó hash-e
  const chk = await JSZip.loadAsync(blob); let bad = 0;
  for (const m of manifest) { if (!m.path) { bad++; continue; } const f = chk.file(m.path); if (!f) { bad++; continue; } if ((await sha256(await f.async("arraybuffer"))) !== m.sha256) bad++; }
  if ((await sha256(new TextEncoder().encode(await chk.file("data.json").async("string")))) !== dataSha) bad++;
  return { name, blob, bad: bad + manifest.filter(m => !m.match).length, count: parts[i].length };
}
/* Egyetlen megosztás = egyetlen AirDrop az összes részzel.
   Ok: iOS-en (főképernyős web-app) AirDrop után a share() ígérete gyakran SOSEM teljesül, és amíg függ, az iOS
   új share()-t nem enged (InvalidStateError) – ezért részenkénti megosztás nem megbízható. Megoldás: (1) egy körben
   minden rész EGY share()-hívással megy; (2) egy kör mérete BATCH_LIMIT-re korlátozott (memória); (3) ha a kör
   végén a megosztás még függ, és van következő kör, az app adatmentés után újratölt (ez zárja le az iOS-megosztást). */
let lastShare = null;   // { settled: bool } – a legutóbbi share() állapota
function shareHung() { return !!(lastShare && !lastShare.settled); }
function shareAll(built, round) {
  return new Promise(res => {
    const files = built.map(p => new File([p.blob], p.name, { type: "application/zip" }));
    const n = files.length, nPh = built.reduce((a, p) => a + p.count, 0), tot = built.reduce((a, p) => a + p.blob.size, 0);
    let can = false; try { can = !!(navigator.canShare && navigator.canShare({ files })); } catch (e) { can = false; }
    const list = built.map((p, i) => `<li class="item"><div class="grow"><div class="t" style="font-size:13px;word-break:break-all">${esc(p.name)}</div><div class="d">${p.count} fotó · ${fmtBytes(p.blob.size)} · önellenőrzés ✓</div></div><button data-dl="${i}" style="flex:0 0 auto">Letöltés</button></li>`).join("");
    modal(`<h2>ZIP-ek készen – küldés${round.multi ? ` – ${round.k}. kör` : ""}</h2>${round.leftAfter ? `<p class="muted">Ez után még ${round.leftAfter} fotó következik a következő kör(ök)ben.</p>` : ""}
      <p><b>${n} fájl</b> · ${nPh} fotó · ${fmtBytes(tot)}</p>
      ${can ? `<button id="xShare" class="primary" style="width:100%;margin:6px 0">AirDrop / Megosztás – mind a(z) ${n} fájl egyszerre</button>` : `<p class="msg warn">Ez a készülék nem tudja egyszerre megosztani a fájlokat – töltsd le mindet (Fájlok › Letöltések), és onnan küldd AirDroppal.</p>`}
      <details ${can ? "" : "open"}><summary class="muted">Tartalék: letöltés fájlonként</summary><ul class="list">${list}</ul></details>
      <div id="xMsg"></div>
      <button id="xDone" class="primary" style="width:100%;margin-top:10px" disabled>Elmentettem – mind a(z) ${n} fájl megérkezett</button>
      <button id="xCancel" style="width:100%;margin-top:6px">Megszakítás (nem számít exportnak)</button>`, b => {
      const done = b.querySelector("#xDone"), msg = b.querySelector("#xMsg");
      const names = built.map(p => esc(p.name)).join("<br>");
      const chk = `Ellenőrizd a Macen (Letöltések), hogy mind a(z) ${n} fájl megérkezett:<br><span class="muted" style="font-size:12px;word-break:break-all">${names}</span><br>Ha igen: „Elmentettem”.`;
      let opened = false; const dl = new Set();
      const allow = () => { done.disabled = !(opened || dl.size === n); };
      if (b.querySelector("#xShare")) b.querySelector("#xShare").onclick = () => {
        if (shareHung()) { reloadOffer(msg, res); return; }
        let p; const st = { settled: false };
        try { p = navigator.share({ files, title: `Ex-felmérés export (${n} fájl)` }); }
        catch (e) { if (e && e.name === "InvalidStateError") { lastShare = { settled: false }; reloadOffer(msg, res); return; } msg.innerHTML = `<p class="msg warn">A megosztás nem indult el: ${esc(e && e.message || e)}. Használd a fájlonkénti letöltést.</p>`; return; }
        lastShare = st; msg.innerHTML = `<p class="msg">${chk}</p>`;
        const tmr = setTimeout(() => { if (!st.settled) { opened = true; allow(); } }, 700);
        Promise.resolve(p)
          .then(() => { st.settled = true; clearTimeout(tmr); opened = true; allow(); msg.innerHTML = `<p class="msg ok">Megosztva. ${chk}</p>`; })
          .catch(e => {
            st.settled = true; clearTimeout(tmr);
            if (e && e.name === "AbortError") { opened = true; allow(); msg.innerHTML = `<p class="msg warn">Az iOS „megszakítva” jelzést adott – AirDrop után ez akkor is előfordul, ha a fájlok átmentek. ${chk} Ha nincsenek ott: koppints újra az AirDrop gombra.</p>`; }
            else if (e && e.name === "InvalidStateError") { st.settled = false; lastShare = st; allow(); reloadOffer(msg, res); }
            else { allow(); msg.innerHTML = `<p class="msg warn">A megosztás nem sikerült: ${esc(e && e.message || e)}. Próbáld újra, vagy használd a fájlonkénti letöltést.</p>`; }
          });
      };
      b.querySelectorAll("[data-dl]").forEach(btn => btn.onclick = () => {
        const i = +btn.dataset.dl, a = document.createElement("a"), u = URL.createObjectURL(built[i].blob);
        a.href = u; a.download = built[i].name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 120000);
        dl.add(i); btn.textContent = "Letöltve ✓"; allow();
        msg.innerHTML = `<p class="msg warn">Letöltve: ${dl.size}/${n}. ${dl.size === n ? "Ellenőrizd a Fájlok › Letöltések mappát, majd küldd onnan AirDroppal (több fájl kijelölhető), utána „Elmentettem”." : "Töltsd le a többit is."}</p>`;
      });
      done.onclick = () => { closeModal(); res({ ok: true }); };
      b.querySelector("#xCancel").onclick = () => { closeModal(); res({ ok: false }); };
    });
  });
}
function reloadOffer(msg, res) {
  msg.innerHTML = `<p class="msg warn">Az iOS még nem zárta le egy korábbi megosztást, ezért most nem nyílik meg az AirDrop. Megoldás: az app elmenti az adatokat és újraindul, utána indítsd újra az exportot – a fotók biztonságban vannak, semmi nem vész el.</p>
    <button id="xReload" class="primary" style="width:100%;margin-top:6px">Újraindítás most</button>`;
  msg.querySelector("#xReload").onclick = () => { closeModal(); res({ ok: false, reload: true }); };
}
async function safeReload(text) {
  await alertBox("Újraindítás", `<p class="msg">${text}</p>`);
  await flushPending(); await S.saveChain; location.reload();
}
// Kör-limit: alapból BATCH_LIMIT; ha egy korábbi export építése közben az app összeomlott (memória), a limit feleződik (min. 1 rész).
function batchLimit() { return (typeof window !== "undefined" && window.__EXF_BATCH_LIMIT) || S.meta.batchLimit || BATCH_LIMIT; }
function selectBatch(cands) {
  const out = []; let sz = 0;
  for (const p of cands) { if (out.length && sz + p.bytes > batchLimit()) break; out.push(p); sz += p.bytes; }
  return out;
}
async function checkExportCrash() {
  // Az előző export ZIP-építése nem jutott el a küldő ablakig (pl. iOS memória miatti újraindítás) → kisebb körök.
  const at = S.meta.exportAttempt; if (!at) return;
  const nl = Math.max(PART_LIMIT, Math.floor((S.meta.batchLimit || BATCH_LIMIT) / 2));
  await metaSet("batchLimit", nl); await metaSet("exportAttempt", null);
  await alertBox("Export újraindítás után", `<p class="msg warn">Az előző export elkészítése közben az app újraindult (valószínűleg memóriahiány). Adat nem veszett el, semmi nem kapott „exportált” jelölést. Az export mostantól kisebb körökben megy (${fmtBytes(nl)} / kör) – indítsd újra.</p>`);
}
async function doExport(full) {
  ocrKill("export/visszaállítás – memória felszabadítása");
  await flushPending();
  let reload = null;
  try { await busy(async () => {
    const byTs = arr => arr.sort((a, b) => a.ts < b.ts ? -1 : 1);
    if (full && !(S.meta.fullRun && S.meta.fullRun.id)) await metaSet("fullRun", { id: stamp(), done: [], k: 0 });
    const cands = () => { if (!full) return byTs(unexported()); if (!S.meta.fullRun) return []; const dn = new Set(S.meta.fullRun.done); return byTs([...S.pmeta.values()].filter(p => !dn.has(p.pid))); };
    for (let k = 1; ; k++) {
      const sel = selectBatch(cands()), leftAfter = cands().length - sel.length;
      const parts = []; let cur = [], sz = 0;
      for (const p of sel) { if (cur.length && sz + p.bytes > PART_LIMIT) { parts.push(cur); cur = []; sz = 0; } cur.push(p); sz += p.bytes; }
      if (cur.length || !parts.length) parts.push(cur);
      const exportId = stamp(), journal = await getAllFix("journal"), built = [];
      await metaSet("exportAttempt", { ts: now(), photos: sel.length });
      for (let i = 0; i < parts.length; i++) {
        setSave("busy", `Export ${i + 1}/${parts.length} készül…`);
        let part;
        try { part = await buildPart(parts, i, exportId, full, journal); }
        catch (e) { await metaSet("exportAttempt", null); setSave("err", "EXPORT HIBA"); await alertBox("Export hiba", `<p class="msg err">${esc(e.message || e)}</p><p>Az export nem számít érvényesnek; a fotók biztonságban vannak a telefonon.</p>`); return; }
        if (part.bad) { await metaSet("exportAttempt", null); setSave("err", "EXPORT HIBA"); await alertBox("Export-ellenőrzési hiba", `<p class="msg err">${part.bad} elem nem ellenőrizhető a ZIP-ben. Az export nem számít érvényesnek.</p>`); return; }
        built.push(part);
      }
      await metaSet("exportAttempt", null);
      setSave("ok", `ZIP kész (${built.length} fájl) – küldésre vár`);
      const kk = full ? (S.meta.fullRun.k || 0) + 1 : k;
      const r = await shareAll(built, { k: kk, multi: kk > 1 || leftAfter > 0, leftAfter });
      if (!r.reload) await metaSet("exports", (S.meta.exports || []).concat(built.map(p => ({ name: p.name, ts: now(), photos: p.count, bytes: p.blob.size, confirmed: r.ok, full }))));
      if (!r.ok) {
        built.forEach(p => p.blob = null); setSave("err", "Export megszakítva");
        if (r.reload) { reload = "Az app most újraindul (az adatok mentve). Utána nyomd meg újra az Export gombot."; return; }
        await alertBox("Nincs megerősítve", `<p class="msg warn">A fotók nem kapnak „exportált” jelölést. Ismételd meg az exportot.</p>`); return;
      }
      // Jelölés + teljes-export állapot EGY tranzakcióban; a memóriabeli állapot csak sikeres commit után frissül.
      const upd = [];
      built.forEach((part, i) => { for (const p of parts[i]) { const u = Object.assign({}, S.pmeta.get(p.pid)); u.exported = (u.exported || []).concat([part.name]); upd.push(u); } });
      const fr2 = full ? { id: S.meta.fullRun.id, done: S.meta.fullRun.done.concat(sel.map(p => p.pid)), k: kk } : null;
      const fullDone = full && !leftAfter;
      try {
        await txDo(["photometa", "journal", "meta"], "readwrite", t => { const st = t.objectStore("photometa"); upd.forEach(u => st.put(u));
          if (full) t.objectStore("meta").put(fullDone ? null : fr2, "fullRun");
          t.objectStore("meta").put({ ts: now(), id: exportId, full }, "lastExport");
          t.objectStore("journal").add({ ts: now(), by: (S.meta.session || {}).name, tel: S.installId, dev: "*", why: "export", patch: { names: built.map(p => p.name), photos: sel.length } }); });
      } catch (e) {
        built.forEach(p => p.blob = null); setSave("err", "MENTÉSI HIBA");
        await alertBox("Mentési hiba", `<p class="msg err">Az „exportált” jelölés nem mentődött: ${esc(e.message || e)}</p><p>A fájlok átmentek, de a fotók exportálatlannak maradnak – a következő export újra tartalmazza őket (a műhely-importáló a duplikátumokat kiszűri).</p>`); return;
      }
      upd.forEach(u => S.pmeta.set(u.pid, u));
      if (S.meta.batchLimit) { const nb = S.meta.batchLimit * 2; await metaSet("batchLimit", nb >= BATCH_LIMIT ? null : nb); }   // sikeres kör után a csökkentett limit fokozatosan visszaáll
      if (full) S.meta.fullRun = fullDone ? null : fr2;
      S.meta.lastExport = { ts: now(), id: exportId, full };
      built.forEach(p => p.blob = null);
      const left = cands().length;
      if (!left) { setSave("ok", "Export kész ✓"); if (shareHung()) reload = "Export kész ✓. Az iOS-megosztás lezárásához az app most újraindul (az adatok mentve), hogy a következő export is gond nélkül induljon."; return; }
      if (shareHung()) { reload = `Ez a kör kész. Még ${left} fotó van hátra. Az iOS-megosztás lezárásához az app most újraindul (az adatok mentve) – utána nyomd meg: ${full ? "„Teljes export folytatása”" : "„Növekményes export”"}.`; return; }
    }
  }); } catch (e) {
    setSave("err", "EXPORT HIBA");
    await alertBox("Váratlan export-hiba", `<p class="msg err">${esc(e && e.message || e)}</p><p>A már megerősített körök jelölése megmaradt; a többi fotó exportálatlan, biztonságban van. Indítsd újra az exportot.</p>`);
  }
  if (reload) { await safeReload(reload); return; }
  updateBanner(); if (S.view === "export") renderExport();
}

/* ---------------- Visszaállítás exportból ---------------- */
async function restoreFromZips(files) {
  ocrKill("export/visszaállítás – memória felszabadítása");
  if (!files.length) return;
  let addedP = 0, addedR = 0, badP = 0, skipped = 0; const conflicts = [];
  await busy(async () => {
    for (const f of files) {
      try {
        const zip = await JSZip.loadAsync(f);
        const man = JSON.parse(await zip.file("manifest.json").async("string"));
        const dataTxt = await zip.file("data.json").async("string");
        if ((await sha256(new TextEncoder().encode(dataTxt))) !== man.data_sha256) { await alertBox("Sérült export", `<p class="msg err">${esc(f.name)}: data.json ellenőrzőösszeg hibás – kihagyva.</p>`); continue; }
        const data = JSON.parse(dataTxt);
        for (const d of data.devicesNew || []) if (!S.byId.has(d.id)) { await txDo(["devices"], "readwrite", t => t.objectStore("devices").put(d)); S.devs.push(d); rebuildIndex(); }
        for (const r of data.records || []) {
          let wrote = false;
          await txDo(["records", "journal"], "readwrite", t => { const st = t.objectStore("records");
            const g = st.get(r.id); g.onsuccess = () => { const cur = g.result;
              if (cur && cur.tel && r.tel && cur.tel !== r.tel && (cur.rev || 0) >= (r.rev || 0) && cur.updated !== r.updated) {
                conflicts.push(`${r.id}: a meglévő (${cur.tel} rev ${cur.rev}) megtartva, a(z) ${r.tel} rev ${r.rev} kihagyva`);
                t.objectStore("journal").add({ ts: now(), tel: S.installId, dev: r.id, why: "restore-skip", patch: { from: f.name, skipped: r } });
              }
              if (!cur || (cur.rev || 0) < (r.rev || 0)) {
                st.put(r); wrote = true;
                t.objectStore("journal").add({ ts: now(), tel: S.installId, dev: r.id, why: "restore-rec", patch: { from: f.name, rev: r.rev }, old: cur || null });
                if (cur && cur.tel && r.tel && cur.tel !== r.tel) conflicts.push(`${r.id}: ${cur.tel} rev ${cur.rev} → ${r.tel} rev ${r.rev}`);
              }
            }; });
          if (wrote) { S.recs.set(r.id, r); addedR++; }
        }
        for (const m of man.photos) {
          if (!m.path) continue;
          if (S.pmeta.has(m.pid)) { skipped++; continue; }
          const zf = zip.file(m.path); if (!zf) { badP++; continue; }
          const buf = await zf.async("arraybuffer");
          if ((await sha256(buf)) !== m.sha256) { badP++; continue; }
          const pm = Object.assign({}, (data.photos || []).find(p => p.pid === m.pid) || { pid: m.pid, dev: m.dev, type: m.type, n: m.n, sha: m.sha256, bytes: buf.byteLength, ts: m.ts, deleted: m.deleted });
          delete pm.path; pm.verified = true; pm.exported = pm.exported && pm.exported.length ? pm.exported : [f.name];
          let tb = null; try { const { img, url } = await loadImage(new Blob([buf])); tb = await (await resizeTo(img, THUMB_EDGE, 0.7)).blob.arrayBuffer(); URL.revokeObjectURL(url); } catch (e) {}
          await txDo(["photometa", "photoblob", "thumbs"], "readwrite", t => { t.objectStore("photoblob").put(buf, pm.pid); if (tb) t.objectStore("thumbs").put(tb, pm.pid); t.objectStore("photometa").put(pm); });
          S.pmeta.set(pm.pid, pm); addedP++;
        }
      } catch (e) { await alertBox("Hiba", `<p class="msg err">${esc(f.name)}: ${esc(e.message || e)}</p>`); }
    }
    await txDo(["journal"], "readwrite", t => t.objectStore("journal").add({ ts: now(), by: (S.meta.session || {}).name, tel: S.installId, dev: "*", why: "restore", patch: { addedP, addedR, badP, skipped, conflicts } }));
  });
  await loadAll();
  await syncPairs();
  await alertBox("Visszaállítás", `<p class="msg ${badP ? "err" : "ok"}">Fotó hozzáadva: ${addedP} · rekord frissítve: ${addedR} · már meglévő fotó: ${skipped} · HIBÁS (kihagyva): ${badP}</p>
    ${conflicts.length ? `<p class="msg warn">Más telefon adatával felülírt rekord (naplózva): ${conflicts.map(esc).join("<br>")}</p>` : ""}`);
  renderSetup();
}

/* ---------------- Banner, navigáció, indulás ---------------- */
function updateBanner() {
  const b = $("#banner"); const msgs = [];
  if (S.swWaiting) msgs.push(S.busy ? "Új programverzió érhető el – a folyamatban lévő mentés/export után frissíthető." : `Új programverzió érhető el. <button id="bUpd">Frissítés most</button>`);
  const un = unexported();
  if (un.length) {
    const oldest = un.reduce((a, p) => p.ts < a ? p.ts : a, un[0].ts);
    const mins = (Date.now() - new Date(oldest).getTime()) / 60000;
    if (un.length >= REMIND_PHOTOS || mins >= REMIND_MIN) msgs.push(`${un.length} fotó még nincs exportálva (legrégebbi ${Math.round(mins)} perce). <button id="bExpB">Export most</button>`);
  }
  const pc = pairConflictCount();
  if (pc) msgs.push(`⚠ ${pc} ZSO/ZSC pár eltérő adattal – a tételt megnyitva oldható fel (⚠ jelzés a listában).`);
  if (S.swError) msgs.push(`Az offline réteg nem indult el (${esc(S.swError)}); az app működik, de internet nélkül nem indítható újra.`);
  if (S.meta.inventory && !isStandalone()) msgs.push("Nem a főképernyőről telepített appként fut – az adatok veszélyben lehetnek (lásd Beállítás).");
  else if (S.meta.persist && S.meta.persist.ok === false) msgs.push("A tartós tárolás nincs engedélyezve – exportálj gyakran.");
  if (!msgs.length) { b.classList.add("hidden"); return; }
  b.innerHTML = msgs.join("<br>"); b.classList.remove("hidden");
  if ($("#bUpd")) $("#bUpd").onclick = async () => { await flushPending(); await S.saveChain; S.updating = true; S.swWaiting.postMessage("SKIP_WAITING"); };
  if ($("#bExpB")) $("#bExpB").onclick = () => go("export");
}
function go(view) {
  window.scrollTo(0, 0);
  if (!S.meta.inventory || !S.meta.session || !S.meta.session.name || !S.meta.session.permit) view = "setup";
  S.view = view;
  if (view === "setup") renderSetup(); else if (view === "home") renderHome(); else if (view === "device") renderDevice(S.cur); else if (view === "export") renderExport();
  updateBanner();
}
async function loadAll() {
  await loadMeta();
  S.devs = (await getAllFix("devices")) || [];
  S.devs.sort((a, b) => (a.tipus === "SZEKRENY") - (b.tipus === "SZEKRENY") || (a.id < b.id ? -1 : 1));
  rebuildIndex();
  S.recs = new Map(((await getAllFix("records")) || []).map(r => [r.id, r]));
  S.pmeta = new Map(((await getAllFix("photometa")) || []).map(p => [p.pid, p]));
  S.labels = S.meta.inventory ? Object.fromEntries(S.meta.inventory.groups.map(g => [g.key, g.label])) : {};
  $("#docid").textContent = (BETA ? "BÉTA (külön adatok) · " : "") + (S.meta.inventory ? S.meta.inventory.doc : "");
}
async function recoverPendingText() {
  let p = null; try { p = JSON.parse(localStorage.getItem(LSP + "pending") || "null"); } catch (e) {}
  if (!p || !S.byId.has(p.id)) return;
  const cur = recOf(p.id);
  if ((cur[p.key] || "") !== p.val) { await saveRecord(p.id, { [p.key]: p.val }, "text-recovered"); await alertBox("Visszaállított gépelés", `<p class="msg ok">Az app bezáródása előtt beírt szöveg (${esc(p.key)}) visszaállítva: ${esc(S.byId.get(p.id).tag)}.</p>`); }
  try { localStorage.removeItem(LSP + "pending"); } catch (e) {}
}
async function boot() {
  try {
    if (!window.indexedDB || !window.crypto || !crypto.subtle) throw new Error("A böngésző nem támogatja a biztonságos tárolást (HTTPS szükséges).");
    S.db = await idbOpen();
    await loadAll();
    await syncPairs();
    setSave("ok", "Kész");
    try { S.bc = new BroadcastChannel("exf"); S.bc.onmessage = async e => { if (e.data && e.data.t === "rec") { const r = await getOne("records", e.data.id); if (r) S.recs.set(r.id, r); } }; } catch (e) { S.bc = null; }
    if ("serviceWorker" in navigator) {
      try {
        const reg = await navigator.serviceWorker.register("sw.js");
        const watch = w => { if (!w) return; w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) { S.swWaiting = w; updateBanner(); } }); };
        if (reg.waiting && navigator.serviceWorker.controller) S.swWaiting = reg.waiting;
        reg.addEventListener("updatefound", () => watch(reg.installing));
        // Újratöltés CSAK felhasználói frissítés-kérésre (első telepítéskor a clients.claim() nem töltheti újra az oldalt munka közben).
        let reloaded = false; navigator.serviceWorker.addEventListener("controllerchange", () => { if (S.updating && !reloaded) { reloaded = true; location.reload(); } });
      } catch (e) { S.swError = String(e.message || e); }
    }
    $("#modal").addEventListener("click", e => { if (e.target.id === "modal" && modalDismiss) modalDismiss(); });
    await recoverPendingText();
    await checkExportCrash();
    let cap = null; try { cap = JSON.parse(localStorage.getItem(LSP + "capturing") || "null"); localStorage.removeItem(LSP + "capturing"); } catch (e) {}
    if (cap && S.byId.has(cap.dev) && Date.now() - cap.ts < 30 * 60000 && S.meta.session) {
      const got = photosOf(cap.dev).some(p => new Date(p.ts).getTime() >= cap.ts - 2000);
      S.cur = cap.dev; go("device");
      if (!got) alertBox("Fotó ellenőrzése", `<p class="msg warn">Az app a fényképezés közben újraindult. Ha készítettél <b>${esc(cap.type)}</b> fotót, az NEM került mentésre – fotózd újra. (Ha a kamerát megszakítottad, hagyd figyelmen kívül.)</p>`);
    } else go("home");
    setInterval(updateBanner, 60000);
  } catch (e) {
    $("#view").innerHTML = `<div class="msg err"><b>Indítási hiba:</b> ${esc(e.message || e)}</div>`; setSave("err", "HIBA");
  }
}
window.__EXF = S; // tesztekhez
boot();
