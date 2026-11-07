// adsb.lol readsb tarball (stdin) -> prop-only day index.
// out/day/DATE.bin: gzipped capnstruct TrackBundle (LiveTrackHeader + LiveTrackPoint) chunk per 1 degree tile,
// out/idx/DATE.json: tile -> [offset, length, points].
// out/spd/DATE.bin + DATE.json: speed index. Every prop flight sampled every 4 s, sharded by (minute of day, 4 m/s speed band),
// so a detected pass only fetches the few shards matching its speed and time. Record: 24-byte SpdSample (#[repr(C)]).
// Usage: cat v2026.11.01-planes-readsb-prod-0.tar.* | node scripts/build-index.mjs 2026-11-01 out
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildTrack } from '../public/lib/physics.js';
import { frameAt } from '../public/lib/geo.js';
import { LiveTrackHeader, LiveTrackPoint, SpdSample, packTrackBundle } from '../public/lib/schemas.js';

const FT = 0.3048,
  KT = 0.514444,
  MAX_ALT_FT = 20000;
export const SPD_REC = SpdSample.size,
  SPD_STEP = 4,
  SPD_BAND = 4,
  SPD_MAX_Z = 4000;
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

// Index rows are [tEpoch, lat, lon, altFt, gsKt, trkDeg, vrFpm]; resample the smoothed track every SPD_STEP s.
function speedSamples(d, rows, day0, flights, spend, nspd) {
  if (rows.length < 2) return 0;
  rows.sort((a, b) => a[0] - b[0]);
  const r0 = rows[0],
    fr = frameAt(r0[1], r0[2]);
  const trk = buildTrack(
    {},
    rows.map((r) => [r[0], r[1], r[2], r[3] * FT, r[4] == null ? null : r[4] * KT, r[5], r[6] == null ? null : (r[6] * FT) / 60]),
    fr,
  );
  if (!trk) return 0;
  const fi = flights.push([d.icao, d.t ?? null, d.r ?? null]) - 1;
  let bytes = 0;
  for (let t = Math.ceil(trk.t0 / SPD_STEP) * SPD_STEP; t <= trk.t1; t += SPD_STEP) {
    const s = trk.state(t);
    if (!s || s.z > SPD_MAX_Z || t < day0 || t >= day0 + 86400) continue;
    const v = Math.hypot(s.vx, s.vy, s.vz);
    if (v < 15) continue;
    const k = `${Math.floor((t - day0) / 60)}_${Math.floor(v / SPD_BAND)}`;
    const sample = SpdSample.create({
      fi,
      t_ds: Math.round((t - day0) * 10),
      lat_e6: Math.round(fr.lat(s.y) * 1e6),
      lon_e6: Math.round(fr.lon(s.x) * 1e6),
      z: Math.round(s.z),
      ve_dm: Math.max(-32768, Math.min(32767, Math.round(s.vx * 10))),
      vn_dm: Math.max(-32768, Math.min(32767, Math.round(s.vy * 10))),
      vz_dm: Math.max(-32768, Math.min(32767, Math.round(s.vz * 10))),
    });
    if (!spend.has(k)) spend.set(k, []);
    spend.get(k).push(Buffer.from(sample.bytes.buffer, sample.bytes.byteOffset, sample.bytes.byteLength));
    nspd.set(k, (nspd.get(k) ?? 0) + 1);
    bytes += SPD_REC;
  }
  return bytes;
}

