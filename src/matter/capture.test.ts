import { describe, expect, it } from 'vitest';
import { LOGICAL_H, LOGICAL_W, rgba } from '@/contracts';
import { DEBRIS_CHUNK_CAP } from './chunks';
import { createMatterWorld, type ChunkStateOut, type MatterWorldEx } from './index';
import { layeredDisc } from './testing/bodies';

/**
 * Tidal Draw / arena capture (D28 task 2): chunksInShape, capture into a ring, pinned chunks, release, launched chunks with an
 * uncapped KINETIC blow credited to the thrower, spawnChunk ids; debris persistence (cooling glow, drift).
 */

const view = { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H };
const st = (): ChunkStateOut => ({
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  angle: 0,
  spin: 0,
  mass: 0,
  radius: 0,
  mode: 0,
  owner: 0,
  origin: 0,
  temp: 0,
});
const run = (w: MatterWorldEx, n: number): void => {
  for (let i = 0; i < n; i++) w.tick();
};
function rock(
  world: MatterWorldEx,
  x: number,
  y: number,
  size: number,
  mass: number,
  vx = 0,
  vy = 0,
): number {
  const px = new Uint32Array(size * size).fill(rgba(150, 140, 130, 255));
  return world.spawnChunk({ pixels: px, w: size, h: size, x, y, vx, vy, spin: 0, mass });
}

