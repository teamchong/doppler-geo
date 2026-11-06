import { decodeFile, Recorder, wav } from './lib/media.js';
import { FS } from './lib/spectro.js';
import { search } from './lib/search.js';
import { liveFeed } from './lib/data.js';
import { newMessagePortRpcSession, transferArrayBuffer } from './lib/vendor/capnweb.js';
import { unpackAnalysis } from './lib/schemas.js';
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

// Analysis runs off the main thread over a Cap'n Web MessagePort RPC session with zero-copy ArrayBuffer transfer.
const worker = new Worker('./analyze.worker.js', { type: 'module' });
const rpcChannel = new MessageChannel();
worker.postMessage({ rpcPort: rpcChannel.port2 }, [rpcChannel.port2]);
const analyzer = newMessagePortRpcSession(rpcChannel.port1);
const map = L.map('map', { preferCanvas: true }).setView([20, 0], 2);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '&copy; OpenStreetMap',
}).addTo(map);
const layer = L.layerGroup().addTo(map),
  truthLayer = L.layerGroup().addTo(map);
map.on?.('moveend', () => {
  if (dets.length) renderDets();
});

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
  ctx.font = `${Math.round(10.5 * dpr)}px ui-monospace, monospace`;
  ctx.fillText('Approaching plane (higher pitch)', 48 * dpr, cy - 30 * dpr);
  ctx.fillText('Leaving plane (lower pitch)', w - 185 * dpr, cy + 32 * dpr);
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
    const relT = player.currentTime - (src === 'file' ? (a.origin ?? clipOffset) : 0);
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
  $('specDur').textContent = `Window ${Math.floor(durS / 60)}:${String(durS % 60).padStart(2, '0')} · Click chart to jump audio`;
  $('specPassCount').textContent = `${a.events.length} plane pass${a.events.length === 1 ? '' : 'es'} detected`;
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
    const t = (src === 'file' ? (a.origin ?? clipOffset) : 0) + fx * a.F * a.dt;
    const hz = Math.round(a.b0 * a.df + (1 - fy) * a.B * a.df);
    $('specHover').textContent = `t = ${hms(t)} · pitch = ${hz} Hz`;
  }
  renderSpectrogramFrame();
});
$('spec').addEventListener('mouseleave', () => {
  specHoverPt = null;
  $('specHover').textContent = 'Move mouse over chart to see time and pitch · Blue curve shows the plane\'s pitch drop';
  renderSpectrogramFrame();
});
$('spec').addEventListener('click', (ev) => {
  if (!player || !specState) return;
  const rect = $('spec').getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width)));
  player.currentTime = (src === 'file' ? (specState.a.origin ?? clipOffset) : 0) + frac * specState.a.F * specState.a.dt;
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
const when = (d) => {
  if (src === 'rec') return new Date(d.at * 1000).toLocaleTimeString([], { hour12: false });
  const ff = src === 'file' ? getFileTimeFilter() : null;
  if (ff) return `${new Date((ff.t0 + d.at) * 1000).toLocaleTimeString([], { hour12: false })} (${hms(d.at)})`;
  return hms(d.at);
};
const passEpoch = (r, d, k = -1) =>
  (k >= 0 ? r.heard?.[k] : null) ?? r.start + (src === 'rec' && recStart ? (d ? d.at - recStart : 0) : (d?.at ?? 0));
// Passes found this session. `at` is epoch seconds for a recording, seconds into the clip for a file.
// cands: null = flight search pending, [] = no match, else solver results best first.
const WINDOW_S = 300,
  EVERY_MS = 3000,
  preview = $('preview');
let dets = [],
  src = null,
  sel = null,
  pinned = false,
  player = null,
  clipOffset = 0,
  activeSource = 'two',
  runGen = 0,
  dataBase = '',
  searched = '',
  recStart = null,
  onSearched = null,
  rec = null,
  tick = null,
  running = false,
  saved = null,
  currentFile = null;
