import { RpcTarget, newMessagePortRpcSession, transferArrayBuffer } from './lib/vendor/capnweb.js';
import { analyze } from './lib/spectro.js';
import { solve } from './lib/solver.js';
import { Dem, frameAt } from './lib/geo.js';
import { buildTrack } from './lib/physics.js';

class AnalyzerService extends RpcTarget {
  analyze(samples) {
    const result = analyze(samples);
    transferArrayBuffer(result.img);
    return result;
  }

  solve(p) {
    const frame = frameAt(p.lat, p.lon);
    const tracks = p.tracks.map((t) => buildTrack(t.meta, t.rows, frame)).filter(Boolean);
    return solve({ events: p.events, tracks, frame, dem: Dem.from(p.dem), window: p.window, dur: p.dur, radius: p.radius });
  }
}

onmessage = ({ data }) => {
  if (data?.rpcPort) {
    newMessagePortRpcSession(data.rpcPort, new AnalyzerService());
  }
};
