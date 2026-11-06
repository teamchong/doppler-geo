# doppler-geo

Find where and when an audio or video recording was made from the sound of propeller planes or helicopters flying overhead, matched against public flight tracks worldwide.

**Live demo:** [https://doppler.teamchong.net](https://doppler.teamchong.net)  
**Inspired by:** [colsto's acoustic aircraft geolocation video](https://youtu.be/UytYrhYLOKI)  
**License:** [MIT](./LICENSE)

## How It Works (In Plain English)

When a propeller plane or helicopter flies past you, the pitch of its engine sound drops from high to low as it passes overhead (the **Doppler effect**):

* **How much the pitch drops** tells you the plane's **speed**.
* **How quickly the pitch drops** tells you **how close** the plane passed.
* **The moment the pitch drops fastest** tells you the **exact time** the plane was closest to the microphone.

`doppler-geo` measures that pitch drop directly in your browser, then searches worldwide flight tracks to find which planes were flying at that speed and distance, and where the microphone was on Earth.

### Privacy & Zero Location Hints

* **100% in your browser:** Microphone audio and uploaded files never leave your device.
* **No GPS or IP lookup:** The app never asks for browser location permissions, never checks your IP address, and uses no cookies or analytics.
* **Worldwide search:** Every recording is matched against flights across the entire world using only the sound of the plane and public flight tracks.

## Why 1 Plane Gives a List of Flights, While 2 Planes Pinpoint a Spot

| Scenario | What the Sound Tells You | What You Get | Included Example |
| :--- | :--- | :--- | :--- |
| **1 plane heard** | Only tells you the plane's speed and closest distance. It cannot tell you which direction or country it was flying in. | **Shortlist of possible planes worldwide** that were flying at that speed and distance. | **Example 2 (`kampina-klankbeeld.mp3`):** Real outdoor recording from Kampina, Netherlands ([Freesound #858688](https://freesound.org/people/klankbeeld/sounds/858688/)). One small Cessna 172 (`PH-TRG`, ~160 km/h, ~2 km away) hums behind birdsong around `0:39`, narrowing 1,147 worldwide flights to a shortlist that includes `PH-TRG`. |
| **2+ planes heard at the same spot** | Each plane narrows the map to a strip along its flight path. Where two different planes' paths cross at the right time difference is the only place on Earth the microphone could be. | **1 exact pinpointed location** on the map. | **Example 1 (`two-planes-sim.mp3` · Synthetic 2-Plane Audio + Real ADS-B Tracks):** Synthesized Doppler audio (`public/lib/sim.js`) over two real ADS-B flights near Cranfield, UK (`G-GFIG` Cessna 152 and `G-RIMM` Westland Wasp helicopter) passing 4 minutes apart. Their crossing paths pinpoint the virtual microphone to **within 40 meters** out of all 1,147 propeller flights worldwide. |

## What We Found in Real-World Testing

We built `doppler-geo` to test how well airplane sound geolocation works when you remove manual location hints and search against worldwide flights:

1. **Hearing Just 1 Plane Cannot Pinpoint Your Location:** The sound of a single plane only tells you how fast it flew and how close it passed. It cannot tell you which direction or country it was in. Because hundreds of small planes around the world fly at the exact same speed at any given time, 1 plane only gives a list of hundreds of possible matches worldwide (as **Example 2** shows). You must capture **at least 2 different planes** flying past the same microphone so their paths cross at a single point on Earth (**Example 1**).
2. **Big Commercial Jets (`737`, `A320`, `A380`) Do Not Work:** Jet airliners produce a loud roar across all frequencies rather than a single steady musical note, and pilots constantly change engine power during climb and landing. This method only works on **propeller planes, turboprops, and helicopters** whose spinning blades produce a steady hum.
3. **Needs Daytime & an Outdoor Microphone:** Small propeller planes mostly fly during the day in clear weather and stay away from major commercial airports. Leaving a microphone running indoors or overnight in a city usually catches nothing because very few small prop planes fly at night, and windows plus indoor fan/AC hum drown out distant propeller sound.

## Under the Hood

### 1. Detecting the Plane's Pitch Drop (`public/lib/spectro.js`, `public/lib/media.js`)

1. **Audio Filtering & Spectrogram:** Audio is downsampled to $4000\text{ Hz}$ and converted into a spectrogram covering $80\text{ to }700\text{ Hz}$ (the pitch range of propeller and helicopter blades) at 4 frames per second.
2. **Background Noise Removal:** Steady background hum (fans, electrical buzz) and brief clicks or bird chirps are filtered out so the smooth pitch curve of the propeller blades stands out.
3. **Curve Fitting:** A tracker traces each plane pass on the spectrogram and fits the Doppler pitch formula (`fitLine` / `nelderMead` in `public/lib/physics.js`):
   $$f(t) = \frac{f_0}{1 + \frac{v}{c} \cdot \frac{v(t - t_c)}{\sqrt{d^2 + v^2(t - t_c)^2}}}, \quad c = 340\text{ m/s}$$
   estimating the engine's base pitch $f_0$, plane speed $v$, closest distance $d$, and closest-pass time $t_c$.

### 2. Fast Worldwide Flight Search (`public/lib/search.js`, `public/lib/data.js`, `scripts/search_kernel.rs`)

* **Live 60-Minute Worldwide Feed (`/api/live` + `LiveTrackerDO`):** A Cloudflare Durable Object (`LiveTrackerDO` in `worker/index.js`) polls live worldwide propeller and helicopter traffic from [adsb.lol](https://adsb.lol) every 20 seconds (`public/prop-types.json`, 2,302 aircraft type codes) and keeps a rolling 60-minute flight history.
* **Historical Flight Shards (`data/spd/{day}.bin`, `data/day/{day}.bin`):** Pre-indexed flight data grouped by time and speed so the browser only downloads the matching slices.
* **Zero-Copy Rust WebAssembly Kernel (`public/lib/search_kernel.wasm`):** Flight samples are placed directly into WebAssembly memory so candidate lookup, multi-plane path crossing, and initial scoring run in milliseconds inside the browser.

### 3. 3D Sound-Delay Verification (`public/lib/solver.js`, `public/lib/physics.js`)

* **Smooth 3D Flight Paths (`buildTrack`):** Raw GPS points from flight trackers are smoothed into continuous 3D paths with position and velocity.
* **Sound Travel-Time Check (`retardedK` & `nelderMead`):** Sound takes roughly 3 seconds to travel 1 kilometer. For each candidate spot on the map, the solver accounts for the exact time sound took to travel from the moving plane to the microphone and refines the microphone's latitude, longitude, and clock offset.

## Quick Start & Commands

Requires **Node.js 22+**. No external databases, API keys, or hardcoded domains are required.

```bash
# Install dependencies
npm install

# Run the test suite (detector, end-to-end examples, and 20-spot benchmark)
npm test

# Start the local dev server (http://localhost:8787)
npm run dev
```

### All `npm` Scripts

| Command | Description |
| :--- | :--- |
| `npm run dev` | Start local Cloudflare Worker + `LiveTrackerDO` dev server (`http://localhost:8787`) |
| `npm test` | Run all three test suites (`test:detector`, `test:e2e`, `test:batch`) |
| `npm run update:data` | Refresh `public/prop-types.json` and rebuild the bundled `2025-07-18` example index |
| `npm run update:types` | Fetch latest propeller/turboprop/helicopter aircraft type codes (`scripts/prop-types.mjs`) |
| `npm run update:example` | Rebuild `public/examples/2025-07-18/data` from `test/fixtures/kampina-slice.json` |
| `npm run index:day -- YYYY-MM-DD` | Stream an `adsb.lol` daily flight archive tarball from `stdin` into `public/data/` |
| `npm run build:wasm` | Recompile `scripts/search_kernel.rs` to `public/lib/search_kernel.wasm` (`wasm32-unknown-unknown`) |
| `npm run deploy` | Deploy Worker and static assets to Cloudflare (`*.workers.dev` by default, or custom domain if `CF_DOMAIN` is set) |

### Deploying Your Own Instance (Zero Hardcode)

`wrangler.jsonc`, `cloudflare.config.ts`, and `worker/index.js` contain **no hardcoded domains, account IDs, or keys**:

1. **Deploy to `*.workers.dev`:**
   ```bash
   npx wrangler login
   npm run deploy
   ```
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
| `public/index.html` | Single-page web app with 3-step guide, audio source cards, spectrogram, and map |
| `public/app.js` | UI controller, spectrogram renderer, map markers, live recording loop, and clip trimmer |
| `public/analyze.worker.js` | Web Worker that runs audio analysis in the background |
| `public/lib/spectro.js` | Spectrogram builder, noise removal, and pitch-track extractor |
| `public/lib/physics.js` | 3D flight path interpolation (`buildTrack`), sound-delay Doppler math (`retardedK`), and optimizer (`nelderMead`) |
| `public/lib/solver.js` | Multi-plane location solver and sound-delay verification |
| `public/lib/search.js` | Worldwide flight index loader (`SpeedStore`), WebAssembly search bridge, and candidate ranking |
| `public/lib/search_kernel.wasm` | Precompiled Rust WebAssembly kernel for fast flight lookup and multi-plane path crossing |
| `public/lib/data.js` | Compressed flight shard loader (`loadHistory`) and live flight feed client (`LiveFeed`) |
| `public/lib/media.js` | Browser audio/video decoding, microphone recording, and `.wav` export |
| `public/lib/geo.js` | Map coordinate and distance helpers |
| `public/lib/sim.js` | Synthetic propeller sound generator for testing |
| `public/prop-types.json` | 2,302 propeller, turboprop, and helicopter aircraft type codes |
| `public/examples/2025-07-18/` | Bundled example audio clips (`two-planes-sim.mp3`, `kampina-klankbeeld.mp3`) and 12-minute worldwide flight slice |
| `worker/index.js` | Cloudflare Worker + `LiveTrackerDO` Durable Object maintaining the live 60-minute worldwide flight feed (`/api/live`) |
| `scripts/build-index.mjs` | Builds indexed flight shards from `adsb.lol` archives |
| `scripts/build-example.mjs` | Builds the bundled example flight index under `public/examples/2025-07-18/data` |
| `scripts/prop-types.mjs` | Regenerates `public/prop-types.json` from `tar1090-db` aircraft definitions |
| `scripts/search_kernel.rs` | Rust source for `public/lib/search_kernel.wasm` |
| `test/detector.mjs` | Spectrogram and plane-pass detector test on 20 simulated 2-plane recordings |
| `test/e2e.mjs` | End-to-end location test on the bundled simulated and real Kampina recordings |
| `test/batch.mjs` | End-to-end accuracy benchmark across 20 simulated 2-plane spots against worldwide flights |

## Credits & Data Licenses

* **ADS-B Flight Data:** [adsb.lol](https://adsb.lol) (Open Database License / ODbL).
* **Example Field Recording:** *"prop plane birds fens Kampina Netherlands 1140 am 250718_1173"* by [klankbeeld](https://freesound.org/people/klankbeeld/sounds/858688/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
* **Map Tiles:** [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors and AWS Terrain Tiles.
* **Code License:** [MIT](./LICENSE).
