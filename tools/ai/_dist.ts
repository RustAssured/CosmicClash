import { DEFAULT_ARENA, DEFAULT_LIGHTING, type Difficulty, type TitanId } from '@/contracts';
import { createFighter } from '@/combat';
import { createFakeWorld } from '@/combat/testing/fakeWorld';
import { createAiSource, createMatch } from '@/sim';
import { getTitanDef } from '@/titans';
import { createAI } from '@/ai';
const t = 'lastone' as TitanId; const seed = 4;
const match = createMatch({ seed, stage: 'nursery', mode: 'aivai', slots: [{ titan: t, controller: 'ai', aiLevel: 6 }, { titan: t, controller: 'ai', aiLevel: 1 }] }, { createWorld: (s) => createFakeWorld(s), createFighter, getTitanDef, arena: DEFAULT_ARENA, lighting: DEFAULT_LIGHTING });
match.setSources(createAiSource(match, 0, createAI(6 as Difficulty, getTitanDef(t), seed * 5)), createAiSource(match, 1, createAI(1 as Difficulty, getTitanDef(t), seed * 5 + 1)));
for (let i = 0; i < 3000; i++) {
  match.step();
  if (i % 40 === 0) { const a = match.fighters[0].view, b = match.fighters[1].view; console.log(i, 'dx', (b.x - a.x).toFixed(0), 'dy', (b.y - a.y).toFixed(0), a.state, a.moveId ?? '', '|', b.state, b.moveId ?? '', 'v', a.vx.toFixed(0), b.vx.toFixed(0), 'bounds', a.boundsX0.toFixed(0), a.boundsX1.toFixed(0)); }
}
