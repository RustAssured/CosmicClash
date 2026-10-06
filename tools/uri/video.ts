/**
 * Gate 2B captures: a 3 s, 60 fps side-by-side video per move × side: the locked oracle's own frames (left; recorded by
 * tools/uri/oracle.ts --shots=0..179) and the game's kinetic pose (right; the asset's parts placed by the rig and rasterised
 * with the 4-sample majority rule, at-rest colours; shading, cores and loop are S5's pass). Needs ffmpeg on PATH.
 *   npx tsx tools/uri/video.ts [--in=.scratch/uri-oracle-all] [--out=docs/gallery/wip/uri-2b] [--moves=slam,...] [--sides=right,...]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { UriKinetics, type UriKineticView, type UriMoveName } from '@/combat/uri/kinetics';
import { uriPartMatter } from '@/titans/uri/maps';
import { emptyPlaces, placeParts, URI_ORDER, URI_REF, uriPart } from '@/titans/uri/rig';
import { URI_SIDES } from './sides';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const IN = opt('in', '.scratch/uri-oracle-all');
const OUT = opt('out', 'docs/gallery/wip/uri-2b');
const MOVES = opt('moves', 'slam,punch,cross,upper').split(',') as UriMoveName[];
const SIDES = opt('sides', 'right,left,above,below').split(',');
const W = 640;
const H = 360;
const OX = URI_REF.screenX - URI_REF.originX;
const OY = URI_REF.screenY - URI_REF.originY;
const parts = new Map(uriPartMatter().map((p) => [p.key, p]));

function render(
  pl: ReturnType<typeof emptyPlaces>,
  moon: UriKineticView['moon'],
  bx: number,
  by: number,
  out: Uint8Array,
  stride: number,
  x0: number,
): void {
  for (const k of URI_ORDER) {
    const meta = uriPart(k);
    const m = parts.get(k)!.map;
    const px0 = (k === 'moon' && moon ? moon.x : pl[k].x) + OX + bx;
    const py0 = (k === 'moon' && moon ? moon.y : pl[k].y) + OY + by;
    const ang = k === 'moon' && moon ? moon.a : pl[k].a;
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
          const ix = Math.floor(dx * ca + dy * sa + meta.pivX);
          const iy = Math.floor(-dx * sa + dy * ca + meta.pivY);
          if (ix < 0 || iy < 0 || ix >= m.w || iy >= m.h) continue;
          const i = iy * m.w + ix;
          if (!m.material[i]) continue;
          cnt++;
          if (s === 3 || best < 0) best = i;
        }
        if (cnt < 2) continue;
        const c = m.baseColor[best]!;
        const o = (y * stride + x0 + x) * 4;
        out[o] = c & 255;
        out[o + 1] = (c >>> 8) & 255;
        out[o + 2] = (c >>> 16) & 255;
        out[o + 3] = 255;
      }
  }
}

const view = (): UriKineticView => ({
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
});

mkdirSync(OUT, { recursive: true });
for (const move of MOVES)
  for (const side of SIDES) {
    const tmp = `${IN}/_frames`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const k = new UriKinetics(1);
    const t = URI_SIDES[side]!;
    k.target = [t[0] - OX, t[1] - OY];
    for (let f = 0; f < 240; f++) k.step(1 / 60);
    k.begin(move);
    const v = view();
    const pl = emptyPlaces();
    for (let f = 0; f < 180; f++) {
      k.step(1 / 60);
      k.view(v);
      placeParts(k.currentPose(), pl);
      const png = new PNG({ width: W * 2, height: H });
      png.data.fill(0);
      for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
      const ora = PNG.sync.read(readFileSync(`${IN}/${move}-${side}-${f}.png`));
      for (let y = 0; y < H; y++) ora.data.copy(png.data, y * W * 2 * 4, y * W * 4, (y + 1) * W * 4);
      // the game side on a dark ground (the oracle's own scenery is not part of the comparison)
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const o = (y * W * 2 + W + x) * 4;
          png.data[o] = 10;
          png.data[o + 1] = 10;
          png.data[o + 2] = 18;
        }
      render(pl, v.moon, Math.sin(k.t * 0.37) * 1.2, Math.sin(k.t * 0.53) * 1.6, png.data, W * 2, W);
      writeFileSync(`${tmp}/${String(f).padStart(3, '0')}.png`, PNG.sync.write(png));
    }
    const file = `${OUT}/uri-2b-${move}-${side}.mp4`;
    const r = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-framerate',
        '60',
        '-i',
        `${tmp}/%03d.png`,
        '-vf',
        'scale=iw*2:ih*2:flags=neighbor',
        '-c:v',
        'libx264',
        '-crf',
        '12',
        '-pix_fmt',
        'yuv420p',
        file,
      ],
      { stdio: 'inherit' },
    );
    console.log(`${file}: ffmpeg exit ${r.status}`);
  }
