/**
 * Filmstrip of a scripted fight with the Last One played as the WITNESS (what `witness=1` selects), on the real matter world,
 * composited with the software blitter (rig parts drawn by the shared rotation sampler).
 *   npx tsx tools/titans/witness-fight.ts [out.png] [--b=planet] [--gap=260] [--script0="4:crush"] [--script1=""]
 *       [--ticks=0,20,40,60] [--w=320] [--h=240] [--scale=2] [--meter=1]
 * --meter fills the Witness's super meter first (the Ultimate needs it).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  LOGICAL_H,
  LOGICAL_W,
  parseScript,
  type MatchConfig,
  type TitanId,
  type ViewRect,
} from '@/contracts';
import { createMatterWorld } from '@/matter';
import { createMatch, createScriptSource } from '@/sim';
import { getTitanDef } from '@/titans';
import { createFighter, type FighterImpl } from '@/combat';
import { skipIntro } from '@/combat/testing/harness';
import { blitLayers, makeFrame, paintBackdrop } from '../../dev/titans/blit';
import { writePng } from '../lead/png';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) ?? 'docs/gallery/wip/witness-fight.png';
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const cfg: MatchConfig = {
  seed: +opt('seed', '7'),
  stage: 'nursery',
  mode: 'versus',
  slots: [
    { titan: 'colossus', controller: 'human' },
    { titan: opt('b', 'planet') as TitanId, controller: 'human' },
  ],
  witness: true,
};
const m = createMatch(cfg, {
  createWorld: (s) => createMatterWorld(s),
  createFighter,
  getTitanDef,
  arena: DEFAULT_ARENA,
  lighting: DEFAULT_LIGHTING,
});
skipIntro(m);
const fa = m.fighters[0] as unknown as { px: number; py: number };
const fb = m.fighters[1] as unknown as { px: number; py: number };
fb.px = fa.px + +opt('gap', '260');
fb.py = fa.py;
if (opt('meter', '0') !== '0') (m.fighters[0] as FighterImpl).debugSetMeter(+opt('meter', '1'));
const t0 = m.tick;
m.setSources(
  createScriptSource(parseScript(opt('script0', '')), t0 + 1),
  createScriptSource(parseScript(opt('script1', '')), t0 + 1),
);
const ticks = opt('ticks', '0,20,40,60').split(',').map(Number);
const cw = +opt('w', '320');
const ch = +opt('h', '240');
const sw = cw * ticks.length;
const strip = new Uint32Array(sw * ch);
const frame = makeFrame();
for (let k = 0; k < ticks.length; k++) {
  while (m.tick - t0 < ticks[k]!) m.step();
  const v = m.fighters[0]!.view;
  const view: ViewRect = {
    x0: Math.round(v.x - LOGICAL_W / 2 + 60),
    y0: Math.round(v.y - LOGICAL_H / 2),
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
  const ox = Math.round((LOGICAL_W - cw) / 2);
  const oy = Math.round((LOGICAL_H - ch) / 2);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++)
      strip[y * sw + k * cw + x] = x === 0 ? 0xffffffff : frame[(y + oy) * LOGICAL_W + x + ox]!;
  console.log(`t+${ticks[k]}: state=${v.state} integrity=${v.integrityPct.toFixed(0)}% parts=${v.parts}`);
}
mkdirSync(dirname(out), { recursive: true });
writePng(out, strip, sw, ch, +opt('scale', '2'));
console.log(`saved ${out}`);
