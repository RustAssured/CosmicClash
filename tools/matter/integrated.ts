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
        lastHitTick = match.tick;
        pending.push({
          tick: match.tick,
          bodyId,
          m0,
          type: ev.type,
          energy: ev.energy,
          imm: m0 - after.mass,
        });
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
  imm: number;
}
const pending: Pend[] = [];
let lastMass = match.world.stats(1).mass;
let lastHitTick = -9999;
const lossBy = [0, 0, 0];
const CHECKS = [20, 40, 90, 300, 900];
match.setSources(createScriptSource(parseScript(arg('script0', '4:crush')), ROUND_INTRO_TICKS), null);
for (let t = 0; t < ROUND_INTRO_TICKS + ticks; t++) {
  match.step();
  {
    const st = match.world.stats(1);
    const d = lastMass - st.mass;
    lastMass = st.mass;
    if (d > 0) {
      const since = match.tick - lastHitTick;
      lossBy[since <= 30 ? 0 : since <= 300 ? 1 : 2]! += d;
    }
  }
  for (const p of pending) {
    for (const c of CHECKS) {
      if (match.tick - p.tick !== c) continue;
      const s = match.world.stats(p.bodyId);
      const lost = p.m0 - s.mass;
      console.log(
        `   .. ${p.type} E=${p.energy.toFixed(0)} @${p.tick} +${c} ticks: lost ${((lost / s.initialMass) * 100).toFixed(2)}% of initial mass, of which immediate ${((p.imm / s.initialMass) * 100).toFixed(2)}% (delayed share ${lost > 0 ? (((lost - p.imm) / lost) * 100).toFixed(0) : 0}%)`,
      );
    }
  }
}
{
  const tot = lossBy[0]! + lossBy[1]! + lossBy[2]!;
  if (tot > 0)
    console.log(
      `mass lost on body 1 by time since the latest blow: <=30 ticks ${((lossBy[0]! / tot) * 100).toFixed(0)}%, 31-300 ${((lossBy[1]! / tot) * 100).toFixed(0)}%, >300 ${((lossBy[2]! / tot) * 100).toFixed(0)}%`,
    );
}
