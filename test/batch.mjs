// Full pipeline on 20 simulated 2-plane spots, live mode (start known to ±2 s).
import { pairSpots, simulate, analyze, search, distM, BASE } from './lib.mjs';
const tally = {};
for (const s of pairSpots()) {
  const x = simulate({ passes: s.passes, observer: [0, 0, 1.5], start: s.start, dur: s.dur, noise: +(process.env.NOISE ?? 0.05), seed: s.seed });
  const ev = analyze(x).events, r = ev.length ? await search(ev, { s0: s.start - 2, s1: s.start + 2, base: BASE }) : { kind: 'no pass', results: [] };
  const top = r.results[0], err = top ? distM(top.lat, top.lon, s.lat, s.lon) : Infinity;
  const k = r.kind === 'located' ? (err < 1000 ? 'correct' : 'WRONG') : r.kind;
  tally[k] = (tally[k] ?? 0) + 1;
  console.log(`#${s.i} ${ev.length} pass(es) -> ${k}${top ? ` ${(err / 1000).toFixed(2)} km` : ''}`);
}
console.log(JSON.stringify(tally));
