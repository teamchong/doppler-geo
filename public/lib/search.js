import { buildTrack } from './physics.js';
import { score } from './solver.js';
import { frameAt, distM } from './geo.js';
import { loadHistory, availableDays, rangeGunzip, liveFeed, dataRoot } from './data.js';

// Worldwide pass search over the speed index (scripts/build-index.mjs, out/spd).
// 1. Lookup + Join + Pre-rank: executed in a single cross-boundary call inside the Rust WASM kernel
//    (public/lib/search_kernel.wasm) operating directly on 24-byte SpdSample structs in wasm.memory.
// 2. Verify: refit top survivors with the full 3D retarded-time spline model on the raw curve.
const MY = 111195, REC = 24, OK_Q = 0.008;
const isoDay = (d) => new Date(d * 86400e3).toISOString().slice(0, 10);

let kernelPromise = null;
async function getKernel() {
  if (!kernelPromise) {
    kernelPromise = (async () => {
      let bytes;
      try {
        const r = await fetch('./lib/search_kernel.wasm');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        bytes = await r.arrayBuffer();
      } catch {
        const fs = await import('node:fs');
        bytes = fs.readFileSync(new URL('./search_kernel.wasm', import.meta.url));
      }
      const { instance } = await WebAssembly.instantiate(bytes, {});
      const { memory, init_arena, run_search } = instance.exports;
      const cap = { samples: 250000, shards: 8192, fids: 32768 };
      let hdrPtr = init_arena(cap.samples, cap.shards, cap.fids);
      return {
        memory,
        init_arena,
        run_search,
        cap,
        get hdrPtr() {
          return hdrPtr;
        },
        ensure(minSamples, minShards, minFids) {
          if (minSamples > cap.samples || minShards > cap.shards || minFids > cap.fids) {
            cap.samples = Math.max(cap.samples, Math.ceil(minSamples * 1.5));
            cap.shards = Math.max(cap.shards, Math.ceil(minShards * 1.5));
            cap.fids = Math.max(cap.fids, Math.ceil(minFids * 1.5));
            hdrPtr = init_arena(cap.samples, cap.shards, cap.fids);
          }
          return hdrPtr;
        },
      };
    })();
  }
  return kernelPromise;
}

export class SpeedStore {
  constructor(base = '') {
    this.base = base;
    this.days = new Map();
    this.shards = new Map();
    this.rawShards = new Map();
    this.flights = [];
    this.fidToHex = [];
    this.hexToId = new Map();
    this._liveVer = -1;
    this._liveFidBase = 0;
  }

  _registerFlights(list) {
    const fidBase = this.flights.length;
    for (const item of list) {
      const f = Array.isArray(item) ? { hex: item[0], type: item[1], reg: item[2] } : item;
      let hid = this.hexToId.get(f.hex);
      if (hid === undefined) {
        hid = this.hexToId.size;
        this.hexToId.set(f.hex, hid);
      }
      this.flights.push(f);
      this.fidToHex.push(hid);
    }
    return fidBase;
  }

  async day(day) {
    if (!this.days.has(day)) {
      this.days.set(
        day,
        availableDays(this.base).then(async (days) => {
          if (!days.includes(day)) return null;
          const root = await dataRoot(this.base);
          const r = await fetch(`${root}/data/spd/${day}.json`).catch(() => null);
          if (!r?.ok) return null;
          const d = await r.json();
          const fidBase = this._registerFlights(d.flights ?? []);
          const day0 = Date.parse(`${day}T00:00:00Z`) / 1000;
          let minM = Infinity, maxM = -Infinity;
          for (const k of Object.keys(d.keys ?? {})) {
            const m = Number(k.split('_')[0]);
            if (m < minM) minM = m;
            if (m > maxM) maxM = m;
          }
          return { root, ...d, fidBase, day0, minM, maxM };
        }),
      );
    }
    return this.days.get(day);
  }

