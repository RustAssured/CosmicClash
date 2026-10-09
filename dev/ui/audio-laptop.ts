import { KFilter, LoudnessAccumulator } from '@/telemetry/loudness';

/**
 * What WJ hears (D27: laptop speakers). A crude laptop-speaker model — a 4th-order high-pass at 200 Hz (small drivers roll off
 * ~24 dB/oct below ~200 Hz) — in front of the BS.1770 meter: the integrated loudness of a render as a laptop plays it. A mix
 * that is −20 LUFS on the meter but carries its energy in the sub reads much quieter here; one whose weight is in harmonics and
 * mid crunch holds up. Pure math (Node and browser).
 */
export const LAPTOP_HP_HZ = 200;

function highpass(x: Float32Array, fs: number, f0: number, q: number): Float32Array {
  const w = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w) / (2 * q);
  const cw = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 + cw) / 2 / a0;
  const b1 = -(1 + cw) / a0;
  const b2 = b0;
  const a1 = (-2 * cw) / a0;
  const a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    const o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = o;
    y[i] = o;
  }
  return y;
}

/** Integrated loudness (LUFS) of a stereo signal as a laptop speaker plays it. */
export function laptopLufs(left: Float32Array, right: Float32Array, fs: number): number {
  const sp = (x: Float32Array): Float32Array =>
    highpass(highpass(x, fs, LAPTOP_HP_HZ, 0.5412), fs, LAPTOP_HP_HZ, 1.3066);
  const l = sp(left);
  const r = sp(right);
  const kf = [new KFilter(fs), new KFilter(fs)];
  const acc = new LoudnessAccumulator();
  const block = Math.round(fs / 10);
  for (let i = 0; i + block <= l.length; i += block)
    acc.push((kf[0]!.sumSquares(l, i, i + block) + kf[1]!.sumSquares(r, i, i + block)) / block, 0);
  return +acc.integrated.toFixed(1);
}
