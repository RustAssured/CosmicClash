/**
 * Deterministic seeded RNG (sfc32). Never call Math.random() inside the simulation,
 * the titan generators, or the AI: replays and AI-vs-AI tests must reproduce exactly.
 */

/** 32-bit integer hash of up to any number of ints (used to derive sub-seeds). */
export function hash32(...vals: number[]): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < vals.length; i++) {
    h ^= vals[i]! | 0;
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

/** Hash a string to an int (for labelled forks). */
export function hashString(s: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed = 1) {
    const s = seed >>> 0;
    this.a = 0x9e3779b9 ^ s;
    this.b = 0x243f6a88 ^ Math.imul(s, 0x85ebca6b);
    this.c = 0xb7e15162 ^ Math.imul(s, 0xc2b2ae35);
    this.d = 1;
    for (let i = 0; i < 15; i++) this.nextU32();
  }

  /** Uniform 32-bit unsigned integer. */
  nextU32(): number {
    this.a |= 0;
    this.b |= 0;
    this.c |= 0;
    this.d |= 0;
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform float in [a, b). */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** Uniform int in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Uniform int in [a, b] inclusive. */
  intRange(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Approximately normal (sum of uniforms), mean 0, sd ~1. */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)]!;
  }

  /** Independent child stream; the same (parent state, label) always yields the same child. */
  fork(label: string | number = 0): Rng {
    const l = typeof label === 'string' ? hashString(label) : label;
    return new Rng(hash32(this.nextU32(), l));
  }

  /** Snapshot / restore (for lookahead and tests). */
  getState(): [number, number, number, number] {
    return [this.a, this.b, this.c, this.d];
  }
  setState(s: readonly [number, number, number, number]): void {
    this.a = s[0];
    this.b = s[1];
    this.c = s[2];
    this.d = s[3];
  }
}

/** Stateless per-cell hash noise in [0,1): deterministic value from integer lattice coordinates. */
export function hashNoise2(x: number, y: number, seed = 0): number {
  return hash32(x, y, seed) / 4294967296;
}
