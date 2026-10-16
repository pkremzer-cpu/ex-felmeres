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
  // v1.3: OCR-barát tervjel-egyezés (iOS „Szöveg beolvasása” / Live Text):
  //  – több soros / zajos beolvasott szöveg: minden sor és token külön jelöltként is vizsgálva;
  //  – kábelcímke-előtag: „W” levágása (WTIT-… → TIT-…), WZS/WZC/WZO → ZSO/ZSC;
  //  – tipikus OCR-tévesztések (O/0, Q/0, D/0, I/1, L/1, S/5, B/8, Z/2, G/6) egységesítve – csak alacsonyabb rangú egyezés.
  function norm(x) { return s(x).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase(); }
  function compact(x) { return norm(x).replace(/[^A-Z0-9]/g, ""); }
  const FOLD = { O: "0", Q: "0", D: "0", I: "1", L: "1", S: "5", B: "8", Z: "2", G: "6" };
  function fold(c) { return c.replace(/[OQDILSBZG]/g, ch => FOLD[ch]); }
  // ZSO/ZSC végálláskapcsoló-pár: azonos hurok-azonosító (a „-ZSO-”/„-ZSC-” utáni rész) = egy tok, egy eszköz.
  function pairInfo(tag) { const m = /^-ZS([OC])-(.+)$/.exec(s(tag).trim()); return m ? { role: m[1], key: m[2] } : null; }
  function buildPairs(devs) {
    const by = {}; for (const d of devs) { const p = pairInfo(d.tag); if (p && d.tipus !== "UJ") (by[p.key] = by[p.key] || {})[p.role] = d; }
    const partner = {}, primaryOf = {};
    for (const k in by) { const o = by[k].O, c = by[k].C; if (o && c) { partner[o.id] = c.id; partner[c.id] = o.id; primaryOf[c.id] = o.id; primaryOf[o.id] = o.id; } }
    return { partner, primaryOf };
  }
  function variants(c) {
    // Egy tömör jelöltből a tervjel-változatok (kábelcímke-előtagok feloldásával)
    const out = new Set([c]);
    if (/^W[A-Z]{1,5}\d/.test(c)) out.add(c.slice(1));
    for (const v of [...out]) {
      let m;
      if ((m = /^ZS(\d.*)$/.exec(v))) { out.add("ZSO" + m[1]); out.add("ZSC" + m[1]); }
      if ((m = /^Z([OC])(\d.*)$/.exec(v))) out.add("ZS" + m[1] + m[2]);
    }
    return [...out];
  }
  function buildIndex(dev, alt) {
    const tags = [dev.tag].concat(alt || []);
    const ctags = tags.map(compact).filter(Boolean);
    return { hay: norm(tags.concat([dev.leiras, dev.szekreny, dev.kat, dev.id]).join(" ")).replace(/[^A-Z0-9]+/g, " "),
             ctag: ctags[0] || "", ctags, ftags: ctags.map(fold), cid: compact(dev.id) };
  }
  // Jelöltek: {c, exact} – „exact” csak a TELJES lekérdezés változtatás nélküli tömör alakja (csak ez adhat „pontos” jelölést)
  function candidates(q) {
    const raw = norm(q), full = raw.replace(/[^A-Z0-9]/g, "");
    const parts = new Set([full]);
    for (const line of raw.split(/[\r\n]+/)) { const c = line.replace(/[^A-Z0-9]/g, ""); if (c.length >= 4) parts.add(c); }
    for (const tok of raw.split(/[^A-Z0-9-]+/)) { const c = tok.replace(/[^A-Z0-9]/g, ""); if (c.length >= 6) parts.add(c); }
    const out = new Map(); for (const p of parts) if (p) for (const v of variants(p)) { const ex = p === full && v === full; if (!out.has(v) || ex) out.set(v, ex); }
    return [...out].map(([c, exact]) => ({ c, exact }));
  }
  function tagScore(idx, cands) {
    let best = 0;
    for (const { c, exact } of cands) {
      const fc = fold(c);
      for (let i = 0; i < idx.ctags.length; i++) {
        const t = idx.ctags[i], ft = idx.ftags[i];
        if (t === c) best = Math.max(best, exact ? 1000 : 800);
        else if (c.length >= 3 && t.startsWith(c)) best = Math.max(best, 500);
        else if (c.length >= 3 && t.includes(c)) best = Math.max(best, 300);
        else if (c.length >= 6 && ft === fc) best = Math.max(best, 700);
        else if (c.length >= 6 && ft.startsWith(fc)) best = Math.max(best, 400);
      }
      if (idx.cid === c) best = Math.max(best, exact ? 1000 : 800);
    }
    return best;
  }
  function score(idx, q) {
    const nq = norm(q).replace(/[^A-Z0-9]+/g, " ").trim();
    if (!nq) return 0;
    let sc = tagScore(idx, candidates(q));
    const toks = nq.split(" ");
    let all = true;
    for (const t of toks) { if (idx.hay.includes(t) || idx.ctags.some(c => c.includes(t))) sc += 10; else all = false; }
    if (!all && sc < 300) return 0;
    return sc;
  }
  // Egyezés jellege a felhasználói visszajelzéshez: "pontos" | "ocr" (előtag-/tévesztés-javított) | ""
  function matchKind(idx, q) { const t = tagScore(idx, candidates(q)); return t >= 1000 ? "pontos" : t >= 700 ? "ocr" : ""; }
  function search(devs, index, q, limit) {
    const out = [];
    for (let i = 0; i < devs.length; i++) { const sc = score(index[i], q); if (sc > 0) out.push([sc, i]); }
    out.sort((a, b) => b[0] - a[0] || (devs[a[1]].tag < devs[b[1]].tag ? -1 : 1));
    return out.slice(0, limit || 60).map(x => devs[x[1]]);
  }

  // v1.3: Ex-jelölés értelmező (iOS „Szöveg beolvasása” / kézi beírás → mezőjavaslat). Determinisztikus, offline.
  // Konzervatív szabályok: megosztott EPL (Ga/Gb, 1/2G) → a ház EPL-je; T-tartomány → legkedvezőtlenebb osztály;
  // szögletes zárójeles [ia Ga] (kimeneti áramkör) nem számít a készülék EPL-jébe. Az eredmény CSAK javaslat – jóváhagyás kell.
  // Szóköz nélküli Ex-blokk tokenekre bontása: védelmi mód(ok) → csoport → hőmérséklet → EPL (mohó, a leghosszabb illeszkedéssel)
  function unglue(r) {
    const PROTS = ["PXB", "PYB", "PZC", "DA", "DB", "DC", "EB", "EC", "IA", "IB", "IC", "NA", "NC", "NR", "MA", "MB", "MC", "TA", "TB", "TC", "OP", "D", "E", "I", "N", "P", "M", "O", "Q"];
    const out = []; let i = 0;
    const take = re => { const m = re.exec(r.slice(i)); if (m && m.index === 0) { out.push(m[0]); i += m[0].length; return true; } return false; };
    // védelmi módok (a csoport „II”/„III” előtt állnak meg)
    while (i < r.length) {
      if (/^(III?[ABC]?|[IL1]{2,3}[ABC])/.test(r.slice(i)) && out.length) break;
      if (r[i] === "[") { const j = r.indexOf("]", i); if (j < 0) break; out.push(r.slice(i, j + 1)); i = j + 1; continue; }
      const p = PROTS.find(x => r.startsWith(x, i) && !(x.length === 1 && x === "I" && /^I{2}/.test(r.slice(i))));
      if (!p) break;
      if (out.length && /^I[ABC]$/.test(p) && /^\.?T[\d*]/.test(r.slice(i + 2))) { out.push("?" + p); i += p.length; break; }   // „DBICT6” → valószínűleg csonka „IIC”: nem védelmi mód, csoport ismeretlen
      out.push(p); i += p.length;
    }
    const nProt = out.length;
    const g1 = take(/^(III[ABC]?|II[ABC]?|[IL1]{2,3}[ABC])/);
    take(/^\.?(T[1-6]\.{1,3}T[1-6]|T[1-6]T[1-6]|T[1-6](?:\/T[1-6])*|T\d{2,3}°?C|T\*+°?C)/);
    const e1 = take(/^(G[ABC]\/G[ABC]|D[ABC]\/D[ABC]|G[ABC]|D[ABC])/);
    // Csak akkor fogadjuk el, ha valódi Ex-blokk: van védelmi mód ÉS utána csoport/hőmérséklet/EPL, és a maradék nem betűvel folytatódik
    const ok = nProt > 0 && out.length > nProt && !/^[A-Z]/.test(r.slice(i));
    if (!ok) return null;
    return out.join(" ") + (i < r.length ? " " + r.slice(i) : "");
  }
  function parseMarking(txt) {
    const notes = [], out = {};
    // 1) Normalizálás (Unicode, kötőjelek, …, nagybetű); OCR-javítás CSAK jelölés-mintákban
    let t = String(txt || "").normalize("NFKC").replace(/…/g, "...").replace(/[‐-―−]/g, "-").toUpperCase();
    // Sortörés: „¶” szakaszhatár, KIVÉVE ha a jelölés láthatóan a következő sorban folytatódik (az előző sor „EX”-re / védelmi módra végződik,
    // vagy a következő csoporttal / T-osztállyal / EPL-lel / „[”-rel kezdődik). A ¶ CSAK az Ex-szakaszok határolására szolgál; minden más szabálynál szóköz.
    {
      const CONT = /^(?:\[|\(|°|\.{2,}|[IL1]{2,3}\s*[ABC]?\b|T\s*[1-6*]|T\s*\d[\dO]{1,2}|[GD]\s*[ABC]\b(?!\s*[(\d~=.])|(?:DA|DB|DC|EB|EC|IA|IB|IC|NA|NC|NR|MA|MB|MC|TA|TB|TC|PXB|PYB|PZC)\b(?!\s*[(\d~=.])|[DEIMNOPQ](?:\s+[DEIMNOPQ])*\s+(?:III?[ABC]?\b|\[))/;
      const ENDS = /(?:\bE?EX|\b(?:DA|DB|DC|EB|EC|IA|IB|IC|NA|NC|NR|MA|MB|MC|TA|TB|TC|PXB|PYB|PZC|II[ABC]?|III[ABC]?)|\bT\s*\d[\dO]{1,2}|III?[ABC]|[IL1]{2,3}C)\s*$/;
      const ls = t.split(/\r?\n/).map(x => x.replace(/[ \t]+/g, " ").trim()).filter(Boolean);
      t = ls.map((x, i) => i === 0 ? x : ((ENDS.test(ls[i - 1]) || CONT.test(x)) ? " " : " ¶ ") + x).join("");
    }
    t = t.replace(/\b[0-9O]*\d[0-9O]*\b/g, w => w.replace(/O/g, "0")).replace(/(\d)O(?=[\dO]|\b|°)/g, "$10").replace(/(\d)O(?=[\dO]|\b|°)/g, "$10")   // O→0 számokban
         .replace(/\b[L1]ECEX\b/g, "IECEX").replace(/\b[L1]P\s*(?=\d{2}\b)/g, "IP").replace(/\/\s*[L1]P(?=\d{2}\b)/g, "/IP")
         .replace(/\bE?E[XK](?=\s|\[|$)/g, "EX").replace(/\bEX(?=(?:DA|DB|DC|EB|EC|IA|IB|IC|TA|TB|TC|NA|NC|NR|MA|MB|MC|PXB|PYB|PZC)\b)/g, "EX ")
         .replace(/\b(\d{2})ATEX/g, "$1 ATEX");
    // Összetapadt OCR-kimenet (pl. PaddleOCR / szóköz nélküli tábla) szétbontása: „EXDBIAIICT6...T1GA/GB”, „0034XSIRA16ATEX”, „1/2GEX”
    t = t.replace(/(\d[XU])(?=[A-Z]{2,}\d)/g, "$1 ").replace(/(\d\s*\)?\s*[GD])(?=EX)/g, "$1 ").replace(/([A-Z0-9])(?=IECEX)/g, "$1 ")
         .replace(/\bE[XK](?=[A-Z\[])([A-Z0-9.\/*°\[\]]+)/g, (m, rest) => { const u = unglue(rest); return u === null ? m : "EX " + u; })
         .replace(/\bEX\s+([A-Z][A-Z0-9.\/*°]{2,})/g, (m, rest) => { const u = unglue(rest); return u === null ? m : "EX " + u; })
         .replace(/\b(T[1-6])(G[ABC]|D[ABC])\b/g, "$1 $2")
         // „EXDBIA IIC …”: csak kétbetűs védelmi-mód kódokból álló tapadás, ha utána csoport / T / EPL következik
         .replace(/\bEX((?:PXB|PYB|PZC|DA|DB|DC|EB|EC|IA|IB|IC|NA|NC|NR|MA|MB|MC|TA|TB|TC)+)(?=\s+(?:III?[ABC]?(?:\b|T)|[IL1]{2,3}[ABC]\b|T[1-6\d*]|[GD][ABC]\b))/g,
                  (m, p) => "EX " + p.match(/PXB|PYB|PZC|DA|DB|DC|EB|EC|IA|IB|IC|NA|NC|NR|MA|MB|MC|TA|TB|TC/g).join(" "))
         .replace(/\b(I{2,3}[ABC])(?=T[\d*])/g, "$1 ");   // „IIICT*C”, „IICT6” → csoport + hőmérséklet
    // csoport-jelölés OCR-hibái (lI, 1I, IlC…) csak „EX …” szakaszon belül és ATEX-kategóriánál
    const PT = "DA|DB|DC|EB|EC|IA|IB|IC|NA|NC|NR|MA|MB|MC|TA|TB|TC|PXB|PYB|PZC";
    const fixGrp = seg => seg.replace(new RegExp(`\\b(${PT})\\s*\\/\\s*(?=(?:${PT})\\b)`, "g"), "$1 ").replace(/\b(DA|DB|DC|EB|EC|IA|IB|IC|NA|NC|NR|MA|MB|MC|TA|TB|TC|PXB|PYB|PZC)([IL1]{2,3})([ABC])\b/g, (m, a, b, c) => a + " " + (b.length === 3 ? "III" : "II") + c).replace(/\b(?!111)[IL1]{3}(?=\s*[ABC]\b)/g, "III").replace(/\b(?!11)[IL1]{2}(?=\s*[ABC]\b)/g, "II")
                             .replace(/\b(?!111)([IL1]{3})([ABC])\b/g, "III$2").replace(/\b(?!11)([IL1]{2})([ABC])\b/g, "II$2")
                             .replace(/\b(DA|DB|DC|EB|EC|IA|IB|IC|NA|NC|NR|MA|MB|MC|TA|TB|TC|PXB|PYB|PZC)(III?[ABC]?)\b/g, "$1 $2")
                             .replace(/\bT\s+([1-6])\b/g, "T$1").replace(/\bT([1-6])\s*(?:\.\s*){1,3}\s*T([1-6])(?![0-9])/g, "T$1...T$2");
    t = t.replace(/\b(I{2,3})\s([ABC])\b(?=\s*(?:T[\d*]|[GD][ABC]\b|¶|$))/g, "$1$2");   // „II B T4” → „IIB T4”
    t = t.replace(/\b[IL1]{2}\s*(?=\(?\d\)?\s*(?:\/\s*\d\s*)?(?:\(\d\)\s*)?[GD]\b)/g, "II ");
    const tSec = t; t = t.replace(/\s*¶\s*/g, " ");
    // 2) Ex-szakaszok: „EX …” a következő EX / ATEX-kategória / „|” / sorvég előtt; szögletes zárójeles rész = társított áramkör
    const PROT = /^(DA|DB|DC|D|EB|EC|E|IA|IB|IC|I|NA|NC|NR|N|PXB|PYB|PZC|PX|PY|PZ|P|MA|MB|MC|M|TA|TB|TC|T|O|Q|OP)$/;
    const segs = [], assoc = [];
    const body = t.replace(/\[[^\]]*\]/g, m => { assoc.push(m); return " "; }), bodySec = tSec.replace(/\[[^\]]*\]/g, " ");
    for (const m of bodySec.matchAll(/\bEX\b([^|¶]*?)(?=¶|\bEX\b|\bII\s*\(?\d|\||\bIP\s*\d|\bTA\b|\bT\s*AMB|\bCABLE\b|\bIECEX\b|\b[A-Z]{2,12}\s*\d{2}\s*\.?\s*ATEX\b|\bCLASS\b|\bUI\b|\bU[IO]\s*[=≤<]|$)/g)) segs.push(fixGrp(m[1]).trim());
    if (assoc.length) notes.push(`Szögletes zárójeles (társított / kimeneti áramköri) jelölés figyelmen kívül: ${assoc.join(" ").replace(/\s+/g, " ")}`);
    const fam = new Set(), gas = [], dust = [];
    for (const sg of segs) {
      const tok = sg.split(/[\s,;]+/).filter(Boolean); const prot = [];
      const OLD = /^[DEIMNOPQ]{2,3}$/;   // régi összevont jelölés: „Ex de”, „Ex dem”
      let i = 0; while (i < tok.length && (PROT.test(tok[i]) || OLD.test(tok[i]))) { prot.push(tok[i]); i++; }
      if (!prot.length) continue;
      for (const p of prot) { if (PROT.test(p)) fam.add(p === "OP" ? "OP" : p[0]); else for (const ch of p) fam.add(ch); }
      const rest = tok.slice(i).join(" ");
      const isDust = /\bD[ABC]\b(?!\s*[(\d~])/.test(rest) || prot.every(p => p[0] === "T");   // por-szakasz: Ex t… vagy Dx EPL (önmagában a IIIx nem elég)
      (isDust ? dust : gas).push({ prot, rest });
    }
    const FAM = { D: "Ex d (da/db/dc)", E: "Ex e (eb/ec)", I: "Ex i (ia/ib/ic)", N: "Ex n (nA/nC/nR)", P: "Ex p (pxb/pyb/pzc)", M: "Ex m (ma/mb/mc)", T: "Ex t (ta/tb/tc)", O: "Ex o", Q: "Ex q", OP: "Ex op" };
    const gasHint = /\bG[ABC]\b|\bII\s*\(?\d[^G]{0,6}G\b|\dG\s*E[XK]|T[1-6]\s*G[ABC]\b/.test(body);   // összetapadt OCR-blokk is („L2GEXDB…T6GB”)
    if (fam.size === 1 && [...fam][0] === "T" && !gas.length && gasHint) notes.push("Csak a por-jelölés (Ex t) olvasható, de a táblán gáz-jelölés is van – a védelmi módot kézzel add meg.");
    else if (fam.size === 1) out.mod = FAM[[...fam][0]]; else if (fam.size > 1) out.mod = "Kombinált (több mód)";
    else if (assoc.length) notes.push("Csak társított (szögletes zárójeles) jelölés – a védelmi módot kézzel add meg.");
    else if (/\bEX\b/.test(t)) notes.push("Ex-jelölés van, de a védelmi mód nem olvasható.");
    const minOf = (arr, order) => arr.length ? arr.sort((x, y) => order.indexOf(x) - order.indexOf(y))[0] : null;
    // 3) Gáz: EPL, csoport, T-osztály
    const gEpl = [], gGrp = [], gT = [];
    for (const g of gas) {
      let m;
      if ((m = /\bG([ABC])\s*\/\s*G([ABC])\b/.exec(g.rest))) { const w = m[1] > m[2] ? m[1] : m[2]; gEpl.push("G" + w.toLowerCase()); notes.push(`EPL G${m[1].toLowerCase()}/G${m[2].toLowerCase()} → a ház EPL-je: G${w.toLowerCase()}`); }
      else for (const x of g.rest.matchAll(/\bG([ABC])\b(?![(\d~])/g)) gEpl.push("G" + x[1].toLowerCase());
      for (const x of g.rest.matchAll(/\bII([ABC])?\b/g)) gGrp.push("II" + (x[1] || ""));
      if ((m = /\bT([1-6])\s*(?:\.\.\.|-|\/)\s*(?:T[1-6]\s*\/\s*)?T([1-6])\b/.exec(g.rest))) { const lo = Math.min(+m[1], +m[2]); gT.push(lo); notes.push(`T${m[1]}…T${m[2]} → konzervatívan T${lo} (Ta / folyamathőmérséklet-függő; a gyártói táblázatból igazolandó)`); }
      else if (/\bT[1-6]\s*\.{1,3}(?!\s*T[1-6])/.test(g.rest)) notes.push("A T-osztály tartománya nem olvasható teljesen (pl. „T6…”) – a T-osztályt kézzel add meg.");
      else { for (const x of g.rest.matchAll(/\bT([1-6])\b(?!\s*\d|\s*°)/g)) gT.push(+x[1]); }
      if ((m = /\bT\s*(\d{2,3})\s*°\s*C\b/.exec(g.rest))) notes.push(`Gázjelölésben tényleges max. felületi hőmérséklet (T${m[1]}°C) – a T-osztályt kézzel add meg (MSZ EN IEC 60079-0 szerinti besorolás).`);
    }
    if (gEpl.length) out.eg = minOf([...new Set(gEpl)], ["Gc", "Gb", "Ga"]);   // több szakasz: a legkevésbé szigorú (konzervatív)
    if (gGrp.length) { const gs = [...new Set(gGrp)]; out.dg = minOf(gs.filter(x => x !== "II"), ["IIA", "IIB", "IIC"]) || "II"; if (gs.filter(x => x !== "II").length > 1) notes.push(`Több eltérő gázcsoport a szövegben (${gs.join(", ")}) → konzervatívan ${out.dg} – a táblán ellenőrizd.`); }
    // Ta-függő T-osztály-táblázat a szakaszokon kívül (pl. „T6: Ta ≤ 40 °C; T5: Ta ≤ 55 °C”) → a legkedvezőtlenebb osztály
    const tab = [...t.matchAll(/\bT([1-6])\s*[:;,]/g)].map(x => +x[1]);
    if (gT.length && tab.length) { const all = gT.concat(tab); if (new Set(all).size > 1) { notes.push(`Ta-függő T-osztály-táblázat a szövegben (${[...new Set(all)].sort().reverse().map(x => "T" + x).join(", ")}) → konzervatívan T${Math.min(...all)}`); gT.push(...tab); } }
    if (gT.length) { const lo = Math.min(...gT); out.dt = "T" + lo; if (new Set(gT).size > 1 && !notes.some(n => n.includes("konzervatívan"))) notes.push(`Több T-osztály a jelölésben (Ta-függő) → konzervatívan T${lo}`); }
    // 4) Por: EPL, csoport, max. felületi hőmérséklet
    const dEpl = [], dGrp = [], dTc = [];
    for (const d of dust) {
      let m;
      if ((m = /\bD([ABC])\s*\/\s*D([ABC])\b/.exec(d.rest))) { const w = m[1] > m[2] ? m[1] : m[2]; dEpl.push("D" + w.toLowerCase()); notes.push(`EPL D${m[1].toLowerCase()}/D${m[2].toLowerCase()} → a ház EPL-je: D${w.toLowerCase()}`); }
      else for (const x of d.rest.matchAll(/\bD([ABC])\b(?!\s*[(\d~])/g)) dEpl.push("D" + x[1].toLowerCase());
      for (const x of d.rest.matchAll(/\bIII([ABC])\b/g)) dGrp.push("III" + x[1]);
      const tl = /\bT\s*(\d{2,3})\s+(\d{2,3})\s*°\s*C\b/.exec(d.rest);
      if (tl) notes.push(`Rétegvastagság-függő jelölés (T${tl[1]} ${tl[2]}°C) – a max. felületi hőmérsékletet kézzel add meg.`);
      else for (const x of d.rest.matchAll(/\bT\s*(\d{2,3})\s*°\s*C\b/g)) dTc.push(+x[1]);
      if (/\bT\s*\*+\s*°?\s*C/.test(d.rest)) notes.push("Por: „T**°C” – a hőmérséklet a táblán nincs kitöltve (gyártói dokumentáció szükséges).");
    }
    if (dEpl.length) out.ep = minOf([...new Set(dEpl)], ["Dc", "Db", "Da"]);
    if (dGrp.length) out.dp = minOf([...new Set(dGrp)], ["IIIA", "IIIB", "IIIC"]);
    if (dTc.length) out.dtc = String(Math.max(...dTc));
    // 5) ATEX-kategória (ha nincs EPL): „II 1/2 G” → 2G; „II 2(1) G” → 2G; „II (1) G” = társított
    for (const m of t.matchAll(/\bII\s*(\(?)(\d)(\)?)\s*(?:\/\s*(\d)\s*)?(?:\((\d)\)\s*)?([GD])\b/g)) {
      if (m[1] && m[3]) { notes.push(`ATEX „II (${m[2]}) ${m[6]}” = társított készülék kategóriája – nem a készüléké.`); continue; }
      const cat = (m[4] || m[2]) + m[6];
      if (m[6] === "G" && !out.eg) { out.eg = cat; if (m[4]) notes.push(`Kategória ${m[2]}/${m[4]}G → ${cat}`); }
      if (m[6] === "D" && !out.ep) out.ep = cat;
    }
    // 6) IP és tanúsítvány
    const ip = /\bIP\s*(\d{2})((?:\s*\/\s*(?:IP\s*)?\d{2})*)/.exec(t); if (ip) out.ip = ip[0].replace(/\s+/g, "");
    const certs = [];
    const d0 = x => x.replace(/O/g, "0").replace(/\s/g, "");   // számcsoportban O→0 (OCR)
    for (const m of t.matchAll(/\b([A-ZÄÖÜ][A-ZÄÖÜ0-9]{1,11}?)\s*([0-9O]{2})\s*\.?\s*ATEX\s*(E\s+|[A-DF-NP-Z]\s*)?((?:[0-9O]\s?){3,7})\s*([XU]?)(?![A-Z0-9])/g)) {
      if (m[1] === "IECEX") continue;
      const sfx = m[3] ? m[3].trim() + " " : "";
      certs.push(`${m[1]} ${d0(m[2])} ATEX ${sfx}${d0(m[4])}${m[5] ? " " + m[5] : ""}`); }
    for (const m of t.matchAll(/\bIECEX\s*([A-Z]{2,6})\s*([0-9O]{2})\s*\.\s*([0-9O]{3,4})\s*([XU]?)(?![A-Z0-9])/g)) certs.push(`IECEx ${m[1]} ${d0(m[2])}.${d0(m[3])}${m[4] || ""}`);
    if (certs.length) out.cert = [...new Set(certs)].join(" | ");
    if (!/\bEX\b/.test(t) && !/\bII\s*\(?\d/.test(t)) notes.push("Nem található Ex-jelölés a beolvasott szövegben – ha a táblán valóban nincs, a „NINCS Ex-JELÖLÉS” kézzel választandó.");
    return { fields: out, notes };
  }
  function proposeFromMarking(txt) {
    const r = parseMarking(txt), f = r.fields, out = {};
    const chk = { mod: LISTS.mod, eg: LISTS.eg, ep: LISTS.ep, dg: LISTS.dg, dp: LISTS.dp, dt: LISTS.dt };
    for (const k of Object.keys(f)) { if (chk[k] && !chk[k].includes(f[k])) { r.notes.push(`${k}: „${f[k]}” nem listaérték – kihagyva`); continue; } out[k] = String(f[k]); }
    return { fields: out, notes: r.notes };
  }

  // Kanonikus JSON (Python json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False) megfelelője)
  function canon(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  }
  function safeName(x) { return norm(x).replace(/[^A-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "NA"; }

  const api = { LISTS, RES_EXCEL, PHOTO_TYPES, evaluate, validate, search, buildIndex, score, matchKind, candidates, fold, pairInfo, buildPairs, parseMarking, proposeFromMarking, canon, safeName, norm, compact };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.ExLogic = api;
})(typeof self !== "undefined" ? self : this);
