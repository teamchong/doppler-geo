import { FT, KT, frameAt } from './geo.js';

// Tracks are { meta: { hex, type, reg }, rows: [[tEpoch, lat, lon, altM, gsMps, trkDeg, vrMps]] }.

// Inverse of the columnar line format written by scripts/build-index.mjs.
export function decodeLine(line, day0) {
  const { h, t, r, c } = JSON.parse(line), rows = [];
  const acc = [0, 0, 0, 0];
  for (let i = 0; i < c[0].length; i++) {
    for (let j = 0; j < 4; j++) acc[j] = i ? acc[j] + c[j][i] : c[j][i];
    rows.push([day0 + acc[0] / 10, acc[1] / 1e4, acc[2] / 1e4, acc[3], c[4][i] == null ? null : c[4][i] / 10, c[5][i], c[6][i] == null ? null : c[6][i] / 10]);
  }
  return { meta: { hex: h, type: t, reg: r }, rows };
}

// Byte range of a gzipped chunk, decompressed. Static hosting may ignore Range and send the whole file: then cache it once and slice.
const whole = new Map();
export async function rangeGunzip(url, off, len) {
  let body;
  if (whole.has(url)) body = (await whole.get(url)).slice(off, off + len);
  else {
    const r = await fetch(url, { headers: { Range: `bytes=${off}-${off + len - 1}` } });
    if (r.status === 200) {
      const p = r.arrayBuffer();
      whole.set(url, p);
      body = (await p).slice(off, off + len);
    } else body = await r.arrayBuffer();
  }
  return new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

const isoDay = (d) => new Date(d * 86400e3).toISOString().slice(0, 10);

export async function availableDays(base = '') {
  const r = await fetch(`${base}/data/days.json`);
  return r.ok ? r.json() : [];
}

// Prop flights within rKm of (lat, lon) between t0 and t1 (epoch s), from the daily index.
export async function loadHistory(lat, lon, rKm, t0, t1, base = '') {
  const days = new Set(await availableDays(base)), want = [];
  for (let d = Math.floor((t0 - 120) / 86400); d <= Math.floor((t1 + 120) / 86400); d++) want.push(isoDay(d));
  const dLat = (rKm + 15) / 111, dLon = dLat / Math.cos((lat * Math.PI) / 180), keys = [];
  for (let a = Math.floor(lat - dLat); a <= Math.floor(lat + dLat); a++)
    for (let o = Math.floor(lon - dLon); o <= Math.floor(lon + dLon); o++) keys.push(`${a}_${((o + 540) % 360) - 180}`);
  const byHex = new Map();
  await Promise.all(
    want.filter((d) => days.has(d)).map(async (day) => {
      const idx = await fetch(`${base}/data/idx/${day}.json`).then((r) => r.json()), day0 = Date.parse(`${day}T00:00:00Z`) / 1000;
      await Promise.all(
        keys.filter((k) => idx.tiles[k]).map(async (k) => {
          const [off, len] = idx.tiles[k];
          const text = new TextDecoder().decode(await rangeGunzip(`${base}/data/day/${day}.bin`, off, len));
          for (const line of text.split('\n')) {
            if (!line) continue;
            const tr = decodeLine(line, day0), rows = tr.rows.filter((x) => x[0] >= t0 - 120 && x[0] <= t1 + 120);
            if (!rows.length) continue;
            const e = byHex.get(tr.meta.hex);
            if (e) e.rows.push(...rows);
            else byHex.set(tr.meta.hex, { meta: tr.meta, rows });
          }
        }),
      );
    }),
  );
  return { tracks: [...byHex.values()], missing: want.filter((d) => !days.has(d)) };
}

// Polls the live proxy and keeps the last 20 minutes of prop positions.
export class LiveFeed {
  constructor(base = '') {
    this.base = base;
    this.ac = new Map();
    this.center = null;
    this.latest = [];
    this.now = 0;
  }

  // center is set by the caller; only a ~25 km cell leaves the browser.
  async poll() {
    const { lat, lon } = this.center, q = `?lat=${Math.round(lat * 4) / 4}&lon=${Math.round(lon * 4) / 4}`;
    const r = await fetch(`${this.base}/api/live${q}`);
    if (!r.ok) throw new Error(`live feed ${r.status}`);
    const d = await r.json();
    this.now = d.now / 1000;
    this.latest = d.ac;
    for (const a of d.ac) {
      const alt = a.alt_geom ?? a.alt_baro, rate = a.geom_rate ?? a.baro_rate;
      if (a.lat == null || typeof alt !== 'number') continue;
      const t = this.now - (a.seen_pos ?? 0);
      let e = this.ac.get(a.hex);
      if (!e) this.ac.set(a.hex, (e = { meta: { hex: a.hex, type: a.t, reg: a.r ?? null, flight: a.flight?.trim() || null }, rows: [] }));
      const last = e.rows[e.rows.length - 1];
      if (last && t - last[0] < 0.5) continue;
      e.rows.push([t, a.lat, a.lon, alt * FT, a.gs == null ? null : a.gs * KT, a.track ?? null, rate == null ? null : (rate * FT) / 60]);
    }
    for (const [hex, e] of this.ac) {
      e.rows = e.rows.filter((x) => x[0] > this.now - 1200);
      if (!e.rows.length) this.ac.delete(hex);
    }
    return d;
  }

  tracks() {
    return [...this.ac.values()].filter((e) => e.rows.length >= 2);
  }
}

// Straight-line projection of current positions: who passes within 12 km of `center` in the next 15 minutes.
export function upcoming(ac, center) {
  const fr = frameAt(center.lat, center.lon), out = [];
  for (const a of ac) {
    if (a.lat == null || !a.gs || a.track == null) continue;
    const x = fr.x(a.lon), y = fr.y(a.lat), v = a.gs * KT, vx = v * Math.sin((a.track * Math.PI) / 180), vy = v * Math.cos((a.track * Math.PI) / 180);
    const eta = Math.max(0, -(x * vx + y * vy) / (v * v)), h = Math.hypot(x + vx * eta, y + vy * eta), alt = (a.alt_geom ?? a.alt_baro) * FT || 0;
    const dist = Math.hypot(h, alt);
    if (eta < 900 && dist < 12000) out.push({ hex: a.hex, type: a.t, reg: a.r, eta, dist });
  }
  return out.sort((a, b) => a.eta - b.eta);
}
