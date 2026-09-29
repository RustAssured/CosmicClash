/**
 * Render a moment of a scripted fight to PNG (real Fighters + Match; fake world unless the matter library is present).
 *   npx tsx tools/titans/frame.ts out.png [--a=lastone --b=asteroid] [--t=200] [--script0="20:strike"] [--script1=...] [--scale=3] [--meter=1] [--focus=0|1]
 * Uses dev/titans/blit.ts as the compositor, so it shows exactly what the layers contain.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LOGICAL_H, LOGICAL_W, parseScript, type TitanId, type ViewRect } from '@/contracts';
import { makeMatch, skipIntro, run, createScriptSource } from '@/combat/testing/harness';
import { blitLayers, makeFrame, paintBackdrop } from '../../dev/titans/blit';
import { writePng } from '../lead/png';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) ?? '.scratch/titans/frame.png';
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const m = makeMatch({
  a: opt('a', 'lastone') as TitanId,
  b: opt('b', 'asteroid') as TitanId,
  seed: +opt('seed', '7'),
});
skipIntro(m);
if (opt('meter', '') !== '')
  for (const f of m.fighters) (f as unknown as { meter: number }).meter = +opt('meter', '0');
const t0 = m.tick;
m.setSources(
  createScriptSource(parseScript(opt('script0', '')), t0 + 1),
  createScriptSource(parseScript(opt('script1', '')), t0 + 1),
);
run(m, +opt('t', '60'));
const a = m.fighters[0].view;
const b = m.fighters[1].view;
const focus = opt('focus', '');
const cx = focus === '0' ? a.x : focus === '1' ? b.x : (a.x + b.x) / 2;
const cy = (focus === '0' ? a.y : focus === '1' ? b.y : (a.y + b.y) / 2) - 30;
const view: ViewRect = {
  x0: Math.round(cx - LOGICAL_W / 2),
  y0: Math.round(cy - LOGICAL_H / 2),
  w: LOGICAL_W,
  h: LOGICAL_H,
};
const frame = makeFrame();
paintBackdrop(frame);
const layers = [
  ...m.fighters[0].renderLayers(view, 1),
  ...m.fighters[1].renderLayers(view, 1),
  ...m.world.renderLayers(view, 1),
];
blitLayers(frame, layers, view, 1);
mkdirSync(dirname(out), { recursive: true });
writePng(out, frame, LOGICAL_W, LOGICAL_H, +opt('scale', '2'));
console.log(
  `saved ${out}  tick=${m.tick} A:${a.state}/${a.moveId ?? '-'} B:${b.state}/${b.moveId ?? '-'} dist=${Math.abs(a.x - b.x).toFixed(0)}`,
);
