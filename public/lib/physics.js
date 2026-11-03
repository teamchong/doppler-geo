// Speed of sound near the ground, m/s.
export const C = 340;

// ADS-B samples: Hermite position, velocity linearly interpolated from reported gs/track.
// Differentiating the position curve instead amplifies position rounding into +-10 m/s jitter.
export class Track {
  constructor(meta, t, p, v) {
    this.meta = meta;
    this.t = t;
    this.p = p;
    this.v = v;
    this.n = t.length;
    this.t0 = t[0];
    this.t1 = t[this.n - 1];
    this.i = 0;
    this.s = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  }

  // Shared result object, copy fields before calling again. Null outside coverage or across gaps.
  state(tt) {
    const t = this.t, n = this.n;
    if (!(tt >= t[0] && tt <= t[n - 1])) return null;
    let i = this.i;
    if (!(t[i] <= tt && tt <= t[i + 1])) {
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (t[m] <= tt) lo = m; else hi = m;
      }
      i = this.i = lo;
    }
    const h = t[i + 1] - t[i];
    if (h > 60) return null;
    const s = (tt - t[i]) / h, s2 = s * s, s3 = s2 * s;
    const a = 2 * s3 - 3 * s2 + 1, b = (s3 - 2 * s2 + s) * h, c = -2 * s3 + 3 * s2, d = (s3 - s2) * h;
    const p = this.p, v = this.v, j = 3 * i, k = j + 3, o = this.s;
    o.x = a * p[j] + b * v[j] + c * p[k] + d * v[k];
    o.y = a * p[j + 1] + b * v[j + 1] + c * p[k + 1] + d * v[k + 1];
    o.z = a * p[j + 2] + b * v[j + 2] + c * p[k + 2] + d * v[k + 2];
    o.vx = v[j] + s * (v[k] - v[j]);
    o.vy = v[j + 1] + s * (v[k + 1] - v[j + 1]);
    o.vz = v[j + 2] + s * (v[k + 2] - v[j + 2]);
    return o;
  }
}

// rows: [tEpoch, lat, lon, altM, gsMps|null, trackDeg|null, vrMps|null]
export function buildTrack(meta, rows, fr) {
  const ok = rows.filter((r) => Number.isFinite(r[0]) && Number.isFinite(r[1]) && Number.isFinite(r[2]) && Number.isFinite(r[3]));
  ok.sort((a, b) => a[0] - b[0]);
  const keep = [];
  for (const r of ok) if (!keep.length || r[0] - keep[keep.length - 1][0] >= 0.5) keep.push(r);
  const n = keep.length;
  if (n < 2) return null;
  const t = new Float64Array(n), p = new Float64Array(3 * n), v = new Float64Array(3 * n);
  keep.forEach((r, i) => {
    t[i] = r[0];
    p[3 * i] = fr.x(r[2]);
    p[3 * i + 1] = fr.y(r[1]);
    p[3 * i + 2] = r[3];
  });
  const RAD = Math.PI / 180, W = 8;
  // Altitude flips between sources by a few hundred ft: median over ±W s, climb rate by regression over the same span.
  const z = Float64Array.from(t, (ti) => {
    const s = keep.filter((r) => Math.abs(r[0] - ti) <= W).map((r) => r[3]).sort((a, b) => a - b);
    return s[s.length >> 1];
  });
  for (let i = 0; i < n; i++) {
    const [, , , , gs, trk, vr] = keep[i];
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1), dt = t[b] - t[a];
    if (gs != null && trk != null) {
      v[3 * i] = gs * Math.sin(trk * RAD);
      v[3 * i + 1] = gs * Math.cos(trk * RAD);
    } else {
      v[3 * i] = (p[3 * b] - p[3 * a]) / dt;
      v[3 * i + 1] = (p[3 * b + 1] - p[3 * a + 1]) / dt;
    }
    let st = 0, sz = 0, stt = 0, stz = 0, m = 0;
    for (let j = 0; j < n; j++)
      if (Math.abs(t[j] - t[i]) <= W) {
        const d = t[j] - t[i];
        st += d;
        sz += z[j];
        stt += d * d;
        stz += d * z[j];
        m++;
      }
    const den = m * stt - st * st;
    p[3 * i + 2] = z[i];
    v[3 * i + 2] = vr ?? (m > 1 && den > 0 ? (m * stz - st * sz) / den : 0);
  }
  // A lone message whose gs/track disagrees with both neighbours, which agree with each other.
  for (let i = 1; i < n - 1; i++) {
    const [ax, ay, bx, by] = [v[3 * i - 3], v[3 * i - 2], v[3 * i + 3], v[3 * i + 4]], mx = (ax + bx) / 2, my = (ay + by) / 2;
    if (Math.hypot(v[3 * i] - mx, v[3 * i + 1] - my) > Math.max(15, 2 * Math.hypot(ax - bx, ay - by))) [v[3 * i], v[3 * i + 1]] = [mx, my];
  }
  return new Track(meta, t, p, v);
}

