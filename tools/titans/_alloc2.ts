import { ManualSource, makeMatch, skipIntro, createFakeWorld } from '@/combat/testing/harness';
import { LastOneBehaviour } from '@/combat/behaviours/lastone';
import { FighterImpl } from '@/combat';
const g = (globalThis as unknown as { gc?: () => void }).gc!;
type Fn = (...a: unknown[]) => unknown;
function measure(label: string, patch: () => void, undo: () => void): void {
  patch();
  const m = makeMatch({ a: 'lastone', b: 'lastone', seed: 3, createWorld: (s) => createFakeWorld(s) });
  const sa = new ManualSource(), sb = new ManualSource();
  m.setSources(sa, sb); skipIntro(m);
  for (let i = 0; i < 1500; i++) m.step();
  g();
  const h0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < 2000; i++) m.step();
  const h1 = process.memoryUsage().heapUsed;
  console.log(label.padEnd(40), ((h1 - h0) / 2000).toFixed(0), 'bytes/tick');
  undo();
}
const P = LastOneBehaviour.prototype as unknown as Record<string, Fn>;
const F = FighterImpl.prototype as unknown as Record<string, Fn>;
const noop = (): void => {};
const stash = new Map<string, Fn>();
const mute = (o: Record<string, Fn>, k: string, tag: string) => ({ patch: () => { stash.set(tag, o[k]!); o[k] = noop as Fn; }, undo: () => { o[k] = stash.get(tag)!; } });
measure('baseline', () => {}, () => {});
for (const [o, k, tag] of [[P, 'update', 'L.update'], [P, 'drawAll', 'L.drawAll'], [P, 'drawEye', 'L.drawEye'], [P, 'drawFx', 'L.drawFx'], [F, 'syncView', 'F.syncView'], [F, 'updateThreats', 'F.updateThreats'], [F, 'integrate', 'F.integrate'], [F, 'refreshStats', 'F.refreshStats']] as const) {
  const t = mute(o as Record<string, Fn>, k, tag);
  measure(`no ${tag}`, t.patch, t.undo);
}
