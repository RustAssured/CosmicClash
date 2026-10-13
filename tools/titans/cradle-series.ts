/**
 * THE CRADLE through time: a scripted fight (real fighters, real matter world, the layers as the renderer receives them)
 * composited into one contact sheet, with Cradle-only hooks: `--sever=<tick>` cuts the cord at its root on that tick (as a
 * failed root joint would), `--hurt=<tick>:<frac>` carves the Cradle's bodies to a mass fraction, `--meter=1` fills it.
 *
 *   npx tsx tools/titans/cradle-series.ts out.png --script0="10:strike" --ticks=20,30,40 [--b=asteroid] [--gap=230]
 *        [--crop=480x320] [--cols=4] [--scale=2] [--dx=60] [--dy=0] [--sever=60] [--hurt=30:0.5] [--focus=0|1|mid]
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LOGICAL_H, LOGICAL_W, parseScript, type TitanId, type ViewRect } from '@/contracts';
import { createMatterWorld } from '@/matter';
import type { FighterImpl } from '@/combat';
import type { CradleBehaviour } from '@/combat/behaviours/kit/cradle';
import { createScriptSource, makeMatch, skipIntro } from '@/combat/testing/harness';
import { blitLayers, makeFrame, paintBackdrop } from '../../dev/titans/blit';
import { writeContactSheet } from '../lead/png';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) ?? '.scratch/cradle/series.png';
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const ticks = opt('ticks', '2,20,40,60')
  .split(',')
  .map(Number)
  .sort((a, b) => a - b);
const [cw, ch] = opt('crop', '480x320').split('x').map(Number) as [number, number];
const m = makeMatch({
  a: (opt('a', 'cradle') as TitanId) ?? 'cradle',
  b: opt('b', 'asteroid') as TitanId,
  seed: +opt('seed', '7'),
  createWorld: (s) => createMatterWorld(s),
});
skipIntro(m);
const fa = m.fighters[0] as FighterImpl;
const fb = m.fighters[1] as FighterImpl;
const gap = +opt('gap', '230');
fa.px = 800 - gap / 2;
fb.px = 800 + gap / 2;
if (opt('meter', '') !== '') fa.meter = +opt('meter', '0');
m.setSources(
  createScriptSource(parseScript(opt('script0', '')), m.tick + 1),
  createScriptSource(parseScript(opt('script1', '')), m.tick + 1),
);
const beh = fa.behaviour as unknown as CradleBehaviour;
const sever = +opt('sever', '-1');
const [hurtAt, hurtFrac] = opt('hurt', '-1:1').split(':').map(Number) as [number, number];
const items: { pixels: Uint32Array; w: number; h: number }[] = [];
let at = 0;
for (const target of ticks) {
  while (at < target) {
    m.step();
    at++;
    if (at === sever) beh.debugSever();
    if (at === +opt('plant', '-1')) beh.debugPlant(fb.view.x - 10, fb.view.y + 5, 900, true);
    if (at === hurtAt)
      for (const b of [fa.body, ...beh.regionBodies.slice(0, opt('hurtcord', '1') === '1' ? undefined : 1)])
        m.world.carve(b.id, hurtFrac, 77 + b.id);
  }
  const a = fa.view;
  const b = fb.view;
  const focus = opt('focus', '0');
  const cx = (focus === '1' ? b.x : focus === 'mid' ? (a.x + b.x) / 2 : a.x) + +opt('dx', '60');
  const cy = (focus === '1' ? b.y : focus === 'mid' ? (a.y + b.y) / 2 : a.y) + 30 + +opt('dy', '0');
  const view: ViewRect = {
    x0: Math.round(cx - LOGICAL_W / 2),
    y0: Math.round(cy - LOGICAL_H / 2),
    w: LOGICAL_W,
    h: LOGICAL_H,
  };
  const frame = makeFrame();
  paintBackdrop(frame);
  blitLayers(
    frame,
    [...fa.renderLayers(view, 1), ...fb.renderLayers(view, 1), ...m.world.renderLayers(view, 1)],
    view,
    1,
  );
  const px = new Uint32Array(cw * ch);
  const ox = (LOGICAL_W - cw) >> 1;
  const oy = (LOGICAL_H - ch) >> 1;
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) px[y * cw + x] = frame[(y + oy) * LOGICAL_W + x + ox]!;
  items.push({ pixels: px, w: cw, h: ch });
}
mkdirSync(dirname(out), { recursive: true });
writeContactSheet(out, items, +opt('cols', '4'), +opt('scale', '2'), 3);
console.log(
  `saved ${out}: ticks ${ticks.join(',')}  cradle ${fa.view.state} ${fa.view.integrityPct.toFixed(0)}%  cord links ${beh.cordLinks} cuts ${beh.cordCuts}  gestation ${JSON.stringify(beh.gestation)}  foe ${fb.view.integrityPct.toFixed(0)}%`,
);
