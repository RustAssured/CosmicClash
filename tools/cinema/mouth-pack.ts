/**
 * Pack the baked Mouth frames (press/cinema/work/mouth/<seq>/NNNN.png, tools/cinema/mouth-bake.ts) into frame packs the
 * actors play back (src/cinema/p6/pack.ts): every pixel snapped to the master palette (UNIFICATION §2), emissive where
 * the oracle's emissive layer is lit, run-length coded. → press/cinema/work/mouth/<seq>.cfp
 *
 *   npx tsx tools/cinema/mouth-pack.ts [edge heap jaw]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { hex } from '../../src/contracts';
import { masterPalette } from '../../src/render/master';
import { nearestMaster } from '../../src/cinema/p4/palette';
import { writePack } from '../../src/cinema/p6/pack';

const DIR = 'press/cinema/work/mouth';
const M = masterPalette();
const palette = Uint32Array.from(M.colors, (h) => hex(h));
const index = new Map<number, number>();
palette.forEach((c, i) => index.set(c, i));
if (palette.length > 128)
  throw new Error('master palette has more than 128 colours: the pack format keeps 7 bits');

for (const seq of process.argv.slice(2).length ? process.argv.slice(2) : ['edge', 'heap', 'jaw']) {
  const files = readdirSync(`${DIR}/${seq}`)
    .filter((f) => f.endsWith('.png'))
    .sort();
  const frames: Uint8Array[] = [];
  let w = 0;
  let h = 0;
  for (const f of files) {
    const png = PNG.sync.read(readFileSync(`${DIR}/${seq}/${f}`));
    w = png.width / 2;
    h = png.height;
    const out = new Uint8Array(w * h).fill(255);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const l = (y * png.width + x) * 4;
        const r = (y * png.width + w + x) * 4;
        const a = png.data[l + 3]!;
        const ea = png.data[r + 3]!;
        if (a < 128 && ea < 128) continue;
        // an emissive pixel takes its emissive colour (what the oracle's bloom reads), the rest the figure's
        const src = ea >= 128 ? r : l;
        const c = nearestMaster(png.data[src]!, png.data[src + 1]!, png.data[src + 2]!);
        const k = index.get(c)!;
        // (255 means transparent, so the 128th colour cannot also be emissive: it is drawn matte)
        out[y * w + x] = k | (ea >= 128 && k !== 127 ? 128 : 0);
      }
    frames.push(out);
  }
  const data = writePack(w, h, palette, frames);
  writeFileSync(`${DIR}/${seq}.cfp`, data);
  console.log(
    `${seq}: ${frames.length} frames → ${DIR}/${seq}.cfp (${(data.length / 1048576).toFixed(1)} MB)`,
  );
}
