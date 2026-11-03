import { buildTrack } from './physics.js';
import { score } from './solver.js';
import { frameAt, distM } from './geo.js';
import { loadHistory, availableDays, rangeGunzip, liveFeed, dataRoot } from './data.js';

// Worldwide pass search over the speed index (scripts/build-index.mjs, out/spd).
// 1. Lookup: every indexed sample whose speed fits a pass is the closest approach for ground spots on its perpendicular.
// 2. Join: with 2+ passes, a spot survives only if every pass fits a different plane there with one recording start.
// 3. Verify: refit survivors with the full retarded-time model on the raw curve.
const C = 340, CELL = 250, MY = 111195, REC = 24, OK_Q = 0.008;
const H = Array.from({ length: 33 }, (_, i) => i * 125);
const isoDay = (d) => new Date(d * 86400e3).toISOString().slice(0, 10);

export class SpeedStore {
  constructor(base = '') {
    this.base = base;
    this.days = new Map();
    this.shards = new Map();
  }

  async day(day) {
    if (!this.days.has(day)) {
      this.days.set(
        day,
        availableDays(this.base).then(async (days) => {
          if (!days.includes(day)) return null;
          const root = await dataRoot(this.base);
          const r = await fetch(`${root}/data/spd/${day}.json`).catch(() => null);
          return r?.ok ? { root, ...(await r.json()) } : null;
        }),
      );
    }
    return this.days.get(day);
  }

  // Samples for one (UTC minute, speed band): { f: flight, t: epoch, lat, lon, z, ve, vn, vz }.
  async shard(min, band) {
    const day = isoDay(Math.floor(min / 1440)), key = `${min % 1440}_${band}`, id = `${day}/${key}`;
    if (!this.shards.has(id)) {
      this.shards.set(
        id,
        (async () => {
          const idx = await this.day(day), e = idx?.keys[key];
          if (!e) return [];
          const dv = new DataView(await rangeGunzip(`${idx.root}/data/spd/${day}.bin`, e[0], e[1])), day0 = Date.parse(`${day}T00:00:00Z`) / 1000, out = [];
          for (let o = 0; o + REC <= dv.byteLength; o += REC) {
            const f = idx.flights[dv.getUint32(o, true)];
            out.push({ f: { hex: f[0], type: f[1], reg: f[2] }, t: day0 + dv.getUint32(o + 4, true) / 10, lat: dv.getInt32(o + 8, true) / 1e6, lon: dv.getInt32(o + 12, true) / 1e6, z: dv.getInt16(o + 16, true), ve: dv.getInt16(o + 18, true) / 10, vn: dv.getInt16(o + 20, true) / 10, vz: dv.getInt16(o + 22, true) / 10 });
          }
          return out;
        })().catch((e) => {
          this.shards.delete(id);
          throw e;
        }),
      );
    }
    const baseOut = await this.shards.get(id);
    if (this.base) return baseOut;
    const liveOut = liveFeed.shard(min, band);
    return liveOut.length ? [...baseOut, ...liveOut] : baseOut;
  }
}

const cellKey = (lat, lon) => `${Math.floor((lat * MY) / CELL)},${Math.floor((lon * MY * Math.cos((lat * Math.PI) / 180)) / CELL)}`;

// One pass -> Map(cell -> [{ start, f, lat, lon }]) for recording starts in [s0, s1].
async function lookup(store, e, s0, s1) {
  const tv = Math.max(22, 0.5 * e.v), out = new Map(), jobs = [], tPad = 5;
  for (let m = Math.floor((s0 + e.tc - tPad - 25) / 60); m <= Math.floor((s1 + e.tc + tPad + 60) / 60); m++)
    for (let b = Math.max(3, Math.floor((e.v - tv) / 4)); b <= Math.min(60, Math.floor((e.v + tv) / 4)); b++)
      jobs.push(store.shard(m, b));
  for (const sh of await Promise.all(jobs))
    for (const s of sh) {
      const hs = Math.hypot(s.ve, s.vn);
      if (hs < 15 || Math.abs(Math.hypot(hs, s.vz) - e.v) > tv) continue;
      const px = -s.vn / hs, py = s.ve / hs, kx = 1 / (MY * Math.cos((s.lat * Math.PI) / 180));
      for (const dt of [-5, 0, 5]) {
        const sLat = s.lat + (s.vn * dt) / MY, sLon = s.lon + s.ve * dt * kx, st = s.t + dt;
        for (const h of H) {
          const d = Math.hypot(h, Math.max(30, s.z));
          if (d < 0.25 * e.d - 150 || d > 3.5 * e.d + 600) continue;
          const start = st - d / C - e.tc;
          if (start < s0 - tPad || start > s1 + tPad) continue;
          for (const side of h ? [-1, 1] : [1]) {
            const lat = sLat + (side * h * py) / MY, lon = sLon + side * h * px * kx, k = cellKey(lat, lon);
            let a = out.get(k);
            if (!a) out.set(k, (a = []));
            if (!a.some((x) => x.f.hex === s.f.hex && Math.abs(x.start - start) < 6)) a.push({ start, f: s.f, lat, lon, s: { ...s, lat: sLat, lon: sLon, t: st } });
          }
        }
      }
    }
  return out;
}

