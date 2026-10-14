/* Ex-felmérés – PRJ2656-APADEO – offline-first terepi app (iPhone / Safari, kezdőképernyős webapp)
   Adattárolás: kizárólag a készüléken (IndexedDB). Kimenet: ellenőrzőösszeges ZIP-export (fotók + adatok).
   Adatvédelmi elvek:
   (1) minden módosítás azonnal, egyetlen IndexedDB-tranzakcióban (olvasás + összefésülés + írás + napló) mentődik;
   (2) a mentések sorosítva futnak (nincs versenyhelyzet), a gépelés közbeni szöveg szinkron árnyékmásolatban is megvan;
   (3) minden fotó ArrayBufferként tárolva, visszaolvasva, SHA-256-tal ellenőrizve;
   (4) az app soha nem töröl fotót véglegesen (csak "törölt" jelölés), minden változás naplózva (journal);
   (5) export: ZIP önellenőrzés után, felhasználói megosztás + megerősítés után számít exportáltnak. */
"use strict";
const APP_VERSION = "1.1.1";
const DB_NAME = "exfelmeres", DB_VER = 2;
const PART_LIMIT = (typeof window !== "undefined" && window.__EXF_PART_LIMIT) || 40 * 1024 * 1024;   // ZIP-rész max. mérete (iOS-memória miatt)
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
  for (const k of ["inventory", "session", "lastExport", "lastTim", "defaultMode", "persist", "recent", "exports", "installId"]) S.meta[k] = await getOne("meta", k);
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
    await txDo(["records", "journal"], "readwrite", t => {
      const st = t.objectStore("records");
      const g = st.get(id);
      g.onsuccess = () => {
        const old = g.result || blankRec(id);
        rec = JSON.parse(JSON.stringify(old));
        Object.assign(rec, patch);
        if (patch.res) rec.res = Object.assign({}, old.res || {}, patch.res);
        if (!("status" in patch) && ["uj", "kesz", "ertekelendo"].includes(old.status)) rec.status = "folyamatban";
        rec.rev = (old.rev || 0) + 1; rec.updated = now(); rec.by = (S.meta.session || {}).name || ""; rec.tel = S.installId;
        st.put(rec);
        t.objectStore("journal").add({ ts: rec.updated, by: rec.by, tel: S.installId, dev: id, why: why || "edit", patch, rev: rec.rev });
      };
    });
    S.recs.set(id, rec);
    if (S.bc) S.bc.postMessage({ t: "rec", id });
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
  try { localStorage.setItem("exf_pending", JSON.stringify(S.pending)); } catch (e) {}
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
    try { const ls = JSON.parse(localStorage.getItem("exf_pending") || "null"); if (ls && ls.id === p.id && ls.key === p.key && ls.val === p.val) localStorage.removeItem("exf_pending"); } catch (e) {}
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
function photosOf(id) { return [...S.pmeta.values()].filter(p => p.dev === id).sort((a, b) => a.ts < b.ts ? -1 : 1); }
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
  const fails = [], warn = [];
  await busy(async () => {
    for (const file of files) {
      setSave("busy", "Fotó mentése…");
      try {
        const m = await addOnePhoto(devId, type, file);
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
function countFor(k) { const keep = S.filter; S.filter = k; const n = S.devs.filter(passFilter).length; S.filter = keep; return n; }
function rebuildIndex() { S.index = S.devs.map(L.buildIndex); S.byId = new Map(S.devs.map(d => [d.id, d])); }

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
    await loadAll(); renderSetup();
  } catch (e) { alertBox("Hiba", `<p class="msg err">${esc(e.message || e)}</p>`); }
}

/* ---------------- Kereső / lista ---------------- */
function renderHome() {
  const inv = S.meta.inventory;
  const eszk = S.devs.filter(d => d.tipus !== "SZEKRENY");
  const done = eszk.filter(d => (S.recs.get(d.id) || {}).status === "kesz").length;
  const started = eszk.filter(d => devStatus(d)[0] !== "new").length;
  const cabs = [...new Set(S.devs.map(d => d.szekreny))].sort();
  $("#view").innerHTML = `
  <div class="search"><input id="q" type="search" inputmode="search" ${TXT_ATTR} aria-label="Keresés"
     placeholder="Keresés: tag, pl. LSHH 320 TSI, PIT220…" value="${esc(S.q)}">
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
  $("#chips").querySelectorAll("[data-f]").forEach(b => b.onclick = () => { S.filter = b.dataset.f; renderHome(); });
  $("#circ").querySelectorAll("[data-c]").forEach(b => b.onclick = () => { S.circ = b.dataset.c; renderHome(); });
  $("#cab").onchange = e => { S.cab = e.target.value; renderHome(); };
  $("#bNew").onclick = newDeviceForm; $("#bExp").onclick = () => go("export"); $("#bSet").onclick = () => go("setup");
  drawList();
}
function drawList() {
  let arr;
  const plain = !S.q.trim() && S.filter === "all" && !S.cab && S.circ === "all";
  if (S.q.trim()) arr = L.search(S.devs, S.index, S.q, 400).filter(passFilter).slice(0, 80);
  else if (plain) arr = (S.meta.recent || []).map(id => S.byId.get(id)).filter(Boolean);
  else arr = S.devs.filter(passFilter).slice(0, 300);
  const head = plain ? `<li class="muted" style="padding:8px 0">Legutóbbiak – írj a keresőbe, vagy válassz szűrőt.</li>` : "";
  $("#res").innerHTML = head + (arr.length ? arr.map(d => { const [c, l] = devStatus(d); const pc = photosOf(d.id).filter(p => !p.deleted).length;
    return `<li class="item" data-id="${esc(d.id)}"><div class="grow"><div class="t">${esc(d.tag)}</div><div class="d">${esc(d.leiras)} · ${esc(d.szekreny)}${d.exi === "IGEN" ? " · <b>Ex i</b>" : ""}${pc ? ` · 📷 ${pc}` : ""}</div></div><span class="st ${c}">${esc(l)}</span></li>`; }).join("")
    : (S.q.trim() || !plain ? `<li class="muted" style="padding:12px 0">Nincs találat.${S.q.trim() ? " Ha az eszköz nincs a leltárban: <b>+ Leltáron kívüli</b>." : ""}</li>` : ""));
  $("#res").querySelectorAll("[data-id]").forEach(li => li.onclick = () => openDevice(li.dataset.id));
}
async function openDevice(id) {
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
  const d = S.byId.get(id); if (!d) return go("home");
  const r = recOf(id), inv = S.meta.inventory, groups = Object.fromEntries(inv.groups.map(g => [g.key, g]));
  const ph = photosOf(id), ev = L.evaluate(r), isCab = d.tipus === "SZEKRENY";
  const gyors = r.mode === "gyors";
  const val = L.validate(d, r, ph, S.labels);
  const evc = v => v === "MEGFELEL" ? "M" : v === "NEM FELEL MEG" ? "N" : v === "TISZTÁZANDÓ" ? "T" : "";
  $("#view").innerHTML = `
  <button id="bBack" style="margin-bottom:8px">‹ Keresés</button>
  <h1>${esc(d.tag)}</h1>
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
function chooseTypeThen(fn) {
  modal(`<h2>Fotó típusa</h2>${L.PHOTO_TYPES.map(t => `<button data-t="${t.key}" style="width:100%;margin:4px 0">${esc(t.label)}</button>`).join("")}<button id="mNo" style="width:100%;margin-top:8px">Mégse</button>`,
    b => { b.querySelectorAll("[data-t]").forEach(x => x.onclick = () => { closeModal(); fn(x.dataset.t); }); b.querySelector("#mNo").onclick = closeModal; }, closeModal);
}
function pickPhoto(id, type, sel) {
  const inp = $(sel); inp.value = "";
  try { localStorage.setItem("exf_capturing", JSON.stringify({ dev: id, type, ts: Date.now() })); } catch (e) {}
  const clear = () => { try { localStorage.removeItem("exf_capturing"); } catch (e) {} };
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
  $("#view").innerHTML = `<button id="bBack" style="margin-bottom:8px">‹ Keresés</button><h1>Mentés / export</h1>
  <div class="card"><div class="kv"><b>Fotók összesen</b><span>${all.length} db · ${fmtBytes(allB)}</span><b>Még nem exportált</b><span><b>${un.length} db · ${fmtBytes(unB)}</b></span>
    <b>Rögzített eszközök</b><span>${[...S.recs.values()].filter(r => r.status !== "uj").length}</span><b>Utolsó export</b><span>${S.meta.lastExport ? esc(new Date(S.meta.lastExport.ts).toLocaleString("hu-HU")) : "még nem volt"}</span>
    <b>Telefon</b><span>${esc(S.installId)}</span></div>
    <p id="persistInfo" class="muted"></p></div>
  <button id="bInc" class="primary" style="width:100%;margin:6px 0">Növekményes export (új fotók + minden adat)</button>
  <button id="bFull" style="width:100%;margin:6px 0">Teljes export (minden fotó + minden adat)</button>
  <p class="muted">Minden ZIP tartalmazza a teljes adatállományt (data.json, CSV, napló) és a fotók SHA-256 listáját; legfeljebb ${fmtBytes(PART_LIMIT)}-os részekre bomlik.
   Mentés: a megosztás-ablakban <b>Mentés a Fájlokba</b> (iCloud Drive) vagy <b>AirDrop</b> a Macre. A fotók csak a megerősítés után számítanak exportáltnak – az app SOHA nem törli őket.</p>
  <h3>Korábbi exportok</h3>${ex.length ? `<ul class="list">${ex.slice().reverse().map(e => `<li class="item"><div class="grow"><div class="t" style="font-size:14px">${esc(e.name)}</div><div class="d">${esc(new Date(e.ts).toLocaleString("hu-HU"))} · ${esc(e.photos)} fotó · ${esc(e.confirmed ? "megerősítve ✓" : "NEM megerősített")}</div></div></li>`).join("")}</ul>` : `<p class="muted">Nincs.</p>`}`;
  $("#bBack").onclick = () => go("home");
  const run = full => { $("#bInc").disabled = $("#bFull").disabled = true; doExport(full).finally(() => { if ($("#bInc")) { $("#bInc").disabled = $("#bFull").disabled = false; } }); };
  $("#bInc").onclick = () => run(false); $("#bFull").onclick = () => run(true);
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
function shareStep(part, i, n) {
  // A megosztás KÖZVETLENÜL a felhasználói koppintásból indul (iOS user-activation követelmény).
  return new Promise(res => {
    const file = new File([part.blob], part.name, { type: "application/zip" });
    const can = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    modal(`<h2>Rész ${i + 1}/${n} kész</h2><p><b>${esc(part.name)}</b><br>${part.count} fotó · ${fmtBytes(part.blob.size)} · önellenőrzés ✓</p>
      ${can ? `<button id="xShare" class="primary" style="width:100%;margin:6px 0">Megosztás / Mentés a Fájlokba</button>` : ""}
      <button id="xDl" style="width:100%;margin:6px 0">${can ? "Tartalék: letöltés" : "Letöltés (Fájlok › Letöltések)"}</button>
      <div id="xMsg"></div><button id="xDone" class="primary" style="width:100%;margin-top:10px" disabled>Elmentettem – tovább</button>
      <button id="xCancel" style="width:100%;margin-top:6px">Megszakítás (nem számít exportnak)</button>`, b => {
      const done = b.querySelector("#xDone"), msg = b.querySelector("#xMsg");
      if (b.querySelector("#xShare")) b.querySelector("#xShare").onclick = () => {
        navigator.share({ files: [file], title: part.name })
          .then(() => { msg.innerHTML = `<p class="msg ok">Megosztva. Ha elmentetted, nyomd meg: „Elmentettem – tovább”.</p>`; done.disabled = false; })
          .catch(e => { msg.innerHTML = `<p class="msg warn">${e && e.name === "AbortError" ? "A megosztás megszakítva." : "A megosztás nem sikerült: " + esc(e && e.message || e)} Próbáld újra, vagy használd a letöltést.</p>`; });
      };
      b.querySelector("#xDl").onclick = () => {
        const a = document.createElement("a"); const u = URL.createObjectURL(part.blob); a.href = u; a.download = part.name; document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 120000);
        msg.innerHTML = `<p class="msg warn">Ellenőrizd a Fájlok app Letöltések mappájában, hogy a fájl ott van-e, majd nyomd meg: „Elmentettem – tovább”.</p>`; done.disabled = false;
      };
      done.onclick = () => { closeModal(); res(true); };
      b.querySelector("#xCancel").onclick = () => { closeModal(); res(false); };
    });
  });
}
async function doExport(full) {
  await flushPending();
  await busy(async () => {
    const sel = (full ? [...S.pmeta.values()] : unexported()).sort((a, b) => a.ts < b.ts ? -1 : 1);
    const parts = []; let cur = [], sz = 0;
    for (const p of sel) { if (cur.length && sz + p.bytes > PART_LIMIT) { parts.push(cur); cur = []; sz = 0; } cur.push(p); sz += p.bytes; }
    if (cur.length || !parts.length) parts.push(cur);
    const exportId = stamp(), journal = await getAllFix("journal");
    for (let i = 0; i < parts.length; i++) {
      setSave("busy", `Export ${i + 1}/${parts.length} készül…`);
      let part;
      try { part = await buildPart(parts, i, exportId, full, journal); }
      catch (e) { setSave("err", "EXPORT HIBA"); await alertBox("Export hiba", `<p class="msg err">${esc(e.message || e)}</p><p>Az export nem számít érvényesnek; a fotók biztonságban vannak a telefonon.</p>`); return; }
      if (part.bad) { setSave("err", "EXPORT HIBA"); await alertBox("Export-ellenőrzési hiba", `<p class="msg err">${part.bad} elem nem ellenőrizhető a ZIP-ben. Az export nem számít érvényesnek.</p>`); return; }
      setSave("ok", `Export ${i + 1}/${parts.length} kész`);
      const ok = await shareStep(part, i, parts.length);
      await metaSet("exports", (S.meta.exports || []).concat([{ name: part.name, ts: now(), photos: part.count, bytes: part.blob.size, confirmed: ok, full }]));
      part.blob = null;
      if (!ok) { setSave("err", "Export megszakítva"); await alertBox("Nincs megerősítve", `<p class="msg warn">A fotók nem kapnak „exportált” jelölést. Ismételd meg az exportot.</p>`); return; }
      await txDo(["photometa", "journal"], "readwrite", t => { const st = t.objectStore("photometa");
        for (const p of parts[i]) { const u = Object.assign({}, S.pmeta.get(p.pid)); u.exported = (u.exported || []).concat([part.name]); st.put(u); S.pmeta.set(p.pid, u); }
        t.objectStore("journal").add({ ts: now(), by: (S.meta.session || {}).name, tel: S.installId, dev: "*", why: "export", patch: { name: part.name, photos: parts[i].length } }); });
    }
    await metaSet("lastExport", { ts: now(), id: exportId, full });
    setSave("ok", "Export kész ✓");
  });
  updateBanner(); if (S.view === "export") renderExport();
}

/* ---------------- Visszaállítás exportból ---------------- */
async function restoreFromZips(files) {
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
  $("#docid").textContent = S.meta.inventory ? S.meta.inventory.doc : "";
}
async function recoverPendingText() {
  let p = null; try { p = JSON.parse(localStorage.getItem("exf_pending") || "null"); } catch (e) {}
  if (!p || !S.byId.has(p.id)) return;
  const cur = recOf(p.id);
  if ((cur[p.key] || "") !== p.val) { await saveRecord(p.id, { [p.key]: p.val }, "text-recovered"); await alertBox("Visszaállított gépelés", `<p class="msg ok">Az app bezáródása előtt beírt szöveg (${esc(p.key)}) visszaállítva: ${esc(S.byId.get(p.id).tag)}.</p>`); }
  try { localStorage.removeItem("exf_pending"); } catch (e) {}
}
async function boot() {
  try {
    if (!window.indexedDB || !window.crypto || !crypto.subtle) throw new Error("A böngésző nem támogatja a biztonságos tárolást (HTTPS szükséges).");
    S.db = await idbOpen();
    await loadAll();
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
    let cap = null; try { cap = JSON.parse(localStorage.getItem("exf_capturing") || "null"); localStorage.removeItem("exf_capturing"); } catch (e) {}
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
