/**
 * Deterministic 2D noise for the titan art toolkit. Integer-hash based (no Math.random, no allocation per call),
 * fast enough to evaluate a few dozen times per cell for a 25k-cell body at load.
 */

const F = 1 / 4294967296;

/** 32-bit integer hash of a lattice point and a seed → [0, 2^32). */
export function ihash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash → [0,1). */
export const hash01 = (x: number, y: number, seed: number): number => ihash2(x, y, seed) * F;

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Gradient noise (Perlin-style, unit gradients from the hash) in about [-1, 1]. */
export function gradNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const g = (ix: number, iy: number, dx: number, dy: number): number => {
    const a = ihash2(ix, iy, seed) * F * 6.283185307179586;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const n00 = g(xi, yi, xf, yf);
  const n10 = g(xi + 1, yi, xf - 1, yf);
  const n01 = g(xi, yi + 1, xf, yf - 1);
  const n11 = g(xi + 1, yi + 1, xf - 1, yf - 1);
  const u = fade(xf);
  const v = fade(yf);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 1.41421356;
}

/** Smooth value noise in [0, 1). */
export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = fade(x - xi);
  const v = fade(y - yi);
  const a = hash01(xi, yi, seed);
  const b = hash01(xi + 1, yi, seed);
  const c = hash01(xi, yi + 1, seed);
  const d = hash01(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal Brownian motion of gradient noise, normalised to about [-1, 1]. */
export function fbm(x: number, y: number, seed: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let o = 0; o < octaves; o++) {
    sum += amp * gradNoise(fx, fy, seed + o * 101);
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal in [0, 1]: sharp crests (veins, ridgelines, strata). */
export function ridged(x: number, y: number, seed: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(gradNoise(fx, fy, seed + o * 57));
    sum += amp * n * n;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return sum / norm;
}

/** Cellular (Worley) noise result: nearest / second-nearest feature distances and the nearest cell's id hash. */
export interface WorleyResult {
  f1: number;
  f2: number;
  /** Hash of the nearest feature point's lattice cell in [0,1). */
  id: number;
  /** Nearest feature point position. */
  px: number;
  py: number;
}

export function makeWorley(): WorleyResult {
  return { f1: 0, f2: 0, id: 0, px: 0, py: 0 };
}

/** Worley noise with jittered feature points; `out` is reused. Scale is in lattice cells. */
export function worley(x: number, y: number, seed: number, out: WorleyResult, jitter = 0.9): WorleyResult {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  let id = 0;
  let bx = 0;
  let by = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i;
      const cy = yi + j;
      const h = ihash2(cx, cy, seed);
      const fx = cx + 0.5 + ((h & 0xffff) / 65535 - 0.5) * jitter;
      const fy = cy + 0.5 + ((h >>> 16) / 65535 - 0.5) * jitter;
      const dx = fx - x;
      const dy = fy - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = h * F;
        bx = fx;
        by = fy;
      } else if (d < f2) f2 = d;
    }
  }
  out.f1 = f1;
  out.f2 = f2;
  out.id = id;
  out.px = bx;
  out.py = by;
  return out;
}

/** Recursive Bayer matrix of side `n` (power of two), thresholds in (0,1). */
function bayerMatrix(n: number): Float32Array {
  let side = 1;
  let m = new Float32Array([0]);
  while (side < n) {
    const ns = side * 2;
    const next = new Float32Array(ns * ns);
    const quad = [0, 2, 3, 1];
    for (let y = 0; y < ns; y++) {
      for (let x = 0; x < ns; x++) {
        const base = m[(y % side) * side + (x % side)]!;
        next[y * ns + x] = 4 * base + quad[(y >= side ? 2 : 0) + (x >= side ? 1 : 0)]!;
      }
    }
    m = next;
    side = ns;
  }
  return m.map((v) => (v + 0.5) / (n * n));
}

/** 4×4 and 8×8 Bayer ordered-dither thresholds in (0,1). */
export const BAYER4 = bayerMatrix(4);
export const BAYER8 = bayerMatrix(8);

export const bayer4 = (x: number, y: number): number => BAYER4[((y & 3) << 2) | (x & 3)]!;
export const bayer8 = (x: number, y: number): number => BAYER8[((y & 7) << 3) | (x & 7)]!;
