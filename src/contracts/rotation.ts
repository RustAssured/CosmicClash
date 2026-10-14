import { DMath } from './dmath';
/**
 * Quantised rotation for rig regions (D27 amends D4; proposals 140/151). ONE sampler shared by matter (hit masks) and the
 * renderer (whose GLSL twin lives in src/render/rotsprite.ts): what you see is what is hit, bit for bit.
 *
 *  - Angles are QUANTISED: `ANGLE_STEPS` per turn; the LUT holds Q14 fixed-point cos/sin, so CPU and GPU agree bit for bit
 *    (the GPU receives the integer pair as a uniform; nothing transcendental runs on it).
 *  - Each destination pixel takes 3 × 3 sub-samples at (k + 0.5) / 3 of the pixel, maps each back into the source with the
 *    integer inverse rotation (exact floor division, biased positive so GLSL's integer division is well defined), and keeps the
 *    MAJORITY colour of the nine (ties → the centre sample). No new colours are ever made (palette-safe), single-pixel spurs
 *    and holes along rotated edges are voted away, and an angle of 0 reproduces the source exactly.
 *  - Coordinates: a part's source pivot is a pixel CORNER (integer) `(px, py)` in the source, drawn at the destination pixel
 *    corner `(qx, qy)`. Rotation is clockwise on screen (y down) for positive steps. `facing = -1` mirrors the source about the
 *    pivot corner BEFORE rotating (texel x' = 2·px − 1 − x).
 * Moved here from src/render/rotsprite.ts (S5's Phase 1 spike) so pure modules (matter) can import it.
 */

/** Rotation quantisation: steps per full turn (1.40625° each; at a 90 px radius one step moves the rim ≈ 2.2 px). */
export const ANGLE_STEPS = 256;
/** Fixed-point scale of the LUT (Q14). */
export const ROT_ONE = 1 << 14;
/** Sub-samples per axis. */
export const ROT_SUB = 3;
/** Destination offsets are expressed in 1 / (2·SUB) px so sub-sample centres are integers. */
export const ROT_DEN = 2 * ROT_SUB;
/** Positive bias (a multiple of the divisor) that keeps the integer division's operand ≥ 0. */
export const ROT_BIAS_PX = 4096;

/** Q14 cos / sin for every quantised angle (Int32Array, index = step). Deterministic: Math.round of Math.cos/sin. */
export const ROT_LUT: { cos: Int32Array; sin: Int32Array } = (() => {
  const cos = new Int32Array(ANGLE_STEPS);
  const sin = new Int32Array(ANGLE_STEPS);
  for (let i = 0; i < ANGLE_STEPS; i++) {
    // exact quadrants first, so 90° / 180° / 270° are exact transposes
    const q = i % (ANGLE_STEPS / 4);
    const a = (2 * Math.PI * i) / ANGLE_STEPS;
    cos[i] = q === 0 ? [ROT_ONE, 0, -ROT_ONE, 0][i / (ANGLE_STEPS / 4)]! : Math.round(DMath.cos(a) * ROT_ONE);
    sin[i] = q === 0 ? [0, ROT_ONE, 0, -ROT_ONE][i / (ANGLE_STEPS / 4)]! : Math.round(DMath.sin(a) * ROT_ONE);
  }
  return { cos, sin };
})();

/** The quantised step nearest an angle in radians (wraps). */
export function angleToStep(rad: number): number {
  const s = Math.round((rad / (2 * Math.PI)) * ANGLE_STEPS);
  return ((s % ANGLE_STEPS) + ANGLE_STEPS) % ANGLE_STEPS;
}

/** floor(a / b) for b > 0, exact, using the same positive-bias trick as the shader. */
function floorDiv(a: number, b: number): number {
  return Math.trunc((a + ROT_BIAS_PX * b) / b) - ROT_BIAS_PX;
}

export interface RotPart {
  /** Source sprite (packed RGBA, alpha in the top byte), its size, and the pivot corner in it. */
  pixels: Uint32Array;
  w: number;
  h: number;
  px: number;
  py: number;
  /** Quantised angle step. */
  step: number;
}

/** Source texel (x, y) that sub-sample (sx, sy ∈ 0..2) of destination pixel (dx, dy) (relative to the destination pivot) reads. */
export function subSource(part: RotPart, dx: number, dy: number, sx: number, sy: number): [number, number] {
  const c = ROT_LUT.cos[part.step]!;
  const s = ROT_LUT.sin[part.step]!;
  const X = ROT_DEN * dx + 2 * sx + 1;
  const Y = ROT_DEN * dy + 2 * sy + 1;
  // inverse rotation (rotate by −θ): src = ( c·X + s·Y, −s·X + c·Y ) / (DEN · ROT_ONE)
  const div = ROT_DEN * ROT_ONE;
  return [floorDiv(c * X + s * Y, div) + part.px, floorDiv(-s * X + c * Y, div) + part.py];
}

/** The colour the sampler draws for destination pixel (dx, dy) relative to the destination pivot (0 = transparent). */
const votes = new Uint32Array(ROT_SUB * ROT_SUB);

