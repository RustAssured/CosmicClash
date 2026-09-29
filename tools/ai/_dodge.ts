import { Btn, type Difficulty } from '@/contracts';
import { makeMatch, skipIntro, ManualSource, createFakeWorld } from '@/combat/testing/harness';
import { createAiSource } from '@/sim';
import { createAI } from '@/ai';
import { getTitanDef } from '@/titans';
const level = +(process.argv[2] ?? 6) as Difficulty;
const m = makeMatch({ seed: 2, a: 'lastone', b: 'lastone', createWorld: createFakeWorld, infinite: true });
const ai = createAI(level, getTitanDef('lastone'), 6);
const foe = new ManualSource();
m.setSources(createAiSource(m, 0, ai), foe);
skipIntro(m);
const t0 = m.tick;
for (let i = 0; i < 1500; i++) {
  const f1 = m.fighters[1]!, f0 = m.fighters[0]!;
  const near = Math.abs(f0.view.x - f1.view.x) < 190;
  foe.held = near && f1.view.moveId === null && f1.view.state !== 'hitstun' && i % 90 === 0 ? Btn.CRUSH : 0;
  foe.moveX = Math.sign(f0.view.x - f1.view.x) * 0.6 * (near ? 0 : 1);
  m.step();
  for (const e of m.events) {
    const t = m.tick - t0;
    if (e.t === 'move' && e.slot === 1) console.log(t, 'FOE', e.moveId, 'dist', Math.abs(f0.view.x - f1.view.x).toFixed(0));
    if (e.t === 'move' && e.slot === 0) console.log(t, 'AI ', e.moveId);
    if (e.t === 'hit') console.log(t, `HIT ${e.attacker}->${e.target} ${e.type} ${e.energy.toFixed(0)}`);
  }
}
console.log((ai.log as string[]).slice(-30).join('\n'));