describe('capture API', () => {
  it('spawnChunk returns the id chunkState and chunksInShape report', () => {
    const world = createMatterWorld(1);
    const a = rock(world, 100, 100, 4, 10);
    const b = rock(world, 140, 100, 4, 12);
    const c = rock(world, 400, 300, 6, 30);
    expect(a).toBeGreaterThan(0);
    expect(new Set([a, b, c]).size).toBe(3);
    const s = st();
    expect(world.chunkState(c, s)).toBe(true);
    expect(s.x).toBeCloseTo(400, 6);
    expect(s.mass).toBeCloseTo(30, 6);
    expect(s.mode).toBe(0);
    const out = new Int32Array(8);
    const n = world.chunksInShape({ kind: 'field', x: 120, y: 100, r: 30, falloff: 0 }, out);
    expect(Array.from(out.subarray(0, n)).sort()).toEqual([a, b].sort());
    expect(world.chunksInShape({ kind: 'point', x: 404, y: 300, r: 1 }, out)).toBe(1);
    expect(out[0]).toBe(c);
    expect(world.chunkState(9999, s)).toBe(false);
  });

  it('a captured chunk rides its owner ring, is pinned against the cap, and goes free when the ring is cleared', () => {
    const world = createMatterWorld(2);
    world.setOrbit(0, { x: 320, y: 180, radius: 70, omega: 2 });
    const id = rock(world, 200, 120, 8, 40, -50, 30);
    expect(world.captureChunk(id, 1)).toBe(false); // slot 1 has no ring
    expect(world.captureChunk(id, 0)).toBe(true);
    run(world, 240);
    const s = st();
    expect(world.chunkState(id, s)).toBe(true);
    expect(s.mode).toBe(1);
    expect(s.owner).toBe(0);
    const r = Math.hypot(s.x - 320, s.y - 180);
    expect(Math.abs(r - 70)).toBeLessThan(14); // its lane (±6 px) plus the steering lag
    // it keeps circling: the phase advances with the ring
    const a0 = Math.atan2(s.y - 180, s.x - 320);
    run(world, 30);
    world.chunkState(id, s);
    const da = ((Math.atan2(s.y - 180, s.x - 320) - a0 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    expect(da).toBeGreaterThan(0.6);
    expect(da).toBeLessThan(1.4);
    // flood the pool far past the cap: the pinned chunk is never degraded to make room
    for (let i = 0; i < DEBRIS_CHUNK_CAP + 80; i++)
      rock(world, 40 + (i % 70) * 8, 300 + Math.floor(i / 70) * 6, 2, 1);
    expect(world.diagnostics().chunks).toBe(DEBRIS_CHUNK_CAP);
    expect(world.chunkState(id, s)).toBe(true);
    expect(s.mass).toBeCloseTo(40, 6);
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
    world.setOrbit(0, null);
    world.tick();
    world.chunkState(id, s);
    expect(s.mode).toBe(0);
    expect(Math.hypot(s.vx, s.vy)).toBeGreaterThan(60); // it leaves with the ring's speed
  });

  it('retireChunk takes a chunk out of play and books its mass as dissipated', () => {
    const world = createMatterWorld(9);
    const a = rock(world, 100, 100, 10, 55);
    const b = rock(world, 300, 100, 4, 5);
    const d0 = world.ledger().dissipated;
    expect(world.retireChunk(a)).toBe(true);
    expect(world.retireChunk(a)).toBe(false);
    expect(world.chunkState(a, st())).toBe(false);
    expect(world.chunkState(b, st())).toBe(true);
    expect(world.diagnostics().chunks).toBe(1);
    expect(world.ledger().dissipated - d0).toBeCloseTo(55, 6);
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-6);
  });

  it('gravitySourceOf reads back the source set for a slot, and reading it never changes the hash', () => {
    const world = createMatterWorld(10);
    expect(world.gravitySourceOf!(0)).toBeNull();
    world.setGravitySource(1, {
      x: 300,
      y: 200,
      strength: 250,
      radius: 180,
      consumeRadius: 12,
      creditBodyId: 4,
    });
    const h = world.hash();
    const g = world.gravitySourceOf!(1)!;
    expect(g).toEqual({ x: 300, y: 200, strength: 250, radius: 180, consumeRadius: 12, creditBodyId: 4 });
    g.strength = 9999; // a copy: editing it does not touch the world
    expect(world.gravitySourceOf!(1)!.strength).toBe(250);
    expect(world.hash()).toBe(h);
    world.setGravitySource(1, null);
    expect(world.gravitySourceOf!(1)).toBeNull();
  });

  it('releaseChunk lets one chunk go and leaves the others captured', () => {
    const world = createMatterWorld(3);
    world.setOrbit(1, { x: 300, y: 200, radius: 50, omega: -1.5 });
    const a = rock(world, 250, 200, 5, 10);
    const b = rock(world, 350, 200, 5, 10);
    world.captureChunk(a, 1);
    world.captureChunk(b, 1);
    run(world, 20);
    expect(world.releaseChunk(a)).toBe(true);
    run(world, 5);
    const s = st();
    world.chunkState(a, s);
    expect(s.mode).toBe(0);
    world.chunkState(b, s);
    expect(s.mode).toBe(1);
  });

  it("a flattened ring (S3's debris ring in the moons' plane) and a struck ring chunk breaking into free pieces", () => {
    const world = createMatterWorld(8);
    world.setOrbit(0, { x: 320, y: 180, radius: 90, omega: 1.2, flatten: 0.26 });
    const id = rock(world, 410, 180, 12, 90);
    world.captureChunk(id, 0);
    let maxDy = 0;
    let maxDx = 0;
    const s = st();
    for (let t = 0; t < 400; t++) {
      world.tick();
      world.chunkState(id, s);
      if (t > 120) {
        maxDy = Math.max(maxDy, Math.abs(s.y - 180));
        maxDx = Math.max(maxDx, Math.abs(s.x - 320));
      }
    }
    expect(maxDx).toBeGreaterThan(75);
    expect(maxDy).toBeLessThan(40);
    expect(maxDy).toBeGreaterThan(12);
    const m = world.diagnostics().chunkMass;
    expect(world.strikeChunk(id, s.x - 3, s.y, 900, 1, 0)).toBe(true);
    expect(world.diagnostics().chunks).toBeGreaterThanOrEqual(2);
    expect(world.diagnostics().chunkMass).toBeCloseTo(m, 6);
    const out = new Int32Array(8);
    const n = world.chunksInShape({ kind: 'field', x: s.x, y: s.y, r: 40, falloff: 0 }, out);
    for (let k = 0; k < n; k++) {
      world.chunkState(out[k]!, s);
      expect(s.mode).toBe(0);
    }
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
  });

  it('a launched chunk lands an uncapped KINETIC blow; the same chunk merely flying in is capped', () => {
    const hit = (launch: boolean): number => {
      const world = createMatterWorld(4);
      const target = world.createBody(
        layeredDisc({ size: 40, seed: 3, x: 420, y: 200, ownerSlot: 1 }).spec,
      ).id;
      const m0 = world.stats(target).mass;
      const id = rock(world, 250, 200, 12, 160, launch ? 0 : 600, 0);
      if (launch) world.launchChunk(id, 600, 0, -1, 0);
      run(world, 50);
      expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
      return m0 - world.stats(target).mass;
    };
    const free = hit(false);
    const thrown = hit(true);
    expect(thrown).toBeGreaterThan(free * 3);
    expect(thrown).toBeGreaterThan(20);
  });

  it('a launched chunk passes through its thrower and still hits the enemy', () => {
    const world = createMatterWorld(5);
    const thrower = world.createBody(
      layeredDisc({ size: 30, seed: 2, x: 300, y: 200, ownerSlot: 0 }).spec,
    ).id;
    const target = world.createBody(layeredDisc({ size: 30, seed: 4, x: 480, y: 200, ownerSlot: 1 }).spec).id;
    const t0 = world.stats(thrower).mass;
    const g0 = world.stats(target).mass;
    const id = rock(world, 260, 200, 10, 120);
    world.launchChunk(id, 700, 0, thrower, 0);
    run(world, 50);
    expect(world.stats(thrower).mass).toBeCloseTo(t0, 6);
    expect(world.stats(target).mass).toBeLessThan(g0 - 10);
  });
});

describe('debris persistence', () => {
  it('slabs of a heavy blow leave glowing and cool to dark', () => {
    const world = createMatterWorld(6);
    const id = world.createBody(layeredDisc({ size: 40, seed: 5, x: 400, y: 290 }).spec).id;
    world.applyDamage(id, {
      type: 'KINETIC',
      shape: { kind: 'point', x: 372, y: 290, r: 10 },
      energy: 1200,
      dirX: 1,
      dirY: 0,
      duration: 1,
      sourceMass: 5,
      sourceBodyId: -1,
      originX: 0,
      originY: 0,
      flags: 0,
      params: {},
    });
    run(world, 40);
    const temps = (): number[] => {
      const out: number[] = [];
      for (let i = 0; i < world.core.chunks.hi; i++) {
        const c = world.core.chunks.list[i]!;
        if (c.alive) out.push(c.temp);
      }
      return out;
    };
    const hot = temps();
    expect(hot.length).toBeGreaterThan(0);
    expect(Math.max(...hot)).toBeGreaterThan(0.3);
    const glow = (): number => {
      let e = 0;
      for (const l of world.renderLayers(view, 0))
        if (l.id.startsWith('debris') && l.emissive)
          for (let i = 0; i < l.emissive.length; i++) e += l.emissive[i]!;
      return e;
    };
    const g0 = glow();
    expect(g0).toBeGreaterThan(0);
    run(world, 900);
    expect(Math.max(0, ...temps())).toBe(0);
    expect(glow()).toBeLessThan(g0 * 0.05);
  });

  it('settled debris drifts slowly and deterministically', () => {
    const pos = (): number[] => {
      const world = createMatterWorld(7);
      const ids = [rock(world, 200, 150, 4, 8), rock(world, 330, 200, 5, 12), rock(world, 450, 260, 3, 5)];
      run(world, 600);
      const s = st();
      const out: number[] = [];
      for (const id of ids) {
        world.chunkState(id, s);
        out.push(s.x, s.y);
      }
      return out;
    };
    const a = pos();
    expect(a).toEqual(pos());
    const start = [200, 150, 330, 200, 450, 260];
    for (let k = 0; k < 3; k++) {
      const d = Math.hypot(a[2 * k]! - start[2 * k]!, a[2 * k + 1]! - start[2 * k + 1]!);
      expect(d).toBeGreaterThan(2);
      expect(d).toBeLessThan(40);
    }
  });
});
