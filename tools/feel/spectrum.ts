/**
 * Scale-of-motion signal metrics (pure; shared by tools/feel/scale.ts and its test). See docs/briefs/scale-spec.md.
 */
import { TICK_HZ } from '@/contracts';

/* ---------------------------------------------------------------------------------------------- *
 *  spectrum
 * ---------------------------------------------------------------------------------------------- */

/**
 * Wobble rate (Hz): how often the signal turns back on itself — velocity sign reversals per second / 2, counting only
 * swings larger than `min` (signal units) so pixel-level noise does not count. A moon-scale body turns back ≤ ~1.5×/s.
 */
export function wobble(sig: ArrayLike<number>, min = 0.15, hz = TICK_HZ): number {
  let dir = 0;
  let hi = sig[0] ?? 0;
  let lo = hi;
  let ext = hi;
  let turns = 0;
  for (let i = 1; i < sig.length; i++) {
    const v = sig[i]!;
    if (dir === 0) {
      // no direction yet: the first swing larger than `min` sets it
      if (v > hi) hi = v;
      if (v < lo) lo = v;
      if (hi - v > min) {
        dir = -1;
        ext = v;
      } else if (v - lo > min) {
        dir = 1;
        ext = v;
      }
    } else if (dir > 0) {
      if (v > ext) ext = v;
      else if (ext - v > min) {
        turns++;
        dir = -1;
        ext = v;
      }
    } else if (v < ext) ext = v;
    else if (v - ext > min) {
      turns++;
      dir = 1;
      ext = v;
    }
  }
  return (turns / 2) * (hz / Math.max(1, sig.length));
}

export interface Spectral {
  /** Dominant frequency (Hz) of the detrended signal (0 when flat). */
  f0: number;
  /** Share (0..1) of the detrended signal's energy above `cut` Hz. */
  hf: number;
  /** Rms amplitude of the part above `cut` Hz (signal units). */
  hfA: number;
}

/** Detrend (least-squares line), Hann window, DFT; energy shares by frequency. O(n²), n ≤ a few hundred. */
export function spectral(sig: ArrayLike<number>, cut = 2, hz = TICK_HZ): Spectral {
  const n = sig.length;
  if (n < 8) return { f0: 0, hf: 0, hfA: 0 };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += sig[i]!;
    sxx += i * i;
    sxy += i * sig[i]!;
  }
  const b = (n * sxy - sx * sy) / Math.max(1e-12, n * sxx - sx * sx);
  const a = (sy - b * sx) / n;
  const d = new Float64Array(n);
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    wsum += w * w;
    d[i] = (sig[i]! - (a + b * i)) * w;
  }
  let total = 0;
  let high = 0;
  let best = 0;
  let bestK = 0;
  for (let k = 1; k <= n >> 1; k++) {
    let re = 0;
    let im = 0;
    const s = (2 * Math.PI * k) / n;
    for (let i = 0; i < n; i++) {
      re += d[i]! * Math.cos(s * i);
      im -= d[i]! * Math.sin(s * i);
    }
    const p = re * re + im * im;
    total += p;
    if ((k * hz) / n > cut) high += p;
    if (p > best) {
      best = p;
      bestK = k;
    }
  }
  // Parseval with the window's power: rms of the high band in signal units
  const hfA = Math.sqrt((2 * high) / (n * wsum));
  return { f0: total > 1e-9 ? (bestK * hz) / n : 0, hf: total > 1e-9 ? high / total : 0, hfA };
}

/** Spec thresholds (docs/briefs/scale-spec.md). Signal units: px for root/lean/parts, mrad for the angle. */
export const SCALE_SPEC = {
  /** Wobble (turn-backs per second / 2) of any body or part signal. */
  wobbleHz: 1.5,
  /** Rms of the part above 2.5 Hz, after the first 150 ms of the command or hit. */
  lateRms: 0.3,
  lateRmsAngle: 3,
  /** Share of energy above 2 Hz, unless the high band is negligible. */
  hfShare: 0.15,
} as const;
