// Posts mic samples to the main thread in 4096-sample chunks.
registerProcessor(
  'tap',
  class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.buf = new Float32Array(4096);
      this.n = 0;
    }

    process(inputs) {
      const ch = inputs[0][0];
      if (!ch) return true;
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf);
          this.buf = new Float32Array(4096);
          this.n = 0;
        }
      }
      return true;
    }
  },
);
