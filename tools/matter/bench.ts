/**
 * Matter benchmark: two ~150x150 bodies under a scripted 60 s fight that uses every damage type, then a saturated
 * "worst case" run (pools full: 400 chunks + 6000 particles) and an idle-allocation check.
 *   npx tsx tools/matter/bench.ts            (add --json for machine-readable output)
 *   node --expose-gc --import tsx tools/matter/bench.ts   (lets the allocation check force GC first)
 */
import {
  DamageFlag,
  LOGICAL_H,
  LOGICAL_W,
  MAX_DEBRIS_CHUNKS,
  MAX_PARTICLES,
  Rng,
  type DamageEvent,
  type DamageType,
} from '@/contracts';
import { createMatterWorld, type MatterWorldEx } from '@/matter';
import { layeredDisc, ribbedSlab, celadonBody, latticeDisc } from '@/matter/testing/bodies';

const json = process.argv.includes('--json');

interface Stats {
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}
function summarize(samples: number[]): Stats {
  const s = samples.slice().sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return {
    avg: samples.reduce((a, b) => a + b, 0) / samples.length,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: s[s.length - 1]!,
  };
}

function makeWorld(seed: number): { world: MatterWorldEx; ids: [number, number]; x: [number, number] } {
  const world = createMatterWorld(seed);
  // ~22k cells each: R=84 disc, and a 90 celadon ovoid.
  const a = layeredDisc({ size: 84, seed: 3, x: 330, y: 300, ownerSlot: 0 });
  const b = celadonBody({ size: 90, seed: 5, x: 830, y: 300, facing: -1, ownerSlot: 1 });
  const ia = world.createBody(a.spec).id;
  const ib = world.createBody(b.spec).id;
  return { world, ids: [ia, ib], x: [330, 830] };
}

const TYPES: DamageType[] = ['FRACTURE', 'KINETIC', 'CRUSH', 'THERMAL', 'TIDAL', 'ASSIMILATION'];

function randomEvent(rng: Rng, targetX: number, srcX: number, srcId: number, kind: number): DamageEvent {
  const type = TYPES[kind % TYPES.length]!;
  const dir = Math.sign(targetX - srcX) || 1;
  const ty = 250 + rng.next() * 100;
  const tx = targetX - dir * (10 + rng.next() * 70);
  const base = {
    dirX: dir,
    dirY: (rng.next() - 0.5) * 0.6,
    duration: 1,
    sourceMass: 6,
    sourceBodyId: srcId,
    originX: srcX,
    originY: 300,
    flags: 0,
    params: {},
  };
  switch (type) {
    case 'FRACTURE':
      return {
        ...base,
        type,
        energy: 300 + rng.next() * 500,
        shape:
          rng.next() < 0.5
            ? { kind: 'line', x0: tx - dir * 30, y0: ty - 20, x1: tx + dir * 70, y1: ty + 25, width: 6 }
            : { kind: 'cone', x: tx - dir * 20, y: ty, dirX: dir, dirY: 0, range: 50, halfAngle: 0.6 },
        flags: rng.next() < 0.4 ? DamageFlag.SEED_CRACK : 0,
        params: { crackSeeds: 3 },
      };
    case 'KINETIC':
      return {
        ...base,
        type,
        energy: 300 + rng.next() * 500,
        shape: { kind: 'point', x: tx, y: ty, r: 8 },
        flags: DamageFlag.EMBED,
        params: { embed: 3, embedDelay: 40 },
      };
    case 'CRUSH':
      return {
        ...base,
        type,
        energy: 800 + rng.next() * 1400,
        shape: { kind: 'point', x: tx, y: ty, r: 16 },
        params: { compress: 12, shock: 1 },
      };
    case 'THERMAL':
      return {
        ...base,
        type,
        energy: 60 + rng.next() * 200,
        shape: { kind: 'point', x: tx, y: ty, r: 20 },
        params: { shock: rng.next() < 0.3 ? 200 : 0 },
      };
    case 'TIDAL':
      return {
        ...base,
        type,
        energy: 6,
        duration: 30,
        flags: DamageFlag.CONTINUOUS,
        shape: { kind: 'field', x: targetX, y: 300, r: 130, falloff: 1.4 },
        params: { pull: 1.2 },
      };
    default:
      return {
        ...base,
        type,
        energy: 300,
        shape: { kind: 'point', x: tx, y: ty, r: 14 },
        flags: DamageFlag.LATCH,
        params: { latch: 200, harvest: 0.7 },
      };
  }
}

