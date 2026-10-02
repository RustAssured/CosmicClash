/**
 * Renderer side of the rig-part rotation (D27, proposals 140/151). The sampler itself is a contract
 * (`src/contracts/rotation.ts`) so matter's hit masks run the very same arithmetic; this module re-exports it and holds the
 * GLSL ES 3.00 twin the compositor uses, kept bit-identical by `rotsprite.test.ts` and `dev/render/verify.ts` §10e.
 */
import { ROT_BIAS_PX, ROT_DEN, ROT_ONE } from '@/contracts/rotation';

export {
  ANGLE_STEPS,
  ROT_LUT,
  ROT_ONE,
  angleToStep,
  rotBounds,
  rotRaster,
  rotSample,
  subSource,
  type RotPart,
} from '@/contracts/rotation';

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
const int ROT_DEN = ${ROT_DEN};
const int ROT_DIV = ${ROT_DEN * ROT_ONE};
const int ROT_BIAS = ${ROT_BIAS_PX * ROT_DEN * ROT_ONE};
int rotFloorDiv(int a) { return (a + ROT_BIAS) / ROT_DIV - ${ROT_BIAS_PX}; }
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
