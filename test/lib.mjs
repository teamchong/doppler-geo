// Shared test helpers. Node 22+, ffmpeg on PATH for MP3 decoding.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
export const ROOT = new URL('../public/', import.meta.url).pathname, R = ROOT + 'lib/';

// Serve public/ to the lib code, honouring Range.
globalThis.fetch = async (url, o = {}) => {
  const f = ROOT + String(url).replace(/^\.?\//, '');
  if (!fs.existsSync(f)) return new Response(null, { status: 404 });
  const b = fs.readFileSync(f), m = /bytes=(\d+)-(\d+)/.exec(o.headers?.Range ?? '');
  return new Response(m ? b.subarray(+m[1], +m[2] + 1) : b, { status: m ? 206 : 200 });
};

export const { analyze, FS } = await import(R + 'spectro.js');
export const { search } = await import(R + 'search.js');
export const { buildTrack } = await import(R + 'physics.js');
export const { simulate } = await import(R + 'sim.js');
export const { frameAt, distM, FT, KT } = await import(R + 'geo.js');
export const BASE = 'examples/2025-07-18';

export function decode(file) {
  const b = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-ac', '1', '-ar', String(FS), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}

// 12 minutes of every worldwide prop flight, 2025-07-18 09:36-09:48 UTC. pts: [t - t0, lat, lon, alt ft | 'ground', gs kt, track].
export const SLICE = JSON.parse(fs.readFileSync(new URL('fixtures/kampina-slice.json', import.meta.url)));
export const rows = (m) => m.pts.map((q) => [SLICE.t0 + q[0], q[1], q[2], q[3] === 'ground' ? 0 : q[3] * FT, q[4] == null ? null : q[4] * KT, q[5], null]);

// Spots where two different airborne planes passed overhead 1-4 minutes apart. Deterministic.
export function pairSpots(n = 20) {
  const { ac } = SLICE, cells = new Map(), pairs = [], seen = new Set();
  for (const [hex, m] of Object.entries(ac)) {
    if (!m.pts.every((q) => q[3] !== 'ground')) continue;
    for (const q of m.pts) {
      if (q[0] < 0 || q[0] > 240 || q[3] > 3000) continue;
      const k = `${Math.round(q[1] / 0.015)},${Math.round(q[2] / 0.022)}`;
      for (const o of cells.get(k) ?? []) if (o.hex !== hex && Math.abs(o.t - q[0]) > 60 && Math.abs(o.t - q[0]) < 240) pairs.push([o, { hex, t: q[0], lat: q[1], lon: q[2] }]);
      cells.has(k) || cells.set(k, []);
      cells.get(k).push({ hex, t: q[0], lat: q[1], lon: q[2] });
    }
  }
  return pairs
    .filter(([a, b]) => { const k = [a.hex, b.hex].sort().join(); return !seen.has(k) && seen.add(k); })
    .slice(0, n)
    .map(([a, b], i) => {
      const lat = (a.lat + b.lat) / 2 + 0.003, lon = (a.lon + b.lon) / 2 - 0.004, fr = frameAt(lat, lon), start = SLICE.t0 - 30, dur = 300;
      const passes = [a, b].map((p, j) => ({ hex: p.hex, track: buildTrack({ hex: p.hex }, rows(SLICE.ac[p.hex]), fr), f0: [92, 118][j] }));
      return { i, lat, lon, start, dur, passes, seed: i + 1 };
    });
}

// Closest approach of a track to the mic, in recording seconds.
export function closest(track, start, dur, z = 1.5) {
  let best = { d: Infinity };
  for (let t = start; t <= start + dur; t += 0.25) {
    const s = track.state(t);
    if (!s) continue;
    const d = Math.hypot(s.x, s.y, s.z - z);
    if (d < best.d) best = { d, tc: t - start, v: Math.hypot(s.vx, s.vy) };
  }
  return best;
}
