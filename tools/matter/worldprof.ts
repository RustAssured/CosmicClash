/**
 * Per-section profile of the matter world tick inside the slice match (AI vs AI), the Witness by default.
 *   npx tsx tools/matter/worldprof.ts [--ticks=3600] [--seed=21] [--reps=2] [--classic-lastone] [--stage=shearfield] [--hash]
 * Sections are WorldCore.prof laps (world.ts tick()): per tick, min over replays (as tools/lead/simprof.ts).
 */
import { PerformanceObserver } from 'node:perf_hooks';
import { DEFAULT_ARENA, DEFAULT_LIGHTING, type MatchConfig } from '@/contracts';
import { createAI } from '@/ai';
import { createFighter } from '@/combat';
import { createMatterWorld, type MatterWorldEx } from '@/matter';
import { createAiSource, createMatch } from '@/sim';
import { STAGE_INFO } from '@/stages/info';
import { getTitanDef, witnessDef } from '@/titans';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((x) => x.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const TICKS = +opt('ticks', '3600');
const SEED = +opt('seed', '21');
const REPS = +opt('reps', '2');
const WITNESS = !args.includes('--classic-lastone');
const STAGE = opt('stage', 'nursery') as MatchConfig['stage'];
/** `--hash`: print Match.hash() every 300 ticks (before/after determinism checks of a perf change). */
const HASH = args.includes('--hash');
const NAMES = ['jobs', 'wounds', 'thermal', 'infect', 'conn', 'waves', 'chunks', 'parts', 'visual', 'stats'];
const NS = NAMES.length;

function run(): { sec: Float64Array; world: Float64Array; bodies: number } {
  const cfg: MatchConfig = {
    seed: SEED,
    stage: STAGE,
    mode: 'aivai',
    footwork: 'orbit',
    witness: WITNESS,
    slots: [
      { titan: 'lastone', controller: 'ai', aiLevel: 4 },
      { titan: 'planet', controller: 'ai', aiLevel: 4 },
    ],
  };
  const m = createMatch(cfg, {
    createWorld: createMatterWorld,
    createFighter,
    getTitanDef,
    arena: STAGE_INFO[STAGE]?.arena ?? DEFAULT_ARENA,
    lighting: STAGE_INFO[STAGE]?.lighting ?? DEFAULT_LIGHTING,
  });
  const l1 = WITNESS ? witnessDef(getTitanDef('lastone')) : getTitanDef('lastone');
  m.setSources(
    createAiSource(m, 0, createAI(4, l1, SEED * 7 + 1, { footwork: 'orbit' })),
    createAiSource(m, 1, createAI(4, getTitanDef('planet'), SEED * 7 + 2, { footwork: 'orbit' })),
  );
  const w = m.world as unknown as MatterWorldEx;
  const core = w.core;
  core.clock = () => performance.now();
  const sec = new Float64Array(TICKS * NS);
  const world = new Float64Array(TICKS);
  const prev = new Float64Array(NS);
  const wo = w as unknown as Record<string, unknown>;
  const tick = wo.tick as () => void;
  let cur = 0;
  wo.tick = function (this: unknown): void {
    prev.set(core.prof.subarray(0, NS));
    const s = performance.now();
    tick.call(this);
    world[cur] = performance.now() - s;
    for (let k = 0; k < NS; k++) sec[cur * NS + k] = core.prof[k]! - prev[k]!;
  };
  const hashes: string[] = [];
  for (cur = 0; cur < TICKS; cur++) {
    m.step();
    if (cur % 300 === 299) hashes.push((m.hash() >>> 0).toString(16));
    if (m.phase === 'matchend') break;
  }
  if (HASH) console.log(`hashes every 300 ticks: ${hashes.join(' ')}`);
  return { sec, world, bodies: core.bodyList.length };
}

// GC pauses over the whole run (all replays): the runtime's own entries.
const pauses: number[] = [];
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) pauses.push(e.duration);
});
obs.observe({ entryTypes: ['gc'] });
const best = run();
for (let r = 1; r < REPS; r++) {
  const t = run();
  for (let i = 0; i < best.sec.length; i++) best.sec[i] = Math.min(best.sec[i]!, t.sec[i]!);
  for (let i = 0; i < TICKS; i++) best.world[i] = Math.min(best.world[i]!, t.world[i]!);
}
const stat = (a: ArrayLike<number>): string => {
  const s = Array.from(a).sort((x, y) => x - y);
  const mean = s.reduce((x, y) => x + y, 0) / s.length;
  const p = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]!;
  return `mean ${mean.toFixed(3)}  p50 ${p(0.5).toFixed(3)}  p99 ${p(0.99).toFixed(3)}  max ${s[s.length - 1]!.toFixed(2)}`;
};
console.log(
  `world-tick sections, ${WITNESS ? 'Witness' : 'Last One'} vs Planet, ${STAGE}, seed ${SEED}, ${TICKS} ticks, min of ${REPS} (ms); bodies at end ${best.bodies}`,
);
console.log(`  world   ${stat(best.world)}`);
for (let k = 0; k < NS; k++) {
  const col = new Float64Array(TICKS);
  for (let i = 0; i < TICKS; i++) col[i] = best.sec[i * NS + k]!;
  console.log(`  ${NAMES[k]!.padEnd(7)} ${stat(col)}`);
}
// What the slowest 1 % of ticks spend their time on (mean ms per section over those ticks).
const order = Array.from(best.world, (v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
const worst = order.slice(0, Math.max(1, Math.floor(TICKS / 100)));
const share = NAMES.map((n, k) => {
  let s = 0;
  for (const [, i] of worst) s += best.sec[i * NS + k]!;
  return `${n} ${(s / worst.length).toFixed(2)}`;
});
console.log(
  `  slowest 1 % (${worst.length} ticks, mean world ${(worst.reduce((a, [v]) => a + v, 0) / worst.length).toFixed(2)}): ${share.join(', ')}`,
);
setTimeout(() => {
  obs.disconnect();
  const tot = pauses.reduce((a, b) => a + b, 0);
  console.log(
    `  GC over ${REPS} run(s): ${pauses.length} pauses, ${pauses.filter((p) => p > 4).length} > 4 ms, max ${Math.max(0, ...pauses).toFixed(2)} ms, total ${tot.toFixed(1)} ms`,
  );
}, 50);
