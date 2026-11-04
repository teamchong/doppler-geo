import { buildTrack } from './physics.js';
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
const whole = new Map(), chunkCache = new Map(), idxCache = new Map();
let activeFetches = 0;
const fetchQueue = [];
function limitFetch(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeFetches++;
      fn().then(resolve, reject).finally(() => {
        activeFetches--;
        if (fetchQueue.length) fetchQueue.shift()();
      });
    };
    if (activeFetches < 8) run();
    else fetchQueue.push(run);
  });
}

export function rangeGunzip(url, off, len) {
  const key = `${url}:${off}:${len}`;
  if (!chunkCache.has(key)) {
    chunkCache.set(key, (async () => {
      let body;
      if (whole.has(url)) {
        const w = await whole.get(url);
        if (w) body = w.slice(off, off + len);
      }
      if (!body) {
        body = await limitFetch(async () => {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const r = await fetch(url, { headers: { Range: `bytes=${off}-${off + len - 1}` } });
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              const buf = await r.arrayBuffer();
              if (r.status === 200) {
                whole.set(url, Promise.resolve(buf));
                return buf.slice(off, off + len);
              }
              return buf;
            } catch (e) {
              if (attempt === 2) throw e;
              await new Promise((res) => setTimeout(res, 150 * (attempt + 1)));
            }
          }
        });
      }
      return new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    })().catch((e) => {
      chunkCache.delete(key);
      throw e;
    }));
  }
  return chunkCache.get(key);
}

const isoDay = (d) => new Date(d * 86400e3).toISOString().slice(0, 10);

const daysCache = new Map(),
  rootCache = new Map();
export async function dataRoot(base = '') {
  if (base) return base;
  if (!rootCache.has('')) {
    rootCache.set(
      '',
      fetch('/data/days.json')
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [])
        .then((d) => {
          if (Array.isArray(d) && d.length) {
            daysCache.set('', Promise.resolve(d));
            return '';
          }
          return './examples/2025-07-18';
        }),
    );
  }
  return rootCache.get('');
}
export async function availableDays(base = '') {
  const root = await dataRoot(base);
  if (!daysCache.has(root)) {
    daysCache.set(
      root,
      fetch(`${root}/data/days.json`)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [])
        .then((d) => (Array.isArray(d) ? d : [])),
    );
  }
  return daysCache.get(root);
}

