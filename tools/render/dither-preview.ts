/**
 * CPU preview of the palette dither on synthetic gradients and a noise nebula, using the same LUT + per-pixel ratio
 * maths as the shader (src/render/palette.ts). Used to tune LUT parameters by eye without a GPU:
 *   npx tsx tools/render/dither-preview.ts [stage] [bayerSize=4] [levels=4]  →  .scratch/render/dither-<stage>.png
 */
import { STAGE_IDS, hex, linearToRgbaBytes, type StageId } from './helpers';
import { STAGE_INFO as STAGES } from '../../src/stages/info';
import { Noise2 } from '../../src/stages/toolkit/noise';
import { bayerRanks, bayerThreshold } from '../../src/render/dither';
import { buildDitherLut, ditherToIndex, preparePalette, srgbToLinear } from '../../src/render/palette';
import { writePng } from '../lead/png';

const stage = (process.argv[2] ?? 'nursery') as StageId;
if (!STAGE_IDS.includes(stage)) throw new Error('unknown stage');
const pal = preparePalette(STAGES[stage].palette, STAGES[stage].ramps);
const lut = buildDitherLut(pal, { size: 32 });
const bn = Number(process.argv[3] ?? 4);
const levels = Number(process.argv[4] ?? 4);
const bayer = bayerRanks(bn);

const W = 640;
const H = 360;
const img = new Uint32Array(W * H);
const noise = new Noise2(5);

const tone = (v: number): number => 1 - Math.exp(-v);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r: number;
    let g: number;
    let b: number;
    if (y < 60) {
      // grey ramp
      r = g = b = srgbToLinear(x / (W - 1));
    } else if (y < 120) {
      // each palette-hue swatch strip: brightness sweep of the stage's brightest saturated colour
      const c = pal.linear;
      const k = Math.floor(((y - 60) / 60) * 5) * 7 + 12;
      const idx = Math.min(pal.count - 1, k);
      const s = x / (W - 1);
      r = c[idx * 3]! * s * 1.4;
      g = c[idx * 3 + 1]! * s * 1.4;
      b = c[idx * 3 + 2]! * s * 1.4;
    } else {
      // fbm nebula through the tone map, three colour bands
      const d = noise.fbm(x / 90, y / 90, 5);
      const l = noise.fbm(x / 90 - 0.1, y / 90 - 0.1, 5);
      const dens = Math.max(0, Math.min(1, (d - 0.35) / 0.5));
      const lit = Math.max(0, Math.min(1, (d - l) * 6));
      r = tone((0.08 + 0.7 * dens + 1.2 * lit * dens) * 1.1);
      g = tone((0.02 + 0.2 * dens + 0.5 * lit * dens) * 1.0);
      b = tone((0.08 + 0.4 * dens + 0.1 * lit) * 1.0);
    }
    const idx = ditherToIndex(
      pal,
      lut,
      Math.min(1, r),
      Math.min(1, g),
      Math.min(1, b),
      bayerThreshold(bayer, bn, x, y),
      levels,
    );
    img[y * W + x] = linearToRgbaBytes(pal.srgb[idx * 3]!, pal.srgb[idx * 3 + 1]!, pal.srgb[idx * 3 + 2]!);
  }
}
writePng(`.scratch/render/dither-${stage}-b${bn}-l${levels}.png`, img, W, H, 2, 0xff000000);
void hex;
console.log('wrote', stage);
