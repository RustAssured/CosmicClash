import { makeLayer, type RenderLayer } from '@/contracts';
import { DMath } from '@/contracts/dmath';

/**
 * Shared render-side kit for the titans' "living idle" animations (the approved prototypes in the idle handover package).
 * Everything here is PRESENTATION ONLY (S19): the sim never reads it, nothing feeds back, and the one clock is the sim tick
 * (fixed 1/60 s steps), so a replay, a 144 Hz display and both netplay peers see the same idle.
 *
 * - `BAY8` / `bay8`: the approved 8×8 Bayer table, `(v + 0.5) / 64` (the repo's `fx/lib.ts` dither is 4×4).
 * - `h2` / `vnoise`: the prototypes' integer hash and value noise, bit for bit; `NoiseLattice` evaluates the same noise from
 *   a per-frame table of lattice hashes, for loops that sample one noise field at thousands of cells.
 * - `IdleRng`: the prototypes' LCG, seeded per fighter (never `Math.random`, never the sim RNG).
 * - `IdleClock`: how many fixed steps to run to catch up with the sim tick.
 * - `Pool`: preallocated objects with swap-remove (no per-frame allocation, no `splice`).
 * - `BodySkin`: a behaviour-owned copy of the body's pixels presented in place of the body layer, so an idle can recolour,
 *   hide or add body pixels (an additive overlay cannot erase). It never writes `map.pixels` (hashed by the sim).
 * - `BodySpaceLayer`: a larger layer in the body's own (map) space, placed and mirrored exactly like the body, for flames,
 *   prominences and sparks drawn in map coordinates as the prototypes do.
 */

const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20,
  62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];
export const BAY8 = new Float32Array(BAYER8.map((v) => (v + 0.5) / 64));
export const bay8 = (x: number, y: number): number => BAY8[((y & 7) << 3) | (x & 7)]!;

export const clampN = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

/**
 * A sine for per-cell idle loops: a 4096-step table (built with DMath, so the same everywhere) read with linear
 * interpolation, error < 4e-7. `DMath.sin` is exact but slow in a loop of 20k cells and allocates (its range reduction
 * stores doubles in module variables, which V8 boxes).
 */
