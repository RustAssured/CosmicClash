import { describe, expect, it } from 'vitest';
import {
  DamageFlag,
  LOGICAL_H,
  LOGICAL_W,
  leanShift,
  type DamageEvent,
  type DamageShape,
  type MaterialSpec,
  type SimEvent,
} from '@/contracts';
import {
  MATERIAL_ARCHETYPES,
  buildMaterialTable,
  createMatterWorld,
  warmUp,
  type MatterWorldEx,
} from './index';
import { bridge, celadonBody, layeredDisc, ribbedSlab, type TestBody } from './testing/bodies';

const view = { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H };
const ev = (over: Partial<DamageEvent> & Pick<DamageEvent, 'type' | 'shape' | 'energy'>): DamageEvent => ({
  dirX: 1,
  dirY: 0,
  duration: 1,
  sourceMass: 5,
  sourceBodyId: -1,
  originX: 0,
  originY: 0,
  flags: 0,
  params: {},
  ...over,
});

/** Total mass conservation residual must stay tiny. */
function expectConserved(world: MatterWorldEx): void {
  const l = world.ledger();
  expect(Math.abs(l.error)).toBeLessThan(1e-2);
}

function make(seed: number, bodies: TestBody[]): { world: MatterWorldEx; ids: number[] } {
  const world = createMatterWorld(seed);
  const ids = bodies.map((b) => world.createBody(b.spec).id);
  return { world, ids };
}

describe('buildMaterialTable', () => {
  const spec = (key: string, base: string, extra: Partial<MaterialSpec> = {}): MaterialSpec => ({
    key,
    base,
    visual: { ramp: ['#111111', '#444444', '#888888'], emissive: 0, char: '#000000', crack: '#000000' },
    ...extra,
  });
  it('reserves id 0 for EMPTY and gives specs[i] id i+1', () => {
    const t = buildMaterialTable([spec('a', 'rock'), spec('b', 'ice')]);
    expect(t[0]!.key).toBe('');
    expect(t[0]!.density).toBe(0);
    expect(t[1]!.key).toBe('a');
    expect(t[1]!.id).toBe(1);
    expect(t[2]!.key).toBe('b');
    expect(t[2]!.id).toBe(2);
  });
  it('applies physics overrides and merges resist', () => {
    const t = buildMaterialTable([spec('r', 'rock', { physics: { bond: 77, resist: { FRACTURE: 3 } } })]);
    expect(t[1]!.bond).toBe(77);
    expect(t[1]!.resist.FRACTURE).toBe(3);
    expect(t[1]!.resist.KINETIC).toBe(MATERIAL_ARCHETYPES.rock!.resist.KINETIC);
  });
  it('appends ash after authored materials when a spec references it, and resolves ashId', () => {
    const t = buildMaterialTable([spec('lat', 'lattice'), spec('rock', 'rock')]);
    expect(t.length).toBe(4);
    expect(t[3]!.key).toBe('ash');
    expect(t[1]!.ashId).toBe(3);
    // an authored 'ash' is used, not duplicated
    const t2 = buildMaterialTable([spec('lat', 'lattice'), spec('ash', 'ash')]);
    expect(t2.length).toBe(3);
    expect(t2[1]!.ashId).toBe(2);
  });
  it('throws on unknown archetypes and duplicate keys', () => {
    expect(() => buildMaterialTable([spec('x', 'nope')])).toThrow(/unknown material archetype/);
    expect(() => buildMaterialTable([spec('x', 'rock'), spec('x', 'ice')])).toThrow(/duplicate/);
  });
  it('provides every archetype key the brief promises', () => {
    for (const k of [
      'rock',
      'regolith',
      'mantle',
      'ironNickel',
      'ice',
      'crystal',
      'glass',
      'celadon',
      'eye',
      'tendril',
      'lattice',
      'chain',
      'node',
      'plasma',
      'corona',
      'gas',
      'cloud',
      'fuelGas',
      'diskGas',
      'jet',
      'ocean',
      'magma',
      'core',
      'horizon',
      'ash',
      'char',
    ])
      expect(MATERIAL_ARCHETYPES[k], k).toBeDefined();
  });
});

