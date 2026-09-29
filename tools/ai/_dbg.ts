import { DEFAULT_ARENA, DEFAULT_LIGHTING } from '@/contracts';
import { createMatterWorld } from '@/matter';
import { createFighter } from '@/combat';
import { createMatch, createAiSource } from '@/sim';
import { getTitanDef } from '@/titans';
import { createAI } from '@/ai';
const match = createMatch({ seed: 1, stage: 'nursery', mode: 'aivai', slots: [{ titan: 'lastone', controller: 'ai', aiLevel: 3 }, { titan: 'asteroid', controller: 'dummy' }] }, { createWorld: (s) => createMatterWorld(s), createFighter, getTitanDef, arena: DEFAULT_ARENA, lighting: DEFAULT_LIGHTING });
match.setSources(createAiSource(match, 0, createAI(3, getTitanDef('lastone'), 5)), null);
let lastMass = 1;
const sums: Record<string, number> = {};
for (let i = 0; i < 4000; i++) {
  match.step();
  for (const e of match.events) {
    if (e.t === 'hit') sums[`hit ${e.attacker}->${e.target} ${e.type}`] = (sums[`hit ${e.attacker}->${e.target} ${e.type}`] ?? 0) + e.massRemoved;
    if (e.t === 'matter') sums[`matter ${e.kind} slot${e.slot}`] = (sums[`matter ${e.kind} slot${e.slot}`] ?? 0) + e.mass;
  }
  const m0 = match.fighters[0].view.bodyStats.massFrac;
  if (m0 < lastMass - 0.02) { console.log('tick', i, 'lastone massFrac', m0.toFixed(3), 'state', match.fighters[0].view.state, match.fighters[0].view.moveId); lastMass = m0; }
}
console.log(sums);
