// ICAO type designators with piston or turboprop engines, from tar1090-db.
import fs from 'node:fs';
import zlib from 'node:zlib';

const r = await fetch('https://raw.githubusercontent.com/wiedehopf/tar1090-db/master/db/icao_aircraft_types.js');
if (!r.ok) throw new Error(`tar1090-db: ${r.status}`);
const buf = Buffer.from(await r.arrayBuffer());
const types = JSON.parse((buf[0] === 0x1f ? zlib.gunzipSync(buf) : buf).toString('utf8'));
const props = Object.entries(types)
  .filter(([, v]) => /^.[0-9C][PT]$/.test(v.desc ?? ''))
  .map(([k]) => k)
  .sort();
fs.writeFileSync(new URL('../public/prop-types.json', import.meta.url), JSON.stringify(props) + '\n');
console.log(`${props.length} prop types`);