function near(M, k) {
  const [cy, cx] = k.split(',').map(Number), out = [];
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) for (const o of M.get(`${cy + dy},${cx + dx}`) ?? []) out.push(o);
  return out;
}

// Every combination of distinct planes (a few per pass) that agrees on spot and start.
function join(L) {
  const hits = [];
  for (const [k, list] of L[0]) {
    let combos = list.map((a) => ({ flights: [a.f], ss: [a.s], start: a.start, lat: a.lat, lon: a.lon }));
    for (const M of L.slice(1)) {
      const cand = near(M, k), next = [];
      for (const c of combos) {
        const seen = new Set();
        for (const o of cand)
          if (Math.abs(o.start - c.start) < 12 && !c.flights.some((f) => f.hex === o.f.hex) && !seen.has(o.f.hex) && seen.size < 8) {
            seen.add(o.f.hex);
            next.push({ flights: [...c.flights, o.f], ss: [...c.ss, o.s], start: (c.start + o.start) / 2, lat: (c.lat + o.lat) / 2, lon: (c.lon + o.lon) / 2 });
          }
      }
      combos = next;
      if (!combos.length) break;
    }
    for (const c of combos) hits.push(c);
  }
  return hits;
}

// Cheap pre-rank: each plane flies straight from its index sample. Same misfit measure as score(), no fetches.
function linScore(pts, s, lat, lon, start) {
  const kx = MY * Math.cos((lat * Math.PI) / 180), x0 = (s.lon - lon) * kx, y0 = (s.lat - lat) * MY, z0 = s.z - 1.5, ks = [];
  let sfk = 0, skk = 0;
  for (const [tr, f] of pts) {
    let te = start + tr;
    for (let it = 0; it < 3; it++) {
      const u = te - s.t, r = Math.hypot(x0 + s.ve * u, y0 + s.vn * u, z0 + s.vz * u);
      te = start + tr - r / C;
    }
    const u = te - s.t, x = x0 + s.ve * u, y = y0 + s.vn * u, z = z0 + s.vz * u, r = Math.hypot(x, y, z), k = 1 / (1 + (s.ve * x + s.vn * y + s.vz * z) / (r * C));
    ks.push(k);
    sfk += f * k;
    skk += k * k;
  }
  if (ks[0] <= 1.005 || ks[ks.length - 1] >= 0.995) return Infinity;
  const f0 = sfk / skk;
  let e = 0;
  pts.forEach(([, f], i) => (e += (f - f0 * ks[i]) ** 2));
  return Math.sqrt(e / pts.length) / f0;
}

const circle = (lat, lon, r) => Array.from({ length: 16 }, (_, i) => [lat + (r * Math.sin((i * Math.PI) / 8)) / MY, lon + (r * Math.cos((i * Math.PI) / 8)) / (MY * Math.cos((lat * Math.PI) / 180))]);

