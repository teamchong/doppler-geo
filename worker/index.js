import { DurableObject } from 'cloudflare:workers';
import PROPS from '../public/prop-types.json';
import { RpcTarget, newWorkersRpcResponse } from '../public/lib/vendor/capnweb.js';
import { LiveTrackHeader, LiveTrackPoint, NULL_I16 } from '../public/lib/schemas.js';
const PROP = new Set(PROPS);
const LIVE_TYPES = PROPS.slice(0, 750).join(',');
const FIELDS = ['hex', 't', 'r', 'flight', 'lat', 'lon', 'alt_baro', 'alt_geom', 'gs', 'track', 'baro_rate', 'geom_rate', 'seen_pos'];
const WINDOW_S = 86400;
const HOT_WINDOW_S = 1800;
const BUCKET_S = 600;
const MIN_STEP_S = 8;
const POLL_MIN_MS = 10_000;
const ALARM_MS = 20_000;
const CHECKPOINT_MS = 60_000;

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...init.headers } });

async function fetchUpstream(upstream) {
  const r = await fetch(upstream, { headers: { 'user-agent': 'doppler-geo/1.0' } });
  if (!r.ok) throw new Error(`adsb.lol ${r.status}`);
  const txt = await r.text();
  let d;
  try {
    d = JSON.parse(txt);
  } catch {
    d = JSON.parse(txt.replace(/(\s\x1f)+/g, '$1'));
  }
  const ac = (d.ac ?? [])
    .filter((a) => PROP.has(a.t) && a.alt_baro !== 'ground' && Number.isFinite(a.lat) && Number.isFinite(a.lon))
    .map((a) => Object.fromEntries(FIELDS.map((f) => [f, a[f] ?? null])));
  return { now: d.now ?? Date.now(), ac };
}

