# doppler-geo

Locate where and when an audio or video recording was made from the acoustic Doppler shift of overhead propeller aircraft, matched against worldwide ADS-B flight history.

**Live demo:** [https://doppler.teamchong.net](https://doppler.teamchong.net)
**Inspired by:** [colsto's acoustic aircraft geolocation video](https://youtu.be/UytYrhYLOKI)
**License:** [MIT](./LICENSE)

## Overview

When a propeller plane or helicopter flies past a microphone, its blade-pass tone slides downward in frequency as an S-curve:
* **Approach vs. recede asymptotes** give the aircraft's ground speed $v$.
* **Slope at the inflection point** gives the closest-approach slant distance $d$.
* **Inflection time** gives the exact moment of closest approach $t_c$ (plus acoustic travel delay $d / c$).

`doppler-geo` extracts those Doppler curves directly in the browser using WebAudio and a Web Worker, then searches worldwide ADS-B flight trajectories to find where on Earth the microphone was located.

### Privacy & Zero-Location Design
* **100% client-side DSP:** Microphone recordings and uploaded audio/video files are decoded and analyzed locally in your browser (`OfflineAudioContext`, `AudioWorklet`, and a Web Worker). Raw audio never leaves your device.
* **Zero location input:** The app never asks for browser geolocation (`navigator.geolocation`), never performs IP geolocation (`request.cf`), and uses no cookies or analytics.
* **Worldwide ADS-B matching:** Candidate aircraft are searched across global propeller traffic so location and time are inferred solely from the acoustic frequency trace(s) and public flight tracks.

## Single Pass vs. Multi-Pass Pinpointing

| Scenario | Physical Constraint | Solver Output | Bundled Benchmark Example |
| :--- | :--- | :--- | :--- |
| **1 aircraft pass** (unknown clock time) | Constrains ground speed $v$ and slant distance $d$, placing the microphone on a parallel corridor at distance $d$ on either side of the flight track | **Shortlist** of worldwide aircraft matching $(v, d)$ during the time window | **Example 2 (`kampina-klankbeeld.mp3`):** Unedited 2-minute wildlife recording on Kampina heath, Netherlands ([Freesound #858688](https://freesound.org/people/klankbeeld/sounds/858688/)). A distant Cessna 172 (`PH-TRG`, $v \approx 45\text{ m/s}$, $d \approx 1.97\text{ km}$) hums behind the birds around `0:39`, narrowing 1,147 worldwide flights to a shortlist containing `PH-TRG`. |
| **2+ aircraft passes** (or known live clock time) | Intersects spatial-temporal corridors across all passes with a shared recording start time $t_0$ and ground position $(\text{lat}, \text{lon})$ | **Pinpointed spot** with uncertainty hull and ADS-B flight trajectories | **Example 1 (`two-planes-sim.mp3`):** Two real ADS-B tracks over Cranfield, UK (`G-GFIG` Cessna 152 and `G-RIMM` Westland Wasp) passing ~4 minutes apart. Crossing passes pin the microphone to **~40 meters** from ground truth across all 1,147 global propeller flights. |

## Field Test Findings: Why the YouTube Video Overstates It

We built `doppler-geo` to test how well acoustic aircraft geolocation actually works when you remove manual region/time hints and run against worldwide ADS-B traffic:

1. **Hearing Just 1 Plane Cannot Pinpoint Your Location:** The sound of a single plane only tells you how fast it flew ($v$) and how close it passed ($d$). It cannot tell you what direction or country it was in. Because hundreds of small planes around the world fly at the exact same speed at any given time, 1 plane only gives a list of hundreds of possible matches worldwide (as **Example 2** shows). You must capture **at least 2 different planes** flying past the same microphone so their paths cross at a single point on Earth (**Example 1**).
2. **Big Commercial Jets (`737`, `A320`, `A380`) Do Not Work:** Jet airliners produce broadband exhaust roar rather than a single steady note, and pilots constantly change engine power during climb and landing. This method only works on **propeller planes, turboprops, and helicopters** whose spinning blades produce a steady hum.
3. **Needs Daytime & an Outdoor Microphone:** Small propeller planes mostly fly during the day and stay away from major commercial airports. Leaving a microphone running indoors or overnight in a city usually catches nothing because very few small prop planes fly at night, and windows plus indoor fan/AC hum drown out distant propeller sound.

## How the Algorithm Works

### 1. Acoustic Doppler Pass Detection (`public/lib/spectro.js`, `public/lib/media.js`)
1. **Resampling & STFT:** Audio is anti-alias filtered with a 63-tap Blackman-windowed sinc FIR filter and decimated to $f_s = 4000\text{ Hz}$, then transformed with a 4096-point Hann-windowed FFT every $\Delta t = 0.25\text{ s}$ across the $80\text{ to }700\text{ Hz}$ propeller blade-pass band ($\Delta f \approx 0.98\text{ Hz}$).
2. **Two-Stage Whitening & Harmonic Masking:** Stationary electrical/background hum is removed per frequency bin via robust median/MAD normalization, followed by per-frame median subtraction to suppress broadband transients (wind, birds, footsteps). Harmonic and subharmonic aliases ($\frac{1}{3}, \frac{1}{2}, \frac{2}{3}, 2\times, 3\times$) are masked so the dominant fundamental trace is isolated.
3. **Viterbi Ridge Tracking & Physical Parameter Fit:** A monotone non-increasing dynamic programming tracker extracts candidate pass ridges and fits each ridge to the constant-velocity straight-line acoustic Doppler model (`fitLine` / `nelderMead` in `public/lib/physics.js`):
   $$f(t) = \frac{f_0}{1 + \frac{v}{c} \cdot \frac{v(t - t_c)}{\sqrt{d^2 + v^2(t - t_c)^2}}}, \quad c = 340\text{ m/s}$$
   estimating rest frequency $f_0$, ground speed $v$, closest-approach slant distance $d$, and closest-approach time $t_c$, while rejecting stationary tones and non-physical fits.

### 2. Worldwide Speed-Index Lookup & Multi-Pass Join (`public/lib/search.js`, `public/lib/data.js`)
* **Dual Data Sources:**
  * **Rolling 60-minute worldwide feed (`/api/live` + `LiveTrackerDO`):** A singleton Cloudflare Durable Object (`LiveTrackerDO` in `worker/index.js`) wakes every 20 seconds via `alarm()`, polls worldwide airborne piston/turboprop/helicopter traffic from [adsb.lol](https://adsb.lol) (`public/prop-types.json`, 2,302 ICAO type designators ordered with active types first), and checkpoints a rolling 60-minute trajectory buffer in SQLite storage. Visitors opening the page immediately receive the full multi-point track history and subsequent delta updates (`?since=<ts>`).
  * **Historical daily index (`data/spd/{day}.bin`, `data/day/{day}.bin`):** Pre-indexed UTC day shards bucket aircraft state samples by `(UTC minute, 4 m/s speed band)` for fast HTTP `Range` lookup, alongside $1^\circ \times 1^\circ$ gzipped trajectory tiles.
* **Zero-Copy Rust WASM Kernel (`public/lib/search_kernel.wasm`, `scripts/search_kernel.rs`):** Decompressed 24-byte `SpdSample` shard buffers (`[fi, t_ds, lat_e6, lon_e6, z, ve_dm, vn_dm, vz_dm]`) are placed directly into `wasm.memory` with zero JS object deserialization. A single cross-boundary call (`run_search()`) executes candidate projection (`lookup`), spatial-temporal cell intersection across all pass subsets (`join`), and 3D linear Doppler pre-ranking (`lin_score`), returning only the top deduplicated survivors for 3D spline verification.

### 3. Retarded-Time Trajectory Verification (`public/lib/solver.js`, `public/lib/physics.js`)
* **3D Hermite Spline Tracks (`buildTrack`):** Raw ADS-B points are outlier-filtered and interpolated into smooth 3D local tangent-plane position and velocity trajectories.
* **Exact Acoustic Propagation Delay (`retardedK`):** For a candidate microphone position $\mathbf{x}_{\text{mic}}$ and observation time $t_{\text{obs}}$, the solver finds the emission time $t_{\text{emit}}$ satisfying:
  $$t_{\text{emit}} + \frac{\|\mathbf{x}(t_{\text{emit}}) - \mathbf{x}_{\text{mic}}\|}{c} = t_{\text{obs}}$$
  computes the exact line-of-sight Doppler factor $k(t_{\text{obs}})$, solves each plane's rest frequency $f_0 = (\sum f_i k_i) / (\sum k_i^2)$ in closed form, and refines $(\text{lat}, \text{lon}, t_0)$ via coarse/fine grid search and Nelder-Mead simplex optimization (`nelderMead`), penalized by nearby propeller aircraft in the index that should have been audible (`unheard`).

## Quick Start & Local `npm` Scripts

Requires **Node.js 22+**. Zero external databases, API keys, or hardcoded domains are required.

```bash
# Install dependencies
npm install

# Run the full test suite (detector recall, end-to-end examples, and 20-spot batch benchmark)
npm test

# Start the local Cloudflare Worker + Durable Object + static asset dev server
npm run dev
```

### All `npm` Scripts

| Command | Description |
| :--- | :--- |
| `npm run dev` | Start local Cloudflare Worker + `LiveTrackerDO` SQLite Durable Object dev server (`http://localhost:8787`) |
| `npm test` | Run all three benchmark suites (`test:detector`, `test:e2e`, `test:batch`) |
| `npm run update:data` | Refresh `public/prop-types.json` from `tar1090-db` + live `adsb.lol` and rebuild the bundled `2025-07-18` example index |
| `npm run update:types` | Fetch latest piston/turboprop ICAO type designators (`scripts/prop-types.mjs`) with active types prioritized first |
| `npm run update:example` | Rebuild `public/examples/2025-07-18/data` from `test/fixtures/kampina-slice.json` |
| `npm run index:day -- YYYY-MM-DD` | Stream an `adsb.lol` daily readsb tarball from `stdin` into `public/data/` and update `public/data/days.json` |
| `npm run build:wasm` | Recompile `scripts/search_kernel.rs` to `public/lib/search_kernel.wasm` (`wasm32-unknown-unknown`) |
| `npm run deploy` | Deploy Worker, static assets, and `LiveTrackerDO` migration to Cloudflare (`*.workers.dev` by default, or custom domain if `CF_DOMAIN` is set) |

### Deploying Your Own Instance (Zero Hardcode)

`wrangler.jsonc`, `cloudflare.config.ts`, and `worker/index.js` contain **no hardcoded domains, account IDs, or keys**:

1. **Deploy to `*.workers.dev`:**
   ```bash
   npx wrangler login
   npm run deploy
   ```
   Cloudflare automatically provisions the `LiveTrackerDO` SQLite Durable Object (`migrations` in `wrangler.jsonc`) and starts accumulating the rolling 60-minute worldwide ADS-B trajectory window.
2. **Deploy to a custom domain (optional):**
   Set `CF_DOMAIN` in your environment or in a local gitignored `.env` file:
   ```bash
   # Either inline:
   CF_DOMAIN=doppler.example.com npm run deploy

   # Or via local .env (ignored by git):
   echo "CF_DOMAIN=doppler.example.com" > .env
   npm run deploy
   ```
3. **Index additional historical days (optional):**
   To match uploaded recordings from earlier dates against historical archives, stream any UTC day tarball from [adsb.lol globe_history releases](https://github.com/adsblol) into `public/data/`:
   ```bash
   cat v2026.11.01-planes-readsb-prod-0.tar.* | npm run index:day -- 2026-11-01
   ```

## Repository Structure

| Path | Description |
| :--- | :--- |
| `public/index.html` | Single-page web UI with 3-step story header, source selector cards, interactive spectrogram, and Leaflet map |
| `public/app.js` | UI controller, high-DPI spectrogram renderer, map overlays, panel reset logic, live recording loop, and clip trimmer |
| `public/analyze.worker.js` | Web Worker running `analyze()` off the main thread |
| `public/lib/spectro.js` | STFT spectrogram, two-stage whitening, harmonic masking, Viterbi ridge extraction, and 1D Doppler curve fitting |
| `public/lib/physics.js` | 3D Hermite track interpolation (`buildTrack`), retarded-time Doppler solver (`retardedK`), and `nelderMead` optimizer |
| `public/lib/solver.js` | Multi-pass candidate generation, retarded-time scoring, and unanswered-flight penalty (`unheard`) |
| `public/lib/search.js` | Worldwide speed-index loader (`SpeedStore`), zero-copy WASM arena bridge, and 3D retarded-time verification |
| `public/lib/search_kernel.wasm` | Precompiled Rust `wasm32` kernel for zero-serialization `SpdSample` lookup, multi-pass join, and pre-ranking |
| `public/lib/data.js` | HTTP `Range` gzipped shard loader (`loadHistory`), rolling worldwide `LiveFeed` client, and track extrapolation |
| `public/lib/media.js` | Browser audio/video decoding, $4000\text{ Hz}$ anti-alias FIR decimation, `AudioWorklet` mic capture, and `.wav` export |
| `public/lib/geo.js` | Local tangent-plane (`frameAt`) and great-circle distance helpers |
| `public/lib/sim.js` | Synthetic propeller acoustic pass generator for simulation and testing |
| `public/prop-types.json` | 2,302 piston/turboprop ICAO type designators (ordered with active types first) |
| `public/examples/2025-07-18/` | Bundled example audio clips (`two-planes-sim.mp3`, `kampina-klankbeeld.mp3`) and 12-minute worldwide ADS-B slice |
| `worker/index.js` | Cloudflare Worker + `LiveTrackerDO` Durable Object maintaining the rolling 60-minute worldwide ADS-B feed (`/api/live`) |
| `scripts/build-index.mjs` | Streaming tar reader that builds `day/{day}.bin`, `idx/{day}.json`, `spd/{day}.bin`, and `days.json` from `adsb.lol` tarballs |
| `scripts/build-example.mjs` | Builds the bundled example index under `public/examples/2025-07-18/data` |
| `scripts/prop-types.mjs` | Regenerates `public/prop-types.json` from `tar1090-db` aircraft type definitions and active traffic |
| `scripts/search_kernel.rs` | Rust source for `public/lib/search_kernel.wasm` (shared `IOHeader` linear memory arena + single-call `run_search()`) |
| `test/detector.mjs` | Spectrogram & pass-detector recall benchmark on 20 simulated 2-plane spots |
| `test/e2e.mjs` | End-to-end solver test on the bundled simulated and real Kampina field recordings |
| `test/batch.mjs` | End-to-end batch accuracy benchmark across 20 simulated 2-plane spots against the worldwide slice |

## Credits & Data Licenses

* **ADS-B Flight Data:** [adsb.lol](https://adsb.lol) (Open Database License / ODbL).
* **Example Field Recording:** *"prop plane birds fens Kampina Netherlands 1140 am 250718_1173"* by [klankbeeld](https://freesound.org/people/klankbeeld/sounds/858688/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
* **Map Tiles:** [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors and AWS Terrain Tiles.
* **Code License:** [MIT](./LICENSE).
