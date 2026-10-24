/**
 * A video clip of a fight on the REAL matter world, drawn by the software compositor (dev/titans/blit.ts: the same layers
 * the game draws, no GPU needed), encoded with ffmpeg: .gif (palette-optimised, for chats and docs), .mp4 or .webm.
 *
 *   npx tsx tools/titans/clip.ts out.gif --a=remainder --b=lastone [--seconds=6] [--fps=30] [--skip=0] (ticks before
 *     recording) [--gap=220] [--script0="30:crush"] [--script1=…] [--ai0=4 --ai1=4] (AI levels instead of scripts)
 *     [--cam=mid|0|1] [--w=400] [--h=280] [--scale=2] [--seed=5] [--meter=1] (fighter 0 starts with a full meter)
 *
 * Ticks in scripts count from the first live tick. The camera follows the midpoint of the two fighters (or one of them),
 * eased, at the native 640×360 pixel density, cropped to w×h and scaled up by whole pixels.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LOGICAL_H, LOGICAL_W, parseScript, type Difficulty, type TitanId, type ViewRect } from '@/contracts';
import { createAI } from '@/ai';
import { createMatterWorld } from '@/matter';
import { createAiSource } from '@/sim';
import { getTitanDef } from '@/titans';
import { createScriptSource, makeMatch, skipIntro } from '@/combat/testing/harness';
import { blitLayers, makeFrame, paintBackdrop } from '../../dev/titans/blit';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--'));
if (!out)
  throw new Error('usage: npx tsx tools/titans/clip.ts out.gif --a=<titan> --b=<titan> [--seconds=6]');
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');

const a = opt('a', 'remainder') as TitanId;
const b = opt('b', 'lastone') as TitanId;
const fps = +opt('fps', '30');
const seconds = +opt('seconds', '6');
const W = +opt('w', '400');
const H = +opt('h', '280');
const scale = +opt('scale', '2');
const cam = opt('cam', 'mid');

const m = makeMatch({ a, b, seed: +opt('seed', '5'), createWorld: (s) => createMatterWorld(s) });
skipIntro(m);
const f0 = m.fighters[0] as unknown as { px: number; py: number; meter: number };
const f1 = m.fighters[1] as unknown as { px: number; py: number };
if (opt('gap', '') !== '') {
  f1.px = f0.px + +opt('gap', '220');
  f1.py = f0.py;
}
if (opt('meter', '') !== '') f0.meter = +opt('meter', '1');
const t0 = m.tick;
const source = (slot: 0 | 1, other: TitanId, me: TitanId): ReturnType<typeof createScriptSource> => {
  const lvl = opt(`ai${slot}`, '');
  if (lvl)
    return createAiSource(
      m,
      slot,
      createAI(+lvl as Difficulty, getTitanDef(me), 97 + slot, { footwork: 'orbit' }),
    );
  void other;
  return createScriptSource(parseScript(opt(`script${slot}`, '')), t0 + 1);
};
m.setSources(source(0, b, a), source(1, a, b));
for (let i = 0; i < +opt('skip', '0'); i++) m.step();

mkdirSync(dirname(out), { recursive: true });
const OW = W * scale;
const OH = H * scale;
const ext = out.split('.').pop();
const encode =
  ext === 'gif'
    ? [
        '-vf',
        `split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=full[p];[s1][p]paletteuse=dither=none`,
        '-loop',
        '0',
      ]
    : ext === 'webm'
      ? ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '28', '-pix_fmt', 'yuv420p']
      : [
          '-c:v',
          'libx264',
          '-crf',
          '18',
          '-preset',
          'slow',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
        ];
const ff = spawn(
  'ffmpeg',
  [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${OW}x${OH}`,
    '-r',
    String(fps),
    '-i',
    '-',
    ...encode,
    out,
  ],
  { stdio: ['pipe', 'inherit', 'inherit'] },
);

const frame = makeFrame();
const big = new Uint32Array(OW * OH);
const step = Math.max(1, Math.round(60 / fps));
let camX = NaN;
let camY = NaN;
const frames = Math.round(seconds * fps);
for (let k = 0; k < frames; k++) {
  for (let s = 0; s < step; s++) m.step();
  const v0 = m.fighters[0]!.view;
  const v1 = m.fighters[1]!.view;
  const tx = cam === '0' ? v0.x : cam === '1' ? v1.x : (v0.x + v1.x) / 2;
  const ty = cam === '0' ? v0.y : cam === '1' ? v1.y : (v0.y + v1.y) / 2;
  camX = Number.isNaN(camX) ? tx : camX + (tx - camX) * 0.12;
  camY = Number.isNaN(camY) ? ty : camY + (ty - camY) * 0.12;
  const view: ViewRect = {
    x0: Math.round(camX - LOGICAL_W / 2),
    y0: Math.round(camY - LOGICAL_H / 2),
    w: LOGICAL_W,
    h: LOGICAL_H,
  };
  frame.fill(0xff1a0c08);
  paintBackdrop(frame);
  blitLayers(
    frame,
    [
      ...m.fighters[0]!.renderLayers(view, 1),
      ...m.fighters[1]!.renderLayers(view, 1),
      ...m.world.renderLayers(view, 1),
    ],
    view,
    1,
  );
  const ox = Math.round((LOGICAL_W - W) / 2);
  const oy = Math.round((LOGICAL_H - H) / 2);
  for (let y = 0; y < OH; y++) {
    const sy = oy + Math.floor(y / scale);
    for (let x = 0; x < OW; x++)
      big[y * OW + x] = frame[sy * LOGICAL_W + ox + Math.floor(x / scale)]! | 0xff000000;
  }
  if (!ff.stdin.write(Buffer.from(big.buffer))) await new Promise((r) => ff.stdin.once('drain', r));
}
ff.stdin.end();
await new Promise<void>((r, j) =>
  ff.on('close', (c) => (c === 0 ? r() : j(new Error(`ffmpeg exited ${c}`)))),
);
console.log(`saved ${out}: ${frames} frames at ${fps} fps, ${OW}×${OH}, ${m.tick - t0} ticks`);