// Prop flights within rKm of (lat, lon) between t0 and t1 (epoch s), from the daily index.
export async function loadHistory(lat, lon, rKm, t0, t1, base = '') {
  const root = await dataRoot(base), days = new Set(await availableDays(base)), want = [];
  for (let d = Math.floor((t0 - 120) / 86400); d <= Math.floor((t1 + 120) / 86400); d++) want.push(isoDay(d));
  const dLat = (rKm + 15) / 111, dLon = dLat / Math.cos((lat * Math.PI) / 180), keys = [];
  for (let a = Math.floor(lat - dLat); a <= Math.floor(lat + dLat); a++)
    for (let o = Math.floor(lon - dLon); o <= Math.floor(lon + dLon); o++) keys.push(`${a}_${((o + 540) % 360) - 180}`);
  const byHex = new Map();
  await Promise.all(
    want.filter((d) => days.has(d)).map(async (day) => {
      const idxUrl = `${root}/data/idx/${day}.json`;
      if (!idxCache.has(idxUrl)) idxCache.set(idxUrl, limitFetch(() => fetch(idxUrl).then((r) => r.json())));
      const idx = await idxCache.get(idxUrl), day0 = Date.parse(`${day}T00:00:00Z`) / 1000;
      await Promise.all(
        keys.filter((k) => idx.tiles[k]).map(async (k) => {
          const [off, len] = idx.tiles[k];
          const text = new TextDecoder().decode(await rangeGunzip(`${root}/data/day/${day}.bin`, off, len));
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
  if (!base) {
    for (const tr of liveFeed.tracksNear(lat, lon, rKm, t0 - 120, t1 + 120)) {
      if (!byHex.has(tr.meta.hex)) byHex.set(tr.meta.hex, tr);
    }
  }
  return { tracks: [...byHex.values()], missing: want.filter((d) => !days.has(d)) };
}

function extrapRow(r, dt) {
  if (r[4] == null || r[5] == null) return null;
  const rad = (r[5] * Math.PI) / 180, ve = r[4] * Math.sin(rad), vn = r[4] * Math.cos(rad);
  const lat = r[1] + (vn * dt) / 111195, lon = r[2] + (ve * dt) / (111195 * Math.max(0.1, Math.cos((r[1] * Math.PI) / 180)));
  return [r[0] + dt, lat, lon, Math.max(30, r[3]), r[4], r[5], 0];
}

// Polls the live proxy and keeps the last 60 minutes of prop positions worldwide (zero location input).
export class LiveFeed {
  constructor(base = '') {
    this.base = base;
    this.ac = new Map();
    this.center = null;
    this.latest = [];
    this.now = 0;
    this.clockOffset = 0;
    this.lastPollMs = 0;
    this.lastSince = 0;
    this.ver = 0;
    this._idxVer = -1;
    this._minIdx = new Map();
    this._minRaw = new Map();
    this._flights = [];
    this._trks = [];
    this._day0 = 0;
  }
  async poll() {
    const q = this.center
      ? `?lat=${Math.round(this.center.lat * 4) / 4}&lon=${Math.round(this.center.lon * 4) / 4}`
      : this.lastSince > 0
        ? `?since=${Math.floor(this.lastSince)}`
        : '';
    const r = await fetch(`${this.base}/api/live${q}`);
    if (!r.ok) throw new Error(`live feed ${r.status}`);
    const d = await r.json();
    return this._ingest(d, true);
  }
  async ensureWindow(s0, s1) {
    const nowEst = this.now || Date.now() / 1000;
    if (s1 < nowEst - 10800 || s0 > nowEst + 600) return;
    const win = this.window();
    if (win && s0 >= win[0] + 60 && s1 <= win[1] - 5) return;
    const since = Math.floor(s0 - 180),
      until = Math.ceil(s1 + 180);
    const r = await fetch(`${this.base}/api/live?since=${since}&until=${until}`);
    if (!r.ok) return;
    const d = await r.json();
    this._ingest(d, false);
  }
  _ingest(d, updateSince = true) {
    const localNow = Date.now() / 1000;
    this.now = (d.now ?? Date.now()) / 1000;
    if (Math.abs(this.now - localNow) > 60) this.clockOffset = this.now - localNow;
    else this.clockOffset = 0;
    if (updateSince) this.lastPollMs = Date.now();
    if (Array.isArray(d.ac) && d.ac.length) this.latest = d.ac;
    if (Array.isArray(d.tracks)) {
      for (const tr of d.tracks) {
        if (!tr?.h || !Array.isArray(tr.p)) continue;
        let e = this.ac.get(tr.h);
        if (!e) {
          e = { meta: { hex: tr.h, type: tr.t, reg: tr.r ?? null, flight: tr.fl ?? null }, rows: [], _dirty: true };
          this.ac.set(tr.h, e);
        } else {
          e.meta.type = tr.t || e.meta.type;
          e.meta.reg = tr.r ?? e.meta.reg;
          e.meta.flight = tr.fl ?? e.meta.flight;
        }
        for (const p of tr.p) {
          if (!Array.isArray(p) || p[1] == null || typeof p[3] !== 'number') continue;
          const t = p[0];
          const last = e.rows[e.rows.length - 1];
          if (last) {
            if (Math.abs(t - last[0]) < 0.5) continue;
            if (t < last[0] && e.rows.some((r) => Math.abs(r[0] - t) < 0.5)) continue;
          }
          e.rows.push([
            t,
            p[1],
            p[2],
            p[3] * FT,
            p[4] == null ? null : p[4] * KT,
            p[5] ?? null,
            p[6] == null ? null : (p[6] * FT) / 60,
          ]);
          e._dirty = true;
        }
      }
    }
    for (const a of this.latest) {
      const alt = a.alt_geom ?? a.alt_baro,
        rate = a.geom_rate ?? a.baro_rate;
      if (a.lat == null || typeof alt !== 'number') continue;
      const t = this.now - (a.seen_pos ?? 0);
      let e = this.ac.get(a.hex);
      if (!e) this.ac.set(a.hex, (e = { meta: { hex: a.hex, type: a.t, reg: a.r ?? null, flight: a.flight?.trim() || null }, rows: [], _dirty: true }));
      const last = e.rows[e.rows.length - 1];
      if (last && Math.abs(t - last[0]) < 0.5) continue;
      e.rows.push([t, a.lat, a.lon, alt * FT, a.gs == null ? null : a.gs * KT, a.track ?? null, rate == null ? null : (rate * FT) / 60]);
      e._dirty = true;
    }
    for (const [hex, e] of this.ac) {
      if (e.rows.length > 1 && e._dirty) e.rows.sort((a, b) => a[0] - b[0]);
      if (e.rows.length && e.rows[0][0] <= this.now - 43200) {
        e.rows = e.rows.filter((x) => x[0] > this.now - 43200);
        e._dirty = true;
      }
      if (!e.rows.length) this.ac.delete(hex);
    }
    if (updateSince && !this.center && this.ac.size) this.lastSince = this.now;
    this.ver++;
    return d;
  }
  _ensureEntry(e) {
    if (!e._dirty && e._trk !== undefined) return;
    e._dirty = false;
    if (!e.rows.length) {
      e._full = null;
      e._fr = null;
      e._trk = null;
      return;
    }
    const r0 = e.rows[0],
      r1 = e.rows[e.rows.length - 1];
    const pre = [-180, -135, -90, -45].map((dt) => extrapRow(r0, dt)).filter(Boolean);
    const post = [45, 90].map((dt) => extrapRow(r1, dt)).filter(Boolean);
    const rows = [...pre, ...e.rows, ...post];
    if (rows.length < 2) {
      e._full = null;
      e._fr = null;
      e._trk = null;
      return;
    }
    e._full = { meta: e.meta, rows };
    const fr = frameAt(rows[0][1], rows[0][2]);
    e._fr = fr;
    e._trk = buildTrack(e.meta, rows, fr);
  }
  tracks() {
    const out = [];
    for (const e of this.ac.values()) {
      if (!e.rows.length) continue;
      this._ensureEntry(e);
      if (e._full) out.push(e._full);
    }
    return out;
  }
  window() {
    if (!this.ac.size) return null;
    let t0 = Infinity,
      t1 = -Infinity;
    for (const e of this.ac.values()) {
      if (!e.rows.length) continue;
      t0 = Math.min(t0, e.rows[0][0] - 180);
      t1 = Math.max(t1, e.rows[e.rows.length - 1][0] + 90);
    }
    return t0 < t1 ? [t0, t1] : null;
  }
  tracksNear(lat, lon, rKm, t0, t1) {
    if (!this.ac.size) return [];
    const dLat = (rKm + 15) / 111,
      dLon = dLat / Math.max(0.1, Math.cos((lat * Math.PI) / 180));
    const out = [];
    for (const e of this.ac.values()) {
      if (!e.rows.length) continue;
      if (!e.rows.some((r) => r[0] >= t0 - 90 && r[0] <= t1 + 180 && Math.abs(r[1] - lat) <= dLat && Math.abs(r[2] - lon) <= dLon)) continue;
      this._ensureEntry(e);
      if (e._full) out.push(e._full);
    }
    return out;
  }
  _ensureBase() {
    if (this._idxVer === this.ver) return;
    const win = this.window(),
      day0 = win ? Math.floor(win[0] / 86400) * 86400 : 0;
    const flights = [],
      trks = [];
    for (const e of this.ac.values()) {
      if (!e.rows.length) continue;
      this._ensureEntry(e);
      if (!e._trk) continue;
      const f = { hex: e.meta.hex, type: e.meta.type, reg: e.meta.reg };
      const fi = flights.push(f) - 1;
      trks.push({ fi, f, trk: e._trk, fr: e._fr });
    }
    this._flights = flights;
    this._trks = trks;
    this._day0 = day0;
    this._minIdx.clear();
    this._minRaw.clear();
    this._idxVer = this.ver;
  }
  _ensureMin(min) {
    this._ensureBase();
    if (this._minRaw.has(min)) return;
    const tStart = min * 60,
      tEnd = tStart + 60,
      day0 = this._day0;
    const idxBands = new Map(),
      rawBands = new Map();
    for (const { fi, f, trk, fr } of this._trks) {
      if (trk.t1 < tStart || trk.t0 >= tEnd) continue;
      const ts0 = Math.max(tStart, Math.ceil(trk.t0 / 4) * 4);
      const ts1 = Math.min(tEnd - 0.001, trk.t1);
      for (let ts = ts0; ts <= ts1; ts += 4) {
        const s = trk.state(ts);
        if (!s || s.z > 4000) continue;
        const v = Math.hypot(s.vx, s.vy, s.vz);
        if (v < 15) continue;
        const band = Math.floor(v / 4);
        const lat = fr.lat(s.y),
          lon = fr.lon(s.x);
        let arr = idxBands.get(band);
        if (!arr) idxBands.set(band, (arr = []));
        arr.push({ f, t: ts, lat, lon, z: s.z, ve: s.vx, vn: s.vy, vz: s.vz });
        let rarr = rawBands.get(band);
        if (!rarr) rawBands.set(band, (rarr = []));
        rarr.push([
          fi,
          Math.max(0, Math.round((ts - day0) * 10)),
          Math.round(lat * 1e6),
          Math.round(lon * 1e6),
          Math.round(s.z),
          Math.round(s.vx * 10),
          Math.round(s.vy * 10),
          Math.round(s.vz * 10),
        ]);
      }
    }
    const rawMap = new Map();
    for (const [band, rows] of rawBands) {
      const buf = new ArrayBuffer(rows.length * 24),
        dv = new DataView(buf);
      for (let i = 0; i < rows.length; i++) {
        const o = i * 24,
          r = rows[i];
        dv.setUint32(o, r[0], true);
        dv.setUint32(o + 4, r[1], true);
        dv.setInt32(o + 8, r[2], true);
        dv.setInt32(o + 12, r[3], true);
        dv.setInt16(o + 16, Math.max(-32768, Math.min(32767, r[4])), true);
        dv.setInt16(o + 18, Math.max(-32768, Math.min(32767, r[5])), true);
        dv.setInt16(o + 20, Math.max(-32768, Math.min(32767, r[6])), true);
        dv.setInt16(o + 22, Math.max(-32768, Math.min(32767, r[7])), true);
      }
      rawMap.set(band, new Uint8Array(buf));
    }
    this._minIdx.set(min, idxBands);
    this._minRaw.set(min, rawMap);
  }
  shard(min, band) {
    if (!this.ac.size) return [];
    this._ensureMin(min);
    return this._minIdx.get(min)?.get(band) ?? [];
  }
  rawShard(min, band) {
    if (!this.ac.size) return null;
    this._ensureMin(min);
    const bytes = this._minRaw.get(min)?.get(band);
    return bytes ? { bytes, flights: this._flights, day0: this._day0, ver: this.ver } : null;
  }
}
export const liveFeed = new LiveFeed();
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
