/**
 * End-to-end move damage table: every damaging move of an attacker titan, pressed against an IDLE and a GUARDING dummy of the
 * defender titan on the REAL matter world, at a range of starting gaps. Reports, per move, for the gaps where it connected:
 * the percent of the defender's initial mass removed (mean / min / max) `settle` ticks after the press, the share of gaps where it
 * connected at all, and the mean hits per press. This is what the pacing targets are judged on (Strike 2-5 %, Crush 6-15 %,
 * Ultimate 25-45 % of a full body): it includes the lunge, hit-stop, parts interception, guard and the matter models.
 *
 *   npx tsx tools/ai/moves.ts [--a=lastone] [--b=asteroid] [--gaps=70:295:25] [--settle=300] [--slots=strike,crush,signature,ultimate]
 */
import { Btn, type MoveSlot, type TitanId } from '@/contracts';
import { createMatterWorld } from '@/matter';
import { makeMatch, skipIntro, ManualSource } from '@/combat/testing/harness';
import { getTitanDef } from '@/titans';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const A = opt('a', 'lastone') as TitanId;
const B = opt('b', 'asteroid') as TitanId;
const [g0, g1, gs] = opt('gaps', '70:295:25').split(':').map(Number) as [number, number, number];
const SETTLE = +opt('settle', '300');
const SLOTS = opt('slots', 'strike,crush,signature,ultimate').split(',') as MoveSlot[];

const BTN: Partial<Record<MoveSlot, number>> = {
  strike: Btn.STRIKE,
  crush: Btn.CRUSH,
  signature: Btn.SIGNATURE,
  ultimate: Btn.ULTIMATE,
};

interface Trial {
  gap: number;
  removed: number;
  hits: number;
  heaviest: number;
}

function press(slot: MoveSlot, gap: number, guard: boolean): Trial {
  const m = makeMatch({ a: A, b: B, seed: 5, createWorld: (s) => createMatterWorld(s) });
  skipIntro(m);
  const a = new ManualSource();
  const b = new ManualSource();
  m.setSources(a, b);
  const fa = m.fighters[0] as unknown as { px: number; py: number; meter: number };
  const fb = m.fighters[1] as unknown as { px: number; py: number };
  fb.px = fa.px + gap;
  fb.py = fa.py;
  if (slot === 'ultimate') fa.meter = 1;
  let hits = 0;
  let heaviest = 0;
  const target = m.fighters[1]!;
  const before = target.view.bodyStats.mass;
  const total = slot === 'ultimate' ? SETTLE + 200 : SETTLE;
  for (let i = 0; i < total; i++) {
    // let the fighters settle for a few ticks, then press (held for a signature/ultimate's whole charge window)
    if (i === 6) a.held = BTN[slot]!;
    else if (i === 7 && slot !== 'signature') a.held = 0;
    else if (i === 46 && slot === 'signature') a.held = 0;
    if (guard && i >= 2) b.held = Btn.GUARD;
    m.step();
    for (const e of m.events)
      if (e.t === 'hit' && e.attacker === 0) {
        hits++;
        if (e.energy > heaviest) heaviest = e.energy;
      }
  }
  const after = target.view.bodyStats.mass;
  return { gap, removed: (100 * (before - after)) / Math.max(1e-6, before), hits, heaviest };
}

const def = getTitanDef(A);
const gaps: number[] = [];
for (let g = g0; g <= g1; g += gs) gaps.push(g);
console.log(`${A} → ${B}   (mass removed, % of the defender's initial mass, ${SETTLE} ticks after the press; gaps ${gaps.join(',')})`);
for (const slot of SLOTS) {
  const mv = def.moves.find((x) => x.slot === slot);
  if (!mv) continue;
  for (const guard of [false, true]) {
    const trials = gaps.map((g) => press(slot, g, guard));
    const hit = trials.filter((t) => t.hits > 0);
    const rem = hit.map((t) => t.removed);
    const mean = rem.length ? rem.reduce((x, y) => x + y, 0) / rem.length : 0;
    const min = rem.length ? Math.min(...rem) : 0;
    const max = rem.length ? Math.max(...rem) : 0;
    const hpp = hit.length ? hit.reduce((x, t) => x + t.hits, 0) / hit.length : 0;
    console.log(
      `${mv.id.padEnd(20)} ${guard ? 'guard' : 'idle '}  connects ${hit.length}/${gaps.length}  removed mean ${mean.toFixed(1).padStart(5)}%  min ${min.toFixed(1).padStart(5)}%  max ${max.toFixed(1).padStart(5)}%  hits/press ${hpp.toFixed(1)}   per gap: ${trials.map((t) => (t.hits > 0 ? t.removed.toFixed(0) : '.')).join(' ')}`,
    );
  }
}
