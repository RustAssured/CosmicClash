import { describe, expect, it } from 'vitest';
import {
  DamageFlag,
  LOGICAL_H,
  LOGICAL_W,
  REGION_GRID,
  rgba,
  type DamageEvent,
  type DebugOverlayMode,
  type SimEvent,
} from '@/contracts';
import { createMatterWorld, type MatterWorldEx } from './index';
import { DEBUG_MODES } from './debug';
import {
  blackHole,
  celadonBody,
  gasPlanet,
  latticeDisc,
  layeredDisc,
  ribbedSlab,
  type TestBody,
} from './testing/bodies';

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
function make(seed: number, bodies: TestBody[]): { world: MatterWorldEx; ids: number[] } {
  const world = createMatterWorld(seed);
  return { world, ids: bodies.map((b) => world.createBody(b.spec).id) };
}
const run = (w: MatterWorldEx, n: number): void => {
  for (let i = 0; i < n; i++) w.tick();
};
const conserved = (w: MatterWorldEx): void => expect(Math.abs(w.ledger().error)).toBeLessThan(1e-2);
const view = { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H };

const ALL_TYPES = ['FRACTURE', 'KINETIC', 'CRUSH', 'THERMAL', 'TIDAL', 'ASSIMILATION'] as const;

function barrage(world: MatterWorldEx, id: number, tick0: number): void {
  ALL_TYPES.forEach((type, k) => {
    world.applyDamage(
      id,
      ev({
        type,
        shape:
          k % 2 === 0
            ? { kind: 'point', x: 350 + k * 6, y: 270 + k * 7, r: 12 }
            : { kind: 'cone', x: 330, y: 300 - k * 5, dirX: 1, dirY: 0.1, range: 60, halfAngle: 0.5 },
        energy: type === 'THERMAL' ? 60 : type === 'TIDAL' ? 30 : 700,
        dirX: 0.9,
        dirY: 0.3 * ((k % 3) - 1),
        flags: k % 2 ? DamageFlag.EMBED | DamageFlag.LATCH : DamageFlag.SEED_CRACK,
        originX: 700,
        originY: 290,
        sourceBodyId: 1,
        params: { embed: 2, crackSeeds: 3, latch: 220, harvest: 0.5, shock: 150, compress: 10, pull: 1 },
      }),
    );
    run(world, 3);
  });
  void tick0;
}

