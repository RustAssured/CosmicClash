/**
 * The Witness contact sheets, so the art can be LOOKED AT before it is wired into the game:
 *   npx tsx tools/titans/witness-sheet.ts [--light=nursery|cold|noon] [--out=docs/gallery/wip]
 * Writes:
 *   witness-<light>-3x.png         the whole Witness at rest (regions in draw order, with membranes and fibres), 3×
 *   witness-<light>-1x-thumb.png   1:1 next to the 64 px thumbnail
 *   witness-<light>-cutaways.png   the four reveal layers: intact, carapace cut, channels cut, lattice cut (abyss), 2×
 *   witness-<light>-vs-planet.png  next to the Planet at true scale, 2×
 *   witness-<light>-regions.png    exploded view: every region body pulled apart from the eye, 2×
 * and prints the extent, the height relative to the Planet's diameter, and the cell count per region.
 */
import { DEFAULT_LIGHTING, type StageLighting } from '@/contracts';
import { paintWitness, type WitnessBody } from '@/titans/art/lastone';
import { writeContactSheet, writePng, type SheetItem } from '../lead/png';
import { compose, planetItem, restPoses, thumbnail, type Pose } from './witness-lib';

const lights: Record<string, StageLighting> = {
  nursery: DEFAULT_LIGHTING,
  cold: {
    dir: [-0.3, -0.6, 0.74],
    color: '#cfe6ff',
    ambient: '#0e1a3a',
    rim: '#7fc8ff',
    screenPos: [0.3, -0.1],
  },
  noon: {
    dir: [0.0, -0.7, 0.71],
    color: '#fff3d6',
    ambient: '#2b2a3a',
    rim: '#ffd9a0',
    screenPos: [0.5, -0.2],
  },
};
const args = process.argv.slice(2);
const lightName = (args.find((a) => a.startsWith('--light=')) ?? '--light=nursery').slice(8);
const outDir = (args.find((a) => a.startsWith('--out=')) ?? '--out=docs/gallery/wip').slice(6);
const lighting = lights[lightName] ?? DEFAULT_LIGHTING;
const SEED = 1234;
const PAD = 6;

const W: WitnessBody = paintWitness(SEED, lighting);
const win = {
  x0: Math.floor(W.x0) - PAD,
  y0: Math.floor(W.y0) - PAD,
  w: Math.ceil(W.x1 - W.x0) + PAD * 2,
  h: Math.ceil(W.y1 - W.y0) + PAD * 2,
  lighting,
};
const rest = restPoses(W);

/** Cutaway wedge (body coords): the lower-left of the carapace sphere, outside the socket. */
const wedge = (x: number, y: number): boolean => {
  const deg = (Math.atan2(y - 6, x) * 180) / Math.PI;
  return deg > 100 && deg < 205 && Math.hypot(x, y) > 34;
};

/** Exploded poses: every region pulled away from the eye along the direction of its centroid. */
function explode(k: number): Pose[] {
  return W.regions.map((r, i) => {
    if (r.kind === 'eye') return rest[i]!;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < r.map.h; y++)
      for (let x = 0; x < r.map.w; x++)
        if (r.map.material[y * r.map.w + x] !== 0) {
          sx += x + r.ox;
          sy += y + r.oy;
          n++;
        }
    const l = Math.hypot(sx / n, sy / n) || 1;
    const push =
      r.kind === 'interior' ? r.layer * 0.35 * k : r.kind === 'arm' ? k * (1 + 0.5 * r.segment) : k;
    return { x: rest[i]!.x + (sx / n / l) * push, y: rest[i]!.y + (sy / n / l) * push, a: 0 };
  });
}

const intact = compose(W, rest, { ...win, soft: true });
writePng(`${outDir}/witness-${lightName}-3x.png`, intact.pixels, intact.w, intact.h, 3);
const thumb = thumbnail(intact, 64);
writeContactSheet(`${outDir}/witness-${lightName}-1x-thumb.png`, [intact, thumb], 2, 2, 6);
const cut = (k: number): SheetItem => compose(W, rest, { ...win, soft: true, cut: k, cutWedge: wedge });
writeContactSheet(`${outDir}/witness-${lightName}-cutaways.png`, [cut(0), cut(1), cut(2), cut(3)], 4, 2, 6);
const planet = planetItem(SEED, lighting);
writeContactSheet(`${outDir}/witness-${lightName}-vs-planet.png`, [intact, planet.item], 2, 2, 10);
const ex = 14;
writeContactSheet(
  `${outDir}/witness-${lightName}-regions.png`,
  [
    compose(W, explode(ex), {
      ...win,
      x0: win.x0 - ex * 3,
      y0: win.y0 - ex * 3,
      w: win.w + ex * 6,
      h: win.h + ex * 6,
    }),
  ],
  1,
  2,
  6,
);

const height = W.y1 - W.y0;
const width = W.x1 - W.x0;
console.log(
  `witness: ${width}x${height} px live extent (x ${W.x0}..${W.x1}, y ${W.y0}..${W.y1}); ` +
    `height / Planet diameter (${planet.diameter} px) = ${(height / planet.diameter).toFixed(2)}; ` +
    `${W.regions.length} regions, ${W.cells} cells; thumbnail ${thumb.w}x${thumb.h}`,
);
for (const r of W.regions) {
  let n = 0;
  for (let i = 0; i < r.map.material.length; i++) if (r.map.material[i] !== 0) n++;
  console.log(
    `  ${r.key.padEnd(9)} ${r.kind.padEnd(8)} ${String(r.map.w).padStart(3)}x${String(r.map.h).padEnd(3)} cells ${String(n).padStart(5)}  pivot (${r.pivotX.toFixed(1)}, ${r.pivotY.toFixed(1)}) parent ${r.parent}${r.weld ? ' (welded)' : ''}`,
  );
}
