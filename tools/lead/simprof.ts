/**
 * Headless sim profile: where Match.step() spends its time, per section, on the slice matchup (AI vs AI).
 *   npx tsx tools/lead/simprof.ts [--ticks=3600] [--seed=21] [--orbit]
 * Sections: each fighter's tick (split behaviour.update vs the rest when reachable), resolvePair, world.tick.
 * Wall clock on a shared laptop is noisy: the run is replayed `--reps` times and the per-tick MINIMUM is kept (as in
 * tools/matter/bench.ts), so scheduler noise drops out and what the code itself costs stays.
 */
import { DEFAULT_ARENA, DEFAULT_LIGHTING, type MatchConfig } from '@/contracts';
import { createAI } from '@/ai';
import { createFighter } from '@/combat';
import { createMatterWorld } from '@/matter';
import { createAiSource, createMatch } from '@/sim';
import { getTitanDef } from '@/titans';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((x) => x.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const TICKS = +opt('ticks', '3600');
const SEED = +opt('seed', '21');
const REPS = +opt('reps', '3');
const FOOT: 'classic' | 'orbit' = args.includes('--orbit') ? 'orbit' : 'classic';

type Sec = 'f0' | 'f0.beh' | 'f1' | 'f1.beh' | 'pair' | 'world' | 'step';
const SECS: Sec[] = ['step', 'f0', 'f0.beh', 'f1', 'f1.beh', 'pair', 'world'];

function run(): Record<Sec, Float64Array> {
  const cfg: MatchConfig = {
    seed: SEED,
    stage: 'nursery',
    mode: 'aivai',
    footwork: FOOT,
    slots: [
      { titan: 'lastone', controller: 'ai', aiLevel: 4 },
      { titan: 'planet', controller: 'ai', aiLevel: 4 },
    ],
  };
  const m = createMatch(cfg, {
    createWorld: createMatterWorld,
    createFighter,
    getTitanDef,
    arena: DEFAULT_ARENA,
    lighting: DEFAULT_LIGHTING,
  });
  m.setSources(
    createAiSource(m, 0, createAI(4, getTitanDef('lastone'), SEED * 7 + 1, { footwork: FOOT })),
    createAiSource(m, 1, createAI(4, getTitanDef('planet'), SEED * 7 + 2, { footwork: FOOT })),
  );
  const t: Record<Sec, Float64Array> = Object.fromEntries(
    SECS.map((s) => [s, new Float64Array(TICKS)]),
  ) as never;
  let cur = 0;
  const wrap = (obj: Record<string, unknown>, key: string, sec: Sec): void => {
    const fn = obj[key] as ((...a: unknown[]) => unknown) | undefined;
    if (typeof fn !== 'function') return;
    obj[key] = function (this: unknown, ...a: unknown[]): unknown {
      const s = performance.now();
      const r = fn.apply(this, a);
      t[sec][cur]! += performance.now() - s;
      return r;
    };
  };
  m.fighters.forEach((f, i) => {
    const o = f as unknown as Record<string, unknown>;
    wrap(o, 'tick', i === 0 ? 'f0' : 'f1');
    const beh = o.behaviour as Record<string, unknown> | undefined;
    if (beh) wrap(beh, 'update', i === 0 ? 'f0.beh' : 'f1.beh');
  });
  wrap(m.fighters[0] as unknown as Record<string, unknown>, 'resolvePair', 'pair');
  wrap(m.world as unknown as Record<string, unknown>, 'tick', 'world');
  for (cur = 0; cur < TICKS; cur++) {
    const s = performance.now();
    m.step();
    t.step[cur] = performance.now() - s;
    if (m.phase === 'matchend') break;
  }
  return t;
}

const best: Record<Sec, Float64Array> = run();
for (let r = 1; r < REPS; r++) {
  const t = run();
  for (const s of SECS) for (let i = 0; i < TICKS; i++) best[s][i] = Math.min(best[s][i]!, t[s][i]!);
}
const stat = (a: Float64Array): string => {
  const s = Array.from(a).sort((x, y) => x - y);
  const mean = s.reduce((x, y) => x + y, 0) / s.length;
  const p = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]!;
  return `mean ${mean.toFixed(3)}  p50 ${p(0.5).toFixed(3)}  p95 ${p(0.95).toFixed(3)}  p99 ${p(0.99).toFixed(3)}  max ${s[s.length - 1]!.toFixed(2)}`;
};
console.log(`slice sim profile, ${FOOT}, seed ${SEED}, ${TICKS} ticks, min of ${REPS} replays (ms):`);
for (const s of SECS) console.log(`  ${s.padEnd(7)} ${stat(best[s])}`);