function packTileBundle(items, day0) {
  let totalPts = 0,
    validTracks = 0;
  for (const tr of items) {
    if (tr.p?.length) {
      validTracks++;
      totalPts += tr.p.length;
    }
  }
  const hdrsView = LiveTrackHeader.alloc(validTracks);
  const ptsView = LiveTrackPoint.alloc(totalPts);
  const hCur = hdrsView.cursor();
  const ptCur = ptsView.cursor();
  let hIdx = 0,
    ptIdx = 0;
  for (const tr of items) {
    const pts = tr.p;
    if (!pts?.length) continue;
    hCur.at(hIdx++);
    hCur.pt_off = ptIdx;
    hCur.pt_cnt = pts.length;
    hCur.hex = tr.h || '';
    hCur.type = tr.t || '';
    hCur.reg = tr.r || '';
    hCur.flight = '';
    for (let j = 0; j < pts.length; j++) {
      const p = pts[j];
      ptCur.at(ptIdx++);
      ptCur.t_ds = Math.max(0, Math.round((p[0] - day0) * 10));
      ptCur.lat = p[1];
      ptCur.lon = p[2];
      ptCur.alt = Math.max(-32768, Math.min(32767, Math.round(p[3])));
      ptCur.gs = p[4];
      ptCur.track = p[5];
      ptCur.rate = p[6] == null ? null : Math.max(-32768, Math.min(32767, Math.round(p[6])));
    }
  }
  return packTrackBundle(hdrsView, ptsView, day0);
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
    for (const [k, v] of spend) fs.appendFileSync(path.join(stmp, k), Buffer.concat(v));
    spend.clear();
    spdBytes = 0;
  };
  for await (const d of traces) {
    if (++files % 20000 === 0) log(`${files} traces, ${kept} props`);
    if (!props.has(d.t)) continue;
    const tiles = new Map();
    let lastT = -Infinity;
    for (const r of d.trace) {
      const t = d.timestamp + r[0],
        alt = r[10] ?? r[3];
      if (r[3] === 'ground' || typeof alt !== 'number' || alt > MAX_ALT_FT || t < day0 || t >= day0 + 86400 || t - lastT < 2) continue;
      lastT = t;
      const key = `${Math.floor(r[1])}_${Math.floor(r[2])}`,
        vr = r[11] ?? r[7];
      if (!tiles.has(key)) tiles.set(key, []);
      tiles.get(key).push([
        Math.round(t * 10) / 10,
        r[1],
        r[2],
        alt,
        r[4] == null ? null : r[4],
        r[5] == null ? null : r[5],
        vr == null ? null : vr,
      ]);
    }
    if (tiles.size) kept++;
    spdBytes += speedSamples(d, [...tiles.values()].flat(), day0, flights, spend, nspd);
    for (const [k, p] of tiles) {
      if (!pend.has(k)) pend.set(k, []);
      pend.get(k).push({ h: d.icao, t: d.t, r: d.r ?? null, p });
      npts.set(k, (npts.get(k) ?? 0) + p.length);
    }
    if (spdBytes > 256e6) flush();
  }
  flush();
  for (const sub of ['day', 'idx']) fs.mkdirSync(path.join(out, sub), { recursive: true });
  const binPath = path.join(out, 'day', `${date}.bin`),
    fd = fs.openSync(binPath, 'w'),
    tiles = {};
  let off = 0;
  for (const k of [...pend.keys()].sort()) {
    const bundle = packTileBundle(pend.get(k), day0);
    const gz = zlib.gzipSync(bundle, { level: 9 });
    fs.writeSync(fd, gz);
    tiles[k] = [off, gz.length, npts.get(k)];
    off += gz.length;
  }
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
  const days = fs
    .readdirSync(path.join(out, 'idx'))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort();
  fs.writeFileSync(path.join(out, 'days.json'), JSON.stringify(days));
  fs.rmSync(tmp, { recursive: true, force: true });
  return { files, kept, tiles: Object.keys(tiles).length, bytes: off, spdKeys: Object.keys(keys).length, spdBytes: soff, points: [...npts.values()].reduce((a, b) => a + b, 0) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [date, out = 'public/data'] = process.argv.slice(2);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || process.stdin.isTTY) {
    console.error('usage: cat vYYYY.MM.DD-planes-readsb-prod-0.tar.* | npm run index:day -- YYYY-MM-DD [public/data]');
    process.exit(1);
  }
  const stats = await buildIndex(tarTraces(process.stdin), { date, out, props: loadProps(), log: console.error });
  console.log(JSON.stringify(stats));
}
