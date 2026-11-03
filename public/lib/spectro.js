import { fitLine, lineK } from './physics.js';

export const FS = 4000;
const FMIN = 40, FMAX = 400, THR = 3;

function fftTables(n) {
  const rev = new Uint32Array(n), bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) [cos[i], sin[i]] = [Math.cos((2 * Math.PI * i) / n), -Math.sin((2 * Math.PI * i) / n)];
  return { rev, cos, sin };
}

function fft(re, im, { rev, cos, sin }) {
  const n = re.length;
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size)
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j, b = a + half;
        const tr = re[b] * cos[k] - im[b] * sin[k], ti = re[b] * sin[k] + im[b] * cos[k];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
  }
}

// Log power in FMIN..FMAX. 1 s Hann window zero padded to 0.49 Hz bins, 0.25 s hop.
export function spectrogram(x, fs = FS, win = 4096, nfft = 8192, hopS = 0.25) {
  const hop = Math.round(hopS * fs), df = fs / nfft;
  const b0 = Math.ceil(FMIN / df), B = Math.floor(FMAX / df) - b0 + 1;
  const F = Math.max(0, Math.floor((x.length - win) / hop) + 1);
  const L = new Float32Array(F * B), tab = fftTables(nfft), re = new Float64Array(nfft), im = new Float64Array(nfft);
  const w = new Float64Array(win).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1)));
  for (let f = 0; f < F; f++) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < win; i++) re[i] = x[f * hop + i] * w[i];
    fft(re, im, tab);
    for (let b = 0; b < B; b++) L[f * B + b] = Math.log10(re[b0 + b] ** 2 + im[b0 + b] ** 2 + 1e-12);
  }
  return { F, B, b0, df, dt: hop / fs, t0: win / 2 / fs, L };
}

const median = (a) => {
  const s = Float32Array.from(a).sort();
  return s[s.length >> 1];
};

// Robust z-score per bin (kills steady hum), then per-frame median removal (kills broadband bursts).
function whiten({ F, B, L }) {
  const Z = new Float32Array(F * B), col = new Float32Array(F);
  for (let b = 0; b < B; b++) {
    for (let f = 0; f < F; f++) col[f] = L[f * B + b];
    const m = median(col), mad = median(col.map((v) => Math.abs(v - m))) * 1.4826 + 1e-6;
    for (let f = 0; f < F; f++) Z[f * B + b] = (L[f * B + b] - m) / mad;
  }
  for (let f = 0; f < F; f++) {
    const row = Z.subarray(f * B, (f + 1) * B), m = median(row);
    for (let b = 0; b < B; b++) row[b] = Math.min(10, Math.max(-4, row[b] - m));
  }
  return Z;
}

// Best continuous ridge through the whole spectrogram.
function viterbi(Z, F, B, J = 4, lam = 0.3) {
  const back = new Int16Array(F * B);
  let prev = Z.slice(0, B), cur = new Float32Array(B);
  for (let f = 1; f < F; f++) {
    for (let b = 0; b < B; b++) {
      let best = -Infinity, arg = b;
      for (let d = -J; d <= J; d++) {
        const p = b + d;
        if (p < 0 || p >= B) continue;
        const v = prev[p] - lam * Math.abs(d);
        if (v > best) [best, arg] = [v, p];
      }
      cur[b] = best + Z[f * B + b];
      back[f * B + b] = arg;
    }
    [prev, cur] = [cur, prev];
  }
  const path = new Int32Array(F);
  path[F - 1] = prev.indexOf(Math.max(...prev));
  for (let f = F - 1; f > 0; f--) path[f - 1] = back[f * B + path[f]];
  return path;
}

// Runs of frames where the ridge stands out, gaps up to 3 s bridged, at least 8 s long.
function segments(Z, path, F, B) {
  const raw = Float32Array.from(path, (b, f) => Z[f * B + b]), sm = new Float32Array(F), W = 4;
  for (let f = 0; f < F; f++) {
    let s = 0, n = 0;
    for (let j = Math.max(0, f - W); j <= Math.min(F - 1, f + W); j++) [s, n] = [s + raw[j], n + 1];
    sm[f] = s / n;
  }
  const out = [];
  let a = -1, lastOn = -1;
  for (let f = 0; f <= F; f++) {
    const on = f < F && sm[f] > THR;
    if (on) {
      if (a < 0 || f - lastOn > 12) {
        if (a >= 0 && lastOn - a >= 32) out.push([a, lastOn]);
        a = f;
      }
      lastOn = f;
    }
  }
  if (a >= 0 && lastOn - a >= 32) out.push([a, lastOn]);
  return { out, raw };
}

function mask(Z, B, b0, path, a, b, ks) {
  for (let f = a; f <= b; f++)
    for (const k of ks) {
      const c = Math.round((b0 + path[f]) * k) - b0, w = Math.ceil(4 * k);
      for (let j = Math.max(0, c - w); j <= Math.min(B - 1, c + w); j++) Z[f * B + j] = -4;
    }
}

