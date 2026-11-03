// adsb.lol readsb tarball (stdin) -> prop-only day index.
// out/day/DATE.bin: gzipped NDJSON chunk per 1 degree tile, out/idx/DATE.json: tile -> [offset, length, points].
// Line: {h, t, r, c: [t, lat, lon, alt, gs, trk, vr]} columns of ints. t (0.1 s since midnight), lat/lon (1e-4 deg)
// and alt (m) are delta coded; gs and vr in 0.1 m/s, trk in deg, null when missing.
// out/spd/DATE.bin + DATE.json: speed index. Every prop flight sampled every 4 s, sharded by (minute of day, 4 m/s speed band),
// so a detected pass only fetches the few shards matching its speed and time. Record: see SPD_REC.
// Usage: cat v2026.11.01-planes-readsb-prod-0.tar.* | node scripts/build-index.mjs 2026-11-01 out
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildTrack } from '../public/lib/physics.js';
import { frameAt } from '../public/lib/geo.js';

const FT = 0.3048, KT = 0.514444, MAX_ALT_FT = 20000;
// flight u32, t u32 (0.1 s since midnight), lat i32, lon i32 (1e-6 deg), alt i16 (m), vE vN vZ i16 (0.1 m/s). Little endian.
export const SPD_REC = 24, SPD_STEP = 4, SPD_BAND = 4, SPD_MAX_Z = 4000;

export function loadProps(file = new URL('../public/prop-types.json', import.meta.url)) {
  return new Set(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// Streaming ustar reader, tolerates a truncated tail.
async function* untar(input) {
  let buf = Buffer.alloc(0), hdr = null, longName = null;
  for await (const chunk of input) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
    for (;;) {
      if (!hdr) {
        if (buf.length < 512) break;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (h.every((b) => b === 0)) continue;
        const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
        const size = parseInt(str(124, 136).trim() || '0', 8), prefix = str(345, 500);
        hdr = { name: longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100)), size, pad: Math.ceil(size / 512) * 512, type: String.fromCharCode(h[156] || 48) };
        longName = null;
      }
      if (buf.length < hdr.pad) break;
      const data = buf.subarray(0, hdr.size);
      buf = buf.subarray(hdr.pad);
      if (hdr.type === 'L') longName = data.toString('utf8').replace(/\0.*$/s, '');
      else if (hdr.type === 'x') longName = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1] ?? null;
      else if (hdr.type === '0') yield { name: hdr.name, data };
      hdr = null;
    }
  }
}

// Index rows are [0.1 s since midnight, lat 1e-4, lon 1e-4, alt m, gs 0.1 m/s, trk, vr 0.1 m/s]; resample the smoothed track every SPD_STEP s.
function speedSamples(d, rows, day0, flights, spend, nspd) {
  if (rows.length < 2) return 0;
  rows.sort((a, b) => a[0] - b[0]);
  const r0 = rows[0], fr = frameAt(r0[1] / 1e4, r0[2] / 1e4);
  const trk = buildTrack({}, rows.map((r) => [day0 + r[0] / 10, r[1] / 1e4, r[2] / 1e4, r[3], r[4] == null ? null : r[4] / 10, r[5], r[6] == null ? null : r[6] / 10]), fr);
  if (!trk) return 0;
  const fi = flights.push([d.icao, d.t ?? null, d.r ?? null]) - 1;
  let bytes = 0;
  for (let t = Math.ceil(trk.t0 / SPD_STEP) * SPD_STEP; t <= trk.t1; t += SPD_STEP) {
    const s = trk.state(t);
    if (!s || s.z > SPD_MAX_Z || t < day0 || t >= day0 + 86400) continue;
    const v = Math.hypot(s.vx, s.vy, s.vz);
    if (v < 15) continue;
    const k = `${Math.floor((t - day0) / 60)}_${Math.floor(v / SPD_BAND)}`, b = Buffer.alloc(SPD_REC);
    b.writeUInt32LE(fi, 0);
    b.writeUInt32LE(Math.round((t - day0) * 10), 4);
    b.writeInt32LE(Math.round(fr.lat(s.y) * 1e6), 8);
    b.writeInt32LE(Math.round(fr.lon(s.x) * 1e6), 12);
    b.writeInt16LE(Math.round(s.z), 16);
    [s.vx, s.vy, s.vz].forEach((c, j) => b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(c * 10))), 18 + 2 * j));
    if (!spend.has(k)) spend.set(k, []);
    spend.get(k).push(b);
    nspd.set(k, (nspd.get(k) ?? 0) + 1);
    bytes += SPD_REC;
  }
  return bytes;
}

export async function* tarTraces(input) {
  for await (const { name, data } of untar(input)) {
    if (!/trace_full_[0-9a-f~]+\.json$/.test(name)) continue;
    try {
      yield JSON.parse((data[0] === 0x1f ? zlib.gunzipSync(data) : data).toString('utf8'));
    } catch {}
  }
}