export function rotSample(part: RotPart, dx: number, dy: number): number {
  const v = votes;
  const c = ROT_LUT.cos[part.step]!;
  const s = ROT_LUT.sin[part.step]!;
  const div = ROT_DEN * ROT_ONE;
  const { pixels, w, h, px, py } = part;
  for (let sy = 0; sy < ROT_SUB; sy++) {
    const Y = ROT_DEN * dy + 2 * sy + 1;
    for (let sx = 0; sx < ROT_SUB; sx++) {
      const X = ROT_DEN * dx + 2 * sx + 1;
      const x = floorDiv(c * X + s * Y, div) + px;
      const y = floorDiv(-s * X + c * Y, div) + py;
      const col = x >= 0 && y >= 0 && x < w && y < h ? pixels[y * w + x]! : 0;
      // fully transparent texels are one colour ("empty") whatever their rgb
      v[sy * ROT_SUB + sx] = col >>> 24 === 0 ? 0 : col;
    }
  }
  // majority vote, ties keep the centre sample (the GPU twin runs the same vote with the same fast path)
  const centre = v[4]!;
  let nc = 0;
  for (let j = 0; j < 9; j++) if (v[j] === centre) nc++;
  let best = centre;
  if (nc < 5) {
    let bestN = nc;
    for (let i = 0; i < 9; i++) {
      if (i === 4) continue;
      let n = 0;
      for (let j = 0; j < 9; j++) if (v[j] === v[i]) n++;
      if (n > bestN) {
        best = v[i]!;
        bestN = n;
      }
    }
  }
  return best >>> 0;
}

/** Destination bounds (relative to the destination pivot) that can hold any pixel of the rotated part. */
export function rotBounds(part: RotPart): { x0: number; y0: number; x1: number; y1: number } {
  // forward-rotate the source rectangle's corners (relative to the pivot) with the LUT; 1 px of margin for the sub-samples
  const c = ROT_LUT.cos[part.step]! / ROT_ONE;
  const s = ROT_LUT.sin[part.step]! / ROT_ONE;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [sx, sy] of [
    [-part.px, -part.py],
    [part.w - part.px, -part.py],
    [-part.px, part.h - part.py],
    [part.w - part.px, part.h - part.py],
  ] as const) {
    const dx = c * sx - s * sy;
    const dy = s * sx + c * sy;
    x0 = Math.min(x0, dx);
    y0 = Math.min(y0, dy);
    x1 = Math.max(x1, dx);
    y1 = Math.max(y1, dy);
  }
  return { x0: Math.floor(x0) - 1, y0: Math.floor(y0) - 1, x1: Math.ceil(x1) + 1, y1: Math.ceil(y1) + 1 };
}

/** CPU twin of the whole draw: the rotated part rasterised over its bounds; the pivot sits at (ox, oy) of the buffer. */
export function rotRaster(part: RotPart): {
  pixels: Uint32Array;
  w: number;
  h: number;
  ox: number;
  oy: number;
} {
  const b = rotBounds(part);
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  const out = new Uint32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) out[y * w + x] = rotSample(part, x + b.x0, y + b.y0);
  return { pixels: out, w, h, ox: -b.x0, oy: -b.y0 };
}

/* ---- proposal 161 (S4 + S5): ALPHA-FIRST vote with mirroring — the sampler matter and the renderer both use ---- */

/** A part with the proposal-161 extras: mirroring and an origin inside a larger atlas. */
export interface RotPartEx extends RotPart {
  /** +1 as authored, −1 mirrored about the pivot corner before rotating. */
  facing?: 1 | -1;
}

const votesAt = new Uint32Array(ROT_SUB * ROT_SUB);
const vx = new Int32Array(ROT_SUB * ROT_SUB);
const vy = new Int32Array(ROT_SUB * ROT_SUB);
/** The source texel (x, y) of the winning sample of the last `rotSampleAt` call (meaningless when it returned 0). */
export const rotWinner = { x: 0, y: 0 };

/**
 * Proposal 161 sampler: the colour drawn at destination pixel (dx, dy) relative to the destination pivot (0 = transparent),
 * alpha-first vote, optional mirroring. The winning texel is left in `rotWinner`.
 */
