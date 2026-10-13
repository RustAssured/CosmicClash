/**
 * THE CRADLE's jaw-organ through a move (real fighters, real matter world): per tick, the move phase and where the jaw is
 * relative to the Cradle's root, facing-relative (+x toward the foe), and the cord's link angles. Calibrates the jaw
 * templates in tools/titans/author/cradle.ts and shows the cord's weight (lag, overshoot, settle).
 *
 *   npx tsx tools/titans/cradle-jaw.ts --script0="10:strike" [--ticks=90] [--b=planet] [--gap=300] [--every=2]
 */
import { parseScript, type TitanId } from '@/contracts';
import type { FighterImpl } from '@/combat';
import { createScriptSource, makeMatch, skipIntro } from '@/combat/testing/harness';
import { createMatterWorld } from '@/matter';
import type { CradleBehaviour } from '@/combat/behaviours/kit/cradle';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const m = makeMatch({
  a: 'cradle' as TitanId,
  b: opt('b', 'planet') as TitanId,
  seed: +opt('seed', '7'),
  createWorld: (s) => createMatterWorld(s),
});
skipIntro(m);
const fa = m.fighters[0] as FighterImpl;
const fb = m.fighters[1] as FighterImpl;
const gap = +opt('gap', '300');
fa.px = 800 - gap / 2;
fb.px = 800 + gap / 2;
if (opt('meter', '') !== '') fa.meter = +opt('meter', '0');
m.setSources(
  createScriptSource(parseScript(opt('script0', '')), m.tick + 1),
  createScriptSource(parseScript(opt('script1', '')), m.tick + 1),
);
const beh = fa.behaviour as unknown as CradleBehaviour;
const pt = { x: 0, y: 0 };
const every = +opt('every', '2');
for (let t = 1; t <= +opt('ticks', '90'); t++) {
  m.step();
  if (t % every) continue;
  const rig = beh.rigBuild.rig;
  const has = beh.jawPoint(pt);
  const jx = has ? (pt.x - fa.px) * fa.facing : NaN;
  const jy = has ? pt.y - fa.py : NaN;
  const angs = beh.rigBuild.cord.slice(0, beh.cordLinks).map((b) => rig.a[b]!.toFixed(2));
  if (opt('pos', '') === '1') {
    const fr = { x: 0, y: 0, a: 0 };
    const ps = beh.rigBuild.cord.slice(0, beh.cordLinks).map((b) => {
      rig.frame(b, fr);
      return `${(fr.x - fa.px * fa.facing).toFixed(0)},${(fr.y - fa.py).toFixed(0)}`;
    });
    console.log('      frames ' + ps.join(' '));
  }
  const disc = beh.rigBuild.disc >= 0 ? rig.a[beh.rigBuild.disc]!.toFixed(2) : '-';
  const mv = fa.mv;
  console.log(
    `t${String(t).padStart(3)} ${fa.state.padEnd(8)} ${(mv.def?.id ?? '').padEnd(18)} ${mv.phase.padEnd(8)} ${String(mv.phaseTick).padStart(3)}` +
      `  jaw ${jx.toFixed(0).padStart(4)},${jy.toFixed(0).padStart(4)}  disc ${disc}  cord ${angs.join(' ')}  foe ${fb.view.integrityPct.toFixed(0)}%`,
  );
}
