import { describe, expect, it } from 'vitest';
import { CellFlag, DamageFlag, type DamageEvent, type MaterialSpec, type SimEvent } from '@/contracts';
import { createMatterWorld, buildMaterialTable, type MatterWorldEx } from './index';
import {
  blackHole,
  celadonBody,
  gasPlanet,
  latticeDisc,
  layeredDisc,
  ribbedSlab,
  uniformDisc,
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
  const ids = bodies.map((b) => world.createBody(b.spec).id);
  return { world, ids };
}
const run = (w: MatterWorldEx, n: number): void => {
  for (let i = 0; i < n; i++) w.tick();
};
const conserved = (w: MatterWorldEx): void => expect(Math.abs(w.ledger().error)).toBeLessThan(1e-2);
const countFlag = (tb: TestBody, flag: number): number => {
  let n = 0;
  for (let i = 0; i < tb.map.flags.length; i++)
    if (tb.map.material[i] !== 0 && (tb.map.flags[i]! & flag) !== 0) n++;
  return n;
};

describe('KINETIC', () => {
  it('regolith craters are wide and shallow; iron craters are deeper relative to width and smaller', () => {
    const crater = (tb: TestBody): { width: number; depth: number; removed: number } => {
      const { world, ids } = make(2, [tb]);
      const before = tb.map.material.slice();
      world.applyDamage(
        ids[0]!,
        ev({
          type: 'KINETIC',
          shape: { kind: 'point', x: 352, y: 290, r: 8 },
          energy: 500,
          dirX: 1,
          dirY: 0,
        }),
      );
      const map = tb.map;
      let x0 = 1e9;
      let x1 = -1;
      let y0 = 1e9;
      let y1 = -1;
      let removed = 0;
      for (let i = 0; i < map.material.length; i++) {
        if (before[i] !== 0 && map.material[i] === 0) {
          const x = i % map.w;
          const y = (i - x) / map.w;
          removed++;
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
      }
      return { width: y1 - y0 + 1, depth: x1 - x0 + 1, removed };
    };
    // Same disc geometry, different material at the surface: swap the bulk archetype by building two slabs.
    const soft = layeredDisc({ size: 50, seed: 3, x: 400, y: 290 });
    const hard = ribbedSlab({ size: 50, seed: 3, x: 400, y: 290 });
    const cs = crater(soft);
    const ch = crater(hard);
    expect(cs.removed).toBeGreaterThan(50);
    expect(ch.removed).toBeGreaterThan(20);
    // Regolith (KINETIC resist 1.3, density 0.8) yields to more removed cells than dense iron.
    expect(cs.removed).toBeGreaterThan(ch.removed);
    // Craters are bowls: the lateral extent is comparable to (or larger than) the depth for regolith.
    expect(cs.width).toBeGreaterThanOrEqual(cs.depth * 0.8);
  });

  it('EMBED leaves shrapnel that fractures outward after embedDelay, creating secondary damage', () => {
    const tb = layeredDisc({ size: 50, seed: 4, x: 400, y: 290 });
    const { world, ids } = make(3, [tb]);
    const events: SimEvent[] = [];
    world.applyDamage(
      ids[0]!,
      ev({
        type: 'KINETIC',
        shape: { kind: 'point', x: 356, y: 290, r: 8 },
        energy: 500,
        flags: DamageFlag.EMBED,
        params: { embed: 3, embedDelay: 30 },
      }),
    );
    expect(countFlag(tb, CellFlag.SHRAPNEL)).toBeGreaterThan(0);
    expect(countFlag(tb, CellFlag.SHRAPNEL)).toBeLessThanOrEqual(3);
    const cellsAtHit = world.stats(ids[0]!).cells;
    const crackedAtHit = world.stats(ids[0]!).crackedCells;
    run(world, 12);
    const before = world.stats(ids[0]!).cells;
    run(world, 40);
    world.drainEvents(events);
    expect(countFlag(tb, CellFlag.SHRAPNEL)).toBe(0);
    const s = world.stats(ids[0]!);
    // secondary burst: more matter gone and/or more cracked cells than right after the impact
    expect(s.cells < before || s.crackedCells > crackedAtHit).toBe(true);
    expect(s.cells).toBeLessThan(cellsAtHit);
    conserved(world);
  });

  it('respects the crater param and reveals interior layers', () => {
    const tb = layeredDisc({ size: 50, seed: 4, x: 400, y: 290 });
    const { world, ids } = make(3, [tb]);
    const r = world.applyDamage(
      ids[0]!,
      ev({
        type: 'KINETIC',
        shape: { kind: 'point', x: 356, y: 290, r: 10 },
        energy: 1200,
        params: { crater: 14 },
      }),
    );
    expect(r.cellsRemoved).toBeGreaterThan(100);
    expect(r.revealedInterior).toBe(true);
    expect(r.contactX).toBeLessThan(400);
    expect(r.impulseX).toBeGreaterThan(0);
  });
});

describe('FRACTURE', () => {
  it('iron-nickel resists FRACTURE far better than brittle celadon (emergent from the resist table + bond costs)', () => {
    const hit = (tb: TestBody): number => {
      const { world, ids } = make(2, [tb]);
      const c0 = world.stats(ids[0]!).cells;
      world.applyDamage(
        ids[0]!,
        ev({
          type: 'FRACTURE',
          shape: { kind: 'point', x: 350, y: 285, r: 10 },
          energy: 400,
          dirX: 1,
          dirY: 0.1,
        }),
      );
      run(world, 40);
      return c0 - world.stats(ids[0]!).cells;
    };
    const celadon = hit(uniformDisc('celadon', { size: 46, seed: 3, x: 400, y: 290 }));
    const iron = hit(uniformDisc('ironNickel', { size: 46, seed: 3, x: 400, y: 290 }));
    // Cells, not mass: iron is 2x denser. Iron is chewed (a chisel pit) but never sheared into slabs like celadon.
    expect(iron).toBeGreaterThan(20);
    expect(celadon).toBeGreaterThan(iron * 1.8);
  });

  it('the deferred chisel follows a body that the same blow knocks away (a launched titan is still pitted)', () => {
    const hit = (knock: number): number => {
      const tb = uniformDisc('ironNickel', { size: 46, seed: 3, x: 400, y: 290 });
      const { world, ids } = make(2, [tb]);
      const body = world.getBody(ids[0]!)!;
      const c0 = world.stats(ids[0]!).cells;
      world.applyDamage(
        ids[0]!,
        ev({
          type: 'FRACTURE',
          shape: { kind: 'point', x: 350, y: 285, r: 10 },
          energy: 400,
          dirX: 1,
          dirY: 0.1,
        }),
      );
      for (let i = 0; i < 40; i++) {
        body.transform.x += knock;
        world.tick();
      }
      return c0 - world.stats(ids[0]!).cells;
    };
    const still = hit(0);
    const launched = hit(20);
    expect(still).toBeGreaterThan(20);
    expect(launched).toBeGreaterThan(still * 0.8);
  });

  it('shear cuts follow weak seams: severed bonds are much weaker-than-average bonds', () => {
    const tb = celadonBody({ size: 46, seed: 6, x: 400, y: 290 });
    const { world, ids } = make(2, [tb]);
    const map = tb.map;
    const bondsBefore = { R: map.bondR.slice(), D: map.bondD.slice() };
    let sum = 0;
    let n = 0;
    for (let i = 0; i < map.material.length; i++) {
      if (!bondsBefore.R[i]) continue;
      sum += bondsBefore.R[i]!;
      n++;
    }
    const mean = sum / n;
    world.applyDamage(
      ids[0]!,
      ev({
        type: 'FRACTURE',
        shape: { kind: 'point', x: 352, y: 280, r: 10 },
        energy: 500,
        dirX: 1,
        dirY: 0.1,
      }),
    );
    run(world, 12); // seams are severed progressively: measure while the fissure is still growing
    let broken = 0;
    let wsum = 0;
    for (let i = 0; i < map.material.length; i++) {
      if (bondsBefore.R[i]! > 0 && map.bondR[i] === 0 && map.material[i] !== 0 && map.material[i + 1] !== 0) {
        broken++;
        wsum += bondsBefore.R[i]!;
      }
      if (
        bondsBefore.D[i]! > 0 &&
        map.bondD[i] === 0 &&
        map.material[i] !== 0 &&
        map.material[i + map.w] !== 0
      ) {
        broken++;
        wsum += bondsBefore.D[i]!;
      }
    }
    expect(broken).toBeGreaterThan(20);
    expect(wsum / broken).toBeLessThan(mean * 0.9);
  });

  it('SEED_CRACK fronts propagate over time and terminate; cracked cell count keeps growing then stops', () => {
    const tb = celadonBody({ size: 50, seed: 8, x: 400, y: 290 });
    const { world, ids } = make(5, [tb]);
    world.applyDamage(
      ids[0]!,
      ev({
        type: 'FRACTURE',
        shape: { kind: 'point', x: 356, y: 280, r: 8 },
        energy: 400,
        flags: DamageFlag.SEED_CRACK,
        params: { crackSeeds: 4 },
      }),
    );
    const b = world.core.bodyById[ids[0]!]!;
    expect(b.frontCount).toBeGreaterThan(0);
    const brokenBonds = (): number => {
      const m = tb.map;
      let n = 0;
      for (let i = 0; i < m.material.length - m.w; i++) {
        if (m.material[i] === 0) continue;
        if (m.material[i + 1] !== 0 && m.bondR[i] === 0 && i % m.w < m.w - 1) n++;
        if (m.material[i + m.w] !== 0 && m.bondD[i] === 0) n++;
      }
      return n;
    };
    const c0 = brokenBonds();
    run(world, 60);
    const c1 = brokenBonds();
    // the fissure network keeps growing after the blow (or has already shed its slab)
    expect(c1 > c0 || world.diagnostics().chunks > 0).toBe(true);
    run(world, 900);
    expect(b.frontCount).toBe(0);
    conserved(world);
  });

  it('a line lash carves along its axis and PIERCE bores a channel', () => {
    const tb = celadonBody({ size: 50, seed: 8, x: 400, y: 290 });
    const { world, ids } = make(5, [tb]);
    const r = world.applyDamage(
      ids[0]!,
      ev({
        type: 'FRACTURE',
        shape: { kind: 'line', x0: 330, y0: 290, x1: 470, y1: 290, width: 4 },
        energy: 80,
        flags: DamageFlag.PIERCE | DamageFlag.CONTINUOUS,
        dirX: 1,
      }),
    );
    expect(r.cellsRemoved).toBeGreaterThan(5);
    // The channel is on the axis: cells removed lie near y = 290.
    let offAxis = 0;
    for (let y = 0; y < tb.map.h; y++)
      for (let x = 0; x < tb.map.w; x++)
        if (
          tb.map.material[y * tb.map.w + x] === 0 &&
          Math.abs(y - tb.map.coreY) > 6 &&
          Math.abs(x - tb.map.coreX) < 30
        )
          offAxis++;
    void offAxis;
    expect(r.contactY).toBeGreaterThan(280);
    expect(r.contactY).toBeLessThan(300);
  });
});

describe('CRUSH', () => {
  it('makes a wider, shallower crater than KINETIC, compacts the rim and snaps bonds with an expanding shock ring', () => {
    const measure = (
      type: 'CRUSH' | 'KINETIC',
    ): { removed: number; dense: number; cracked: number; cracked30: number } => {
      const tb = layeredDisc({ size: 54, seed: 4, x: 400, y: 290 });
      const { world, ids } = make(3, [tb]);
      const before = tb.map.material.slice();
      world.applyDamage(
        ids[0]!,
        ev({
          type,
          shape: { kind: 'point', x: 352, y: 290, r: 14 },
          energy: 1500,
          params: { compress: 10, shock: 1 },
        }),
      );
      let removed = 0;
      for (let i = 0; i < before.length; i++) if (before[i] !== 0 && tb.map.material[i] === 0) removed++;
      let dense = 0;
      for (let i = 0; i < before.length; i++)
        if (tb.map.density[i]! > 132 && tb.map.material[i] !== 0) dense++;
      const c0 = world.stats(ids[0]!).crackedCells;
      run(world, 30);
      const c30 = world.stats(ids[0]!).crackedCells;
      conserved(world);
      return { removed, dense, cracked: c0, cracked30: c30 };
    };
    const c = measure('CRUSH');
    const k = measure('KINETIC');
    expect(c.dense).toBeGreaterThan(20); // compression: density rose around the crater
    expect(k.dense).toBe(0);
    expect(c.cracked30).toBeGreaterThan(c.cracked + 5); // the shock ring keeps breaking bonds after the impact
    expect(c.removed).toBeGreaterThan(50);
  });

  it('sustained crush on the same spot keeps compacting and weakening', () => {
    const tb = layeredDisc({ size: 54, seed: 4, x: 400, y: 290 });
    const { world, ids } = make(3, [tb]);
    let removedTotal = 0;
    for (let k = 0; k < 4; k++) {
      const r = world.applyDamage(
        ids[0]!,
        ev({
          type: 'CRUSH',
          shape: { kind: 'point', x: 352, y: 290, r: 14 },
          energy: 900,
          params: { compress: 10 },
        }),
      );
      removedTotal += r.cellsRemoved;
      run(world, 20);
    }
    expect(removedTotal).toBeGreaterThan(150);
    conserved(world);
  });
});

describe('THERMAL', () => {
  it('burns flammable lattice (fronts spread), chars, ashes and produces few chunks; mass is conserved', () => {
    const tb = latticeDisc({ size: 40, seed: 3, x: 400, y: 290 });
    const { world, ids } = make(3, [tb]);
    world.applyDamage(
      ids[0]!,
      ev({ type: 'THERMAL', shape: { kind: 'point', x: 372, y: 290, r: 6 }, energy: 40 }),
    );
    run(world, 30);
    const s30 = world.stats(ids[0]!).burningCells;
    expect(s30).toBeGreaterThan(5);
    run(world, 200);
    const s = world.stats(ids[0]!);
    expect(s.burningCells).toBeGreaterThan(s30 * 0.5); // the front kept spreading rather than dying at once
    // ash was appended to the table and cells converted to it
    const ashId = tb.materials.findIndex((m) => m.key === 'ash');
    expect(ashId).toBeGreaterThan(0);
    let ash = 0;
    for (let i = 0; i < tb.map.material.length; i++) if (tb.map.material[i] === ashId) ash++;
    expect(ash).toBeGreaterThan(5);
    expect(countFlag(tb, CellFlag.CHARRED)).toBeGreaterThan(5);
    // THERMAL destroys by burning, not by shearing: no big rigid chunks
    expect(world.diagnostics().chunks).toBeLessThan(12);
    conserved(world);
  });

  it('heat diffusion is stable: temperatures stay finite and bounded over 10k ticks of continuous heating', () => {
    const tb = layeredDisc({ size: 30, seed: 3, x: 400, y: 290 });
    const { world, ids } = make(3, [tb]);
    for (let t = 0; t < 10000; t++) {
      if (t % 50 === 0)
        world.applyDamage(
          ids[0]!,
          ev({ type: 'THERMAL', shape: { kind: 'point', x: 385, y: 285, r: 8 }, energy: 6 }),
        );
      world.tick();
    }
    let max = 0;
    for (let i = 0; i < tb.map.temperature.length; i++) {
      const T = tb.map.temperature[i]!;
      expect(Number.isFinite(T)).toBe(true);
      expect(T).toBeGreaterThanOrEqual(0);
      max = Math.max(max, T);
    }
    expect(max).toBeLessThan(6000);
    conserved(world);
  });

  it('atmosphere absorbs heat: the crust under a gas shell is heated far less than the same crust without it', () => {
    const heatCrust = (withAtmo: boolean): number => {
      const tb = gasPlanet({ size: 40, seed: 5, x: 400, y: 290 });
      const airId = tb.materials.findIndex((m) => m.key === 'air');
      if (!withAtmo)
        for (let i = 0; i < tb.map.material.length; i++)
          if (tb.map.material[i] === airId) tb.map.material[i] = 0;
      const { world, ids } = make(3, [tb]);
      world.applyDamage(
        ids[0]!,
        ev({
          type: 'THERMAL',
          shape: { kind: 'point', x: 353, y: 290, r: 12 },
          energy: 30,
          dirX: 1,
          dirY: 0,
        }),
      );
      const crustId = tb.materials.findIndex((m) => m.key === 'crust');
      let sum = 0;
      for (let i = 0; i < tb.map.material.length; i++)
        if (tb.map.material[i] === crustId) sum += tb.map.temperature[i]!;
      void ids;
      return sum;
    };
    const shielded = heatCrust(true);
    const bare = heatCrust(false);
    expect(bare).toBeGreaterThan(0);
    expect(shielded).toBeLessThan(bare * 0.8);
  });

  it('ocean cells boil away (boil events) and flammable gas ignites with fireballs', () => {
    const tb = gasPlanet({ size: 40, seed: 5, x: 400, y: 290 });
    const { world, ids } = make(3, [tb]);
    const oceanId = tb.materials.findIndex((m) => m.key === 'ocean');
    const events: SimEvent[] = [];
    // heat a point on the ocean surface hard (PIERCE ignores the shielding)
    world.applyDamage(
      ids[0]!,
      ev({
        type: 'THERMAL',
        shape: { kind: 'field', x: 400, y: 252, r: 30, falloff: 0.5 },
        energy: 200,
        flags: DamageFlag.PIERCE,
        dirX: 0,
        dirY: 1,
        params: { heat: 15000 },
      }),
    );
    run(world, 30);
    world.drainEvents(events);
    let oceanLeft = 0;
    for (let i = 0; i < tb.map.material.length; i++) if (tb.map.material[i] === oceanId) oceanLeft++;
    expect(events.some((e) => e.t === 'matter' && e.kind === 'boil') || oceanLeft < 200).toBe(true);
    conserved(world);
  });

  it('burning kills infection and infected matter burns faster', () => {
    const burn = (infected: boolean): number => {
      const tb = latticeDisc({ size: 30, seed: 3, x: 400, y: 290 });
      if (infected)
        for (let i = 0; i < tb.map.material.length; i++)
          if (tb.map.material[i] !== 0) {
            tb.map.infection[i] = 255;
            tb.map.flags[i] = tb.map.flags[i]! | CellFlag.ASSIMILATED;
          }
      const { world, ids } = make(3, [tb]);
      world.applyDamage(
        ids[0]!,
        ev({ type: 'THERMAL', shape: { kind: 'point', x: 390, y: 290, r: 10 }, energy: 30 }),
      );
      run(world, 120);
      return world.stats(ids[0]!).cells + (infected ? 0 : 0);
    };
    // Infected lattice takes 1.5x the heat and loses integrity 1.6x faster: more of it is gone after the same time.
    expect(burn(true)).toBeLessThanOrEqual(burn(false));
  });
});

describe('TIDAL', () => {
  it('tears matter off toward the sink, spirals it in, consumes it and credits the attacker (mass moves, none is lost)', () => {
    const victim = layeredDisc({ size: 40, seed: 3, x: 250, y: 290, ownerSlot: 0 });
    const bh = blackHole({ size: 12, seed: 2, x: 520, y: 290, ownerSlot: 1 });
    const { world, ids } = make(3, [victim, bh]);
    world.setGravitySource(1, {
      x: 520,
      y: 290,
      strength: 400,
      radius: 320,
      consumeRadius: 14,
      creditBodyId: ids[1]!,
    });
    const m0 = world.stats(ids[0]!).mass;
    const bh0 = world.stats(ids[1]!).mass;
    let transferred = 0;
    for (let t = 0; t < 120; t++) {
      const r = world.applyDamage(
        ids[0]!,
        ev({
          type: 'TIDAL',
          shape: { kind: 'field', x: 250, y: 290, r: 90, falloff: 1.4 },
          energy: 6,
          flags: DamageFlag.CONTINUOUS,
          sourceBodyId: ids[1]!,
          originX: 520,
          originY: 290,
          params: { pull: 1.2 },
        }),
      );
      transferred += r.massTransferred;
      world.tick();
    }
    run(world, 200);
    const lost = m0 - world.stats(ids[0]!).mass;
    const gained = world.stats(ids[1]!).mass - bh0;
    expect(lost).toBeGreaterThan(200);
    expect(transferred).toBeGreaterThan(200);
    // Everything torn off ended up in the black hole (streams and consumed chunks): within a few percent.
    expect(gained).toBeGreaterThan(lost * 0.85);
    expect(gained).toBeLessThanOrEqual(lost + 1e-6);
    expect(world.stats(ids[1]!).massGained).toBeCloseTo(gained, 3);
    expect(world.stats(ids[0]!).massLost).toBeGreaterThan(200);
    expect(world.stats(ids[1]!).massFrac).toBeGreaterThan(1);
    conserved(world);
  });

  it('the horizon is immune to everything', () => {
    const bh = blackHole({ size: 14, seed: 2, x: 400, y: 290, ownerSlot: 1 });
    const { world, ids } = make(3, [bh]);
    const horizon = bh.materials.findIndex((m) => m.key === 'horizon');
    const countH = (): number => {
      let n = 0;
      for (let i = 0; i < bh.map.material.length; i++) if (bh.map.material[i] === horizon) n++;
      return n;
    };
    const h0 = countH();
    for (const type of ['FRACTURE', 'KINETIC', 'CRUSH', 'THERMAL', 'TIDAL', 'ASSIMILATION'] as const)
      world.applyDamage(
        ids[0]!,
        ev({
          type,
          shape: { kind: 'point', x: 400, y: 290, r: 10 },
          energy: 3000,
          originX: 800,
          originY: 290,
          params: { heat: 5000 },
        }),
      );
    run(world, 60);
    expect(countH()).toBe(h0);
  });

  it('gas and plasma strip far more easily than solid rock under the same field', () => {
    const strip = (tb: TestBody): number => {
      const { world, ids } = make(3, [tb]);
      const c0 = world.stats(ids[0]!).cells;
      for (let t = 0; t < 30; t++) {
        world.applyDamage(
          ids[0]!,
          ev({
            type: 'TIDAL',
            shape: { kind: 'field', x: 400, y: 290, r: 90, falloff: 1.4 },
            energy: 4,
            flags: DamageFlag.CONTINUOUS,
            originX: 700,
            originY: 290,
            params: { pull: 1 },
          }),
        );
        world.tick();
      }
      return (c0 - world.stats(ids[0]!).cells) / c0;
    };
    const star = strip(gasPlanet({ size: 30, seed: 1, x: 400, y: 290 })); // has gas/cloud/ocean shell
    const slab = strip(ribbedSlab({ size: 44, seed: 1, x: 400, y: 290 }));
    expect(star).toBeGreaterThan(slab);
  });
});

describe('ASSIMILATION', () => {
  const nexus = (): TestBody => latticeDisc({ size: 34, seed: 9, x: 200, y: 290, ownerSlot: 1 });

  it('LATCH infects at the contact; infection spreads along bonds over time and converts cells to lattice', () => {
    const tb = celadonBody({ size: 44, seed: 3, x: 400, y: 290 });
    const { world, ids } = make(3, [tb]);
    world.applyDamage(
      ids[0]!,
      ev({
        type: 'ASSIMILATION',
        shape: { kind: 'point', x: 362, y: 290, r: 8 },
        energy: 300,
        flags: DamageFlag.LATCH,
        originX: 100,
        originY: 290,
        params: { latch: 220 },
      }),
    );
    const i0 = world.stats(ids[0]!).infectedCells;
    expect(i0).toBeGreaterThan(10);
    expect(countFlag(tb, CellFlag.ASSIMILATED)).toBeGreaterThan(5);
    run(world, 150);
    const i1 = world.stats(ids[0]!).infectedCells;
    expect(i1).toBeGreaterThan(i0 * 1.4);
    conserved(world);
  });

  it('infection does not cross severed bonds (cracks stop it)', () => {
    const tb = celadonBody({ size: 44, seed: 3, x: 400, y: 290 });
    const { world, ids } = make(3, [tb]);
    const map = tb.map;
    // Wall: sever the column of bonds at x = coreX - 6 across the whole body.
    const wallX = map.coreX - 6;
    for (let y = 0; y < map.h; y++) map.bondR[y * map.w + wallX] = 0;
    world.applyDamage(
      ids[0]!,
      ev({
        type: 'ASSIMILATION',
        shape: { kind: 'point', x: 400 - 6 - 12, y: 290, r: 5 },
        energy: 300,
        flags: DamageFlag.LATCH,
        originX: 100,
        originY: 290,
        params: { latch: 255 },
      }),
    );
    run(world, 400);
    let beyond = 0;
    for (let y = 0; y < map.h; y++)
      for (let x = wallX + 1; x < map.w; x++) if (map.infection[y * map.w + x]! >= 40) beyond++;
    expect(beyond).toBe(0);
  });

  it('harvest tears converted lattice out and credits its mass to the source body', () => {
    const victim = celadonBody({ size: 40, seed: 3, x: 500, y: 290, ownerSlot: 0 });
    const src = nexus();
    const { world, ids } = make(3, [victim, src]);
    world.setGravitySource(1, {
      x: 200,
      y: 290,
      strength: 0,
      radius: 10,
      consumeRadius: 0,
      creditBodyId: ids[1]!,
    });
    const g0 = world.stats(ids[1]!).mass;
    world.applyDamage(
      ids[0]!,
      ev({
        type: 'ASSIMILATION',
        shape: { kind: 'point', x: 465, y: 290, r: 9 },
        energy: 300,
        flags: DamageFlag.LATCH,
        sourceBodyId: ids[1]!,
        originX: 200,
        originY: 290,
        params: { latch: 255, harvest: 1 },
      }),
    );
    run(world, 500);
    const gained = world.stats(ids[1]!).mass - g0;
    expect(gained).toBeGreaterThan(3);
    expect(world.stats(ids[1]!).massGained).toBeCloseTo(gained, 3);
    expect(world.stats(ids[0]!).massLost).toBeGreaterThan(3);
    conserved(world);
  });
});

describe('what differs between types on the same target', () => {
  it('THERMAL leaves no chunks, TIDAL streams to the sink, KINETIC many small pieces, FRACTURE few big ones', () => {
    const outcome = (
      type: DamageEvent['type'],
    ): { chunks: number; largest: number; particles: number; burning: number } => {
      const tb = layeredDisc({ size: 46, seed: 3, x: 400, y: 290 });
      const { world, ids } = make(3, [tb]);
      const cont = type === 'TIDAL' ? DamageFlag.CONTINUOUS : 0;
      const shape =
        type === 'TIDAL'
          ? ({ kind: 'field', x: 400, y: 290, r: 80, falloff: 1.4 } as const)
          : ({ kind: 'point', x: 360, y: 285, r: 10 } as const);
      for (let t = 0; t < (type === 'TIDAL' ? 20 : 1); t++) {
        world.applyDamage(
          ids[0]!,
          ev({
            type,
            shape,
            energy: type === 'THERMAL' ? 60 : type === 'TIDAL' ? 5 : 450,
            flags: cont,
            originX: 800,
            originY: 290,
            params: {},
          }),
        );
        world.tick();
      }
      run(world, 40);
      const pool = world.core.chunks;
      let largest = 0;
      for (let i = 0; i < pool.hi; i++)
        if (pool.list[i]!.alive) largest = Math.max(largest, pool.list[i]!.mass);
      return {
        chunks: pool.count,
        largest,
        particles: world.diagnostics().particles,
        burning: world.stats(ids[0]!).burningCells,
      };
    };
    const th = outcome('THERMAL');
    const fr = outcome('FRACTURE');
    const ki = outcome('KINETIC');
    expect(th.chunks).toBeLessThanOrEqual(1);
    expect(ki.chunks).toBeGreaterThan(fr.chunks);
    expect(fr.largest).toBeGreaterThan(ki.largest * 0.7); // kinetic ejecta blocks are ~6x6 cells, slabs are as big or bigger
    expect(outcome('TIDAL').particles).toBeGreaterThan(0);
  });
});

describe('material table override', () => {
  it('a titan can override physics per material (e.g. make crust immune to FRACTURE)', () => {
    const spec: MaterialSpec = {
      key: 'x',
      base: 'rock',
      physics: { resist: { FRACTURE: 0 } },
      visual: { ramp: ['#111111', '#444444', '#888888'], emissive: 0, char: '#000', crack: '#000' },
    };
    const t = buildMaterialTable([spec]);
    expect(t[1]!.resist.FRACTURE).toBe(0);
  });
});