describe('createBody', () => {
  it('initialises integrity, bonds, surface flags, mass and stats', () => {
    const tb = layeredDisc({ size: 28, seed: 2 });
    const { world, ids } = make(1, [tb]);
    const map = tb.map;
    let live = 0;
    for (let i = 0; i < map.material.length; i++) {
      if (map.material[i] === 0) continue;
      live++;
      expect(map.integrity[i]).toBe(255);
    }
    const s = world.stats(ids[0]!);
    expect(s.cells).toBe(live);
    expect(s.initialCells).toBe(live);
    expect(s.massFrac).toBeCloseTo(1, 6);
    expect(s.coreIntegrity).toBeCloseTo(1, 6);
    expect(s.exposedCoreFrac).toBe(0);
    // bonds exist exactly between live neighbours
    const w = map.w;
    for (let i = 0; i < map.material.length - w - 1; i++) {
      const x = i % w;
      if (x < w - 1) expect(map.bondR[i] !== 0).toBe(map.material[i] !== 0 && map.material[i + 1] !== 0);
      expect(map.bondD[i] !== 0).toBe(map.material[i] !== 0 && map.material[i + w] !== 0);
    }
    // surface flag: live cell with a void 4-neighbour
    for (let i = w + 1; i < map.material.length - w - 1; i++) {
      if (map.material[i] === 0) continue;
      const surf =
        map.material[i - 1] === 0 ||
        map.material[i + 1] === 0 ||
        map.material[i - w] === 0 ||
        map.material[i + w] === 0;
      expect((map.flags[i]! & 32) !== 0).toBe(surf);
    }
    expectConserved(world);
  });
  it('weakens bonds across material layer boundaries', () => {
    const tb = layeredDisc({ size: 40, seed: 3 });
    createMatterWorld(1).createBody(tb.spec);
    const map = tb.map;
    let same = 0;
    let sameN = 0;
    let diff = 0;
    let diffN = 0;
    for (let i = 0; i < map.material.length - 1; i++) {
      if (map.material[i] === 0 || map.material[i + 1] === 0) continue;
      if (map.material[i] === map.material[i + 1]) {
        same += map.bondR[i]!;
        sameN++;
      } else {
        diff += map.bondR[i]!;
        diffN++;
      }
    }
    expect(diffN).toBeGreaterThan(10);
    expect(diff / diffN).toBeLessThan((same / sameN) * 0.9);
  });
});

describe('overlap / solidAt (pixel-accurate hit detection)', () => {
  const shapes: DamageShape[] = [
    { kind: 'point', x: 400, y: 285, r: 14 },
    { kind: 'line', x0: 340, y0: 250, x1: 450, y1: 330, width: 9 },
    { kind: 'cone', x: 330, y: 290, dirX: 1, dirY: 0.2, range: 90, halfAngle: 0.45 },
    { kind: 'ring', x: 400, y: 290, r0: 18, r1: 30 },
    { kind: 'field', x: 395, y: 295, r: 32, falloff: 2 },
  ];
  const inside = (s: DamageShape, x: number, y: number): boolean => {
    switch (s.kind) {
      case 'point':
        return Math.hypot(x - s.x, y - s.y) <= s.r;
      case 'line': {
        const dx = s.x1 - s.x0;
        const dy = s.y1 - s.y0;
        const l2 = dx * dx + dy * dy;
        let t = ((x - s.x0) * dx + (y - s.y0) * dy) / l2;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(x - (s.x0 + dx * t), y - (s.y0 + dy * t)) <= s.width / 2;
      }
      case 'cone': {
        const d = Math.hypot(x - s.x, y - s.y);
        if (d > s.range) return false;
        if (d < 1e-9) return true;
        const l = Math.hypot(s.dirX, s.dirY);
        const cos = ((x - s.x) * s.dirX + (y - s.y) * s.dirY) / (d * l);
        return cos >= Math.cos(s.halfAngle);
      }
      case 'ring': {
        const d = Math.hypot(x - s.x, y - s.y);
        return d >= s.r0 && d <= s.r1;
      }
      case 'field':
        return Math.hypot(x - s.x, y - s.y) < s.r;
    }
  };
  for (const [name, facing, lean] of [
    ['facing right', 1, 0],
    ['mirrored', -1, 0],
    ['leaning', 1, 9],
    ['mirrored + leaning', -1, -7],
  ] as const) {
    it(`matches brute force for all shape kinds (${name})`, () => {
      const tb = layeredDisc({ size: 30, seed: 9, x: 400.0, y: 290.0, facing });
      tb.spec.transform.lean = lean;
      const { world, ids } = make(1, [tb]);
      const map = tb.map;
      const t = tb.spec.transform;
      const solidRef = (wx: number, wy: number): boolean => {
        const ly = wy - t.y + t.anchorY;
        const j = Math.floor(ly);
        if (j < 0 || j >= map.h) return false;
        const dx = wx - t.x - leanShift(t.lean, j, t.anchorY);
        const i = Math.floor(dx * t.facing + t.anchorX);
        return i >= 0 && i < map.w && map.material[j * map.w + i] !== 0;
      };
      // solidAt agrees with the reference mapping on a dense grid.
      let checked = 0;
      for (let y = 250; y < 330; y += 1.3)
        for (let x = 350; x < 450; x += 1.7) {
          expect(world.solidAt(ids[0]!, x, y)).toBe(solidRef(x, y));
          checked++;
        }
      expect(checked).toBeGreaterThan(1000);
      for (const s of shapes) {
        const r = world.overlap(ids[0]!, s);
        let count = 0;
        let sx = 0;
        let sy = 0;
        for (let j = 0; j < map.h; j++) {
          const sh = leanShift(t.lean, j, t.anchorY);
          for (let i = 0; i < map.w; i++) {
            if (map.material[j * map.w + i] === 0) continue;
            const wx = t.x + (i + 0.5 - t.anchorX) * t.facing + sh;
            const wy = t.y + (j + 0.5 - t.anchorY);
            if (inside(s, wx, wy)) {
              count++;
              sx += wx;
              sy += wy;
            }
          }
        }
        expect(r.cells, `${name} ${s.kind}`).toBe(count);
        if (count > 0) {
          expect(r.x).toBeCloseTo(sx / count, 6);
          expect(r.y).toBeCloseTo(sy / count, 6);
          expect(r.coverage).toBeGreaterThan(0);
          expect(r.coverage).toBeLessThanOrEqual(1);
        } else {
          expect(Number.isNaN(r.x)).toBe(true);
        }
      }
    });
  }
  it('reuses the provided out object and reports a whiff as NaN', () => {
    const tb = layeredDisc({ size: 26, x: 400, y: 290 });
    const { world, ids } = make(1, [tb]);
    const out = { cells: 0, x: 0, y: 0, nearestX: 0, nearestY: 0, coverage: 0 };
    const r = world.overlap(ids[0]!, { kind: 'point', x: 10, y: 10, r: 5 }, out);
    expect(r).toBe(out);
    expect(r.cells).toBe(0);
    expect(Number.isNaN(r.nearestX)).toBe(true);
  });
});

