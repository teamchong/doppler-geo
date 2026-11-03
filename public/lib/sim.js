import { last, retardedK } from './physics.js';
import { FS } from './spectro.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// What a microphone at (ox, oy, oz) records from `start` for `dur` seconds: prop passes, mains hum, speech-like bursts, noise.
export function simulate({ passes, observer: [ox, oy, oz], start, dur, fs = FS, noise = 0.05, hum = 0.02, speech = 0, seed = 1 }) {
  const n = Math.round(dur * fs), out = new Float32Array(n), rand = rng(seed), blk = Math.round(fs / 100);
  for (const { track, f0, amp = 1, harmonics = [1, 0.5, 0.3] } of passes) {
    const ph = harmonics.map(() => rand() * 2 * Math.PI);
    for (let i0 = 0; i0 < n; i0 += blk) {
      const k = retardedK(track, ox, oy, oz, start + i0 / fs);
      if (!(k > 0)) continue;
      const a = (amp * 300) / last.R;
      for (let i = i0; i < Math.min(n, i0 + blk); i++)
        harmonics.forEach((h, j) => {
          ph[j] += (2 * Math.PI * f0 * (j + 1) * k) / fs;
          out[i] += a * h * Math.sin(ph[j]);
        });
    }
  }
  for (let i = 0; i < n; i++) {
    const g = Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    out[i] += noise * g + hum * (Math.sin((2 * Math.PI * 60 * i) / fs) + 0.5 * Math.sin((2 * Math.PI * 120 * i) / fs));
  }
  // Voiced bursts with drifting pitch, harmonics through the band.
  for (let t = 0; speech > 0 && t < dur; t += 0.5 + rand() * 2) {
    const len = 0.3 + rand() * 1.2, p0 = 90 + rand() * 130;
    let ph = 0;
    for (let i = Math.round(t * fs); i < Math.min(n, Math.round((t + len) * fs)); i++) {
      const u = (i / fs - t) / len, env = Math.sin(Math.PI * u);
      ph += (2 * Math.PI * p0 * (1 + 0.15 * Math.sin(6 * u))) / fs;
      for (let h = 1; h <= 6; h++) out[i] += (speech * env * Math.sin(h * ph)) / h;
    }
  }
  return out;
}