export function rotSampleAt(part: RotPartEx, dx: number, dy: number): number {
  const c = ROT_LUT.cos[part.step]!;
  const s = ROT_LUT.sin[part.step]!;
  const div = ROT_DEN * ROT_ONE;
  const { pixels, w, h, px, py } = part;
  const mirror = part.facing === -1;
  let opaque = 0;
  for (let sy = 0; sy < ROT_SUB; sy++) {
    const Y = ROT_DEN * dy + 2 * sy + 1;
    for (let sx = 0; sx < ROT_SUB; sx++) {
      const X = ROT_DEN * dx + 2 * sx + 1;
      let x = floorDiv(c * X + s * Y, div) + px;
      const y = floorDiv(-s * X + c * Y, div) + py;
      if (mirror) x = 2 * px - 1 - x;
      const col = x >= 0 && y >= 0 && x < w && y < h ? pixels[y * w + x]! : 0;
      const k = sy * ROT_SUB + sx;
      votesAt[k] = col >>> 24 === 0 ? 0 : col;
      vx[k] = x;
      vy[k] = y;
      if (votesAt[k] !== 0) opaque++;
    }
  }
  // coverage first: the opaque majority decides whether anything is drawn at all
  if (opaque < 5) return 0;
  // then the colour among the opaque samples; ties keep the centre, then the first in scan order
  const centre = votesAt[4]!;
  let best = 0;
  let bestN = 0;
  let at = 4;
  if (centre !== 0) {
    best = centre;
    for (let j = 0; j < 9; j++) if (votesAt[j] === centre) bestN++;
  }
  for (let i = 0; i < 9; i++) {
    if (i === 4 || votesAt[i] === 0) continue;
    let n = 0;
    for (let j = 0; j < 9; j++) if (votesAt[j] === votesAt[i]) n++;
    if (n > bestN) {
      best = votesAt[i]!;
      bestN = n;
      at = i;
    }
  }
  rotWinner.x = vx[at]!;
  rotWinner.y = vy[at]!;
  return best >>> 0;
}

/* ---- proposal 174 (S4, Phase 2A): the 4-SAMPLE MAJORITY mode, 우리's rotation (uri/docs/URI_SPEC.md §3) ---- */

/**
 * Which rotation sampler a rig part uses. 'vote9' (default) = the 3 × 3 alpha-first vote above (the Witness); 'majority4' = 우리's
 * rule: each destination pixel samples the part at 4 sub-positions ((k + 0.5) / 2 of the pixel, k = 0, 1) and is drawn iff at
 * least 2 of them land on opaque texels; the colour is the sample at (¾, ¾) when it is opaque, else the first opaque sample in
 * scan order ((¼, ¼), (¾, ¼), (¼, ¾)) — the oracle's `drawPart` (uri/src/10_parts_render.js). Step 0 copies 1:1.
 */
export type RotMode = 'vote9' | 'majority4';
/** Sub-samples per axis of the 'majority4' mode and its offset denominator (destination offsets in 1/4 px). */
export const ROT4_SUB = 2;
export const ROT4_DEN = 2 * ROT4_SUB;

/**
 * The 'majority4' sampler: the colour drawn at destination pixel (dx, dy) relative to the destination pivot (0 = transparent),
 * optional mirroring; the winning texel is left in `rotWinner`. Same LUT, pivot convention and exact floor division as
 * `rotSampleAt`; integer arithmetic only (its GLSL twin is `rotSample4GL` in src/render/rotsprite.ts).
 */
export function rotSampleMaj4(part: RotPartEx, dx: number, dy: number): number {
  const c = ROT_LUT.cos[part.step]!;
  const s = ROT_LUT.sin[part.step]!;
  const div = ROT4_DEN * ROT_ONE;
  const { pixels, w, h, px, py } = part;
  const mirror = part.facing === -1;
  let cnt = 0;
  let best = 0;
  let bx = 0;
  let by = 0;
  for (let k = 0; k < 4; k++) {
    const X = ROT4_DEN * dx + 2 * (k & 1) + 1;
    const Y = ROT4_DEN * dy + 2 * (k >> 1) + 1;
    let x = floorDiv(c * X + s * Y, div) + px;
    const y = floorDiv(-s * X + c * Y, div) + py;
    if (mirror) x = 2 * px - 1 - x;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const col = pixels[y * w + x]!;
    if (col >>> 24 === 0) continue;
    cnt++;
    // the (¾, ¾) sample wins when opaque; otherwise the first opaque one
    if (k === 3 || cnt === 1) {
      best = col;
      bx = x;
      by = y;
    }
  }
  if (cnt < 2) return 0;
  rotWinner.x = bx;
  rotWinner.y = by;
  return best >>> 0;
}

/** CPU raster of a whole part in either mode (the pivot sits at (ox, oy) of the buffer). */
export function rotRasterMode(
  part: RotPartEx,
  mode: RotMode,
): { pixels: Uint32Array; w: number; h: number; ox: number; oy: number } {
  if (mode === 'vote9') return rotRasterAt(part);
  const b = rotBoundsEx(part);
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  const out = new Uint32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) out[y * w + x] = rotSampleMaj4(part, x + b.x0, y + b.y0);
  return { pixels: out, w, h, ox: -b.x0, oy: -b.y0 };
}

/** Bounds of a (possibly mirrored) part: mirroring about the pivot corner equals a pivot at w − px. */
export function rotBoundsEx(part: RotPartEx): { x0: number; y0: number; x1: number; y1: number } {
  return rotBounds(part.facing === -1 ? { ...part, px: part.w - part.px } : part);
}

/** CPU twin of a whole part draw under proposal 161 (the pivot sits at (ox, oy) of the buffer). */
export function rotRasterAt(part: RotPartEx): {
  pixels: Uint32Array;
  w: number;
  h: number;
  ox: number;
  oy: number;
} {
  const b = rotBoundsEx(part);
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  const out = new Uint32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) out[y * w + x] = rotSampleAt(part, x + b.x0, y + b.y0);
  return { pixels: out, w, h, ox: -b.x0, oy: -b.y0 };
}
