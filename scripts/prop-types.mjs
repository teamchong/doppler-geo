// ICAO type designators with piston or turboprop engines from tar1090-db, ordered with active types first.
import fs from 'node:fs';
import zlib from 'node:zlib';

const outUrl = new URL('../public/prop-types.json', import.meta.url);
const sliceUrl = new URL('../test/fixtures/kampina-slice.json', import.meta.url);
const existing = fs.existsSync(outUrl) ? JSON.parse(fs.readFileSync(outUrl, 'utf8')) : [];

const r = await fetch('https://raw.githubusercontent.com/wiedehopf/tar1090-db/master/db/icao_aircraft_types.js');
if (!r.ok) throw new Error(`tar1090-db: ${r.status}`);
const buf = Buffer.from(await r.arrayBuffer());
const types = JSON.parse((buf[0] === 0x1f ? zlib.gunzipSync(buf) : buf).toString('utf8'));
const props = Object.entries(types)
  .filter(([, v]) => /^.[0-9C][PT]$/.test(v.desc ?? ''))
  .map(([k]) => k)
  .sort();
const propSet = new Set(props);

const counts = new Map();
if (fs.existsSync(sliceUrl)) {
  const slice = JSON.parse(fs.readFileSync(sliceUrl, 'utf8'));
  for (const m of Object.values(slice.ac ?? {})) {
    if (m.t && propSet.has(m.t)) counts.set(m.t, (counts.get(m.t) ?? 0) + 1);
  }
}

for (let i = 0; i < props.length; i += 750) {
  const chunk = props.slice(i, i + 750).join(',');
  try {
    const res = await fetch(`https://api.adsb.lol/v2/type/${chunk}`, { headers: { 'user-agent': 'doppler-geo/1.0' } });
    if (res.ok) {
      const txt = (await res.text()).replace(/(\s\x1f)+/g, '$1');
      const d = JSON.parse(txt);
      for (const a of d.ac ?? []) {
        if (a.t && propSet.has(a.t)) counts.set(a.t, (counts.get(a.t) ?? 0) + 1);
      }
    }
  } catch {}
}

const active = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
const priorActive = existing.slice(0, 400).filter((k) => propSet.has(k));
const ordered = [...new Set([...active, ...priorActive, ...props])];
fs.writeFileSync(outUrl, JSON.stringify(ordered) + '\n');
console.log(`${ordered.length} prop types (${active.length} active prioritized first)`);