function updateTelemetry(d) {
  if (!d) {
    $('telF0').textContent = 'Waiting for plane';
    $('telV').textContent = 'Waiting for plane';
    $('telD').textContent = 'Waiting for plane';
    $('telFit').textContent = 'Idle';
    return;
  }
  $('telF0').textContent = d.f0 ? `${d.f0.toFixed(1)} Hz` : 'N/A';
  $('telV').textContent = `${Math.round(d.v * 3.6)} km/h (${d.v.toFixed(1)} m/s)`;
  $('telD').textContent = `${Math.round(d.d)} m`;
  if (d.cands == null) $('telFit').textContent = 'Searching...';
  else if (d.ixPos >= 0 && d.cands.length) {
    const used = d.used ?? dets.length;
    $('telFit').textContent = `${d.cands.length} spot${d.cands.length === 1 ? '' : 's'} (${used} plane${used === 1 ? '' : 's'})`;
  } else if (d.passCnt || d.cands.length) {
    const cnt = d.passCnt || d.cands.length;
    $('telFit').textContent = `${cnt} possible plane${cnt === 1 ? '' : 's'}`;
  } else $('telFit').textContent = 'No match';
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
  if (targetSource !== 'file') clearFileControls();
}
function clearFileControls() {
  currentFile = null;
  const prev = $('preview');
  if (prev) {
    prev.pause();
    if (prev.src) URL.revokeObjectURL(prev.src);
    prev.removeAttribute('src');
    prev.hidden = true;
  }
  if ($('file')) $('file').value = '';
  if ($('range')) $('range').hidden = true;
  if ($('timeFilterRow')) $('timeFilterRow').hidden = true;
  if ($('from')) $('from').value = '0:00';
  if ($('to')) $('to').value = '';
  if ($('len')) $('len').textContent = '';
  if ($('recTime')) $('recTime').value = '';
  if ($('recTol')) $('recTol').value = '60';
  if ($('recTimeInfo')) $('recTimeInfo').textContent = 'All indexed times';
  if ($('run')) $('run').disabled = true;
  if ($('clearFile')) $('clearFile').hidden = true;
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

function mergeWavClips(clips) {
  const valid = clips.filter((c) => c?.x?.length).sort((a, b) => a.t0 - b.t0 || b.x.length - a.x.length);
  if (!valid.length) return null;
  const segs = [];
  for (const c of valid) {
    const cEnd = c.t0 + c.x.length / FS,
      last = segs.at(-1);
    if (!last || c.t0 > last.tEnd + 0.05) segs.push({ t0: c.t0, tEnd: cEnd, parts: [c] });
    else if (cEnd > last.tEnd) {
      last.tEnd = cEnd;
      last.parts.push(c);
    }
  }
  const bufs = segs.map((s) => {
    if (s.parts.length === 1) return s.parts[0].x;
    const len = Math.round((s.tEnd - s.t0) * FS),
      out = new Float32Array(len);
    for (const p of s.parts) {
      const off = Math.max(0, Math.round((p.t0 - s.t0) * FS));
      out.set(p.x.subarray(0, Math.min(p.x.length, len - off)), off);
    }
    return out;
  });
  if (bufs.length === 1) return { x: bufs[0], t0: segs[0].t0 };
  const firstT0 = segs[0].t0,
    lastEnd = segs.at(-1).tEnd,
    spanLen = Math.round((lastEnd - firstT0) * FS);
  if (spanLen > 0 && spanLen <= 1800 * FS) {
    const x = new Float32Array(spanLen);
    for (let i = 0; i < segs.length; i++) {
      const off = Math.max(0, Math.round((segs[i].t0 - firstT0) * FS));
      x.set(bufs[i].subarray(0, Math.min(bufs[i].length, spanLen - off)), off);
    }
    return { x, t0: firstT0 };
  }
  const total = bufs.reduce((n, b) => n + b.length, 0),
    x = new Float32Array(total);
  let off = 0;
  for (const b of bufs) {
    x.set(b, off);
    off += b.length;
  }
  return { x, t0: firstT0 };
}

function slicePassWav(wavClip, pts, at, prevWav = null) {
  if (!wavClip?.x?.length) return null;
  const { x, t0 } = wavClip,
    dur = x.length / FS;
  const p0 = pts.length ? pts[0][0] : at - 20,
    p1 = pts.length ? pts.at(-1)[0] : at + 20;
  let startT = Math.max(t0, Math.min(p0 - 15, at - 30));
  const endT = Math.min(t0 + dur, Math.max(p1 + 15, at + 30));
  if (prevWav?.x?.length) {
    const prevEnd = prevWav.t0 + prevWav.x.length / FS;
    if (prevEnd >= t0 && prevEnd < startT) startT = prevEnd;
  }
  const i0 = Math.max(0, Math.floor((startT - t0) * FS)),
    i1 = Math.min(x.length, Math.ceil((endT - t0) * FS));
  return i1 > i0 ? { x: x.slice(i0, i1), t0: t0 + i0 / FS } : null;
}

// Overlapping live windows see the same pass again; keep one entry and take the newer fit.
function merge(events, origin, spec = null, wavClip = null) {
  const winEnd = origin + (wavClip?.x?.length ? wavClip.x.length / FS : (spec?.dur ?? 0));
  for (const e of events) {
    const at = origin + e.tc,
      pts = e.pts.map(([t, f]) => [origin + t, f]),
      p0 = pts.length ? pts[0][0] : at - 15,
      p1 = pts.length ? pts.at(-1)[0] : at + 15;
    const d = dets.find(
      (d) =>
        (Math.abs(d.at - at) < 12 && Math.abs(d.v - e.v) < 0.25 * d.v) ||
        (src === 'rec' && (d.locked || origin > (d.p0 ?? d.at - 15) - 2) && at >= d.at - 10 && at <= (d.p1 ?? d.at + 20) + 30),
    );
    if (!d && src === 'rec' && origin > (recStart ?? origin) + 5 && (e.pts[0]?.[0] ?? 99) < 10 && dets.some((p) => at <= (p.p1 ?? p.at + 20) + 35)) {
      continue;
    }
    const prevWav = dets
      .filter((p) => p !== d && p.at < at - 10 && p.wav)
      .sort((a, b) => a.at - b.at)
      .at(-1)?.wav;
    const clip = slicePassWav(wavClip, pts, at, prevWav);
    const isDone = src === 'rec' && winEnd >= p1 + 20;
    if (d) {
      const keepSpec = !d.locked && (!d.pts?.length || origin <= Math.min(d.p0 ?? d.pts[0][0], p0) - 2);
      if (keepSpec) {
        Object.assign(d, {
          at,
          v: e.v,
          d: e.d,
          f0: e.f0,
          p0: Math.min(d.p0 ?? p0, p0),
          p1: Math.max(d.p1 ?? p1, p1),
          locked: isDone,
          pts,
          spec: spec ?? d.spec,
          wav: mergeWavClips([d.wav, clip]),
        });
      } else {
        d.p1 = Math.max(d.p1 ?? p1, p1);
        if (isDone) d.locked = true;
        if (!d.locked) d.wav = mergeWavClips([d.wav, clip]);
      }
    } else {
      dets.push({ id: dets.length + 1, at, v: e.v, d: e.d, f0: e.f0, p0, p1, locked: isDone, pts, spec, wav: clip, cands: null });
    }
  }
  dets.sort((p, q) => p.at - q.at);
  dets.forEach((p, idx) => (p.id = idx + 1));
  const wavCount = dets.filter((d) => d.wav).length;
  if (wavCount) $('save').textContent = `Download .wav (${wavCount === 1 ? '1 pass' : `all ${wavCount} passes`})`;
}

function drawCands(d) {
  layer.clearLayers();
  if (!d?.cands?.length && !d?.passList?.length) return;
  if (d.kind === 'shortlist' || (d.ixPos < 0 && d.passList?.length)) {
    const list = d.passList?.length ? d.passList : d.cands;
    for (const r of list)
      L.circleMarker([r.lat, r.lon], { radius: 3.5, color: '#38bdf8', weight: 1, fillOpacity: 0.7 })
        .addTo(layer)
        .bindTooltip(`Pass #${d.id} candidate: ${r.flights.map(label).join(' + ')}`);
    return map.fitBounds(L.latLngBounds(list.map((r) => [r.lat, r.lon])), { padding: [24, 24], animate: false });
  }
  if (!d.cands?.length) return;
  const best = d.cands[0];
  // Draw ADS-B trajectories and CPA vectors for the top candidate
  if (best.paths?.length) {
    best.paths.forEach((p, idx) => {
      const trkColor = idx === 0 ? '#38bdf8' : '#a855f7';
      const passNum = d.ix?.[idx] != null ? dets[d.ix[idx]]?.id ?? d.ix[idx] + 1 : idx + 1;
      if (p.path?.length >= 2) {
        L.polyline(p.path, { color: trkColor, weight: 2.5, opacity: 0.85 })
          .addTo(layer)
          .bindTooltip(`Pass #${passNum} Flight Path: ${label(p.flight)}`);
      }
      if (p.cpa) {
        L.polyline([p.cpa, [best.lat, best.lon]], { color: trkColor, weight: 1.5, dashArray: '4 5', opacity: 0.75 }).addTo(layer);
        L.circleMarker(p.cpa, { radius: 4, color: trkColor, weight: 1.5, fillOpacity: 0.9 })
          .addTo(layer)
          .bindTooltip(`Pass #${passNum} Closest Point Overhead: ${label(p.flight)}`);
      }
    });
  }
  d.cands.forEach((r, i) => {
    const conf = Math.max(0.15, Math.min(1, best.q / r.q));
    const color = i ? '#64748b' : '#f59e0b';
    const tip = `Pinpointed Intersection #${i + 1}: ${r.flights.map((f, k) => `Pass #${d.ix?.[k] != null ? dets[d.ix[k]]?.id ?? d.ix[k] + 1 : k + 1} ${label(f)}`).join(' ∩ ')}`;
    if (r.hull?.length) {
      L.polygon(r.hull, { color, weight: i ? 1 : 2, fillOpacity: 0.25 * conf })
        .addTo(layer)
        .bindTooltip(tip);
    }
    L.circleMarker([r.lat, r.lon], { radius: i ? 5 : 7, color, weight: i ? 1.5 : 2, fillOpacity: 0.45 * conf })
      .addTo(layer)
      .bindTooltip(tip);
  });
  const boundsPts =
    d.kind === 'located'
      ? [...best.hull, ...(best.paths?.flatMap((p) => p.path ?? []) ?? [])]
      : [...d.cands.slice(0, 5).flatMap((r) => r.hull), ...(best.paths?.flatMap((p) => p.path ?? []) ?? [])];
  map.fitBounds(L.latLngBounds(boundsPts), { maxZoom: 13, padding: [32, 32], animate: false });
}

function pick(d, byUser) {
  [sel, pinned] = [d.id, pinned || byUser];
  if (byUser && src !== 'rec' && player) player.currentTime = d.at;
  if (src === 'rec' && d?.spec) drawSpectrogram(d.spec);
  updateTelemetry(d);
  drawCands(d);
  renderDets();
}

function summary(d) {
  if (d.cands === null) return 'Searching flights...';
  if (d.ixPos >= 0 && d.cands?.length) {
    const r = d.cands[0],
      myFlight = r.flights?.[d.ixPos],
      otherPasses = (d.ix ?? [])
        .filter((_, k) => k !== d.ixPos)
        .map((op) => `Pass #${dets[op]?.id ?? op + 1}`)
        .join(' & '),
      tPass = passEpoch(r, d, d.ixPos);
  return `★ Intersects ${otherPasses} · ${label(myFlight)} · Pinpointed near ${r.lat.toFixed(3)}, ${r.lon.toFixed(3)} (${fmt(tPass)})`;
  }
  const pCnt = d.passCnt ?? d.passList?.length ?? d.cands?.length ?? 0;
  if (!pCnt) return 'No matching flight';
  return `${pCnt} possible plane${pCnt === 1 ? '' : 's'} worldwide (1 pass alone cannot pinpoint a spot)`;
}

function renderDets() {
  $('dets').hidden = !dets.length;
  const badge = $('detBadge');
  const d = dets.find((x) => x.id === sel) ?? dets.at(-1);
  if (badge) {
    badge.textContent =
      !d || d.cands === null
        ? 'Searching'
        : d.kind === 'located'
          ? `Pinpointed (${d.cands.length} Spot${d.cands.length === 1 ? '' : 's'})`
          : d.kind === 'shortlist'
            ? `1 Pass (${d.passCnt || d.cands.length} Possible Planes)`
            : d.kind === 'unsure'
              ? `Closest Intersection (${d.cands.length})`
              : 'No Match';
  }
  const ixBox = $('ixBox');
  if (ixBox) {
    const hasIx = d && d.cands?.length > 0 && (d.kind === 'located' || d.kind === 'unsure') && (d.ix?.length ?? 0) >= 2;
    ixBox.hidden = !hasIx;
    if (hasIx) {
      ixBox.className = d.kind === 'located' ? 'ix-box' : 'ix-box unsure';
      const passNames = d.ix.map((idx) => `Pass #${dets[idx]?.id ?? idx + 1}`).join(' ∩ ');
      const breakdown = d.ix
        .map((idx) => `Pass #${dets[idx]?.id ?? idx + 1} (${dets[idx]?.passCnt ?? dets[idx]?.passList?.length ?? '?'} planes)`)
        .join(' ∩ ');
      const head = document.createElement('div');
      head.className = 'ix-head';
      const title = document.createElement('div');
      title.className = 'ix-title';
      title.textContent =
        d.kind === 'located'
          ? `Pinpointed Location · Intersection of ${passNames}`
          : `Closest Intersection · ${passNames} (Approximate)`;
      const pill = document.createElement('span');
      pill.className = 'ix-pill';
      pill.textContent = `${breakdown} → ${d.cands.length} shared spot${d.cands.length === 1 ? '' : 's'}`;
      head.append(title, pill);
      const ixOl = document.createElement('ol');
      ixOl.className = 'ix-list';
      const best = d.cands[0];
      d.cands.slice(0, SHOW).forEach((r, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<b></b> <span></span><br><span class="mute"></span>`;
        li.children[0].textContent = `#${i + 1} (${strength(r, best)})`;
        li.children[1].textContent = `Pinpointed spot near ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}`;
        li.children[3].textContent = r.flights
          .map((f, k) => {
            const pIdx = d.ix[k],
              pObj = dets[pIdx],
            tP = passEpoch(r, pObj, k);
          return `Pass #${pObj?.id ?? pIdx + 1}: ${label(f)} (${fmt(tP)})`;
          })
          .join('  ∩  ');
        li.onclick = () =>
          map.fitBounds(L.latLngBounds([...r.hull, ...(r.paths?.flatMap((p) => p.path ?? []) ?? [])]), {
            maxZoom: 14,
            padding: [32, 32],
          });
        ixOl.append(li);
      });
      ixBox.replaceChildren(head, ixOl);
    } else {
      ixBox.replaceChildren();
    }
  }
  const ol = $('detList');
  ol.replaceChildren(
    ...dets.map((d) => {
      const li = document.createElement('li');
      li.className = d.id === sel ? 'open' : '';
      const head = document.createElement('button');
      head.className = 'det';
      const isIx = d.ixPos >= 0 && d.cands?.length > 0;
      head.innerHTML = `<time></time><span class="mute"></span><span class="${isIx ? 'sum ix' : 'sum'}"></span>`;
      head.children[0].textContent = `Pass #${d.id} · ${when(d)}`;
      const pCnt = d.passCnt ?? d.passList?.length;
      head.children[1].textContent = `${Math.round(d.v * 3.6)} km/h, ${Math.round(d.d)} m away${pCnt != null ? ` · ${pCnt} plane${pCnt === 1 ? '' : 's'}` : ''}`;
      head.children[2].textContent = summary(d);
      head.onclick = () => pick(d, true);
      li.append(head);
      if (d.id === sel && (d.cands?.length || d.passList?.length)) {
        const sub = document.createElement('ol');
        const note = document.createElement('p');
        note.className = 'mute small';
        const otherPasses = isIx
          ? (d.ix ?? [])
              .filter((_, k) => k !== d.ixPos)
              .map((op) => `Pass #${dets[op]?.id ?? op + 1}`)
              .join(' & ')
          : '';
        const ixHexes = new Set();
        if (isIx) {
          d.cands.slice(0, SHOW).forEach((r, i) => {
            const f = r.flights?.[d.ixPos];
            if (f?.hex) ixHexes.add(f.hex);
            const pPath = r.paths?.[d.ixPos];
            const tPass = passEpoch(r, d, d.ixPos);
            const c = document.createElement('li');
            c.className = 'ix-match';
            c.innerHTML = `<span class="ix-tag"></span> <b></b> <span></span><br><span class="mute"></span>`;
            c.children[0].textContent = `★ Intersects ${otherPasses}${i === 0 ? ' · Pinpointed Spot' : ` (#${i + 1})`}`;
            c.children[1].textContent = label(f);
            c.children[2].textContent = `near ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)} (${fmt(tPass)})`;
            const crossInfo = r.flights
              .map((of, k) => (k === d.ixPos ? null : `Pass #${dets[d.ix[k]]?.id ?? d.ix[k] + 1}: ${label(of)}`))
              .filter(Boolean)
              .join(' · ');
            c.children[4].textContent = `Crosses ${crossInfo} (${strength(r, d.cands[0])})`;
            c.onclick = () =>
        map.fitBounds(L.latLngBounds([...r.hull, ...(pPath?.path ?? r.paths?.flatMap((p) => p.path ?? []) ?? [])]), {
          maxZoom: 14,
          padding: [32, 32],
          animate: false,
        });
            sub.append(c);
          });
        }
        const rawPassList = d.passList?.length ? d.passList : d.kind === 'shortlist' ? d.cands : [];
        const baseOtherList = rawPassList.filter((r) => !ixHexes.has(r.flights?.[0]?.hex));
        const mapBounds = map.getBounds?.() ?? null;
        const mapCenter = map.getCenter?.() ?? null;
        const inViewCnt = mapBounds ? baseOtherList.filter((r) => mapBounds.contains([r.lat, r.lon])).length : baseOtherList.length;
      const mapZoomed = Boolean(mapBounds && mapCenter && (map.getZoom?.() ?? 2) >= 3);
        const otherList = mapZoomed
          ? [...baseOtherList].sort((a, b) => {
              const aIn = mapBounds?.contains([a.lat, a.lon]) ? 0 : 1,
                bIn = mapBounds?.contains([b.lat, b.lon]) ? 0 : 1;
              if (aIn !== bIn) return aIn - bIn;
              return L.latLng(a.lat, a.lon).distanceTo(mapCenter) - L.latLng(b.lat, b.lon).distanceTo(mapCenter);
            })
          : baseOtherList;
        note.textContent = isIx
          ? `Pass #${d.id} matched ${pCnt || d.cands.length} flights worldwide on its own. The highlighted flight below crossed paths with ${otherPasses} at the same spot:`
          : mapZoomed
            ? inViewCnt > 0
              ? `Showing ${inViewCnt} matching plane${inViewCnt === 1 ? '' : 's'} inside your current map view (out of ${pCnt || d.cands.length} worldwide at this speed), sorted by closest to map center:`
              : `None of the ${pCnt || d.cands.length} planes at ${Math.round(d.v * 3.6)} km/h were directly inside this map box at ${when(d)}, showing the closest matches to your map center:`
            : `Every plane below was flying at Pass #${d.id}'s speed and distance (${pCnt || d.cands.length} worldwide). Zoom the map to your area to filter by location, or record a 2nd plane to pinpoint:`;
        const showCount = showAll ? otherList.length : Math.max(0, SHOW - (isIx ? Math.min(d.cands.length, 2) : 0));
        otherList.slice(0, showCount).forEach((r, i) => {
          const f = r.flights?.[0];
          const c = document.createElement('li');
          c.innerHTML = `<b></b> <span></span> <span class="mute"></span>`;
          c.children[0].textContent = `#${i + 1 + ixHexes.size} ${label(f)}`;
          const tPass = passEpoch(r, d, -1);
          const distKm = mapZoomed && mapCenter ? L.latLng(r.lat, r.lon).distanceTo(mapCenter) / 1000 : null;
          const distTag = distKm != null ? ` · ${distKm < 10 ? distKm.toFixed(1) : Math.round(distKm)} km from map center` : '';
          c.children[1].textContent = `near ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)} (${fmt(tPass)})${distTag}`;
          c.children[2].textContent = isIx ? `· Pass #${d.id} only (no intersection with ${otherPasses})` : `· Pass #${d.id} candidate`;
          c.onclick = () => {
            L.circleMarker([r.lat, r.lon], { radius: 5, color: '#38bdf8', weight: 2, fillOpacity: 0.9 })
              .addTo(layer)
              .bindTooltip(`Pass #${d.id} candidate: ${label(f)}`)
              .openTooltip();
          map.fitBounds(L.latLngBounds(r.hull), { maxZoom: 12, padding: [32, 32], animate: false });
          };
          sub.append(c);
        });
        li.append(note, sub);
        if (otherList.length > Math.max(0, SHOW - (isIx ? Math.min(d.cands.length, 2) : 0))) {
          const b = document.createElement('button');
          b.className = 'link';
          b.textContent = showAll
            ? 'Show fewer'
            : `Show ${otherList.length - showCount} more Pass #${d.id} single-pass candidates`;
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
  try {
    const totalS = samples.length / FS;
    if (src === 'file' && totalS > 360) {
      const winLen = WINDOW_S * FS,
        stepLen = (WINDOW_S - 60) * FS;
      for (let off = 0; off < samples.length; off += stepLen) {
        const end = Math.min(samples.length, off + winLen),
          start = Math.max(0, end - winLen),
          sub = samples.slice(start, end),
          subOrigin = origin + start / FS;
        const a = unpackAnalysis(await analyzer.analyze(transferArrayBuffer(sub)));
        if (myGen !== runGen) return;
        a.origin = subOrigin;
        merge(a.events, subOrigin, a, null);
        if (a.events.length || !dets.length) drawSpectrogram(a);
        if (end >= samples.length) break;
      }
    } else {
      const workBuf = src === 'rec' ? new Float32Array(samples) : samples;
      const a = unpackAnalysis(await analyzer.analyze(transferArrayBuffer(workBuf)));
      if (myGen !== runGen) return;
      a.origin = origin;
      merge(a.events, origin, a, src === 'rec' && a.events.length ? { x: samples, t0: origin } : null);
      if (a.events.length || !dets.length) drawSpectrogram(a);
    }
  } finally {
    if (myGen === runGen) busy('');
  }
  if (myGen !== runGen) return;
  const latest = dets[dets.length - 1];
  if (latest && !pinned) pick(latest, false);
  else renderDets();
  if (!dets.length) {
    return status(
      src === 'rec'
        ? rec.seconds < 12
          ? `Live Mic (${rec.seconds.toFixed(0)}s) · Listening · Need about 15 to 30 s of a propeller plane flying past`
          : `Live Mic (${rec.seconds.toFixed(0)}s analyzed) · 0 propeller planes heard so far · Keep recording while a propeller plane or helicopter flies past`
        : 'No propeller plane or helicopter pass heard in this audio. Needs a steady propeller or rotor hum (big commercial jets do not work).',
    );
  }
  await where(myGen);
}

// Search the flight index with every pass so far. Recording: start time is known (clock). File: optional time filter or all indexed times.
async function where(myGen = runGen) {
  if (!dets.length) return;
  const ff = src === 'file' ? getFileTimeFilter() : null;
  const filterKey = ff ? `:${Math.round(ff.s0)}_${Math.round(ff.s1)}` : '';
  const liveFresh = src === 'rec' && (dets.some((d) => d.cands === null) || (liveFeed.now && liveFeed.now - ((dets.at(-1)?.at ?? 0) + (liveFeed.clockOffset || 0)) < 45));
  const sig = dets.map((d) => `${d.at.toFixed(1)}:${d.v.toFixed(1)}:${d.pts.length}`).join() + (src === 'rec' ? (liveFresh ? `:${Math.floor(liveFeed.now / 10)}` : ':settled') : filterKey);
  if (sig === searched) return;
  const S = src === 'rec' ? recStart : 0,
    sClock = S + (src === 'rec' ? liveFeed.clockOffset || 0 : 0),
    s0 = src === 'rec' ? sClock - 10 : ff ? ff.s0 : null,
    s1 = src === 'rec' ? sClock + 10 : ff ? ff.s1 : null,
    evs = dets.map((d) => ({ v: d.v, d: d.d, tc: d.at - S, pts: d.pts.map(([t, f]) => [t - S, f]) }));
  status(`${dets.length} plane pass${dets.length === 1 ? '' : 'es'} detected. Searching flights...`);
  busy(src === 'rec' ? 'Searching live flights worldwide' : 'Searching flights worldwide');
  let r;
  try {
    r = await search(evs, {
      s0,
      s1,
      base: dataBase,
      onProgress: (p) => {
        if (myGen === runGen) busy(`Searching ${src === 'rec' ? 'live flights' : 'flights'} worldwide (${Math.round(p * 100)}%)`);
      },
    });
  } catch (e) {
    searched = '';
    throw e;
  } finally {
    if (myGen === runGen) busy('');
  }
  if (myGen !== runGen) return;
  searched = sig;
  for (let i = 0; i < dets.length; i++) {
    const passList = r.passShortlists?.[i] ?? (i === 0 ? r.results : []),
      passCnt = r.passPlanes?.[i] ?? passList.length,
      ixPos = (r.kind === 'located' || r.kind === 'unsure') && r.ix ? r.ix.indexOf(i) : -1;
    Object.assign(dets[i], {
      cands: r.results,
      kind: r.kind,
      used: r.used,
      ix: r.ix ?? [0],
      ixPos,
      passList,
      passCnt,
    });
  }
  const ixDesc =
    (r.kind === 'located' || r.kind === 'unsure') && r.ix?.length >= 2
      ? r.ix.map((idx) => `Pass #${dets[idx]?.id ?? idx + 1} (${r.passPlanes?.[idx] ?? '?'} planes)`).join(' ∩ ')
      : '';
  const msg = {
    located: `Pinpointed from ${ixDesc || `${r.used} plane passes`}. Best location is ${r.results.length > 1 ? `${(r.results[1].q / r.results[0].q).toFixed(1)}x better than the next` : 'a unique match'}.`,
    unsure: `${dets.length} plane passes heard (${ixDesc}), but no single location fits all of them well. Showing the closest intersection.`,
    shortlist: `1 plane heard: ${r.planes} flights worldwide were flying at this speed and distance. Record a 2nd plane at the same spot to pinpoint your location.`,
    none: 'No matching flight found. The plane may not have had its flight tracker on, or that day is not in the database.',
  }[r.kind];
  status(msg);
  const d = dets.find((x) => x.id === sel) ?? dets.at(-1);
  if (d) pick(d, false);
  onSearched?.(r);
}

// Live mic: re-analyze the last 5 minutes every few seconds while recording; Stop just stops.
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

// Saves all detected Doppler pass clips (or the last 5 min fallback) to a local .wav file.
$('save').onclick = () => {
  let clip = mergeWavClips(dets.map((d) => d.wav));
  if (!clip && saved) {
    const { x, offset } = saved.samples();
    clip = { x, t0: saved.t0 + offset };
  }
  if (!clip?.x?.length) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(wav(clip.x));
  a.download = `recording-${new Date(clip.t0 * 1000).toISOString().slice(0, 19).replace(/:/g, '-') }Z.wav`;
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
  $('save').textContent = 'Download .wav (last 5m)';
  rec = new Recorder();
  try {
    await rec.start();
  } catch (e) {
    rec = null;
    return status(`Mic: ${e.message}`);
  }
  saved = rec;
  $('rec').textContent = 'Stop';
  status('Listening with auto max mic boost (+24 dB). Live-checking every 3s as propeller planes pass...');
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

function toLocalIsoInput(epochSec) {
  const d = new Date(Math.round(epochSec) * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseFilenameTime(name = '') {
  const mUtc = name.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})[-:](\d{2})[-:](\d{2})(?:\.\d+)?Z/i);
  if (mUtc) {
    const [, Y, M, D, h, m, s] = mUtc;
    const epoch = Date.UTC(+Y, +M - 1, +D, +h, +m, +s) / 1000;
    if (Number.isFinite(epoch)) return { epoch, tol: 15, label: `From filename (${h}:${m}:${s} UTC)` };
  }
  const mIso = name.match(/(\d{4})-(\d{2})-(\d{2})[T_\s-](\d{2})[-:.](\d{2})(?:[-:.](\d{2}))?/);
  if (mIso) {
    const [, Y, M, D, h, m, s = '0'] = mIso;
    const epoch = new Date(+Y, +M - 1, +D, +h, +m, +s).getTime() / 1000;
    if (Number.isFinite(epoch)) return { epoch, tol: 60, label: 'From filename' };
  }
  const mCmp = name.match(/(?:^|\D)(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[_-](\d{2})(\d{2})(\d{2})?(?:\D|$)/);
  if (mCmp) {
    const [, Y, M, D, h, m, s = '0'] = mCmp;
    const epoch = new Date(+Y, +M - 1, +D, +h, +m, +s).getTime() / 1000;
    if (Number.isFinite(epoch)) return { epoch, tol: 60, label: 'From filename' };
  }
  return null;
}

function detectFileTime(f, dur = 0, forceModified = false) {
  if (!f) return null;
  const byName = parseFilenameTime(f.name || '');
  if (byName) return byName;
  if (f.lastModified && (forceModified || Math.abs(Date.now() - f.lastModified) < 24 * 3600e3)) {
    const epoch = Math.round(f.lastModified / 1000 - (Number.isFinite(dur) && dur > 0 ? dur : 0));
    return { epoch, tol: 120, label: 'From file timestamp' };
  }
  return null;
}

function getFileTimeFilter() {
  const val = $('recTime')?.value?.trim(),
    tol = Number($('recTol')?.value ?? 60);
  if (!val || !(tol > 0)) return null;
  const t0 = new Date(val).getTime() / 1000;
  if (!Number.isFinite(t0)) return null;
  return { t0, tol, s0: t0 - tol, s1: t0 + tol };
}

function updateTimeFilterInfo(customLabel = null) {
  const info = $('recTimeInfo');
  if (!info) return;
  const ff = getFileTimeFilter();
  if (!ff) {
    info.textContent = 'All indexed times';
    return;
  }
  const utcStr = new Date(ff.t0 * 1000).toISOString().slice(11, 19) + ' UTC';
  info.textContent = customLabel ?? `${utcStr} (±${ff.tol >= 60 ? `${Math.round(ff.tol / 60)}m` : `${ff.tol}s`})`;
}

function applyDetectedFileTime(f, dur = 0, forceModified = false) {
  const det = detectFileTime(f, dur, forceModified);
  if (det && $('recTime')) {
    $('recTime').value = toLocalIsoInput(det.epoch);
    if ($('recTol')) {
      const opts = [...$('recTol').options].map((o) => Number(o.value)).filter((v) => v > 0);
      const bestTol = opts.find((v) => v >= det.tol) ?? 60;
      $('recTol').value = String(bestTol);
    }
    updateTimeFilterInfo(det.label);
    return det;
  }
  updateTimeFilterInfo();
  return null;
}

function onTimeFilterChanged() {
  updateTimeFilterInfo();
  if (src === 'file' && dets.length) {
    renderDets();
    searched = '';
    where(runGen).catch((e) => status(e.message));
  }
}

if ($('recTime')) $('recTime').onchange = onTimeFilterChanged;
if ($('recTol')) $('recTol').onchange = onTimeFilterChanged;
if ($('detectTimeBtn')) {
  $('detectTimeBtn').onclick = () => {
    const f = currentFile || $('file')?.files?.[0];
    const dur = Number.isFinite(preview?.duration) ? preview.duration : 0;
    const det = applyDetectedFileTime(f, dur, true);
    if (!det && !f) status('Choose an audio or video file first, or enter a recording time.');
    if (src === 'file' && dets.length) {
      renderDets();
      searched = '';
      where(runGen).catch((e) => status(e.message));
    }
  };
}
if ($('clearTimeBtn')) {
  $('clearTimeBtn').onclick = () => {
    if ($('recTime')) $('recTime').value = '';
    updateTimeFilterInfo();
    if (src === 'file' && dets.length) {
      renderDets();
      searched = '';
      where(runGen).catch((e) => status(e.message));
    }
  };
}

function loadSelectedFile(f) {
  if (!f) return;
  reset('file', 'file');
  currentFile = f;
  $('run').disabled = false;
  if ($('clearFile')) $('clearFile').hidden = false;
  if (preview.src) URL.revokeObjectURL(preview.src);
  preview.hidden = $('range').hidden = false;
  if ($('timeFilterRow')) $('timeFilterRow').hidden = false;
  preview.src = URL.createObjectURL(f);
  const det = applyDetectedFileTime(f, 0, false);
  preview.onloadedmetadata = () => {
    [$('from').value = '0:00', ($('to').value = clock(preview.duration))], showLen();
    if (!det) applyDetectedFileTime(f, preview.duration, false);
  };
  const ff = getFileTimeFilter();
  status(
    `Selected "${f.name}"${ff ? ` · Recorded ${new Date(ff.t0 * 1000).toLocaleTimeString([], { hour12: false })} (±${ff.tol}s)` : ''}. Pick the time window where the plane passes and click Locate File.`,
  );
}
$('file').onchange = () => loadSelectedFile($('file').files[0]);
window.addEventListener('dragenter', (e) => e.preventDefault());
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  try {
    const dt = new DataTransfer();
    dt.items.add(f);
    $('file').files = dt.files;
  } catch {}
  loadSelectedFile(f);
});
$('clearFile').onclick = () => {
  clearFileControls();
  reset('file', 'file');
  status('File cleared. Choose a local audio or video clip where a propeller plane passes.');
};
const showLen = () => {
  const a = parseClock($('from').value),
    b = parseClock($('to').value);
  $('len').textContent = b > a ? `${Math.round(b - a)} s` : '';
};
$('setFrom').onclick = () => [($('from').value = clock(preview.currentTime)), showLen()];
$('setTo').onclick = () => [($('to').value = clock(preview.currentTime)), showLen()];
$('from').oninput = $('to').oninput = showLen;
$('run').onclick = async () => {
  const f = currentFile || $('file').files[0];
  if (!f) return;
  $('run').disabled = true;
  const myGen = ++runGen;
  try {
    busy('Decoding');
    const x = await decodeFile(f);
    const dur = x.length / FS;
    if (!$('recTime')?.value) applyDetectedFileTime(f, dur, false);
    if (!$('from').value.trim()) $('from').value = '0:00';
    if (!$('to').value.trim()) $('to').value = clock(dur);
    showLen();
    const a = parseClock($('from').value),
      b = $('to').value === clock(dur) ? dur : parseClock($('to').value);
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
        L.circleMarker(ex.truth, { radius: 7, color: '#22c55e', weight: 3, fillOpacity: 0.15 })
          .addTo(truthLayer)
          .bindTooltip('Actual Recording Location', { permanent: true, direction: 'right' });
        const top = r.results[0];
        const km = top && L.latLng(top.lat, top.lon).distanceTo(ex.truth) / 1000;
        const inList = r.results.some((c) => c.flights.some((f) => ex.regs.includes(f.reg)));
        ans.textContent =
          `Actual location: ${ex.what}. ` +
          (r.kind === 'located'
            ? `Estimated location is ${km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`} away.`
            : r.kind === 'shortlist'
            ? `${ex.regs[0]} is ${inList ? 'included' : 'not'} in the ${r.results.length} possible planes worldwide.`
            : 'Not found.');
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
