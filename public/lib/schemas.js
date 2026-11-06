import {
  WasmArena,
  defineStruct,
  f32,
  f64,
  fixedArray,
  i16,
  i32,
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

// Binary track table schemas streamed over capnweb between LiveTrackerDO and LiveFeed.
export const LiveTrackHeader = defineStruct('LiveTrackHeader', {
  pt_off: u32,
  pt_cnt: u32,
  hex: str,
  type: str,
  reg: str,
  flight: str,
});

export const LiveTrackPoint = defineStruct('LiveTrackPoint', {
  t_ds: u32,
  lat_e5: i32,
  lon_e5: i32,
  alt: i16,
  gs_d: i16,
  track_d: i16,
  rate: i16,
});
export const TrackBundleHeader = defineStruct('TrackBundleHeader', {
  base_sec: f64,
  hdr_bytes: u32,
  pt_cnt: u32,
});

export function packTrackBundle(hdrBytes, ptBytes, ptCnt, baseSec) {
  const hdrAligned = (hdrBytes.byteLength + 7) & ~7;
  const out = new Uint8Array(16 + hdrAligned + ptBytes.byteLength);
  const bHdr = TrackBundleHeader.view(out, 0);
  bHdr.base_sec = baseSec;
  bHdr.hdr_bytes = hdrBytes.byteLength;
  bHdr.pt_cnt = ptCnt;
  out.set(hdrBytes, 16);
  out.set(ptBytes, 16 + hdrAligned);
  return out;
}

export function unpackTrackBundle(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 16) return { baseSec: 0, hdrs: [], pts: LiveTrackPoint.alloc(0), ptCnt: 0 };
  const bHdr = TrackBundleHeader.view(bytes, 0);
  const hdrAligned = (bHdr.hdr_bytes + 7) & ~7;
  const hdrs = bHdr.hdr_bytes > 0 ? LiveTrackHeader.array(bytes.subarray(16, 16 + bHdr.hdr_bytes)) : [];
  const ptsByteEnd = 16 + hdrAligned + bHdr.pt_cnt * LiveTrackPoint.size;
  const pts = LiveTrackPoint.array(bytes.subarray(16 + hdrAligned, ptsByteEnd));
  return { baseSec: bHdr.base_sec, hdrs, pts, ptCnt: bHdr.pt_cnt };
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

export const SpectrogramHeader = defineStruct('SpectrogramHeader', {
  F: u32,
  B: u32,
  b0: u32,
  pass_cnt: u32,
  pts_cnt: u32,
  curve_cnt: u32,
  df: f64,
  dt: f64,
  t0: f64,
  dur: f64,
});

export function packAnalysis(res) {
  const evs = res.events ?? [];
  let totalPts = 0,
    totalCurve = 0;
  for (const e of evs) {
    totalPts += e.pts?.length ?? 0;
    totalCurve += e.curve?.length ?? 0;
  }
  const hdrSize = SpectrogramHeader.size;
  const passesByteLen = evs.length * DetectedPass.size;
  const tfByteLen = (totalPts + totalCurve) * TimeFreqPoint.size;
  const meta = new Uint8Array(hdrSize + passesByteLen + tfByteLen);

  const sHdr = SpectrogramHeader.view(meta, 0);
  sHdr.F = res.F;
  sHdr.B = res.B;
  sHdr.b0 = res.b0;
  sHdr.pass_cnt = evs.length;
  sHdr.pts_cnt = totalPts;
  sHdr.curve_cnt = totalCurve;
  sHdr.df = res.df;
  sHdr.dt = res.dt;
  sHdr.t0 = res.t0;
  sHdr.dur = res.dur;
  const passesView = DetectedPass.array(meta.subarray(hdrSize, hdrSize + passesByteLen));
  const tfView = TimeFreqPoint.array(meta.subarray(hdrSize + passesByteLen));
  let ptCursor = 0;
  let curveCursor = totalPts;

  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    const p = passesView.cursor(i);
    p.v = e.v;
    p.d = e.d;
    p.f0 = e.f0;
    p.t0 = e.t0;
    p.t1 = e.t1;
    p.tc = e.tc;
    p.fit_rms = e.fitRms;
    p.fit_rms_rel = e.fitRmsRel;
    p.seg0 = e.seg?.[0] ?? 0;
    p.seg1 = e.seg?.[1] ?? 0;
    const pts = e.pts ?? [];
    p.pts_off = ptCursor;
    p.pts_cnt = pts.length;
    for (let j = 0; j < pts.length; j++) {
      const tf = tfView.cursor(ptCursor++);
      tf.t = pts[j][0];
      tf.f = pts[j][1];
    }
    const curve = e.curve ?? [];
    p.curve_off = curveCursor;
    p.curve_cnt = curve.length;
    for (let j = 0; j < curve.length; j++) {
      const tf = tfView.cursor(curveCursor++);
      tf.t = curve[j][0];
      tf.f = curve[j][1];
    }
  }
  const img = new Uint8Array(res.img.buffer, res.img.byteOffset, res.img.byteLength);
  return { meta, img };
}

export function unpackAnalysis({ meta, img }) {
  const bytes = meta instanceof Uint8Array ? meta : new Uint8Array(meta);
  const sHdr = SpectrogramHeader.view(bytes, 0);
  const hdrSize = SpectrogramHeader.size;
  const passesByteLen = sHdr.pass_cnt * DetectedPass.size;
  const passesView = DetectedPass.array(bytes.subarray(hdrSize, hdrSize + passesByteLen));
  const tfView = TimeFreqPoint.array(bytes.subarray(hdrSize + passesByteLen));
  const events = [];
  for (let i = 0; i < sHdr.pass_cnt; i++) {
    const p = passesView.cursor(i);
    const pts = new Array(p.pts_cnt);
    for (let j = 0; j < p.pts_cnt; j++) {
      const tf = tfView.cursor(p.pts_off + j);
      pts[j] = [tf.t, tf.f];
    }
    const curve = new Array(p.curve_cnt);
    for (let j = 0; j < p.curve_cnt; j++) {
      const tf = tfView.cursor(p.curve_off + j);
      curve[j] = [tf.t, tf.f];
    }
    events.push({
      v: p.v,
      d: p.d,
      f0: p.f0,
      t0: p.t0,
      t1: p.t1,
      tc: p.tc,
      fitRms: p.fit_rms,
      fitRmsRel: p.fit_rms_rel,
      seg: [p.seg0, p.seg1],
      pts,
      curve,
    });
  }
  const imgClamped = new Uint8ClampedArray(img.buffer, img.byteOffset, img.byteLength);
  return {
    F: sHdr.F,
    B: sHdr.B,
    b0: sHdr.b0,
    df: sHdr.df,
    dt: sHdr.dt,
    t0: sHdr.t0,
    dur: sHdr.dur,
    events,
    img: imgClamped,
  };
}

// 44-byte RIFF WAVE PCM 16-bit mono header (#[repr(C)] zero-padding layout).
export const WavHeader = defineStruct('WavHeader', {
  riff_magic: u32,
  file_size: u32,
  wave_magic: u32,
  fmt_magic: u32,
  fmt_size: u32,
  audio_format: u16,
  num_channels: u16,
  sample_rate: u32,
  byte_rate: u32,
  block_align: u16,
  bits_per_sample: u16,
  data_magic: u32,
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
