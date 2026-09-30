/**
 * Filmstrip of a scripted fight: the same crop of the scene at several ticks, side by side, on the REAL matter world.
 *   npx tsx tools/titans/strip.ts out.png --a=lastone --b=asteroid --script0="4:crush" --gap=130 --ticks=30,40,46,52,60,75,100 [--w=260] [--scale=1] [--focus=1]
 * Ticks are counted from the start of the script. The crop follows the focused fighter (default: the foe, fighter 1), so knock-back
 * reads as the body sliding through a fixed-size window plus the scene moving behind it.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LOGICAL_H, LOGICAL_W, parseScript, type TitanId, type ViewRect } from '@/contracts';
import { createMatterWorld } from '@/matter';
import { createScriptSource, makeMatch, skipIntro } from '@/combat/testing/harness';
import { blitLayers, makeFrame, paintBackdrop } from '../../dev/titans/blit';
import { writePng } from '../lead/png';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) ?? '.scratch/titans/strip.png';
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const m = makeMatch({
  a: opt('a', 'lastone') as TitanId,
  b: opt('b', 'asteroid') as TitanId,
  seed: +opt('seed', '5'),
  createWorld: (s) => createMatterWorld(s),
});
skipIntro(m);
const gap = +opt('gap', '130');
const fa = m.fighters[0] as unknown as { px: number; py: number; meter: number };
const fb = m.fighters[1] as unknown as { px: number; py: number };
fb.px = fa.px + gap;
fb.py = fa.py;
if (opt('meter', '') !== '') fa.meter = +opt('meter', '0');
const t0 = m.tick;
m.setSources(
  createScriptSource(parseScript(opt('script0', '')), t0 + 1),
  createScriptSource(parseScript(opt('script1', '')), t0 + 1),
);
const ticks = opt('ticks', '30,40,46,52,60,75,100').split(',').map(Number);
const cw = +opt('w', '260');
const ch = 200;
const scale = +opt('scale', '1');
const focus = +opt('focus', '1');
// the crop origin is fixed to where the focused fighter starts, so travel is visible against the frame
const startX = focus === 1 ? fb.px : fa.px;
const startY = (focus === 1 ? fb.py : fa.py) - 20;
const strip = new Uint32Array(cw * ticks.length * ch);
const sw = cw * ticks.length;
const frame = makeFrame();
for (let k = 0; k < ticks.length; k++) {
  while (m.tick - t0 < ticks[k]!) m.step();
  const cx = startX + (m.fighters[focus]!.view.x - startX) * 0.35;
  const view: ViewRect = {
    x0: Math.round(cx - LOGICAL_W / 2),
    y0: Math.round(startY - LOGICAL_H / 2),
    w: LOGICAL_W,
    h: LOGICAL_H,
  };
  frame.fill(0xff1a0c08);
  paintBackdrop(frame);
  const layers = [
    ...m.fighters[0]!.renderLayers(view, 1),
    ...m.fighters[1]!.renderLayers(view, 1),
    ...m.world.renderLayers(view, 1),
  ];
  blitLayers(frame, layers, view, 1);
  const ox = Math.round((LOGICAL_W - cw) / 2);
  const oy = Math.round((LOGICAL_H - ch) / 2);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const px = frame[(y + oy) * LOGICAL_W + x + ox]!;
      // a thin divider and the tick label position are left to the filename; the divider keeps frames apart
      strip[y * sw + k * cw + x] = x === 0 ? 0xffffffff : px;
    }
  const v = m.fighters[focus]!.view;
  console.log(
    `t+${ticks[k]}: focus x=${v.x.toFixed(0)} (moved ${(v.x - startX).toFixed(0)}) state=${v.state} lean=${(m.fighters[focus] as unknown as { body: { transform: { lean: number } } }).body.transform.lean}`,
  );
}
mkdirSync(dirname(out), { recursive: true });
writePng(out, strip, sw, ch, scale);
console.log(`saved ${out} (${ticks.length} frames of ${cw}x${ch})`);
