import { analyze } from './lib/spectro.js';
import { solve } from './lib/solver.js';
import { Dem, frameAt } from './lib/geo.js';
import { buildTrack } from './lib/physics.js';

onmessage = ({ data: { id, type, payload: p } }) => {
  try {
    let result;
    if (type === 'analyze') {
      result = analyze(p.samples);
      postMessage({ id, result }, [result.img.buffer]);
      return;
    }
    const frame = frameAt(p.lat, p.lon);
    const tracks = p.tracks.map((t) => buildTrack(t.meta, t.rows, frame)).filter(Boolean);
    result = solve({ events: p.events, tracks, frame, dem: Dem.from(p.dem), window: p.window, dur: p.dur, radius: p.radius });
    postMessage({ id, result });
  } catch (e) {
    postMessage({ id, error: e.message });
  }
};
