/**
 * The master's last word (D6): a LOOKAHEAD TRUE-PEAK brick-wall limiter, ceiling −1 dBTP.
 *
 * `LimiterCore` is the whole DSP as one self-contained class (no imports, no closures over module scope) so the very same code
 * runs in Node unit tests and, stringified, inside the AudioWorklet (`limiterWorkletSource()`); an AudioWorklet module cannot
 * import our bundle.
 *
 * Per sample frame:
 *  1. detection: the largest of |x| and four 4×-oversampled interpolated values (the BS.1770 true-peak FIR) across channels,
 *     for the sample D = taps/2 frames back (where the FIR is centred);
 *  2. the gain that sample needs, min(1, ceiling / peak);
 *  3. a sliding MINIMUM of that over the next `look` frames, then a moving AVERAGE over `look` frames of the minimum: every
 *     averaged value is ≤ the requirement of the sample it is applied to (each window it averages contains that sample), so
 *     the gain is already down when a peak arrives, and it ramps smoothly (no clicks, no distortion of the waveform shape);
 *  4. release: the gain falls instantly to that envelope and recovers with a one-pole of `release` seconds;
 *  5. the audio is delayed by look + D frames to line up.
 */
export class LimiterCore {
  readonly look: number;
  readonly delayFrames: number;
  private readonly ceil: number;
  private readonly relK: number;
  private readonly phases: number[][];
  private readonly taps: number;
  private readonly half: number;
  private readonly nCh: number;
  private readonly hist: Float64Array[];
  private hpos = 0;
  private readonly dline: Float32Array[];
  private dpos = 0;
  private readonly dqIdx: Float64Array;
  private readonly dqVal: Float64Array;
  private dqHead = 0;
  private dqLen = 0;
  private readonly box: Float64Array;
  private bpos = 0;
  private bsum: number;
  private g = 1;
  private m = 0;
  /** Smallest gain applied since the last `takeMinGain()` (diagnostics). */
  private minG = 1;

  constructor(
    channels: number,
    sampleRate: number,
    lookaheadSec: number,
    ceilingLin: number,
    releaseSec: number,
    phases: number[][],
  ) {
    this.nCh = channels;
    this.look = Math.max(2, Math.round(lookaheadSec * sampleRate));
    this.ceil = ceilingLin;
    this.relK = 1 - Math.exp(-1 / Math.max(1, releaseSec * sampleRate));
    this.phases = phases;
    this.taps = phases[0]!.length;
    this.half = this.taps >> 1;
    this.delayFrames = this.look + this.half;
    this.hist = [];
    this.dline = [];
    for (let c = 0; c < channels; c++) {
      this.hist.push(new Float64Array(this.taps));
      this.dline.push(new Float32Array(this.delayFrames + 1));
    }
    const cap = this.look + 4;
    this.dqIdx = new Float64Array(cap);
    this.dqVal = new Float64Array(cap);
    this.box = new Float64Array(this.look).fill(1);
    this.bsum = this.look;
  }

  /** Process `n` frames from `inp` (one array per channel; a missing channel reads as silence) into `out`. */
  process(inp: ArrayLike<number>[], out: Float32Array[], n: number): void {
    const taps = this.taps;
    const half = this.half;
    const look = this.look;
    const cap = this.dqIdx.length;
    const win = look + 1;
    for (let i = 0; i < n; i++) {
      // 1. detection for the sample `half` frames back
      let pk = 0;
      for (let c = 0; c < this.nCh; c++) {
        const src = inp[c] ?? inp[0];
        const v = src ? src[i]! : 0;
        const h = this.hist[c]!;
        h[this.hpos] = v;
        const centre = h[(this.hpos - half + taps) % taps]!;
        const next = h[(this.hpos - half + 1 + taps) % taps]!;
        let a = centre < 0 ? -centre : centre;
        const b = next < 0 ? -next : next;
        if (b > a) a = b;
        for (let p = 0; p < this.phases.length; p++) {
          const ph = this.phases[p]!;
          let acc = 0;
          let q = this.hpos;
          for (let k = 0; k < taps; k++) {
            acc += ph[k]! * h[q]!;
            q = q === 0 ? taps - 1 : q - 1;
          }
          const ab = acc < 0 ? -acc : acc;
          if (ab > a) a = ab;
        }
        if (a > pk) pk = a;
      }
      this.hpos = (this.hpos + 1) % taps;
      // 2. requirement
      const req = pk > this.ceil ? this.ceil / pk : 1;
      // 3a. sliding minimum over the last `win` requirements (monotonic deque)
      const m = this.m++;
      while (this.dqLen > 0 && this.dqVal[(this.dqHead + this.dqLen - 1) % cap]! >= req) this.dqLen--;
      const tail = (this.dqHead + this.dqLen) % cap;
      this.dqIdx[tail] = m;
      this.dqVal[tail] = req;
      this.dqLen++;
      while (this.dqIdx[this.dqHead]! <= m - win) {
        this.dqHead = (this.dqHead + 1) % cap;
        this.dqLen--;
      }
      const hmin = this.dqVal[this.dqHead]!;
      // 3b. moving average of the minimum
      this.bsum += hmin - this.box[this.bpos]!;
      this.box[this.bpos] = hmin;
      this.bpos = (this.bpos + 1) % look;
      let env = this.bsum / look;
      if (env > hmin + 1) env = hmin + 1; // (float guard; never binding)
      // 4. release
      if (env < this.g) this.g = env;
      else this.g += (env - this.g) * this.relK;
      if (this.g < this.minG) this.minG = this.g;
      // 5. delayed audio × gain
      const rd = (this.dpos + 1) % (this.delayFrames + 1);
      for (let c = 0; c < out.length; c++) {
        const d = this.dline[Math.min(c, this.nCh - 1)]!;
        const src = inp[c] ?? inp[0];
        if (c < this.nCh) d[this.dpos] = src ? src[i]! : 0;
        out[c]![i] = d[rd]! * this.g;
      }
      this.dpos = rd;
    }
  }

  /** The smallest gain applied since the last call (1 = no limiting). */
  takeMinGain(): number {
    const g = this.minG;
    this.minG = this.g;
    return g;
  }
}

export const LIMITER_PROCESSOR = 'adeuk-true-peak-limiter';
/** −1 dBTP with a 0.2 dB margin for the 4× interpolation's own error. */
export const LIMITER_CEILING = Math.pow(10, -1.2 / 20);
export const LIMITER_LOOKAHEAD = 0.0025;
export const LIMITER_RELEASE = 0.12;

/** The AudioWorklet module: `LimiterCore` stringified (the exact code the tests run) plus a thin processor around it. */
export function limiterWorkletSource(): string {
  return `const LimiterCore = (${LimiterCore.toString()});
class AdeukTruePeakLimiter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.core = new LimiterCore(o.channels, sampleRate, o.lookahead, o.ceiling, o.release, o.phases);
    this.blocks = 0;
    this.every = Math.max(1, Math.round(sampleRate / 128 / 10));
  }
  process(inputs, outputs) {
    const inp = inputs[0] || [];
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    this.core.process(inp, out, out[0].length);
    if (++this.blocks >= this.every) {
      this.blocks = 0;
      this.port.postMessage(this.core.takeMinGain());
    }
    return true;
  }
}
registerProcessor('${LIMITER_PROCESSOR}', AdeukTruePeakLimiter);
`;
}
