/**
 * Periodic waveforms for `createPeriodicWave`. Pure: the Web Audio side only hands the coefficients to an oscillator.
 *
 * Used to give a low-frequency oscillator (an LFO that drives a gain) a shape no plain sine/square/triangle has: the Nexus's
 * heartbeat is one, a lub and a softer dub per period, and it costs one node however fast or slow it beats.
 */

/** Cosine and sine coefficients (harmonics 1..`harmonics`; index 0 is the ignored DC term) of one period sampled on `x`. */
export function fourierCoefficients(
  x: ArrayLike<number>,
  harmonics: number,
): { real: Float32Array; imag: Float32Array } {
  const n = x.length;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let k = 1; k <= harmonics; k++) {
    let a = 0;
    let b = 0;
    const w = (2 * Math.PI * k) / n;
    for (let i = 0; i < n; i++) {
      a += x[i]! * Math.cos(w * i);
      b += x[i]! * Math.sin(w * i);
    }
    real[k] = (2 * a) / n;
    imag[k] = (2 * b) / n;
  }
  return { real, imag };
}

/** One period of a raised-cosine bump of `width` (fraction of the period) centred at `pos`, wrapping around the ends. */
function bump(out: Float32Array, pos: number, width: number, level: number): void {
  const n = out.length;
  for (let i = 0; i < n; i++) {
    let d = Math.abs(i / n - pos);
    d = Math.min(d, 1 - d);
    if (d < width / 2) out[i] = out[i]! + level * 0.5 * (1 + Math.cos((2 * Math.PI * d) / width));
  }
}

/** Heartbeat: a "lub" at phase 0 and a softer "dub" at phase `gap`, each a smooth bump. Values are ≥ 0 before DC removal. */
export function heartbeatWave(
  n = 512,
  gap = 0.3,
  dubLevel = 0.6,
  lubWidth = 0.1,
  dubWidth = 0.08,
): Float32Array {
  const w = new Float32Array(n);
  bump(w, 0, lubWidth, 1);
  bump(w, gap, dubWidth, dubLevel);
  return w;
}

/** Sum of a Fourier series at phase `p` (0..1), for tests. */
export function evalSeries(real: Float32Array, imag: Float32Array, p: number): number {
  let v = 0;
  for (let k = 1; k < real.length; k++)
    v += real[k]! * Math.cos(2 * Math.PI * k * p) + imag[k]! * Math.sin(2 * Math.PI * k * p);
  return v;
}
