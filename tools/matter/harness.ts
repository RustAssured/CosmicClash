/**
 * Shared measurement harness for the matter benchmark and its regression test.
 *
 * Wall-clock per-tick numbers on a shared machine are polluted by OS pre-emption, and process CPU counters only tick every
 * ~4 ms here, so they cannot resolve a single tick. The simulation is deterministic, though: replaying the identical scenario
 * does exactly the same work on every tick. `replay()` therefore runs it several times and keeps the per-tick MINIMUM, which
 * strips scheduler noise while keeping everything the simulation itself causes (allocation, GC, JIT-independent work).
 */
import { DamageFlag, LOGICAL_H, LOGICAL_W, Rng, type DamageEvent, type DamageType } from '@/contracts';
import { createMatterWorld, type MatterWorldEx } from '@/matter';
import { celadonBody, layeredDisc } from '@/matter/testing/bodies';

export interface Stats {
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function summarize(samples: ArrayLike<number>): Stats {
  const s = Array.from(samples).sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  let sum = 0;
  for (const v of s) sum += v;
  return { avg: sum / s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1]! };
}

export const TYPES: DamageType[] = ['FRACTURE', 'KINETIC', 'CRUSH', 'THERMAL', 'TIDAL', 'ASSIMILATION'];

export interface Scene {
  world: MatterWorldEx;
  ids: [number, number];
  x: [number, number];
}

/** Two bodies: a layered disc of radius `r` (r=84 gives ~22k cells, r=55 gives ~10k) and a celadon ovoid ~7% larger. */
export function makeScene(seed: number, r = 84): Scene {
  const world = createMatterWorld(seed);
  const a = layeredDisc({ size: r, seed: 3, x: 330, y: 300, ownerSlot: 0 });
  const b = celadonBody({ size: Math.round(r * 1.07), seed: 5, x: 830, y: 300, facing: -1, ownerSlot: 1 });
  const ia = world.createBody(a.spec).id;
  const ib = world.createBody(b.spec).id;
  return { world, ids: [ia, ib], x: [330, 830] };
}