describe('restore / heal / carve / grow / shed', () => {
  it('shed drains the accretion pool before cells and keeps the ledger exact', () => {
    const tb = celadonBody({ size: 40, seed: 4, x: 400, y: 290 });
    const { world, ids } = make(6, [tb]);
    world.core.ledger.injected += 30;
    world.core.creditMass(ids[0]!, 30, 400, 290, -1, 'consume');
    const m0 = world.stats(ids[0]!).mass;
    const s0 = world.stats(ids[0]!);
    expect(world.shed(ids[0]!, 20, 'burn')).toBe(0);
    expect(world.stats(ids[0]!).mass).toBeCloseTo(m0 - 20, 4);
    expect(world.stats(ids[0]!).cells).toBe(s0.cells);
    const cells = world.shed(ids[0]!, 40, 'burn'); // 10 from the pool, 30 from cells
    expect(cells).toBeGreaterThan(0);
    expect(world.core.bodyById[ids[0]!]!.pool).toBeCloseTo(0, 5);
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-2);
  });

  it('a healed body is stable: no mass loss without damage events, even with the old debris around', () => {
    for (const mk of [celadonBody, layeredDisc]) {
      const tb = mk({ size: 60, seed: 4, x: 400, y: 290 });
      const { world, ids } = make(6, [tb]);
      for (let i = 0; i < 40 && world.stats(ids[0]!).massFrac > 0.25; i++) {
        world.applyDamage(
          ids[0]!,
          ev({
            type: 'FRACTURE',
            shape: { kind: 'point', x: 372 + (i % 5) * 4, y: 270 + (i % 7) * 6, r: 12 },
            energy: 700,
            flags: DamageFlag.SEED_CRACK,
          }),
        );
        run(world, 15);
      }
      run(world, 200);
      world.heal(ids[0]!, 0.6, 77);
      let last = world.stats(ids[0]!).massFrac;
      expect(last).toBeGreaterThan(0.3);
      for (let k = 0; k < 20; k++) {
        run(world, 50);
        const f = world.stats(ids[0]!).massFrac;
        expect(f).toBeGreaterThanOrEqual(last - 1e-3);
        last = f;
      }
      expect(Math.abs(world.ledger().error)).toBeLessThan(1e-2);
    }
  });

  it('restore() returns every per-cell array to its pristine values exactly', () => {
    const tb = layeredDisc({ size: 40, seed: 2, x: 400, y: 290 });
    const { world, ids } = make(1, [tb]);
    const map = tb.map;
    const snap = {
      material: map.material.slice(),
      density: map.density.slice(),
      integrity: map.integrity.slice(),
      bondR: map.bondR.slice(),
      bondD: map.bondD.slice(),
      flags: map.flags.slice(),
      infection: map.infection.slice(),
      temperature: map.temperature.slice(),
      height: map.height.slice(),
      baseColor: map.baseColor.slice(),
      pixels: map.pixels.slice(),
    };
    const m0 = world.stats(ids[0]!).mass;
    world.setGravitySource(1, {
      x: 700,
      y: 290,
      strength: 300,
      radius: 400,
      consumeRadius: 14,
      creditBodyId: ids[0]!,
    });
    barrage(world, ids[0]!, 0);
    run(world, 200);
    expect(world.stats(ids[0]!).mass).toBeLessThan(m0);
    world.restore(ids[0]!);
    world.refresh(ids[0]!);
    for (const k of Object.keys(snap) as (keyof typeof snap)[]) {
      expect(Array.from((map as unknown as Record<string, ArrayLike<number>>)[k]!), k).toEqual(
        Array.from(snap[k]),
      );
    }
    const s = world.stats(ids[0]!);
    expect(s.massFrac).toBeCloseTo(1, 6);
    expect(s.coreIntegrity).toBeCloseTo(1, 6);
    expect(s.burningCells).toBe(0);
    expect(s.crackedCells).toBe(0);
    conserved(world);
  });

  it('carve() reaches the requested mass fraction, leaves the core last, and is deterministic', () => {
    const carved = (seed: number, frac: number): { world: MatterWorldEx; id: number; tb: TestBody } => {
      const tb = celadonBody({ size: 50, seed: 3, x: 400, y: 290 });
      const { world, ids } = make(seed, [tb]);
      world.carve(ids[0]!, frac, 17);
      return { world, id: ids[0]!, tb };
    };
    const a = carved(1, 0.5);
    const s = a.world.stats(a.id);
    expect(s.massFrac).toBeGreaterThan(0.42);
    expect(s.massFrac).toBeLessThan(0.56);
    expect(s.coreIntegrity).toBeGreaterThan(0.9);
    expect(s.cells).toBeLessThan(s.initialCells);
    // believable scarring: some cracks, and debris in the arena
    expect(s.crackedCells).toBeGreaterThan(0);
    expect(a.world.diagnostics().chunks).toBeGreaterThan(0);
    conserved(a.world);
    const b = carved(1, 0.5);
    expect(b.world.hash()).toBe(a.world.hash());
    const c = carved(2, 0.5);
    expect(c.world.hash()).not.toBe(a.world.hash());
    const tenth = carved(1, 0.1);
    expect(tenth.world.stats(tenth.id).massFrac).toBeLessThan(0.16);
    expect(tenth.world.stats(tenth.id).massFrac).toBeGreaterThan(0.05);
  });

  it('heal() restores part of the missing matter as scars (reduced integrity), deterministically, conserving mass', () => {
    const build = (): { world: MatterWorldEx; id: number; tb: TestBody } => {
      const tb = layeredDisc({ size: 44, seed: 5, x: 400, y: 290 });
      const { world, ids } = make(3, [tb]);
      world.carve(ids[0]!, 0.4, 5);
      return { world, id: ids[0]!, tb };
    };
    const a = build();
    const before = a.world.stats(a.id);
    const massBefore = before.mass;
    const cellsBefore = before.cells;
    const missing = before.initialCells - cellsBefore;
    a.world.heal(a.id, 0.5, 9);
    a.world.tick();
    const after = a.world.stats(a.id);
    expect(after.mass).toBeGreaterThan(massBefore);
    const regained = after.cells - cellsBefore;
    expect(regained).toBeGreaterThan(missing * 0.3);
    expect(regained).toBeLessThan(missing * 0.7);
    // scars: restored cells are weaker than pristine, and some cracked/charred
    let weak = 0;
    for (let i = 0; i < a.tb.map.material.length; i++)
      if (a.tb.map.material[i] !== 0 && a.tb.map.integrity[i]! < 200) weak++;
    expect(weak).toBeGreaterThan(regained * 0.5);
    conserved(a.world);
    const b = build();
    b.world.heal(b.id, 0.5, 9);
    b.world.tick();
    expect(b.world.hash()).toBe(a.world.hash());
    // heal(0) changes no cells
    const c = build();
    const cells0 = c.world.stats(c.id).cells;
    c.world.heal(c.id, 0, 1);
    expect(c.world.stats(c.id).cells).toBe(cells0);
  });

  it('grow() adds cells of a material from the pool first (mass ledger stays exact) and shed() debits mass', () => {
    const bh = blackHole({ size: 14, seed: 2, x: 400, y: 290, ownerSlot: 1 });
    const victim = layeredDisc({ size: 34, seed: 3, x: 200, y: 290, ownerSlot: 0 });
    const { world, ids } = make(3, [victim, bh]);
    world.setGravitySource(1, {
      x: 400,
      y: 290,
      strength: 400,
      radius: 350,
      consumeRadius: 14,
      creditBodyId: ids[1]!,
    });
    for (let t = 0; t < 60; t++) {
      world.applyDamage(
        ids[0]!,
        ev({
          type: 'TIDAL',
          shape: { kind: 'field', x: 200, y: 290, r: 70, falloff: 1.4 },
          energy: 6,
          flags: DamageFlag.CONTINUOUS,
          sourceBodyId: ids[1]!,
          originX: 400,
          originY: 290,
          params: { pull: 1.2 },
        }),
      );
      world.tick();
    }
    run(world, 200);
    const gained = world.stats(ids[1]!).massGained;
    expect(gained).toBeGreaterThan(50);
    const massBefore = world.stats(ids[1]!).mass;
    const cellsBefore = world.stats(ids[1]!).cells;
    const added = world.grow(ids[1]!, { cells: 60, materialKey: 'disk' });
    expect(added).toBeGreaterThan(30);
    const s = world.stats(ids[1]!);
    expect(s.cells).toBe(cellsBefore + added);
    // mass is conserved by growth: cells were built from the pool (pool shrank, cell mass grew)
    expect(s.mass).toBeGreaterThanOrEqual(massBefore - 1e-6);
    conserved(world);
    expect(world.grow(ids[1]!, { cells: 10, materialKey: 'does-not-exist' })).toBe(0);
    // shed
    const m0 = world.stats(ids[0]!).mass;
    const n = world.shed(ids[0]!, 100, 'burn');
    expect(n).toBeGreaterThan(20);
    expect(m0 - world.stats(ids[0]!).mass).toBeGreaterThanOrEqual(100 - 1e-6);
    expect(m0 - world.stats(ids[0]!).mass).toBeLessThan(140);
    conserved(world);
  });
});

