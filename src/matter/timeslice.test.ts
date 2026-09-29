import { describe, expect, it } from 'vitest';
import { DAMAGE_TYPES, DamageFlag, Rng, type DamageEvent, type DamageType } from '@/contracts';
import { createMatterWorld, type MatterWorldEx } from './index';
import {
  bridge,
  celadonBody,
  latticeDisc,
  layeredDisc,
  ribbedSlab,
  sparseLattice,
  uniformDisc,
  type TestBody,
} from './testing/bodies';

/**
 * Work that is spread over ticks (multi-tick events, the deferred FRACTURE chisel, crack fronts, shock rings) and the
 * connectivity shortcut must stay deterministic, cancel cleanly with lifecycle calls, and never change the outcome.
 */
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

function build(seed: number, bodies: TestBody[]): { world: MatterWorldEx; ids: number[] } {
  const world = createMatterWorld(seed);
  return { world, ids: bodies.map((b) => world.createBody(b.spec).id) };
}

const fractureBlow = (x = 352, y = 282): DamageEvent =>
  ev({
    type: 'FRACTURE',
    shape: { kind: 'point', x, y, r: 10 },
    energy: 700,
    flags: DamageFlag.SEED_CRACK,
    params: { crackSeeds: 3 },
  });

describe('deferred chisel and multi-tick jobs', () => {
  function scenario(seed: number, trace: number[]): MatterWorldEx {
    const a = layeredDisc({ size: 46, seed: 5, x: 300, y: 290, ownerSlot: 0 });
    const b = celadonBody({ size: 46, seed: 6, x: 520, y: 290, facing: -1, ownerSlot: 1 });
    const { world, ids } = build(seed, [a, b]);
    world.setGravitySource(1, {
      x: 520,
      y: 290,
      strength: 300,
      radius: 300,
      consumeRadius: 14,
      creditBodyId: ids[1]!,
    });
    for (let t = 0; t < 240; t++) {
      if (t === 0) world.applyDamage(ids[0]!, fractureBlow(255, 282));
      if (t === 2)
        world.applyDamage(
          ids[1]!,
          ev({
            type: 'TIDAL',
            shape: { kind: 'field', x: 520, y: 290, r: 90, falloff: 1.3 },
            energy: 200,
            duration: 40,
            originX: 300,
            originY: 290,
            sourceBodyId: ids[0]!,
            params: { pull: 1.2 },
          }),
        );
      if (t === 7)
        world.applyDamage(
          ids[0]!,
          ev({ type: 'CRUSH', shape: { kind: 'point', x: 300, y: 250, r: 14 }, energy: 900, duration: 9 }),
        );
      if (t === 20) world.applyDamage(ids[1]!, fractureBlow(560, 300));
      world.tick();
      trace.push(world.hash());
    }
    return world;
  }

  it('same seed and same calls give the same hash on every tick, with jobs in flight', () => {
    const a: number[] = [];
    const b: number[] = [];
    scenario(11, a);
    scenario(11, b);
    expect(a).toEqual(b);
    // The trace really changes while the jobs run (they are part of the hashed state), and a different seed diverges.
    expect(new Set(a).size).toBeGreaterThan(200);
    const c: number[] = [];
    scenario(12, c);
    expect(c).not.toEqual(a);
  });

  it('a FRACTURE blow leaves a deferred chisel in the queue that runs a few ticks later', () => {
    const { world, ids } = build(2, [celadonBody({ size: 46, seed: 6, x: 400, y: 290 })]);
    world.applyDamage(ids[0]!, fractureBlow(360, 282));
    expect(world.diagnostics().jobs).toBe(1);
    const h0 = world.hash();
    world.tick();
    expect(world.diagnostics().jobs).toBe(1);
    for (let i = 0; i < 6; i++) world.tick();
    expect(world.diagnostics().jobs).toBe(0);
    expect(world.hash()).not.toBe(h0);
  });

  it('restore() mid-job cancels pending work: the body stays pristine', () => {
    const { world, ids } = build(3, [celadonBody({ size: 46, seed: 6, x: 400, y: 290 })]);
    world.applyDamage(ids[0]!, fractureBlow(360, 282));
    world.applyDamage(
      ids[0]!,
      ev({ type: 'CRUSH', shape: { kind: 'point', x: 360, y: 300, r: 14 }, energy: 800, duration: 30 }),
    );
    world.tick();
    expect(world.diagnostics().jobs).toBeGreaterThan(0);
    world.restore(ids[0]!);
    expect(world.diagnostics().jobs).toBe(0);
    for (let i = 0; i < 40; i++) world.tick();
    const s = world.stats(ids[0]!);
    expect(s.cells).toBe(s.initialCells);
    expect(s.massFrac).toBeCloseTo(1, 6);
  });

  it('heal() mid-job cancels pending work and stays deterministic', () => {
    const run = (): number => {
      const { world, ids } = build(4, [layeredDisc({ size: 44, seed: 5, x: 400, y: 290 })]);
      world.applyDamage(ids[0]!, fractureBlow(362, 282));
      for (let i = 0; i < 2; i++) world.tick();
      world.heal(ids[0]!, 0.8, 9);
      expect(world.diagnostics().jobs).toBe(0);
      for (let i = 0; i < 60; i++) world.tick();
      return world.hash();
    };
    expect(run()).toBe(run());
  });

  it('carve() and removeBody() mid-job are deterministic and safe', () => {
    const run = (): number => {
      const { world, ids } = build(5, [
        layeredDisc({ size: 44, seed: 5, x: 300, y: 290, ownerSlot: 0 }),
        ribbedSlab({ size: 40, seed: 7, x: 520, y: 290, facing: -1, ownerSlot: 1 }),
      ]);
      world.applyDamage(ids[0]!, fractureBlow(262, 282));
      world.applyDamage(ids[1]!, fractureBlow(560, 290));
      world.tick();
      world.carve(ids[0]!, 0.5, 3);
      world.tick();
      world.removeBody(ids[1]!);
      for (let i = 0; i < 40; i++) world.tick();
      expect(Math.abs(world.ledger().error)).toBeLessThan(1e-2);
      return world.hash();
    };
    expect(run()).toBe(run());
  });
});

