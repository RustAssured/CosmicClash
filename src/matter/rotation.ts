import {
  ANGLE_STEPS,
  ROT_BIAS_PX,
  ROT_DEN,
  ROT_LUT,
  ROT_ONE,
  rotSampleAt,
  rotWinner,
  type RotPartEx,
} from '@/contracts';
import type { WorldPoint } from './body';
import type { ShapeQ } from './shape';

/**
 * ROTATED REGION BODIES (proposal 140, D27). Body routes every coordinate query through here when `transform.rot` is non-zero.
 *
 * A rig region body (the Witness's arms, halo, cradle: SLICE_PLAN §4.1) carries a quantised rotation. Hit truth is WHAT THE
 * RENDERER DRAWS: the shared clean-edge sampler (`@/contracts/rotation`) — `ANGLE_STEPS` steps per turn, a Q14 integer LUT
 * exact at the quadrants, 3×3 integer sub-samples per destination pixel mapped back with an exact (biased) floor division and
 * the proposal-161 ALPHA-FIRST vote (coverage = an opaque majority, then the colour among the opaque samples). The cached mask
 * below uses the contract's LUT and constants; edge pixels call the contract's own `rotSampleAt` (one implementation), and
 * `rotation.test.ts` checks every destination pixel of every angle against it.
 *
 * Body mapping: the source pivot is the map anchor (a pixel corner) drawn at the integer world pixel
 * (round(t.x), round(t.y)); `facing = -1` mirrors the map about the pivot BEFORE rotating; row-shear lean does not apply to
 * rotated regions (amended D4).
 *
 * The cache holds ONE mask per (body, angle, facing): for every destination pixel of the rotated map rectangle, the texel its
 * centre sub-sample reads and whether all nine sub-samples read that same texel (true for every interior pixel). That is pure
 * geometry, so it never goes stale under destruction; liveness and colour are read at query time, and only the few edge pixels
 * whose sub-samples straddle texels run the 9-sample vote.
 */

export { ANGLE_STEPS };
const DEN = ROT_DEN;
const DIV = ROT_DEN * ROT_ONE;
const BIAS_PX = ROT_BIAS_PX;

/** Q14 cos / sin per quantised step: THE shared LUT (`@/contracts/rotation`, the renderer samples the same table). */
export const ROT_COS = ROT_LUT.cos;
export const ROT_SIN = ROT_LUT.sin;

/** Wrap any integer step to 0..ANGLE_STEPS-1. */
export const rotStep = (k: number): number => ((k % ANGLE_STEPS) + ANGLE_STEPS) % ANGLE_STEPS;

const floorDiv = (a: number): number => Math.trunc((a + BIAS_PX * DIV) / DIV) - BIAS_PX;

/** The minimal body view the rotated hit-tests need (Body satisfies it). */
export interface RotBody {
  readonly w: number;
  readonly h: number;
  readonly map: {
    readonly material: Uint8Array;
    readonly integrity: Uint8Array;
    readonly pixels: Uint32Array;
  };
  readonly transform: { x: number; y: number; anchorX: number; anchorY: number; facing: 1 | -1 };
}

/** Map cell (j*w+i) that sub-sample (sx, sy) of destination pixel (dx, dy) — relative to the pivot pixel — reads; -1 = off-map. */
export function subCell(
  b: RotBody,
  step: number,
  facing: 1 | -1,
  dx: number,
  dy: number,
  sx: number,
  sy: number,
): number {
  const c = ROT_COS[step]!;
  const s = ROT_SIN[step]!;
  const X = DEN * dx + 2 * sx + 1;
  const Y = DEN * dy + 2 * sy + 1;
  const u = floorDiv(c * X + s * Y);
  const v = floorDiv(-s * X + c * Y);
  const t = b.transform;
  const i = facing === 1 ? t.anchorX + u : t.anchorX - 1 - u;
  const j = t.anchorY + v;
  if (i < 0 || j < 0 || i >= b.w || j >= b.h) return -1;
  return j * b.w + i;
}

/** One cached rotated mask: per destination pixel, the centre sub-sample's cell and whether all nine read it. */
export class RotMask {
  constructor(
    readonly step: number,
    readonly facing: 1 | -1,
    /** Destination rectangle, relative to the pivot pixel. */
    readonly x0: number,
    readonly y0: number,
    readonly w: number,
    readonly h: number,
    readonly centre: Int32Array,
    readonly uniform: Uint8Array,
  ) {}
}