describe('determinism over the full pipeline', () => {
  it('carve + every damage type + 600 ticks of aftermath hashes identically for identical seeds', () => {
    const run1 = (seed: number): number => {
      const a = layeredDisc({ size: 38, seed: 5, x: 320, y: 290, ownerSlot: 0 });
      const b = latticeDisc({ size: 36, seed: 6, x: 450, y: 290, facing: -1, ownerSlot: 1 });
      const { world, ids } = make(seed, [a, b]);
      world.carve(ids[0]!, 0.7, 3);
      world.setGravitySource(1, {
        x: 450,
        y: 290,
        strength: 300,
        radius: 260,
        consumeRadius: 14,
        creditBodyId: ids[1]!,
      });
      barrage(world, ids[0]!, 0);
      barrage(world, ids[1]!, 0);
      run(world, 600);
      world.heal(ids[0]!, 0.3, 2);
      run(world, 60);
      return world.hash();
    };
    expect(run1(4)).toBe(run1(4));
    expect(run1(4)).not.toBe(run1(5));
  });
});

describe('BodyStats', () => {
  it('regionGrid is WORLD oriented (accounts for facing), NaN-free and drops where damage lands', () => {
    for (const facing of [1, -1] as const) {
      const tb = layeredDisc({ size: 44, seed: 5, x: 400, y: 290, facing });
      const { world, ids } = make(3, [tb]);
      // Hit the WORLD-left edge of the body.
      world.applyDamage(
        ids[0]!,
        ev({
          type: 'KINETIC',
          shape: { kind: 'point', x: 360, y: 290, r: 10 },
          energy: 1500,
          dirX: 1,
          dirY: 0,
        }),
      );
      run(world, 5);
      const g = world.stats(ids[0]!).regionGrid;
      expect(g.length).toBe(REGION_GRID * REGION_GRID);
      for (const v of g) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      const col = (c: number): number => {
        let s = 0;
        for (let r = 0; r < REGION_GRID; r++) s += g[r * REGION_GRID + c]!;
        return s;
      };
      // world-left columns (0..2) lost more integrity than world-right columns (5..7), for either facing
      expect(col(0) + col(1) + col(2)).toBeLessThan(col(5) + col(6) + col(7) - 0.1);
    }
  });

  it('exposedCoreFrac rises when the core is bared; coreIntegrity falls when it is hit', () => {
    const tb = celadonBody({ size: 40, seed: 3, x: 400, y: 290 });
    const { world, ids } = make(3, [tb]);
    const s0 = world.stats(ids[0]!);
    expect(s0.exposedCoreFrac).toBe(0);
    for (let k = 0; k < 6; k++) {
      world.applyDamage(
        ids[0]!,
        ev({
          type: 'KINETIC',
          shape: { kind: 'point', x: 372 + k * 4, y: 290, r: 12 },
          energy: 1400,
          dirX: 1,
          dirY: 0,
        }),
      );
      run(world, 4);
    }
    const s = world.stats(ids[0]!);
    expect(s.exposedCoreFrac).toBeGreaterThan(0.1);
    expect(s.coreIntegrity).toBeLessThan(1);
    expect(s.massFrac).toBeLessThan(0.9);
  });
});

