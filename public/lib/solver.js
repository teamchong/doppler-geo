import { C, nelderMead, retardedK } from './physics.js';

const pick = (a, m) => (a.length <= m ? a : Array.from({ length: m }, (_, i) => a[Math.round((i * (a.length - 1)) / (m - 1))]));
const kbuf = new Float64Array(256);

// Relative RMS between a traced curve and the retarded-time model, f0 fitted by least squares.
export function score(pts, trk, x, y, z, start) {
  let sfk = 0, skk = 0, valid = 0, k0 = 0, k1 = 0;
  for (let i = 0; i < pts.length; i++) {
    const k = retardedK(trk, x, y, z, start + pts[i][0]);
    if (k > 0) { if (!valid) k0 = k; k1 = k; kbuf[i] = k; sfk += pts[i][1] * k; skk += k * k; valid++; }
    else kbuf[i] = 0;
  }
  if (valid < Math.max(4, pts.length - 2) || k0 <= 1.005 || k1 >= 0.995) return Infinity;
  const f0 = sfk / skk;
  let e = 0;
  for (let i = 0; i < pts.length; i++) if (kbuf[i] > 0) e += (pts[i][1] - f0 * kbuf[i]) ** 2;
  return Math.sqrt(e / valid) / f0;
}

// Every track instant whose speed matches is the CPA for ground points on its perpendicular, at the fitted slant distance.
function candidates(e, tracks, ground, s0, s1, radius) {
  const out = [], tolV = Math.max(8, 0.2 * e.v), ds = e.d > 1500 ? [0.8, 1, 1.25] : [1];
  const h0 = s0 + e.tc, h1 = s1 + e.tc;
  for (const trk of tracks) {
    for (let t = Math.max(trk.t0, h0 - 60); t <= Math.min(trk.t1, h1); t += 4) {
      const s = trk.state(t);
      if (!s) continue;
      const hs = Math.hypot(s.vx, s.vy), sp = Math.hypot(hs, s.vz);
      if (Math.abs(sp - e.v) > tolV || hs < 5) continue;
      const px = -s.vy / hs, py = s.vx / hs, sx = s.x, sy = s.y, sz = s.z;
      for (const m of ds) {
        const d = e.d * m;
        for (const side of [-1, 1]) {
          let off = 0, z = ground(sx, sy);
          for (let it = 0; it < 2 && off >= 0; it++) {
            const h = sz - z;
            off = h > d * 1.15 ? NaN : Math.sqrt(Math.max(0, d * d - h * h));
            z = ground(sx + side * off * px, sy + side * off * py);
          }
          if (!(off >= 0)) break;
          const x = sx + side * off * px, y = sy + side * off * py;
          if (x * x + y * y > radius * radius) continue;
          const start = t + Math.hypot(off, sz - z) / C - e.tc;
          if (start >= s0 - 2 && start <= s1 + 2) out.push({ trk, x, y, start, ux: side * px, uy: side * py });
          if (off === 0) break;
        }
      }
    }
  }
  return out;
}

