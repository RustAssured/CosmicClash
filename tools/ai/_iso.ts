import { Btn, type Difficulty } from '@/contracts';
import { makeMatch, skipIntro, ManualSource, createFakeWorld } from '@/combat/testing/harness';
import { createAiSource } from '@/sim';
import { createAI } from '@/ai';
import { getTitanDef } from '@/titans';
import type { FighterImpl } from '@/combat';
let dodged = 0, hit = 0, n = 0;
const level = +(process.argv[2] ?? 6) as Difficulty;
for (let seed = 1; seed <= 30; seed++) {
  const m = makeMatch({ seed, a: 'lastone', b: 'asteroid', createWorld: createFakeWorld, infinite: true });
  const ai = createAI(level, getTitanDef('lastone'), seed);
  const foe = new ManualSource();
  m.setSources(createAiSource(m, 0, ai), foe);
  skipIntro(m);
  // bring the foe into range and wait for the AI to be idle, then throw a heavy
  const f0 = m.fighters[0] as FighterImpl, f1 = m.fighters[1] as FighterImpl;
  f1.px = f0.px + 170; f1.py = f0.py;
  let thrown = -1;
  let gotHit = false, dodgedIt = false;
  for (let i = 0; i < 260; i++) {
    if (thrown < 0 && i >= 6 && f0.view.moveId === null && f0.view.state !== 'hitstun') { foe.held = Btn.CRUSH; thrown = i; } else foe.held = 0;
    m.step();
    for (const e of m.events) if (e.t === 'hit' && e.attacker === 1 && e.target === 0) gotHit = true;
    if (thrown >= 0 && i > thrown + 26 && i < thrown + 40 && f0.view.intangible) dodgedIt = true;
  }
  if (thrown >= 0) { n++; if (gotHit) hit++; else dodged++; void dodgedIt; }
}
console.log(`L${level}: crushes thrown ${n}, hit ${hit}, avoided ${dodged}`);
