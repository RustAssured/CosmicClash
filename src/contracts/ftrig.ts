import { DMath } from './dmath';

/**
 * FAST trig for PRESENTATION pixel loops (S19): overlays rasterised per pixel (the Cradle's sac and veil, the Supernova's
 * nova, …) call a dozen transcendental functions per pixel over 10⁴–10⁵ pixels; through DMath (fdlibm in software) that cost
 * up to half a second in one tick. These are table / polynomial approximations built only from + − × ÷, floor and sqrt, so
 * they are deterministic on every engine like DMath, but roughly 10× cheaper and accurate to about 1e-6 (sin / cos) and
 * 1e-5 rad (atan2 / asin): plenty for choosing a pixel's colour, NOT for sim state (keep DMath there).
 */

const N = 4096;
const MASK = N - 1;
const SCALE = N / (2 * Math.PI);
/** sin over one turn, N + 1 entries (the last repeats the first so interpolation never wraps). */
const SIN = new Float64Array(N + 1);
for (let i = 0; i <= N; i++) SIN[i] = DMath.sin((i / N) * 2 * Math.PI);

/** sin(x), table + linear interpolation (|error| < 4e-7). */
export function fsin(x: number): number {
  const t = x * SCALE;
  const f = Math.floor(t);
  const fr = t - f;
  const i = f & MASK;
  const a = SIN[i]!;
  return a + (SIN[i + 1]! - a) * fr;
}

/** cos(x) = sin(x + π/2). */
export function fcos(x: number): number {
  return fsin(x + Math.PI / 2);
}

/** atan on [-1, 1]: Abramowitz & Stegun 4.4.49, a 9th-order odd polynomial (|error| ≤ 1e-5 rad). */
function atanUnit(z: number): number {
  const z2 = z * z;
  return z * (0.999866 + z2 * (-0.3302995 + z2 * (0.180141 + z2 * (-0.085133 + z2 * 0.0208351))));
}

/** atan2(y, x), same quadrant conventions as Math.atan2 (0 for (0, 0)). */
export function fatan2(y: number, x: number): number {
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  if (ax === 0 && ay === 0) return 0;
  let r: number;
  if (ay <= ax) r = atanUnit(ay / ax);
  else r = Math.PI / 2 - atanUnit(ax / ay);
  if (x < 0) r = Math.PI - r;
  return y < 0 ? -r : r;
}

/** asin(x) for x in [-1, 1]. */
export function fasin(x: number): number {
  const c = x > 1 ? 1 : x < -1 ? -1 : x;
  return fatan2(c, Math.sqrt(1 - c * c));
}
