/**
 * The Witness's arm styles side by side, so one can be chosen by eye:
 *   npx tsx tools/titans/witness-arms.ts [--out=docs/gallery/wip]
 * Writes witness-arms-<style>.png (3×) per style and witness-arms-compare.png (all styles, 3×), and checks that every arm
 * segment is still ONE 4-connected body (matter would shed a loose island as debris on the first tick).
 */
import { DEFAULT_LIGHTING } from '@/contracts';
import { paintWitness, WITNESS_ARM_STYLES, type WitnessBody } from '@/titans/art/lastone';
import { writeContactSheet, writePng, type SheetItem } from '../lead/png';
import { compose, restPoses } from './witness-lib';

const args = process.argv.slice(2);
const outDir = (args.find((a) => a.startsWith('--out=')) ?? '--out=docs/gallery/wip').slice(6);
const SEED = 1234;
const PAD = 6;

/** Number of 4-connected islands of matter in a map. */
function islands(m: { w: number; h: number; material: Uint8Array }): number {
  const seen = new Uint8Array(m.w * m.h);
  let n = 0;
  const stack: number[] = [];
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] || m.material[i] === 0) continue;
    n++;
    seen[i] = 1;
    stack.push(i);
    while (stack.length) {
      const c = stack.pop()!;
      const x = c % m.w;
      const y = (c - x) / m.w;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= m.w || ny >= m.h) continue;
        const j = ny * m.w + nx;
        if (!seen[j] && m.material[j] !== 0) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
  }
  return n;
}

const items: SheetItem[] = [];
for (const style of WITNESS_ARM_STYLES) {
  const W: WitnessBody = paintWitness(SEED, DEFAULT_LIGHTING, style);
  const win = {
    x0: Math.floor(W.x0) - PAD,
    y0: Math.floor(W.y0) - PAD,
    w: Math.ceil(W.x1 - W.x0) + PAD * 2,
    h: Math.ceil(W.y1 - W.y0) + PAD * 2,
    lighting: DEFAULT_LIGHTING,
  };
  const img = compose(W, restPoses(W), { ...win, soft: true });
  writePng(`${outDir}/witness-arms-${style}.png`, img.pixels, img.w, img.h, 3);
  items.push(img);
  const arms = W.regions.filter((r) => r.kind === 'arm');
  const split = arms.filter((r) => islands(r.map) !== 1).map((r) => `${r.key}:${islands(r.map)}`);
  const cells = arms.reduce((t, r) => t + r.map.material.reduce((a, v) => a + (v ? 1 : 0), 0), 0);
  console.log(
    `${style.padEnd(6)} ${W.x1 - W.x0}x${W.y1 - W.y0} px, arm cells ${cells}, ` +
      (split.length ? `SPLIT: ${split.join(' ')}` : 'every arm segment one body'),
  );
}
writeContactSheet(`${outDir}/witness-arms-compare.png`, items, items.length, 3, 8);
console.log(`saved ${outDir}/witness-arms-*.png`);
