// Detector on simulated 2-plane spots vs truth. A pass counts only if a straight-pass fit to its noise-free
// pitch curve recovers its speed and distance: turning or climbing planes break the model, whatever the detector does.
import { pairSpots, simulate, analyze, closest, R } from './lib.mjs';
const { retardedK, fitLine } = await import(R + 'physics.js');
const noise = +(process.env.NOISE ?? 0.05), verbose = process.argv.includes('-v');
const good = (f, c) => Math.abs(f.v - c.v) < 5 && Math.abs(f.d - c.d) < 0.3 * c.d;
function fittable(p, s, c) {
  for (const W of [15, 25, 40]) {
    const ts = [], fq = [];
    for (let t = c.tc - W; t <= c.tc + W; t += 0.25) { const k = retardedK(p.track, 0, 0, 1.5, s.start + t); if (k > 0) { ts.push(t); fq.push(p.f0 * k); } }
    if (ts.length > 40 && good(fitLine(ts, fq), c)) return true;
  }
  return false;
}
const n = { truth: 0, fittable: 0, found: 0, accurate: 0, extra: 0 };
for (const s of pairSpots()) {
  const x = simulate({ passes: s.passes, observer: [0, 0, 1.5], start: s.start, dur: s.dur, noise, seed: s.seed });
  const ev = analyze(x).events;
  const want = s.passes.map((p) => ({ p, c: closest(p.track, s.start, s.dur) })).filter(({ c }) => c.d < 3000 && c.tc > 15 && c.tc < s.dur - 15);
  const lines = [];
  let used = 0;
  for (const { p, c } of want) {
    n.truth++;
    if (!fittable(p, s, c)) { lines.push(`${c.tc.toFixed(0)}s unfittable`); continue; }
    n.fittable++;
    const e = ev.find((e) => Math.abs(e.tc - c.tc) < 6);
    if (e) { n.found++; used++; if (good(e, c)) n.accurate++; }
    lines.push(`${c.tc.toFixed(0)}s ${c.v.toFixed(0)}m/s ${c.d.toFixed(0)}m -> ${e ? `${e.v.toFixed(0)}m/s ${e.d.toFixed(0)}m${good(e, c) ? '' : ' BAD'}` : 'MISSED'}`);
  }
  n.extra += ev.filter((e) => !want.some(({ c }) => Math.abs(e.tc - c.tc) < 6)).length;
  if (verbose || /MISSED|BAD/.test(lines.join())) console.log(`#${s.i} ${lines.join(' | ')}`);
}
console.log(JSON.stringify(n));
