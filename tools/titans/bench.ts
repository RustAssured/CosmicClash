/**
 * Fighter/Match performance: ms per Match.step (fighters + real matter world) over a scripted busy fight, with the fighters'
 * own share (tick + overlay raster) measured separately.   npx tsx tools/titans/bench.ts [ticks=1800]
 */
import { parseScript, type TitanId } from '@/contracts';
import { createMatterWorld } from '@/matter';
import { FighterImpl } from '@/combat';
import { createScriptSource, makeMatch, skipIntro } from '@/combat/testing/harness';

const N = +(process.argv[2] ?? 1800);
const A = '1:right*40,45:strike,80:crush,140:surge,150:right*30,190:sig*50,260:guard*30,300:strike,310:upright*20,330:crush,400:ult,520:strike,560:crush,610:sig*40,700:strike,760:crush';
const B = '1:left*50,60:strike,100:left*20,130:guard*40,200:crush,240:sig,300:surge,330:left*40,370:strike,420:ult,500:crush,540:strike,600:left*30,660:sig,720:crush';

function run(a: TitanId, b: TitanId): void {
  const m = makeMatch({ a, b, seed: 3, createWorld: (s) => createMatterWorld(s) });
  skipIntro(m);
  const t0 = m.tick;
  m.setSources(createScriptSource(parseScript(A), t0), createScriptSource(parseScript(B), t0));
  (m.fighters[0] as unknown as { meter: number }).meter = 1;
  (m.fighters[1] as unknown as { meter: number }).meter = 1;
  let fighterMs = 0;
  const orig = FighterImpl.prototype.tick;
  FighterImpl.prototype.tick = function (ctx) {
    const t = performance.now();
    orig.call(this, ctx);
    fighterMs += performance.now() - t;
  };
  const samples: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    m.step();
    samples.push(performance.now() - t);
    if (m.phase === 'matchend') break;
  }
  FighterImpl.prototype.tick = orig;
  samples.sort((x, y) => x - y);
  const q = (p: number): number => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))]!;
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  console.log(
    `${a} vs ${b}: ${samples.length} steps  mean ${mean.toFixed(2)} ms  p50 ${q(0.5).toFixed(2)}  p95 ${q(0.95).toFixed(2)}  p99 ${q(0.99).toFixed(2)}  max ${samples[samples.length - 1]!.toFixed(2)}  | fighters ${(fighterMs / samples.length).toFixed(3)} ms/step (both)`,
  );
}
run('lastone', 'asteroid');
run('asteroid', 'lastone');
run('lastone', 'lastone');
