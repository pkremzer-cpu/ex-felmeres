/* Ex-felmérés – offline szövegfelismerő worker (ES-modul worker).
   Bemenet:  {id, cmd:"ocr", img:{data:ArrayBuffer(RGBA), width, height}, opt}
             {id, cmd:"warm"}  – csak a modellek betöltése (előmelegítés / offline-ellenőrzés)
   Kimenet:  {id, progress:{stage, i, n}}  |  {id, ok:true, lines:[{text, score}], text, ms}  |  {id, ok:false, error}
   Hálózat: kizárólag a saját origó ./ocr/ fájljai (a Service Worker gyorsítótárából offline is). Adat nem hagyja el a telefont. */
import * as ort from "./ort-bundle.min.js";
import "./ocr-core.js";   // → self.ExOCR

const O = self.ExOCR;
ort.env.wasm.numThreads = 1;   // GitHub Pages: nincs cross-origin isolation → egyszálú WASM
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = new URL("./", self.location.href).href;

let S = null;   // {det, rec, cls, keys}
async function bin(name) {
  const r = await fetch(new URL(name, self.location.href));
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
let P = null;   // egyetlen betöltés akkor is, ha két kérés egyszerre érkezik
function load(post) { return S ? Promise.resolve(S) : (P = P || doLoad(post).catch(e => { P = null; throw e; })); }
async function doLoad(post) {
  const so = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  post({ stage: "load", i: 0, n: 4 });
  const keysTxt = await (await fetch(new URL("keys.txt", self.location.href))).text();
  const keys = keysTxt.split("\n"); if (keys.length && keys[keys.length - 1] === "") keys.pop();
  if (keys.length !== 6623) throw new Error(`keys.txt: ${keys.length} kulcs (várt: 6623)`);
  post({ stage: "load", i: 1, n: 4 });
  const det = await ort.InferenceSession.create(await bin("det.onnx"), so); post({ stage: "load", i: 2, n: 4 });
  const cls = await ort.InferenceSession.create(await bin("cls.onnx"), so); post({ stage: "load", i: 3, n: 4 });
  const rec = await ort.InferenceSession.create(await bin("rec.onnx"), so); post({ stage: "load", i: 4, n: 4 });
  S = { det, rec, cls, keys };
  return S;
}

self.onmessage = async e => {
  const m = e.data || {}, id = m.id, post = p => self.postMessage({ id, progress: p });
  try {
    const s = await load(post);
    if (m.cmd === "warm") { self.postMessage({ id, ok: true, lines: [], text: "", ms: 0 }); return; }
    if (m.cmd !== "ocr" || !m.img || !m.img.data) throw new Error("ismeretlen parancs");
    const img = { data: new Uint8ClampedArray(m.img.data), width: m.img.width, height: m.img.height };
    if (img.data.length !== img.width * img.height * 4) throw new Error("hibás képméret");
    if (m.opt && m.opt.__fail) throw new Error("szimulált memóriahiba (teszt)");
    const opt = Object.assign({}, m.opt || {}, { onStage: (stage, i, n) => post({ stage, i, n }) });
    const t0 = Date.now();
    const r = await O.ocrImage(ort, s.det, s.rec, s.keys, img, opt, s.cls);
    self.postMessage({ id, ok: true, lines: r.lines.map(l => ({ text: l.text, score: Math.round(l.score * 1000) / 1000 })), text: r.text, ms: Date.now() - t0 });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
