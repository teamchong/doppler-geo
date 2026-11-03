import { decodeFile, Recorder, wav } from './lib/media.js';
import { FS } from './lib/spectro.js';
import { search } from './lib/search.js';
import { liveFeed } from './lib/data.js';

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
const call = (type, payload, transfer = []) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload }, transfer);
  });

const map = L.map('map', { preferCanvas: true }).setView([20, 0], 2);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '&copy; OpenStreetMap',
}).addTo(map);
const layer = L.layerGroup().addTo(map),
  truthLayer = L.layerGroup().addTo(map);

$('mapThemeBtn')?.addEventListener('click', () => {
  const dark = $('map').classList.toggle('radar-tiles');
  $('mapThemeBtn').textContent = dark ? 'Map: Dark' : 'Map: Light';
});

// Acoustic Inferno-inspired 256-entry RGB lookup table
const LUT = new Uint8Array(256 * 3);
for (let i = 0; i < 256; i++) {
  const t = i / 255;
  LUT[i * 3] = Math.min(255, Math.round(5 + 250 * Math.pow(t, 1.15)));
  LUT[i * 3 + 1] = Math.min(255, Math.round(8 + 230 * Math.pow(t, 2.2)));
  LUT[i * 3 + 2] = Math.min(255, Math.round(15 + 140 * Math.sin(Math.min(1, t * 1.35) * Math.PI) + 90 * Math.pow(t, 3.5)));
}

let specState = null,
  specHoverPt = null;

function sizeSpecCanvas(c) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(320, Math.floor((c.clientWidth || 520) * dpr));
  const h = Math.max(200, Math.floor((c.clientHeight || 255) * dpr));
  if (c.width !== w || c.height !== h) [c.width, c.height] = [w, h];
  return { w, h, dpr };
}

