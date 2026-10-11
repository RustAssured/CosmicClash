/**
 * Quick headless smoke of the Mouth in a real Match (no AI on the Mouth: scripted bites), against one titan.
 *   npx tsx tools/mouth/smoke.ts [--foe=planet] [--ticks=1200]
 */
import { DEFAULT_ARENA, DEFAULT_LIGHTING, Btn, type MatchConfig, type TitanId } from '@/contracts';
import { createMatterWorld } from '@/matter';
import { createFighter } from '@/combat';
import { createMatch, createScriptSource } from '@/sim';
import { getTitanDef } from '@/titans';
import { arenaForMatch } from '@/combat/mouth/arena';
import type { MouthFighter } from '@/combat/mouth/fighter';

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const foe = arg('foe', 'planet') as TitanId;
const ticks = +arg('ticks', '1200');
const cfg: MatchConfig = {
  seed: 7,
  stage: 'nursery',
  mode: 'versus',
  footwork: 'orbit',
  slots: [
    { titan: 'mouth', controller: 'human' },
    { titan: foe, controller: 'dummy' },
  ],
};
const arena = arenaForMatch(DEFAULT_ARENA, ['mouth', foe]);
const m = createMatch(cfg, {
  createWorld: createMatterWorld,
  createFighter,
  getTitanDef,
  arena,
  lighting: DEFAULT_LIGHTING,
});
const ev = [];
for (let t = 0; t < ticks; t += 90)
  ev.push({
    tick: t,
    buttons: [Btn.STRIKE, Btn.CRUSH, Btn.SIGNATURE][(t / 90) % 3]!,
    hold: 2,
    moveX: 0,
    moveY: 0,
    moveTicks: 0,
  });
m.setSources(createScriptSource(ev, 120), null);
const mf = m.fighters[0] as MouthFighter;
let hits = 0;
const t0 = performance.now();
for (let i = 0; i < ticks; i++) {
  m.step();
  for (const e of m.events) if (e.t === 'hit' && e.attacker === 0) hits++;
  if (i % 120 === 0)
    console.log(
      `t${i} beat=${mf.view.mouth.beat} head=(${mf.view.x.toFixed(0)},${mf.view.y.toFixed(0)}) foe=(${m.fighters[1].view.x.toFixed(0)},${m.fighters[1].view.y.toFixed(0)}) foeInt=${m.fighters[1].view.integrityPct.toFixed(0)} hits=${hits}`,
    );
}
console.log(
  `done ${ticks} ticks in ${(performance.now() - t0).toFixed(0)} ms; mouth hits dealt ${hits}; hash ${m.hash()}`,
);