// Singleton Durable Object that maintains a continuous 60-minute rolling window of worldwide prop aircraft tracks.
function packParts(list) {
  const parts = [];
  let cur = [],
    curPts = 0;
  for (const item of list) {
    if (!item.p?.length) continue;
    if (cur.length && (curPts + item.p.length > 900 || cur.length >= 100)) {
      parts.push(cur);
      cur = [];
      curPts = 0;
    }
    cur.push(item);
    curPts += item.p.length;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

export class LiveTrackerDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ac = new Map();
    this.latest = [];
    this.now = 0;
    this.lastPollMs = 0;
    this.lastSaveMs = 0;
    this.polling = null;
    this.minBucket = null;
    this.maxBucket = null;
    this.ctx.blockConcurrencyWhile(async () => {
      await this._restore();
      const alarm = await this.ctx.storage.getAlarm();
      if (!alarm) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
    });
  }

  async _readBucket(b) {
    const meta = await this.ctx.storage.get(`b_${b}_meta`);
    if (!meta || !meta.parts) return [];
    const keys = Array.from({ length: meta.parts }, (_, i) => `b_${b}_${i}`);
    const out = [];
    for (let i = 0; i < keys.length; i += 128) {
      const map = await this.ctx.storage.get(keys.slice(i, i + 128));
      for (let j = i; j < Math.min(keys.length, i + 128); j++) {
        const part = map.get(keys[j]);
        if (Array.isArray(part)) out.push(...part);
      }
    }
    return out;
  }
  async _writeBucket(b, list) {
    if (!list.length) return;
    const exists = this.minBucket !== null && this.maxBucket !== null && b >= this.minBucket && b <= this.maxBucket;
    const prev = exists ? await this._readBucket(b) : [];
    if (prev.length) {
      const byHex = new Map(prev.map((e) => [e.h, e]));
      for (const item of list) {
        const ex = byHex.get(item.h);
        if (!ex) {
          byHex.set(item.h, item);
        } else {
          ex.t = item.t || ex.t;
          ex.r = item.r ?? ex.r;
          ex.fl = item.fl ?? ex.fl;
          const lastT = ex.p.length ? ex.p[ex.p.length - 1][0] : -Infinity;
          for (const pt of item.p) {
            if (pt[0] > lastT) ex.p.push(pt);
          }
        }
      }
      list = [...byHex.values()];
    }
    const parts = packParts(list);
    const puts = { [`b_${b}_meta`]: { parts: parts.length } };
    for (let i = 0; i < parts.length; i++) {
      puts[`b_${b}_${i}`] = parts[i];
    }
    const entries = Object.entries(puts);
    for (let i = 0; i < entries.length; i += 128) {
      await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
    }
    if (this.minBucket === null || b < this.minBucket) this.minBucket = b;
    if (this.maxBucket === null || b > this.maxBucket) this.maxBucket = b;
  }

  async _archiveCold(nowSec) {
    const coldBucket = Math.floor((nowSec - HOT_WINDOW_S) / BUCKET_S);
    const minKeepBucket = Math.floor((nowSec - WINDOW_S) / BUCKET_S);
    let minT = Infinity;
    for (const e of this.ac.values()) {
      if (e.p.length && e.p[0][0] < minT) minT = e.p[0][0];
    }
    let changed = false;
    if (Number.isFinite(minT)) {
      const startBucket = Math.floor(minT / BUCKET_S);
      for (let b = startBucket; b < coldBucket; b++) {
        const bEnd = (b + 1) * BUCKET_S;
        const list = [];
        for (const [hex, e] of this.ac) {
          if (!e.p.length || e.p[0][0] >= bEnd) continue;
          let k = 0;
          while (k < e.p.length && e.p[k][0] < bEnd) k++;
          const pts = e.p.splice(0, k);
          if (b >= minKeepBucket && pts.length) {
            list.push({ h: e.h, t: e.t, r: e.r, fl: e.fl, p: pts });
          }
          if (!e.p.length) this.ac.delete(hex);
        }
        if (b >= minKeepBucket && list.length) {
          await this._writeBucket(b, list);
          changed = true;
        }
      }
    }
    if (this.minBucket !== null && this.minBucket < minKeepBucket) {
      for (let b = this.minBucket; b < minKeepBucket; b++) {
        const meta = await this.ctx.storage.get(`b_${b}_meta`);
        if (meta?.parts) {
          const keys = Array.from({ length: meta.parts }, (_, i) => `b_${b}_${i}`);
          keys.push(`b_${b}_meta`);
          for (let i = 0; i < keys.length; i += 128) {
            await this.ctx.storage.delete(keys.slice(i, i + 128));
          }
        }
      }
      this.minBucket = this.maxBucket !== null && this.maxBucket >= minKeepBucket ? minKeepBucket : null;
      if (this.minBucket === null) this.maxBucket = null;
      changed = true;
    }
    if (changed) {
      await this.ctx.storage.put('archive_meta', { minBucket: this.minBucket, maxBucket: this.maxBucket });
    }
  }

  async _restore() {
    try {
      const arch = await this.ctx.storage.get('archive_meta');
      if (arch) {
        this.minBucket = arch.minBucket ?? null;
        this.maxBucket = arch.maxBucket ?? null;
      }
      const nowSec = Date.now() / 1000;
      const cut = nowSec - WINDOW_S;
      const hotMeta = await this.ctx.storage.get('hot_meta');
      if (hotMeta?.parts) {
        this.now = hotMeta.now || 0;
        const keys = Array.from({ length: hotMeta.parts }, (_, i) => `hot_${i}`);
        for (let i = 0; i < keys.length; i += 128) {
          const map = await this.ctx.storage.get(keys.slice(i, i + 128));
          for (const list of map.values()) {
            if (!Array.isArray(list)) continue;
            for (const item of list) {
              const p = (item.p ?? []).filter((r) => r[0] > cut);
              if (p.length) this.ac.set(item.h, { h: item.h, t: item.t, r: item.r, fl: item.fl ?? null, p });
            }
          }
        }
      }
      const meta = await this.ctx.storage.get('meta');
      if (meta?.chunks) {
        if (!this.now) this.now = meta.now || 0;
        const keys = Array.from({ length: meta.chunks }, (_, i) => `chunk_${i}`);
        for (let i = 0; i < keys.length; i += 128) {
          const map = await this.ctx.storage.get(keys.slice(i, i + 128));
          for (const list of map.values()) {
            if (!Array.isArray(list)) continue;
            for (const item of list) {
              const p = (item.p ?? []).filter((r) => r[0] > cut);
              if (!p.length) continue;
              const ex = this.ac.get(item.h);
              if (!ex) {
                this.ac.set(item.h, { h: item.h, t: item.t, r: item.r, fl: item.fl ?? null, p });
              } else {
                ex.p.push(...p);
                ex.p.sort((a, b) => a[0] - b[0]);
              }
            }
          }
        }
        await this._archiveCold(nowSec);
        await this._checkpoint();
        const delKeys = ['meta', ...keys];
        for (let i = 0; i < delKeys.length; i += 128) {
          await this.ctx.storage.delete(delKeys.slice(i, i + 128));
        }
      } else if (this.ac.size) {
        await this._archiveCold(nowSec);
      }
    } catch {}
  }

  async _checkpoint() {
    this.lastSaveMs = Date.now();
    try {
      const nowSec = (this.now || Date.now()) / 1000;
      await this._archiveCold(nowSec);
      const parts = packParts([...this.ac.values()]);
      for (let i = 0; i < parts.length; i += 128) {
        const batch = {};
        const end = Math.min(parts.length, i + 128);
        for (let j = i; j < end; j++) batch[`hot_${j}`] = parts[j];
        await this.ctx.storage.put(batch);
      }
      await this.ctx.storage.put('hot_meta', { now: this.now, parts: parts.length });
    } catch {}
  }

  async _pollIfNeeded() {
    const nowMs = Date.now();
    if (this.lastPollMs && nowMs - this.lastPollMs < POLL_MIN_MS && this.ac.size) return;
    if (this.polling) return this.polling;
    this.polling = (async () => {
      try {
        const { now, ac } = await fetchUpstream(`https://api.adsb.lol/v2/type/${LIVE_TYPES}`);
        this.now = now;
        this.latest = ac;
        this.lastPollMs = Date.now();
        const nowSec = this.now / 1000;
        for (const a of ac) {
          const alt = a.alt_geom ?? a.alt_baro;
          const rate = a.geom_rate ?? a.baro_rate;
          if (a.lat == null || typeof alt !== 'number') continue;
          const t = Math.round((nowSec - (a.seen_pos ?? 0)) * 10) / 10;
          let e = this.ac.get(a.hex);
          if (!e) {
            e = { h: a.hex, t: a.t, r: a.r ?? null, fl: a.flight?.trim() || null, p: [] };
            this.ac.set(a.hex, e);
          } else {
            e.t = a.t || e.t;
            e.r = a.r ?? e.r;
            e.fl = a.flight?.trim() || e.fl;
          }
          const last = e.p[e.p.length - 1];
          if (last && t - last[0] < MIN_STEP_S) continue;
          e.p.push([
            t,
            Math.round(a.lat * 1e5) / 1e5,
            Math.round(a.lon * 1e5) / 1e5,
            Math.round(alt),
            a.gs == null ? null : Math.round(a.gs * 10) / 10,
            a.track == null ? null : Math.round(a.track * 10) / 10,
            rate == null ? null : Math.round(rate),
          ]);
        }
        if (Date.now() - this.lastSaveMs >= CHECKPOINT_MS) {
          await this._checkpoint();
        }
      } finally {
        this.polling = null;
      }
    })();
    return this.polling;
  }

  async alarm() {
    try {
      await this._pollIfNeeded();
    } catch {}
    await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
  }

  async _collectSlice(sinceParam, untilParam) {
    const until = untilParam !== null && untilParam !== undefined ? Number(untilParam) || Infinity : Infinity;
    const nowEst = (this.now || Date.now()) / 1000;
    if (!this.ac.size || !Number.isFinite(until) || until >= nowEst - 30) {
      try {
        await this._pollIfNeeded();
      } catch (e) {
        if (!this.ac.size && this.minBucket === null) throw e;
      }
    }
    const nowSec = (this.now || Date.now()) / 1000;
    const since = sinceParam !== null && sinceParam !== undefined ? Number(sinceParam) || 0 : nowSec - 1200;
    const byHex = new Map();
    if (this.minBucket !== null && this.maxBucket !== null && since < (this.maxBucket + 1) * BUCKET_S) {
      let bStart = Math.max(this.minBucket, Math.floor((since - 1) / BUCKET_S));
      const bEnd = Math.min(this.maxBucket, Math.floor((Math.min(until, nowSec) + 1) / BUCKET_S));
      if (bEnd - bStart > 6) bStart = bEnd - 6;
      for (let b = bStart; b <= bEnd; b++) {
        const list = await this._readBucket(b);
        for (const e of list) {
          const pts = e.p.filter((r) => r[0] > since - 1 && r[0] <= until + 1);
          if (!pts.length) continue;
          const ex = byHex.get(e.h);
          if (!ex) {
            byHex.set(e.h, { h: e.h, t: e.t, r: e.r, fl: e.fl, p: pts });
          } else {
            ex.t = e.t || ex.t;
            ex.r = e.r ?? ex.r;
            ex.fl = e.fl ?? ex.fl;
            ex.p.push(...pts);
          }
        }
      }
    }
    let t0 = this.minBucket !== null ? this.minBucket * BUCKET_S : Infinity;
    let t1 = this.maxBucket !== null ? (this.maxBucket + 1) * BUCKET_S : -Infinity;
    for (const e of this.ac.values()) {
      if (!e.p.length) continue;
      if (e.p[0][0] < t0) t0 = e.p[0][0];
      if (e.p[e.p.length - 1][0] > t1) t1 = e.p[e.p.length - 1][0];
      if (e.p[e.p.length - 1][0] <= since - 1 || e.p[0][0] > until + 1) continue;
      const pts = since > 0 || until < Infinity ? e.p.filter((r) => r[0] > since - 1 && r[0] <= until + 1) : e.p;
      if (!pts.length) continue;
      const ex = byHex.get(e.h);
      if (!ex) {
        byHex.set(e.h, { h: e.h, t: e.t, r: e.r, fl: e.fl, p: pts });
      } else {
        ex.t = e.t || ex.t;
        ex.r = e.r ?? ex.r;
        ex.fl = e.fl ?? ex.fl;
        ex.p.push(...pts);
      }
    }
    return {
      now: this.now || Date.now(),
      window: t0 < t1 ? [t0, t1] : null,
      byHex,
    };
  }

  async getBinarySlice(opts = {}) {
    const { now, window, byHex } = await this._collectSlice(opts.since ?? null, opts.until ?? null);
    const baseSec = window ? Math.floor(window[0]) : Math.floor(now / 1000);
    let totalPts = 0;
    for (const tr of byHex.values()) totalPts += tr.p.length;
    const ptsView = LiveTrackPoint.alloc(totalPts);
    const hdrInput = [];
    let ptIdx = 0;
    for (const tr of byHex.values()) {
      const pts = tr.p;
      if (!pts.length) continue;
      hdrInput.push({
        pt_off: ptIdx,
        pt_cnt: pts.length,
        hex: tr.h || '',
        type: tr.t || '',
        reg: tr.r || '',
        flight: tr.fl || '',
      });
      for (let j = 0; j < pts.length; j++) {
        const p = pts[j];
        const cur = ptsView.cursor(ptIdx++);
        cur.t_ds = Math.max(0, Math.round((p[0] - baseSec) * 10));
        cur.lat_e5 = Math.round(p[1] * 1e5);
        cur.lon_e5 = Math.round(p[2] * 1e5);
        cur.alt = Math.max(-32768, Math.min(32767, Math.round(p[3])));
        cur.gs_d = p[4] == null ? NULL_I16 : Math.round(p[4] * 10);
        cur.track_d = p[5] == null ? NULL_I16 : Math.round(p[5] * 10);
        cur.rate = p[6] == null ? NULL_I16 : Math.max(-32768, Math.min(32767, Math.round(p[6])));
      }
    }
    return {
      now,
      window,
      baseSec,
      trackHeaders: LiveTrackHeader.pack(hdrInput),
      trackPoints: ptsView.bytes,
    };
  }

  async fetch(req) {
    if (req.method === 'POST' || req.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return newWorkersRpcResponse(req, new LiveTrackerRpc(this), { binary: true });
    }
    const url = new URL(req.url);
    let slice;
    try {
      slice = await this._collectSlice(url.searchParams.get('since'), url.searchParams.get('until'));
    } catch (e) {
      return json({ error: e.message }, { status: 502 });
    }
    return json(
      {
        now: slice.now,
        window: slice.window,
        ac: this.latest,
        tracks: [...slice.byHex.values()],
      },
      {
        headers: { 'cache-control': 'no-store' },
      },
    );
  }
}

