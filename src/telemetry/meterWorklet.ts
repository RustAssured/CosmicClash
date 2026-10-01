/**
 * AudioWorklet source for the in-engine loudness tap. Self-contained JavaScript (an AudioWorklet module cannot import our
 * bundle), loaded from a Blob URL. It mirrors `KFilter` + `TruePeakDetector` in `loudness.ts` sample for sample; the
 * coefficients are computed by those pure functions on the main thread and passed in `processorOptions`, and
 * `meterWorklet.test.ts` runs this exact string against the pure implementation.
 *
 * Every `blockFrames` frames (100 ms) it posts `{ ms, tp }`: ms = Σ over channels of the K-weighted mean square,
 * tp = the linear true peak of that block. The node outputs silence (it is a parallel tap, never in the signal path).
 */
export const METER_PROCESSOR = 'adeuk-loudness-meter';

export const METER_WORKLET_SOURCE = String.raw`
class AdeukLoudnessMeter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.k = o.k;              // [[b0,b1,b2,a1,a2],[b0,b1,b2,a1,a2]]
    this.phases = o.phases;    // array of Float64Array-like arrays
    this.taps = this.phases[0].length;
    this.blockFrames = o.blockFrames;
    this.ch = [];
    this.acc = 0;
    this.frames = 0;
    this.peak = 0;
  }
  state(c) {
    let s = this.ch[c];
    if (!s) {
      s = { x1: 0, x2: 0, y1: 0, y2: 0, z1: 0, z2: 0, hist: new Float64Array(this.taps), pos: 0, sum: 0 };
      this.ch[c] = s;
    }
    return s;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const n = input[0].length;
    const a = this.k[0];
    const b = this.k[1];
    const phases = this.phases;
    const taps = this.taps;
    let i = 0;
    while (i < n) {
      const take = Math.min(n - i, this.blockFrames - this.frames);
      for (let c = 0; c < input.length; c++) {
        const x = input[c];
        const s = this.state(c);
        let x1 = s.x1, x2 = s.x2, y1 = s.y1, y2 = s.y2, z1 = s.z1, z2 = s.z2;
        let sum = s.sum;
        let peak = this.peak;
        const hist = s.hist;
        let pos = s.pos;
        for (let j = i; j < i + take; j++) {
          const v = x[j];
          const y = a[0] * v + a[1] * x1 + a[2] * x2 - a[3] * y1 - a[4] * y2;
          x2 = x1; x1 = v;
          const z = b[0] * y + b[1] * y1 + b[2] * y2 - b[3] * z1 - b[4] * z2;
          y2 = y1; y1 = y; z2 = z1; z1 = z;
          sum += z * z;
          hist[pos] = v;
          pos = (pos + 1) % taps;
          const av = v < 0 ? -v : v;
          if (av > peak) peak = av;
          for (let p = 0; p < phases.length; p++) {
            const h = phases[p];
            let acc = 0;
            let q = pos - 1;
            for (let k = 0; k < taps; k++) {
              if (q < 0) q += taps;
              acc += h[k] * hist[q];
              q--;
            }
            const ab = acc < 0 ? -acc : acc;
            if (ab > peak) peak = ab;
          }
        }
        s.x1 = x1; s.x2 = x2; s.y1 = y1; s.y2 = y2; s.z1 = z1; s.z2 = z2;
        s.sum = sum; s.pos = pos;
        this.peak = peak;
      }
      this.frames += take;
      i += take;
      if (this.frames >= this.blockFrames) {
        let ms = 0;
        for (let c = 0; c < this.ch.length; c++) {
          ms += this.ch[c].sum / this.frames;
          this.ch[c].sum = 0;
        }
        this.port.postMessage({ ms: ms, tp: this.peak });
        this.frames = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}
registerProcessor('${METER_PROCESSOR}', AdeukLoudnessMeter);
`;