/**
 * The destination rectangle of `b` at (step, current facing), relative to the pivot pixel: every pixel outside it draws
 * nothing. A memo of the last (step, facing, anchor, size) it was computed for (callers keep one per body: no garbage).
 */
export class RotBox {
  step = -1;
  facing: 1 | -1 = 1;
  ax = NaN;
  ay = NaN;
  bw = -1;
  bh = -1;
  x0 = 0;
  y0 = 0;
  w = 0;
  h = 0;

  /** Refresh for `b` at `step` (a no-op when nothing it depends on changed). Returns itself. */
  of(b: RotBody, step: number): RotBox {
    const t = b.transform;
    if (
      step === this.step &&
      t.facing === this.facing &&
      t.anchorX === this.ax &&
      t.anchorY === this.ay &&
      b.w === this.bw &&
      b.h === this.bh
    )
      return this;
    const c = ROT_COS[step]! / ROT_ONE;
    const s = ROT_SIN[step]! / ROT_ONE;
    let mnx = Infinity;
    let mny = Infinity;
    let mxx = -Infinity;
    let mxy = -Infinity;
    for (let k = 0; k < 4; k++) {
      const lx = ((k & 1 ? b.w : 0) - t.anchorX) * t.facing;
      const ly = (k & 2 ? b.h : 0) - t.anchorY;
      const wx = c * lx - s * ly;
      const wy = s * lx + c * ly;
      if (wx < mnx) mnx = wx;
      if (wx > mxx) mxx = wx;
      if (wy < mny) mny = wy;
      if (wy > mxy) mxy = wy;
    }
    this.step = step;
    this.facing = t.facing;
    this.ax = t.anchorX;
    this.ay = t.anchorY;
    this.bw = b.w;
    this.bh = b.h;
    this.x0 = Math.floor(mnx) - 1;
    this.y0 = Math.floor(mny) - 1;
    this.w = Math.ceil(mxx) + 1 - this.x0;
    this.h = Math.ceil(mxy) + 1 - this.y0;
    return this;
  }
}

const maskBox = new RotBox();

/** Build the mask of `b` at `step` (pure function of the map size, anchor, facing and angle). */
export function buildRotMask(b: RotBody, step: number): RotMask {
  const t = b.transform;
  const { x0, y0, w, h } = maskBox.of(b, step);
  const centre = new Int32Array(w * h);
  const uniform = new Uint8Array(w * h);
  for (let v = 0; v < h; v++)
    for (let u = 0; u < w; u++) {
      const o = v * w + u;
      const cc = subCell(b, step, t.facing, x0 + u, y0 + v, 1, 1);
      centre[o] = cc;
      let same = 1;
      for (let k = 0; k < 9 && same; k++) {
        if (k === 4) continue;
        if (subCell(b, step, t.facing, x0 + u, y0 + v, k % 3, (k / 3) | 0) !== cc) same = 0;
      }
      uniform[o] = same;
    }
  return new RotMask(step, t.facing, x0, y0, w, h, centre, uniform);
}

/**
 * Per-body cache: one mask per (angle, facing), built on first use. Masks are pure geometry that never changes, so the cache
 * can never be stale and is not simulation state (not hashed). `maxMasks` bounds memory (5 bytes per destination pixel: ~70 KB
 * for a 64×96 region); least recently used masks are dropped beyond it.
 */
export class RotMaskCache {
  private readonly masks: (RotMask | undefined)[] = new Array<RotMask | undefined>(ANGLE_STEPS * 2);
  private readonly order: number[] = [];
  builds = 0;
  constructor(
    readonly body: RotBody,
    readonly maxMasks = 12,
  ) {}

  get(step: number): RotMask {
    const k = rotStep(step) * 2 + (this.body.transform.facing === 1 ? 0 : 1);
    let m = this.masks[k];
    if (!m) {
      m = buildRotMask(this.body, rotStep(step));
      this.builds++;
      this.masks[k] = m;
      this.order.push(k);
      if (this.order.length > this.maxMasks) this.masks[this.order.shift()!] = undefined;
    } else {
      const at = this.order.indexOf(k);
      if (at !== this.order.length - 1) {
        this.order.splice(at, 1);
        this.order.push(k);
      }
    }
    return m;
  }
}

const pivotX = (b: RotBody): number => Math.round(b.transform.x);
const pivotY = (b: RotBody): number => Math.round(b.transform.y);

/** The part view handed to the contract sampler (reused: no per-query garbage). */
const part: RotPartEx = { pixels: new Uint32Array(0), w: 0, h: 0, px: 0, py: 0, step: 0, facing: 1 };

