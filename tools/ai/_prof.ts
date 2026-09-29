import { makeMatch, skipIntro, createFakeWorld, ManualSource } from '@/combat/testing/harness';
import { createAI } from '@/ai';
import { UtilityAI } from '@/ai/controller';
import { getTitanDef } from '@/titans';
import type { InputFrame } from '@/contracts';
const acc = new Map<string, [number, number]>();
function wrap(proto: any, name: string, label: string): void {
  const orig = proto[name];
  proto[name] = function (...a: unknown[]) {
    const t = performance.now();
    const r = orig.apply(this, a);
    const e = acc.get(label) ?? [0, 0];
    e[0] += performance.now() - t; e[1]++;
    acc.set(label, e);
    return r;
  };
}
for (const n of ['decide', 'think', 'scanThreats', 'evalMove', 'attackCandidates', 'commit', 'build', 'observeFoe', 'bestSidestepDir']) wrap(UtilityAI.prototype, n, n);
const m = makeMatch({ createWorld: createFakeWorld });
const ai = createAI(5, getTitanDef('lastone'), 1);
const foe = new ManualSource();
m.setSources(null, foe);
skipIntro(m);
const out: InputFrame = { moveX: 0, moveY: 0, held: 0, pressed: 0, released: 0 };
for (let i = 0; i < 100; i++) { m.step(); ai.decide(m.aiContext(0), out); }
acc.clear();
const N = 3000;
for (let i = 0; i < N; i++) { foe.moveX = Math.sin(i * 0.03); m.step(); ai.decide(m.aiContext(0), out); }
for (const [k, [t, n]] of [...acc.entries()].sort((a, b) => b[1][0] - a[1][0])) console.log(k.padEnd(20), (t / N).toFixed(4), 'ms/tick amortised', ' calls', n, ' each', (t / n * 1000).toFixed(1), 'us');