async function verify(evs, hits, base, s0, s1) {
  const pts = evs.map((e) => e.pts.filter((_, i) => i % Math.ceil(e.pts.length / 20) === 0)), out = [], seen = new Set(), cache = new Map(), span = Math.max(...evs.map((e) => e.tc));
  const tracksAt = (lat, lon, t) => {
    const h0 = Math.floor(t / 3600) * 3600, k = `${Math.floor(lat)},${Math.floor(lon)},${h0}`;
    if (!cache.has(k)) cache.set(k, loadHistory(Math.floor(lat) + 0.5, Math.floor(lon) + 0.5, 60, h0 - 300, h0 + 3600 + span + 300, base).then((r) => r.tracks));
    return cache.get(k);
  };
  const candidates = [];
  for (const h of hits) {
    const key = `${Math.round(h.lat * 20)},${Math.round(h.lon * 20)},${Math.round(h.start / 20)},${h.flights.map((f) => f.hex).join()}`;
    if (seen.has(key) || seen.size >= 40) continue;
    seen.add(key);
    const fr = frameAt(h.lat, h.lon), tracks = await tracksAt(h.lat, h.lon, h.start);
    const trks = h.flights.map((f) => tracks.find((t) => t.meta.hex === f.hex)).map((t) => t && buildTrack(t.meta, t.rows, fr));
    if (trks.some((t) => !t)) continue;
    let best = [Infinity];
    const st0 = s1 - s0 <= 10 ? Math.max(s0, Math.min(s1, h.start)) : h.start;
    for (let x = -800; x <= 800; x += 200)
      for (let y = -800; y <= 800; y += 200)
        for (const ds of [-3, 0, 3]) {
          let q = 0;
          for (let p = 0; p < evs.length && q < Infinity; p++) q += score(pts[p], trks[p], x, y, 1.5, st0 + ds);
          if (q < best[0]) best = [q, x, y, st0 + ds];
        }
    if (best[0] < Infinity) candidates.push({ h, fr, trks, best });
  }
  candidates.sort((a, b) => a.best[0] - b.best[0]);
  for (const { h, fr, trks, best: b0 } of candidates.slice(0, 12)) {
    let best = b0;
    const [, cx, cy, cst] = b0;
    for (let x = cx - 200; x <= cx + 200; x += 100)
      for (let y = cy - 200; y <= cy + 200; y += 100)
        for (let ds = -2; ds <= 2; ds++) {
          let q = 0;
          for (let p = 0; p < evs.length && q < Infinity; p++) q += score(pts[p], trks[p], x, y, 1.5, cst + ds);
          if (q < best[0]) best = [q, x, y, cst + ds];
        }
    const lat = fr.lat(best[2]), lon = fr.lon(best[1]);
    const paths = trks.map((t, p) => {
      const path = [], tc = best[3] + evs[p].tc;
      let cpa = null, minD = Infinity;
      for (let dt = -45; dt <= 45; dt += 2) {
        const s = t.state(tc + dt);
        if (!s) continue;
        const pt = [fr.lat(s.y), fr.lon(s.x)];
        path.push(pt);
        const d2 = (s.x - best[1]) ** 2 + (s.y - best[2]) ** 2;
        if (d2 < minD) [minD, cpa] = [d2, pt];
      }
      return { flight: h.flights[p], path, cpa };
    });
    out.push({ q: best[0] / evs.length, lat, lon, start: best[3], flights: h.flights, paths, hull: circle(lat, lon, 150), score: best[0] / evs.length, unheard: 0 });
  }
  out.sort((a, b) => a.q - b.q);
  return out.filter((r, i) => !out.slice(0, i).some((o) => distM(o.lat, o.lon, r.lat, r.lon) < 1500 && o.flights.every((f, j) => f.hex === r.flights[j].hex)));
}