/**
 * The cell DRAWN at destination pixel (u, v) of mask `m`, or -1 where the renderer draws nothing. Interior pixels (all nine
 * sub-samples read one texel) are answered from the mask; edge pixels run THE renderer's sampler (`rotSampleAt`, proposal 161:
 * alpha-first vote, mirroring) and take its winning texel. A drawn texel whose cell is already dead (its pixel not yet
 * refreshed) is not hit.
 */
export function drawnCell(b: RotBody, m: RotMask, u: number, v: number): number {
  if (u < 0 || v < 0 || u >= m.w || v >= m.h) return -1;
  const o = v * m.w + u;
  const cc = m.centre[o]!;
  if (m.uniform[o] === 1)
    return cc < 0 || b.map.material[cc] === 0 || b.map.pixels[cc]! >>> 24 === 0 ? -1 : cc;
  const t = b.transform;
  part.pixels = b.map.pixels;
  part.w = b.w;
  part.h = b.h;
  part.px = t.anchorX;
  part.py = t.anchorY;
  part.step = m.step;
  part.facing = m.facing;
  if (rotSampleAt(part, m.x0 + u, m.y0 + v) === 0) return -1;
  const c = rotWinner.y * b.w + rotWinner.x;
  return b.map.material[c] === 0 ? -1 : c;
}
/** The cell drawn at world point (wx, wy) of the rotated body, or -1 (the renderer's pixel there). */
export function rotCellAt(b: RotBody, m: RotMask, wx: number, wy: number): number {
  return drawnCell(b, m, Math.floor(wx) - pivotX(b) - m.x0, Math.floor(wy) - pivotY(b) - m.y0);
}

/** solidAt for a rotated body: a live cell is drawn at that world point. */
export function rotSolidAt(b: RotBody, m: RotMask, wx: number, wy: number): boolean {
  return rotCellAt(b, m, wx, wy) >= 0;
}

/** World position of the CENTRE of local cell (i, j) under the rotation (float geometry for the damage models). */
export function rotCellWorld(b: RotBody, step: number, i: number, j: number, out: WorldPoint): void {
  rotLocalToWorld(b, step, i + 0.5, j + 0.5, out);
}

/** World position of continuous map-local point (lx, ly) under the rotation. */
export function rotLocalToWorld(b: RotBody, step: number, lx: number, ly: number, out: WorldPoint): void {
  const t = b.transform;
  const c = ROT_COS[step]! / ROT_ONE;
  const s = ROT_SIN[step]! / ROT_ONE;
  const mx = (lx - t.anchorX) * t.facing;
  const my = ly - t.anchorY;
  out.x = pivotX(b) + c * mx - s * my;
  out.y = pivotY(b) + s * mx + c * my;
}

/** Continuous map-local coordinates of world point (wx, wy) under the rotation (inverse of `rotCellWorld`). */
export function rotWorldToLocal(b: RotBody, step: number, wx: number, wy: number, out: WorldPoint): void {
  const t = b.transform;
  const c = ROT_COS[step]! / ROT_ONE;
  const s = ROT_SIN[step]! / ROT_ONE;
  const dx = wx - pivotX(b);
  const dy = wy - pivotY(b);
  out.x = t.anchorX + (c * dx + s * dy) * t.facing;
  out.y = t.anchorY + (-s * dx + c * dy);
}

/**
 * Body.collect for a rotated body: the live cells DRAWN inside the shape, each once, weighted at the first drawn pixel centre
 * the shape covers (row-major over destination pixels: deterministic). Same output contract as `Body.collect`, so every damage
 * model consumes it unchanged. `stamp`/`gen` deduplicate cells drawn by several pixels.
 */
export function rotCollect(
  b: RotBody,
  m: RotMask,
  q: ShapeQ,
  idx: Int32Array,
  wgt: Float32Array,
  stamp: Uint32Array,
  gen: number,
): number {
  const PX = pivotX(b);
  const PY = pivotY(b);
  const u0 = Math.max(0, Math.floor(q.bx0) - PX - m.x0);
  const v0 = Math.max(0, Math.floor(q.by0) - PY - m.y0);
  const u1 = Math.min(m.w - 1, Math.ceil(q.bx1) - PX - m.x0);
  const v1 = Math.min(m.h - 1, Math.ceil(q.by1) - PY - m.y0);
  let n = 0;
  for (let v = v0; v <= v1; v++) {
    const wy = PY + m.y0 + v + 0.5;
    for (let u = u0; u <= u1; u++) {
      const wt = q.weight(PX + m.x0 + u + 0.5, wy);
      if (wt <= 0) continue;
      const c = drawnCell(b, m, u, v);
      if (c < 0 || b.map.integrity[c] === 0 || stamp[c] === gen) continue;
      stamp[c] = gen;
      idx[n] = c;
      wgt[n] = wt;
      n++;
    }
  }
  return n;
}

