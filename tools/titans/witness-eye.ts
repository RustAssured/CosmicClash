/**
 * The Witness's eye microdetail, before (flat) and after (micro), at the three distances that matter:
 *   npx tsx tools/titans/witness-eye.ts [--out=docs/gallery/wip]
 * Writes witness-eye-micro-1x.png (whole Witness, 1:1, before | after), -3x.png (3×) and -4x-crop.png (the eye alone at
 * 4×, as the aftermath zoom shows it), and prints how much the 1× READ changes: the mean and max luminance difference
 * after a 3×3 box blur (what the eye integrates at play distance), in 0..255 units.
 */
import { DEFAULT_LIGHTING } from '@/contracts';
import { paintWitness } from '@/titans/art/lastone';
import { writeContactSheet, type SheetItem } from '../lead/png';
import { compose, restPoses } from './witness-lib';

const args = process.argv.slice(2);
const outDir = (args.find((a) => a.startsWith('--out=')) ?? '--out=docs/gallery/wip').slice(6);
const SEED = 1234;
const PAD = 6;

const render = (micro: boolean): SheetItem => {
  const W = paintWitness(SEED, DEFAULT_LIGHTING, undefined, { micro });
  return compose(W, restPoses(W), {
    x0: Math.floor(W.x0) - PAD,
    y0: Math.floor(W.y0) - PAD,
    w: Math.ceil(W.x1 - W.x0) + PAD * 2,
    h: Math.ceil(W.y1 - W.y0) + PAD * 2,
    lighting: DEFAULT_LIGHTING,
    soft: true,
  });
};
const before = render(false);
const after = render(true);

/** The eye alone (body coords −34..34), cut out of a composed sheet. */
const crop = (s: SheetItem): SheetItem => {
  const W = paintWitness(SEED, DEFAULT_LIGHTING, undefined, { micro: false });
  const x0 = -34 - (Math.floor(W.x0) - PAD);
  const y0 = -34 - (Math.floor(W.y0) - PAD);
  const n = 68;
  const px = new Uint32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) px[y * n + x] = s.pixels[(y0 + y) * s.w + x0 + x]!;
  return { pixels: px, w: n, h: n };
};

const lum = (c: number): number => 0.299 * (c & 255) + 0.587 * ((c >>> 8) & 255) + 0.114 * ((c >>> 16) & 255);
const blur = (s: SheetItem): Float64Array => {
  const o = new Float64Array(s.w * s.h);
  for (let y = 1; y < s.h - 1; y++)
    for (let x = 1; x < s.w - 1; x++) {
      let t = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) t += lum(s.pixels[(y + dy) * s.w + x + dx]!);
      o[y * s.w + x] = t / 9;
    }
  return o;
};
const ea = crop(before);
const eb = crop(after);
const ba = blur(ea);
const bb = blur(eb);
let sum = 0;
let max = 0;
let raw = 0;
for (let i = 0; i < ba.length; i++) {
  const d = Math.abs(ba[i]! - bb[i]!);
  sum += d;
  max = Math.max(max, d);
  raw = Math.max(raw, Math.abs(lum(ea.pixels[i]!) - lum(eb.pixels[i]!)));
}
writeContactSheet(`${outDir}/witness-eye-micro-1x.png`, [before, after], 2, 1, 6);
writeContactSheet(`${outDir}/witness-eye-micro-3x.png`, [before, after], 2, 3, 6);
writeContactSheet(`${outDir}/witness-eye-micro-4x-crop.png`, [ea, eb], 2, 4, 4);
console.log(
  `eye, 1× read (3×3 blur): mean |Δluma| ${(sum / ba.length).toFixed(2)}, max ${max.toFixed(1)}; ` +
    `largest single-pixel change ${raw.toFixed(0)} (0..255)`,
);
console.log(`saved ${outDir}/witness-eye-micro-*.png`);
