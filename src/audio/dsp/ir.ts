import { Rng } from '@/contracts';

export interface IrOptions {
  /** Time for the tail to fall 60 dB (RT60), seconds. */
  decay: number;
  /** Pre-delay before the diffuse tail, seconds. */
  preDelay?: number;
  /** One-pole lowpass coefficient at the start of the tail (bright) and at its end (dark), 0..1. */
  brightStart?: number;
  brightEnd?: number;
  seed?: number;
}

/**
 * Procedural impulse response for the reverb: a dense, DARK, long tail.
 *
 * Built from decorrelated white noise per channel, shaped three ways: (1) an exponential envelope that reaches −60 dB at
 * `decay` seconds; (2) a lowpass whose cutoff sweeps from bright to dark as time passes, so the tail loses highs first — how
 * a large stone hall behaves and what makes heavy blows feel enormous rather than splashy; (3) a density ramp (sparse
 * early, fully diffuse after ~60 ms) with a handful of discrete early reflections. Deterministic for a given seed.
 */
export function generateImpulseResponse(sampleRate: number, opts: IrOptions): [Float32Array, Float32Array] {
  const decay = opts.decay;
  const seconds = decay * 1.08;
  const n = Math.max(8, Math.floor(sampleRate * seconds));
  const pre = Math.floor(sampleRate * (opts.preDelay ?? 0.014));
  const a0 = opts.brightStart ?? 0.55;
  const a1 = opts.brightEnd ?? 0.035;
  const chans: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)];
  // 60 dB = ln(1000) time constants
  const tau = decay / Math.log(1000);
  for (let c = 0; c < 2; c++) {
    const rng = new Rng((opts.seed ?? 1) * 7919 + c * 104729 + 13);
    const out = chans[c]!;
    let y1 = 0;
    let y2 = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sampleRate;
      const x = rng.next() * 2 - 1;
      // darkening: the (two-pole) cutoff glides exponentially from bright to dark over the first third of the decay
      const k = Math.min(1, t / (decay * 0.35));
      const a = a0 * Math.pow(a1 / a0, k);
      y1 += a * (x - y1);
      y2 += a * (y1 - y2);
      // Two cascaded one-poles have output variance a(1+(1-a)²)/(2-a)³ for white input; dividing it out keeps the tail's
      // LEVEL on the exponential envelope while its COLOUR darkens (otherwise the filter alone would shorten the tail).
      const q = (1 - a) * (1 - a);
      const gain = 1 / Math.sqrt((a * (1 + q)) / Math.pow(2 - a, 3));
      const density = Math.min(1, t / 0.06);
      out[i] = y2 * gain * Math.exp(-t / tau) * (0.25 + 0.75 * density);
    }
    // early reflections: sparse taps 18–90 ms with alternating sign and channel-dependent timing
    for (let e = 0; e < 9; e++) {
      const dt = 0.018 + 0.008 * e + rng.next() * 0.006 + c * 0.0021;
      const idx = pre + Math.floor(dt * sampleRate);
      if (idx < n) out[idx] = (out[idx] ?? 0) + (e % 2 ? -1 : 1) * 0.5 * Math.exp(-dt / (tau * 1.6));
    }
  }
  // Unit energy per channel: a noise-like input comes out of the reverb as loud as it went in, so send levels are literal.
  let e = 0;
  for (const ch of chans) for (let i = 0; i < n; i++) e += ch[i]! * ch[i]!;
  e /= 2;
  const norm = e > 0 ? 1 / Math.sqrt(e) : 1;
  for (const ch of chans) for (let i = 0; i < n; i++) ch[i] = ch[i]! * norm;
  return chans;
}
