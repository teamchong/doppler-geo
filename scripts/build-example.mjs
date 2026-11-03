// Example dataset: a time slice of adsb.lol traces (made by /tmp slice scan) -> same day/idx/spd layout the site serves.
// Usage: node scripts/build-example.mjs slice.json public/examples/2025-07-18
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex, loadProps } from './build-index.mjs';

const [src, out] = process.argv.slice(2);
const { t0, ac } = JSON.parse(fs.readFileSync(src, 'utf8')), date = new Date(t0 * 1000).toISOString().slice(0, 10);
async function* traces() {
  for (const [icao, m] of Object.entries(ac)) yield { icao, t: m.t, r: m.r, timestamp: t0, trace: m.pts };
}
const dir = path.join(out, 'data');
console.log(JSON.stringify(await buildIndex(traces(), { date, out: dir, props: loadProps() })));
fs.writeFileSync(path.join(dir, 'days.json'), JSON.stringify([date]));
