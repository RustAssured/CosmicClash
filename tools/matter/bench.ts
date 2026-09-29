/**
 * Matter benchmark. Scenarios (a scripted two-body fight that uses every damage type, a saturated "a hit every 4 ticks" run and a
 * pools-full worst case) at two body sizes (r=84: ~22k cells each, a stress size; r=55: ~10k, a real titan), an idle allocation
 * check and per-call costs.
 *   npx tsx tools/matter/bench.ts               (add --json for machine-readable output, --assert to fail on budget breaches)
 *   node --expose-gc --import tsx tools/matter/bench.ts   (lets the allocation check force GC first)
 *
 * Timing method (see harness.ts): every scenario is deterministic, so it is replayed several times and the per-tick MINIMUM is
 * kept ("load-robust": scheduler noise from other processes is removed, everything the simulation itself causes stays). The
 * pooled raw wall-clock samples and the main-thread CPU time per tick (process.threadCpuUsage, averaged: the OS counter only
 * ticks every ~4 ms) are printed next to it.
 */
import { MAX_DEBRIS_CHUNKS, MAX_PARTICLES, Rng } from '@/contracts';
import {
  SECTION_NAMES,
  TYPES,
  makeScene,
  randomEvent,
  replay,
  summarize,
  type FightOpts,
  type Replayed,
  type Stats,
} from './harness';

const json = process.argv.includes('--json');
const assertBudget = process.argv.includes('--assert');
const REPS = Number(process.env.REPS ?? 3);

const fmt = (s: Stats): string =>
  `avg ${s.avg.toFixed(2)}  p50 ${s.p50.toFixed(2)}  p95 ${s.p95.toFixed(2)}  p99 ${s.p99.toFixed(2)}  max ${s.max.toFixed(2)} ms`;

interface Row {
  name: string;
  step: Stats;
  tick: Stats;
  raw: Stats;
  render: Stats;
  cpuPerTick: number;
  sections: string;
  peakChunks: number;
  peakParticles: number;
  worst: string;
}

function measure(name: string, o: FightOpts): { row: Row; run: Replayed } {
  const run = replay(o, REPS);
  const ns = SECTION_NAMES.length;
  let w = 0;
  for (let i = 1; i < run.step.length; i++) if (run.tick[i]! > run.tick[w]!) w = i;
  const worst = `worst tick #${w} ${run.tick[w]!.toFixed(2)} ms: ${SECTION_NAMES.map((n, k) => `${n} ${run.sec[w * ns + k]!.toFixed(2)}`).join('  ')}`;
  const row: Row = {
    name,
    step: summarize(run.step),
    tick: summarize(run.tick),
    raw: summarize(run.rawStep),
    render: summarize(run.last.render),
    cpuPerTick: run.cpuPerTick,
    sections: SECTION_NAMES.map((n, k) => `${n} ${run.last.sections[k]!.toFixed(3)}`).join('  '),
    peakChunks: run.last.peakChunks,
    peakParticles: run.last.peakParticles,
    worst,
  };
  return { row, run };
}

const scenarios: { name: string; o: FightOpts }[] = [
  {
    name: '22k cells: 60 s fight, a hit every 24 ticks, all six types',
    o: { ticks: 3600, everyN: 24, seed: 1 },
  },
  { name: '22k cells: saturated, a hit every 4 ticks', o: { ticks: 1800, everyN: 4, seed: 2 } },
  {
    name: '22k cells: pools full (400 chunks + 6000 particles), a hit every 4 ticks',
    o: { ticks: 900, everyN: 4, seed: 4, prefill: true },
  },
  { name: '10k cells (real titan size): 60 s fight', o: { ticks: 3600, everyN: 24, seed: 1, radius: 55 } },
  { name: '10k cells: saturated, a hit every 4 ticks', o: { ticks: 1800, everyN: 4, seed: 2, radius: 55 } },
  {
    name: '10k cells: pools full, a hit every 4 ticks',
    o: { ticks: 900, everyN: 4, seed: 4, prefill: true, radius: 55 },
  },
];

const rows: Row[] = [];
let ledgerError = 0;
for (const sc of scenarios) {
  const { row, run } = measure(sc.name, sc.o);
  rows.push(row);
  ledgerError = Math.max(ledgerError, Math.abs(run.last.world.ledger().error));
}

// Idle allocation: no damage, a populated world (chunks/particles/burning), heap growth over 1000 ticks.
const idleRun = replay({ ticks: 400, everyN: 6, seed: 3 }, 1).last;
const gc = (globalThis as { gc?: () => void }).gc;
if (gc) gc();
const heap0 = process.memoryUsage().heapUsed;
for (let i = 0; i < 1000; i++) idleRun.world.tick();
if (gc) gc();
const idleKB = Math.round((process.memoryUsage().heapUsed - heap0) / 1024);

