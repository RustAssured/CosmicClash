/**
 * Writes one PNG per stage showing its palette, one ramp per row (dark → light), so hue-shifted ramps and the bridges between
 * hue-adjacent ramps can be judged by eye: `npx tsx tools/render/palette-sheet.ts` → .scratch/render/palette-<stage>.png
 */
import { STAGE_IDS, hex } from '../../src/contracts';
import { STAGE_INFO } from '../../src/stages/info';
import { writePng } from '../lead/png';

const SW = 22;
for (const id of STAGE_IDS) {
  const info = STAGE_INFO[id];
  const lens = info.ramps ?? [info.palette.length];
  const cols = Math.max(...lens);
  const w = cols * SW;
  const h = lens.length * SW;
  const px = new Uint32Array(w * h);
  let i = 0;
  lens.forEach((n, row) => {
    for (let k = 0; k < n; k++) {
      const c = hex(info.palette[i++]!);
      for (let y = 0; y < SW - 2; y++)
        for (let x = 0; x < SW - 2; x++) px[(row * SW + y) * w + k * SW + x] = c;
    }
  });
  writePng(`.scratch/render/palette-${id}.png`, px, w, h, 2, 0xff000000);
  console.log(id, info.palette.length, 'colours in', lens.length, 'ramps');
}
