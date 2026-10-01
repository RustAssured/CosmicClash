/**
 * ITU-R BS.1770-4 / EBU R128 loudness and true-peak measurement — pure math, no WebAudio (runs in Node tests and is
 * mirrored sample-for-sample by the AudioWorklet in `meterWorklet.ts`).
 *
 *  - K-weighting: the two BS.1770 biquads (high shelf + RLB high-pass), re-derived for any sample rate (libebur128 method).
 *  - Momentary (400 ms), short-term (3 s), integrated (gated: −70 LUFS absolute, −10 LU relative) loudness.
 *  - Loudness range (EBU Tech 3342: short-term values, −70 absolute / −20 LU relative gate, P95 − P10).
 *  - True peak: 4× polyphase windowed-sinc oversampling (BS.1770-4 Annex 2 recommends ≥ 4× at 48 kHz).
 *
 * The accumulator is fed 100 ms sub-blocks (sum over channels of the K-weighted mean square); 400 ms gating blocks with
 * 75 % overlap are built from four consecutive sub-blocks, exactly as the standard's hop of 100 ms.
 */

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** The two K-weighting stages for sample rate `fs`. */
export function kWeighting(fs: number): [Biquad, Biquad] {
  // stage 1: high shelf (+4 dB above ~1.7 kHz), the head's acoustic effect
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // stage 2: RLB high-pass (~38 Hz)
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const hp: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  return [shelf, hp];
}

/** One channel of K-weighting (two cascaded direct-form-I biquads), stateful across calls. */
export class KFilter {
  private readonly s: [Biquad, Biquad];
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private z1 = 0;
  private z2 = 0;

  constructor(fs: number) {
    this.s = kWeighting(fs);
  }

  /** Filter `x` and return the SUM of squares of the weighted samples (the caller divides by the sample count). */
  sumSquares(x: ArrayLike<number>, from = 0, to = x.length): number {
    const [a, b] = this.s;
    let { x1, x2, y1, y2, z1, z2 } = this;
    let acc = 0;
    for (let i = from; i < to; i++) {
      const v = x[i]!;
      const y = a.b0 * v + a.b1 * x1 + a.b2 * x2 - a.a1 * y1 - a.a2 * y2;
      x2 = x1;
      x1 = v;
      // stage 2 input is stage 1 output (y); its own x-history is y1/y2
      const z = b.b0 * y + b.b1 * y1 + b.b2 * y2 - b.a1 * z1 - b.a2 * z2;
      y2 = y1;
      y1 = y;
      z2 = z1;
      z1 = z;
      acc += z * z;
    }
    this.x1 = x1;
    this.x2 = x2;
    this.y1 = y1;
    this.y2 = y2;
    this.z1 = z1;
    this.z2 = z2;
    return acc;
  }
}

/**
 * Polyphase interpolation filter for true-peak detection: `factor` phases × `tapsPerPhase` taps, Kaiser-windowed sinc
 * with the cut-off at the ORIGINAL Nyquist. Phase p of output sample n is Σ_k h[p][k]·x[n−k]; each phase has unity DC gain.
 */
export function designTruePeakFir(factor = 4, tapsPerPhase = 16, beta = 7): Float64Array[] {
  const n = factor * tapsPerPhase;
  const centre = (n - 1) / 2;
  const i0 = (x: number): number => {
    // modified Bessel function of the first kind, order 0 (series)
    let s = 1;
    let t = 1;
    for (let k = 1; k < 40; k++) {
      t *= (x / (2 * k)) * (x / (2 * k));
      s += t;
    }
    return s;
  };
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const m = i - centre;
    const arg = m / factor;
    const sinc = arg === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg);
    const r = (2 * i) / (n - 1) - 1;
    h[i] = sinc * (i0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0(beta));
  }
  const phases: Float64Array[] = [];
  for (let p = 0; p < factor; p++) {
    const ph = new Float64Array(tapsPerPhase);
    let sum = 0;
    for (let k = 0; k < tapsPerPhase; k++) {
      ph[k] = h[k * factor + p]!;
      sum += ph[k]!;
    }
    for (let k = 0; k < tapsPerPhase; k++) ph[k]! /= sum;
    phases.push(ph);
  }
  return phases;
}

/** Streaming true-peak detector for one channel. */
export class TruePeakDetector {
  private readonly phases: Float64Array[];
  private readonly taps: number;
  private readonly hist: Float64Array;
  private pos = 0;

  constructor(phases: Float64Array[] = designTruePeakFir()) {
    this.phases = phases;
    this.taps = phases[0]!.length;
    this.hist = new Float64Array(this.taps);
  }

