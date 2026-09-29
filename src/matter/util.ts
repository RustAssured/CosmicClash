/**
 * Small allocation-free helpers shared by every matter module. Everything here is safe to call in hot loops.
 */

/** Integer hash of a lattice point + seed. No allocation (unlike contracts' variadic hash32). */
export function hash2(x: number, y: number, s: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1)) | 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform [0,1) noise from a lattice point. */
export const noise2 = (x: number, y: number, s: number): number => hash2(x, y, s) / 4294967296;

/** Smooth value noise in [0,1) (bilinear over hashed lattice), for low-frequency warps. */
export function valueNoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = noise2(xi, yi, s);
  const b = noise2(xi + 1, yi, s);
  const c = noise2(xi, yi + 1, s);
  const d = noise2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export const clampI = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Clamp to a byte and round. */
export const toByte = (v: number): number => (v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0);

/** Packed-RGBA integer lerp with t in 0..256 (no float, no allocation). Alpha taken from `a`. */
export function lerpPx(a: number, b: number, t256: number): number {
  const u = 256 - t256;
  const r = ((a & 255) * u + (b & 255) * t256) >> 8;
  const g = (((a >>> 8) & 255) * u + ((b >>> 8) & 255) * t256) >> 8;
  const bl = (((a >>> 16) & 255) * u + ((b >>> 16) & 255) * t256) >> 8;
  return ((a & 0xff000000) | (bl << 16) | (g << 8) | r) >>> 0;
}

/** Multiply RGB by k256/256 (k256 may exceed 256 to brighten). Alpha preserved. */
export function scalePx(c: number, k256: number): number {
  let r = ((c & 255) * k256) >> 8;
  let g = (((c >>> 8) & 255) * k256) >> 8;
  let b = (((c >>> 16) & 255) * k256) >> 8;
  if (r > 255) r = 255;
  if (g > 255) g = 255;
  if (b > 255) b = 255;
  return ((c & 0xff000000) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Luma 0..255 of a packed colour. */
export const lumaPx = (c: number): number =>
  (((c & 255) * 77 + ((c >>> 8) & 255) * 150 + ((c >>> 16) & 255) * 29) >> 8) | 0;

/** Bayer 4×4 ordered-dither thresholds 0..15. */
export const BAYER4 = new Uint8Array([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);

/** Int32 stack (grow-on-demand, but only ever grows: steady state is allocation-free). */
export class IntStack {
  data: Int32Array;
  size = 0;
  constructor(cap = 1024) {
    this.data = new Int32Array(cap);
  }
  push(v: number): void {
    if (this.size === this.data.length) {
      const nd = new Int32Array(this.data.length * 2);
      nd.set(this.data);
      this.data = nd;
    }
    this.data[this.size++] = v;
  }
  pop(): number {
    return this.data[--this.size]!;
  }
  clear(): void {
    this.size = 0;
  }
}

/** 32-bit FNV-style mixer used by the state hash. */
export function mix32(h: number, w: number): number {
  h = Math.imul(h ^ w, 0x01000193);
  h ^= h >>> 15;
  return h | 0;
}

/** Fold a typed array's bytes into a running hash (word-at-a-time where aligned). */
export function hashBytes(h: number, a: Uint8Array | Uint32Array | Float32Array | Uint16Array | Int32Array): number {
  const buf = a.buffer;
  const off = a.byteOffset;
  const len = a.byteLength;
  const words = len >> 2;
  if ((off & 3) === 0) {
    const u = new Uint32Array(buf, off, words);
    for (let i = 0; i < words; i++) h = Math.imul(h ^ u[i]!, 0x01000193) ^ (h >>> 13);
  }
  const u8 = new Uint8Array(buf, off, len);
  for (let i = (off & 3) === 0 ? words << 2 : 0; i < len; i++) h = Math.imul(h ^ u8[i]!, 0x01000193);
  return h | 0;
}
