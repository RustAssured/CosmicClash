/**
 * Matter GC check (D28 task 7): a 3-minute two-titan fight (r=55, ~10k cells each, a hit every 24 ticks through all six damage
 * types, a gravity well, renderLayers every tick) with every damage event built BEFORE the measured run, so what is counted is
 * what the matter world itself allocates. Reports garbage-collection pauses from the runtime's own GC entries.
 *   npx tsx tools/matter/gc.ts                       (TICKS=10800 by default; --json for machine-readable output)
 *   node --heap-prof --import tsx tools/matter/gc.ts (adds a sampling allocation profile: where the remaining garbage comes from)
 */
import { PerformanceObserver } from 'node:perf_hooks';
import { LOGICAL_H, LOGICAL_W, Rng, type DamageEvent } from '@/contracts';
import { TYPES, makeScene, randomEvent } from './harness';

const TICKS = Number(process.env.TICKS ?? 10800);
const WARM = 600;
const EVERY = 24;

const { world, ids, x } = makeScene(9, 55);
world.setGravitySource(1, {
  x: x[1],
  y: 300,
  strength: 320,
  radius: 260,
  consumeRadius: 14,
  creditBodyId: ids[1],
});
const rng = new Rng(9);
const events: DamageEvent[] = [];
for (let k = 0; k * EVERY < WARM + TICKS; k++) {
  const tgt = k & 1;
  events.push(randomEvent(rng, x[tgt]!, x[1 - tgt]!, ids[1 - tgt]!, (k >> 1) % TYPES.length));
}
const view = { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H };
const step = (t: number): void => {
  if (t % EVERY === 0) {
    const k = t / EVERY;
    world.applyDamage(ids[k & 1]!, events[k]!);
  }
  world.tick();
  world.renderLayers(view, 0.5);
};
for (let t = 0; t < WARM; t++) step(t);

const pauses: { kind: number; ms: number }[] = [];
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    const detail = (e as unknown as { detail?: { kind?: number } }).detail;
    pauses.push({ kind: detail?.kind ?? 0, ms: e.duration });
  }
});
obs.observe({ entryTypes: ['gc'] });
const heap0 = process.memoryUsage().heapUsed;
const t0 = performance.now();
for (let t = WARM; t < WARM + TICKS; t++) step(t);
const wall = performance.now() - t0;
const heap1 = process.memoryUsage().heapUsed;

setTimeout(() => {
  obs.disconnect();
  const over4 = pauses.filter((p) => p.ms > 4).length;
  const total = pauses.reduce((s, p) => s + p.ms, 0);
  const max = pauses.reduce((m, p) => Math.max(m, p.ms), 0);
  const minor = pauses.filter((p) => p.kind === 1).length;
  const r = {
    ticks: TICKS,
    seconds: TICKS / 60,
    gcPauses: pauses.length,
    minor,
    major: pauses.length - minor,
    over4ms: over4,
    maxMs: +max.toFixed(2),
    totalMs: +total.toFixed(1),
    heapDeltaKB: Math.round((heap1 - heap0) / 1024),
    wallMs: Math.round(wall),
    chunks: world.diagnostics().chunks,
  };
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(r)}\n`);
  else
    process.stdout.write(
      `Matter GC over ${r.seconds} s of fight (${TICKS} ticks, render every tick): ${r.gcPauses} pauses ` +
        `(${r.minor} minor, ${r.major} major), ${r.over4ms} > 4 ms, max ${r.maxMs} ms, total ${r.totalMs} ms; ` +
        `heap delta ${r.heapDeltaKB} KB; wall ${r.wallMs} ms; ${r.chunks} chunks at the end\n`,
    );
}, 50);