  /** Push samples; returns the largest absolute interpolated value among them (linear, not dB). */
  push(x: ArrayLike<number>, from = 0, to = x.length): number {
    const { phases, taps, hist } = this;
    let peak = 0;
    for (let i = from; i < to; i++) {
      const v = x[i]!;
      hist[this.pos] = v;
      this.pos = (this.pos + 1) % taps;
      // the sample itself is always a candidate (it is exact)
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      for (let p = 0; p < phases.length; p++) {
        const h = phases[p]!;
        let acc = 0;
        let j = this.pos - 1;
        for (let k = 0; k < taps; k++) {
          if (j < 0) j += taps;
          acc += h[k]! * hist[j]!;
          j--;
        }
        const b = acc < 0 ? -acc : acc;
        if (b > peak) peak = b;
      }
    }
    return peak;
  }
}

export const LUFS_FLOOR = -120;
/** Loudness of a K-weighted channel-summed mean square. */
export const lufs = (meanSquare: number): number =>
  meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : LUFS_FLOOR;
export const toDb = (lin: number): number => (lin > 0 ? 20 * Math.log10(lin) : LUFS_FLOOR);

export interface LoudnessSample {
  /** Seconds since the accumulator started. */
  t: number;
  momentary: number;
  shortTerm: number;
  /** True peak of this 100 ms sub-block, dBTP. */
  truePeak: number;
}

const percentile = (sorted: number[], p: number): number => {
  if (!sorted.length) return LUFS_FLOOR;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx]!;
};

/**
 * Integrates 100 ms sub-blocks into EBU R128 readings. `push` is called ~10×/s (not a hot path); it keeps the full
 * history of 400 ms block powers and short-term values so integrated loudness and LRA are exact over the whole run.
 */
export class LoudnessAccumulator {
  readonly blockSec: number;
  private readonly sub: number[] = [];
  /** Mean square of every 400 ms gating block (one per 100 ms hop). */
  private readonly blocks: number[] = [];
  /** Short-term (3 s) mean squares, one per hop once 3 s have elapsed. */
  private readonly short: number[] = [];
  readonly series: LoudnessSample[] = [];
  private tpMax = 0;
  private n = 0;

  constructor(blockSec = 0.1) {
    this.blockSec = blockSec;
  }

  reset(): void {
    this.sub.length = 0;
    this.blocks.length = 0;
    this.short.length = 0;
    this.series.length = 0;
    this.tpMax = 0;
    this.n = 0;
  }

  /** One 100 ms sub-block: Σ over channels of the K-weighted mean square, and its linear true peak. */
  push(meanSquareSum: number, truePeakLin: number): LoudnessSample {
    this.sub.push(meanSquareSum);
    this.n++;
    if (truePeakLin > this.tpMax) this.tpMax = truePeakLin;
    const m = this.windowMean(4);
    if (this.sub.length >= 4) this.blocks.push(m);
    const s = this.windowMean(30);
    if (this.sub.length >= 30) this.short.push(s);
    const sample: LoudnessSample = {
      t: this.n * this.blockSec,
      momentary: this.sub.length >= 4 ? lufs(m) : LUFS_FLOOR,
      shortTerm: this.sub.length >= 30 ? lufs(s) : LUFS_FLOOR,
      truePeak: toDb(truePeakLin),
    };
    this.series.push(sample);
    // keep the sub-block window bounded (only the last 30 are ever read)
    if (this.sub.length > 64) this.sub.splice(0, this.sub.length - 30);
    return sample;
  }

  private windowMean(k: number): number {
    const a = this.sub;
    const from = Math.max(0, a.length - k);
    let s = 0;
    for (let i = from; i < a.length; i++) s += a[i]!;
    return a.length ? s / (a.length - from) : 0;
  }

  get momentary(): number {
    return this.series.length ? this.series[this.series.length - 1]!.momentary : LUFS_FLOOR;
  }
  get shortTerm(): number {
    return this.series.length ? this.series[this.series.length - 1]!.shortTerm : LUFS_FLOOR;
  }
  /** Max true peak since reset, dBTP. */
  get truePeak(): number {
    return toDb(this.tpMax);
  }

  /** Gated integrated loudness (BS.1770-4 §2.8), LUFS. */
  get integrated(): number {
    const abs = this.blocks.filter((z) => lufs(z) > -70);
    if (!abs.length) return LUFS_FLOOR;
    const rel = lufs(abs.reduce((x, y) => x + y, 0) / abs.length) - 10;
    const gated = abs.filter((z) => lufs(z) > rel);
    if (!gated.length) return LUFS_FLOOR;
    return lufs(gated.reduce((x, y) => x + y, 0) / gated.length);
  }

  /** Loudness range (EBU Tech 3342), LU. */
  get range(): number {
    const abs = this.short.filter((z) => lufs(z) > -70);
    if (abs.length < 2) return 0;
    const rel = lufs(abs.reduce((x, y) => x + y, 0) / abs.length) - 20;
    const vals = abs
      .map(lufs)
      .filter((l) => l > rel)
      .sort((x, y) => x - y);
    return percentile(vals, 0.95) - percentile(vals, 0.1);
  }
}