describe('events', () => {
  it('reports detach, ignite, crack and consume happenings with the owner slot', () => {
    const victim = latticeDisc({ size: 36, seed: 3, x: 250, y: 290, ownerSlot: 0 });
    const bh = blackHole({ size: 12, seed: 2, x: 480, y: 290, ownerSlot: 1 });
    const { world, ids } = make(3, [victim, bh]);
    world.setGravitySource(1, {
      x: 480,
      y: 290,
      strength: 400,
      radius: 350,
      consumeRadius: 14,
      creditBodyId: ids[1]!,
    });
    const events: SimEvent[] = [];
    world.applyDamage(
      ids[0]!,
      ev({ type: 'THERMAL', shape: { kind: 'point', x: 225, y: 290, r: 8 }, energy: 40 }),
    );
    world.applyDamage(
      ids[0]!,
      ev({
        type: 'FRACTURE',
        shape: { kind: 'point', x: 282, y: 282, r: 10 },
        energy: 900,
        flags: DamageFlag.SEED_CRACK,
      }),
    );
    for (let t = 0; t < 400; t++) {
      if (t < 90)
        world.applyDamage(
          ids[0]!,
          ev({
            type: 'TIDAL',
            shape: { kind: 'field', x: 250, y: 290, r: 80, falloff: 1.4 },
            energy: 6,
            flags: DamageFlag.CONTINUOUS,
            sourceBodyId: ids[1]!,
            originX: 480,
            originY: 290,
            params: { pull: 1 },
          }),
        );
      world.tick();
      world.drainEvents(events);
    }
    const kinds = new Set(
      events.filter((e) => e.t === 'matter').map((e) => (e as Extract<SimEvent, { t: 'matter' }>).kind),
    );
    expect(kinds.has('ignite')).toBe(true);
    expect(kinds.has('detach')).toBe(true);
    expect(kinds.has('consume')).toBe(true);
    expect(events.some((e) => e.t === 'matter' && e.kind === 'detach' && e.slot === 0)).toBe(true);
    for (const e of events) if (e.t === 'matter' && e.kind === 'consume') expect(e.slot).toBe(1);
    // draining empties the queue
    const again: SimEvent[] = [];
    world.drainEvents(again);
    expect(again.length).toBe(0);
  });
});