function drawDemoSpectrogram() {
  const c = $('spec');
  if (!c || specState) return;
  const { w, h, dpr } = sizeSpecCanvas(c);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#05080f';
  ctx.fillRect(0, 0, w, h);

  // Subtle frequency grid
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.09)';
  ctx.lineWidth = 1;
  ctx.font = `${Math.round(10 * dpr)}px ui-monospace, monospace`;
  ctx.fillStyle = '#576782';
  for (const hz of [150, 300, 450, 600]) {
    const y = h - ((hz - 80) / 620) * h;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.fillText(`${hz} Hz`, 8 * dpr, y - 4 * dpr);
  }

  // Simulated harmonic S-curves illustrating Doppler shift
  const tc = 0.5, f0 = 135, v = 55, d = 240, dur = 50;
  for (const [mult, alpha, col] of [[1, 0.95, '#f59e0b'], [2, 0.85, '#38bdf8'], [3, 0.55, '#38bdf8'], [4, 0.3, '#38bdf8']]) {
    ctx.save();
    ctx.strokeStyle = col;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = (mult === 2 ? 2.4 : 1.6) * dpr;
    ctx.beginPath();
    for (let px = 0; px <= w; px += 2) {
      const u = (px / w - tc) * dur;
      const vr = (v * u) / Math.hypot(d, v * u);
      const hz = mult * f0 * (1 - vr / 340);
      const y = h - ((hz - 80) / 620) * h;
      px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Inflection point marker at (tc, 2*f0)
  const cx = w * tc, cy = h - ((2 * f0 - 80) / 620) * h;
  ctx.strokeStyle = 'rgba(34, 197, 94, 0.45)';
  ctx.setLineDash([4 * dpr, 4 * dpr]);
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, h);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#22c55e';
  ctx.beginPath();
  ctx.arc(cx, cy, 4.5 * dpr, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#e6edf7';
  ctx.font = `600 ${Math.round(11 * dpr)}px ui-monospace, monospace`;
  ctx.fillText('Closest overhead pass (steepest pitch drop gives speed & distance)', cx + 8 * dpr, cy - 8 * dpr);
  ctx.fillStyle = '#8b9bb4';
  ctx.font = `${Math.round(10.5 * dpr)}px ui-monospace, monospace`;
  ctx.fillText('Approaching plane (higher pitch)', 48 * dpr, cy - 30 * dpr);
  ctx.fillText('Receding plane (lower pitch)', w - 185 * dpr, cy + 32 * dpr);
}

function renderSpectrogramFrame() {
  const c = $('spec');
  if (!c) return;
  if (!specState) return drawDemoSpectrogram();
  const { a, off } = specState;
  const { w, h, dpr } = sizeSpecCanvas(c);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, w, h);

  const dur = a.F * a.dt;
  const hzMin = a.b0 * a.df, hzSpan = a.B * a.df;

  // Subtle frequency & time grid
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fillStyle = 'rgba(230, 237, 247, 0.65)';
  ctx.lineWidth = 1;
  ctx.font = `${Math.round(10 * dpr)}px ui-monospace, monospace`;
  for (const hz of [100, 200, 300, 400, 500, 600]) {
    if (hz <= hzMin || hz >= hzMin + hzSpan) continue;
    const y = h - ((hz - hzMin) / hzSpan) * h;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.fillText(`${hz} Hz`, 6 * dpr, y - 3 * dpr);
  }

  // Fitted Doppler curves
  a.events.forEach((e, idx) => {
    ctx.save();
    ctx.strokeStyle = idx === 0 ? '#38bdf8' : '#22c55e';
    ctx.lineWidth = 2.2 * dpr;
    ctx.shadowColor = idx === 0 ? '#38bdf8' : '#22c55e';
    ctx.shadowBlur = 6 * dpr;
    ctx.beginPath();
    e.curve.forEach(([t, fq], i) => {
      const x = ((t - a.t0) / dur) * w;
      const y = h - ((fq - hzMin) / hzSpan) * h;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    ctx.restore();

    // Pass callout badge at (tc, f0)
    const cx = ((e.tc - a.t0) / dur) * w;
    const cy = Math.max(18 * dpr, Math.min(h - 14 * dpr, h - ((e.f0 - hzMin) / hzSpan) * h));
    ctx.fillStyle = idx === 0 ? '#38bdf8' : '#22c55e';
    ctx.beginPath();
    ctx.arc(cx, cy, 3.8 * dpr, 0, Math.PI * 2);
    ctx.fill();

    const lbl = `#${idx + 1} ${Math.round(e.f0)}Hz · ${Math.round(e.v * 3.6)}km/h · ${Math.round(e.d)}m`;
    ctx.font = `600 ${Math.round(10.5 * dpr)}px ui-monospace, monospace`;
    const tw = ctx.measureText(lbl).width;
    const bx = Math.min(w - tw - 14 * dpr, Math.max(6 * dpr, cx + 6 * dpr));
    const by = Math.max(14 * dpr, cy - 8 * dpr);
    ctx.fillStyle = 'rgba(7, 11, 18, 0.86)';
    ctx.fillRect(bx - 4 * dpr, by - 11 * dpr, tw + 8 * dpr, 15 * dpr);
    ctx.fillStyle = idx === 0 ? '#38bdf8' : '#22c55e';
    ctx.fillText(lbl, bx, by);
  });

  // Playhead line if audio player is active within window
  if (player && src !== 'rec' && Number.isFinite(player.currentTime)) {
    const relT = player.currentTime - (src === 'file' ? clipOffset : 0);
    if (relT >= 0 && relT <= dur) {
      const px = (relT / dur) * w;
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 1.8 * dpr;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
    }
  }

  // Hover crosshair
  if (specHoverPt) {
    const { fx, fy } = specHoverPt;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.moveTo(fx * w, 0);
    ctx.lineTo(fx * w, h);
    ctx.moveTo(0, fy * h);
    ctx.lineTo(w, fy * h);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawSpectrogram(a) {
  if (!a.F) return;
  const off = document.createElement('canvas');
  [off.width, off.height] = [a.F, a.B];
  const octx = off.getContext('2d'),
    im = octx.createImageData(a.F, a.B);
  for (let f = 0; f < a.F; f++)
    for (let b = 0; b < a.B; b++) {
      const v = a.img[f * a.B + b],
        o = 4 * ((a.B - 1 - b) * a.F + f);
      im.data[o] = LUT[v * 3];
      im.data[o + 1] = LUT[v * 3 + 1];
      im.data[o + 2] = LUT[v * 3 + 2];
      im.data[o + 3] = 255;
    }
  octx.putImageData(im, 0, 0);
  specState = { a, off };
  const durS = Math.round(a.F * a.dt);
  $('specDur').textContent = `Window ${Math.floor(durS / 60)}:${String(durS % 60).padStart(2, '0')} · Click to seek`;
  $('specPassCount').textContent = `${a.events.length} Doppler pass${a.events.length === 1 ? '' : 'es'} fitted`;
  renderSpectrogramFrame();
}

$('spec').addEventListener('mousemove', (ev) => {
  const c = $('spec'),
    rect = c.getBoundingClientRect();
  const fx = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width)));
  const fy = Math.max(0, Math.min(1, (ev.clientY - rect.top) / Math.max(1, rect.height)));
  specHoverPt = { fx, fy };
  if (specState) {
    const { a } = specState;
    const t = (src === 'file' ? clipOffset : 0) + fx * a.F * a.dt;
    const hz = Math.round(a.b0 * a.df + (1 - fy) * a.B * a.df);
    $('specHover').textContent = `t = ${hms(t)} · f = ${hz} Hz`;
  }
  renderSpectrogramFrame();
});
$('spec').addEventListener('mouseleave', () => {
  specHoverPt = null;
  $('specHover').textContent = 'Hover for time and frequency · Cyan curve shows fitted Doppler pass';
  renderSpectrogramFrame();
});
$('spec').addEventListener('click', (ev) => {
  if (!player || !specState) return;
  const rect = $('spec').getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width)));
  player.currentTime = (src === 'file' ? clipOffset : 0) + frac * specState.a.F * specState.a.dt;
  player.play?.().catch(() => {});
  renderSpectrogramFrame();
});
window.addEventListener('resize', () => renderSpectrogramFrame());
setInterval(() => {
  if (player && !player.paused && specState) renderSpectrogramFrame();
}, 80);
drawDemoSpectrogram();