  async rawShard(min, band) {
    const day = isoDay(Math.floor(min / 1440)),
      key = `${min % 1440}_${band}`,
      id = `${day}/${key}`;
    if (!this.rawShards.has(id)) {
      this.rawShards.set(
        id,
        (async () => {
          const idx = await this.day(day),
            e = idx?.keys[key];
          if (!e) return null;
          const ab = await rangeGunzip(`${idx.root}/data/spd/${day}.bin`, e[0], e[1]);
          return {
            bytes: new Uint8Array(ab),
            count: Math.floor(ab.byteLength / REC),
            minute: min,
            band,
            fidBase: idx.fidBase,
            day0: idx.day0,
            wasmOff: -1,
          };
        })().catch((e) => {
          this.rawShards.delete(id);
          throw e;
        }),
      );
    }
    const baseSh = await this.rawShards.get(id);
    if (this.base) return baseSh ? [baseSh] : [];
    const liveRaw = liveFeed.rawShard(min, band);
    if (!liveRaw) return baseSh ? [baseSh] : [];
    if (this._liveVer !== liveRaw.ver) {
      this._liveFidBase = this._registerFlights(liveRaw.flights);
      this._liveVer = liveRaw.ver;
    }
    const liveSh = {
      bytes: liveRaw.bytes,
      count: Math.floor(liveRaw.bytes.byteLength / REC),
      minute: min,
      band,
      fidBase: this._liveFidBase,
      day0: liveRaw.day0,
      wasmOff: -1,
    };
    return baseSh ? [baseSh, liveSh] : [liveSh];
  }

  // Legacy object-level shard getter for any external caller
  async shard(min, band) {
    const list = await this.rawShard(min, band);
    const out = [];
    for (const sh of list) {
      const dv = new DataView(sh.bytes.buffer, sh.bytes.byteOffset, sh.bytes.byteLength);
      for (let o = 0; o + REC <= dv.byteLength; o += REC) {
        const f = this.flights[sh.fidBase + dv.getUint32(o, true)];
        out.push({
          f,
          t: sh.day0 + dv.getUint32(o + 4, true) / 10,
          lat: dv.getInt32(o + 8, true) / 1e6,
          lon: dv.getInt32(o + 12, true) / 1e6,
          z: dv.getInt16(o + 16, true),
          ve: dv.getInt16(o + 18, true) / 10,
          vn: dv.getInt16(o + 20, true) / 10,
          vz: dv.getInt16(o + 22, true) / 10,
        });
      }
    }
    return out;
  }
}

const circle = (lat, lon, r) =>
  Array.from({ length: 16 }, (_, i) => [
    lat + (r * Math.sin((i * Math.PI) / 8)) / MY,
    lon + (r * Math.cos((i * Math.PI) / 8)) / (MY * Math.cos((lat * Math.PI) / 180)),
  ]);