/** Pre-fill the pools to their caps so the run measures the worst case: 400 chunks + 6000 particles + continuous damage. */
function fillPools(world: MatterWorldEx): void {
  const rng = new Rng(77);
  for (let i = 0; i < 400; i++) {
    const w = 6 + rng.int(14);
    const h = 5 + rng.int(10);
    const px = new Uint32Array(w * h).fill(0xff3a8fb0);
    world.spawnChunk({
      pixels: px,
      w,
      h,
      x: 60 + rng.next() * 1100,
      y: 40 + rng.next() * 500,
      vx: (rng.next() - 0.5) * 40,
      vy: (rng.next() - 0.5) * 40,
      spin: (rng.next() - 0.5) * 3,
      mass: 4 + rng.int(20),
    });
  }
  const ramp = [0xffffffff, 0xff40a0ff, 0xff202080];
  for (let k = 0; k < 6; k++)
    world.spawnParticles({
      kind: k % 2 ? 'ember' : 'dust',
      x: 640,
      y: 300,
      vx: 0,
      vy: 0,
      spread: 260,
      count: 1000,
      ramp,
      life: [400, 900],
      fieldScale: 0.3,
      emissive: 120,
      size: 1,
    });
}

function runFight(
  ticks: number,
  everyN: number,
  seed: number,
  prefill = false,
): {
  tick: Stats;
  renderMs: Stats;
  peakChunks: number;
  peakParticles: number;
  world: MatterWorldEx;
  sections: string;
  slow: string;
  worst: string;
} {
  const { world, ids, x } = makeWorld(seed);
  world.core.clock = () => performance.now();
  if (prefill) fillPools(world);
  world.setGravitySource(1, {
    x: x[1],
    y: 300,
    strength: 320,
    radius: 260,
    consumeRadius: 14,
    creditBodyId: ids[1],
  });
  const rng = new Rng(seed);
  const samples: number[] = [];
  const renderSamples: number[] = [];
  const view = { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H };
  let peakChunks = 0;
  let peakParticles = 0;
  let worstMs = 0;
  let worstAt = 0;
  const worstSections = new Float64Array(12);
  let lastErr = 0;
  let lastEventDesc = '';
  const lastProf = new Float64Array(12);
  const slowSections = new Float64Array(12);
  let slowTicks = 0;
  for (let t = 0; t < ticks; t++) {
    if (t % everyN === 0) {
      const k = Math.floor(t / everyN);
      const tgt = k & 1;
      const evx = randomEvent(rng, x[tgt]!, x[1 - tgt]!, ids[1 - tgt]!, k >> 1);
      lastEventDesc = `${evx.type} @${t} -> body ${tgt}`;
      world.applyDamage(ids[tgt]!, evx);
    }
    const t0 = performance.now();
    world.tick();
    const dt = performance.now() - t0;
    samples.push(dt);
    if (dt > worstMs) {
      worstMs = dt;
      worstAt = t;
      for (let i = 0; i < 10; i++) worstSections[i] = world.core.prof[i]! - lastProf[i]!;
    }
    if (dt > 2.5) {
      slowTicks++;
      for (let i = 0; i < 10; i++) slowSections[i] = slowSections[i]! + (world.core.prof[i]! - lastProf[i]!);
    }
    for (let i = 0; i < 10; i++) lastProf[i] = world.core.prof[i]!;
    if (t % 3 === 0) {
      const r0 = performance.now();
      world.renderLayers(view, 0.5);
      renderSamples.push(performance.now() - r0);
    }
    if (process.env.LEDGER_TRACE && t % 1 === 0) {
      const err = world.ledger().error;
      if (Math.abs(err - lastErr) > 1e-3) {
        console.log(
          `tick ${t}: ledger error ${lastErr.toExponential(2)} -> ${err.toExponential(2)}; last event ${lastEventDesc}`,
        );
        lastErr = err;
      }
    }
    const d = world.diagnostics();
    if (d.chunks > peakChunks) peakChunks = d.chunks;
    if (d.particles > peakParticles) peakParticles = d.particles;
  }
  const total = world.core.prof;
  const names = [
    'jobs',
    'cracks+fuses',
    'thermal',
    'infection',
    'connectivity',
    'waves',
    'chunks',
    'particles',
    'visuals',
    'stats',
  ];
  const sections = names.map((n, i) => `${n} ${(total[i]! / ticks).toFixed(3)}`).join('  ');
  const slow = names
    .map((n, i) => `${n} ${(slowSections[i]! / Math.max(1, slowTicks)).toFixed(2)}`)
    .join('  ');
  const worst = `worst tick #${worstAt} ${worstMs.toFixed(2)} ms: ${names.map((n, i) => `${n} ${worstSections[i]!.toFixed(2)}`).join('  ')}`;
  return {
    worst,
    tick: summarize(samples),
    renderMs: summarize(renderSamples),
    peakChunks,
    peakParticles,
    world,
    sections,
    slow: `${slowTicks} ticks > 2.5 ms; mean section ms on those: ${slow}`,
  };
}

function fmt(s: Stats): string {
  return `avg ${s.avg.toFixed(2)}  p50 ${s.p50.toFixed(2)}  p95 ${s.p95.toFixed(2)}  p99 ${s.p99.toFixed(2)}  max ${s.max.toFixed(2)} ms`;
}

// Warm-up so the JIT is hot before measuring.
runFight(300, 20, 99);

const fight = runFight(3600, 24, 1);
const saturated = runFight(1800, 4, 2);
const l = fight.world.ledger();

const full = runFight(900, 4, 4, true);