function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (const q of p.reverse()) {
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

// Prop flights that should have been loud during the recording but left no curve.
function unheard(r, tracks, ground, dur) {
  let n = 0;
  const z = ground(r.x, r.y);
  for (const trk of tracks) {
    if (r.trks.includes(trk)) continue;
    let best = Infinity, bt = 0;
    for (let t = Math.max(trk.t0, r.start - 60); t <= Math.min(trk.t1, r.start + dur); t += 2) {
      const s = trk.state(t);
      if (!s) continue;
      const R = Math.hypot(s.x - r.x, s.y - r.y, s.z - z);
      if (R < best) [best, bt] = [R, t + R / C - r.start];
    }
    if (best < 1500 && bt > 8 && bt < dur - 8) n++;
  }
  return n;
}

// events: traced passes, tracks: Track[], window: when the recording started (epoch s), radius around the frame origin (m).
export function solve({ events, tracks, frame, dem, window: [s0, s1], dur, radius, maxResults = 30 }) {
  const ground = (x, y) => dem.at(frame.lat(y), frame.lon(x)) + 1.5;
  const evals = events.map((e) => ({ ...e, sp: pick(e.pts, 60), qp: pick(e.pts, 16) }));
  const lists = evals.map((e) => {
    const cs = candidates(e, tracks, ground, s0, s1, radius);
    // Fitted d is rough, so slide along the perpendicular before ranking.
    for (const c of cs) {
      let best = [Infinity, 0, 0];
      for (const o of [-300, -150, 0, 150, 300]) {
        const x = c.x + o * c.ux, y = c.y + o * c.uy, z = ground(x, y);
        for (const dt of [-1.5, 0, 1.5]) {
          const q = score(e.qp, c.trk, x, y, z, c.start + dt);
          if (q < best[0]) best = [q, o, dt];
        }
      }
      [c.q, c.x, c.y, c.start] = [best[0], c.x + best[1] * c.ux, c.y + best[1] * c.uy, c.start + best[2]];
    }
    return cs.filter((c) => c.q < 0.03).sort((a, b) => a.q - b.q).slice(0, 3000);
  });

  // Multi-pass: every pass must come from the same spot and the same recording start.
  let combos;
  if (lists.length === 1) combos = lists[0].map((c) => ({ x: c.x, y: c.y, start: c.start, q: c.q, trks: [c.trk] }));
  else {
    combos = [];
    for (const c of lists[0]) {
      const trks = [c.trk];
      let q = c.q, ok = true;
      for (const L of lists.slice(1)) {
        let best = null;
        for (const o of L) if (Math.abs(o.start - c.start) < 4 && (o.x - c.x) ** 2 + (o.y - c.y) ** 2 < 1500 ** 2 && (!best || o.q < best.q)) best = o;
        if (!best) {
          ok = false;
          break;
        }
        trks.push(best.trk);
        q += best.q;
      }
      if (ok) combos.push({ x: c.x, y: c.y, start: c.start, q: q / lists.length, trks });
    }
  }
  combos.sort((a, b) => a.q - b.q);
  const chosen = [];
  for (const c of combos) {
    if (chosen.length >= 150) break;
    if (!chosen.some((o) => o.trks.every((t, i) => t === c.trks[i]) && Math.abs(o.start - c.start) < 20 && (o.x - c.x) ** 2 + (o.y - c.y) ** 2 < 400 ** 2)) chosen.push(c);
  }

  const joint = (c, x, y, st) => {
    const z = ground(x, y);
    let s = 0;
    for (let j = 0; j < evals.length; j++) s += score(evals[j].sp, c.trks[j], x, y, z, st);
    return s / evals.length;
  };
  const refined = chosen.map((c) => {
    let best = { x: c.x, y: c.y, start: c.start, q: joint(c, c.x, c.y, c.start) };
    const grid = [];
    for (const [r, step, tr, ts] of [[400, 100, 2, 1], [100, 25, 0.75, 0.25]]) {
      const o = { ...best };
      for (let dx = -r; dx <= r; dx += step)
        for (let dy = -r; dy <= r; dy += step) {
          let m = Infinity, mst = o.start;
          for (let dt = -tr; dt <= tr + 1e-9; dt += ts) {
            const st = o.start + dt;
            if (st < s0 - 0.5 || st > s1 + 0.5) continue;
            const q = joint(c, o.x + dx, o.y + dy, st);
            if (q < m) [m, mst] = [q, st];
          }
          grid.push([o.x + dx, o.y + dy, m]);
          if (m < best.q) best = { x: o.x + dx, y: o.y + dy, start: mst, q: m };
        }
    }
    const nm = nelderMead(([x, y, st]) => (st < s0 - 0.5 || st > s1 + 0.5 ? Infinity : joint(c, x, y, st)), [best.x, best.y, best.start], [60, 60, 0.5], 120);
    if (nm.f < best.q) best = { x: nm.x[0], y: nm.x[1], start: nm.x[2], q: nm.f };
    const area = grid.filter((g) => g[2] <= best.q * 1.5 + 0.001).map((g) => [g[0], g[1]]);
    return { ...best, trks: c.trks, area };
  });

  for (const r of refined) {
    r.unheard = unheard(r, tracks, ground, dur);
    r.score = r.q + 0.004 * r.unheard;
  }
  refined.sort((a, b) => a.score - b.score);

  // One result per pass: a straight pass at unknown time smears along the track, so merge along it but keep
  // the mirror spot across the track separate.
  const side = (g, r) => {
    const s = g.trks[0].state(g.start + evals[0].tc - 3);
    if (!s) return Math.hypot(r.x - g.x, r.y - g.y);
    const h = Math.hypot(s.vx, s.vy) || 1;
    return Math.abs(((r.x - g.x) * -s.vy + (r.y - g.y) * s.vx) / h);
  };
  const groups = [];
  for (const r of refined) {
    const g = groups.find((g) => g.trks.every((t, i) => t === r.trks[i]) && Math.abs(g.start - r.start) < 90 && (g.x - r.x) ** 2 + (g.y - r.y) ** 2 < 6000 ** 2 && side(g, r) < 500);
    if (g) g.area.push(...r.area, [r.x, r.y]);
    else if (groups.length < maxResults) groups.push({ ...r, area: [...r.area, [r.x, r.y]] });
  }
  return groups.map((g) => {
    let h = hull(g.area);
    if (h.length < 3) h = [[-50, -50], [50, -50], [50, 50], [-50, 50]].map(([a, b]) => [g.x + a, g.y + b]);
    return {
      lat: frame.lat(g.y),
      lon: frame.lon(g.x),
      start: g.start,
      q: g.q,
      score: g.score,
      unheard: g.unheard,
      flights: g.trks.map((t) => t.meta),
      heard: evals.map((e) => g.start + e.tc),
      hull: h.map(([x, y]) => [frame.lat(y), frame.lon(x)]),
    };
  });
}
