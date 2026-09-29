/** Small pure helpers shared by the synth, the tests and the verification page. */

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => 20 * Math.log10(Math.max(1e-9, g));
export const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
export const centsToRatio = (c: number): number => Math.pow(2, c / 1200);
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Perceptual volume: slider 0..1 → linear gain (a squared taper feels linear to the ear). */
export const volumeCurve = (v: number): number => {
  const c = clamp01(v);
  return c * c;
};

/**
 * Transfer curve of the final safety limiter (a WaveShaperNode maps [-1,1] → this table). Linear up to `knee`, then a
 * smooth tanh shoulder that asymptotes to `ceiling`. Odd-symmetric and monotonic, with |y| ≤ ceiling everywhere, so
 * whatever reaches it (WaveShaper input is clamped to ±1) leaves it at or below `ceiling` — the "nothing clips" guarantee.
 */
export function limiterCurve(n = 4097, knee = 0.72, ceiling = 0.98): Float32Array {
  const out = new Float32Array(n);
  const room = ceiling - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + room * Math.tanh((a - knee) / room);
    out[i] = Math.sign(x) * y;
  }
  return out;
}

/**
 * Transfer curve of the LAST node before the speakers: identity up to `ceiling`, flat beyond it. The soft limiter runs at 4×
 * oversampling, and its down-sampling filter can overshoot its own ceiling by ~1 dB on a hard-clipped signal; this memoryless
 * stage (no oversampling, so no filter, so no ringing) removes that residue. It only ever touches those rare overshoots.
 */
export function hardClipCurve(n = 2049, ceiling = 0.98): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = clamp((i / (n - 1)) * 2 - 1, -ceiling, ceiling);
  return out;
}

/** Exponential decay envelope samples (1 → ~0) for `setValueCurveAtTime`. */
export function expCurve(n: number, sharpness = 6): Float32Array {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = Math.exp((-sharpness * i) / Math.max(1, n - 1));
  return c;
}

/** Deterministic tiny hash → 0..1 (for per-event variation that must not depend on Math.random). */
export function hash01(a: number, b = 0): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
