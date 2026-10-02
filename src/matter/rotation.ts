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
import { K_CONE, K_POINT, type ShapeQ } from './shape';

/** Margin (texels) of the rotated map rectangle that bounds the drawn pixels (sub-samples reach 0.47 px from the centre). */
const RECT_PAD = 1.5;

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
/** Local copies of contract constants used per query (a bundler's live-binding getter per read is not free in hot paths). */
const STEPS = ANGLE_STEPS;
const ONE = ROT_ONE;
export const rotStep = (k: number): number => ((k % STEPS) + STEPS) % STEPS;

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
    const c = ROT_COS[step]! / ONE;
    const s = ROT_SIN[step]! / ONE;
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
  const c = ROT_COS[step]! / ONE;
  const s = ROT_SIN[step]! / ONE;
  const mx = (lx - t.anchorX) * t.facing;
  const my = ly - t.anchorY;
  out.x = pivotX(b) + c * mx - s * my;
  out.y = pivotY(b) + s * mx + c * my;
}

/** Continuous map-local coordinates of world point (wx, wy) under the rotation (inverse of `rotCellWorld`). */
export function rotWorldToLocal(b: RotBody, step: number, wx: number, wy: number, out: WorldPoint): void {
  const t = b.transform;
  const c = ROT_COS[step]! / ONE;
  const s = ROT_SIN[step]! / ONE;
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

/*
 * Sub-sample patterns. Within one destination pixel the nine sub-samples span less than one texel per source axis (extent
 * (4/6)·(|cos|+|sin|) ≤ 0.95 px), so they read at most 2 × 2 texels: texel code k = du | dv << 1 relative to the lowest one.
 * Which samples take du = 1 depends only on how far the pixel's lowest A sits below the next texel boundary: the samples whose
 * offset reaches it, i.e. the `rankA` largest offsets of the step (ties never split, the threshold is a value). Same for v. So a
 * pixel's whole pattern is one of 10 × 10 per step, precomputed lazily: per texel code its sample count, the centre sample's
 * code, and the codes in order of first appearance among the non-centre samples (the vote's tie order).
 */
const PAT = 100;
/** Per step: the nine sample offsets above the grid minimum, sorted descending (A then B). */
const patOffA = new Int32Array(ANGLE_STEPS * 9);
const patOffB = new Int32Array(ANGLE_STEPS * 9);
const patReady = new Uint8Array(ANGLE_STEPS);
/** Per (step, rankA, rankB): sample count per texel code, the centre's code, codes by first appearance (4 = none). */
const patCount = new Uint8Array(ANGLE_STEPS * PAT * 4);
const patCentre = new Uint8Array(ANGLE_STEPS * PAT);
const patOrder = new Uint8Array(ANGLE_STEPS * PAT * 4);
const sortIdx = new Int32Array(9);
const offTmp = new Int32Array(9);

function sortDesc(off: Int32Array, idx: Int32Array): void {
  for (let k = 0; k < 9; k++) idx[k] = k;
  for (let a = 1; a < 9; a++) {
    const v = idx[a]!;
    let b = a;
    while (b > 0 && off[idx[b - 1]!]! < off[v]!) {
      idx[b] = idx[b - 1]!;
      b--;
    }
    idx[b] = v;
  }
}

function buildPatterns(step: number): void {
  const c = ROT_COS[step]!;
  const s = ROT_SIN[step]!;
  const minA = 4 * (c < 0 ? c : 0) + 4 * (s < 0 ? s : 0);
  const minB = 4 * (s > 0 ? -s : 0) + 4 * (c < 0 ? c : 0);
  const topA = new Uint8Array(9 * 10);
  const topB = new Uint8Array(9 * 10);
  for (let axis = 0; axis < 2; axis++) {
    for (let k = 0; k < 9; k++) {
      const sx = k % 3;
      const sy = (k / 3) | 0;
      offTmp[k] = axis === 0 ? 2 * c * sx + 2 * s * sy - minA : -2 * s * sx + 2 * c * sy - minB;
    }
    sortDesc(offTmp, sortIdx);
    const dst = axis === 0 ? patOffA : patOffB;
    const top = axis === 0 ? topA : topB;
    for (let r = 0; r < 9; r++) dst[step * 9 + r] = offTmp[sortIdx[r]!]!;
    // top[r*9 + k] = 1 when sample k is among the r largest offsets
    for (let r = 0; r <= 9; r++) for (let q = 0; q < r; q++) top[r * 9 + sortIdx[q]!] = 1;
  }
  for (let ra = 0; ra <= 9; ra++)
    for (let rb = 0; rb <= 9; rb++) {
      const e = step * PAT + ra * 10 + rb;
      let seen = 0;
      let no = 0;
      for (let q = 0; q < 4; q++) patOrder[e * 4 + q] = 4;
      for (let k = 0; k < 9; k++) {
        const code = topA[ra * 9 + k]! | (topB[rb * 9 + k]! << 1);
        patCount[e * 4 + code]!++;
        if (k === 4) patCentre[e] = code;
        else if ((seen & (1 << code)) === 0) {
          seen |= 1 << code;
          patOrder[e * 4 + no++] = code;
        }
      }
    }
  patReady[step] = 1;
}

/** Colour (0 = transparent / off-map) and cell (-1 = off-map) of the 4 candidate texels, and each one's vote count. */
const texCol = new Uint32Array(4);
const texCell = new Int32Array(4);
const texVotes = new Int32Array(4);

/* The body a query runs against, loaded once per query (not per pixel). */
let qW = 0;
let qH = 0;
let qAx = 0;
let qAy = 0;
let qMirror = false;
let qPx: Uint32Array = new Uint32Array(0);
let qMat: Uint8Array = new Uint8Array(0);

function loadBody(b: RotBody): void {
  const t = b.transform;
  qW = b.w;
  qH = b.h;
  qAx = t.anchorX;
  qAy = t.anchorY;
  qMirror = t.facing !== 1;
  qPx = b.map.pixels;
  qMat = b.map.material;
}

/** Lowest-sample offsets of the 3×3 grid for `step` (A then B), added to the origin sample's A0 / B0. */
const loA = (c: number, s: number): number => 4 * (c < 0 ? c : 0) + 4 * (s < 0 ? s : 0);
const loB = (c: number, s: number): number => 4 * (s > 0 ? -s : 0) + 4 * (c < 0 ? c : 0);

/**
 * The cell DRAWN at destination pixel (dx, dy) — relative to the pivot pixel, inside `box` — of `b` at `step`, or -1: exactly
 * `drawnCell` of the mask at that step (and the contract sampler `rotSampleAt` + the winning texel), computed on the spot.
 *
 * The nine sub-samples span less than one texel in each source axis (their extent is (4/6)·(|cos|+|sin|) ≤ 0.95 px), so they
 * read at most 2 × 2 texels: one exact floor division per axis for the lowest sample, then the precomputed pattern of the
 * step (see `buildPatterns`). The vote is the contract's alpha-first vote over those ≤ 4 colours (same counts, same tie
 * order), so the result is bit-identical; `rotation.test.ts` checks every pixel of every angle and facing against the cached
 * mask and the sampler, on pristine and wounded bodies.
 */
export function drawnCellAt(b: RotBody, step: number, box: RotBox, dx: number, dy: number): number {
  if (dx < box.x0 || dy < box.y0 || dx >= box.x0 + box.w || dy >= box.y0 + box.h) return -1;
  const c = ROT_COS[step]!;
  const s = ROT_SIN[step]!;
  // sub-sample (sx, sy): X = DEN·dx + 2·sx + 1, Y = DEN·dy + 2·sy + 1; A = c·X + s·Y (→ u), B = −s·X + c·Y (→ v)
  const X0 = DEN * dx + 1;
  const Y0 = DEN * dy + 1;
  // the lowest A / B over the 3×3 grid, and its texel column / row
  const aLo = c * X0 + s * Y0 + loA(c, s);
  const bLo = -s * X0 + c * Y0 + loB(c, s);
  const u0 = floorDiv(aLo);
  const v0 = floorDiv(bLo);
  if (patReady[step] === 0) buildPatterns(step);
  loadBody(b);
  return drawnCore(step, u0, v0, (u0 + 1) * DIV - aLo, (v0 + 1) * DIV - bLo);
}

/**
 * The drawn cell of a pixel whose lowest sub-sample reads texel (u0, v0) and sits tA / tB (in (0, DIV]) below the next texel
 * boundary on each axis, for the body `loadBody` loaded. A sample reads u0 + 1 iff its offset above the lowest one reaches tA:
 * exactly the rankA largest offsets (exact integers).
 */
function drawnCore(step: number, u0: number, v0: number, tA: number, tB: number): number {
  const w = qW;
  const h = qH;
  const px = qPx;
  const mat = qMat;
  // the 2 × 2 candidate texels (code k = du | dv << 1), read once; off-map = no cell, transparent = colour 0
  const iA = qMirror ? qAx - 1 - u0 : qAx + u0;
  const iB = qMirror ? iA - 1 : iA + 1;
  const jA = qAy + v0;
  const inA = iA >= 0 && iA < w;
  const inB = iB >= 0 && iB < w;
  const inJA = jA >= 0 && jA < h;
  const inJB = jA + 1 >= 0 && jA + 1 < h;
  const cell0 = inA && inJA ? jA * w + iA : -1;
  const cell1 = inB && inJA ? jA * w + iB : -1;
  const cell2 = inA && inJB ? (jA + 1) * w + iA : -1;
  const cell3 = inB && inJB ? (jA + 1) * w + iB : -1;
  let p0 = cell0 >= 0 ? px[cell0]! : 0;
  let p1 = cell1 >= 0 ? px[cell1]! : 0;
  let p2 = cell2 >= 0 ? px[cell2]! : 0;
  let p3 = cell3 >= 0 ? px[cell3]! : 0;
  if (p0 >>> 24 === 0) p0 = 0;
  if (p1 >>> 24 === 0) p1 = 0;
  if (p2 >>> 24 === 0) p2 = 0;
  if (p3 >>> 24 === 0) p3 = 0;
  // nothing opaque under any sub-sample: nothing drawn (empty map areas, the common case at a sparse region's edge)
  if (p0 === 0 && p1 === 0 && p2 === 0 && p3 === 0) return -1;
  const o9 = step * 9;
  let rankA = 0;
  while (rankA < 9 && patOffA[o9 + rankA]! >= tA) rankA++;
  let rankB = 0;
  while (rankB < 9 && patOffB[o9 + rankB]! >= tB) rankB++;
  if ((rankA === 0 || rankA === 9) && (rankB === 0 || rankB === 9)) {
    // all nine sub-samples read one texel: drawn iff it is opaque (and still live)
    const k = (rankA === 9 ? 1 : 0) | (rankB === 9 ? 2 : 0);
    const cc = k === 0 ? cell0 : k === 1 ? cell1 : k === 2 ? cell2 : cell3;
    const pc = k === 0 ? p0 : k === 1 ? p1 : k === 2 ? p2 : p3;
    return cc < 0 || pc === 0 || mat[cc] === 0 ? -1 : cc;
  }
  const e = step * PAT + rankA * 10 + rankB;
  const e4 = e * 4;
  texCell[0] = cell0;
  texCell[1] = cell1;
  texCell[2] = cell2;
  texCell[3] = cell3;
  texCol[0] = p0;
  texCol[1] = p1;
  texCol[2] = p2;
  texCol[3] = p3;
  let opaque = 0;
  for (let k = 0; k < 4; k++) {
    const n = patCount[e4 + k]!;
    // a texel no sub-sample reads takes no part in the vote
    if (n === 0) texCol[k] = 0;
    else if (texCol[k] !== 0) opaque += n;
  }
  // alpha-first: an opaque majority decides whether anything is drawn
  if (opaque < 5) return -1;
  // then the colour among the opaque samples (votes count equal COLOURS); ties keep the centre, then the first in scan order
  for (let k = 0; k < 4; k++) {
    const ck = texCol[k]!;
    let n = 0;
    if (ck !== 0) for (let q = 0; q < 4; q++) if (texCol[q] === ck) n += patCount[e4 + q]!;
    texVotes[k] = n;
  }
  const kc = patCentre[e]!;
  let bestN = texVotes[kc]!;
  let at = kc;
  for (let q = 0; q < 4; q++) {
    const k = patOrder[e4 + q]!;
    if (k === 4) break;
    if (texVotes[k]! > bestN) {
      bestN = texVotes[k]!;
      at = k;
    }
  }
  const cell = texCell[at]!;
  return mat[cell] === 0 ? -1 : cell;
}

/**
 * Per-body memo of drawn cells for ONE (angle, facing, anchor) and ONE state of the body's cells. Every probe of a tick (a blow's
 * look-ahead probes the same spot up to 9 times, then the receive and the damage collect it again) re-reads it instead of
 * re-running the sampler. Entries are valid only while the key is unchanged: the angle step / facing / anchor / box, the map's
 * `version` (bumped whenever `map.pixels` is refreshed) and the body's `cellEpoch` (bumped by every `touch`/`touchPoint`, i.e.
 * by every cell mutation, `killCell` included). Any change starts a new generation, so a stale answer is never read. Not
 * simulation state (pure cache of a pure function of the state).
 */
export class RotHitCache {
  private cell: Int32Array = new Int32Array(0);
  private stamp: Uint32Array = new Uint32Array(0);
  private gen = 0;
  private kStep = -1;
  private kFacing = 0;
  private kAx = NaN;
  private kAy = NaN;
  private kBoxW = -1;
  private kVersion = -1;
  private kEpoch = -1;
  /** Box width of the current key (the memo's row stride). */
  stride = 0;

  /** Validate the memo for `b` at `step` (box = `RotBox.of(b, step)`); a changed key starts a new generation. */
  begin(b: RotBody, step: number, box: RotBox, version: number, epoch: number): void {
    const t = b.transform;
    if (
      step === this.kStep &&
      t.facing === this.kFacing &&
      t.anchorX === this.kAx &&
      t.anchorY === this.kAy &&
      box.w === this.kBoxW &&
      version === this.kVersion &&
      epoch === this.kEpoch
    )
      return;
    this.kStep = step;
    this.kFacing = t.facing;
    this.kAx = t.anchorX;
    this.kAy = t.anchorY;
    this.kBoxW = box.w;
    this.kVersion = version;
    this.kEpoch = epoch;
    this.stride = box.w;
    const need = box.w * box.h;
    if (this.stamp.length < need) {
      // sized for the largest box at any angle (allocated once per body)
      const r = Math.hypot(Math.max(t.anchorX, b.w - t.anchorX), Math.max(t.anchorY, b.h - t.anchorY));
      const side = Math.ceil(2 * r) + 6;
      const cap = Math.max(need, side * side);
      this.cell = new Int32Array(cap);
      this.stamp = new Uint32Array(cap);
      this.gen = 0;
    }
    if (++this.gen > 0xfffffff0) {
      this.stamp.fill(0);
      this.gen = 1;
    }
  }

  /** The memoised drawn cell at box pixel `o` (row-major, `stride`), or -2 when not known for the current key. */
  get(o: number): number {
    return this.stamp[o] === this.gen ? this.cell[o]! : -2;
  }

  put(o: number, c: number): void {
    this.stamp[o] = this.gen;
    this.cell[o] = c;
  }
}

/** `rotCellAt` without a mask: the cell drawn at world point (wx, wy), or -1. `box` = `RotBox.of(b, step)`. */
export function rotCellAtDirect(b: RotBody, step: number, box: RotBox, wx: number, wy: number): number {
  return drawnCellAt(b, step, box, Math.floor(wx) - pivotX(b), Math.floor(wy) - pivotY(b));
}

/** `rotCellAtDirect` through a body's memo (`memo.begin` already called for this step and state). */
export function rotCellAtCached(
  b: RotBody,
  step: number,
  box: RotBox,
  memo: RotHitCache,
  wx: number,
  wy: number,
): number {
  const dx = Math.floor(wx) - pivotX(b);
  const dy = Math.floor(wy) - pivotY(b);
  if (dx < box.x0 || dy < box.y0 || dx >= box.x0 + box.w || dy >= box.y0 + box.h) return -1;
  const o = (dy - box.y0) * memo.stride + (dx - box.x0);
  const m = memo.get(o);
  if (m !== -2) return m;
  const c = drawnCellAt(b, step, box, dx, dy);
  memo.put(o, c);
  return c;
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
  memo: RotHitCache | null = null,
): number {
  const PX = pivotX(b);
  const PY = pivotY(b);
  const u0 = Math.max(0, Math.floor(q.bx0) - PX - box.x0);
  const v0 = Math.max(0, Math.floor(q.by0) - PY - box.y0);
  const u1 = Math.min(box.w - 1, Math.ceil(q.bx1) - PX - box.x0);
  const v1 = Math.min(box.h - 1, Math.ceil(q.by1) - PY - box.y0);
  if (u0 > u1 || v0 > v1) return 0;
  const stride = memo !== null ? memo.stride : 0;
  const isPoint = q.kind === K_POINT;
  const qx = q.x;
  const qy = q.y;
  const qr2 = q.r2;
  if (patReady[step] === 0) buildPatterns(step);
  loadBody(b);
  const integ = b.map.integrity;
  const c = ROT_COS[step]!;
  const s = ROT_SIN[step]!;
  const la = loA(c, s);
  const lb = loB(c, s);
  // one pixel to the right moves every sample by DEN in X: A by DEN·c, B by −DEN·s (|·| ≤ DIV, so one carry at most)
  const stepA = DEN * c;
  const stepB = -DEN * s;
  // The map rectangle in the rotated frame (texel u along cos/sin, v across), widened by RECT_PAD: a pixel whose centre is
  // outside it has every sub-sample off the map, so it draws nothing (skipping it changes no result; `drawnCore` still decides
  // every pixel inside). Halves the pixels visited at diagonal angles.
  const fc = c / ONE;
  const fs = s / ONE;
  const ax = qAx;
  const uLo = (qMirror ? ax - qW : -ax) - RECT_PAD;
  const uHi = (qMirror ? ax : qW - ax) + RECT_PAD;
  const vLo = -qAy - RECT_PAD;
  const vHi = qH - qAy + RECT_PAD;
  const coneR = q.kind === K_CONE ? q.range : -1;
  let n = 0;
  for (let v = v0; v <= v1; v++) {
    const wy = PY + box.y0 + v + 0.5;
    const ddy = wy - qy;
    const ddy2 = ddy * ddy;
    // the shape's chord on this row (circular kinds; others their box), widened by a pixel: `weight` still decides each pixel
    if (!q.rowSpan(wy)) continue;
    let xa = q.sx0;
    let xb = q.sx1;
    if (coneR >= 0) {
      // a cone lies inside the disc of its range around its apex
      const d2 = coneR * coneR - ddy2;
      if (d2 < 0) continue;
      const hh = Math.sqrt(d2);
      if (qx - hh > xa) xa = qx - hh;
      if (qx + hh < xb) xb = qx + hh;
    }
    let ua = Math.max(u0, Math.floor(xa) - PX - box.x0 - 1);
    let ub = Math.min(u1, Math.ceil(xb) - PX - box.x0 + 1);
    if (ua > ub) continue;
    // clip to the rotated map rectangle: texel u = fc·x + fs·y, v = −fs·x + fc·y (x, y: pixel centre relative to the pivot)
    const py = box.y0 + v + 0.5;
    let xl = -Infinity;
    let xr = Infinity;
    for (let axis = 0; axis < 2; axis++) {
      const k = axis === 0 ? fc : -fs;
      const base = axis === 0 ? fs * py : fc * py;
      const lo = (axis === 0 ? uLo : vLo) - base;
      const hi = (axis === 0 ? uHi : vHi) - base;
      if (k > 1e-6) {
        xl = Math.max(xl, lo / k);
        xr = Math.min(xr, hi / k);
      } else if (k < -1e-6) {
        xl = Math.max(xl, hi / k);
        xr = Math.min(xr, lo / k);
      } else if (lo > 0 || hi < 0) xr = -Infinity;
    }
    if (xl > xr) continue;
    if (xl > -1e9) ua = Math.max(ua, Math.floor(xl - 0.5) - box.x0 - 1);
    if (xr < 1e9) ub = Math.min(ub, Math.ceil(xr - 0.5) - box.x0 + 1);
    if (ua > ub) continue;
    // exact floor divisions for the row's first pixel, then integer carries along the row
    const dy = box.y0 + v;
    const X0 = DEN * (box.x0 + ua) + 1;
    const Y0 = DEN * dy + 1;
    const aLo = c * X0 + s * Y0 + la;
    const bLo = -s * X0 + c * Y0 + lb;
    let tu = floorDiv(aLo);
    let tv = floorDiv(bLo);
    let tA = (tu + 1) * DIV - aLo;
    let tB = (tv + 1) * DIV - bLo;
    for (let u = ua; u <= ub; u++) {
      if (u > ua) {
        tA -= stepA;
        if (tA <= 0) {
          tA += DIV;
          tu++;
        } else if (tA > DIV) {
          tA -= DIV;
          tu--;
        }
        tB -= stepB;
        if (tB <= 0) {
          tB += DIV;
          tv++;
        } else if (tB > DIV) {
          tB -= DIV;
          tv--;
        }
      }
      // A pixel counts iff the shape covers its centre AND a live, not yet taken cell is drawn there; the two tests are
      // independent, so the cheaper one runs first (a point's inline weight; for the other kinds the drawn cell, whose memo
      // and empty-area early-out are cheaper than their weight). Same pixels, same order, same weights either way.
      let wt = 0;
      if (isPoint) {
        // ShapeQ.weight's point case, inline (same arithmetic)
        const ddx = PX + box.x0 + u + 0.5 - qx;
        const d2 = ddx * ddx + ddy2;
        wt = d2 > qr2 ? 0 : 1 - 0.55 * (d2 / qr2);
        if (wt <= 0) continue;
      }
      let cell: number;
      if (memo !== null) {
        const o = v * stride + u;
        cell = memo.get(o);
        if (cell === -2) {
          cell = drawnCore(step, tu, tv, tA, tB);
          memo.put(o, cell);
        }
      } else cell = drawnCore(step, tu, tv, tA, tB);
      if (cell < 0 || integ[cell] === 0 || stamp[cell] === gen) continue;
      if (!isPoint) {
        wt = q.weight(PX + box.x0 + u + 0.5, wy);
        if (wt <= 0) continue;
      }
      stamp[cell] = gen;
      idx[n] = cell;
      wgt[n] = wt;
      n++;
    }
  }
  return n;
}
