/**
 * Rotation spike (SLICE_PLAN §4.1, D27): a CLEAN-EDGE rotated-sprite sampler for rig parts, with a bit-exact CPU twin.
 *
 * Pure TypeScript (no three, no DOM) so the matter side (hit masks) and the tests can use exactly the arithmetic the GPU runs.
 *
 *  - Angles are QUANTISED: `ANGLE_STEPS` per turn; the LUT holds Q14 fixed-point cos/sin, so CPU and GPU agree bit for bit
 *    (the GPU receives the integer pair as a uniform; nothing transcendental runs on it).
 *  - Each destination pixel takes 3 × 3 sub-samples at (k + 0.5) / 3 of the pixel, maps each back into the source with the
 *    integer inverse rotation (exact floor division, biased positive so GLSL's integer division is well defined), and keeps the
 *    MAJORITY colour of the nine (ties → the centre sample). No new colours are ever made (palette-safe), single-pixel spurs
 *    and holes along rotated edges are voted away, and an angle of 0 reproduces the source exactly.
 *  - Coordinates: a part's source pivot is a pixel CORNER (integer) `(px, py)` in the source, drawn at the destination pixel
 *    corner `(qx, qy)`. Rotation is clockwise on screen (y down) for positive steps.
 */

/** Rotation quantisation: steps per full turn (1.40625° each; at a 90 px radius one step moves the rim ≈ 2.2 px). */
export const ANGLE_STEPS = 256;
/** Fixed-point scale of the LUT (Q14). */
export const ROT_ONE = 1 << 14;
/** Sub-samples per axis. */
const SUB = 3;
/** Destination offsets are expressed in 1 / (2·SUB) px so sub-sample centres are integers. */
const DEN = 2 * SUB;
/** Positive bias (a multiple of the divisor) that keeps the integer division's operand ≥ 0. */
const BIAS_PX = 4096;

/** Q14 cos / sin for every quantised angle (Int32Array, index = step). Deterministic: Math.round of Math.cos/sin. */
export const ROT_LUT: { cos: Int32Array; sin: Int32Array } = (() => {
  const cos = new Int32Array(ANGLE_STEPS);
  const sin = new Int32Array(ANGLE_STEPS);
  for (let i = 0; i < ANGLE_STEPS; i++) {
    // exact quadrants first, so 90° / 180° / 270° are exact transposes
    const q = i % (ANGLE_STEPS / 4);
    const a = (2 * Math.PI * i) / ANGLE_STEPS;
    cos[i] = q === 0 ? [ROT_ONE, 0, -ROT_ONE, 0][i / (ANGLE_STEPS / 4)]! : Math.round(Math.cos(a) * ROT_ONE);
    sin[i] = q === 0 ? [0, ROT_ONE, 0, -ROT_ONE][i / (ANGLE_STEPS / 4)]! : Math.round(Math.sin(a) * ROT_ONE);
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
  return Math.trunc((a + BIAS_PX * b) / b) - BIAS_PX;
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
  const X = DEN * dx + 2 * sx + 1;
  const Y = DEN * dy + 2 * sy + 1;
  // inverse rotation (rotate by −θ): src = ( c·X + s·Y, −s·X + c·Y ) / (DEN · ROT_ONE)
  const div = DEN * ROT_ONE;
  return [floorDiv(c * X + s * Y, div) + part.px, floorDiv(-s * X + c * Y, div) + part.py];
}

/** The colour the sampler draws for destination pixel (dx, dy) relative to the destination pivot (0 = transparent). */
const votes = new Uint32Array(SUB * SUB);

export function rotSample(part: RotPart, dx: number, dy: number): number {
  const v = votes;
  const c = ROT_LUT.cos[part.step]!;
  const s = ROT_LUT.sin[part.step]!;
  const div = DEN * ROT_ONE;
  const { pixels, w, h, px, py } = part;
  for (let sy = 0; sy < SUB; sy++) {
    const Y = DEN * dy + 2 * sy + 1;
    for (let sx = 0; sx < SUB; sx++) {
      const X = DEN * dx + 2 * sx + 1;
      const x = floorDiv(c * X + s * Y, div) + px;
      const y = floorDiv(-s * X + c * Y, div) + py;
      const col = x >= 0 && y >= 0 && x < w && y < h ? pixels[y * w + x]! : 0;
      // fully transparent texels are one colour ("empty") whatever their rgb
      v[sy * SUB + sx] = col >>> 24 === 0 ? 0 : col;
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

/**
 * GLSL ES 3.00 twin of `rotSample` (a fragment-shader function; integer arithmetic only). It declares an RGBA8 `uPart`
 * (row 0 = top), `uPartSize` (w, h), `uPivot` (px, py) and `uRotCS` (Q14 cos, sin); `rotSampleGL(d)` returns the colour for
 * destination pixel `d` relative to the destination pivot (alpha 0 = transparent).
 */
export const ROTSPRITE_GLSL = /* glsl */ `
uniform sampler2D uPart;
uniform ivec2 uPartSize;
uniform ivec2 uPivot;
uniform ivec2 uRotCS;
const int ROT_DEN = ${DEN};
const int ROT_DIV = ${DEN * ROT_ONE};
const int ROT_BIAS = ${BIAS_PX * DEN * ROT_ONE};
int rotFloorDiv(int a) { return (a + ROT_BIAS) / ROT_DIV - ${BIAS_PX}; }
vec4 rotFetch(ivec2 s) {
  if (s.x < 0 || s.y < 0 || s.x >= uPartSize.x || s.y >= uPartSize.y) return vec4(0.0);
  vec4 c = texelFetch(uPart, s, 0);
  return c.a == 0.0 ? vec4(0.0) : c;
}
vec4 rotSampleGL(ivec2 d) {
  vec4 v[9];
  for (int sy = 0; sy < 3; sy++) {
    for (int sx = 0; sx < 3; sx++) {
      int X = ROT_DEN * d.x + 2 * sx + 1;
      int Y = ROT_DEN * d.y + 2 * sy + 1;
      ivec2 s = ivec2(rotFloorDiv(uRotCS.x * X + uRotCS.y * Y), rotFloorDiv(-uRotCS.y * X + uRotCS.x * Y)) + uPivot;
      v[sy * 3 + sx] = rotFetch(s);
    }
  }
  // fast path (same result as the full vote): a centre colour held by ≥ 5 of the 9 is the unique majority
  int nc = 0;
  for (int j = 0; j < 9; j++) nc += v[j] == v[4] ? 1 : 0;
  vec4 best = v[4];
  if (nc < 5) {
    int bestN = nc;
    for (int i = 0; i < 9; i++) {
      if (i == 4) continue;
      int n = 0;
      for (int j = 0; j < 9; j++) n += v[j] == v[i] ? 1 : 0;
      if (n > bestN) { best = v[i]; bestN = n; }
    }
  }
  return best;
}
`;