const SIN_N = 4096;
const SIN_T = new Float64Array(SIN_N + 1);
for (let i = 0; i <= SIN_N; i++) SIN_T[i] = DMath.sin((i / SIN_N) * Math.PI * 2);
const SIN_K = SIN_N / (Math.PI * 2);
export function fsin(x: number): number {
  let u = x * SIN_K;
  u -= Math.floor(u / SIN_N) * SIN_N;
  const i = u | 0;
  const a = SIN_T[i]!;
  return a + (SIN_T[i + 1]! - a) * (u - i);
}
export const fcos = (x: number): number => fsin(x + Math.PI / 2);
/** Smoothstep from a to b (the prototypes' `ss`). */
export function ss(a: number, b: number, x: number): number {
  const t = clampN((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** The prototypes' 2-D integer hash → [0, 1). */
export function h2(a: number, b: number): number {
  let x = Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663);
  x = Math.imul(x ^ (x >>> 13), 0x5bd1e995);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

/** The prototypes' value noise (smoothstep-blended lattice hashes). */
export function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = h2(xi, yi);
  const b = h2(xi + 1, yi);
  const c = h2(xi, yi + 1);
  const d = h2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/**
 * `vnoise` from a table of lattice hashes: `prepare` covers the lattice rectangle a frame's samples fall in (it hashes each
 * lattice point once), `sample` is then the same arithmetic as `vnoise` with four table reads. A sample outside the
 * prepared rectangle falls back to hashing, so the result is always exactly `vnoise`.
 */
export class NoiseLattice {
  private tab: Float32Array;
  private x0 = 0;
  private y0 = 0;
  private nx = 0;
  private ny = 0;

  constructor(cap = 4096) {
    this.tab = new Float32Array(cap);
  }

  prepare(xMin: number, yMin: number, xMax: number, yMax: number): void {
    const x0 = Math.floor(xMin);
    const y0 = Math.floor(yMin);
    const nx = Math.floor(xMax) - x0 + 2;
    const ny = Math.floor(yMax) - y0 + 2;
    if (nx * ny > this.tab.length) this.tab = new Float32Array(nx * ny);
    this.x0 = x0;
    this.y0 = y0;
    this.nx = nx;
    this.ny = ny;
    const t = this.tab;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) t[j * nx + i] = h2(x0 + i, y0 + j);
  }

  sample(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const i = xi - this.x0;
    const j = yi - this.y0;
    if (i < 0 || j < 0 || i + 1 >= this.nx || j + 1 >= this.ny) return vnoise(x, y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const t = this.tab;
    const k = j * this.nx + i;
    const a = t[k]!;
    const b = t[k + 1]!;
    const c = t[k + this.nx]!;
    const d = t[k + this.nx + 1]!;
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
}

/** The prototypes' LCG (`seed = seed * 1664525 + 1013904223`), → [0, 1). */
export class IdleRng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 4294967296;
  }
  reseed(seed: number): void {
    this.s = seed >>> 0;
  }
  /** The generator's state (a sim user folds it into its hash). */
  get state(): number {
    return this.s;
  }
}

/** A per-fighter idle seed (the prototypes used one fixed seed; the slot keeps a mirror match's two idles apart). */
export const idleSeed = (fighterSeed: number, slot: number): number =>
  (fighterSeed ^ Math.imul(slot, 0x9e37)) >>> 0;

/**
 * The idle's clock: one fixed 1/60 s step per sim tick. `due(tick)` says how many steps to run now to catch up (a frame
 * that follows two ticks runs two; ticks run without frames, e.g. an intro skipped by the harness, are all caught up, so
 * the idle depends on the ticks alone). Steps are cheap (no drawing); only a stall longer than `cap` ticks is cut short.
 */
export class IdleClock {
  /** Last sim tick stepped (-1: not started). */
  last = -1;
  /** Idle time in seconds (steps × 1/60). */
  t = 0;
  static readonly DT = 1 / 60;

  due(tick: number, cap = 600): number {
    if (this.last < 0 || tick < this.last) {
      this.last = tick;
      return 0;
    }
    const n = tick - this.last;
    this.last = tick;
    return n > cap ? cap : n;
  }

  reset(): void {
    this.last = -1;
    this.t = 0;
  }
}

/** Preallocated objects, `n` live at the front; `kill(i)` swaps the last live one into slot i (iterate i downward). */
export class Pool<T> {
  readonly items: T[];
  n = 0;
  constructor(cap: number, make: () => T) {
    this.items = [];
    for (let i = 0; i < cap; i++) this.items.push(make());
  }
  /** A free object, or null when the pool is full (the spawn is dropped). */
  alloc(): T | null {
    return this.n < this.items.length ? this.items[this.n++]! : null;
  }
  kill(i: number): void {
    const last = --this.n;
    if (i === last) return;
    const a = this.items[i]!;
    this.items[i] = this.items[last]!;
    this.items[last] = a;
  }
  clear(): void {
    this.n = 0;
  }
}

/**
 * The body's own pixels, owned by the behaviour and presented in place of the body layer (`present`). The renderer's
 * texture cache keys layers by id plus pixel buffer (render/layerCache.ts), so the skin keeps its own texture and the plain
 * body texture is still valid when the idle stops presenting.
 */
export class BodySkin {
  readonly px: Uint32Array;
  readonly emis: Uint8Array;
  private version = 1;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.px = new Uint32Array(w * h);
    this.emis = new Uint8Array(w * h);
  }

  /** Start from the live map (damage, heat and char included) before redrawing the idle's cells. */
  copyFrom(pixels: Uint32Array, emissive: Uint8Array | undefined): void {
    this.px.set(pixels);
    if (emissive) this.emis.set(emissive);
    else this.emis.fill(0);
  }

  /**
   * Swap the skin into the body layer for this frame; `changed`: it was redrawn since the last frame (a whole-layer upload).
   * Call it every frame the idle shows: the fighter points the body layer back at the map each frame.
   */
  present(body: RenderLayer, changed: boolean): void {
    if (changed) this.version++;
    body.pixels = this.px;
    body.emissive = this.emis;
    body.version = this.version;
    body.dirty = null;
  }
}

/**
 * A layer in the body's map space, `w`×`h`, whose cell (mx + offX, my + offY) lies on the body's map cell (mx, my): placed
 * with the body's position, interpolation and facing, so it mirrors and moves exactly with it (row lean is not applied:
 * effects do not shear). `offX`/`offY` are multiples of 8, so the 8×8 Bayer pattern lines up with the body's cells.
 */
export class BodySpaceLayer {
  readonly layer: RenderLayer;
  readonly px: Uint32Array;
  readonly emis: Uint8Array;
  readonly offX: number;
  readonly offY: number;
  private bx0 = 0;
  private by0 = 0;
  private bx1 = 0;
  private by1 = 0;
  private pbx0 = 0;
  private pby0 = 0;
  private pbx1 = 0;
  private pby1 = 0;
  private readonly dirtyRect = { x0: 0, y0: 0, x1: 0, y1: 0 };

  /** `cx`, `cy`: the map cell to centre the layer on (e.g. a star's core). */
  constructor(
    id: string,
    z: number,
    readonly w: number,
    readonly h: number,
    cx: number,
    cy: number,
  ) {
    this.layer = makeLayer(id, 'world', z, w, h);
    this.layer.visible = false;
    this.layer.emissive = new Uint8Array(w * h);
    this.px = this.layer.pixels;
    this.emis = this.layer.emissive;
    this.offX = Math.round((w / 2 - cx) / 8) * 8;
    this.offY = Math.round((h / 2 - cy) / 8) * 8;
  }

  /** Take the body layer's current placement (position, interpolation, facing) without redrawing. */
  follow(body: RenderLayer): void {
    const L = this.layer;
    L.x = body.x;
    L.y = body.y;
    L.prevX = body.prevX;
    L.prevY = body.prevY;
    L.facing = body.facing;
    L.lean = 0;
    L.anchorX = body.anchorX + this.offX;
    L.anchorY = body.anchorY + this.offY;
    L.alpha = body.alpha;
  }

  /** Start a frame on the body layer's current placement; clears what was drawn last frame. */
  begin(body: RenderLayer): void {
    this.follow(body);
    for (let y = this.by0; y < this.by1; y++) {
      const a = y * this.w;
      this.px.fill(0, a + this.bx0, a + this.bx1);
      this.emis.fill(0, a + this.bx0, a + this.bx1);
    }
    this.pbx0 = this.bx0;
    this.pby0 = this.by0;
    this.pbx1 = this.bx1;
    this.pby1 = this.by1;
    this.bx0 = this.w;
    this.by0 = this.h;
    this.bx1 = 0;
    this.by1 = 0;
  }

  /** Set a pixel at integer map cell (mx, my) (opaque overwrite); `e` > 0 also sets its emissive. */
  put(mx: number, my: number, c: number, e = 0): void {
    const x = mx + this.offX;
    const y = my + this.offY;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    this.px[i] = c;
    this.emis[i] = e > 255 ? 255 : e;
    if (x < this.bx0) this.bx0 = x;
    if (y < this.by0) this.by0 = y;
    if (x + 1 > this.bx1) this.bx1 = x + 1;
    if (y + 1 > this.by1) this.by1 = y + 1;
  }

  /**
   * `put` with the colour given as palette + index: packed colours (alpha 255) are beyond V8's small integers, so passing
   * them through a call boxes a number each time; a typed-array read inside the write does not.
   */
  putPal(mx: number, my: number, pal: Uint32Array, k: number, e = 0): void {
    const x = mx + this.offX;
    const y = my + this.offY;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    this.px[i] = pal[k]!;
    this.emis[i] = e > 255 ? 255 : e;
    if (x < this.bx0) this.bx0 = x;
    if (y < this.by0) this.by0 = y;
    if (x + 1 > this.bx1) this.bx1 = x + 1;
    if (y + 1 > this.by1) this.by1 = y + 1;
  }

  /** Raise a drawn pixel's emissive (glow on something already painted this frame). */
  glow(mx: number, my: number, e: number): void {
    const x = mx + this.offX;
    const y = my + this.offY;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    if (this.px[i] === 0) return;
    const v = this.emis[i]! + e;
    this.emis[i] = v > 255 ? 255 : v;
  }

  /** Finish the frame: visible if anything was drawn, dirty = last frame's box ∪ this frame's. */
  end(): void {
    const L = this.layer;
    const had = this.pbx1 > this.pbx0;
    const has = this.bx1 > this.bx0;
    L.visible = has;
    if (!had && !has) return;
    L.version++;
    const x0 = Math.min(had ? this.pbx0 : this.w, has ? this.bx0 : this.w);
    const y0 = Math.min(had ? this.pby0 : this.h, has ? this.by0 : this.h);
    const x1 = Math.max(had ? this.pbx1 : 0, has ? this.bx1 : 0);
    const y1 = Math.max(had ? this.pby1 : 0, has ? this.by1 : 0);
    const d = L.dirty;
    if (d === null) {
      const own = this.dirtyRect;
      own.x0 = x0;
      own.y0 = y0;
      own.x1 = x1;
      own.y1 = y1;
      L.dirty = own;
    } else {
      if (x0 < d.x0) d.x0 = x0;
      if (y0 < d.y0) d.y0 = y0;
      if (x1 > d.x1) d.x1 = x1;
      if (y1 > d.y1) d.y1 = y1;
    }
  }

  /** Clear everything and hide (a new round). */
  clear(): void {
    this.px.fill(0);
    this.emis.fill(0);
    this.bx0 = this.w;
    this.by0 = this.h;
    this.bx1 = 0;
    this.by1 = 0;
    this.pbx0 = this.pbx1 = this.pby0 = this.pby1 = 0;
    this.layer.visible = false;
    this.layer.version++;
    this.layer.dirty = null;
  }
}