describe('debug overlays', () => {
  it('every mode returns a world-space layer aligned with the body, refilled in place', () => {
    const tb = layeredDisc({ size: 30, seed: 3, x: 400, y: 290, facing: -1 });
    const { world, ids } = make(3, [tb]);
    world.applyDamage(
      ids[0]!,
      ev({ type: 'THERMAL', shape: { kind: 'point', x: 380, y: 290, r: 8 }, energy: 10 }),
    );
    world.applyDamage(
      ids[0]!,
      ev({
        type: 'FRACTURE',
        shape: { kind: 'point', x: 375, y: 280, r: 8 },
        energy: 400,
        flags: DamageFlag.SEED_CRACK,
      }),
    );
    run(world, 100);
    let first: unknown = null;
    for (const mode of DEBUG_MODES) {
      const l = world.debugOverlay(ids[0]!, mode as DebugOverlayMode)!;
      expect(l).not.toBeNull();
      expect(l.space).toBe('world');
      expect(l.w).toBe(tb.map.w);
      expect(l.h).toBe(tb.map.h);
      expect(l.facing).toBe(-1);
      expect(l.anchorX).toBe(tb.map.coreX);
      if (first === null) first = l;
      expect(l).toBe(first); // same pooled layer object for a body
      let painted = 0;
      for (let i = 0; i < l.pixels.length; i++) if (l.pixels[i]! >>> 24 !== 0) painted++;
      expect(painted, mode).toBe(world.stats(ids[0]!).cells);
    }
    expect(world.debugOverlay(999, 'materials')).toBeNull();
  });
  it('the islands overlay marks the anchored body and separates cut-off islands', () => {
    const tb = layeredDisc({ size: 30, seed: 3, x: 400, y: 290 });
    const { world, ids } = make(3, [tb]);
    const map = tb.map;
    for (let y = 0; y < map.h; y++) map.bondR[y * map.w + map.coreX + 10] = 0;
    const l = world.debugOverlay(ids[0]!, 'islands')!;
    const green = rgba(60, 200, 110, 255);
    const at = (x: number, y: number): number => l.pixels[y * map.w + x]!;
    expect(at(map.coreX, map.coreY)).toBe(green);
    expect(at(map.coreX + 20, map.coreY)).not.toBe(green);
  });
});