// Last emission distance from retardedK, for amplitude in the simulator.
export const last = { R: 0 };

// Doppler factor heard at tObs: solve tObs = tEmit + |r(tEmit) - obs| / C, use radial velocity at tEmit.
export function retardedK(trk, ox, oy, oz, t) {
  let te = Math.max(trk.t0, Math.min(trk.t1, t - 3000 / C));
  for (let i = 0; i < 8; i++) {
    const s = trk.state(te);
    if (!s) return NaN;
    const dx = s.x - ox, dy = s.y - oy, dz = s.z - oz, R = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const next = t - R / C;
    if (Math.abs(next - te) < 1e-3 || i === 7) {
      last.R = R;
      const vr = -(dx * s.vx + dy * s.vy + dz * s.vz) / R;
      return C / (C - vr);
    }
    te = next;
  }
}

// Same factor for a straight constant-speed pass: speed v, slant CPA distance d, CPA heard at tc.
export function lineK(t, v, d, tc) {
  const T = t - tc + d / C, c2 = C * C, a = c2 - v * v;
  const u = (c2 * T - Math.sqrt(c2 * T * T * v * v + a * d * d)) / a;
  const R = C * (T - u);
  return C / (C + (v * v * u) / R);
}

export function nelderMead(f, x0, step, iters = 300) {
  const n = x0.length, m = n + 1;
  const pts = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    p[i] += step[i];
    pts.push(p);
  }
  const vals = Float64Array.from(pts, f), cen = new Float64Array(n), xr = new Float64Array(n), xe = new Float64Array(n), xc = new Float64Array(n);
  for (let it = 0; it < iters; it++) {
    for (let i = 1; i < m; i++) {
      const v = vals[i], p = pts[i];
      let j = i - 1;
      while (j >= 0 && vals[j] > v) {
        vals[j + 1] = vals[j];
        pts[j + 1] = pts[j];
        j--;
      }
      vals[j + 1] = v;
      pts[j + 1] = p;
    }
    if (Math.abs(vals[n] - vals[0]) <= 1e-12 * (Math.abs(vals[0]) + 1e-12)) break;
    cen.fill(0);
    for (let i = 0; i < n; i++) {
      const pi = pts[i];
      for (let j = 0; j < n; j++) cen[j] += pi[j] / n;
    }
    const pn = pts[n];
    for (let j = 0; j < n; j++) xr[j] = cen[j] - (pn[j] - cen[j]);
    const fr = f(xr);
    if (fr < vals[0]) {
      for (let j = 0; j < n; j++) xe[j] = cen[j] - 2 * (pn[j] - cen[j]);
      const fe = f(xe), src = fe < fr ? xe : xr;
      for (let j = 0; j < n; j++) pn[j] = src[j];
      vals[n] = fe < fr ? fe : fr;
    } else if (fr < vals[n - 1]) {
      for (let j = 0; j < n; j++) pn[j] = xr[j];
      vals[n] = fr;
    } else {
      const k = fr < vals[n] ? -0.5 : 0.5;
      for (let j = 0; j < n; j++) xc[j] = cen[j] + k * (pn[j] - cen[j]);
      const fc = f(xc);
      if (fc < Math.min(fr, vals[n])) {
        for (let j = 0; j < n; j++) pn[j] = xc[j];
        vals[n] = fc;
      } else {
        const p0 = pts[0];
        for (let i = 1; i <= n; i++) {
          const pi = pts[i];
          for (let j = 0; j < n; j++) pi[j] = p0[j] + 0.5 * (pi[j] - p0[j]);
          vals[i] = f(pi);
        }
      }
    }
  }
  let b = 0;
  for (let i = 1; i <= n; i++) if (vals[i] < vals[b]) b = i;
  return { x: pts[b], f: vals[b] };
}
 
 // Fit (f0, v, d, tc) of a straight pass to a traced curve. f0 is solved by least squares inside the cost.
 export function fitLine(ts, fs) {
   const n = ts.length, k = new Float64Array(n);
  const cost = (p) => {
    const v = p[0], ld = p[1], tc = p[2];
    if (!(v > 8 && v < 170 && ld > 3.5 && ld < 10)) return 1e18;
    const d = Math.exp(ld), doverC = d / C, c2 = C * C, v2 = v * v, a = c2 - v2, ad2 = a * d * d;
    let sfk = 0, skk = 0;
    for (let i = 0; i < n; i++) {
      const T = ts[i] - tc + doverC;
      const u = (c2 * T - Math.sqrt(c2 * T * T * v2 + ad2)) / a;
      const R = C * (T - u);
      const ki = C / (C + (v2 * u) / R);
      k[i] = ki;
      sfk += fs[i] * ki;
      skk += ki * ki;
    }
    const f0 = sfk / skk;
    if (!(f0 > 40 && f0 < 450)) return 1e18;
    let e = 0;
     for (let i = 0; i < n; i++) {
       const df = fs[i] - f0 * k[i];
       e += df * df;
     }
     return e / n;
   };
   // tc guess: steepest descent of a 2 s regression slope
   let tc0 = ts[n >> 1], minSlope = Infinity;
   for (let i = 0; i < n; i++) {
     let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
     for (let j = i; j >= 0 && ts[i] - ts[j] <= 2; j--) { sx += ts[j]; sy += fs[j]; sxx += ts[j] * ts[j]; sxy += ts[j] * fs[j]; m++; }
     for (let j = i + 1; j < n && ts[j] - ts[i] <= 2; j++) { sx += ts[j]; sy += fs[j]; sxx += ts[j] * ts[j]; sxy += ts[j] * fs[j]; m++; }
     const den = m * sxx - sx * sx;
     if (m < 3 || den <= 0) continue;
     const slope = (m * sxy - sx * sy) / den;
     if (slope < minSlope) [minSlope, tc0] = [slope, ts[i]];
   }
  const q = Math.max(1, Math.floor(n * 0.15));
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const r = mean(fs.slice(0, q)) / mean(fs.slice(n - q));
  const v0 = Math.min(120, Math.max(15, (C * (r - 1)) / (r + 1)));
  let best = null;
  for (const d0 of [150, 400, 1000, 2500, 6000])
    for (const vm of [1, 1.5]) {
      const res = nelderMead(cost, [v0 * vm, Math.log(d0), tc0], [5, 0.4, 2]);
      if (!best || res.f < best.f) best = res;
    }
  const [v, ld, tc] = best.x, d = Math.exp(ld);
  let sfk = 0, skk = 0;
  for (let i = 0; i < n; i++) {
    const kk = lineK(ts[i], v, d, tc);
    sfk += fs[i] * kk;
    skk += kk * kk;
  }
  const f0 = sfk / skk, rms = Math.sqrt(best.f);
  return { f0, v, d, tc, rms, rmsRel: rms / f0 };
}
