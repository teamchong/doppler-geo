import { FS } from './spectro.js';
import { WavHeader } from './schemas.js';
// Browsers resample decode and capture to this rate with a proper filter; we halve it ourselves.
const SRC = 2 * FS;

const TAPS = (() => {
  const n = 63, m = (n - 1) / 2, fc = 1600 / SRC, h = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = i - m, sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    h[i] = sinc * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1)));
  }
  const s = h.reduce((a, b) => a + b, 0);
  return h.map((v) => v / s);
})();

function decimate2(x) {
  const out = new Float32Array(Math.floor(x.length / 2)), m = (TAPS.length - 1) / 2;
  for (let o = 0; o < out.length; o++) {
    let acc = 0;
    for (let k = 0; k < TAPS.length; k++) {
      const i = 2 * o + k - m;
      if (i >= 0 && i < x.length) acc += TAPS[k] * x[i];
    }
    out[o] = acc;
  }
  return out;
}

// Any audio or video the browser can decode, mono at FS.
export async function decodeFile(file) {
  const ab = await new OfflineAudioContext(1, 1, SRC).decodeAudioData(await file.arrayBuffer());
  const mono = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) {
    const ch = ab.getChannelData(c);
    for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / ab.numberOfChannels;
  }
  return decimate2(mono);
}

// Streaming 2x decimator, same filter as decimate2 (output lags by half the filter, ~4 ms).
class Decimator {
  tail = new Float32Array(0);

  push(x) {
    const buf = new Float32Array(this.tail.length + x.length);
    buf.set(this.tail);
    buf.set(x, this.tail.length);
    const n = buf.length >= TAPS.length ? Math.floor((buf.length - TAPS.length) / 2) + 1 : 0, out = new Float32Array(n);
    for (let o = 0; o < n; o++) {
      let acc = 0;
      for (let k = 0; k < TAPS.length; k++) acc += TAPS[k] * buf[2 * o + k];
      out[o] = acc;
    }
    this.tail = buf.slice(2 * n);
    return out;
  }
}

// Raw microphone capture with all voice processing off (it eats low frequencies).
// Keeps only the last `keepS` seconds, decimated as it arrives, so memory stays flat on long sessions.
export class Recorder {
  constructor(keepS = 300, gain = 15) {
    this.keep = Math.round(keepS * FS);
    this.gain = gain;
    this.rms = 0;
  }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    this.ctx = new AudioContext({ sampleRate: SRC });
    await this.ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
    const src = this.ctx.createMediaStreamSource(this.stream),
      amp = this.ctx.createGain(),
      node = new AudioWorkletNode(this.ctx, 'tap'),
      mute = this.ctx.createGain();
    amp.gain.value = this.gain;
    mute.gain.value = 0;
    const dec = new Decimator();
    this.chunks = [];
    this.held = 0;
    this.dropped = 0;
    this.n = 0;
    this.t0 = null;
    node.port.onmessage = (e) => {
      this.t0 ??= Date.now() / 1000 - e.data.length / this.ctx.sampleRate;
      this.n += e.data.length;
      const c = dec.push(e.data);
      let s = 0, pk = 0;
      for (let i = 0; i < c.length; i++) {
        const a = Math.abs(c[i]);
        if (a > pk) pk = a;
      }
      const scale = pk > 0.85 ? 0.85 / pk : 1;
      for (let i = 0; i < c.length; i++) {
        c[i] *= scale;
        s += c[i] * c[i];
      }
      this.rms = Math.sqrt(s / Math.max(1, c.length));
      this.chunks.push(c);
      this.held += c.length;
      while (this.held - this.chunks[0].length >= this.keep) {
        const d = this.chunks.shift();
        this.held -= d.length;
        this.dropped += d.length;
      }
    };
    src.connect(amp).connect(node).connect(mute).connect(this.ctx.destination);
  }
  get seconds() {
    return this.n / SRC;
  }

  // Last `secs` (up to keepS) of audio at FS, plus how many seconds into the recording it starts.
  samples(secs = Infinity) {
    const from = Math.max(0, this.held - Math.round(secs * FS)), all = new Float32Array(this.held - from);
    let o = -from;
    for (const c of this.chunks) {
      if (o + c.length > 0) all.set(o < 0 ? c.subarray(-o) : c, Math.max(0, o));
      o += c.length;
    }
    return { x: all, offset: (this.dropped + from) / FS };
  }

  async stop() {
    this.stream.getTracks().forEach((t) => t.stop());
    await this.ctx.close();
  }
}

// 16-bit mono WAV at FS, encoded via capnstruct WavHeader (#[repr(C)]).
export function wav(x) {
  const dataBytes = x.length * 2;
  const buf = new ArrayBuffer(WavHeader.size + dataBytes);
  const hdr = WavHeader.view(buf, 0);
  hdr.riff_magic = 0x46464952; // 'RIFF'
  hdr.file_size = 36 + dataBytes;
  hdr.wave_magic = 0x45564157; // 'WAVE'
  hdr.fmt_magic = 0x20746d66; // 'fmt '
  hdr.fmt_size = 16;
  hdr.audio_format = 1;
  hdr.num_channels = 1;
  hdr.sample_rate = FS;
  hdr.byte_rate = FS * 2;
  hdr.block_align = 2;
  hdr.bits_per_sample = 16;
  hdr.data_magic = 0x61746164; // 'data'
  hdr.data_size = dataBytes;
  const pcm = new Int16Array(buf, WavHeader.size, x.length);
  for (let i = 0; i < x.length; i++) {
    pcm[i] = Math.max(-1, Math.min(1, x[i])) * 32767;
  }
  return new Blob([buf], { type: 'audio/wav' });
}
