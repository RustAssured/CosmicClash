/**
 * Renderer side of the rig-part rotation (D27, proposals 140/151/161). The sampler itself is a contract
 * (`src/contracts/rotation.ts`) so matter's hit masks run the very same arithmetic; this module re-exports it and holds the
 * GLSL ES 3.00 twin the compositor uses, kept bit-identical by `rotsprite.test.ts` and `dev/render/verify.ts` §10e.
 *
 * Proposal 161 (S4 + S5, for the Lead to land in the contract): the vote is ALPHA FIRST — coverage is decided by the opaque
 * majority of the nine sub-samples (≥ 5 opaque → drawn), then the colour among the opaque ones (ties → the centre sample, then
 * the first in scan order). Recolouring a body (a darkening crack, heat) can then never flip whether an edge pixel is drawn —
 * and therefore hit. `facing = −1` mirrors the source about the pivot corner before rotating (texel x' = 2·px − 1 − x).
 * `rotSampleAt` below is that algorithm on the CPU, written to be copied into `contracts/rotation.ts` as is; it also reports
 * the texel that won, which the renderer uses for the emissive.
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
  type RotPartEx,
  rotSampleAt,
  rotBoundsEx,
  rotRasterAt,
  rotWinner,
} from '@/contracts/rotation';

/**
 * The sampler body, generated fully unrolled (nine named samples, no arrays, no loops): the D3D11 back-end warned
 * "optimization did not converge" on the loop-and-array form. Same arithmetic and the same vote order as `rotSampleAt`.
 */
const ROT_SAMPLE_BODY = ((): string => {
  const ks = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const lines: string[] = [
    'vec4 rotSampleGL(ivec2 d, out ivec2 texel) {',
    '  ivec2 s;',
    '  int X;',
    '  int Y;',
  ];
  for (const k of ks) {
    const sx = k % 3;
    const sy = Math.floor(k / 3);
    lines.push(
      `  X = ROT_DEN * d.x + ${2 * sx + 1};`,
      `  Y = ROT_DEN * d.y + ${2 * sy + 1};`,
      '  s = ivec2(rotFloorDiv(uRotCS.x * X + uRotCS.y * Y), rotFloorDiv(-uRotCS.y * X + uRotCS.x * Y)) + uPivot;',
      '  if (uFacing < 0) s.x = 2 * uPivot.x - 1 - s.x;',
      `  vec4 v${k} = vec4(0.0);`,
      `  if (s.x >= 0 && s.y >= 0 && s.x < uPartSize.x && s.y < uPartSize.y) v${k} = texelFetch(uPart, s + uPartOrigin, 0);`,
      `  if (v${k}.a == 0.0) v${k} = vec4(0.0);`,
      `  ivec2 a${k} = s + uPartOrigin;`,
    );
  }
  lines.push(`  int opaque = ${ks.map((k) => `int(v${k}.a > 0.0)`).join(' + ')};`);
  lines.push('  texel = a4;', '  if (opaque < 5) return vec4(0.0);');
  for (const i of ks) lines.push(`  int n${i} = ${ks.map((j) => `int(v${j} == v${i})`).join(' + ')};`);
  lines.push('  vec4 best = vec4(0.0);', '  int bestN = 0;', '  if (v4.a > 0.0) { best = v4; bestN = n4; }');
  for (const i of ks) {
    if (i === 4) continue;
    lines.push(`  if (v${i}.a > 0.0 && n${i} > bestN) { best = v${i}; bestN = n${i}; texel = a${i}; }`);
  }
  lines.push('  return best;', '}');
  return lines.join('\n');
})();
/**
 * GLSL ES 3.00 twin of `rotSampleAt` (integer arithmetic only). It declares an RGBA8 atlas `uPart` (row 0 = top), the part's
 * sub-rectangle `uPartOrigin` / `uPartSize`, the pivot `uPivot` (inside the sub-rect), `uRotCS` (Q14 cos, sin) and `uFacing`.
 * `rotSampleGL(d, out ivec2 texel)` returns the colour for destination pixel `d` relative to the destination pivot (alpha 0 =
 * transparent) and the ATLAS texel that won (for the emissive).
 */
export const ROTSPRITE_GLSL = /* glsl */ `
uniform sampler2D uPart;
uniform ivec2 uPartOrigin;
uniform ivec2 uPartSize;
uniform ivec2 uPivot;
uniform ivec2 uRotCS;
uniform int uFacing;
const int ROT_DEN = ${ROT_DEN};
const int ROT_DIV = ${ROT_DEN * ROT_ONE};
const int ROT_BIAS = ${ROT_BIAS_PX * ROT_DEN * ROT_ONE};
int rotFloorDiv(int a) { return (a + ROT_BIAS) / ROT_DIV - ${ROT_BIAS_PX}; }
${ROT_SAMPLE_BODY}
`;
