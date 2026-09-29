import { createMatterWorld } from '@/matter';
import { ManualSource, makeMatch, skipIntro, createFakeWorld } from '@/combat/testing/harness';
import type { TitanId } from '@/contracts';
const g = (globalThis as unknown as { gc?: () => void }).gc;
if (!g) throw new Error('run with --expose-gc');
function measure(label: string, a: TitanId, b: TitanId, real: boolean, drive: (sa: ManualSource, sb: ManualSource, i: number) => void): void {
  const m = makeMatch({ a, b, seed: 3, createWorld: real ? (s) => createMatterWorld(s) : (s) => createFakeWorld(s) });
  const sa = new ManualSource(), sb = new ManualSource();
  m.setSources(sa, sb);
  skipIntro(m);
  for (let i = 0; i < 1500; i++) { drive(sa, sb, i); m.step(); }
  g!();
  const h0 = process.memoryUsage().heapUsed;
  const N = 1500;
  for (let i = 0; i < N; i++) { drive(sa, sb, 1500 + i); m.step(); }
  const h1 = process.memoryUsage().heapUsed;
  console.log(label.padEnd(34), ((h1 - h0) / N).toFixed(0), 'bytes/tick');
}
const idle = () => {};
const walk = (sa: ManualSource, sb: ManualSource, i: number): void => { sa.moveX = Math.sin(i * 0.02); sb.moveX = -Math.sin(i * 0.02); sb.moveY = Math.cos(i * 0.03) * 0.6; };
measure('lastone idle vs asteroid idle (real)', 'lastone', 'asteroid', true, idle);
measure('lastone walking (real)', 'lastone', 'asteroid', true, walk);
measure('lastone idle (fake world)', 'lastone', 'asteroid', false, idle);
measure('lastone walking (fake world)', 'lastone', 'asteroid', false, walk);
measure('asteroid walking (fake world)', 'asteroid', 'lastone', false, walk);