/* ---- mask-free queries (the default for bodies: a rig region turns through many of the 256 steps, so per-angle masks
 *      would be rebuilt nearly every tick). Bit-identical to the cached-mask answers (rotation.test.ts checks every pixel). ---- */

/**
 * The cell DRAWN at destination pixel (dx, dy) — relative to the pivot pixel, inside `box` — of `b` at `step`, or -1: exactly
 * `drawnCell` of the mask at that step, computed on the spot. The nine sub-samples' source coordinates are monotone in the
 * sub-sample offsets, so they all read one texel iff the extreme ones do (4 divisions instead of 16).
 */
export function drawnCellAt(b: RotBody, step: number, box: RotBox, dx: number, dy: number): number {
  if (dx < box.x0 || dy < box.y0 || dx >= box.x0 + box.w || dy >= box.y0 + box.h) return -1;
  const c = ROT_COS[step]!;
  const s = ROT_SIN[step]!;
  const X = DEN * dx + 3;
  const Y = DEN * dy + 3;
  const A = c * X + s * Y;
  const B = -s * X + c * Y;
  const ea = 2 * (Math.abs(c) + Math.abs(s));
  const u = floorDiv(A);
  const v = floorDiv(B);
  const t = b.transform;
  if (floorDiv(A - ea) === u && floorDiv(A + ea) === u && floorDiv(B - ea) === v && floorDiv(B + ea) === v) {
    // interior pixel: all nine sub-samples read texel (u, v)
    const i = t.facing === 1 ? t.anchorX + u : t.anchorX - 1 - u;
    const j = t.anchorY + v;
    if (i < 0 || j < 0 || i >= b.w || j >= b.h) return -1;
    const cc = j * b.w + i;
    return b.map.material[cc] === 0 || b.map.pixels[cc]! >>> 24 === 0 ? -1 : cc;
  }
  part.pixels = b.map.pixels;
  part.w = b.w;
  part.h = b.h;
  part.px = t.anchorX;
  part.py = t.anchorY;
  part.step = step;
  part.facing = t.facing;
  if (rotSampleAt(part, dx, dy) === 0) return -1;
  const cell = rotWinner.y * b.w + rotWinner.x;
  return b.map.material[cell] === 0 ? -1 : cell;
}

/** `rotCellAt` without a mask: the cell drawn at world point (wx, wy), or -1. `box` = `RotBox.of(b, step)`. */
export function rotCellAtDirect(b: RotBody, step: number, box: RotBox, wx: number, wy: number): number {
  return drawnCellAt(b, step, box, Math.floor(wx) - pivotX(b), Math.floor(wy) - pivotY(b));
}

/** `rotCollect` without a mask: the same cells, weights and order (destination pixels row-major inside `box`). */
export function rotCollectDirect(
  b: RotBody,
  step: number,
  box: RotBox,
  q: ShapeQ,
  idx: Int32Array,
  wgt: Float32Array,
  stamp: Uint32Array,
  gen: number,
): number {
  const PX = pivotX(b);
  const PY = pivotY(b);
  const u0 = Math.max(0, Math.floor(q.bx0) - PX - box.x0);
  const v0 = Math.max(0, Math.floor(q.by0) - PY - box.y0);
  const u1 = Math.min(box.w - 1, Math.ceil(q.bx1) - PX - box.x0);
  const v1 = Math.min(box.h - 1, Math.ceil(q.by1) - PY - box.y0);
  let n = 0;
  for (let v = v0; v <= v1; v++) {
    const wy = PY + box.y0 + v + 0.5;
    for (let u = u0; u <= u1; u++) {
      const wt = q.weight(PX + box.x0 + u + 0.5, wy);
      if (wt <= 0) continue;
      const c = drawnCellAt(b, step, box, box.x0 + u, box.y0 + v);
      if (c < 0 || b.map.integrity[c] === 0 || stamp[c] === gen) continue;
      stamp[c] = gen;
      idx[n] = c;
      wgt[n] = wt;
      n++;
    }
  }
  return n;
}