class LiveTrackerRpc extends RpcTarget {
  constructor(tracker) {
    super();
    this.tracker = tracker;
  }
  getSlice(opts = {}) {
    return this.tracker.getBinarySlice(opts);
  }
}

// Stateless edge-cached fallback if Durable Object binding is absent or when querying a specific lat/lon cell.
async function liveStateless(req, ctx) {
  const url = new URL(req.url), hasLoc = url.searchParams.has('lat') || url.searchParams.has('lon');
  let key, upstream;
  if (hasLoc) {
    const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
    if (!url.searchParams.has('lat') || !url.searchParams.has('lon') || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      return json({ error: 'lat and lon required' }, { status: 400 });
    const cell = [Math.round(lat * 4) / 4, Math.round(lon * 4) / 4];
    key = new Request(`https://cache.internal/live/${cell[0]}/${cell[1]}`);
    upstream = `https://api.adsb.lol/v2/point/${cell[0]}/${cell[1]}/60`;
  } else {
    key = new Request('https://cache.internal/live/world');
    upstream = `https://api.adsb.lol/v2/type/${LIVE_TYPES}`;
  }
  let hit = await caches.default.match(key);
  if (!hit) {
    try {
      const { now, ac } = await fetchUpstream(upstream);
      hit = json({ now, ac }, { headers: { 'cache-control': 'public, max-age=5' } });
      ctx.waitUntil(caches.default.put(key, hit.clone()));
    } catch (e) {
      return json({ error: e.message }, { status: 502 });
    }
  }
  return new Response(hit.body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/api/live') {
      const hasLoc = url.searchParams.has('lat') || url.searchParams.has('lon');
      if (!hasLoc && env.LIVE_TRACKER) {
        const id = env.LIVE_TRACKER.idFromName('world');
        return env.LIVE_TRACKER.get(id).fetch(req);
      }
      return liveStateless(req, ctx);
    }
    const res = await env.ASSETS.fetch(req);
    if (res.status === 404 && url.pathname === '/data/days.json') {
      return json([]);
    }
    return res;
  },
};
