// Zero-copy WASM search kernel for doppler-geo.
// Cap'n-Proto-style shared linear memory arena: JS places raw 24-byte SpdSample shard bytes
// directly into wasm.memory and crosses the WASM boundary ONCE per search via `run_search()`.
// Compile: DYLD_LIBRARY_PATH="/Users/me/.rustup/toolchains/1.98.0-aarch64-apple-darwin/lib:/opt/homebrew/lib:/opt/homebrew/opt/llvm/lib" $(rustup which rustc) --target wasm32-unknown-unknown -C opt-level=3 -C lto=fat -C panic=abort -C strip=symbols -A static_mut_refs --crate-type cdylib scripts/search_kernel.rs -o public/lib/search_kernel.wasm

use std::f64::consts::PI;

const C: f64 = 340.0;
const CELL: f64 = 250.0;
const MY: f64 = 111195.0;
const MAX_PASSES: usize = 6;
const MAX_SETS: usize = 16;
const MAX_QP: usize = 128;
const MAX_SPANS: usize = 64;
const MAX_OUT_HITS: usize = 768;

#[repr(C)]
#[derive(Copy, Clone)]
pub struct SpdSample {
    pub fi: u32,
    pub t_ds: u32,
    pub lat_e6: i32,
    pub lon_e6: i32,
    pub z: i16,
    pub ve_dm: i16,
    pub vn_dm: i16,
    pub vz_dm: i16,
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct ShardDesc {
    pub sample_off: u32,
    pub sample_cnt: u32,
    pub minute: i32,
    pub band: i32,
    pub fid_base: u32,
    pub _pad: u32,
    pub day0: f64,
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct PassDesc {
    pub v: f64,
    pub d: f64,
    pub tc: f64,
    pub qp_off: u32,
    pub qp_cnt: u32,
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct QpPoint {
    pub tr: f64,
    pub f: f64,
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct SpanDesc {
    pub sp0: f64,
    pub sp1: f64,
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct OutHit {
    pub lat: f64,
    pub lon: f64,
    pub start: f64,
    pub pre: f64,
    pub set_idx: u32,
    pub n_flights: u32,
    pub fids: [u32; MAX_PASSES],
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct OutShortlist {
    pub fid: u32,
    pub _pad: u32,
    pub lat: f64,
    pub lon: f64,
    pub start: f64,
    pub dv: f64,
}

#[repr(C)]
pub struct IOHeader {
    pub num_samples: u32,
    pub num_shards: u32,
    pub num_fids: u32,
    pub num_hexes: u32,
    pub num_passes: u32,
    pub num_qp: u32,
    pub num_spans: u32,
    pub out_hits_count: u32,
    pub out_shortlist_count: u32,
    pub samples_ptr: u32,
    pub shards_ptr: u32,
    pub fid_to_hex_ptr: u32,
    pub passes_ptr: u32,
    pub qp_ptr: u32,
    pub spans_ptr: u32,
    pub out_hits_ptr: u32,
    pub out_shortlist_ptr: u32,
}

#[derive(Copy, Clone)]
struct SampleState {
    t: f64,
    lat: f64,
    lon: f64,
    z: f64,
    ve: f64,
    vn: f64,
    vz: f64,
}

#[derive(Copy, Clone)]
struct CellEntry {
    start: f64,
    lat: f64,
    lon: f64,
    fid: u32,
    hex_id: u32,
    state_idx: u32,
}

#[derive(Clone)]
struct Combo {
    n: usize,
    fids: [u32; MAX_PASSES],
    hex_ids: [u32; MAX_PASSES],
    state_ids: [u32; MAX_PASSES],
    start: f64,
    lat: f64,
    lon: f64,
    pre: f64,
}

#[inline(always)]
fn block_hash(by: i32, bx: i32, bt: i32) -> usize {
    let h = (by as u32 as u64).wrapping_mul(0x9E3779B97F4A7C15)
        ^ (bx as u32 as u64).wrapping_mul(0xBF58476D1CE4E5B9)
        ^ (bt as u32 as u64).wrapping_mul(0x94D049BB133111EB);
    ((h ^ (h >> 32)) as usize) & 0x3FFFFF
}

struct CellMap {
    keys: Vec<u64>,
    head: Vec<u32>,
    tail: Vec<u32>,
    used_slots: Vec<usize>,
    mask: usize,
    entries: Vec<CellEntry>,
    next: Vec<u32>,
    block_self: Vec<u64>,
    block_near: Vec<u64>,
    block_dirty: Vec<usize>,
}

impl CellMap {
    fn with_capacity(pow2: usize, entry_cap: usize) -> Self {
        let sz = 1usize << pow2;
        Self {
            keys: vec![u64::MAX; sz],
            head: vec![u32::MAX; sz],
            tail: vec![u32::MAX; sz],
            used_slots: Vec::with_capacity(entry_cap),
            mask: sz - 1,
            entries: Vec::with_capacity(entry_cap),
            next: Vec::with_capacity(entry_cap),
            block_self: vec![0u64; 65536],
            block_near: vec![0u64; 65536],
            block_dirty: Vec::with_capacity(8192),
        }
    }

    #[inline(always)]
    fn clear(&mut self) {
        for &slot in &self.used_slots {
            self.keys[slot] = u64::MAX;
            self.head[slot] = u32::MAX;
            self.tail[slot] = u32::MAX;
        }
        self.used_slots.clear();
        self.entries.clear();
        self.next.clear();
        for &w in &self.block_dirty {
            self.block_self[w] = 0;
            self.block_near[w] = 0;
        }
        self.block_dirty.clear();
    }

    #[inline(always)]
    fn mark_block(&mut self, cy: i32, cx: i32, bt: i32) {
        let by = cy >> 2;
        let bx = cx >> 2;
        let sb = block_hash(by, bx, bt);
        let sw = sb >> 6;
        let smask = 1u64 << (sb & 63);
        if (self.block_self[sw] & smask) != 0 {
            return;
        }
        if self.block_self[sw] == 0 && self.block_near[sw] == 0 {
            self.block_dirty.push(sw);
        }
        self.block_self[sw] |= smask;
        for dy in -1..=1 {
            for dx in -1..=1 {
                for dt in -1..=1 {
                    let nb = block_hash(by + dy, bx + dx, bt + dt);
                    let nw = nb >> 6;
                    if self.block_self[nw] == 0 && self.block_near[nw] == 0 {
                        self.block_dirty.push(nw);
                    }
                    self.block_near[nw] |= 1u64 << (nb & 63);
                }
            }
        }

    }

    #[inline(always)]
    fn has_near_spacetime(&self, cy: i32, cx: i32, bt: i32) -> bool {
        let b = block_hash(cy >> 2, cx >> 2, bt);
        (self.block_near[b >> 6] & (1u64 << (b & 63))) != 0
    }



    #[inline(always)]
    fn hash(k: u64) -> usize {
        let mut x = k.wrapping_mul(0x9E3779B97F4A7C15);
        x ^= x >> 32;
        x as usize
    }

    fn grow(&mut self) {
        let new_sz = self.keys.len() * 2;
        let new_mask = new_sz - 1;
        let mut new_keys = vec![u64::MAX; new_sz];
        let mut new_head = vec![u32::MAX; new_sz];
        let mut new_tail = vec![u32::MAX; new_sz];
        let mut new_used = Vec::with_capacity(self.used_slots.len() * 2);
        for &old_slot in &self.used_slots {
            let k = self.keys[old_slot];
            let mut slot = Self::hash(k) & new_mask;
            while new_keys[slot] != u64::MAX {
                slot = (slot + 1) & new_mask;
            }
            new_keys[slot] = k;
            new_head[slot] = self.head[old_slot];
            new_tail[slot] = self.tail[old_slot];
            new_used.push(slot);
        }
        self.keys = new_keys;
        self.head = new_head;
        self.tail = new_tail;
        self.used_slots = new_used;
        self.mask = new_mask;
    }

    #[inline(always)]
    fn insert_if_new(&mut self, key: u64, entry: CellEntry) -> bool {
        if self.used_slots.len() * 2 >= self.keys.len() {
            self.grow();
        }
        let mut slot = Self::hash(key) & self.mask;
        loop {
            let k = self.keys[slot];
            if k == key {
                let mut idx = self.head[slot];
                while idx != u32::MAX {
                    let e = &self.entries[idx as usize];
                    if e.hex_id == entry.hex_id && (e.start - entry.start).abs() < 6.0 {
                        return false;
                    }
                    idx = self.next[idx as usize];
                }
                let new_idx = self.entries.len() as u32;
                self.entries.push(entry);
                self.next.push(u32::MAX);
                let prev_tail = self.tail[slot];
                if prev_tail != u32::MAX {
                    self.next[prev_tail as usize] = new_idx;
                } else {
                    self.head[slot] = new_idx;
                }
                self.tail[slot] = new_idx;
                return true;
            }
            if k == u64::MAX {
                self.keys[slot] = key;
                self.used_slots.push(slot);
                let new_idx = self.entries.len() as u32;
                self.entries.push(entry);
                self.next.push(u32::MAX);
                self.head[slot] = new_idx;
                self.tail[slot] = new_idx;
                let (cy, cx) = unpack_cell(key);
                let bt = (entry.start * (1.0 / 12.0)).floor() as i32;
                self.mark_block(cy, cx, bt);
                return true;
            }
            slot = (slot + 1) & self.mask;
        }
    }

    #[inline(always)]
    fn get_head(&self, key: u64) -> u32 {
        let mut slot = Self::hash(key) & self.mask;
        loop {
            let k = self.keys[slot];
            if k == key {
                return self.head[slot];
            }
            if k == u64::MAX {
                return u32::MAX;
            }
            slot = (slot + 1) & self.mask;
        }
    }
}

struct Arena {
    header: IOHeader,
    samples: Vec<SpdSample>,
    shards: Vec<ShardDesc>,
    fid_to_hex: Vec<u32>,
    passes: Vec<PassDesc>,
    qp: Vec<QpPoint>,
    spans: Vec<SpanDesc>,
    out_hits: Vec<OutHit>,
    out_shortlist: Vec<OutShortlist>,
    maps: Vec<CellMap>,
    states: Vec<SampleState>,
}

static mut ARENA: Option<Box<Arena>> = None;


#[inline(always)]
fn pack_cell(cy: i32, cx: i32) -> u64 {
    ((cy as u32 as u64) << 32) | (cx as u32 as u64)
}

#[inline(always)]
fn unpack_cell(k: u64) -> (i32, i32) {
    ((k >> 32) as u32 as i32, (k & 0xFFFF_FFFF) as u32 as i32)
}

#[inline(always)]
fn eval_k(tr: f64, start: f64, x0: f64, y0: f64, z0: f64, s: &SampleState) -> f64 {
    let st = s.t;
    let ve = s.ve;
    let vn = s.vn;
    let vz = s.vz;
    let mut te = start + tr;
    for _ in 0..3 {
        let u = te - st;
        let dx = x0 + ve * u;
        let dy = y0 + vn * u;
        let dz = z0 + vz * u;
        let r = (dx * dx + dy * dy + dz * dz).sqrt();
        te = start + tr - r / C;
    }
    let u = te - st;
    let x = x0 + ve * u;
    let y = y0 + vn * u;
    let z = z0 + vz * u;
    let r = (x * x + y * y + z * z).sqrt();
    1.0 / (1.0 + (ve * x + vn * y + vz * z) / (r * C))
}

#[inline(always)]
fn lin_score(pts: &[QpPoint], s: &SampleState, lat: f64, lon: f64, start: f64) -> f64 {
    let n = pts.len();
    if n == 0 {
        return f64::INFINITY;
    }
    let kx = MY * (lat * (PI / 180.0)).cos();
    let x0 = (s.lon - lon) * kx;
    let y0 = (s.lat - lat) * MY;
    let z0 = s.z - 1.5;

    let k0 = eval_k(pts[0].tr, start, x0, y0, z0, s);
    if k0 <= 1.005 {
        return f64::INFINITY;
    }
    let kn = if n > 1 {
        eval_k(pts[n - 1].tr, start, x0, y0, z0, s)
    } else {
        k0
    };
    if kn >= 0.995 {
        return f64::INFINITY;
    }

    let mut ks = [0.0f64; 32];
    let limit = n.min(32);
    ks[0] = k0;
    if limit > 1 {
        ks[limit - 1] = kn;
    }
    let mut sfk = pts[0].f * k0 + if limit > 1 { pts[limit - 1].f * kn } else { 0.0 };
    let mut skk = k0 * k0 + if limit > 1 { kn * kn } else { 0.0 };

    for i in 1..(limit.saturating_sub(1)) {
        let k = eval_k(pts[i].tr, start, x0, y0, z0, s);
        ks[i] = k;
        sfk += pts[i].f * k;
        skk += k * k;
    }
    let f0 = sfk / skk;
    let mut err = 0.0;
    for i in 0..limit {
        let diff = pts[i].f - f0 * ks[i];
        err += diff * diff;
    }
    (err / (limit as f64)).sqrt() / f0
}

#[inline(always)]
fn coarse_coords(lat: f64, lon: f64, nom_start: f64) -> (i32, i32, i32) {
    let cy = (lat * (MY / 2200.0)).floor() as i32;
    let cos_l = (lat * (PI / 180.0)).cos().max(0.1);
    let cx = (lon * (MY * cos_l / 2200.0)).floor() as i32;
    let ct = (nom_start / 12.0).floor() as i32;
    (cy, cx, ct)
}

#[inline(always)]
fn coarse_hash(cy: i32, cx: i32, ct: i32) -> usize {
    let h = (cy as u32 as u64)
        .wrapping_mul(0x9E3779B97F4A7C15)
        ^ (cx as u32 as u64).wrapping_mul(0xBF58476D1CE4E5B9)
        ^ (ct as u32 as u64).wrapping_mul(0x94D049BB133111EB);
    ((h ^ (h >> 32)) as usize) & 0x1FFFFF
}

fn collect_pass_candidates(
    samples: &[SpdSample],
    shards: &[ShardDesc],
    shard_lookup: &std::collections::HashMap<(i32, i32), Vec<usize>>,
    fid_to_hex: &[u32],
    e: &PassDesc,
    s0: f64,
    s1: f64,
    pass_idx: u32,
    need_cells: bool,
    shortlist: &mut [OutShortlist],
    shortlist_seen: &mut [bool],
    candidates: &mut Vec<(u32, u32, f64)>,
    coarse_bits: &mut [u64],
) {
    candidates.clear();
    coarse_bits.fill(0);
    let tv = f64::max(22.0, 0.5 * e.v);
    let tpad = 5.0;
    let m_min = ((s0 + e.tc - tpad - 25.0) / 60.0).floor() as i32;
    let m_max = ((s1 + e.tc + tpad + 60.0) / 60.0).floor() as i32;
    let b_min = i32::max(3, ((e.v - tv) / 4.0).floor() as i32);
    let b_max = i32::min(60, ((e.v + tv) / 4.0).floor() as i32);
    let d_lo = (0.25 * e.d - 150.0).max(0.0);
    let d_hi = 3.5 * e.d + 600.0;

    for m in m_min..=m_max {
        for b in b_min..=b_max {
            let Some(sh_indices) = shard_lookup.get(&(m, b)) else { continue };
            for &sh_idx in sh_indices {
                let sh = &shards[sh_idx];
                let start_i = sh.sample_off as usize;
                let end_i = start_i + (sh.sample_cnt as usize);
                for (local_i, raw) in samples[start_i..end_i].iter().enumerate() {
                    let ve = (raw.ve_dm as f64) * 0.1;
                    let vn = (raw.vn_dm as f64) * 0.1;
                    let vz = (raw.vz_dm as f64) * 0.1;
                    let hs = (ve * ve + vn * vn).sqrt();
                    if hs < 15.0 || ((hs * hs + vz * vz).sqrt() - e.v).abs() > tv {
                        continue;
                    }
                    let s_t = sh.day0 + (raw.t_ds as f64) * 0.1;
                    if s_t + 5.0 - 30.0 / C - e.tc < s0 - tpad || s_t - 5.0 - d_hi / C - e.tc > s1 + tpad {
                        continue;
                    }
                    let z_c = f64::max(30.0, raw.z as f64);
                    if z_c > d_hi {
                        continue;
                    }
                    let d_min = z_c.max(d_lo);
                    let max_h = 32.0 * 125.0_f64;
                    let d_max = (max_h * max_h + z_c * z_c).sqrt().min(d_hi);
                    if s_t + 5.0 - d_min / C - e.tc < s0 - tpad || s_t - 5.0 - d_max / C - e.tc > s1 + tpad {
                        continue;
                    }
                    let fid = sh.fid_base + raw.fi;
                    let hex_id = fid_to_hex.get(fid as usize).copied().unwrap_or(fid);
                    let s_lat = (raw.lat_e6 as f64) * 1e-6;
                    let s_lon = (raw.lon_e6 as f64) * 1e-6;
                    let dv = (hs - e.v).abs();
                    let hid = hex_id as usize;
                    if hid < shortlist.len() && (!shortlist_seen[hid] || dv < shortlist[hid].dv) {
                        shortlist_seen[hid] = true;
                        shortlist[hid] = OutShortlist {
                            fid,
                            _pad: pass_idx,
                            lat: s_lat,
                            lon: s_lon,
                            start: (s_t - e.d / C - e.tc).clamp(s0 - tpad, s1 + tpad),
                            dv,
                        };
                    }
                    if need_cells {
                        let nom_start = s_t - e.d / C - e.tc;
                        let lat_rad = s_lat * (PI / 180.0);
                        let cos_s_lat = lat_rad.cos().max(0.1);
                        let px = -vn / hs;
                        let py = ve / hs;
                        let kx = 1.0 / (MY * cos_s_lat);
                        let h_mid = (0.5 * (d_min + d_max)).min(1800.0);
                        for side in [-1.0, 1.0] {
                            let m_lat = s_lat + (side * h_mid * py) / MY;
                            let m_lon = s_lon + side * h_mid * px * kx;
                            let (cy, cx, ct) = coarse_coords(m_lat, m_lon, nom_start);
                            for dy in -1..=1 {
                                for dx in -1..=1 {
                                    for dt_c in -1..=1 {
                                        let bit = coarse_hash(cy + dy, cx + dx, ct + dt_c);
                                        coarse_bits[bit >> 6] |= 1u64 << (bit & 63);
                                    }
                                }
                            }
                        }
                        candidates.push(((start_i + local_i) as u32, fid, s_t));
                    }
                }
            }
        }
    }
}

fn expand_pass_cells(
    map: &mut CellMap,
    prev_map: Option<&CellMap>,
    states: &mut Vec<SampleState>,
    samples: &[SpdSample],
    fid_to_hex: &[u32],
    e: &PassDesc,
    s0: f64,
    s1: f64,
    candidates: &[(u32, u32, f64)],
    other_bits: &[Vec<u64>],
    self_p: usize,
) {
    map.clear();
    let tpad = 5.0;
    let d_lo = 0.25 * e.d - 150.0;
    let d_hi = 3.5 * e.d + 600.0;

    for &(samp_idx, fid, s_t) in candidates {
        let raw = &samples[samp_idx as usize];
        let s_lat = (raw.lat_e6 as f64) * 1e-6;
        let s_lon = (raw.lon_e6 as f64) * 1e-6;
        let nom_start = s_t - e.d / C - e.tc;
        let (cy_c, cx_c, ct_c) = coarse_coords(s_lat, s_lon, nom_start);
        let bit = coarse_hash(cy_c, cx_c, ct_c);
        let w = bit >> 6;
        let mask = 1u64 << (bit & 63);
        let mut any_other = false;
        for (q, ob) in other_bits.iter().enumerate() {
            if q != self_p && (ob[w] & mask) != 0 {
                any_other = true;
                break;
            }
        }
        if !any_other {
            continue;
        }
        let ve = (raw.ve_dm as f64) * 0.1;
        let vn = (raw.vn_dm as f64) * 0.1;
        let vz = (raw.vz_dm as f64) * 0.1;
        let hs = (ve * ve + vn * vn).sqrt();
        let hex_id = fid_to_hex.get(fid as usize).copied().unwrap_or(fid);
        let s_z = raw.z as f64;
        let z_c = f64::max(30.0, s_z);
        let lat_rad = s_lat * (PI / 180.0);
        let cos_s_lat = lat_rad.cos();
        let sin_s_lat = lat_rad.sin() * (PI / 180.0);
        let px = -vn / hs;
        let py = ve / hs;
        let kx = 1.0 / (MY * cos_s_lat);

        let mut valid_h: [(f64, f64); 33] = [(0.0, 0.0); 33];
        let mut n_valid_h = 0usize;
        for hi in 0..33 {
            let h = (hi as f64) * 125.0;
            let d = (h * h + z_c * z_c).sqrt();
            if d >= d_lo && d <= d_hi {
                valid_h[n_valid_h] = (h, d);
                n_valid_h += 1;
            }
        }
        if n_valid_h == 0 {
            continue;
        }
        for dt in [-5.0, 0.0, 5.0] {
            let st = s_t + dt;
            let s_lat_dt = s_lat + (vn * dt) / MY;
            let s_lon_dt = s_lon + (ve * dt) * kx;
            let state = SampleState {
                t: st,
                lat: s_lat_dt,
                lon: s_lon_dt,
                z: s_z,
                ve,
                vn,
                vz,
            };
            let mut state_idx = u32::MAX;
            let mut last_key_neg = u64::MAX;
            let mut last_key_pos = u64::MAX;
            for &(h, d) in &valid_h[..n_valid_h] {
                let start = st - d / C - e.tc;
                if start < s0 - tpad || start > s1 + tpad {
                    continue;
                }
                let sides: &[f64] = if h == 0.0 { &[1.0] } else { &[-1.0, 1.0] };
                for &side in sides {
                    let lat = s_lat_dt + (side * h * py) / MY;
                    let lon = s_lon_dt + side * h * px * kx;
                    let cos_lat = cos_s_lat - sin_s_lat * (lat - s_lat);
                    if let Some(pm) = prev_map {
                        let cy = ((lat * MY) / CELL).floor() as i32;
                        let cx = ((lon * MY * cos_lat) / CELL).floor() as i32;
                        let bt = (start * (1.0 / 12.0)).floor() as i32;
                        if !pm.has_near_spacetime(cy, cx, bt) {
                            continue;
                        }
                    } else {
                        let (cy_c, cx_c, ct_c) = coarse_coords(lat, lon, start);
                        let cbit = coarse_hash(cy_c, cx_c, ct_c);
                        let cw = cbit >> 6;
                        let cmask = 1u64 << (cbit & 63);
                        let mut cell_ok = false;
                        for (q, ob) in other_bits.iter().enumerate() {
                            if q != self_p && (ob[cw] & cmask) != 0 {
                                cell_ok = true;
                                break;
                            }
                        }
                        if !cell_ok {
                            continue;
                        }
                    }
                    let cy = ((lat * MY) / CELL).floor() as i32;
                    let cx = ((lon * MY * cos_lat) / CELL).floor() as i32;
                    let key = pack_cell(cy, cx);
                    if side < 0.0 {
                        if key == last_key_neg {
                            continue;
                        }
                        last_key_neg = key;
                    } else {
                        if key == last_key_pos {
                            continue;
                        }
                        last_key_pos = key;
                    }
                    if state_idx == u32::MAX {
                        state_idx = states.len() as u32;
                        states.push(state);
                    }
                    let entry = CellEntry {
                        start,
                        lat,
                        lon,
                        fid,
                        hex_id,
                        state_idx,
                    };
                    map.insert_if_new(key, entry);
                }
            }
        }
    }
}

fn refresh_ptrs(arena: &mut Arena) {
    arena.header.samples_ptr = arena.samples.as_ptr() as u32;
    arena.header.shards_ptr = arena.shards.as_ptr() as u32;
    arena.header.fid_to_hex_ptr = arena.fid_to_hex.as_ptr() as u32;
    arena.header.passes_ptr = arena.passes.as_ptr() as u32;
    arena.header.qp_ptr = arena.qp.as_ptr() as u32;
    arena.header.spans_ptr = arena.spans.as_ptr() as u32;
    arena.header.out_hits_ptr = arena.out_hits.as_ptr() as u32;
    arena.header.out_shortlist_ptr = arena.out_shortlist.as_ptr() as u32;
}

#[no_mangle]
pub extern "C" fn init_arena(max_samples: usize, max_shards: usize, max_fids: usize) -> *mut IOHeader {
    unsafe {
        if let Some(arena) = ARENA.as_mut() {
            if arena.samples.len() < max_samples {
                arena.samples.resize(
                    max_samples,
                    SpdSample {
                        fi: 0,
                        t_ds: 0,
                        lat_e6: 0,
                        lon_e6: 0,
                        z: 0,
                        ve_dm: 0,
                        vn_dm: 0,
                        vz_dm: 0,
                    },
                );
            }
            if arena.shards.len() < max_shards {
                arena.shards.resize(
                    max_shards,
                    ShardDesc {
                        sample_off: 0,
                        sample_cnt: 0,
                        minute: 0,
                        band: 0,
                        fid_base: 0,
                        _pad: 0,
                        day0: 0.0,
                    },
                );
            }
            let max_sl = max_fids.saturating_mul(MAX_PASSES);
            if arena.fid_to_hex.len() < max_fids {
                arena.fid_to_hex.resize(max_fids, 0);
            }
            if arena.out_shortlist.len() < max_sl {
                arena.out_shortlist.resize(
                    max_sl,
                    OutShortlist {
                        fid: 0,
                        _pad: 0,
                        lat: 0.0,
                        lon: 0.0,
                        start: 0.0,
                        dv: 0.0,
                    },
                );
            }
            refresh_ptrs(arena);
            return &mut arena.header as *mut IOHeader;
        }
    }

    let samples = vec![
        SpdSample {
            fi: 0,
            t_ds: 0,
            lat_e6: 0,
            lon_e6: 0,
            z: 0,
            ve_dm: 0,
            vn_dm: 0,
            vz_dm: 0,
        };
        max_samples
    ];
    let shards = vec![
        ShardDesc {
            sample_off: 0,
            sample_cnt: 0,
            minute: 0,
            band: 0,
            fid_base: 0,
            _pad: 0,
            day0: 0.0,
        };
        max_shards
    ];
    let fid_to_hex = vec![0u32; max_fids];
    let passes = vec![
        PassDesc {
            v: 0.0,
            d: 0.0,
            tc: 0.0,
            qp_off: 0,
            qp_cnt: 0,
        };
        MAX_PASSES
    ];
    let qp = vec![QpPoint { tr: 0.0, f: 0.0 }; MAX_QP];
    let spans = vec![SpanDesc { sp0: 0.0, sp1: 0.0 }; MAX_SPANS];
    let out_hits = vec![
        OutHit {
            lat: 0.0,
            lon: 0.0,
            start: 0.0,
            pre: 0.0,
            set_idx: 0,
            n_flights: 0,
            fids: [0; MAX_PASSES],
        };
        MAX_OUT_HITS
    ];
    let out_shortlist = vec![
        OutShortlist {
            fid: 0,
            _pad: 0,
            lat: 0.0,
            lon: 0.0,
            start: 0.0,
            dv: 0.0,
        };
        max_fids.saturating_mul(MAX_PASSES)
    ];
    let maps = (0..MAX_PASSES).map(|_| CellMap::with_capacity(20, 262144)).collect();

    let header = IOHeader {
        num_samples: 0,
        num_shards: 0,
        num_fids: 0,
        num_hexes: 0,
        num_passes: 0,
        num_qp: 0,
        num_spans: 0,
        out_hits_count: 0,
        out_shortlist_count: 0,
        samples_ptr: 0,
        shards_ptr: 0,
        fid_to_hex_ptr: 0,
        passes_ptr: 0,
        qp_ptr: 0,
        spans_ptr: 0,
        out_hits_ptr: 0,
        out_shortlist_ptr: 0,
    };

    let mut boxed = Box::new(Arena {
        header,
        samples,
        shards,
        fid_to_hex,
        passes,
        qp,
        spans,
        out_hits,
        out_shortlist,
        maps,
        states: Vec::with_capacity(65536),
    });
    refresh_ptrs(&mut boxed);
    let ptr = &mut boxed.header as *mut IOHeader;
    unsafe {
        ARENA = Some(boxed);
    }
    ptr
}

#[no_mangle]
pub extern "C" fn run_search() {
    let arena = unsafe {
        match ARENA.as_mut() {
            Some(a) => a,
            None => return,
        }
    };

    let num_samples = (arena.header.num_samples as usize).min(arena.samples.len());
    let num_shards = (arena.header.num_shards as usize).min(arena.shards.len());
    let num_fids = (arena.header.num_fids as usize).min(arena.fid_to_hex.len());
    let num_hexes = (arena.header.num_hexes as usize).min(arena.out_shortlist.len()).max(1);
    let p_cnt = (arena.header.num_passes as usize).min(MAX_PASSES);
    let num_qp = (arena.header.num_qp as usize).min(MAX_QP);
    let num_spans = (arena.header.num_spans as usize).min(MAX_SPANS);

    let samples = &arena.samples[..num_samples];
    let shards = &arena.shards[..num_shards];
    let fid_to_hex = &arena.fid_to_hex[..num_fids];
    let passes = &arena.passes[..p_cnt];
    let qp_all = &arena.qp[..num_qp];
    let spans = &arena.spans[..num_spans];

    let mut shard_lookup: std::collections::HashMap<(i32, i32), Vec<usize>> =
        std::collections::HashMap::with_capacity(num_shards * 2);
    for (i, sh) in shards.iter().enumerate() {
        shard_lookup.entry((sh.minute, sh.band)).or_default().push(i);
    }

    let mut sets: Vec<Vec<usize>> = Vec::with_capacity(MAX_SETS);
    if p_cnt >= 2 {
        sets.push((0..p_cnt).collect());
        if p_cnt >= 3 {
            for i in 0..p_cnt {
                sets.push((0..p_cnt).filter(|&j| j != i).collect());
            }
            if p_cnt >= 4 {
                for i in 0..p_cnt {
                    for j in (i + 1)..p_cnt {
                        sets.push(vec![i, j]);
                    }
                }
            }
        }
    }

        let mut shortlists: Vec<Vec<OutShortlist>> = (0..p_cnt)
            .map(|p| {
                vec![
                    OutShortlist {
                        fid: 0,
                        _pad: p as u32,
                        lat: 0.0,
                        lon: 0.0,
                        start: 0.0,
                        dv: f64::INFINITY,
                    };
                    num_hexes
                ]
            })
    .collect();
    let mut shortlist_seen: Vec<Vec<bool>> = (0..p_cnt).map(|_| vec![false; num_hexes]).collect();
    arena.states.clear();
    let mut set_hits: Vec<Vec<Combo>> = (0..sets.len()).map(|_| Vec::new()).collect();
    const CH: f64 = 600.0;
    for sp in spans {
        let mut a = sp.sp0;
        while a < sp.sp1 {
            let b = f64::min(sp.sp1, a + CH);
            let need_cells = p_cnt >= 2;
            let mut pass_cands: Vec<Vec<(u32, u32, f64)>> = (0..p_cnt).map(|_| Vec::with_capacity(4096)).collect();
            let mut coarse_bits: Vec<Vec<u64>> = (0..p_cnt).map(|_| vec![0u64; 32768]).collect();
            for p in 0..p_cnt {
                collect_pass_candidates(
                    samples,
                    shards,
                    &shard_lookup,
                    fid_to_hex,
                    &passes[p],
                    a,
                    b,
                    p as u32,
                    need_cells,
                    &mut shortlists[p],
                    &mut shortlist_seen[p],
                    &mut pass_cands[p],
                    &mut coarse_bits[p],
                );
            }
            if need_cells {
                for p in 0..p_cnt {
                    let (left, right) = arena.maps.split_at_mut(p);
                    let prev_map = if p_cnt == 2 && p == 1 { Some(&left[0]) } else { None };
                    expand_pass_cells(
                        &mut right[0],
                        prev_map,
                        &mut arena.states,
                        samples,
                        fid_to_hex,
                        &passes[p],
                        a,
                        b,
                        &pass_cands[p],
                        &coarse_bits,
                        p,
                    );
                }
            }

            if p_cnt >= 2 {
                for (s_idx, ix) in sets.iter().enumerate() {
                    let m0 = &arena.maps[ix[0]];
                    if m0.entries.is_empty() {
                        continue;
                    }
                    let mut combos: Vec<Combo> = Vec::new();
                    let mut next: Vec<Combo> = Vec::new();
                    let mut cand_idx: Vec<u32> = Vec::with_capacity(64);
                    let mut cand_seen: Vec<u64> = Vec::with_capacity(64);

                    for &slot in &m0.used_slots {
                        let k = m0.keys[slot];
                        let (cy, cx) = unpack_cell(k);
                        let m1_check = &arena.maps[ix[1]];
                        combos.clear();
                        let mut idx0 = m0.head[slot];
                        while idx0 != u32::MAX {
                            let e0 = &m0.entries[idx0 as usize];
                            let bt0 = (e0.start * (1.0 / 12.0)).floor() as i32;
                            if !m1_check.has_near_spacetime(cy, cx, bt0) {
                                idx0 = m0.next[idx0 as usize];
                                continue;
                            }
                            let mut fids = [0u32; MAX_PASSES];
                            let mut hex_ids = [0u32; MAX_PASSES];
                            let mut state_ids = [0u32; MAX_PASSES];
                            fids[0] = e0.fid;
                            hex_ids[0] = e0.hex_id;
                            state_ids[0] = e0.state_idx;
                            combos.push(Combo {
                                n: 1,
                                fids,
                                hex_ids,
                                state_ids,
                                start: e0.start,
                                lat: e0.lat,
                                lon: e0.lon,
                                pre: f64::INFINITY,
                            });
                            idx0 = m0.next[idx0 as usize];
                        }

                        if combos.is_empty() {
                            continue;
                        }
                        for &p_next in &ix[1..] {
                            let mp = &arena.maps[p_next];
                            let mut min_st = f64::INFINITY;
                            let mut max_st = f64::NEG_INFINITY;
                            for c in &combos {
                                if c.start < min_st {
                                    min_st = c.start;
                                }
                                if c.start > max_st {
                                    max_st = c.start;
                                }
                            }
                            let st_lo = min_st - 12.0;
                            let st_hi = max_st + 12.0;
                            cand_idx.clear();
                            cand_seen.clear();
                            for dy in -3..=3 {
                                for dx in -3..=3 {
                                    let nk = pack_cell(cy + dy, cx + dx);
                                    let mut c_idx = mp.get_head(nk);
                                    while c_idx != u32::MAX {
                                        let ce = &mp.entries[c_idx as usize];
                                        let cst = ce.start;
                                        if cst > st_lo && cst < st_hi {
                                            let ck = ((ce.hex_id as u64) << 32) | (((cst * 0.2).round() as i32 as u32) as u64);
                                            if !cand_seen.contains(&ck) {
                                                cand_seen.push(ck);
                                                cand_idx.push(c_idx);
                                            }
                                        }
                                        c_idx = mp.next[c_idx as usize];
                                    }
                                }
                            }
                            if cand_idx.is_empty() {
                                combos.clear();
                                break;
                            }
                            next.clear();
                            for c in &combos {
                                let mut seen_hex = [0u32; 8];
                                let mut seen_len = 0usize;
                                for &ci in &cand_idx {
                                    let o = &mp.entries[ci as usize];
                                    if (o.start - c.start).abs() < 12.0 {
                                        let o_hex = o.hex_id;
                                        let mut dup = false;
                                        for k_i in 0..c.n {
                                            if c.hex_ids[k_i] == o_hex {
                                                dup = true;
                                                break;
                                            }
                                        }
                                        if dup {
                                            continue;
                                        }
                                        for k_i in 0..seen_len {
                                            if seen_hex[k_i] == o_hex {
                                                dup = true;
                                                break;
                                            }
                                        }
                                        if dup {
                                            continue;
                                        }
                                        seen_hex[seen_len] = o_hex;
                                        seen_len += 1;
                                        let mut nc = c.clone();
                                        nc.fids[nc.n] = o.fid;
                                        nc.hex_ids[nc.n] = o_hex;
                                        nc.state_ids[nc.n] = o.state_idx;
                                        nc.n += 1;
                                        nc.start = 0.5 * (c.start + o.start);
                                        nc.lat = 0.5 * (c.lat + o.lat);
                                        nc.lon = 0.5 * (c.lon + o.lon);
                                        next.push(nc);
                                        if seen_len >= 8 {
                                            break;
                                        }
                                    }
                                }
                            }
                            std::mem::swap(&mut combos, &mut next);
                            if combos.is_empty() {
                                break;
                            }
                        }

                        for c in &combos {
                            set_hits[s_idx].push(c.clone());
                        }
                    }
                }
            }
            a += CH;
        }
    }

    let mut hit_write = 0usize;
    let max_out_hits = arena.out_hits.len();
    for (s_idx, ix) in sets.iter().enumerate() {
        let raw_hits = &mut set_hits[s_idx];
        if raw_hits.is_empty() {
            continue;
        }
        let mut fine_seen: std::collections::HashSet<(i32, i32, i32, [u32; MAX_PASSES])> =
            std::collections::HashSet::with_capacity(raw_hits.len() / 4 + 64);
        let mut hits: Vec<Combo> = Vec::with_capacity(raw_hits.len() / 4 + 64);
        for h in raw_hits.drain(..) {
            let fk = (
                (h.lat * 80.0).round() as i32,
                (h.lon * 80.0).round() as i32,
                (h.start / 6.0).round() as i32,
                h.hex_ids,
            );
            if fine_seen.insert(fk) {
                hits.push(h);
            }
        }
        let n_p = ix.len();
        let mut qps: Vec<&[QpPoint]> = Vec::with_capacity(n_p);
        for &p_i in ix {
            let pd = &passes[p_i];
            let s = pd.qp_off as usize;
            let e = s + (pd.qp_cnt as usize);
            qps.push(&qp_all[s..e]);
        }

        for h in hits.iter_mut() {
            let mut best_pre = f64::INFINITY;
            let s0 = &arena.states[h.state_ids[0] as usize];
            let ve0 = s0.ve;
            let vn0 = s0.vn;
            let hs = (ve0 * ve0 + vn0 * vn0).sqrt();
            let inv_my = 1.0 / MY;
            let inv_lon = 1.0 / (MY * (h.lat * (PI / 180.0)).cos());

            for o in [-300.0, -150.0, 0.0, 150.0, 300.0] {
                let lat = h.lat + (o * (ve0 / hs)) * inv_my;
                let lon = h.lon + (o * (-vn0 / hs)) * inv_lon;
                for ds in [-3.0, 0.0, 3.0] {
                    let st = h.start + ds;
                    let mut sum = 0.0;
                    let bound = best_pre * (n_p as f64);
                    for p in 0..n_p {
                        let q = lin_score(qps[p], &arena.states[h.state_ids[p] as usize], lat, lon, st);
                        sum += q;
                        if sum >= bound {
                            break;
                        }
                    }
                    let avg = sum / (n_p as f64);
                    if avg < best_pre {
                        best_pre = avg;
                    }
                }
            }
            h.pre = best_pre;
        }

        hits.sort_by(|a, b| a.pre.partial_cmp(&b.pre).unwrap_or(std::cmp::Ordering::Equal));

        let mut seen_keys: std::collections::HashSet<(i32, i32, i32, [u32; MAX_PASSES])> =
            std::collections::HashSet::with_capacity(64);
        for h in hits.iter() {
            if !h.pre.is_finite() {
                break;
            }
            let k_lat = (h.lat * 20.0).round() as i32;
            let k_lon = (h.lon * 20.0).round() as i32;
            let k_st = (h.start / 20.0).round() as i32;
            let key = (k_lat, k_lon, k_st, h.hex_ids);
            if seen_keys.contains(&key) {
                continue;
            }
            seen_keys.insert(key);
            if hit_write < max_out_hits {
                arena.out_hits[hit_write] = OutHit {
                    lat: h.lat,
                    lon: h.lon,
                    start: h.start,
                    pre: h.pre,
                    set_idx: s_idx as u32,
                    n_flights: n_p as u32,
                    fids: h.fids,
                };
                hit_write += 1;
            }
            if seen_keys.len() >= 48 {
                break;
            }
        }
    }

        let mut sl_write = 0usize;
        let max_sl = arena.out_shortlist.len();
        for p in 0..p_cnt {
            let seen = &shortlist_seen[p];
            let mut sl_vec: Vec<OutShortlist> = shortlists[p]
                .iter()
                .copied()
                .enumerate()
                .filter(|&(i, _)| seen[i])
                .map(|(_, v)| v)
                .collect();
            sl_vec.sort_by(|a, b| a.dv.partial_cmp(&b.dv).unwrap_or(std::cmp::Ordering::Equal));
            let take = sl_vec.len().min(max_sl.saturating_sub(sl_write));
            if take > 0 {
                arena.out_shortlist[sl_write..sl_write + take].copy_from_slice(&sl_vec[..take]);
                sl_write += take;
            }
        }
    arena.header.out_hits_count = hit_write as u32;
    arena.header.out_shortlist_count = sl_write as u32;
}