// Recording: the visitor's own clock. Otherwise the place is unknown, so its local time is too: say UTC.
const fmt = (t) =>
  src === 'rec'
    ? new Date(t * 1000).toLocaleTimeString([], { timeStyle: 'medium' })
    : new Date(t * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';

const TYPES = {
  C150: 'Cessna 150', C152: 'Cessna 152', C172: 'Cessna 172', C182: 'Cessna 182', C206: 'Cessna 206', C208: 'Cessna Caravan', C210: 'Cessna 210',
  P28A: 'Piper Cherokee', P28R: 'Piper Arrow', P28B: 'Piper Dakota', PA38: 'Piper Tomahawk', PA18: 'Piper Super Cub', PA24: 'Piper Comanche', PA32: 'Piper Saratoga', PA34: 'Piper Seneca', PA44: 'Piper Seminole', PA46: 'Piper Malibu',
  P208: 'Tecnam P2008', SR20: 'Cirrus SR20', SR22: 'Cirrus SR22', DA20: 'Diamond DA20', DA40: 'Diamond DA40', DA42: 'Diamond DA42', DR40: 'Robin DR400',
  BE35: 'Beech Bonanza', BE36: 'Beech Bonanza', BE58: 'Beech Baron', M20P: 'Mooney M20', CRU2: 'CZAW SportCruiser', SLG4: 'Super Legend', NG5: 'Tecnam Autogyro',
  AS32: 'Super Puma helicopter', A109: 'AW109 helicopter', A169: 'AW169 helicopter', A139: 'AW139 helicopter', EC35: 'H135 helicopter', EC45: 'H145 helicopter',
  R22: 'Robinson R22 helicopter', R44: 'Robinson R44 helicopter', R66: 'Robinson R66 helicopter', AS50: 'Squirrel helicopter', WASP: 'Westland Wasp helicopter',
  PIVI: 'Pipistrel Virus', DHC2: 'Beaver floatplane', DHC6: 'Twin Otter',
};
const label = (m) => [TYPES[m.type] ?? m.type, m.reg ?? m.flight ?? m.hex].filter(Boolean).join(' · ');

// q = average pitch mismatch between the audio and what these planes would have sounded like from the spot.
const strength = (r, best) => {
  if (r.q == null) return 'Speed & climb match';
  if (r === best) return r.q < OK_Q / 2 ? 'Strong match' : r.q < OK_Q ? 'Good match' : 'Weak match';
  const x = r.q / best.q;
  return x < 1.5 ? 'Almost as good as #1' : `${Math.round(x)}x worse than #1`;
};
const OK_Q = 0.008, SHOW = 5;
let showAll = false;
const pad = (n) => String(n).padStart(2, '0');
const hms = (t) => `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(Math.floor(t % 60))}`;
const when = (d) => (src === 'rec' ? new Date(d.at * 1000).toLocaleTimeString([], { hour12: false }) : hms(d.at));

// Passes found this session. `at` is epoch seconds for a recording, seconds into the clip for a file.
// cands: null = flight search pending, [] = no match, else solver results best first.
let dets = [], src = null, sel = null, pinned = false, player = null, clipOffset = 0, activeSource = 'two', runGen = 0;

function updateTelemetry(d) {
  if (!d) {
    $('telF0').textContent = 'Awaiting pass';
    $('telV').textContent = 'Awaiting pass';
    $('telD').textContent = 'Awaiting pass';
    $('telFit').textContent = 'Idle';
    return;
  }
  $('telF0').textContent = d.f0 ? `${d.f0.toFixed(1)} Hz` : 'N/A';
  $('telV').textContent = `${Math.round(d.v * 3.6)} km/h (${d.v.toFixed(1)} m/s)`;
  $('telD').textContent = `${Math.round(d.d)} m`;
  if (d.cands == null) $('telFit').textContent = 'Searching...';
  else if (!d.cands.length) $('telFit').textContent = 'No match';
  else if (d.kind === 'shortlist') $('telFit').textContent = `${d.cands.length} shortlist`;
  else {
    const best = d.cands[0];
    $('telFit').textContent = `${(best.q * 100).toFixed(2)}% RMS (${dets.length} pass${dets.length === 1 ? '' : 'es'})`;
  }
}

// Highlight the active source card and reset all other panels (audio, mic recording, file input, answer banners).
function resetOtherPanels(targetSource) {
  activeSource = targetSource;
  for (const card of document.querySelectorAll('.source-card')) {
    card.classList.toggle('active-source', card.dataset.source === targetSource);
  }
  // Stop live microphone if switching away from rec
  if (targetSource !== 'rec') {
    if (rec) {
      clearInterval(tick);
      tick = null;
      const r = rec;
      rec = null;
      running = false;
      r.stop().catch(() => {});
    }
    $('rec').textContent = 'Start Recording';
    $('recT').textContent = '';
    $('save').hidden = true;
    saved = null;
  }
  // Reset example audio players & answer banners on inactive example cards
  for (const id of ['two', 'kampina']) {
    if (targetSource !== id) {
      const b = $(`ex-${id}`);
      if (b) b.disabled = false;
      const a = $(`exa-${id}`);
      if (a) {
        a.pause();
        a.currentTime = 0;
      }
      const ans = $(`ans-${id}`);
      if (ans) {
        ans.hidden = true;
        ans.textContent = '';
      }
    }
  }
  // Reset local file preview and range controls if switching away from file
  if (targetSource !== 'file') {
    const prev = $('preview');
    if (prev) {
      prev.pause();
      if (prev.src) URL.revokeObjectURL(prev.src);
      prev.removeAttribute('src');
      prev.hidden = true;
    }
    $('range').hidden = true;
    $('file').value = '';
    $('from').value = '0:00';
    $('to').value = '';
    $('len').textContent = '';
    $('run').disabled = true;
  }
}

function reset(kind, base = '', targetSource = kind) {
  runGen++;
  resetOtherPanels(targetSource);
  [dets, src, sel, pinned, searched, dataBase, onSearched] = [[], kind, null, false, '', base, null];
  clipOffset = 0;
  showAll = false;
  specState = null;
  specHoverPt = null;
  $('specDur').textContent = 'Click spectrogram to seek audio';
  $('specPassCount').textContent = 'Awaiting signal';
  drawDemoSpectrogram();
  layer.clearLayers();
  truthLayer.clearLayers();
  if (kind === 'rec' || kind === 'file') map.setView([20, 0], 2);
  updateTelemetry(null);
  renderDets();
}

// Overlapping live windows see the same pass again; keep one entry and take the newer fit.
function merge(events, origin) {
  for (const e of events) {
    const at = origin + e.tc,
      d = dets.find((d) => Math.abs(d.at - at) < 10 && Math.abs(d.v - e.v) < 0.25 * d.v);
    const pts = e.pts.map(([t, f]) => [origin + t, f]);
    if (d) Object.assign(d, { at, v: e.v, d: e.d, f0: e.f0, pts });
    else dets.push({ id: dets.length + 1, at, v: e.v, d: e.d, f0: e.f0, pts, cands: null });
  }
  dets.sort((p, q) => p.at - q.at);
}

function drawCands(d) {
  layer.clearLayers();
  if (!d?.cands?.length) return;
  if (d.kind === 'shortlist') {
    for (const r of d.cands)
      L.circleMarker([r.lat, r.lon], { radius: 3.5, color: '#38bdf8', weight: 1, fillOpacity: 0.7 })
        .addTo(layer)
        .bindTooltip(r.flights.map(label).join(' + '));
    return map.fitBounds(L.latLngBounds(d.cands.map((r) => [r.lat, r.lon])), { padding: [24, 24] });
  }
  const best = d.cands[0];
  // Draw ADS-B trajectories and CPA vectors for the top candidate
  if (best.paths?.length) {
    best.paths.forEach((p, idx) => {
      const trkColor = idx === 0 ? '#38bdf8' : '#a855f7';
      if (p.path?.length >= 2) {
        L.polyline(p.path, { color: trkColor, weight: 2.5, opacity: 0.85 })
          .addTo(layer)
          .bindTooltip(`ADS-B Track: ${label(p.flight)}`);
      }
      if (p.cpa) {
        L.polyline([p.cpa, [best.lat, best.lon]], { color: trkColor, weight: 1.5, dashArray: '4 5', opacity: 0.75 }).addTo(layer);
        L.circleMarker(p.cpa, { radius: 4, color: trkColor, weight: 1.5, fillOpacity: 0.9 })
          .addTo(layer)
          .bindTooltip(`Closest Approach (CPA): ${label(p.flight)}`);
      }
    });
  }
  d.cands.forEach((r, i) => {
    const conf = Math.max(0.15, Math.min(1, best.q / r.q)),
      color = i ? '#64748b' : '#f59e0b',
      tip = `#${i + 1}: ${r.flights.map(label).join(' + ')}`;
    L.polygon(r.hull, { color, weight: i ? 1 : 2, fillOpacity: 0.25 * conf })
      .addTo(layer)
      .bindTooltip(tip);
    L.circleMarker([r.lat, r.lon], { radius: i ? 5 : 7, color, weight: i ? 1.5 : 2, fillOpacity: 0.45 * conf })
      .addTo(layer)
      .bindTooltip(tip);
  });
  const boundsPts =
    d.kind === 'located'
      ? [...best.hull, ...(best.paths?.flatMap((p) => p.path ?? []) ?? [])]
      : [...d.cands.slice(0, 5).flatMap((r) => r.hull), ...(best.paths?.flatMap((p) => p.path ?? []) ?? [])];
  map.fitBounds(L.latLngBounds(boundsPts), { maxZoom: 13, padding: [32, 32] });
}

function pick(d, byUser) {
  [sel, pinned] = [d.id, pinned || byUser];
  if (byUser && src !== 'rec' && player) player.currentTime = d.at;
  updateTelemetry(d);
  drawCands(d);
  renderDets();
}

function summary(d) {
  if (d.cands == null) return 'searching flights...';
  if (!d.cands.length) return 'no matching flight';
  if (d.kind === 'shortlist') return `${d.cands.length} planes worldwide could have made this. A 2nd plane pins it down`;
  const r = d.cands[0],
    more = d.cands.length - 1;
  return `Best guess: near ${r.lat.toFixed(3)}, ${r.lon.toFixed(3)} on ${fmt(r.start)}${more ? `, ${more} other possibilit${more > 1 ? 'ies' : 'y'}` : ''}`;
}

function renderDets() {
  $('dets').hidden = !dets.length;
  const badge = $('detBadge');
  if (badge) {
    const d = dets.find((x) => x.id === sel) ?? dets.at(-1);
    badge.textContent = !d || d.cands == null ? 'Searching...' : d.kind === 'located' ? `Located (${d.cands.length})` : d.kind === 'shortlist' ? `${d.cands.length}-Plane Shortlist` : d.kind === 'unsure' ? 'Closest Fits' : 'No Match';
  }
  const ol = $('detList');
  ol.replaceChildren(
    ...[...dets].reverse().map((d) => {
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
        const sub = document.createElement('ol'),
          best = d.cands[0];
        const note = document.createElement('p');
        note.className = 'mute small';
        note.textContent =
          d.kind === 'shortlist'
            ? 'Every plane below was flying at this speed and height at this moment. With one plane, they all fit equally well.'
            : 'Ranked by how closely the rise and fall of the engine pitch in the audio matches what these planes would have sounded like from that spot.';
        const list = showAll ? d.cands : d.cands.slice(0, SHOW);
        list.forEach((r, i) => {
          const c = document.createElement('li');
          c.innerHTML = `<b></b> <span></span><br><span class="mute"></span>`;
          c.children[0].textContent = `#${i + 1} (${strength(r, best)})`;
          c.children[1].textContent = `near ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}, ${fmt(r.start)}`;
          c.children[3].textContent = `${r.flights.length > 1 ? 'Planes' : 'Plane'}: ${r.flights.map(label).join(', ')}${r.unheard ? `. Less likely: ${r.unheard} other plane${r.unheard > 1 ? 's' : ''} flew close here and should have been heard` : ''}`;
          c.onclick = () => map.fitBounds(L.latLngBounds([...r.hull, ...(r.paths?.flatMap((p) => p.path ?? []) ?? [])]), { maxZoom: 14, padding: [32, 32] });
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
    }),
  );
}

async function locate(samples, origin, myGen = runGen) {
  busy('Looking for Doppler curves');
  const a = await call('analyze', { samples }, [samples.buffer]).finally(() => {
    if (myGen === runGen) busy('');
  });
  if (myGen !== runGen) return;
  drawSpectrogram(a);
  merge(a.events, origin);
  const latest = dets[dets.length - 1];
  if (latest && !pinned) pick(latest, false);
  else renderDets();
  if (!dets.length) {
    return status(
      rec
        ? rec.seconds < 12
          ? `Live Mic (${rec.seconds.toFixed(0)}s) · Spectrogram active · Need ~15 to 30s of a propeller pass to fit S-curve...`
          : `Live checking (${rec.seconds.toFixed(0)}s analyzed) · 0 propeller passes so far · Keep recording while a prop plane or helicopter flies past.`
        : 'No aircraft Doppler pass found in this audio. Needs a propeller plane or helicopter audibly flying past (not a turbofan jet).',
    );
  }
  await where(myGen);
}

// Search the flight index with every pass so far. Recording: start time is known (clock). File: any indexed time.
let dataBase = '', searched = '', recStart = null;
async function where(myGen = runGen) {
  const sig = dets.map((d) => `${d.at.toFixed(1)}:${d.v.toFixed(1)}:${d.pts.length}`).join() + (src === 'rec' ? `:${Math.floor(liveFeed.now / 10)}` : '');
  if (sig === searched) return;
  searched = sig;
  const S = src === 'rec' ? recStart : 0,
    evs = dets.map((d) => ({ v: d.v, d: d.d, tc: d.at - S, pts: d.pts.map(([t, f]) => [t - S, f]) }));
  status(`${dets.length} pass(es) detected. Searching flights...`);
  busy(src === 'rec' ? 'Searching flights at this moment worldwide' : 'Searching every indexed flight worldwide');
  let r;
  try {
    r = await search(evs, {
      s0: src === 'rec' ? S - 2 : null,
      s1: src === 'rec' ? S + 2 : null,
      base: dataBase,
      onProgress: (p) => {
        if (myGen === runGen) busy(`Searching ${src === 'rec' ? 'flights at this moment' : 'every indexed flight'} worldwide (${Math.round(p * 100)}%)`);
      },
    });
  } finally {
    if (myGen === runGen) busy('');
  }
  if (myGen !== runGen || sig !== searched) return; // newer passes or source switch arrived meanwhile
  for (const d of dets) [d.cands, d.kind] = [r.results, r.kind];
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
const WINDOW_S = 300, EVERY_MS = 3000;
let rec = null, tick = null, running = false;
$('micGain')?.addEventListener('change', (ev) => {
  if (rec) rec.setGain(Number(ev.target.value) || 5);
});
async function update() {
  if (!rec || running || rec.seconds < 3) return;
  running = true;
  const r = rec, { x, offset } = r.samples(WINDOW_S), myGen = runGen;
  try {
    recStart = r.t0;
    await locate(x, r.t0 + offset, myGen);
  } catch (e) {
    if (myGen === runGen) status(e.message);
  } finally {
    running = false;
  }
}

// Saves the last 5 min (what the detector saw, at FS) to a local file. Nothing is uploaded.
let saved = null;
$('save').onclick = () => {
  if (!saved) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(wav(saved.samples().x));
  a.download = `recording-${new Date(saved.t0 * 1000).toISOString().slice(0, 19).replace(/:/g, '-') }Z.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('rec').onclick = async () => {
  if (rec) {
    clearInterval(tick);
    tick = null;
    const r = rec;
    rec = null;
    $('rec').textContent = 'Start Recording';
    $('recT').textContent = `stopped at ${r.seconds.toFixed(0)} s`;
    if (r.seconds > 0) {
      saved = r;
      $('save').hidden = false;
    }
    await r.stop();
    if (r.seconds >= 3 && !running) {
      const { x, offset } = r.samples(WINDOW_S), myGen = runGen;
      recStart = r.t0;
      await locate(x, r.t0 + offset, myGen).catch((e) => status(e.message));
    } else if (!dets.length && !running) {
      status('Recording stopped. Record at least 20 to 90 s while a propeller plane passes.');
    }
    return;
  }
  reset('rec', '', 'rec');
  $('save').hidden = true;
  const gain = Number($('micGain')?.value) || 5;
  rec = new Recorder(300, gain);
  try {
    await rec.start();
  } catch (e) {
    rec = null;
    return status(`Mic: ${e.message}`);
  }
  saved = rec;
  $('rec').textContent = 'Stop';
  status(`Listening (${gain}x mic boost). Live-checking every 3s as propeller planes pass...`);
  let last = 0, lastPoll = 0;
  liveFeed.poll().catch(() => {});
  tick = setInterval(() => {
    if (!rec) return;
    const lvl = Math.min(100, Math.round(Math.sqrt(rec.rms) * 180));
    $('recT').textContent = `${rec.seconds.toFixed(0)}s · lvl ${lvl}%`;
    if (rec.seconds >= 1) {
      saved = rec;
      $('save').hidden = false;
    }
    if (Date.now() - lastPoll >= 10000) {
      lastPoll = Date.now();
      liveFeed.poll().catch(() => {});
    }
    if (Date.now() - last >= EVERY_MS) [(last = Date.now()), update()];
  }, 500);
};

// Upload: analyze only the chosen part of the clip; time of day is unknown, so search all indexed days.
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const parseClock = (v) => (v.trim() === '' ? NaN : v.split(':').reduce((acc, p) => acc * 60 + Number(p), 0));
const preview = $('preview');
$('file').onchange = () => {
  const f = $('file').files[0];
  if (!f) return;
  reset('file', '', 'file');
  $('run').disabled = false;
  if (preview.src) URL.revokeObjectURL(preview.src);
  preview.hidden = $('range').hidden = false;
  preview.src = URL.createObjectURL(f);
  preview.onloadedmetadata = () => [($('from').value = '0:00'), ($('to').value = clock(preview.duration)), showLen()];
  status(`Selected "${f.name}". Pick the time window where the plane passes and click Locate File.`);
};
const showLen = () => {
  const a = parseClock($('from').value), b = parseClock($('to').value);
  $('len').textContent = b > a ? `${Math.round(b - a)} s` : '';
};
$('setFrom').onclick = () => [(($('from').value = clock(preview.currentTime)), showLen())];
$('setTo').onclick = () => [(($('to').value = clock(preview.currentTime)), showLen())];
$('from').oninput = $('to').oninput = showLen;
$('run').onclick = async () => {
  const f = $('file').files[0];
  if (!f) return;
  $('run').disabled = true;
  const myGen = runGen + 1;
  try {
    busy('Decoding');
    const x = await decodeFile(f);
    const dur = x.length / FS;
    if (!$('from').value.trim()) $('from').value = '0:00';
    if (!$('to').value.trim()) $('to').value = clock(dur);
    showLen();
    const a = parseClock($('from').value), b = $('to').value === clock(dur) ? dur : parseClock($('to').value);
    if (!(a >= 0) || !(b > a)) return status('Range must be like 0:05 to 1:00, end after start.');
    if (b - a < Math.min(20, dur)) return status('Pick at least 20 s: the plane must be heard approaching and leaving.');
    // Preserve file input and preview while resetting other sources and map/spectrogram state
    runGen++;
    resetOtherPanels('file');
    [dets, src, sel, pinned, searched, dataBase, onSearched] = [[], 'file', null, false, '', '', null];
    clipOffset = a;
    showAll = false;
    specState = null;
    specHoverPt = null;
    layer.clearLayers();
    truthLayer.clearLayers();
    updateTelemetry(null);
    renderDets();
    player = preview;
    await locate(x.slice(Math.round(a * FS), Math.round(Math.min(b, dur) * FS)), a, runGen);
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
for (const id of Object.keys(EX)) {
  $(`ex-${id}`).onclick = async () => {
    const ex = EX[id],
      btn = $(`ex-${id}`),
      ans = $(`ans-${id}`);
    reset('file', EX_BASE, id);
    btn.disabled = true;
    const myGen = runGen;
    try {
      busy('Decoding');
      const x = await decodeFile(await (await fetch($(`exa-${id}`).src)).blob());
      if (myGen !== runGen) return;
      player = $(`exa-${id}`);
      onSearched = (r) => {
        L.circleMarker(ex.truth, { radius: 7, color: '#22c55e', weight: 3, fillOpacity: 0.15 }).addTo(truthLayer).bindTooltip('Ground Truth Answer', { permanent: true, direction: 'right' });
        const top = r.results[0],
          km = top && L.latLng(top.lat, top.lon).distanceTo(ex.truth) / 1000;
        const inList = r.results.some((q) => q.flights.some((f) => ex.regs.includes(f.reg)));
        ans.textContent =
          `Answer: ${ex.what}. ` +
          (r.kind === 'located'
            ? `Best spot is ${km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`} from it.`
            : r.kind === 'shortlist'
              ? `${ex.regs[0]} is ${inList ? '' : 'not '}in the ${r.results.length}-plane shortlist.`
              : 'Not located.');
        ans.hidden = false;
        if (r.kind !== 'located') map.setView(ex.truth, 9);
      };
      await locate(x, 0, myGen);
    } catch (e) {
      if (myGen === runGen) status(e.message);
    } finally {
      if (myGen === runGen) {
        busy('');
        btn.disabled = false;
      }
    }
  };
}

for (const [audioId, sourceId] of [['exa-two', 'two'], ['exa-kampina', 'kampina'], ['preview', 'file']]) {
  $(audioId)?.addEventListener('play', () => {
    player = $(audioId);
    if (activeSource !== sourceId) {
      reset('file', sourceId === 'file' ? '' : EX_BASE, sourceId);
    }
  });
}
for (const btn of document.querySelectorAll('[data-audio][data-seek]')) {
  btn.addEventListener('click', () => {
    const audioId = btn.dataset.audio;
    const cardId = audioId === 'exa-two' ? 'two' : 'kampina';
    if (activeSource !== cardId) {
      reset('file', EX_BASE, cardId);
      status(`Switched to ${cardId === 'two' ? 'Example 1' : 'Example 2'}. Playing pass audio; click Locate to solve on the map.`);
    }
    const audio = $(audioId);
    if (!audio) return;
    player = audio;
    audio.currentTime = Number(btn.dataset.seek) || 0;
    audio.play().catch(() => {});
  });
}

// Clicking an inactive source card focuses that card and resets the others
for (const card of document.querySelectorAll('.source-card')) {
  card.addEventListener('click', (ev) => {
    if (ev.target.closest('button, input, audio, video, a, label')) return;
    const target = card.dataset.source;
    if (!target || target === activeSource) return;
    reset(target === 'rec' ? 'rec' : 'file', target === 'two' || target === 'kampina' ? EX_BASE : '', target);
    const prompts = {
      two: 'Example 1 selected · Click "Locate Example 1" to solve from two crossing passes.',
      kampina: 'Example 2 selected · Click "Locate Example 2" to match the heathland recording.',
      rec: 'Live Microphone selected · Click "Start Recording" when a propeller plane flies overhead.',
      file: 'Local File selected · Choose an audio or video clip where a propeller plane passes.',
    };
    status(prompts[target] || 'Ready.');
  });
}

// Pre-warm the rolling 60-minute worldwide ADS-B feed on page load and keep deltas synced
liveFeed.poll().catch(() => {});
setInterval(() => {
  if (document.visibilityState !== 'hidden') liveFeed.poll().catch(() => {});
}, 20000);
