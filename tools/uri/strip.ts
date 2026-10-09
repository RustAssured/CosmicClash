/**
 * Gate 2B evidence: 우리's pose from the game's kinetic system beside the locked oracle's frames, for one move × side.
 * The game side is the asset's parts (their at-rest colours) placed by `placeParts` from the kinetic pose and rasterised with
 * the same 4-sample majority rule as the oracle (silhouette and pose; shading, cores and loop are S5's), the oracle side is
 * its own canvas (tools/uri/oracle.ts --shots=...).
 *   npx tsx tools/uri/strip.ts --move=slam --side=right --shots=10,40,58,86,100,150 [--in=.scratch/uri-oracle] [--out=docs/gallery/wip]
 */
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { UriKinetics, type UriKineticView } from '@/combat/uri/kinetics';
import { uriPartMatter } from '@/titans/uri/maps';
import { emptyPlaces, placeParts, URI_ORDER, URI_REF, uriPart } from '@/titans/uri/rig';
import { writePng } from '../lead/png';
import { URI_SIDES } from './sides';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const MOVE = opt('move', 'slam') as 'slam' | 'punch' | 'cross' | 'upper';
const SIDE = opt('side', 'right');
const SHOTS = opt('shots', '10,40,58,86,100,150').split(',').map(Number);
const IN = opt('in', '.scratch/uri-oracle');
const OUT = opt('out', 'docs/gallery/wip');
const W = 640;
const H = 360;
const OX = URI_REF.screenX - URI_REF.originX;
const OY = URI_REF.screenY - URI_REF.originY;

const parts = new Map(uriPartMatter(1).map((p) => [p.key, p]));

/** Rasterise every part at its place (4-sample majority: ≥ 2 of 4 sub-samples on matter, as the oracle). */
function render(
  pl: ReturnType<typeof emptyPlaces>,
  moon: UriKineticView['moon'],
  bobX: number,
  bobY: number,
): Uint32Array {
  const img = new Uint32Array(W * H).fill(0xff120a0a);
  for (const k of URI_ORDER) {
    const meta = uriPart(k);
    const m = parts.get(k)!.map;
    let px0 = pl[k].x + OX + bobX;
    let py0 = pl[k].y + OY + bobY;
    let ang = pl[k].a;
    if (k === 'moon' && moon) {
      px0 = moon.x + OX + bobX;
      py0 = moon.y + OY + bobY;
      ang = moon.a;
    }
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const ext = Math.hypot(meta.w, meta.h) + 2;
    for (let y = Math.max(0, Math.floor(py0 - ext)); y <= Math.min(H - 1, Math.ceil(py0 + ext)); y++)
      for (let x = Math.max(0, Math.floor(px0 - ext)); x <= Math.min(W - 1, Math.ceil(px0 + ext)); x++) {
        let cnt = 0;
        let best = -1;
        for (let s = 0; s < 4; s++) {
          const dx = x + (s & 1 ? 0.75 : 0.25) - px0;
          const dy = y + (s & 2 ? 0.75 : 0.25) - py0;
          const u = dx * ca + dy * sa;
          const v = -dx * sa + dy * ca;
          const ix = Math.floor(u + meta.pivX);
          const iy = Math.floor(v + meta.pivY);
          if (ix < 0 || iy < 0 || ix >= m.w || iy >= m.h) continue;
          const i = iy * m.w + ix;
          if (!m.material[i]) continue;
          cnt++;
          if (s === 3 || best < 0) best = i;
        }
        if (cnt < 2) continue;
        img[y * W + x] = m.baseColor[best]!;
      }
  }
  return img;
}

const k = new UriKinetics(1);
const target = URI_SIDES[SIDE]!;
k.target = [target[0] - OX, target[1] - OY];
for (let f = 0; f < 240; f++) k.step(1 / 60);
k.begin(MOVE);
const view = {
  move: null,
  phase: null,
  lead: null,
  rear: null,
  loop: { l: 1, r: 1, sh: 0, vt: 1, br: 1 },
  stress: 0,
  torque: 0,
  core: { x: 0, y: 0 },
  pylon: { L: { th: 0, ang: 0 }, R: { th: 0, ang: 0 } },
  moon: null,
  spread: { L: 1, R: 1 },
} as UriKineticView;
const pl = emptyPlaces();
const CW = 640;
const CH = 360;
const sheet = new Uint32Array(CW * SHOTS.length * CH * 2).fill(0xff000000);
const SW = CW * SHOTS.length;
const max = Math.max(...SHOTS);
for (let f = 0; f <= max; f++) {
  k.step(1 / 60);
  const col = SHOTS.indexOf(f);
  if (col < 0) continue;
  k.view(view);
  placeParts(k.currentPose(), pl);
  // the oracle's idle bob of the whole body (its frame(): sin(t·0.37)·1.2, sin(t·0.53)·1.6)
  const mine = render(pl, view.moon, Math.sin(k.t * 0.37) * 1.2, Math.sin(k.t * 0.53) * 1.6);
  const png = PNG.sync.read(readFileSync(`${IN}/${MOVE}-${SIDE}-${f}.png`));
  const x0 = 0;
  const y0 = 0;
  for (let y = 0; y < CH; y++)
    for (let x = 0; x < CW; x++) {
      const i = ((y + y0) * png.width + x + x0) * 4;
      sheet[y * SW + col * CW + x] =
        (255 << 24) | (png.data[i + 2]! << 16) | (png.data[i + 1]! << 8) | png.data[i]!;
      sheet[(y + CH) * SW + col * CW + x] = mine[(y + y0) * W + x + x0]!;
    }
}
const name = `${OUT}/uri-2b-${MOVE}-${SIDE}.png`;
writePng(name, sheet, SW, CH * 2, 1);
console.log(`saved ${name} (top: oracle, bottom: game pose; frames ${SHOTS.join(', ')})`);
