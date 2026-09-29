/**
 * Writes one PNG per stage showing its palette as swatch rows (ramp order = array order) so hue-shifted ramps can be
 * judged by eye: `npx tsx tools/render/palette-sheet.ts` → .scratch/render/palette-<stage>.png
 */
import { STAGE_IDS, hex } from '../../src/contracts';
import { STAGE_INFO } from '../../src/stages/info';
import { writePng } from '../lead/png';

const SW = 14;
for (const id of STAGE_IDS) {
  const pal = STAGE_INFO[id].palette;
  const cols = 12;
  const rows = Math.ceil(pal.length / cols);
  const w = cols * SW;
  const h = rows * SW;
  const px = new Uint32Array(w * h);
  pal.forEach((c, i) => {
    const cx = (i % cols) * SW;
    const cy = Math.floor(i / cols) * SW;
    for (let y = 0; y < SW - 1; y++) for (let x = 0; x < SW - 1; x++) px[(cy + y) * w + cx + x] = hex(c);
  });
  writePng(`.scratch/render/palette-${id}.png`, px, w, h, 2, 0xff000000);
  console.log(id, pal.length, 'colours');
}
