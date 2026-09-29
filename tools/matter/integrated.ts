/**
 * Headless integrated hit log: run the REAL Match (real titans, fighters, matter world) and print, for every DamageEvent the
 * fighters pass to `world.applyDamage`, what went in and what the matter world reported and did (stats/ledger deltas around
 * the call and 120 ticks later). Use it to check that what the fighters send is what the matter world receives and how much
 * of it lands.
 *   npx tsx tools/matter/integrated.ts [a=lastone] [b=asteroid] [script0=4:crush] [ticks=260] [gap=190] [seed=5]
 */
import { ROUND_INTRO_TICKS, type DamageEvent, type MatterWorld } from '@/contracts';
import { parseScript } from '@/contracts/harness';
import { createFighter } from '@/combat';
import { createMatterWorld } from '@/matter';
import { createMatch, createScriptSource } from '@/sim';
import { STAGES } from '@/stages';
import { getTitanDef } from '@/titans';

const arg = (k: string, d: string): string =>
  process.argv
    .find((a) => a.startsWith(`${k}=`))
    ?.split('=')
    .slice(1)
    .join('=') ?? d;
const a = arg('a', 'lastone') as 'lastone' | 'asteroid';
const b = arg('b', 'asteroid') as 'lastone' | 'asteroid';
const ticks = Number(arg('ticks', '260'));
const stageId = arg('stage', 'nursery') as 'nursery';
const stage = STAGES[stageId];

const match = createMatch(
  {
    seed: Number(arg('seed', '5')),
    stage: stageId,
    mode: 'versus',
    slots: [
      { titan: a, controller: 'dummy' },
      { titan: b, controller: 'dummy' },
    ],
    startGap: Number(arg('gap', '190')),
  } as never,
  {
    createWorld: (seed) => {
      const w = createMatterWorld(seed);
      const orig = w.applyDamage.bind(w);
      (w as MatterWorld).applyDamage = (bodyId: number, ev: DamageEvent) => {
        const before = w.stats(bodyId);
        const m0 = before.mass;
        const c0 = before.cells;
        const L0 = w.ledger();
        const r = orig(bodyId, ev);
        const after = w.stats(bodyId);
        console.log(
          `tick ${match.tick} body ${bodyId} ${ev.type} E=${ev.energy.toFixed(0)} dur=${ev.duration} flags=${ev.flags} ` +
            `shape=${ev.shape.kind} params=${JSON.stringify(ev.params)}\n` +
            `   -> touched ${r.cellsTouched} removed ${r.cellsRemoved} mass ${r.massRemoved.toFixed(1)} | ` +
            `stats d(cells) ${after.cells - c0} d(mass) ${(after.mass - m0).toFixed(1)} | ledger err ${(w.ledger().error - L0.error).toExponential(1)}`,
        );
        pending.push({ tick: match.tick, bodyId, m0, type: ev.type, energy: ev.energy });
        return r;
      };
      return w;
    },
    createFighter,
    getTitanDef,
    arena: stage.arena,
    lighting: stage.lighting,
  },
);
interface Pend {
  tick: number;
  bodyId: number;
  m0: number;
  type: string;
  energy: number;
}
const pending: Pend[] = [];
match.setSources(createScriptSource(parseScript(arg('script0', '4:crush')), ROUND_INTRO_TICKS), null);
for (let t = 0; t < ROUND_INTRO_TICKS + ticks; t++) {
  match.step();
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i]!;
    if (match.tick - p.tick >= 120) {
      const s = match.world.stats(p.bodyId);
      console.log(
        `   .. ${p.type} E=${p.energy.toFixed(0)} @${p.tick}: after 120 ticks the body lost ${(((p.m0 - s.mass) / s.initialMass) * 100).toFixed(2)}% of its initial mass (massFrac ${s.massFrac.toFixed(3)})`,
      );
      pending.splice(i, 1);
    }
  }
}