// Idle allocation check: no damage, world populated with chunks/particles/burning; count heap growth.
const idle = runFight(400, 6, 3);
const gc = (globalThis as { gc?: () => void }).gc;
if (gc) gc();
const heap0 = process.memoryUsage().heapUsed;
for (let i = 0; i < 1000; i++) idle.world.tick();
if (gc) gc();
const heap1 = process.memoryUsage().heapUsed;

const result = {
  fight60s: {
    tick: fight.tick,
    render: fight.renderMs,
    peakChunks: fight.peakChunks,
    peakParticles: fight.peakParticles,
  },
  poolsFull: {
    tick: full.tick,
    render: full.renderMs,
    peakChunks: full.peakChunks,
    peakParticles: full.peakParticles,
  },
  saturated: {
    tick: saturated.tick,
    render: saturated.renderMs,
    peakChunks: saturated.peakChunks,
    peakParticles: saturated.peakParticles,
  },
  ledgerError: l.error,
  idle1000ticksHeapDeltaKB: Math.round((heap1 - heap0) / 1024),
  gcExposed: !!gc,
  caps: { chunks: MAX_DEBRIS_CHUNKS, particles: MAX_PARTICLES },
};
if (json) console.log(JSON.stringify(result, null, 2));
else {
  console.log('Scripted 60 s fight (2 bodies ~22k cells, every damage type):');
  console.log('  sim tick   ', fmt(fight.tick));
  console.log(
    '  renderLayers',
    fmt(fight.renderMs),
    `(peak chunks ${fight.peakChunks}/${MAX_DEBRIS_CHUNKS}, peak particles ${fight.peakParticles}/${MAX_PARTICLES})`,
  );
  console.log('  mean ms/tick by section:', fight.sections);
  console.log('  ', fight.slow);
  console.log('  ', fight.worst);
  console.log('Saturated worst case (a hit every 4 ticks for 30 s):');
  console.log('  sim tick   ', fmt(saturated.tick));
  console.log(
    '  renderLayers',
    fmt(saturated.renderMs),
    `(peak chunks ${saturated.peakChunks}, peak particles ${saturated.peakParticles})`,
  );
  console.log('Pools pre-filled (400 chunks + 6000 particles) + a hit every 4 ticks:');
  console.log('  mean ms/tick by section:', full.sections);
  console.log('  ', full.slow);
  console.log('  ', full.worst);
  console.log('  sim tick   ', fmt(full.tick));
  console.log(
    '  renderLayers',
    fmt(full.renderMs),
    `(peak chunks ${full.peakChunks}, peak particles ${full.peakParticles})`,
  );
  console.log(`Mass ledger residual after the fight: ${l.error.toExponential(2)}`);
  console.log(
    `Idle 1000 ticks heap delta: ${result.idle1000ticksHeapDeltaKB} KB (${gc ? 'gc forced' : 'no --expose-gc: includes garbage'})`,
  );
}
void latticeDisc;
void ribbedSlab;
void LOGICAL_W;

/* ---- per-call costs (not part of the tick budget: paid when a hit lands / a probe is made) ---- */
{
  const { world, ids, x } = makeWorld(11);
  const rng = new Rng(5);
  const time = (n: number, fn: (i: number) => void): number => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn(i);
    return (performance.now() - t0) / n;
  };
  const out = { cells: 0, x: 0, y: 0, nearestX: 0, nearestY: 0, coverage: 0 };
  const overlapPoint = time(2000, () =>
    world.overlap(ids[1]!, { kind: 'point', x: x[1]! - 40, y: 300, r: 20 }, out),
  );
  const overlapCone = time(2000, () =>
    world.overlap(
      ids[1]!,
      { kind: 'cone', x: x[1]! - 120, y: 300, dirX: 1, dirY: 0, range: 120, halfAngle: 0.5 },
      out,
    ),
  );
  const solid = time(20000, () => world.solidAt(ids[1]!, x[1]! - 30, 300));
  const perType: string[] = [];
  for (let k = 0; k < TYPES.length; k++) {
    if (TYPES[k] === 'TIDAL') continue;
    let total = 0;
    const N = 12;
    for (let i = 0; i < N; i++) {
      world.restore(ids[1]!);
      world.tick();
      const ev = randomEvent(rng, x[1]!, x[0]!, ids[0]!, k);
      const t0 = performance.now();
      world.applyDamage(ids[1]!, ev);
      total += performance.now() - t0;
    }
    perType.push(`${TYPES[k]} ${(total / N).toFixed(2)} ms`);
  }
  const hashMs = time(20, () => world.hash());
  if (!json) {
    console.log('Per-call costs:');
    console.log(
      `  overlap point r20 ${(overlapPoint * 1000).toFixed(1)} us · cone 120 ${(overlapCone * 1000).toFixed(1)} us · solidAt ${(solid * 1000).toFixed(2)} us`,
    );
    console.log(`  applyDamage: ${perType.join(' · ')}`);
    console.log(`  world.hash() (two 22k-cell bodies) ${hashMs.toFixed(2)} ms`);
  }
}
