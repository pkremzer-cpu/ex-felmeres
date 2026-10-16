/* Ex-felmérés – offline szövegfelismerés (PP-OCRv3 det + rec, ONNX Runtime Web).
   Tiszta JS, böngészőben és Node-ban is fut; a képet RGBA tömbként kapja ({data, width, height}).
   Lépések (RapidOCR / PaddleOCR referencia szerint): szövegdetektálás (DB) → dobozok → kivágás (álló dobozt 90°-kal elforgat)
   → felismerés (CTC) → sorok fentről lefelé. Nincs hálózat, nincs adatküldés. */
(function (root) {
  "use strict";
  const DEF = { detMin: 736, detMax: 2560, detThresh: 0.3, boxThresh: 0.5, unclip: 1.6, minSize: 3, recH: 48, recMinW: 0, textScore: 0.5, rgb: true, recBatch: 6, clsThresh: 0.9 };

  function resize(img, w, h) {   // bilineáris átméretezés RGBA-ra
    const out = new Uint8ClampedArray(w * h * 4), sw = img.width, sh = img.height, src = img.data;
    const fx = sw / w, fy = sh / h;
    for (let y = 0; y < h; y++) {
      const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5)), y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), wy = sy - y0;
      for (let x = 0; x < w; x++) {
        const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5)), x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), wx = sx - x0;
        const i00 = (y0 * sw + x0) * 4, i01 = (y0 * sw + x1) * 4, i10 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4, o = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) out[o + c] = (src[i00 + c] * (1 - wx) + src[i01 + c] * wx) * (1 - wy) + (src[i10 + c] * (1 - wx) + src[i11 + c] * wx) * wy;
        out[o + 3] = 255;
      }
    }
    return { data: out, width: w, height: h };
  }
  function crop(img, x0, y0, x1, y1) {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(img.width, Math.ceil(x1)); y1 = Math.min(img.height, Math.ceil(y1));
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0), out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) out.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
    return { data: out, width: w, height: h };
  }
  function rot90ccw(img) {   // np.rot90 megfelelője (90° az óramutatóval ellentétesen)
    const w = img.width, h = img.height, out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (y * w + x) * 4, nx = y, ny = w - 1 - x, d = (ny * h + nx) * 4; out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = 255; }
    return { data: out, width: h, height: w };
  }
  // NCHW float32. rgb=true: 0. csatorna = R (a mért Python-referencia így kapta a képet); rgb=false: BGR
  function toTensor(img, mean, std, rgb) {
    const n = img.width * img.height, t = new Float32Array(3 * n), d = img.data, c0 = rgb ? 0 : 2, c2 = rgb ? 2 : 0;
    for (let i = 0; i < n; i++) { t[i] = (d[i * 4 + c0] / 255 - mean[0]) / std[0]; t[n + i] = (d[i * 4 + 1] / 255 - mean[1]) / std[1]; t[2 * n + i] = (d[i * 4 + c2] / 255 - mean[2]) / std[2]; }
    return t;
  }
  // kép → [3,H,W] tenzor-szelet: magasság H-ra skálázva arányosan (max rw), jobbra nullával kitöltve
  function fillLine(t, off, W, H, img, rw, rgb) {
    const r = resize(img, Math.max(1, rw), H), n = H * W, c0 = rgb ? 0 : 2, c2 = rgb ? 2 : 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < rw; x++) { const s = (y * rw + x) * 4, i = off + y * W + x;
      t[i] = (r.data[s + c0] / 255 - 0.5) / 0.5; t[n + i] = (r.data[s + 1] / 255 - 0.5) / 0.5; t[2 * n + i] = (r.data[s + c2] / 255 - 0.5) / 0.5; }
  }
  function convexHull(P) {   // monoton lánc
    const p = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (p.length < 3) return p;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    up.pop(); lo.pop(); return lo.concat(up);
  }
  function minAreaRect(H) {
    if (H.length < 3) return null; let best = null;
    for (let i = 0; i < H.length; i++) {
      const a = H[i], b = H[(i + 1) % H.length], ang = Math.atan2(b[1] - a[1], b[0] - a[0]), c = Math.cos(ang), s = Math.sin(ang);
      let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
      for (const p of H) { const u = p[0] * c + p[1] * s, v = -p[0] * s + p[1] * c; if (u < mnx) mnx = u; if (u > mxx) mxx = u; if (v < mny) mny = v; if (v > mxy) mxy = v; }
      const area = (mxx - mnx) * (mxy - mny);
      if (!best || area < best.area) { const cu = (mnx + mxx) / 2, cv = (mny + mxy) / 2; best = { area, w: mxx - mnx, h: mxy - mny, ang, cx: cu * c - cv * s, cy: cu * s + cv * c }; }
    }
    return best;
  }
  // RapidOCR box_score_fast: cv2.fillPoly maszk (int32-csonkított csúcsok; belső pásztázás + 8-szomszédos élvonalak) alatti átlag
  function polyMean(prob, w, h, Qf) {
    const xs = Qf.map(p => p[0]), ys = Qf.map(p => p[1]);
    const x0 = Math.max(0, Math.min(w - 1, Math.floor(Math.min(...xs)))), x1 = Math.max(0, Math.min(w - 1, Math.ceil(Math.max(...xs))));
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(Math.min(...ys)))), y1 = Math.max(0, Math.min(h - 1, Math.ceil(Math.max(...ys))));
    const W = x1 - x0 + 1, H = y1 - y0 + 1, m = new Uint8Array(W * H);
    const Q = Qf.map(([x, y]) => [Math.trunc(x - x0), Math.trunc(y - y0)]);
    for (let y = 0; y < H; y++) { let lo = Infinity, hi = -Infinity, n = 0;
      for (let k = 0; k < 4; k++) { const a = Q[k], c = Q[(k + 1) % 4]; if (a[1] === c[1]) continue;
        if (Math.min(a[1], c[1]) <= y && y < Math.max(a[1], c[1])) { const xx = a[0] + (c[0] - a[0]) * (y - a[1]) / (c[1] - a[1]); lo = Math.min(lo, xx); hi = Math.max(hi, xx); n++; } }
      if (n < 2) continue; const l = Math.max(0, Math.ceil(lo)), r = Math.min(W - 1, Math.floor(hi)); for (let x = l; x <= r; x++) m[y * W + x] = 1; }
    for (let k = 0; k < 4; k++) { const a = Q[k], c = Q[(k + 1) % 4], n = Math.max(Math.abs(c[0] - a[0]), Math.abs(c[1] - a[1]));
      for (let i = 0; i <= n; i++) { const t = n ? i / n : 0, xi = Math.floor(a[0] + (c[0] - a[0]) * t + 0.5), yi = Math.floor(a[1] + (c[1] - a[1]) * t + 0.5);
        if (xi >= 0 && yi >= 0 && xi < W && yi < H) m[yi * W + xi] = 1; } }
    let s = 0, c = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) { s += prob[(y + y0) * w + x + x0]; c++; }
    return c ? s / c : 0;
  }
  function rhe(v) { const f = Math.floor(v), r = v - f; return r > 0.5 ? f + 1 : r < 0.5 ? f : (f % 2 === 0 ? f : f + 1); }   // np.round (páros felé)
  // pyclipper JT_ROUND / ET_CLOSEDPOLYGON offset (ArcTolerance 0.25) pontos emulációja egész koordinátákon
  function clipperRound(box, d) {
    let P = box.map(([x, y]) => [Math.trunc(x), Math.trunc(y)]); const n = P.length;
    let A = 0; for (let i = 0; i < n; i++) A += P[i][0] * P[(i + 1) % n][1] - P[(i + 1) % n][0] * P[i][1];
    if (A < 0) P = P.slice().reverse();
    const N = P.map((a, i) => { const b = P[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1; return [dy / L, -dx / L]; });
    const steps = Math.PI / Math.acos(1 - 0.25 / Math.abs(d)), spr = steps / (2 * Math.PI), sn = Math.sin(2 * Math.PI / steps), cs = Math.cos(2 * Math.PI / steps), out = [];
    const R = v => Math.sign(v) * Math.floor(Math.abs(v) + 0.5);   // Clipper Round
    for (let j = 0; j < n; j++) { const k = (j + n - 1) % n;
      const sinA = N[k][0] * N[j][1] - N[j][0] * N[k][1], cosA = N[k][0] * N[j][0] + N[j][1] * N[k][1], st = Math.max(Math.round(spr * Math.abs(Math.atan2(sinA, cosA))), 1);
      let X = N[k][0], Y = N[k][1];
      for (let i = 0; i < st; i++) { out.push([R(P[j][0] + X * d), R(P[j][1] + Y * d)]); const X2 = X * cs - sn * Y; Y = X * sn + Y * cs; X = X2; }
      out.push([R(P[j][0] + N[j][0] * d), R(P[j][1] + N[j][1] * d)]); }
    return out;
  }
  function rectCorners(cx, cy, w, h, ang) { const c = Math.cos(ang), s = Math.sin(ang), hw = w / 2, hh = h / 2;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([u, v]) => [cx + u * c - v * s, cy + u * s + v * c]); }
  function orderQuad(pts) {   // bal-felső, jobb-felső, jobb-alsó, bal-alsó (RapidOCR get_mini_boxes szerint)
    const p = pts.slice().sort((a, b) => a[0] - b[0]);
    const [l1, l2] = p[0][1] <= p[1][1] ? [p[0], p[1]] : [p[1], p[0]], [r1, r2] = p[2][1] <= p[3][1] ? [p[2], p[3]] : [p[3], p[2]];
    return [l1, r1, r2, l2];
  }
  // cv2.warpPerspective(INTER_CUBIC, BORDER_REPLICATE) megfelelője a RapidOCR get_rotate_crop_image-hez
  function cubW(t) { const A = -0.75, x = Math.abs(t); return x <= 1 ? ((A + 2) * x - (A + 3)) * x * x + 1 : x < 2 ? ((A * x - 5 * A) * x + 8 * A) * x - 4 * A : 0; }
  function persp(src, dst) {   // 4 pont → 3×3 homográfia (dst → src irányú leképezéshez src és dst felcserélve hívandó)
    const A = [], B = [];
    for (let i = 0; i < 4; i++) { const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u); A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v); }
    for (let c = 0; c < 8; c++) { let m = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[m][c])) m = r;
      [A[c], A[m]] = [A[m], A[c]]; [B[c], B[m]] = [B[m], B[c]];
      for (let r = 0; r < 8; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k]; B[r] -= f * B[c]; } }
    const h = B.map((b, i) => b / A[i][i]); return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }
  function warpQuad(img, q) {
    const [tl, tr, br, bl] = q, dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const W = Math.max(1, Math.floor(Math.max(dist(tl, tr), dist(bl, br)))), H = Math.max(1, Math.floor(Math.max(dist(tl, bl), dist(tr, br))));
    const M = persp([[0, 0], [W, 0], [W, H], [0, H]], q);   // cél → forrás
    const out = new Uint8ClampedArray(W * H * 4), sw = img.width, sh = img.height, d = img.data, wx = [0, 0, 0, 0], wy = [0, 0, 0, 0];
    const cx = v => v < 0 ? 0 : v >= sw ? sw - 1 : v, cy = v => v < 0 ? 0 : v >= sh ? sh - 1 : v;
    for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
      const z = M[6] * u + M[7] * v + M[8], x = (M[0] * u + M[1] * v + M[2]) / z, y = (M[3] * u + M[4] * v + M[5]) / z;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      for (let k = 0; k < 4; k++) { wx[k] = cubW(fx - (k - 1)); wy[k] = cubW(fy - (k - 1)); }
      const o = (v * W + u) * 4;
      for (let c = 0; c < 3; c++) { let acc = 0;
        for (let j = 0; j < 4; j++) { const row = cy(y0 + j - 1) * sw; let ra = 0; for (let k = 0; k < 4; k++) ra += d[(row + cx(x0 + k - 1)) * 4 + c] * wx[k]; acc += ra * wy[j]; }
        out[o + c] = acc; }
      out[o + 3] = 255;
    }
    return { data: out, width: W, height: H };
  }
  async function detect(ort, sess, img, o) {
    // RapidOCR „min” mód: a rövidebb oldal legalább detMin (kis kivágás felnagyítva), a hosszabb legfeljebb detMax
    let sc = Math.min(img.width, img.height) < o.detMin ? o.detMin / Math.min(img.width, img.height) : 1;
    if (Math.max(img.width, img.height) * sc > o.detMax) sc = o.detMax / Math.max(img.width, img.height);
    const w = Math.max(32, Math.round(img.width * sc / 32) * 32), h = Math.max(32, Math.round(img.height * sc / 32) * 32);
    const r = resize(img, w, h);
    const x = new ort.Tensor("float32", toTensor(r, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225], o.rgb), [1, 3, h, w]);
    const res = await sess.run({ [sess.inputNames[0]]: x }); const prob = res[sess.outputNames[0]].data;
    // bináris térkép + 2×2 dilatáció (cv2-paritás)
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (prob[i] > o.detThresh) bin[i] = 1;
    const dil = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) { const i = y * w + xx; if (bin[i] || (xx > 0 && bin[i - 1]) || (y > 0 && bin[i - w]) || (xx > 0 && y > 0 && bin[i - w - 1])) dil[i] = 1; }   // cv2.dilate 2×2, horgony (1,1)
    // összefüggő komponensek (8-szomszédság) → minimális területű elforgatott téglalap (konvex burok + forgó tolómérő)
    const lab = new Int32Array(w * h), boxes = []; let nl = 0; const st = new Int32Array(w * h);
    const sx = img.width / w, sy = img.height / h;
    for (let i0 = 0; i0 < w * h; i0++) {
      if (!dil[i0] || lab[i0]) continue; nl++; let sp = 0; st[sp++] = i0; lab[i0] = nl;
      let sum = 0, cnt = 0; const pts = [];
      while (sp) { const i = st[--sp], yy = (i / w) | 0, xx = i - yy * w; sum += prob[i]; cnt++;
        let edge = false;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const ny = yy + dy, nx = xx + dx; if (ny < 0 || nx < 0 || ny >= h || nx >= w) { edge = true; continue; } const j = ny * w + nx; if (!dil[j]) edge = true; else if (!lab[j]) { lab[j] = nl; st[sp++] = j; } }
        if (edge) pts.push([xx, yy]); }
      if (cnt < 4) continue;
      const rr = minAreaRect(convexHull(pts)); if (!rr || Math.min(rr.w, rr.h) < o.minSize) continue;
      const score = polyMean(prob, w, h, rectCorners(rr.cx, rr.cy, rr.w, rr.h, rr.ang)); if (o.dbg) o.dbg.push({ rr, score, n: pts.length }); if (score < o.boxThresh) continue;
      const d = rr.w * rr.h * o.unclip / (2 * (rr.w + rr.h));
      const ex = minAreaRect(convexHull(clipperRound(rectCorners(rr.cx, rr.cy, rr.w, rr.h, rr.ang), d)));
      if (!ex || Math.min(ex.w, ex.h) < o.minSize + 2) continue;
      const q = orderQuad(rectCorners(ex.cx, ex.cy, ex.w, ex.h, ex.ang)).map(([x, y]) => [Math.max(0, Math.min(img.width, rhe(x * sx))), Math.max(0, Math.min(img.height, rhe(y * sy)))]);
      if (Math.hypot(q[0][0] - q[1][0], q[0][1] - q[1][1]) <= 3 || Math.hypot(q[0][0] - q[3][0], q[0][1] - q[3][1]) <= 3) continue;
      boxes.push({ q, x0: Math.min(...q.map(p => p[0])), y0: Math.min(...q.map(p => p[1])), x1: Math.max(...q.map(p => p[0])), y1: Math.max(...q.map(p => p[1])), score });
    }
    boxes.sort((a, b) => (Math.abs(a.y0 - b.y0) < 10 ? a.x0 - b.x0 : a.y0 - b.y0));
    return boxes;
  }
  function ctc(p, T, C, keys, base) {
    let txt = "", last = -1, ps = 0, pc = 0;
    for (let k = 0; k < T; k++) { let bi = 0, bv = -Infinity; const o = base + k * C; for (let c = 0; c < C; c++) { const v = p[o + c]; if (v > bv) { bv = v; bi = c; } }
      if (bi !== 0 && bi !== last) { txt += bi - 1 < keys.length ? keys[bi - 1] : " "; ps += bv; pc++; } last = bi; }
    return { text: txt, score: ps / (pc + 1) };   // RapidOCR-paritás: np.mean(conf_list + [1e-50]) → osztó n+1
  }
  // RapidOCR TextRecognizer: arány szerint rendezve, 6-os kötegek, köteg-szélesség = 48·max(320/48, max arány)
  async function recognize(ort, sess, keys, imgs, o) {
    const H = o.recH, idx = imgs.map((_, i) => i).sort((a, b) => imgs[a].width / imgs[a].height - imgs[b].width / imgs[b].height), res = new Array(imgs.length);
    for (let b0 = 0; b0 < idx.length; b0 += o.recBatch) {
      const grp = idx.slice(b0, b0 + o.recBatch); let mr = o.recMinW / H;
      for (const i of grp) mr = Math.max(mr, imgs[i].width / imgs[i].height);
      const W = Math.floor(H * mr), n1 = 3 * H * W, t = new Float32Array(n1 * grp.length);
      for (let k = 0; k < grp.length; k++) { const im = imgs[grp[k]], one = new Float32Array(n1); fillLine(one, 0, W, H, im, Math.min(W, Math.ceil(H * im.width / im.height)), o.rgb); t.set(one, k * n1); }
      const out = (await sess.run({ [sess.inputNames[0]]: new ort.Tensor("float32", t, [grp.length, 3, H, W]) }))[sess.outputNames[0]];
      const [, T, C] = out.dims;
      if (o.onStage) o.onStage("rec", Math.min(idx.length, b0 + o.recBatch), idx.length);
      grp.forEach((i, k) => { res[i] = ctc(out.data, T, C, keys, k * T * C); });
    }
    return res;
  }
  // RapidOCR TextClassifier: 3×48×192, '180' címke és >clsThresh → 180°-os forgatás
  async function classify(ort, sess, imgs, o) {
    if (!sess) return imgs; const H = 48, W = 192, n1 = 3 * H * W, outImgs = imgs.slice();
    for (let b0 = 0; b0 < imgs.length; b0 += 6) {
      const grp = imgs.slice(b0, b0 + 6), t = new Float32Array(n1 * grp.length);
      grp.forEach((im, k) => { const one = new Float32Array(n1); fillLine(one, 0, W, H, im, Math.min(W, Math.ceil(H * im.width / im.height)), o.rgb); t.set(one, k * n1); });
      const out = (await sess.run({ [sess.inputNames[0]]: new ort.Tensor("float32", t, [grp.length, 3, H, W]) }))[sess.outputNames[0]].data;
      grp.forEach((im, k) => { if (out[k * 2 + 1] > out[k * 2] && out[k * 2 + 1] > o.clsThresh) outImgs[b0 + k] = rot180(im); });
    }
    return outImgs;
  }
  function rot180(img) { const d = img.data, out = new Uint8ClampedArray(d.length), n = img.width * img.height;
    for (let i = 0; i < n; i++) { const j = (n - 1 - i) * 4; out[j] = d[i * 4]; out[j + 1] = d[i * 4 + 1]; out[j + 2] = d[i * 4 + 2]; out[j + 3] = 255; }
    return { data: out, width: img.width, height: img.height }; }
  function sortBoxes(B) {   // RapidOCR sorted_boxes
    const b = B.slice().sort((p, q) => p.q[0][1] - q.q[0][1] || p.q[0][0] - q.q[0][0]);
    for (let i = 0; i < b.length - 1; i++) for (let j = i; j >= 0; j--) {
      if (Math.abs(b[j + 1].q[0][1] - b[j].q[0][1]) < 10 && b[j + 1].q[0][0] < b[j].q[0][0]) { const t = b[j]; b[j] = b[j + 1]; b[j + 1] = t; } else break; }
    return b;
  }
  // Teljes folyamat: kép → sorok (det → kivágás → cls → rec → pontszűrés)
  async function ocrImage(ort, det, rec, keys, img, opt, cls) {
    const o = Object.assign({}, DEF, opt || {});
    const st = o.onStage || (() => {});
    st("det", 0, 1);
    const boxes = sortBoxes(await detect(ort, det, img, o));
    st("rec", 0, boxes.length);
    let crops = boxes.map(b => { const c = warpQuad(img, b.q); return c.height / c.width >= 1.5 ? rot90ccw(c) : c; });
    crops = await classify(ort, cls, crops, o);
    const rr = await recognize(ort, rec, keys, crops, o), lines = [];
    boxes.forEach((b, i) => { const r = rr[i]; if (r.score >= o.textScore) lines.push({ text: r.text, score: r.score, box: b }); });
    return { text: lines.map(l => l.text).join("\n"), lines, raw: boxes.map((b, i) => ({ q: b.q, text: rr[i].text, score: rr[i].score })) };
  }
  const api = { ocrImage, detect, recognize, classify, resize, crop, rot90ccw, warpQuad, DEF };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.ExOCR = api;
})(typeof self !== "undefined" ? self : this);