describe('connectivity shortcut', () => {
  const makers: ((o: object) => TestBody)[] = [
    layeredDisc,
    ribbedSlab,
    celadonBody,
    latticeDisc,
    sparseLattice,
    bridge,
    (o) => uniformDisc('ice', o),
    (o) => uniformDisc('ironNickel', o),
  ];

  function play(scenarioSeed: number, forceFull: boolean): number[] {
    const rng = new Rng(4000 + scenarioSeed);
    const world = createMatterWorld(scenarioSeed + 1);
    world.core.forceFullConn = forceFull;
    const ids: number[] = [];
    for (let k = 0; k < 2; k++) {
      const tb = makers[rng.int(makers.length)]!({
        seed: rng.int(100),
        x: 260 + k * 320,
        y: 270,
        facing: k === 0 ? 1 : -1,
        ownerSlot: k as 0 | 1,
      });
      ids.push(world.createBody(tb.spec).id);
    }
    const trace: number[] = [];
    for (let t = 0; t < 220; t++) {
      if (t % 4 === 0) {
        const target = rng.int(2);
        const type: DamageType = DAMAGE_TYPES[rng.int(6)]!;
        world.applyDamage(
          ids[target]!,
          ev({
            type,
            shape:
              rng.int(3) === 0
                ? {
                    kind: 'line',
                    x0: 200 + rng.next() * 400,
                    y0: 200 + rng.next() * 150,
                    x1: 200 + rng.next() * 400,
                    y1: 200 + rng.next() * 150,
                    width: 2 + rng.next() * 8,
                  }
                : {
                    kind: 'point',
                    x: 230 + target * 320 + rng.next() * 80,
                    y: 220 + rng.next() * 100,
                    r: 4 + rng.next() * 22,
                  },
            energy: 80 + rng.next() * 900,
            dirX: target === 0 ? 1 : -1,
            dirY: rng.next() - 0.5,
            flags: rng.int(2) === 0 ? DamageFlag.SEED_CRACK : 0,
            params: {
              crackSeeds: 3,
              compress: 8,
              embed: 3,
              latch: 200,
              heat: rng.int(3) === 0 ? 3000 : undefined,
            },
            originX: 400,
            originY: 280,
          }),
        );
      }
      if (t === 120) world.heal(ids[0]!, 0.3, 4);
      world.tick();
      if (t % 5 === 0) trace.push(world.hash());
    }
    return trace;
  }

  for (let sc = 0; sc < 16; sc++) {
    it(`local reconnection gives exactly the results of the full flood (scenario ${sc})`, () => {
      expect(play(sc, false)).toEqual(play(sc, true));
    });
  }

  it('after every settle, all live cells of a solid body are anchored (brute force)', () => {
    for (let sc = 0; sc < 4; sc++) {
      const rng = new Rng(9000 + sc);
      const tb = layeredDisc({ size: 46, seed: sc, x: 400, y: 290 });
      const { world, ids } = build(sc + 1, [tb]);
      for (let t = 0; t < 150; t++) {
        if (t % 5 === 0)
          world.applyDamage(
            ids[0]!,
            ev({
              type: DAMAGE_TYPES[rng.int(6)]!,
              shape: {
                kind: 'point',
                x: 350 + rng.next() * 100,
                y: 250 + rng.next() * 80,
                r: 5 + rng.next() * 15,
              },
              energy: 100 + rng.next() * 700,
              params: { compress: 8, heat: 2500 },
              flags: DamageFlag.SEED_CRACK,
            }),
          );
        world.tick();
      }
      world.settleBody(ids[0]!);
      const body = world.core.bodyById[ids[0]!]!;
      const m = body.map;
      const seen = new Uint8Array(body.n);
      const stack: number[] = [];
      for (const c of body.coreDiscIdx)
        if (m.material[c] !== 0) {
          seen[c] = 1;
          stack.push(c);
        }
      while (stack.length) {
        const c = stack.pop()!;
        const x = c % body.w;
        const nb = [
          x < body.w - 1 && m.bondR[c] ? c + 1 : -1,
          x > 0 && m.bondR[c - 1] ? c - 1 : -1,
          m.bondD[c] ? c + body.w : -1,
          c >= body.w && m.bondD[c - body.w] ? c - body.w : -1,
        ];
        for (const n of nb)
          if (n >= 0 && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
      }
      let unanchored = 0;
      for (let c = 0; c < body.n; c++) if (m.material[c] !== 0 && !seen[c]) unanchored++;
      expect(unanchored).toBe(0);
    }
  });
});
