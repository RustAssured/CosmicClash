import { makeMatch, skipIntro, ManualSource, createFakeWorld } from '@/combat/testing/harness';
import { FighterImpl } from '@/combat';
import { LastOneBehaviour } from '@/combat/behaviours/lastone';
import { AsteroidBehaviour } from '@/combat/behaviours/asteroid';

const acc = new Map<string, number>();
function wrap(proto: any, name: string, label: string): void {
  const orig = proto[name];
  proto[name] = function (...a: unknown[]) {
    const t = performance.now();
    const r = orig.apply(this, a);
    acc.set(label, (acc.get(label) ?? 0) + performance.now() - t);
    return r;
  };
}
wrap(FighterImpl.prototype, 'tick', 'fighter.tick(total)');
wrap(LastOneBehaviour.prototype, 'update', 'lastone.update');
wrap(AsteroidBehaviour.prototype, 'update', 'asteroid.update');
wrap(LastOneBehaviour.prototype, 'drawAll', 'lastone.drawAll');
wrap(LastOneBehaviour.prototype, 'drawEye', 'lastone.drawEye');
wrap(LastOneBehaviour.prototype, 'drawFx', 'lastone.drawFx');
wrap(LastOneBehaviour.prototype, 'drawHalo', 'lastone.drawHalo');
wrap(LastOneBehaviour.prototype, 'steerWhips', 'lastone.steerWhips');
wrap(AsteroidBehaviour.prototype, 'draw', 'asteroid.draw');
wrap(FighterImpl.prototype, 'integrate', 'fighter.integrate');
wrap(FighterImpl.prototype, 'updateThreats', 'fighter.updateThreats');
wrap(FighterImpl.prototype, 'syncView', 'fighter.syncView');
wrap(FighterImpl.prototype, 'refreshStats', 'fighter.refreshStats');
wrap(FighterImpl.prototype, 'constrainToFoe', 'fighter.constrainToFoe');

const m = makeMatch({ createWorld: createFakeWorld });
const a = new ManualSource(), b = new ManualSource();
m.setSources(a, b);
skipIntro(m);
a.moveX = 1; b.moveX = -1;
for (let i = 0; i < 60; i++) m.step();
acc.clear();
const N = 600;
const t0 = performance.now();
for (let i = 0; i < N; i++) m.step();
const per = (performance.now() - t0) / N;
console.log('per step ms', per.toFixed(3));
for (const [k, v] of [...acc.entries()].sort((x, y) => y[1] - x[1])) console.log(k.padEnd(24), (v / N).toFixed(3), 'ms/tick');
