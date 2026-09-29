import { DEFAULT_ARENA, DEFAULT_LIGHTING, type Difficulty, type TitanId } from '@/contracts';
import { createFighter } from '@/combat';
import { createFakeWorld } from '@/combat/testing/fakeWorld';
import { createAiSource, createMatch } from '@/sim';
import { getTitanDef } from '@/titans';
import { createAI } from '@/ai';
const t = (process.argv[2] ?? 'lastone') as TitanId;
const l0 = +(process.argv[3] ?? 6) as Difficulty, l1 = +(process.argv[4] ?? 1) as Difficulty;
for (let seed = 1; seed <= 6; seed++) {
  const match = createMatch({ seed, stage: 'nursery', mode: 'aivai', slots: [{ titan: t, controller: 'ai', aiLevel: l0 }, { titan: t, controller: 'ai', aiLevel: l1 }] }, { createWorld: (s) => createFakeWorld(s), createFighter, getTitanDef, arena: DEFAULT_ARENA, lighting: DEFAULT_LIGHTING });
  match.setSources(createAiSource(match, 0, createAI(l0, getTitanDef(t), seed * 5)), createAiSource(match, 1, createAI(l1, getTitanDef(t), seed * 5 + 1)));
  const stat = [{ hits: 0, e: 0, cells: 0, sidestep: 0, guard: 0 }, { hits: 0, e: 0, cells: 0, sidestep: 0, guard: 0 }];
  let ticks = 0;
  while (match.phase !== 'matchend' && ticks < 60 * 60 * 3) {
    match.step(); ticks++;
    for (const e of match.events) {
      if (e.t === 'hit') { stat[e.attacker]!.hits++; stat[e.attacker]!.e += e.energy; stat[e.attacker]!.cells += e.cellsRemoved; }
      if (e.t === 'surge') stat[e.slot]!.sidestep++;
      if (e.t === 'guard') stat[e.slot]!.guard++;
    }
  }
  console.log(`seed ${seed} wins ${match.wins} ${(ticks / 60).toFixed(0)}s  L${l0}: hits ${stat[0]!.hits} E ${stat[0]!.e.toFixed(0)} surges ${stat[0]!.sidestep} guards ${stat[0]!.guard}   L${l1}: hits ${stat[1]!.hits} E ${stat[1]!.e.toFixed(0)} surges ${stat[1]!.sidestep} guards ${stat[1]!.guard}`);
}
