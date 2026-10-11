/**
 * Crop and scale a region of a side-by-side parity image (both halves, stacked):
 *   npx tsx tools/mouth/crop.ts <in.png> <x0> <y0> <w> <h> [scale=3] [out.png]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [inp, xs, ys, ws, hs, ss, outp] = process.argv.slice(2);
const src = PNG.sync.read(readFileSync(inp!));
const x0 = +xs!;
const y0 = +ys!;
const w = +ws!;
const h = +hs!;
const s = +(ss ?? 3);
const half = src.width / 2;
const out = new PNG({ width: w * s * 2 + 4, height: h * s });
for (let y = 0; y < h * s; y++)
  for (let x = 0; x < w * s * 2 + 4; x++) {
    const o = (y * out.width + x) * 4;
    let sx: number;
    if (x < w * s) sx = x0 + Math.floor(x / s);
    else if (x < w * s + 4) {
      out.data[o] = 255;
      out.data[o + 1] = 255;
      out.data[o + 2] = 255;
      out.data[o + 3] = 255;
      continue;
    } else sx = half + x0 + Math.floor((x - w * s - 4) / s);
    const sy = y0 + Math.floor(y / s);
    const i = (sy * src.width + sx) * 4;
    for (let c = 0; c < 4; c++) out.data[o + c] = src.data[i + c]!;
  }
writeFileSync(outp ?? inp!.replace('.png', '-crop.png'), PNG.sync.write(out));