describe('render layers, particles, chunks and gravity', () => {
  it('renderLayers returns pooled screen layers; chunks appear where they are and extrapolate with alpha', () => {
    const { world } = make(3, []);
    const px = new Uint32Array(6 * 4).fill(rgba(200, 120, 60, 255));
    world.spawnChunk({ pixels: px, w: 6, h: 4, x: 320, y: 180, vx: 60, vy: 0, spin: 0, mass: 5 });
    const l0 = world.renderLayers(view, 0);
    expect(l0.map((l) => l.id).sort()).toEqual(['debris-back', 'fx-front']);
    const layers = l0.slice();
    const find = (layer: (typeof l0)[number]): number[] => {
      const out: number[] = [];
      for (let i = 0; i < layer.pixels.length; i++) if (layer.pixels[i]! >>> 24 !== 0) out.push(i);
      return out;
    };
    const all0 = layers.flatMap(find);
    expect(all0.length).toBeGreaterThanOrEqual(20);
    const xs0 = all0.map((i) => i % LOGICAL_W);
    expect(Math.min(...xs0)).toBeGreaterThanOrEqual(316);
    expect(Math.max(...xs0)).toBeLessThanOrEqual(324);
    const v0 = layers[0]!.version;
    // half a tick of extrapolation moves it by vx * dt * alpha = 60/60*0.9 ~ 1px
    const l1 = world.renderLayers(view, 0.99);
    expect(l1).toBe(l0); // same array, pooled
    expect(l1[0]!.version).toBeGreaterThan(v0);
    for (const l of l1) {
      expect(l.space).toBe('screen');
      expect(l.w).toBe(LOGICAL_W);
      expect(l.h).toBe(LOGICAL_H);
      expect(l.pixels.length).toBe(LOGICAL_W * LOGICAL_H);
    }
    expect(l1[0]!.z).toBeLessThan(0);
    expect(l1[1]!.z).toBeGreaterThan(0);
    // chunk mass entered the ledger as injected matter
    expect(world.ledger().injected).toBeCloseTo(5, 6);
    conserved(world);
    // empty world: layers invisible
    const e = createMatterWorld(1);
    const el = e.renderLayers(view, 0);
    expect(el.every((l) => !l.visible)).toBe(true);
  });

  it('spawnParticles honours count, life and gravity fields; particles consumed by a source credit its body', () => {
    const bh = blackHole({ size: 12, seed: 2, x: 400, y: 290, ownerSlot: 1 });
    const { world, ids } = make(3, [bh]);
    world.setGravitySource(1, {
      x: 400,
      y: 290,
      strength: 500,
      radius: 300,
      consumeRadius: 12,
      creditBodyId: ids[0]!,
    });
    world.spawnParticles({
      kind: 'spark',
      x: 480,
      y: 290,
      vx: 0,
      vy: 0,
      spread: 5,
      count: 40,
      ramp: [rgba(255, 255, 255, 255), rgba(255, 120, 0, 255)],
      life: [200, 200],
      fieldScale: 1,
      emissive: 255,
      size: 1,
    });
    world.spawnParticles({
      kind: 'dust',
      x: 100,
      y: 100,
      vx: 0,
      vy: 0,
      spread: 0,
      count: 10,
      ramp: [rgba(200, 200, 200, 255)],
      life: [20, 20],
      fieldScale: 0,
      emissive: 0,
      size: 2,
    });
    expect(world.diagnostics().particles).toBe(50);
    run(world, 30);
    expect(world.diagnostics().particles).toBeLessThan(50); // dust expired (life 20); sparks are falling into the well
    // sparks fall into the well and vanish (no mass carried: nothing credited, ledger unchanged)
    run(world, 200);
    expect(world.diagnostics().particles).toBe(0);
    expect(world.stats(ids[0]!).massGained).toBe(0);
    conserved(world);
  });

  it('a chunk entering a gravity source is consumed and its mass credited to the source body', () => {
    const bh = blackHole({ size: 12, seed: 2, x: 400, y: 290, ownerSlot: 1 });
    bh.spec.takesDebrisImpacts = false; // isolate the sink from body-impact effects
    const { world, ids } = make(3, [bh]);
    world.setGravitySource(1, {
      x: 400,
      y: 290,
      strength: 500,
      radius: 300,
      consumeRadius: 14,
      creditBodyId: ids[0]!,
    });
    const m0 = world.stats(ids[0]!).mass;
    world.spawnChunk({
      pixels: new Uint32Array(16).fill(rgba(255, 255, 255, 255)),
      w: 4,
      h: 4,
      x: 520,
      y: 290,
      vx: 0,
      vy: 0,
      spin: 0,
      mass: 12,
    });
    run(world, 300);
    expect(world.diagnostics().chunks).toBe(0);
    expect(world.stats(ids[0]!).mass - m0).toBeCloseTo(12, 5);
    expect(world.stats(ids[0]!).massGained).toBeCloseTo(12, 5);
    conserved(world);
  });

  it('chunks are capped: overflow degrades the oldest/smallest to dust without losing mass', () => {
    const { world } = make(3, []);
    const px = new Uint32Array(9).fill(rgba(200, 200, 200, 255));
    for (let i = 0; i < 450; i++)
      world.spawnChunk({
        pixels: px,
        w: 3,
        h: 3,
        x: 200 + (i % 30) * 8,
        y: 100 + Math.floor(i / 30) * 8,
        vx: 0,
        vy: 0,
        spin: 0,
        mass: 1 + (i % 5),
      });
    expect(world.diagnostics().chunks).toBe(400);
    conserved(world);
    run(world, 300);
    conserved(world);
  });

  it('particle pool is capped at MAX_PARTICLES and recycles without leaking carried mass', () => {
    const tb = layeredDisc({ size: 40, seed: 3, x: 400, y: 290 });
    const { world, ids } = make(3, [tb]);
    for (let k = 0; k < 30; k++) {
      world.spawnParticles({
        kind: 'ember',
        x: 300,
        y: 200,
        vx: 0,
        vy: 0,
        spread: 50,
        count: 400,
        ramp: [rgba(255, 200, 100, 255)],
        life: [300, 300],
        fieldScale: 0,
        emissive: 200,
        size: 1,
      });
      world.applyDamage(
        ids[0]!,
        ev({ type: 'KINETIC', shape: { kind: 'point', x: 362, y: 290, r: 8 }, energy: 200 }),
      );
      world.tick();
    }
    expect(world.diagnostics().particles).toBeLessThanOrEqual(6000);
    conserved(world);
  });
});