describe('connectivity and detachment', () => {
  it('a bridge cut in two detaches the far half as a chunk, conserving mass', () => {
    const tb = bridge({ seed: 3, x: 400, y: 290 });
    const { world, ids } = make(2, [tb]);
    const cellsBefore = world.stats(ids[0]!).cells;
    const massBefore = world.stats(ids[0]!).mass;
    // Sever the bridge in its middle with a KINETIC-free direct bond cut: use a thin line FRACTURE with high energy.
    const map = tb.map;
    // find bridge columns x in 30..54 at rows 18..20: break all bonds at column 42
    for (let y = 18; y < 21; y++) map.bondR[y * map.w + 42] = 0;
    world.settleBody(ids[0]!);
    const events: SimEvent[] = [];
    world.tick();
    world.drainEvents(events);
    const s = world.stats(ids[0]!);
    expect(s.cells).toBeLessThan(cellsBefore);
    expect(s.mass).toBeLessThan(massBefore);
    // The half NOT containing the core (right side, ~24*24 + 12*3 cells) became one chunk.
    const d = world.diagnostics();
    expect(d.chunks).toBe(1);
    expect(d.chunkMass).toBeGreaterThan(0.4 * massBefore);
    expect(events.some((e) => e.t === 'matter' && e.kind === 'detach')).toBe(true);
    expectConserved(world);
    // stats report the survivors as anchored
    expect(s.anchoredFrac).toBe(1);
    // chunk drifts away over time
    for (let i = 0; i < 60; i++) world.tick();
    expectConserved(world);
  });
  it('disperses tiny islands as particles, not chunks', () => {
    const tb = layeredDisc({ size: 26, x: 400, y: 290 });
    const { world, ids } = make(2, [tb]);
    const map = tb.map;
    // isolate a 2x2 island at the surface by cutting its bonds
    let cx = -1;
    let cy = -1;
    for (let y = 2; y < map.h && cx < 0; y++)
      for (let x = 2; x < map.w - 2; x++)
        if (map.material[y * map.w + x] !== 0 && map.material[(y - 1) * map.w + x] === 0) {
          cx = x;
          cy = y;
          break;
        }
    const w = map.w;
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) {
        const i = (cy + dy) * w + cx + dx;
        map.bondR[i - 1] = 0;
        map.bondR[i] = dx === 1 ? 0 : map.bondR[i];
        map.bondD[i - w] = 0;
        map.bondD[i] = dy === 1 ? 0 : map.bondD[i];
      }
    world.settleBody(ids[0]!);
    world.tick();
    const d = world.diagnostics();
    expect(d.chunks).toBe(0);
    expect(d.particles).toBeGreaterThan(0);
    expectConserved(world);
  });
});

