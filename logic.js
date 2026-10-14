/* Ex-felmérés – tiszta logika (DOM nélkül), a böngésző és a Node-teszt is ezt használja.
   A megfelelőség-értékelés pontosan az Excel (ICCS-2656-EXC-013-v01) Eszközleltár képleteit követi:
   MSZ EN IEC 60079-14:2025 Table 4 (zóna–EPL), Table 13 (csoport), Table 14 / CHK-T-01 (hőmérséklet). */
(function (root) {
  "use strict";
  const LISTS = {
    zg: ["0", "1", "2", "Nincs", "TISZTÁZANDÓ"],
    zp: ["20", "21", "22", "Nincs", "TISZTÁZANDÓ"],
    tg: ["IIA", "IIB", "IIC"],
    tp: ["IIIA", "IIIB", "IIIC"],
    tt: ["T1", "T2", "T3", "T4", "T5", "T6"],
    mod: ["Ex d (da/db/dc)", "Ex e (eb/ec)", "Ex i (ia/ib/ic)", "Ex n (nA/nC/nR)", "Ex p (pxb/pyb/pzc)", "Ex m (ma/mb/mc)",
          "Ex t (ta/tb/tc)", "Ex o", "Ex q", "Ex op", "Kombinált (több mód)", "Simple apparatus", "NINCS Ex-JELÖLÉS"],
    eg: ["Ga", "Gb", "Gc", "1G", "2G", "3G", "NINCS JELÖLÉS"],
    ep: ["Da", "Db", "Dc", "1D", "2D", "3D", "NINCS JELÖLÉS"],
    dg: ["IIA", "IIB", "IIC", "II", "NINCS JELÖLÉS"],
    dp: ["IIIA", "IIIB", "IIIC", "NINCS JELÖLÉS"],
    dt: ["T1", "T2", "T3", "T4", "T5", "T6", "NINCS JELÖLÉS"],
    res: ["OK", "NOK", "N.A.", "NH"]
  };
  const RES_EXCEL = { "OK": "OK", "NOK": "NOK", "N.A.": "N.A.", "NH": "NEM HOZZÁFÉRHETŐ" };
  const PHOTO_TYPES = [
    { key: "ADATTABLA", label: "Adattábla" }, { key: "ATTEKINTO", label: "Áttekintő" },
    { key: "BEVEZETO", label: "Bevezető / kábel" }, { key: "HIBA", label: "Hiba (NOK)" }
  ];

  function s(v) { return v === undefined || v === null ? "" : String(v); }

  // EPL-rész: "-" nincs zóna, "T" tisztázandó, "N" nem felel meg, "M" megfelel  (Excel part_epl)
  function partEpl(zone, epl, off, a, b, c, s1, s2, s3, sa) {
    const z = s(zone), e = s(epl);
    if (z === "" || z === "Nincs") return "-";
    if (z === "TISZTÁZANDÓ" || e === "") return "T";
    if (e === "NINCS JELÖLÉS") return sa ? "T" : "N";
    const en = e.split(s1).join(a).split(s2).join(b).split(s3).join(c);
    const idx = [a, b, c].indexOf(en);
    if (idx < 0) return "T";
    const zn = Number(z);
    if (!isFinite(zn)) return "T";
    return (idx + 1) <= zn + off ? "M" : "N";
  }
  function partGrp(t, d, list, ii, sa) {
    t = s(t); d = s(d);
    if (t === "") return "-";
    if (d === "") return "T";
    if (d === "NINCS JELÖLÉS") return sa ? "T" : "N";
    const dd = ii && d === "II" ? "IIC" : d;
    const a = list.indexOf(dd), b = list.indexOf(t);
    if (a < 0 || b < 0) return "T";
    return a >= b ? "M" : "N";
  }
  function combine(g, d) {
    if (g === "-" && d === "-") return "";
    if (g === "N" || d === "N") return "NEM FELEL MEG";
    if (g === "T" || d === "T") return "TISZTÁZANDÓ";
    return "MEGFELEL";
  }
  function tnum(x) { const m = /^T([1-6])$/.exec(s(x)); return m ? Number(m[1]) : NaN; }
  function evaluate(r) {
    r = r || {};
    // Simple apparatus (MSZ EN IEC 60079-14:2025 Annex Q): jelölés nélkül is lehet megfelelő → „NINCS JELÖLÉS” = TISZTÁZANDÓ, nem NEM FELEL MEG
    const sa = r.mod === "Simple apparatus";
    const fepl = combine(partEpl(r.zg, r.eg, 1, "Ga", "Gb", "Gc", "1G", "2G", "3G", sa),
                         partEpl(r.zp, r.ep, -19, "Da", "Db", "Dc", "1D", "2D", "3D", sa));
    const fgr = combine(partGrp(r.tg, r.dg, ["IIA", "IIB", "IIC"], true, sa), partGrp(r.tp, r.dp, ["IIIA", "IIIB", "IIIC"], false, sa));
    let tg;
    if (s(r.tt) === "") tg = "-";
    else if (s(r.dt) === "") tg = "T";
    else if (r.dt === "NINCS JELÖLÉS") tg = sa ? "T" : "N";
    else { const a = tnum(r.dt), b = tnum(r.tt); tg = (isNaN(a) || isNaN(b)) ? "T" : (a >= b ? "M" : "N"); }
    let td;
    if (s(r.tmax) === "") td = "-";
    else if (s(r.dtc) === "") td = "T";
    else { const a = Number(String(r.dtc).replace(",", ".")), b = Number(String(r.tmax).replace(",", "."));
           td = (isFinite(a) && isFinite(b)) ? (a <= b ? "M" : "N") : "T"; }
    return { fepl, fgr, ft: combine(tg, td) };
  }

  // Kész-validáció. Visszaad: {ok:bool, errors:[...], warnings:[...]}
  function isNum(x) { return s(x).trim() === "" || isFinite(Number(s(x).replace(",", "."))); }
  function validate(dev, rec, photos, labels) {
    const lab = k => (labels && labels[k]) || k;
    const errors = [], warnings = [];
    rec = rec || {}; const res = rec.res || {};
    const live = (photos || []).filter(p => !p.deleted);
    const cnt = t => live.filter(p => p.type === t).length;
    if (rec.mode === "gyors") {
      if (live.length === 0) errors.push("Gyors módban legalább egy fotó kötelező.");
      return { ok: errors.length === 0, errors, warnings };
    }
    if (dev.tipus === "SZEKRENY") {
      if (!rec.zg) errors.push("A szekrény helyén lévő gázzóna nincs megadva (lehet „Nincs”).");
      if (!rec.zp) errors.push("A szekrény helyén lévő porzóna nincs megadva (lehet „Nincs”).");
    } else {
      if (!rec.zg) errors.push("Gázzóna nincs megadva (lehet „Nincs” vagy „TISZTÁZANDÓ”).");
      if (!rec.zp) errors.push("Porzóna nincs megadva (lehet „Nincs” vagy „TISZTÁZANDÓ”).");
      const outside = rec.zg === "Nincs" && rec.zp === "Nincs";
      if (!outside) {
        if (!rec.mod) errors.push("Védelmi mód nincs megadva (ha nincs Ex-jelölés: „NINCS Ex-JELÖLÉS”).");
        if (rec.mod && rec.mod !== "NINCS Ex-JELÖLÉS" && !s(rec.exj).trim()) errors.push("Az adattábla teljes Ex-jelölése nincs beírva.");
        if (res.jelol !== "NH" && cnt("ADATTABLA") === 0) errors.push("ADATTÁBLA fotó kötelező (ha nem hozzáférhető: Jelölés = NH).");
        const ev = evaluate(rec);
        if (ev.fepl === "NEM FELEL MEG" || ev.fgr === "NEM FELEL MEG" || ev.ft === "NEM FELEL MEG") {
          if (res.eplgrt !== "NOK") errors.push("Az automatikus értékelés NEM FELEL MEG, de az „EPL / csoport / T-osztály” csoport nem NOK – ellentmondás.");
        }
        if ((ev.fepl === "TISZTÁZANDÓ" || ev.fgr === "TISZTÁZANDÓ" || ev.ft === "TISZTÁZANDÓ") && !s(rec.megj).trim())
          errors.push("Az automatikus értékelés TISZTÁZANDÓ – a megjegyzésben írd le, mi a tisztázandó.");
        if (!isNum(rec.tmax) || !isNum(rec.dtc)) errors.push("A hőmérséklet-mezőkbe csak szám írható (°C, tizedesvessző megengedett).");
        if (rec.zg && rec.zg !== "Nincs" && rec.zg !== "TISZTÁZANDÓ" && !rec.tg) warnings.push("A TIM szerinti gázcsoport nincs megadva – a csoport-ellenőrzés nem fut.");
        if (rec.zg && rec.zg !== "Nincs" && rec.zg !== "TISZTÁZANDÓ" && !rec.tt) warnings.push("A TIM szerinti T-osztály nincs megadva – a T-ellenőrzés nem fut.");
        if (rec.zp && rec.zp !== "Nincs" && rec.zp !== "TISZTÁZANDÓ" && !rec.tmax) warnings.push("Porzóna: a megengedett max. felületi hőmérséklet nincs megadva.");
      }
    }
    const missing = (dev.groups || []).filter(g => !res[g]);
    if (missing.length) errors.push("Nincs eredmény: " + missing.map(lab).join(", ") + ".");
    const nok = (dev.groups || []).filter(g => res[g] === "NOK");
    if (nok.length) {
      if (cnt("HIBA") === 0) errors.push("NOK esetén legalább egy HIBA fotó kötelező.");
      if (!s(rec.megj).trim()) errors.push("NOK esetén a megjegyzés (észlelés) kötelező.");
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  // Keresés: ékezet- és írásjel-független, minden szó részszöveg; tömör (szóköz nélküli) egyezés a tagre.
  function norm(x) { return s(x).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase(); }
  function compact(x) { return norm(x).replace(/[^A-Z0-9]/g, ""); }
  function buildIndex(dev) {
    return { hay: norm([dev.tag, dev.leiras, dev.szekreny, dev.kat, dev.id].join(" ")).replace(/[^A-Z0-9]+/g, " "),
             ctag: compact(dev.tag), cid: compact(dev.id) };
  }
  function score(idx, q) {
    const nq = norm(q).replace(/[^A-Z0-9]+/g, " ").trim();
    if (!nq) return 0;
    const cq = nq.replace(/ /g, "");
    let sc = 0;
    if (idx.ctag === cq || idx.cid === cq) sc += 1000;
    else if (idx.ctag.startsWith(cq)) sc += 500;
    else if (idx.ctag.includes(cq)) sc += 300;
    const toks = nq.split(" ");
    let all = true;
    for (const t of toks) { if (idx.hay.includes(t) || idx.ctag.includes(t)) sc += 10; else all = false; }
    if (!all && sc < 300) return 0;
    return sc;
  }
  function search(devs, index, q, limit) {
    const out = [];
    for (let i = 0; i < devs.length; i++) { const sc = score(index[i], q); if (sc > 0) out.push([sc, i]); }
    out.sort((a, b) => b[0] - a[0] || (devs[a[1]].tag < devs[b[1]].tag ? -1 : 1));
    return out.slice(0, limit || 60).map(x => devs[x[1]]);
  }

  // Kanonikus JSON (Python json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False) megfelelője)
  function canon(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  }
  function safeName(x) { return norm(x).replace(/[^A-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "NA"; }

  const api = { LISTS, RES_EXCEL, PHOTO_TYPES, evaluate, validate, search, buildIndex, score, canon, safeName, norm, compact };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.ExLogic = api;
})(typeof self !== "undefined" ? self : this);