describe('cross-check: slab and planet bodies survive every model without NaN/invalid state', () => {
  it('runs a barrage on several body types keeping arrays consistent', () => {
    for (const mk of [ribbedSlab, gasPlanet, celadonBody, latticeDisc]) {
      const tb = mk({ size: 34, seed: 7, x: 400, y: 290 });
      const { world, ids } = make(2, [tb]);
      world.setGravitySource(1, {
        x: 700,
        y: 290,
        strength: 300,
        radius: 400,
        consumeRadius: 14,
        creditBodyId: ids[0]!,
      });
      barrage(world, ids[0]!, 0);
      run(world, 300);
      const map = tb.map;
      for (let i = 0; i < map.material.length; i++) {
        if (map.material[i] === 0) {
          expect(map.integrity[i]).toBe(0);
          expect(map.bondR[i]).toBe(0);
          expect(map.bondD[i]).toBe(0);
        } else {
          expect(map.integrity[i]).toBeGreaterThan(0);
          expect(Number.isFinite(map.temperature[i]!)).toBe(true);
        }
      }
      const s = world.stats(ids[0]!);
      expect(Number.isFinite(s.mass)).toBe(true);
      expect(s.cells).toBeGreaterThanOrEqual(0);
      conserved(world);
    }
  });
});