// Light planes turn and a ridge can run for minutes, so a straight pass only holds near closest approach.
// Fit windows around each steep pitch drop, keeping the widest window that still fits.
function fitPasses(ts, fq) {
  const n = ts.length, sl = new Float64Array(n), out = [];
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
    for (let j = 0; j < n; j++) {
      if (Math.abs(ts[j] - ts[i]) > 2) continue;
      [sx, sy, sxx, sxy, m] = [sx + ts[j], sy + fq[j], sxx + ts[j] ** 2, sxy + ts[j] * fq[j], m + 1];
    }
    const den = m * sxx - sx * sx;
    sl[i] = m >= 5 && den > 0 ? (m * sxy - sx * sy) / den / fq[i] : 0;
  }
  const cands = [];
  for (let i = 0; i < n; i++) if (sl[i] < -1e-3 && sl.every((s, j) => Math.abs(ts[j] - ts[i]) > 10 || s >= sl[i])) cands.push(i);
  cands.sort((a, b) => sl[a] - sl[b]);
  for (const c of cands.slice(0, 4)) {
    let best = null;
    for (const W of [15, 25, 40, 60]) {
      const ix = [];
      for (let i = 0; i < n; i++) if (Math.abs(ts[i] - ts[c]) <= W) ix.push(i);
      if (ix.length < 24) continue;
      const t = ix.map((i) => ts[i]), f = ix.map((i) => fq[i]), fit = fitLine(t, f), t1 = t[0], t2 = t[t.length - 1];
      if (fit.rmsRel < 0.012 && fit.v >= 15 && fit.d < 15000 && fit.tc > t1 + 1.5 && fit.tc < t2 - 1.5 && Math.abs(fit.tc - ts[c]) < 6) best = { fit, t, f };
      else if (best) break;
    }
    if (best && !out.some((e) => Math.abs(e.fit.tc - best.fit.tc) < 10)) out.push(best);
  }
  return out;
}

const pick = (a, m) => (a.length <= m ? a : Array.from({ length: m }, (_, i) => a[Math.round((i * (a.length - 1)) / (m - 1))]));

// Spectrogram image plus up to 3 Doppler passes, each with a straight-pass fit.
export function analyze(x, fs = FS) {
  const S = spectrogram(x, fs), { F, B, b0, df, dt, t0 } = S;
  const base = { F, B, b0, df, dt, t0, dur: x.length / fs, events: [] };
  if (F < 40) return { ...base, img: new Uint8ClampedArray(0) };
  const Z = whiten(S);
  const img = Uint8ClampedArray.from(Z, (z) => ((z + 1) / 8) * 255);
  const fr = (t) => Math.round((t - t0) / dt);
  for (let iter = 0; iter < 8 && base.events.length < 6; iter++) {
    const path = viterbi(Z, F, B);
    const { out, raw } = segments(Z, path, F, B);
    if (!out.length) break;
    for (const [a, b] of out) {
      const ts = [], fq = [];
      for (let f = a; f <= b; f++) {
        if (raw[f] < THR * 0.6) continue;
        const p = path[f], l = Z[f * B + Math.max(0, p - 1)], c = Z[f * B + p], r = Z[f * B + Math.min(B - 1, p + 1)];
        const den = l - 2 * c + r, delta = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)) : 0;
        ts.push(t0 + f * dt);
        fq.push((b0 + p + delta) * df);
      }
      mask(Z, B, b0, path, Math.max(0, a - 8), Math.min(F - 1, b + 8), [1]);
      for (const { fit, t, f } of ts.length >= 24 ? fitPasses(ts, fq) : []) {
        const t1 = t[0], t2 = t[t.length - 1], curve = [];
        for (let u = t1; u <= t2; u += 0.5) curve.push([u, fit.f0 * lineK(u, fit.v, fit.d, fit.tc)]);
        base.events.push({ ...fit, seg: [t1, t2], pts: pick(t.map((u, i) => [u, f[i]]), 120), curve });
        mask(Z, B, b0, path, Math.max(0, fr(t1) - 8), Math.min(F - 1, fr(t2) + 8), [1 / 3, 1 / 2, 2, 3]);
      }
    }
  }
  // Slower than any light plane flies = a bad fit. Within 10 s = the same plane fitted twice; keep the widest fit, a short window fits anything.
  const ev = base.events.filter((e) => e.v >= 22);
  base.events = ev.filter((e) => !ev.some((o) => o !== e && Math.abs(o.tc - e.tc) < 10 && o.seg[1] - o.seg[0] > e.seg[1] - e.seg[0]));
  base.events.sort((p, q) => p.tc - q.tc);
  return { ...base, img };
}
