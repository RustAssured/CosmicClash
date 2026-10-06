/**
 * 우리 in a match: decode cost, then the world tick (per section) and Match.step with 우리 (13 matter bodies, ~105.8k cells)
 * against the Planet, both AI, min of `--reps` replays (as tools/lead/simprof.ts).
 *   npx tsx tools/matter/uriprof.ts [--ticks=3600] [--reps=2] [--seed=21]
 */
import { DEFAULT_ARENA, DEFAULT_LIGHTING, type MatchConfig, type TitanId } from '@/contracts';
import { createAI } from '@/ai';
import { createFighter } from '@/combat';
import { createMatterWorld, type MatterWorldEx } from '@/matter';
import { createAiSource, createMatch } from '@/sim';
import { getTitanDef, URI_ID, uriDef, uriPartMatter } from '@/titans';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((x) => x.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1]!;
const TICKS = +opt('ticks', '3600');
const REPS = +opt('reps', '2');
const SEED = +opt('seed', '21');
const NAMES = ['jobs', 'wounds', 'thermal', 'infect', 'conn', 'waves', 'chunks', 'parts', 'visual', 'stats'];
const NS = NAMES.length;

const t0 = performance.now();
uriPartMatter();
const decodeMs = performance.now() - t0;
const def = (id: TitanId) => (id === URI_ID ? uriDef() : getTitanDef(id));

function run(): {
  step: Float64Array;
  world: Float64Array;
  sec: Float64Array;
  ticks: number;
  hash: number;
  cells: number;
} {
  const cfg: MatchConfig = {
    seed: SEED,
    stage: 'nursery',
    mode: 'aivai',
    footwork: 'orbit',
    slots: [
      { titan: URI_ID, controller: 'ai', aiLevel: 4 },
      { titan: 'planet', controller: 'ai', aiLevel: 4 },
    ],
  };
  const m = createMatch(cfg, {
    createWorld: createMatterWorld,
    createFighter,
    getTitanDef: def,
    arena: DEFAULT_ARENA,
    lighting: DEFAULT_LIGHTING,
  });
  m.setSources(
    createAiSource(m, 0, createAI(4, def(URI_ID), SEED * 7 + 1, { footwork: 'orbit' })),
    createAiSource(m, 1, createAI(4, getTitanDef('planet'), SEED * 7 + 2, { footwork: 'orbit' })),
  );
  const core = (m.world as unknown as MatterWorldEx).core;
  core.clock = () => performance.now();
  const step = new Float64Array(TICKS);
  const world = new Float64Array(TICKS);
  const sec = new Float64Array(TICKS * NS);
  const prev = new Float64Array(NS);
  const w = m.world as unknown as Record<string, unknown>;
  const tick = w.tick as () => void;
  let cur = 0;
  w.tick = function (this: unknown): void {
    prev.set(core.prof.subarray(0, NS));
    const s = performance.now();
    tick.call(this);
    world[cur] = performance.now() - s;
    for (let k = 0; k < NS; k++) sec[cur * NS + k] = core.prof[k]! - prev[k]!;
  };
  let cells = 0;
  for (const b of core.bodyList) cells += b.ownerSlot === 0 ? b.refreshStats().cells : 0;
  let n = 0;
  for (cur = 0; cur < TICKS; cur++) {
    const s = performance.now();
    m.step();
    step[cur] = performance.now() - s;
    n++;
    if (m.phase === 'matchend') break;
  }
  return { step, world, sec, ticks: n, hash: m.hash() >>> 0, cells };
}

const best = run();
for (let r = 1; r < REPS; r++) {
  const x = run();
  if (x.hash !== best.hash) console.log('NONDETERMINISTIC replay');
  for (let i = 0; i < TICKS; i++) {
    best.step[i] = Math.min(best.step[i]!, x.step[i]!);
    best.world[i] = Math.min(best.world[i]!, x.world[i]!);
  }
  for (let i = 0; i < best.sec.length; i++) best.sec[i] = Math.min(best.sec[i]!, x.sec[i]!);
}
const stat = (a: ArrayLike<number>, n: number): string => {
  const s = Array.from(a)
    .slice(0, n)
    .sort((x, y) => x - y);
  const p = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]!;
  return `mean ${(s.reduce((x, y) => x + y, 0) / s.length).toFixed(3)}  p50 ${p(0.5).toFixed(3)}  p99 ${p(0.99).toFixed(3)}  max ${s[s.length - 1]!.toFixed(2)}`;
};
console.log(
  `우리 vs Planet (AI 4, orbit, nursery, seed ${SEED}): ${best.ticks} ticks played, min of ${REPS}; decode ${decodeMs.toFixed(0)} ms (first, cached after); 우리 cells ${best.cells}`,
);
console.log(`  step    ${stat(best.step, best.ticks)}`);
console.log(`  world   ${stat(best.world, best.ticks)}`);
for (let k = 0; k < NS; k++) {
  const col = new Float64Array(best.ticks);
  for (let i = 0; i < best.ticks; i++) col[i] = best.sec[i * NS + k]!;
  console.log(`  ${NAMES[k]!.padEnd(7)} ${stat(col, best.ticks)}`);
}
