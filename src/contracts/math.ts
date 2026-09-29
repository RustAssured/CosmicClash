export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => (a === b ? 0 : (v - a) / (b - a));
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const sign = (v: number): -1 | 0 | 1 => (v > 0 ? 1 : v < 0 ? -1 : 0);
export const lerpAngle = (a: number, b: number, t: number): number => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return a + d * t;
};
/** Exponential approach with frame-rate-independent factor: pass dt in seconds and a half-life. */
export const damp = (cur: number, target: number, halfLifeSec: number, dtSec: number): number =>
  target + (cur - target) * Math.pow(0.5, dtSec / halfLifeSec);
export const len2 = (x: number, y: number): number => Math.sqrt(x * x + y * y);
