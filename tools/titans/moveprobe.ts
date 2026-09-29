/**
 * Move probe: how much of an idle opposing body does each of a titan's moves remove when it lands? The pacing targets (Strike
 * ~2–5 %, Crush ~6–15 %, Ultimate ~25–45 % of a fully exposed body, delayed damage a minority of the total) are measured HERE, on
 * the real matter world through the real Match and Fighters, with the foe standing still.
 *   npx tsx tools/titans/moveprobe.ts --a=supernova --b=asteroid [--gap=170] [--slots=strike,crush,signature,ultimate] [--aim=forward]
 *                                     [--hold=N] [--settle=300] [--seed=7] [--y=0]
 * Prints, per move: the nominal energy, the share of the foe's initial mass gone 40 ticks after the button press (immediate) and
 * after `settle` ticks (with cracks, fire and detached slabs), the hits that connected, and what the attacker lost.
 */
import { Btn, type AimDir, type MoveSlot, type SimEvent, type TitanId } from '@/contracts';
import { createMatterWorld } from '@/matter';
import type { FighterImpl } from '@/combat';
import { ManualSource, makeMatch, skipIntro } from '@/combat/testing/harness';
import { getTitanDef } from '@/titans';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');

const A = opt('a', 'supernova') as TitanId;
const B = opt('b', 'asteroid') as TitanId;
const gap = +opt('gap', '170');
const settle = +opt('settle', '300');
const seed = +opt('seed', '7');
const dy = +opt('y', '0');
const aim = opt('aim', 'forward') as AimDir;
const slots = opt('slots', 'strike,crush,signature,ultimate').split(',') as MoveSlot[];
const holdOpt = opt('hold', '');

const BTN: Partial<Record<MoveSlot, number>> = {
  strike: Btn.STRIKE,
  crush: Btn.CRUSH,
  signature: Btn.SIGNATURE,
  ultimate: Btn.ULTIMATE,
  surge: Btn.SURGE,
};

const defA = getTitanDef(A);
console.log(`${A} → ${B}  (gap ${gap} px, aim ${aim}, foe idle, real matter world)\n`);
console.log(
  'move'.padEnd(26),
  'energy'.padStart(7),
  'hits'.padStart(5),
  'gone@40'.padStart(9),
  `gone@${settle}`.padStart(9),
  'delayed'.padStart(9),
  'self'.padStart(7),
  'integrity'.padStart(10),
);

for (const slot of slots) {
  const move = defA.moves.find((mv) => mv.slot === slot && !mv.extra?.['followUpOnly']);
  if (!move) continue;
  const m = makeMatch({ a: A, b: B, seed, createWorld: (s) => createMatterWorld(s) });
  skipIntro(m);
  const fa = m.fighters[0] as FighterImpl;
  const fb = m.fighters[1] as FighterImpl;
  // stage the contact: A on the left, B `gap` px to its right, both at rest altitude
  fa.px = 800 - gap / 2;
  fb.px = 800 + gap / 2;
  fb.py = fa.py + dy;
  fa.meter = 1;
  fb.meter = 0;
  const src = new ManualSource();
  m.setSources(src, null);
  const ini = fb.view.bodyStats.initialMass;
  const iniA = fa.view.bodyStats.initialMass;
  const v = move.variants[aim];
  const chargeMax = (v.frame?.chargeMax ?? move.frame.chargeMax) | 0;
  const hold = holdOpt !== '' ? +holdOpt : chargeMax;
  let hits = 0;
  let gone40 = 0;
  const btn = BTN[slot]!;
  src.moveY = aim === 'up' ? -1 : aim === 'down' ? 1 : 0;
  for (let t = 1; t <= settle; t++) {
    src.held = t <= (chargeMax > 0 ? 1 + move.frame.startup + hold : 3) ? btn : 0;
    m.step();
    for (const e of m.events as readonly SimEvent[])
      if (e.t === 'hit' && e.attacker === 0) {
        hits++;
      }
    if (t === 40) gone40 = 1 - fb.view.bodyStats.mass / ini;
  }
  const gone = 1 - fb.view.bodyStats.mass / ini;
  const self = 1 - fa.view.bodyStats.mass / iniA;
  const nominal = v.hitboxes.reduce(
    (s, h) => s + h.damage.energy * (h.damage.flags & 16 ? h.to - h.from : 1),
    0,
  );
  console.log(
    `${move.name} (${slot})`.padEnd(26),
    String(Math.round(nominal)).padStart(7),
    String(hits).padStart(5),
    `${(gone40 * 100).toFixed(1)}%`.padStart(9),
    `${(gone * 100).toFixed(1)}%`.padStart(9),
    `${gone > 0 ? (((gone - gone40) / gone) * 100).toFixed(0) : '0'}%`.padStart(9),
    `${(self * 100).toFixed(1)}%`.padStart(7),
    `${fb.view.integrityPct.toFixed(0)}%`.padStart(10),
  );
}
