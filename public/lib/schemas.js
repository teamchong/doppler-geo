import {
  WasmArena,
  defineStruct,
  f32,
  f64,
  fixedArray,
  fixedStr,
  i16,
  i32,
  scaled,
  sentinel,
  slice,
  str,
  u16,
  u32,
} from './vendor/capnstruct.js';
export { WasmArena };

export const MAX_PASSES = 6;
export const NULL_I16 = -32768;

// 24-byte speed-index sample shared across offline shards, LiveFeed shards, and WASM linear memory.
export const SpdSample = defineStruct('SpdSample', {
  fi: u32,
  t_ds: u32,
  lat_e6: i32,
  lon_e6: i32,
  z: i16,
  ve_dm: i16,
  vn_dm: i16,
  vz_dm: i16,
});

// WASM search_kernel.rs #[repr(C)] descriptor and output tables.
export const ShardDesc = defineStruct('ShardDesc', {
  sample_off: u32,
  sample_cnt: u32,
  minute: i32,
  band: i32,
  fid_base: u32,
  _pad: u32,
  day0: f64,
});

export const PassDesc = defineStruct('PassDesc', {
  v: f64,
  d: f64,
  tc: f64,
  qp_off: u32,
  qp_cnt: u32,
});

export const QpPoint = defineStruct('QpPoint', {
  tr: f64,
  f: f64,
});

export const SpanDesc = defineStruct('SpanDesc', {
  sp0: f64,
  sp1: f64,
});

export const OutHit = defineStruct('OutHit', {
  lat: f64,
  lon: f64,
  start: f64,
  pre: f64,
  set_idx: u32,
  n_flights: u32,
  fids: fixedArray(u32, MAX_PASSES),
});

export const OutShortlist = defineStruct('OutShortlist', {
  fid: u32,
  _pad: u32,
  lat: f64,
  lon: f64,
  start: f64,
  dv: f64,
});

export const IOHeader = defineStruct('IOHeader', {
  num_samples: u32,
  num_shards: u32,
  num_fids: u32,
  num_hexes: u32,
  num_passes: u32,
  num_qp: u32,
  num_spans: u32,
  out_hits_count: u32,
  out_shortlist_count: u32,
  samples_ptr: u32,
  shards_ptr: u32,
  fid_to_hex_ptr: u32,
  passes_ptr: u32,
  qp_ptr: u32,
  spans_ptr: u32,
  out_hits_ptr: u32,
  out_shortlist_ptr: u32,
});

// Binary track table schemas streamed over capnweb between LiveTrackerDO, offline tiles, and LiveFeed.
export const LiveTrackHeader = defineStruct('LiveTrackHeader', {
  pt_off: u32,
  pt_cnt: u32,
  hex: fixedStr(8),
  type: fixedStr(8),
  reg: fixedStr(12),
  flight: fixedStr(12),
});

export const LiveTrackPoint = defineStruct('LiveTrackPoint', {
  t_ds: u32,
  lat: scaled(i32, 1e5),
  lon: scaled(i32, 1e5),
  alt: i16,
  gs: scaled(i16, 10, { null: NULL_I16 }),
  track: scaled(i16, 10, { null: NULL_I16 }),
  rate: sentinel(i16, NULL_I16),
});

export const TrackBundle = defineStruct('TrackBundle', {
  base_sec: f64,
  headers: slice(LiveTrackHeader),
  points: slice(LiveTrackPoint),
});

export function packTrackBundle(headers, points, baseSec) {
  return TrackBundle.pack([
    {
      base_sec: baseSec,
      headers,
      points,
    },
  ]);
}

export function unpackTrackBundle(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < TrackBundle.size) {
    return { baseSec: 0, hdrs: LiveTrackHeader.from(0), pts: LiveTrackPoint.from(0), ptCnt: 0 };
  }
  const b = TrackBundle.view(bytes);
  const hdrs = b.headers;
  const pts = b.points;
  return { baseSec: b.base_sec, hdrs, pts, ptCnt: pts.length };
}

// Zero-copy audio spectrogram + Doppler pass detection schemas across Web Worker MessagePort.
export const TimeFreqPoint = defineStruct('TimeFreqPoint', {
  t: f32,
  f: f32,
});

export const DetectedPass = defineStruct('DetectedPass', {
  v: f64,
  d: f64,
  f0: f64,
  t0: f64,
  t1: f64,
  tc: f64,
  fit_rms: f64,
  fit_rms_rel: f64,
  seg0: i32,
  seg1: i32,
  pts_off: u32,
  pts_cnt: u32,
  curve_off: u32,
  curve_cnt: u32,
});