export async function buildIndex(traces, { date, out, props, log = () => {} }) {
  const day0 = Date.parse(`${date}T00:00:00Z`) / 1000, tmp = path.join(out, `.tmp-${date}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const stmp = path.join(tmp, 'spd');
  fs.mkdirSync(stmp, { recursive: true });
  const pend = new Map(), npts = new Map(), spend = new Map(), nspd = new Map(), flights = [];
  let pendBytes = 0, spdBytes = 0, files = 0, kept = 0;
  const flush = () => {
    for (const [k, v] of pend) fs.appendFileSync(path.join(tmp, k), v.join(''));
    for (const [k, v] of spend) fs.appendFileSync(path.join(stmp, k), Buffer.concat(v));
    pend.clear();
    spend.clear();
    pendBytes = spdBytes = 0;
  };
  for await (const d of traces) {
    if (++files % 20000 === 0) log(`${files} traces, ${kept} props`);
    if (!props.has(d.t)) continue;
    const tiles = new Map();
    let lastT = -Infinity;
    for (const r of d.trace) {
      const t = d.timestamp + r[0], alt = r[10] ?? r[3];
      if (r[3] === 'ground' || typeof alt !== 'number' || alt > MAX_ALT_FT || t < day0 || t >= day0 + 86400 || t - lastT < 2) continue;
      lastT = t;
      const key = `${Math.floor(r[1])}_${Math.floor(r[2])}`, vr = r[11] ?? r[7];
      if (!tiles.has(key)) tiles.set(key, []);
      tiles.get(key).push([Math.round((t - day0) * 10), Math.round(r[1] * 1e4), Math.round(r[2] * 1e4), Math.round(alt * FT), r[4] == null ? null : Math.round(r[4] * KT * 10), r[5] == null ? null : Math.round(r[5]), vr == null ? null : Math.round(((vr * FT) / 60) * 10)]);
    }
    if (tiles.size) kept++;
    spdBytes += speedSamples(d, [...tiles.values()].flat(), day0, flights, spend, nspd);
    for (const [k, p] of tiles) {
      const c = [0, 1, 2, 3, 4, 5, 6].map((j) => p.map((row, i) => (j < 4 && i ? row[j] - p[i - 1][j] : row[j])));
      const line = JSON.stringify({ h: d.icao, t: d.t, r: d.r ?? null, c }) + '\n';
      if (!pend.has(k)) pend.set(k, []);
      pend.get(k).push(line);
      npts.set(k, (npts.get(k) ?? 0) + p.length);
      if ((pendBytes += line.length) + spdBytes > 256e6) flush();
    }
  }
  flush();

  for (const sub of ['day', 'idx']) fs.mkdirSync(path.join(out, sub), { recursive: true });
  const binPath = path.join(out, 'day', `${date}.bin`), fd = fs.openSync(binPath, 'w'), tiles = {};
  let off = 0;
  for (const k of fs.readdirSync(tmp).filter((f) => f !== 'spd').sort()) {
    const gz = zlib.gzipSync(fs.readFileSync(path.join(tmp, k)), { level: 9 });
    fs.writeSync(fd, gz);
    tiles[k] = [off, gz.length, npts.get(k)];
    off += gz.length;
  }
  fs.closeSync(fd);
  fs.writeFileSync(path.join(out, 'idx', `${date}.json`), JSON.stringify({ date, tiles }));
  fs.mkdirSync(path.join(out, 'spd'), { recursive: true });
  const sfd = fs.openSync(path.join(out, 'spd', `${date}.bin`), 'w'), keys = {};
  let soff = 0;
  for (const k of fs.readdirSync(stmp).sort()) {
    const gz = zlib.gzipSync(fs.readFileSync(path.join(stmp, k)), { level: 9 });
    fs.writeSync(sfd, gz);
    keys[k] = [soff, gz.length, nspd.get(k)];
    soff += gz.length;
  }
  fs.closeSync(sfd);
  fs.writeFileSync(path.join(out, 'spd', `${date}.json`), JSON.stringify({ date, step: SPD_STEP, band: SPD_BAND, flights, keys }));
  fs.rmSync(tmp, { recursive: true, force: true });
  return { files, kept, tiles: Object.keys(tiles).length, bytes: off, spdKeys: Object.keys(keys).length, spdBytes: soff, points: [...npts.values()].reduce((a, b) => a + b, 0) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [date, out = 'out'] = process.argv.slice(2);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
    console.error('usage: cat parts | node scripts/build-index.mjs YYYY-MM-DD [out]');
    process.exit(1);
  }
  const stats = await buildIndex(tarTraces(process.stdin), { date, out, props: loadProps(), log: console.error });
  console.log(JSON.stringify(stats));
}