// Per-call costs: min over replays of the same event list, on freshly restored bodies.
const calls: Record<string, Stats> = {};
{
  const { world, ids, x } = makeScene(11, Number(process.env.CALL_R ?? 84));
  const rng = new Rng(5);
  const out = { cells: 0, x: 0, y: 0, nearestX: 0, nearestY: 0, coverage: 0 };
  const minTime = (n: number, fn: (i: number) => void): number => {
    let best = Infinity;
    for (let rep = 0; rep < 5; rep++) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) fn(i);
      best = Math.min(best, (performance.now() - t0) / n);
    }
    return best;
  };
  const overlapPoint = minTime(2000, () =>
    world.overlap(ids[1]!, { kind: 'point', x: x[1]! - 40, y: 300, r: 20 }, out),
  );
  const overlapCone = minTime(500, () =>
    world.overlap(
      ids[1]!,
      { kind: 'cone', x: x[1]! - 120, y: 300, dirX: 1, dirY: 0, range: 120, halfAngle: 0.5 },
      out,
    ),
  );
  const solid = minTime(20000, () => world.solidAt(ids[1]!, x[1]! - 30, 300));
  const hashMs = minTime(10, () => world.hash());
  for (let k = 0; k < TYPES.length; k++) {
    if (TYPES[k] === 'TIDAL') continue;
    const evs = Array.from({ length: 40 }, () => randomEvent(rng, x[1]!, x[0]!, ids[0]!, k));
    const best = evs.map(() => Infinity);
    for (let rep = 0; rep < 4; rep++)
      for (let i = 0; i < evs.length; i++) {
        world.restore(ids[1]!);
        world.tick();
        const t0 = performance.now();
        world.applyDamage(ids[1]!, evs[i]!);
        const dt = performance.now() - t0;
        if (rep > 0 && dt < best[i]!) best[i] = dt;
      }
    calls[TYPES[k]!] = summarize(best);
  }
  calls['overlap point r20 (ms)'] = summarize([overlapPoint]);
  calls['overlap cone 120 (ms)'] = summarize([overlapCone]);
  calls['solidAt (ms)'] = summarize([solid]);
  calls['hash() 2 bodies (ms)'] = summarize([hashMs]);
}

const result = {
  method: `min of ${REPS} replays per tick; cpu = main-thread CPU averaged over the run`,
  scenarios: rows.map((r) => ({
    name: r.name,
    step: r.step,
    tick: r.tick,
    rawWall: r.raw,
    render: r.render,
    cpuPerTick: r.cpuPerTick,
    peakChunks: r.peakChunks,
    peakParticles: r.peakParticles,
  })),
  ledgerError,
  idle1000ticksHeapDeltaKB: idleKB,
  gcExposed: !!gc,
  applyDamageMs: calls,
  caps: { chunks: MAX_DEBRIS_CHUNKS, particles: MAX_PARTICLES },
};

if (json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(
    `Matter benchmark, ms per Match-style step (applyDamage + world.tick). Load-robust = per-tick minimum over ${REPS} replays.`,
  );
  for (const r of rows) {
    console.log(`\n${r.name}`);
    console.log('  step load-robust ', fmt(r.step));
    console.log('  tick load-robust ', fmt(r.tick));
    console.log('  step raw wall    ', fmt(r.raw));
    console.log(
      `  cpu/tick ${r.cpuPerTick.toFixed(3)} ms · renderLayers avg ${r.render.avg.toFixed(2)} p99 ${r.render.p99.toFixed(2)} ms · peak chunks ${r.peakChunks}/${MAX_DEBRIS_CHUNKS}, particles ${r.peakParticles}/${MAX_PARTICLES}`,
    );
    console.log('  mean ms/tick by section:', r.sections);
    console.log('  ', r.worst);
  }
  console.log(`\nMass ledger residual (worst scenario): ${ledgerError.toExponential(2)}`);
  console.log(
    `Idle 1000 ticks heap delta: ${idleKB} KB (${gc ? 'gc forced' : 'no --expose-gc: includes garbage'})`,
  );
  console.log(
    'applyDamage per call (ms, min over replays; p50 / p90 / max over 40 events on a 22k-cell body):',
  );
  for (const [k, s] of Object.entries(calls))
    console.log(
      k.endsWith('(ms)')
        ? `  ${k.padEnd(24)} ${s.avg.toFixed(4)}`
        : `  ${k.padEnd(24)} ${s.p50.toFixed(2)} / ${s.p95.toFixed(2)} / ${s.max.toFixed(2)}`,
    );
}

if (assertBudget) {
  const bad = rows.filter((r) => r.step.p99 > 3 || r.step.max > 5);
  const slow = Object.entries(calls).filter(([k, s]) => !k.endsWith('(ms)') && s.max > 1.5);
  if (bad.length || slow.length) {
    for (const r of bad)
      console.error(`BUDGET: ${r.name}: p99 ${r.step.p99.toFixed(2)} max ${r.step.max.toFixed(2)}`);
    for (const [k, s] of slow) console.error(`BUDGET: applyDamage ${k} max ${s.max.toFixed(2)} ms > 1.5`);
    process.exit(1);
  }
}
