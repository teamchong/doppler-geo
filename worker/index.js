import { DurableObject } from 'cloudflare:workers';
import PROPS from '../public/prop-types.json';

const PROP = new Set(PROPS);
const LIVE_TYPES = PROPS.slice(0, 750).join(',');
const FIELDS = ['hex', 't', 'r', 'flight', 'lat', 'lon', 'alt_baro', 'alt_geom', 'gs', 'track', 'baro_rate', 'geom_rate', 'seen_pos'];
const WINDOW_S = 21600;
const MIN_STEP_S = 8;
const POLL_MIN_MS = 10_000;
const ALARM_MS = 20_000;
const CHECKPOINT_MS = 60_000;
const CHUNK_SIZE = 250;

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
export class LiveTrackerDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ac = new Map();
    this.latest = [];
    this.now = 0;
    this.lastPollMs = 0;
    this.lastSaveMs = 0;
    this.polling = null;
    this.ctx.blockConcurrencyWhile(async () => {
      await this._restore();
      const alarm = await this.ctx.storage.getAlarm();
      if (!alarm) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
    });
  }

  async _restore() {
    try {
      const meta = await this.ctx.storage.get('meta');
      if (!meta || !meta.chunks) return;
      this.now = meta.now || 0;
      const keys = Array.from({ length: meta.chunks }, (_, i) => `chunk_${i}`);
      const map = await this.ctx.storage.get(keys);
      const cut = (this.now ? this.now / 1000 : Date.now() / 1000) - WINDOW_S;
      for (const k of keys) {
        const list = map.get(k);
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          const p = (item.p ?? []).filter((r) => r[0] > cut);
          if (p.length) this.ac.set(item.h, { h: item.h, t: item.t, r: item.r, fl: item.fl, p });
        }
      }
    } catch {}
  }

  async _checkpoint() {
    try {
      const all = [...this.ac.values()];
      const chunks = Math.ceil(all.length / CHUNK_SIZE);
      const puts = { meta: { now: this.now, chunks } };
      for (let i = 0; i < chunks; i++) {
        puts[`chunk_${i}`] = all.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      }
      await this.ctx.storage.put(puts);
      this.lastSaveMs = Date.now();
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
        const cut = nowSec - WINDOW_S;
        for (const [hex, e] of this.ac) {
          if (e.p.length && e.p[0][0] <= cut) e.p = e.p.filter((r) => r[0] > cut);
          if (!e.p.length) this.ac.delete(hex);
        }
        if (Date.now() - this.lastSaveMs >= CHECKPOINT_MS) {
          this.ctx.waitUntil(this._checkpoint());
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

  async fetch(req) {
    const url = new URL(req.url);
    try {
      await this._pollIfNeeded();
    } catch (e) {
      if (!this.ac.size) return json({ error: e.message }, { status: 502 });
    }
    const nowSec = (this.now || Date.now()) / 1000;
    const sinceParam = url.searchParams.get('since');
    const since = sinceParam !== null ? Number(sinceParam) || 0 : nowSec - 1200;
    const until = Number(url.searchParams.get('until')) || Infinity;
    const tracks = [];
    let t0 = Infinity, t1 = -Infinity;
    for (const e of this.ac.values()) {
      if (!e.p.length) continue;
      if (e.p[0][0] < t0) t0 = e.p[0][0];
      if (e.p[e.p.length - 1][0] > t1) t1 = e.p[e.p.length - 1][0];
      const pts = since > 0 || until < Infinity ? e.p.filter((r) => r[0] > since - 1 && r[0] <= until + 1) : e.p;
      if (pts.length) tracks.push({ h: e.h, t: e.t, r: e.r, fl: e.fl, p: pts });
    }
    return json(
      {
        now: this.now || Date.now(),
        window: t0 < t1 ? [t0, t1] : null,
        ac: this.latest,
        tracks,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
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