async function verify(evs, hits, base, s0, s1) {
  const pts = evs.map((e) => e.pts.filter((_, i) => i % Math.ceil(e.pts.length / 20) === 0)),
    out = [],
    seen = new Set(),
    cache = new Map(),
    span = Math.max(...evs.map((e) => e.tc));
  const tracksAt = (lat, lon, t) => {
    const h0 = Math.floor(t / 3600) * 3600,
      k = `${Math.floor(lat)},${Math.floor(lon)},${h0}`;
    if (!cache.has(k))
      cache.set(
        k,
        loadHistory(Math.floor(lat) + 0.5, Math.floor(lon) + 0.5, 60, h0 - 300, h0 + 3600 + span + 300, base).then((r) => r.tracks),
      );
    return cache.get(k);
  };
  const candidates = [];
  for (const h of hits) {
    const key = `${Math.round(h.lat * 20)},${Math.round(h.lon * 20)},${Math.round(h.start / 20)},${h.flights.map((f) => f.hex).join()}`;
    if (seen.has(key) || seen.size >= 40) continue;
    seen.add(key);
    const fr = frameAt(h.lat, h.lon),
      tracks = await tracksAt(h.lat, h.lon, h.start);
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
    const lat = fr.lat(best[2]),
      lon = fr.lon(best[1]);
    const paths = trks.map((t, p) => {
      const path = [],
        tc = best[3] + evs[p].tc;
      let cpa = null,
        minD = Infinity;
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
    out.push({
      q: best[0] / evs.length,
      lat,
      lon,
      start: best[3],
      flights: h.flights,
      paths,
      hull: circle(lat, lon, 150),
      score: best[0] / evs.length,
      unheard: 0,
    });
  }
  out.sort((a, b) => a.q - b.q);
  return out.filter((r, i) => !out.slice(0, i).some((o) => distM(o.lat, o.lon, r.lat, r.lon) < 1500 && o.flights.every((f, j) => f.hex === r.flights[j].hex)));
}

const stores = new Map();
let activeStoreInWasm = null;
let wasmSampleCursor = 0;

// events: passes with tc relative to the recording start; [s0, s1]: possible recording starts (epoch s), or null for every indexed day.
// Returns { kind: 'located' | 'unsure' | 'shortlist' | 'none', results, planes, used }.
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
      const idx = await store.day(d);
      const d0 = Date.parse(`${d}T00:00:00Z`) / 1000;
      const spStart = Number.isFinite(idx?.minM) ? Math.max(d0, d0 + idx.minM * 60 - 120) : d0;
      const spEnd = Number.isFinite(idx?.maxM) ? Math.min(d0 + 86400, d0 + (idx.maxM + 1) * 60 + 120) : d0 + 86400;
      if (spans.length && spStart <= spans[spans.length - 1][1]) spans[spans.length - 1][1] = Math.max(spans[spans.length - 1][1], spEnd);
      else spans.push([spStart, spEnd]);
    }
    if (!base) {
      const lw = liveFeed.window();
      if (lw && !spans.some(([a, b]) => lw[0] >= a && lw[1] <= b)) spans.unshift(lw);
    }
    if (!spans.length) return { kind: 'none', results: [], planes: 0 };
    s0 = Math.min(...spans.map((s) => s[0]));
    s1 = Math.max(...spans.map((s) => s[1]));
  }

  onProgress(0.05);
  const kernel = await getKernel();

  // Collect all unique (minute, band) shard pairs required across all spans and events
  const tpad = 5;
  const wanted = new Map();
  for (const [sp0, sp1] of spans) {
    for (const e of events) {
      const tv = Math.max(22, 0.5 * e.v);
      const mMin = Math.floor((sp0 + e.tc - tpad - 25) / 60);
      const mMax = Math.floor((sp1 + e.tc + tpad + 60) / 60);
      const bMin = Math.max(3, Math.floor((e.v - tv) / 4));
      const bMax = Math.min(60, Math.floor((e.v + tv) / 4));
      for (let m = mMin; m <= mMax; m++) {
        for (let b = bMin; b <= bMax; b++) {
          const k = `${m}_${b}`;
          if (!wanted.has(k)) wanted.set(k, [m, b]);
        }
      }
    }
  }

  const pairs = [...wanted.values()];
  const fetchedLists = await Promise.all(pairs.map(([m, b]) => store.rawShard(m, b)));
  onProgress(0.5);

  const shardList = [];
  for (const list of fetchedLists) {
    for (const sh of list) {
      if (sh && sh.count > 0) shardList.push(sh);
    }
  }

  // If switching stores or arena needs resizing, reset wasmSampleCursor and re-place shards
  if (activeStoreInWasm !== store) {
    activeStoreInWasm = store;
    wasmSampleCursor = 0;
    for (const sh of shardList) sh.wasmOff = -1;
  }

  let newSamplesNeeded = 0;
  for (const sh of shardList) {
    if (sh.wasmOff < 0) newSamplesNeeded += sh.count;
  }

  const prevSamplesCap = kernel.cap.samples,
    prevShardsCap = kernel.cap.shards,
    prevFidsCap = kernel.cap.fids;
  const hdrPtr = kernel.ensure(wasmSampleCursor + newSamplesNeeded + 1024, shardList.length + 64, store.flights.length + 64);
  if (kernel.cap.samples !== prevSamplesCap || kernel.cap.shards !== prevShardsCap || kernel.cap.fids !== prevFidsCap) {
    wasmSampleCursor = 0;
    for (const sh of shardList) sh.wasmOff = -1;
  }

  const memBuf = kernel.memory.buffer;
  const hdrU32 = new Uint32Array(memBuf, hdrPtr, 17);
  const samplesPtr = hdrU32[9];
  const shardsPtr = hdrU32[10];
  const fidToHexPtr = hdrU32[11];
  const passesPtr = hdrU32[12];
  const qpPtr = hdrU32[13];
  const spansPtr = hdrU32[14];
  const outHitsPtr = hdrU32[15];
  const outShortlistPtr = hdrU32[16];

  // 1. Copy any newly-fetched 24-byte SpdSample shard buffers directly into wasm.memory (zero serialization)
  const wasmU8 = new Uint8Array(memBuf);
  for (const sh of shardList) {
    if (sh.wasmOff < 0) {
      sh.wasmOff = wasmSampleCursor;
      wasmU8.set(sh.bytes.subarray(0, sh.count * REC), samplesPtr + sh.wasmOff * REC);
      wasmSampleCursor += sh.count;
    }
  }

  // 2. Write ShardDesc table into wasm.memory
  const shardsU32 = new Uint32Array(memBuf, shardsPtr, shardList.length * 8);
  const shardsI32 = new Int32Array(memBuf, shardsPtr, shardList.length * 8);
  const shardsF64 = new Float64Array(memBuf, shardsPtr, shardList.length * 4);
  for (let i = 0; i < shardList.length; i++) {
    const sh = shardList[i];
    const u = i * 8;
    shardsU32[u] = sh.wasmOff;
    shardsU32[u + 1] = sh.count;
    shardsI32[u + 2] = sh.minute;
    shardsI32[u + 3] = sh.band;
    shardsU32[u + 4] = sh.fidBase;
    shardsU32[u + 5] = 0;
    shardsF64[i * 4 + 3] = sh.day0;
  }

  // 3. Sync fid -> hexId mapping table into wasm.memory
  const fidToHexU32 = new Uint32Array(memBuf, fidToHexPtr, store.fidToHex.length);
  fidToHexU32.set(store.fidToHex);

  // 4. Write PassDesc + QpPoint tables into wasm.memory
  const pCnt = Math.min(events.length, 6);
  const passesF64 = new Float64Array(memBuf, passesPtr, pCnt * 4);
  const passesU32 = new Uint32Array(memBuf, passesPtr, pCnt * 8);
  const qpF64 = new Float64Array(memBuf, qpPtr, 128 * 2);
  let qpCursor = 0;
  for (let p = 0; p < pCnt; p++) {
    const e = events[p];
    const step = Math.max(1, Math.ceil(e.pts.length / 16));
    const qpOff = qpCursor;
    for (let j = 0; j < e.pts.length && qpCursor < 128; j += step) {
      qpF64[qpCursor * 2] = e.pts[j][0];
      qpF64[qpCursor * 2 + 1] = e.pts[j][1];
      qpCursor++;
    }
    passesF64[p * 4] = e.v;
    passesF64[p * 4 + 1] = e.d;
    passesF64[p * 4 + 2] = e.tc;
    passesU32[p * 8 + 6] = qpOff;
    passesU32[p * 8 + 7] = qpCursor - qpOff;
  }

  // 5. Write SpanDesc table into wasm.memory
  const sCnt = Math.min(spans.length, 64);
  const spansF64 = new Float64Array(memBuf, spansPtr, sCnt * 2);
  for (let i = 0; i < sCnt; i++) {
    spansF64[i * 2] = spans[i][0];
    spansF64[i * 2 + 1] = spans[i][1];
  }

  // 6. Update IOHeader counts and cross the WASM boundary ONCE
  hdrU32[0] = wasmSampleCursor;
  hdrU32[1] = shardList.length;
  hdrU32[2] = store.fidToHex.length;
  hdrU32[3] = Math.max(1, store.hexToId.size);
  hdrU32[4] = pCnt;
  hdrU32[5] = qpCursor;
  hdrU32[6] = sCnt;

  kernel.run_search();
  onProgress(0.9);

  // Re-bind views in case WASM memory grew inside run_search()
  const outBuf = kernel.memory.buffer;
  const outHdrU32 = new Uint32Array(outBuf, hdrPtr, 17);
  const numHits = outHdrU32[7];
  const numShortlist = outHdrU32[8];

  // Build pass subsets matching search_kernel.rs
  const sets = [];
  if (pCnt >= 2) {
    sets.push(Array.from({ length: pCnt }, (_, i) => i));
    if (pCnt >= 3) {
      for (let i = 0; i < pCnt; i++) sets.push(Array.from({ length: pCnt }, (_, j) => j).filter((j) => j !== i));
      if (pCnt >= 4)
        for (let i = 0; i < pCnt; i++)
          for (let j = i + 1; j < pCnt; j++) sets.push([i, j]);
    }
  }

  // Read pre-ranked OutHit structs directly from wasm.memory
  const hitsBySet = sets.map(() => []);
  if (numHits > 0) {
    const hitsF64 = new Float64Array(outBuf, outHitsPtr, numHits * 8);
    const hitsU32 = new Uint32Array(outBuf, outHitsPtr, numHits * 16);
    for (let i = 0; i < numHits; i++) {
      const f = i * 8,
        u = i * 16;
      const lat = hitsF64[f],
        lon = hitsF64[f + 1],
        start = hitsF64[f + 2],
        pre = hitsF64[f + 3];
      const setIdx = hitsU32[u + 8],
        nFlights = hitsU32[u + 9];
      const flights = [];
      for (let k = 0; k < nFlights; k++) flights.push(store.flights[hitsU32[u + 10 + k]]);
      if (hitsBySet[setIdx]) hitsBySet[setIdx].push({ lat, lon, start, pre, flights });
    }
  }

  // Verify each pass set; prefer more passes unless fewer fit clearly better.
  let best = null;
  for (let sIdx = 0; sIdx < sets.length; sIdx++) {
    const ix = sets[sIdx],
      hits = hitsBySet[sIdx];
    if (!hits.length) continue;
    if (best && ix.length < best.ix.length && best.results[0].q < OK_Q * 1.4) break;
    const results = await verify(ix.map((i) => events[i]), hits, base, s0, s1);
    if (results.length && (!best || (ix.length > best.ix.length ? results[0].q < OK_Q * 1.4 || results[0].q < best.results[0].q * 0.6 : results[0].q < best.results[0].q)))
      best = { ix, results };
  }
  onProgress(1);

  if (best) {
    const { ix, results } = best,
      top = results[0],
      second = results[1];
    if (top.q < OK_Q || (top.q < 0.012 && (!second || top.q < second.q * 0.85)))
      return { kind: 'located', results: results.filter((r) => r.q < Math.max(OK_Q * 2, top.q * 2)), used: ix.length };
    return { kind: 'unsure', results, used: ix.length };
  }

  // Read OutShortlist structs directly from wasm.memory
  const results = [];
  if (numShortlist > 0) {
    const slU32 = new Uint32Array(outBuf, outShortlistPtr, numShortlist * 10);
    const slF64 = new Float64Array(outBuf, outShortlistPtr, numShortlist * 5);
    for (let i = 0; i < numShortlist; i++) {
      const fid = slU32[i * 10];
      const lat = slF64[i * 5 + 1],
        lon = slF64[i * 5 + 2],
        start = slF64[i * 5 + 3],
        dv = slF64[i * 5 + 4];
      const f = store.flights[fid];
      if (f) results.push({ lat, lon, start, flights: [f], hull: circle(lat, lon, 300), q: null, score: 1, unheard: 0, dv });
    }
  }
  return { kind: results.length ? 'shortlist' : 'none', results, planes: results.length, used: 1 };
}