export const SpectrogramBundle = defineStruct('SpectrogramBundle', {
  F: u32,
  B: u32,
  b0: u32,
  _pad: u32,
  df: f64,
  dt: f64,
  t0: f64,
  dur: f64,
  passes: slice(DetectedPass),
  tf_points: slice(TimeFreqPoint),
});

export function packAnalysis(res) {
  const evs = res.events ?? [];
  let totalPts = 0,
    totalCurve = 0;
  for (const e of evs) {
    totalPts += e.pts?.length ?? 0;
    totalCurve += e.curve?.length ?? 0;
  }
  const passesView = DetectedPass.from(evs.length);
  const tfView = TimeFreqPoint.from(totalPts + totalCurve);
  const pCur = passesView.cursor();
  const tfCur = tfView.cursor();
  let ptCursor = 0;
  let curveCursor = totalPts;

  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    pCur.at(i);
    pCur.v = e.v;
    pCur.d = e.d;
    pCur.f0 = e.f0;
    pCur.t0 = e.t0;
    pCur.t1 = e.t1;
    pCur.tc = e.tc;
    pCur.fit_rms = e.fitRms;
    pCur.fit_rms_rel = e.fitRmsRel;
    pCur.seg0 = e.seg?.[0] ?? 0;
    pCur.seg1 = e.seg?.[1] ?? 0;
    const pts = e.pts ?? [];
    pCur.pts_off = ptCursor;
    pCur.pts_cnt = pts.length;
    for (let j = 0; j < pts.length; j++) {
      tfCur.at(ptCursor++);
      tfCur.t = pts[j][0];
      tfCur.f = pts[j][1];
    }
    const curve = e.curve ?? [];
    pCur.curve_off = curveCursor;
    pCur.curve_cnt = curve.length;
    for (let j = 0; j < curve.length; j++) {
      tfCur.at(curveCursor++);
      tfCur.t = curve[j][0];
      tfCur.f = curve[j][1];
    }
  }
  const meta = SpectrogramBundle.pack([
    {
      F: res.F,
      B: res.B,
      b0: res.b0,
      df: res.df,
      dt: res.dt,
      t0: res.t0,
      dur: res.dur,
      passes: passesView,
      tf_points: tfView,
    },
  ]);
  const img = new Uint8Array(res.img.buffer, res.img.byteOffset, res.img.byteLength);
  return { meta, img };
}

export function unpackAnalysis({ meta, img }) {
  const s = SpectrogramBundle.view(meta);
  const passesView = s.passes;
  const tfView = s.tf_points;
  const pCur = passesView.cursor();
  const tfCur = tfView.cursor();
  const events = [];
  for (let i = 0; i < passesView.length; i++) {
    pCur.at(i);
    const pts = new Array(pCur.pts_cnt);
    for (let j = 0; j < pCur.pts_cnt; j++) {
      tfCur.at(pCur.pts_off + j);
      pts[j] = [tfCur.t, tfCur.f];
    }
    const curve = new Array(pCur.curve_cnt);
    for (let j = 0; j < pCur.curve_cnt; j++) {
      tfCur.at(pCur.curve_off + j);
      curve[j] = [tfCur.t, tfCur.f];
    }
    events.push({
      v: pCur.v,
      d: pCur.d,
      f0: pCur.f0,
      t0: pCur.t0,
      t1: pCur.t1,
      tc: pCur.tc,
      fitRms: pCur.fit_rms,
      fitRmsRel: pCur.fit_rms_rel,
      seg: [pCur.seg0, pCur.seg1],
      pts,
      curve,
    });
  }
  const imgClamped = new Uint8ClampedArray(img.buffer, img.byteOffset, img.byteLength);
  return {
    F: s.F,
    B: s.B,
    b0: s.b0,
    df: s.df,
    dt: s.dt,
    t0: s.t0,
    dur: s.dur,
    events,
    img: imgClamped,
  };
}

// 44-byte RIFF WAVE PCM 16-bit mono header (#[repr(C)] zero-padding layout with inline fixedStr(4) magic tags).
export const WavHeader = defineStruct('WavHeader', {
  riff_magic: fixedStr(4),
  file_size: u32,
  wave_magic: fixedStr(4),
  fmt_magic: fixedStr(4),
  fmt_size: u32,
  audio_format: u16,
  num_channels: u16,
  sample_rate: u32,
  byte_rate: u32,
  block_align: u16,
  bits_per_sample: u16,
  data_magic: fixedStr(4),
  data_size: u32,
});
export const WASM_KERNEL_SCHEMAS = [
  SpdSample,
  ShardDesc,
  PassDesc,
  QpPoint,
  SpanDesc,
  OutHit,
  OutShortlist,
  IOHeader,
];
