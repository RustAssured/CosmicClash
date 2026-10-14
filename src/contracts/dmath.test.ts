import { describe, expect, it } from 'vitest';
import { DMath, sq } from './dmath';

/** Distance in units in the last place between two doubles of the same sign. */
const f64 = new Float64Array(2);
const i64 = new BigInt64Array(f64.buffer);
function ulps(a: number, b: number): number {
  if (Object.is(a, b)) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  f64[0] = a;
  f64[1] = b;
  const d = i64[0]! - i64[1]!;
  return Number(d < 0n ? -d : d);
}

/** A fixed spread of arguments: tiny, angle-sized, pixel-sized, tick-sized, both signs. */
function args(n: number, mags: number[]): number[] {
  const out: number[] = [];
  let s = 987654321;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    out.push(((s >>> 0) / 4294967296 - 0.5) * 2 * mags[i % mags.length]!);
  }
  return out;
}
const MAGS = [1e-6, 0.3, 1, 3.3, 7, 40, 900, 1e5];

function maxUlps(f: (x: number) => number, g: (x: number) => number, xs: number[]): number {
  let m = 0;
  for (const x of xs) m = Math.max(m, ulps(f(x), g(x)));
  return m;
}

describe('DMath: deterministic transcendentals (netplay Step 0)', () => {
  const xs = args(20000, MAGS);

  it('sin, cos, atan, exp and log stay within about one ulp of the engine', () => {
    expect(maxUlps(DMath.sin, Math.sin, xs)).toBeLessThanOrEqual(1);
    expect(maxUlps(DMath.cos, Math.cos, xs)).toBeLessThanOrEqual(1);
    expect(maxUlps(DMath.atan, Math.atan, xs)).toBeLessThanOrEqual(1);
    const ex = xs.map((x) => x / 1000);
    expect(maxUlps(DMath.exp, Math.exp, ex)).toBeLessThanOrEqual(1);
    const lx = xs.map((x) => Math.abs(x) + 1e-9);
    expect(maxUlps(DMath.log, Math.log, lx)).toBeLessThanOrEqual(1);
  });

  it('atan2 matches within two ulps, and every signed-zero / infinity case of the spec', () => {
    const ys = args(20000, MAGS.slice().reverse());
    let m = 0;
    for (let i = 0; i < xs.length; i++)
      m = Math.max(m, ulps(DMath.atan2(ys[i]!, xs[i]!), Math.atan2(ys[i]!, xs[i]!)));
    expect(m).toBeLessThanOrEqual(2);
    const special = [0, -0, 1, -1, Infinity, -Infinity, NaN, 1e-300, -1e300];
    for (const y of special)
      for (const x of special)
        expect(
          Object.is(DMath.atan2(y, x), Math.atan2(y, x)) || ulps(DMath.atan2(y, x), Math.atan2(y, x)) <= 1,
        ).toBe(true);
  });

  it('tan, asin, acos, pow, cbrt, tanh and hypot are close (behaviour-preserving)', () => {
    const tx = xs.filter((x) => Math.abs(Math.cos(x)) > 1e-3);
    expect(maxUlps(DMath.tan, Math.tan, tx)).toBeLessThanOrEqual(4);
    const ux = xs.map((x) => Math.max(-1, Math.min(1, x / 4)));
    for (const x of ux) {
      expect(Math.abs(DMath.asin(x) - Math.asin(x))).toBeLessThan(1e-14);
      expect(Math.abs(DMath.acos(x) - Math.acos(x))).toBeLessThan(1e-14);
    }
    for (let i = 0; i < 4000; i++) {
      const b = Math.min(1000, Math.abs(xs[i]!)) + 1e-3;
      const e = (((i * 37) % 200) - 100) / 41;
      const want = Math.pow(b, e);
      expect(Math.abs(DMath.pow(b, e) - want) / want).toBeLessThan(1e-13);
      expect(Math.abs(DMath.cbrt(xs[i]!) - Math.cbrt(xs[i]!))).toBeLessThanOrEqual(
        Math.abs(Math.cbrt(xs[i]!)) * 1e-15,
      );
      expect(Math.abs(DMath.tanh(xs[i]!) - Math.tanh(xs[i]!))).toBeLessThan(1e-15);
      expect(ulps(DMath.hypot(xs[i]!, e), Math.hypot(xs[i]!, e))).toBeLessThanOrEqual(2);
    }
    // the integer powers the sim uses are exact products
    for (const x of xs.slice(0, 2000)) {
      expect(DMath.pow(x, 2)).toBe(x * x);
      expect(sq(x)).toBe(x * x);
    }
  });

  it('follows the special cases of Math (NaN, infinities, signed zeros)', () => {
    for (const f of ['sin', 'cos', 'tan', 'atan', 'exp', 'log', 'cbrt', 'tanh', 'asin', 'acos'] as const)
      for (const x of [0, -0, Infinity, -Infinity, NaN, 2, -2]) {
        const a = DMath[f](x);
        const b = Math[f](x);
        expect(Object.is(a, b) || ulps(a, b) <= 2).toBe(true);
      }
    for (const [x, y] of [
      [0, -1],
      [-0, -3],
      [-0, 3],
      [-2, 0.5],
      [-2, 3],
      [-8, 1 / 3],
      [1, Infinity],
      [0.5, -Infinity],
      [NaN, 0],
      [Infinity, -2],
      [-Infinity, 3],
    ] as const)
      expect(Object.is(DMath.pow(x, y), Math.pow(x, y))).toBe(true);
  });

  it('is bit-stable: a digest of 10 000 results per function (cross-engine identity: tools/netplay/crossengine.ts)', () => {
    let h = 0x811c9dc5 | 0;
    const u = new Uint32Array(f64.buffer);
    const fold = (v: number): void => {
      f64[0] = v;
      h = Math.imul(h ^ u[0]!, 0x01000193);
      h = Math.imul(h ^ u[1]!, 0x01000193);
    };
    for (const x of xs.slice(0, 10000)) {
      fold(DMath.sin(x));
      fold(DMath.cos(x));
      fold(DMath.tan(x));
      fold(DMath.atan(x));
      fold(DMath.atan2(x, 1.5 - x));
      fold(DMath.exp(x / 1000));
      fold(DMath.log(Math.abs(x) + 1e-9));
      fold(DMath.pow(Math.abs(x) + 0.5, x / 900));
      fold(DMath.hypot(x, 2 * x - 1));
      fold(DMath.cbrt(x));
      fold(DMath.tanh(x / 10));
    }
    // If DMath changes on purpose, update this digest AND re-run the cross-engine check (every engine must agree).
    expect((h >>> 0).toString(16)).toBe('92f6b8dc');
  });
});