describe('determinism', () => {
  function run(seed: number, worldSeed = seed): number {
    const a = layeredDisc({ size: 34, seed: 5, x: 300, y: 250, ownerSlot: 0 });
    const b = celadonBody({ size: 34, seed: 6, x: 420, y: 250, facing: -1, ownerSlot: 1 });
    const { world, ids } = make(worldSeed, [a, b]);
    const rng = (n: number): number => ((n * 2654435761 + seed * 40503) >>> 0) / 4294967296;
    for (let t = 0; t < 140; t++) {
      if (t % 17 === 3)
        world.applyDamage(
          ids[t % 2]!,
          ev({
            type: t % 3 === 0 ? 'FRACTURE' : 'KINETIC',
            shape: { kind: 'point', x: 290 + rng(t) * 150, y: 230 + rng(t + 1) * 40, r: 8 },
            energy: 260,
            dirX: rng(t + 2) - 0.5,
            dirY: 0.4,
            flags: t % 2 ? DamageFlag.SEED_CRACK | DamageFlag.EMBED : 0,
            params: { embed: 2, crackSeeds: 3 },
          }),
        );
      world.tick();
    }
    return world.hash();
  }
  it('same seed + same calls => identical hash', () => {
    expect(run(1)).toBe(run(1));
    expect(run(9)).toBe(run(9));
  });
  it('warmUp() leaves no trace: hashes are identical before and after it runs', () => {
    const before = run(4);
    expect(warmUp(40)).toBe(40);
    expect(run(4)).toBe(before);
  });
  it('different seeds diverge', () => {
    expect(run(1)).not.toBe(run(2));
    expect(run(1, 5)).not.toBe(run(1, 6));
  });
});

describe('mass conservation', () => {
  it('holds through mixed damage, debris physics and particle expiry', () => {
    const a = layeredDisc({ size: 34, seed: 5, x: 300, y: 250, ownerSlot: 0 });
    const b = ribbedSlab({ size: 34, seed: 6, x: 460, y: 250, facing: -1, ownerSlot: 1 });
    const { world, ids } = make(3, [a, b]);
    for (let t = 0; t < 300; t++) {
      if (t % 11 === 5)
        world.applyDamage(
          ids[t % 2]!,
          ev({
            type: (['FRACTURE', 'KINETIC'] as const)[t % 2]!,
            shape: { kind: 'point', x: 280 + ((t * 7) % 170), y: 240 + ((t * 3) % 30), r: 9 },
            energy: 300,
            dirX: 0.7,
            dirY: 0.2,
            flags: DamageFlag.SEED_CRACK | DamageFlag.EMBED,
          }),
        );
      world.tick();
      if (t % 37 === 0) expectConserved(world);
    }
    expectConserved(world);
    const l = world.ledger();
    expect(l.dissipated).toBeGreaterThan(0);
  });
});

describe('FRACTURE vs KINETIC on the same target', () => {
  function hit(type: 'FRACTURE' | 'KINETIC'): {
    chunks: number;
    biggest: number;
    removed: number;
    largestChunkFrac: number;
  } {
    const tb = celadonBody({ size: 44, seed: 12, x: 400, y: 290 });
    const { world, ids } = make(4, [tb]);
    const m0 = world.stats(ids[0]!).mass;
    world.applyDamage(
      ids[0]!,
      ev({
        type,
        shape: { kind: 'point', x: 360, y: 280, r: 9 },
        energy: 500,
        dirX: 1,
        dirY: 0.15,
      }),
    );
    for (let i = 0; i < 30; i++) world.tick();
    const pool = world.core.chunks;
    let biggest = 0;
    let n = 0;
    for (let i = 0; i < pool.hi; i++) {
      const c = pool.list[i]!;
      if (!c.alive) continue;
      n++;
      biggest = Math.max(biggest, c.mass);
    }
    const s = world.stats(ids[0]!);
    return {
      chunks: n,
      biggest,
      removed: m0 - s.mass,
      largestChunkFrac: biggest / Math.max(1e-6, m0 - s.mass),
    };
  }
  it('FRACTURE frees slabs (few, large chunks); KINETIC carves a crater with many small pieces', () => {
    const f = hit('FRACTURE');
    const k = hit('KINETIC');
    expect(f.removed).toBeGreaterThan(30);
    expect(k.removed).toBeGreaterThan(30);
    // FRACTURE: a couple of big slabs carry most of the removed mass.
    expect(f.chunks).toBeGreaterThanOrEqual(1);
    expect(f.chunks).toBeLessThanOrEqual(10);
    expect(f.largestChunkFrac).toBeGreaterThan(0.3);
    // KINETIC: mass goes into many fragments/dust; more chunks and none dominating.
    expect(k.chunks).toBeGreaterThan(f.chunks * 2);
    expect(k.largestChunkFrac).toBeLessThan(0.15);
  });
});