// events: passes with tc relative to the recording start; [s0, s1]: possible recording starts (epoch s), or null for every indexed day.
// Returns { kind: 'located' | 'unsure' | 'shortlist' | 'none', results, planes, used }.
const stores = new Map();
export async function search(events, { s0, s1, base = '', onProgress = () => {} }) {
  if (!events.length) return { kind: 'none', results: [], planes: 0 };
  if (!base && (!liveFeed.ac.size || Date.now() / 1000 - liveFeed.now > 8)) {
    try {
      await liveFeed.poll();
    } catch {}
  }
  let store = stores.get(base);
  if (!store) stores.set(base, (store = new SpeedStore(base)));
  const spans = [];
  if (s0 != null) {
    spans.push([s0, s1]);
  } else {
    const days = (await availableDays(base)).sort();
    for (const d of days) {
      const d0 = Date.parse(`${d}T00:00:00Z`) / 1000;
      if (spans.length && d0 <= spans[spans.length - 1][1]) spans[spans.length - 1][1] = Math.max(spans[spans.length - 1][1], d0 + 86400);
      else spans.push([d0, d0 + 86400]);
    }
    if (!base) {
      const lw = liveFeed.window();
      if (lw && !spans.some(([a, b]) => lw[0] >= a && lw[1] <= b)) spans.unshift(lw);
    }
    if (!spans.length) return { kind: 'none', results: [], planes: 0 };
    s0 = Math.min(...spans.map((s) => s[0]));
    s1 = Math.max(...spans.map((s) => s[1]));
  }
  const CH = 600, found = [];
  let shortlist = new Map();
  const totalSpan = spans.reduce((s, [x, y]) => s + Math.max(1, y - x), 0);
  let doneSpan = 0;
  for (const [sp0, sp1] of spans)
    for (let a = sp0; a < sp1; a += CH) {
      onProgress(doneSpan / totalSpan);
      const b = Math.min(sp1, a + CH), L = await Promise.all(events.map((e) => lookup(store, e, a, b)));
      doneSpan += b - a;
    if (events.length >= 2) {
      // A phantom pass must not veto the real ones: try all passes, drop-one subsets, and pairs.
      const sets = [events.map((_, i) => i)];
      if (events.length >= 3) {
        for (let i = 0; i < events.length; i++) sets.push(events.map((_, j) => j).filter((j) => j !== i));
        if (events.length >= 4)
          for (let i = 0; i < events.length; i++)
            for (let j = i + 1; j < events.length; j++) sets.push([i, j]);
      }
      for (const ix of sets) {
        const hits = join(ix.map((i) => L[i]));
        if (hits.length) found.push({ ix, hits });
      }
    }
    // Single pass (or as fallback): every plane that could have made the best pass.
    for (const list of L[0].values())
      for (const o of list) {
        const dv = Math.abs(Math.hypot(o.s.ve, o.s.vn) - events[0].v), prev = shortlist.get(o.f.hex);
        if (!prev || dv < prev.dv)
          shortlist.set(o.f.hex, { lat: o.lat, lon: o.lon, start: o.start, flights: [o.f], hull: circle(o.lat, o.lon, 300), q: null, score: 1, unheard: 0, dv });
      }
  }
  onProgress(1);
  // Verify each pass set; prefer more passes unless fewer fit clearly better.
  let best = null;
  for (const ix of [...new Set(found.map((f) => f.ix.join()))].map((k) => k.split(',').map(Number))) {
    if (best && ix.length < best.ix.length && best.results[0].q < OK_Q * 1.4) break;
    const hits = found.filter((f) => f.ix.join() === ix.join()).flatMap((f) => f.hits);
    const qp = ix.map((i) => events[i].pts.filter((_, j) => j % Math.ceil(events[i].pts.length / 16) === 0));
    for (const h of hits) {
      // Slide along the line between the plane and the spot (fitted distance is rough), keep the best.
      h.pre = Infinity;
      for (const o of [-300, -150, 0, 150, 300])
        for (const ds of [-3, 0, 3]) {
          const s0 = h.ss[0], hs = Math.hypot(s0.ve, s0.vn), lat = h.lat + (o * (s0.ve / hs)) / MY, lon = h.lon + (o * (-s0.vn / hs)) / (MY * Math.cos((h.lat * Math.PI) / 180));
          const q = h.ss.reduce((acc, ss, p) => acc + linScore(qp[p], ss, lat, lon, h.start + ds), 0) / h.ss.length;
          if (q < h.pre) h.pre = q;
        }
    }
    hits.sort((a, b) => a.pre - b.pre);
    const results = await verify(ix.map((i) => events[i]), hits, base, s0, s1);
    if (results.length && (!best || (ix.length > best.ix.length ? results[0].q < OK_Q * 1.4 || results[0].q < best.results[0].q * 0.6 : results[0].q < best.results[0].q)))
      best = { ix, results };
  }
  if (best) {
    const { ix, results } = best, top = results[0], second = results[1];
    if (top.q < OK_Q || (top.q < 0.012 && (!second || top.q < second.q * 0.85)))
      return { kind: 'located', results: results.filter((r) => r.q < Math.max(OK_Q * 2, top.q * 2)), used: ix.length };
    return { kind: 'unsure', results, used: ix.length };
  }
  const results = [...shortlist.values()].sort((a, b) => a.dv - b.dv);
  return { kind: results.length ? 'shortlist' : 'none', results, planes: results.length, used: 1 };
}
