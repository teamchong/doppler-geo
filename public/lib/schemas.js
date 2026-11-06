import {
  WasmArena,
  defineStruct,
  f64,
  fixedArray,
  i16,
  i32,
  str,
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
