import { decodeFile, Recorder, wav } from './lib/media.js';
import { FS } from './lib/spectro.js';
import { search } from './lib/search.js';

const $ = (id) => document.getElementById(id);
const status = (s) => ($('status').textContent = s);
// Progress lives in its own line so the last result stays readable while work runs.
// Row keeps its height (no layout shift) and only shows after 400 ms, so quick live updates never blink.
let busyT = 0;
const busy = (s) => {
  clearTimeout(busyT);
  if (!s) return $('busy').classList.remove('on');
  $('busyMsg').textContent = s;
  busyT = setTimeout(() => $('busy').classList.add('on'), 400);
};

// Analysis runs off the main thread.
const worker = new Worker('./analyze.worker.js', { type: 'module' });
let seq = 0;
const pending = new Map();
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  pending.delete(data.id);
  data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
};
const call = (type, payload, transfer = []) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  worker.postMessage({ id, type, payload }, transfer);
});

const map = L.map('map').setView([30, 0], 2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap' }).addTo(map);
const layer = L.layerGroup().addTo(map), truthLayer = L.layerGroup().addTo(map);
function drawSpectrogram(a) {
  const c = $('spec');
  if (!a.F) return;
  [c.width, c.height] = [a.F, a.B];
  const ctx = c.getContext('2d'), im = ctx.createImageData(a.F, a.B);
  for (let f = 0; f < a.F; f++)
    for (let b = 0; b < a.B; b++) {
      const v = a.img[f * a.B + b], o = 4 * ((a.B - 1 - b) * a.F + f);
      [im.data[o], im.data[o + 1], im.data[o + 2], im.data[o + 3]] = [v, v, v, 255];
    }
  ctx.putImageData(im, 0, 0);
  ctx.strokeStyle = '#ff6b2c';
  ctx.lineWidth = 1;
  for (const e of a.events) {
    ctx.beginPath();
    e.curve.forEach(([t, fq], i) => ctx[i ? 'lineTo' : 'moveTo']((t - a.t0) / a.dt, a.B - 1 - (fq / a.df - a.b0)));
    ctx.stroke();
  }
}

// Recording: the visitor's own clock. Otherwise the place is unknown, so its local time is too: say UTC.
const fmt = (t) =>
  src === 'rec'
    ? new Date(t * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : new Date(t * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
const TYPES = {
  C150: 'Cessna 150', C152: 'Cessna 152', C172: 'Cessna 172', C182: 'Cessna 182', C206: 'Cessna 206', C208: 'Cessna Caravan', C210: 'Cessna 210',
  P28A: 'Piper Cherokee', P28R: 'Piper Arrow', P28B: 'Piper Dakota', PA38: 'Piper Tomahawk', PA18: 'Piper Super Cub', PA24: 'Piper Comanche', PA32: 'Piper Saratoga', PA34: 'Piper Seneca', PA44: 'Piper Seminole', PA46: 'Piper Malibu', P208: 'Tecnam P2008',
  SR20: 'Cirrus SR20', SR22: 'Cirrus SR22', DA20: 'Diamond DA20', DA40: 'Diamond DA40', DA42: 'Diamond DA42', DR40: 'Robin DR400', BE35: 'Beech Bonanza', BE36: 'Beech Bonanza', BE58: 'Beech Baron', M20P: 'Mooney M20',
  CRUZ: 'CZAW SportCruiser', SLG4: 'Super Legend', NG5: 'Tecnam Autogyro', AS32: 'Super Puma helicopter', A109: 'AW109 helicopter', A169: 'AW169 helicopter', A139: 'AW139 helicopter', EC35: 'H135 helicopter', EC45: 'H145 helicopter',
  R22: 'Robinson R22 helicopter', R44: 'Robinson R44 helicopter', R66: 'Robinson R66 helicopter', AS50: 'Squirrel helicopter', WASP: 'Westland Wasp helicopter', PIVI: 'Pipistrel Virus', DHC2: 'Beaver floatplane', DHC6: 'Twin Otter',
};
const label = (m) => [TYPES[m.type] ?? m.type, m.reg ?? m.flight ?? m.hex].filter(Boolean).join(' ');
// q = average pitch mismatch between the audio and what these planes would have sounded like from the spot.
const strength = (r, best) => {
  if (r.q == null) return 'Possible';
  if (r === best) return r.q < OK_Q / 2 ? 'Strong match' : r.q < OK_Q ? 'Good match' : 'Weak match';
  const x = r.q / best.q;
  return x < 1.5 ? 'Almost as good as #1' : `${Math.round(x)}x worse than #1`;
};
const OK_Q = 0.008, SHOW = 5;
let showAll = false;
const pad = (n) => String(n).padStart(2, '0');
const hms = (t) => `${pad(Math.floor(t / 3600))}:${pad(Math.floor(t / 60) % 60)}:${pad(Math.floor(t % 60))}`;
const when = (d) => (src === 'rec' ? new Date(d.at * 1000).toLocaleTimeString([], { hour12: false }) : hms(d.at));

// Passes found this session. `at` is epoch seconds for a recording, seconds into the clip for a file.
// cands: null = flight search pending, [] = no match, else solver results best first.
let dets = [], src = null, sel = null, pinned = false, player = null;
function reset(kind, base = '') {
  [dets, src, sel, pinned, searched, dataBase, onSearched] = [[], kind, null, false, '', base, null];
  showAll = false;
  layer.clearLayers();
  truthLayer.clearLayers();
  renderDets();
}

// Overlapping live windows see the same pass again; keep one entry and take the newer fit.
function merge(events, origin) {
  for (const e of events) {
    const at = origin + e.tc, d = dets.find((d) => Math.abs(d.at - at) < 4 && Math.abs(d.v - e.v) < 0.25 * d.v);
    const pts = e.pts.map(([t, f]) => [origin + t, f]);
    if (d) Object.assign(d, { at, v: e.v, d: e.d, pts });
    else dets.push({ id: dets.length + 1, at, v: e.v, d: e.d, pts, cands: null });
  }
  dets.sort((p, q) => p.at - q.at);
}

function drawCands(d) {
  layer.clearLayers();
  if (!d.cands?.length) return;
  if (d.kind === 'shortlist') {
    for (const r of d.cands) L.circleMarker([r.lat, r.lon], { radius: 3, color: '#d9480f', weight: 1, fillOpacity: 0.6 }).addTo(layer).bindTooltip(r.flights.map(label).join(' + '));
    return map.fitBounds(L.latLngBounds(d.cands.map((r) => [r.lat, r.lon])), { padding: [20, 20] });
  }
  const best = d.cands[0].q;
  d.cands.forEach((r, i) => {
    const conf = Math.max(0.15, Math.min(1, best / r.q));
    L.polygon(r.hull, { color: i ? '#888' : '#d9480f', weight: i ? 1 : 2, fillOpacity: 0.25 * conf }).addTo(layer).bindTooltip(`#${i + 1}`);
  });
  map.fitBounds(L.latLngBounds(d.cands.slice(0, 5).flatMap((r) => r.hull)), { maxZoom: 14, padding: [30, 30] });
}

function pick(d, byUser) {
  [sel, pinned] = [d.id, pinned || byUser];
  if (byUser && src === 'file' && player) player.currentTime = d.at;
  drawCands(d);
  renderDets();
}

function summary(d) {
  if (d.cands == null) return 'searching flights...';
  if (!d.cands.length) return 'no matching flight';
  if (d.kind === 'shortlist') return `${d.cands.length} planes worldwide could have made this. A 2nd plane pins it down`;
  const r = d.cands[0], more = d.cands.length - 1;
  return `Best guess: near ${r.lat.toFixed(3)}, ${r.lon.toFixed(3)} on ${fmt(r.start)}${more ? `, ${more} other possibilit${more > 1 ? 'ies' : 'y'}` : ''}`;
}

function renderDets() {
  $('dets').hidden = !dets.length;
  const ol = $('detList');
  ol.replaceChildren(...[...dets].reverse().map((d) => {
    const li = document.createElement('li');
    li.className = d.id === sel ? 'open' : '';
    const head = document.createElement('button');
    head.className = 'det';
    head.innerHTML = `<time></time><span class="mute"></span><span class="sum"></span>`;
    head.children[0].textContent = when(d);
    head.children[1].textContent = `plane at ${Math.round(d.v * 3.6)} km/h, ${Math.round(d.d)} m away at closest`;
    head.children[2].textContent = summary(d);
    head.onclick = () => pick(d, true);
    li.append(head);
    if (d.id === sel && d.cands?.length) {
      const sub = document.createElement('ol'), best = d.cands[0];
      const note = document.createElement('p');
      note.className = 'mute small';
      note.textContent =
        d.kind === 'shortlist'
          ? 'Every plane below was flying at this speed and height at this moment. With one plane, they all fit equally well.'
          : 'Ranked by how closely the rise and fall of the engine pitch in the audio matches what these planes would have sounded like from that spot.';
      const list = showAll ? d.cands : d.cands.slice(0, SHOW);
      list.forEach((r, i) => {
        const c = document.createElement('li');
        c.innerHTML = '<b></b> <span></span><br><span class="mute"></span>';
        c.children[0].textContent = `#${i + 1} ${strength(r, best)}`;
        c.children[1].textContent = `near ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}, ${fmt(r.start)}`;
        c.children[3].textContent = `${r.flights.length > 1 ? 'Planes' : 'Plane'}: ${r.flights.map(label).join(', ')}${r.unheard ? `. Less likely: ${r.unheard} other plane${r.unheard > 1 ? 's' : ''} flew close here and should have been heard` : ''}`;
        c.onclick = () => map.fitBounds(r.hull, { maxZoom: 15 });
        sub.append(c);
      });
      li.append(note, sub);
      if (d.cands.length > SHOW) {
        const b = document.createElement('button');
        b.className = 'link';
        b.textContent = showAll ? 'Show fewer' : `Show ${d.cands.length - SHOW} more`;
        b.onclick = () => ((showAll = !showAll), renderDets());
        li.append(b);
      }
    }
    return li;
  }));
}

async function locate(samples, origin) {
  busy('Looking for Doppler curves');
  const a = await call('analyze', { samples }, [samples.buffer]).finally(() => busy(''));
  drawSpectrogram(a);
  merge(a.events, origin);
  const latest = dets[dets.length - 1];
  if (latest && !pinned) pick(latest, false);
  else renderDets();
  if (!dets.length) return status('N/A: no aircraft Doppler pass found in this audio. Needs a propeller plane audibly flying past.');
  await where();
}

// Search the flight index with every pass so far. Recording: start time is known (clock). File: any indexed time.
let dataBase = '', searched = '', recStart = null;
async function where() {
  const sig = dets.map((d) => `${d.at.toFixed(0)}:${d.v.toFixed(0)}`).join();
  if (sig === searched) return;
  searched = sig;
  const S = src === 'rec' ? recStart : 0, evs = dets.map((d) => ({ v: d.v, d: d.d, tc: d.at - S, pts: d.pts.map(([t, f]) => [t - S, f]) }));
  status(`${dets.length} pass(es) detected. Searching flights...`);
  busy(src === 'rec' ? 'Searching flights at this moment worldwide' : 'Searching every indexed flight worldwide');
  let r;
  try {
    r = await search(evs, { s0: src === 'rec' ? S - 2 : null, s1: src === 'rec' ? S + 2 : null, base: dataBase, onProgress: (p) => busy(`Searching ${src === 'rec' ? 'flights at this moment' : 'every indexed flight'} worldwide, ${Math.round(p * 100)}%`) });
  } finally {
    busy('');
  }
  if (sig !== searched) return; // newer passes arrived meanwhile
  for (const d of dets) [d.cands, d.kind] = [[], r.kind];
  if (r.kind === 'shortlist') dets[0].cands = r.results;
  else for (const d of dets) d.cands = r.results;
  const msg = {
    located: `Located from ${r.used} planes. Best spot fits ${r.results.length > 1 ? `${(r.results[1].q / r.results[0].q).toFixed(1)}x better than the next` : 'alone'}.`,
    unsure: `${dets.length} passes, but no spot fits all of them well. Showing the closest fits.`,
    shortlist: `One plane: ${r.planes} flights worldwide could have made it. Keep recording until a 2nd plane passes.`,
    none: 'No indexed flight matches. The plane may not carry ADS-B, or that day is not indexed.',
  }[r.kind];
  status(msg);
  const d = dets.find((x) => x.id === sel) ?? dets.at(-1);
  if (d) pick(d, false);
  onSearched?.(r);
}
let onSearched = null;

// Live mic: re-analyze the last 5 minutes every few seconds while recording; Stop just stops.
const WINDOW_S = 300, EVERY_MS = 4000;
let rec = null, tick = null, running = false;

async function update() {
  if (!rec || running || rec.seconds < 10) return;
  running = true;
  const r = rec, { x, offset } = r.samples(WINDOW_S);
  try {
    recStart = r.t0;
    await locate(x, r.t0 + offset);
  } catch (e) {
    status(e.message);
  } finally {
    running = false;
  }
}

// Saves the last 5 min (what the detector saw, at FS) to a local file. Nothing is uploaded.
let saved = null;
$('save').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(wav(saved.samples().x));
  a.download = `recording-${new Date(saved.t0 * 1000).toISOString().slice(0, 19).replace(/:/g, '-')}Z.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('rec').onclick = async () => {
  if (rec) {
    clearInterval(tick);
    const r = rec;
    rec = null;
    $('rec').textContent = 'Start recording';
    $('recT').textContent = `stopped at ${r.seconds.toFixed(0)} s`;
    saved = r;
    $('save').hidden = false;
    return r.stop();
  }
  $('save').hidden = true;
  rec = new Recorder();
  try {
    await rec.start();
  } catch (e) {
    rec = null;
    return status(`Mic: ${e.message}`);
  }
  $('rec').textContent = 'Stop';
  reset('rec');
  status('Listening. Results update as planes pass.');
  let last = 0;
  tick = setInterval(() => {
    $('recT').textContent = `${rec.seconds.toFixed(0)} s`;
    if (Date.now() - last >= EVERY_MS) [(last = Date.now()), update()];
  }, 500);
};

// Upload: analyze only the chosen part of the clip; time of day is unknown, so search all indexed days.
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const parseClock = (v) => (v.trim() === '' ? NaN : v.split(':').reduce((acc, p) => acc * 60 + Number(p), 0));
const preview = $('preview');
$('file').onchange = () => {
  const f = $('file').files[0];
  $('run').disabled = !f;
  if (preview.src) URL.revokeObjectURL(preview.src);
  preview.hidden = $('range').hidden = !f;
  if (!f) return;
  preview.src = URL.createObjectURL(f);
  preview.onloadedmetadata = () => [($('from').value = '0:00'), ($('to').value = clock(preview.duration)), showLen()];
};
const showLen = () => {
  const a = parseClock($('from').value), b = parseClock($('to').value);
  $('len').textContent = b > a ? `${Math.round(b - a)} s` : '';
};
$('setFrom').onclick = () => [($('from').value = clock(preview.currentTime)), showLen()];
$('setTo').onclick = () => [($('to').value = clock(preview.currentTime)), showLen()];
$('from').oninput = $('to').oninput = showLen;
$('run').onclick = async () => {
  const f = $('file').files[0], a = parseClock($('from').value), b = parseClock($('to').value);
  if (!(a >= 0) || !(b > a)) return status('Range must be like 0:05 to 1:00, end after start.');
  if (b - a < 20) return status('Pick at least 20 s: the plane must be heard approaching and leaving.');
  $('run').disabled = true;
  try {
    busy('Decoding');
    const x = await decodeFile(f);
    reset('file');
    player = preview;
    await locate(x.slice(Math.round(a * FS), Math.round(Math.min(b, x.length / FS) * FS)), a);
  } catch (e) {
    status(e.message);
  } finally {
    busy('');
    $('run').disabled = false;
  }
};

// Examples: bundled audio + a 12 minute worldwide slice of the index, searched exactly like an upload.
const EX_BASE = './examples/2025-07-18';
const EX = {
  two: { truth: [52.008, -0.513], regs: ['G-GFIG', 'G-RIMM'], what: 'a field near Cranfield, England. Cessna 152 G-GFIG and Westland Wasp G-RIMM, 18 Jul 2025 10:40:27 BST' },
  kampina: { truth: [51.578671, 5.257332], regs: ['PH-TRG'], what: "the recordist's map pin on Kampina heath, Netherlands. Cessna 172 PH-TRG, 18 Jul 2025 11:40 CEST", pin: true },
};
for (const id of Object.keys(EX))
  $(`ex-${id}`).onclick = async () => {
    const ex = EX[id], btn = $(`ex-${id}`), ans = $(`ans-${id}`);
    btn.disabled = true;
    ans.hidden = true;
    try {
      busy('Decoding');
      const x = await decodeFile(await (await fetch($(`exa-${id}`).src)).blob());
      reset('file', EX_BASE);
      player = $(`exa-${id}`);
      onSearched = (r) => {
        L.circleMarker(ex.truth, { radius: 7, color: '#2b8a3e', weight: 3, fillOpacity: 0 }).addTo(truthLayer).bindTooltip('Answer', { permanent: true, direction: 'right' });
        const top = r.results[0], km = top && L.latLng(top.lat, top.lon).distanceTo(ex.truth) / 1000;
        const inList = r.results.some((q) => q.flights.some((f) => ex.regs.includes(f.reg)));
        ans.textContent = `Answer: ${ex.what}. ` + (r.kind === 'located' ? `Best spot is ${km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`} from it.` : r.kind === 'shortlist' ? `${ex.regs[0]} is ${inList ? '' : 'not '}in the ${r.results.length}-plane shortlist.` : 'Not located.');
        ans.hidden = false;
        if (r.kind !== 'located') map.setView(ex.truth, 9);
      };
      await locate(x, 0);
    } catch (e) {
      status(e.message);
    } finally {
      busy('');
      btn.disabled = false;
    }
  };