export function randomEvent(
  rng: Rng,
  targetX: number,
  srcX: number,
  srcId: number,
  kind: number,
): DamageEvent {
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

/** Pre-fill the pools to their caps so a run measures the worst case: 400 chunks + 6000 particles. */
export function fillPools(world: MatterWorldEx): void {
  const rng = new Rng(77);
  for (let i = 0; i < 400; i++) {
    const w = 6 + rng.int(14);
    const h = 5 + rng.int(10);
    world.spawnChunk({
      pixels: new Uint32Array(w * h).fill(0xff3a8fb0),
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

export const SECTION_NAMES = [
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

export interface FightOpts {
  ticks: number;
  /** A damage event is applied every `everyN` ticks (alternating targets, cycling through all six types). */
  everyN: number;
  seed: number;
  prefill?: boolean;
  /** Disc radius: 84 = ~22k cells per body (stress), 55 = ~10k (real titan size). */
  radius?: number;
  /** Restrict the rotation to these damage types (default: all six). */
  types?: DamageType[];
}

export interface FightRun {
  /** world.tick() only. */
  tick: Float64Array;
  /** applyDamage (if any that tick) + world.tick(): what Match.step() pays for the matter world. */
  step: Float64Array;
  /** applyDamage only on ticks that had a hit (others 0). */
  apply: Float64Array;
  render: number[];
  peakChunks: number;
  peakParticles: number;
  world: MatterWorldEx;
  /** Mean ms per tick by section (see SECTION_NAMES). */
  sections: Float64Array;
  /** Main-thread CPU ms per tick averaged over the run (the OS counter is too coarse for single ticks). */
  cpuPerTick: number;
  /** Per-tick section split, `ticks * SECTION_NAMES.length` values (ms). */
  sec: Float64Array;
}

export function runFight(o: FightOpts): FightRun {
  const { world, ids, x } = makeScene(o.seed, o.radius ?? 84);
  world.core.clock = () => performance.now();
  if (o.prefill) fillPools(world);
  world.setGravitySource(1, {
    x: x[1],
    y: 300,
    strength: 320,
    radius: 260,
    consumeRadius: 14,
    creditBodyId: ids[1],
  });
  const rng = new Rng(o.seed);
  const tick = new Float64Array(o.ticks);
  const step = new Float64Array(o.ticks);
  const apply = new Float64Array(o.ticks);
  const render: number[] = [];
  const view = { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H };
  const rot = o.types ?? TYPES;
  let peakChunks = 0;
  let peakParticles = 0;
  const nsec = SECTION_NAMES.length;
  const sec = new Float64Array(o.ticks * nsec);
  const lastProf = new Float64Array(nsec);
  const cpu0 = process.threadCpuUsage?.();
  for (let t = 0; t < o.ticks; t++) {
    const t0 = performance.now();
    if (t % o.everyN === 0) {
      const k = Math.floor(t / o.everyN);
      const tgt = k & 1;
      const type = rot[(k >> 1) % rot.length]!;
      const evx = randomEvent(rng, x[tgt]!, x[1 - tgt]!, ids[1 - tgt]!, TYPES.indexOf(type));
      world.applyDamage(ids[tgt]!, evx);
    }
    const t1 = performance.now();
    world.tick();
    const t2 = performance.now();
    for (let i = 0; i < nsec; i++) {
      const p = world.core.prof[i]!;
      sec[t * nsec + i] = p - lastProf[i]!;
      lastProf[i] = p;
    }
    apply[t] = t1 - t0;
    tick[t] = t2 - t1;
    step[t] = t2 - t0;
    if (t % 3 === 0) {
      const r0 = performance.now();
      world.renderLayers(view, 0.5);
      render.push(performance.now() - r0);
    }
    const d = world.diagnostics();
    if (d.chunks > peakChunks) peakChunks = d.chunks;
    if (d.particles > peakParticles) peakParticles = d.particles;
  }
  const cpu1 = process.threadCpuUsage?.(cpu0);
  const sections = new Float64Array(SECTION_NAMES.length);
  for (let i = 0; i < sections.length; i++) sections[i] = world.core.prof[i]! / o.ticks;
  return {
    tick,
    step,
    apply,
    render,
    peakChunks,
    peakParticles,
    world,
    sections,
    cpuPerTick: cpu1 ? (cpu1.user + cpu1.system) / 1000 / o.ticks : NaN,
    sec,
  };
}

export interface Replayed {
  /** Per-tick minimum over the replays (load-robust). */
  step: Float64Array;
  tick: Float64Array;
  /** Raw wall-clock samples pooled over all replays (what a loaded machine really saw). */
  rawStep: number[];
  last: FightRun;
  cpuPerTick: number;
  /** Section split (ms) of each tick taken from the replay in which that tick was fastest. */
  sec: Float64Array;
}

/** Warm the JIT once, then replay `reps` times and keep per-tick minima (see the file header). */
export function replay(o: FightOpts, reps = 3): Replayed {
  runFight({ ...o, ticks: Math.min(o.ticks, 300) });
  let min: Float64Array | null = null;
  let minTick: Float64Array | null = null;
  const raw: number[] = [];
  let last!: FightRun;
  let cpu = 0;
  let secBest: Float64Array | null = null;
  const nsec = SECTION_NAMES.length;
  for (let r = 0; r < reps; r++) {
    last = runFight(o);
    cpu += last.cpuPerTick / reps;
    for (let i = 0; i < last.step.length; i++) raw.push(last.step[i]!);
    if (!min || !minTick) {
      min = last.step.slice();
      minTick = last.tick.slice();
      secBest = last.sec.slice();
    } else {
      for (let i = 0; i < min.length; i++) {
        if (last.step[i]! < min[i]!) min[i] = last.step[i]!;
        if (last.tick[i]! < minTick[i]!) {
          minTick[i] = last.tick[i]!;
          for (let k = 0; k < nsec; k++) secBest![i * nsec + k] = last.sec[i * nsec + k]!;
        }
      }
    }
  }
  return { step: min!, tick: minTick!, rawStep: raw, last, cpuPerTick: cpu, sec: secBest! };
}

/**
 * How much slower than the reference machine this process currently runs: the minimum time of a fixed integer workload over
 * many runs, relative to `REFERENCE_MS` (measured on a quiet 2.8 GHz Xeon). >= 1 when the CPU is shared or slow; used to scale
 * budgets in the regression test so a busy CI box does not fail a healthy build.
 */
const REFERENCE_MS = 6.7;
export function speedFactor(): number {
  const work = (n: number): number => {
    let x = 0x9e3779b9 | 0;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      acc = (acc + (x & 1023)) | 0;
    }
    return acc;
  };
  for (let w = 0; w < 3; w++) work(3_000_000);
  let best = Infinity;
  for (let r = 0; r < 25; r++) {
    const t0 = performance.now();
    work(3_000_000);
    best = Math.min(best, performance.now() - t0);
  }
  return Math.max(1, best / REFERENCE_MS);
}