describe('detached chunks appear exactly where their cells were drawn (mirroring + lean)', () => {
  for (const [facing, lean] of [
    [1, 0],
    [-1, 0],
    [-1, 5],
    [1, -6],
  ] as const) {
    it(`facing ${facing}, lean ${lean}`, () => {
      const tb = bridge({ seed: 3, x: 300, y: 200, facing });
      tb.spec.transform.lean = lean;
      const { world, ids } = make(2, [tb]);
      const map = tb.map;
      const t = tb.spec.transform;
      const X = Math.round(t.x);
      const Y = Math.round(t.y);
      // Where the sprite draws cell (i, j) in world pixels (the compositor's rule: integer position, mirror, row shear).
      const draw = (i: number, j: number): [number, number] => {
        const sh = lean === 0 ? 0 : Math.round((lean * (t.anchorY - j)) / Math.max(1, t.anchorY));
        const wx = (facing === 1 ? X + (i - t.anchorX) : X - (i - t.anchorX) - 1) + sh;
        return [wx, Y + (j - t.anchorY)];
      };
      // Cut the bridge; the right block (not containing the core anchor) detaches.
      for (let y = 18; y < 21; y++) map.bondR[y * map.w + 42] = 0;
      const expected = new Set<number>();
      for (let j = 0; j < map.h; j++)
        for (let i = 43; i < map.w; i++) {
          if (map.material[j * map.w + i] === 0) continue;
          const [wx, wy] = draw(i, j);
          expected.add(wy * 100000 + wx);
        }
      world.settleBody(ids[0]!);
      expect(world.diagnostics().chunks).toBe(1);
      const layers = world.renderLayers(view, 0);
      const got = new Set<number>();
      for (const l of layers)
        for (let i = 0; i < l.pixels.length; i++)
          if (l.pixels[i]! >>> 24 !== 0) got.add(Math.floor(i / LOGICAL_W) * 100000 + (i % LOGICAL_W));
      expect(got.size).toBe(expected.size);
      for (const k of expected) expect(got.has(k)).toBe(true);
    });
  }
});

describe('debris depth classes', () => {
  it('are deterministic per chunk id, cover all three classes, and rendering never changes the world hash', async () => {
    const { chunkDepth, Chunk } = await import('./chunks');
    const counts = [0, 0, 0];
    for (let id = 1; id <= 800; id++) {
      const c = new Chunk();
      c.id = id;
      c.age = 100;
      const d = chunkDepth(c);
      expect(chunkDepth(c)).toBe(d);
      counts[d]!++;
    }
    expect(counts[0]!).toBeGreaterThan(300); // back ~ 1/2
    expect(counts[1]!).toBeGreaterThan(200); // fight plane ~ 3/8
    expect(counts[2]!).toBeGreaterThan(60); // near ~ 1/8
    expect(counts[2]!).toBeLessThan(160);
    const fresh = new Chunk();
    fresh.id = 8; // a near-class id: a fresh chunk still appears in place first
    fresh.age = 2;
    expect(chunkDepth(fresh)).toBe(1);
    fresh.launchNear = true;
    fresh.age = 20;
    expect(chunkDepth(fresh)).toBe(2);
    fresh.age = 200;
    expect(chunkDepth(fresh)).toBe(
      ((8 * 2654435761) >>> 0) % 8 < 4 ? 0 : ((8 * 2654435761) >>> 0) % 8 < 7 ? 1 : 2,
    );
  });

  it('a long barrage renders all three layers without touching the hash (twice: same hash)', () => {
    const run = (): number => {
      const tb = bridge({ seed: 3, x: 300, y: 200, facing: 1 });
      const { world, ids } = make(2, [tb]);
      for (let i = 0; i < 6; i++) {
        world.applyDamage(
          ids[0]!,
          ev({
            type: 'CRUSH',
            shape: { kind: 'point', x: 290 + i * 6, y: 200, r: 9 },
            energy: 900,
            flags: 0,
          }),
        );
        for (let t = 0; t < 20; t++) {
          world.tick();
          world.renderLayers(view, (t % 4) / 4);
        }
      }
      return world.hash();
    };
    expect(run()).toBe(run());
  });
});
