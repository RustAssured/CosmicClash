/**
 * Frame series: composite several moments of a scripted fight (real Fighters, real matter world, the layers exactly as the
 * renderer would receive them) into ONE contact sheet, so an effect can be read through time.
 *   npx tsx tools/titans/series.ts out.png --a=supernova --b=asteroid --script0="1:crush" --ticks=2,20,34,50 [--gap=200] [--meter=1]
 *        [--script1=…] [--focus=0|1|mid] [--crop=420x260] [--cols=2] [--scale=2] [--seed=7] [--dx=0] [--dy=0]
 * Ticks count from the tick the fight goes live (the same clock the scripts use). The crop is centred on `--focus` (default: the
 * attacker) so the effect fills the frame.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LOGICAL_H, LOGICAL_W, parseScript, type TitanId, type ViewRect } from '@/contracts';
import { createMatterWorld } from '@/matter';
import type { FighterImpl } from '@/combat';
import { createScriptSource, makeMatch, skipIntro } from '@/combat/testing/harness';
import { blitLayers, makeFrame, paintBackdrop } from '../../dev/titans/blit';
import { writeContactSheet } from '../lead/png';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) ?? '.scratch/titans/series.png';
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');

const ticks = opt('ticks', '2,20,40,60')
  .split(',')
  .map(Number)
  .sort((a, b) => a - b);
const [cw, ch] = opt('crop', '420x260').split('x').map(Number) as [number, number];
const gap = +opt('gap', '260');
const focusOpt = opt('focus', '0');
const m = makeMatch({
  a: opt('a', 'supernova') as TitanId,
  b: opt('b', 'asteroid') as TitanId,
  seed: +opt('seed', '7'),
  createWorld: (s) => createMatterWorld(s),
});
skipIntro(m);
const fa = m.fighters[0] as FighterImpl;
const fb = m.fighters[1] as FighterImpl;
fa.px = 800 - gap / 2;
fb.px = 800 + gap / 2;
if (opt('meter', '') !== '')
  for (const f of m.fighters) (f as unknown as { meter: number }).meter = +opt('meter', '0');
const t0 = m.tick;
m.setSources(
  createScriptSource(parseScript(opt('script0', '')), t0 + 1),
  createScriptSource(parseScript(opt('script1', '')), t0 + 1),
);

const items: { pixels: Uint32Array; w: number; h: number }[] = [];
let at = 0;
for (const target of ticks) {
  while (at < target) {
    m.step();
    at++;
  }
  const a = m.fighters[0].view;
  const b = m.fighters[1].view;
  const cx = (focusOpt === '1' ? b.x : focusOpt === 'mid' ? (a.x + b.x) / 2 : a.x) + +opt('dx', '0');
  const cy = (focusOpt === '1' ? b.y : focusOpt === 'mid' ? (a.y + b.y) / 2 : a.y) - 10 + +opt('dy', '0');
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
    [
      ...m.fighters[0].renderLayers(view, 1),
      ...m.fighters[1].renderLayers(view, 1),
      ...m.world.renderLayers(view, 1),
    ],
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
writeContactSheet(out, items, +opt('cols', '2'), +opt('scale', '2'), 3);
const a = m.fighters[0].view;
console.log(
  `saved ${out}: ticks ${ticks.join(',')}  A ${a.state}/${a.moveId ?? '-'} fuel/res ${a.resource.toFixed(1)} mass ${a.bodyStats.massFrac.toFixed(2)}`,
);
