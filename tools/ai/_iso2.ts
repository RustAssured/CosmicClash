import { Btn, type Difficulty } from '@/contracts';
import { makeMatch, skipIntro, ManualSource, createFakeWorld } from '@/combat/testing/harness';
import { createAiSource } from '@/sim';
import { createAI } from '@/ai';
import { getTitanDef } from '@/titans';
import type { FighterImpl } from '@/combat';
const level = +(process.argv[2] ?? 6) as Difficulty;
const seed = +(process.argv[3] ?? 1);
const m = makeMatch({ seed, a: 'lastone', b: 'asteroid', createWorld: createFakeWorld, infinite: true });
const ai = createAI(level, getTitanDef('lastone'), seed);
const foe = new ManualSource();
m.setSources(createAiSource(m, 0, ai), foe);
skipIntro(m);
const f0 = m.fighters[0] as FighterImpl, f1 = m.fighters[1] as FighterImpl;
f1.px = f0.px + 170; f1.py = f0.py;
let thrown = -1;
for (let i = 0; i < 120; i++) {
  if (thrown < 0 && i >= 6 && f0.view.moveId === null) { foe.held = Btn.METEOR ?? Btn.CRUSH; thrown = i; } else foe.held = 0;
  m.step();
  const evs = m.events.filter((e) => e.t === 'move' || e.t === 'hit' || e.t === 'surge').map((e) => e.t + (e.t === 'move' ? ':' + e.moveId + '@' + e.slot : e.t === 'hit' ? ' ' + e.attacker + '>' + e.target : ''));
  if (thrown >= 0 || evs.length) console.log(i, 'dx', (f1.view.x - f0.view.x).toFixed(0), 'AI', f0.view.state, f0.view.moveId ?? '', f0.view.phase ?? '', 'foe', f1.view.state, f1.view.moveId ?? '', f1.view.phase ?? f1.view.phaseTick, evs.join(' '));
}
console.log(ai.log.join('\n'));
