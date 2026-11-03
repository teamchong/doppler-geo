import PROPS from '../public/prop-types.json';

const PROP = new Set(PROPS);
const FIELDS = ['hex', 't', 'r', 'flight', 'lat', 'lon', 'alt_baro', 'alt_geom', 'gs', 'track', 'baro_rate', 'geom_rate', 'seen_pos'];

const json = (body, init = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...init.headers } });

// Prop aircraft within 60 nm, shared by every visitor in the same 0.25 degree cell for 5 s.
async function live(req, ctx) {
  // Client sends only a rounded cell; never fall back to request IP location.
  const url = new URL(req.url), lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
  if (!url.searchParams.has('lat') || !url.searchParams.has('lon') || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ error: 'lat and lon required' }, { status: 400 });
  const cell = [Math.round(lat * 4) / 4, Math.round(lon * 4) / 4];
  const key = new Request(`https://cache.internal/live/${cell[0]}/${cell[1]}`);
  let hit = await caches.default.match(key);
  if (!hit) {
    const r = await fetch(`https://api.adsb.lol/v2/point/${cell[0]}/${cell[1]}/60`, { headers: { 'user-agent': 'doppler.teamchong.net' } });
    if (!r.ok) return json({ error: `adsb.lol ${r.status}` }, { status: 502 });
    const d = await r.json();
    const ac = (d.ac ?? []).filter((a) => PROP.has(a.t) && a.alt_baro !== 'ground').map((a) => Object.fromEntries(FIELDS.map((f) => [f, a[f] ?? null])));
    hit = json({ now: d.now, ac }, { headers: { 'cache-control': 'public, max-age=5' } });
    ctx.waitUntil(caches.default.put(key, hit.clone()));
  }
  return new Response(hit.body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export default {
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);
    if (pathname === '/api/live') return live(req, ctx);
    return env.ASSETS.fetch(req);
  },
};
