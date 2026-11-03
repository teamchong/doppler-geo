// The two bundled example MP3s through analyze + worldwide search over the example index.
import { decode, analyze, search, distM, ROOT, BASE } from './lib.mjs';
async function run(name, file, truth) {
  const ev = analyze(decode(ROOT + BASE + '/' + file)).events, t = performance.now();
  const r = await search(ev, { s0: null, s1: null, base: BASE });
  const top = r.results[0];
  console.log(`${name}: ${ev.length} pass(es) ${ev.map((e) => `${e.v.toFixed(0)}m/s ${e.d.toFixed(0)}m @${e.tc.toFixed(0)}s`).join(', ')} -> ${r.kind}, ${r.results.length} result(s), ${(performance.now() - t).toFixed(0)} ms${top ? `, #1 ${(distM(top.lat, top.lon, ...truth) / 1000).toFixed(2)} km from truth` : ''}`);
  return r;
}
await run('two-planes-sim', 'two-planes-sim.mp3', [52.008, -0.513]);
const r = await run('kampina (real)', 'kampina-klankbeeld.mp3', [51.578671, 5.257332]);
console.log('  PH-TRG in results:', r.results.some((q) => q.flights.some((f) => f.reg === 'PH-TRG')));
