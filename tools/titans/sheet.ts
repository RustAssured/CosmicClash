/**
 * Titan legibility sheet. Renders every implemented titan (intact / eroded 50% / 10%) at 1×, 4× and as a 64 px thumbnail row
 * to `.scratch/titans/*.png` so the art can be LOOKED AT.   npx tsx tools/titans/sheet.ts [lastone|asteroid] [--light=nursery|cold|noon]
 */
import { mkdirSync } from 'node:fs';
import { DEFAULT_LIGHTING, type StageLighting, type TitanDef } from '@/contracts';
import { writePng, writeContactSheet } from '../lead/png';
import { paintTitanMap } from '@/titans/generate';
import lastone from '@/titans/lastone.json';
import asteroid from '@/titans/asteroid.json';

const defs: Record<string, TitanDef> = {
  lastone: lastone as unknown as TitanDef,
  asteroid: asteroid as unknown as TitanDef,
};
const lights: Record<string, StageLighting> = {
  nursery: DEFAULT_LIGHTING,
  cold: { dir: [-0.3, -0.6, 0.74], color: '#cfe6ff', ambient: '#0e1a3a', rim: '#7fc8ff', screenPos: [0.3, -0.1] },
  noon: { dir: [0.0, -0.7, 0.71], color: '#fff3d6', ambient: '#2b2a3a', rim: '#ffd9a0', screenPos: [0.5, -0.2] },
};
const which = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const lightName = (process.argv.find((a) => a.startsWith('--light=')) ?? '--light=nursery').slice(8);

mkdirSync('.scratch/titans', { recursive: true });
for (const id of which.length ? which : Object.keys(defs)) {
  const def = defs[id]!;
  const t0 = performance.now();
  const { map } = paintTitanMap(def, 1234, lights[lightName]!);
  const ms = performance.now() - t0;
  const px = new Uint32Array(map.w * map.h);
  for (let i = 0; i < px.length; i++) px[i] = map.material[i] ? map.baseColor[i]! : 0;
  console.log(`${id}: ${map.w}x${map.h} generated in ${ms.toFixed(0)} ms`);
  writePng(`.scratch/titans/${id}-${lightName}-4x.png`, px, map.w, map.h, 4);
  writePng(`.scratch/titans/${id}-${lightName}-1x.png`, px, map.w, map.h, 1);
}
void writeContactSheet;
