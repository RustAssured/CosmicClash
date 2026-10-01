import { describe, expect, it } from 'vitest';
import {
  CellFlag,
  DEFAULT_LIGHTING,
  LOGICAL_H,
  LOGICAL_W,
  type DamageEvent,
  type TitanId,
} from '@/contracts';
import { generateTitanBody, getTitanDef } from '@/titans';
import { createMatterWorld, type MatterWorldEx } from './index';
import { ChunkPool, YOUNG_TICKS, degradeToDust, type Chunk } from './chunks';
import { layeredDisc, type TestBody } from './testing/bodies';
import { SLICE_BLOWS, measureBlow } from './testing/woundbench';
import { HAIRLINE, SLAB_HELD, shearDelay } from './wound';

/**
 * D1 — "the instant cut". Damage may count instantly; SEPARATION takes time: a heavy blow cracks the body on the impact frame,
 * holds the freed matter as slabs, shears them 80–300 ms later (wall time, hit-stop included) and lets them go a piece at a
 * time as tumbling chunks carrying the wound's momentum. Baseline before the fix (tools/lead/pacing.ts, 40 fights): the
 * largest one-tick loss was 51 % of a heavy hit's 1.5 s loss on the Planet, and that tick was 98 % particles.
 */

const deps = {
  createMatterWorld,
  generate: (id: TitanId) => generateTitanBody(getTitanDef(id), 3, DEFAULT_LIGHTING),
  def: getTitanDef,
};

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

function make(seed: number, tb: TestBody): { world: MatterWorldEx; id: number } {
  const world = createMatterWorld(seed);
  return { world, id: world.createBody(tb.spec).id };
}

describe('D1 regression: heavy slice blows on the real titan bodies', () => {
  for (const blow of SLICE_BLOWS) {
    it(`${blow.name}: no instant cut, slabs not embers, a timed shear carrying the wound's momentum`, () => {
      const r = measureBlow(blow, deps);
      expect(r.loss).toBeGreaterThan(50);
      // The largest one-tick body-mass loss is a small share of what the blow takes in 1.5 s (was 51 % on the Planet).
      expect(r.maxTickShare).toBeLessThanOrEqual(0.15);
      // Removed solid matter leaves as rigid chunks (fluids and gas excepted; was ~2 % in the worst tick).
      expect(r.chunkShare).toBeGreaterThanOrEqual(0.6);
      // Crack on the impact frame; shear 80–300 ms after it (wall time, hit-stop included).
      expect(r.crackCells).toBeGreaterThan(50);
      expect(r.shearMs).toBeGreaterThanOrEqual(80);
      expect(r.shearMs).toBeLessThanOrEqual(300);
      // The slabs carry >= 60 % of the wound's directional momentum, and tumble with their lever arm.
      expect(r.momentum).toBeGreaterThanOrEqual(0.6);
      expect(r.spinAgree).toBeGreaterThanOrEqual(0.8);
      // Matter FX (flash disc, near plume, crater dust) clear the wound box within 400 ms.
      expect(r.fxClearMs).toBeGreaterThanOrEqual(0);
      expect(r.fxClearMs).toBeLessThanOrEqual(400);
      expect(r.ledgerError).toBeLessThan(1e-2);
    }, 60_000);
  }

  it('is deterministic (same blow, same hash)', () => {
    const a = measureBlow(SLICE_BLOWS[1]!, deps);
    const b = measureBlow(SLICE_BLOWS[1]!, deps);
    expect(a.hash).toBe(b.hash);
  }, 60_000);
});

describe('wound sequencing on a synthetic body', () => {
  const blow = (hitstop: number): DamageEvent =>
    ev({
      type: 'KINETIC',
      shape: { kind: 'point', x: 356, y: 290, r: 10 },
      energy: 1200,
      params: { crater: 14 },
      hitstop,
    });

  it('the impact frame shows the crack, the matter is still there, and the damage already counts', () => {
    const tb = layeredDisc({ size: 50, seed: 4, x: 400, y: 290 });
    const { world, id } = make(3, tb);
    const m0 = world.stats(id).mass;
    const px0 = tb.map.pixels.slice();
    const r = world.applyDamage(id, blow(8));
    world.tick(); // the impact frame
    const held = world.diagnostics().heldSlabs;
    expect(held).toBeGreaterThan(4);
    // DamageResult counts the committed bowl at once ...
    expect(r.massRemoved).toBeGreaterThan(80);
    // ... while most of it is still body matter (held slabs), only the pulverised core is gone.
    const lostNow = m0 - world.stats(id).mass;
    expect(lostNow).toBeLessThan(r.massRemoved * 0.25);
    // Hairline outlines are drawn: cracked cells beside bond-1 edges whose pixels changed on this frame.
    const map = tb.map;
    let hair = 0;
    let redrawn = 0;
    for (let i = 0; i < map.material.length; i++) {
      if (map.material[i] === 0 || (map.flags[i]! & CellFlag.CRACKED) === 0) continue;
      const x = i % map.w;
      if (x < map.w - 1 && map.material[i + 1] !== 0 && map.bondR[i] === HAIRLINE) {
        hair++;
        if (map.pixels[i] !== px0[i]) redrawn++;
      }
    }
    expect(hair).toBeGreaterThan(20);
    expect(redrawn).toBeGreaterThan(hair * 0.8);
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
  });

  it('shear timing: hit-stop counts toward the 80–300 ms beat', () => {
    expect(shearDelay(0)).toBe(8); // 133 ms of world time
    expect(shearDelay(8)).toBe(1); // 8 frozen frames + 1 tick = 150 ms
    expect(shearDelay(13)).toBe(1); // capped hit-stop: the first world tick after it (233 ms)
    for (const hs of [0, 4, 8, 13]) {
      const tb = layeredDisc({ size: 50, seed: 4, x: 400, y: 290 });
      const { world, id } = make(3, tb);
      world.applyDamage(id, blow(hs));
      let first = -1;
      for (let t = 0; t < 40 && first < 0; t++) {
        world.tick();
        if (world.diagnostics().chunks > 0) first = t;
      }
      const wallMs = first === 0 ? 0 : (hs + first) * (1000 / 60);
      expect(wallMs).toBeGreaterThanOrEqual(80);
      expect(wallMs).toBeLessThanOrEqual(300);
    }
  });

  it('held slabs leave one budgeted piece at a time and the ledger stays exact', () => {
    const tb = layeredDisc({ size: 50, seed: 4, x: 400, y: 290 });
    const { world, id } = make(3, tb);
    const m0 = world.stats(id).mass;
    world.applyDamage(id, blow(8));
    let last = m0;
    let maxTick = 0;
    let ticks = 0;
    while (world.diagnostics().heldSlabs > 0 && ticks < 120) {
      world.tick();
      const m = world.stats(id).mass;
      maxTick = Math.max(maxTick, last - m);
      last = m;
      ticks++;
      expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
    }
    expect(world.diagnostics().heldSlabs).toBe(0);
    expect(ticks).toBeGreaterThan(5);
    const total = m0 - world.stats(id).mass;
    expect(maxTick).toBeLessThan(total * 0.15);
    // Every slab became a chunk (or, for a crumb, dust): no cell is left tagged as held.
    const body = world.core.bodyById[id]!;
    for (let s = 1; s < body.wounds.state.length; s++) expect(body.wounds.state[s]).not.toBe(SLAB_HELD);
    let tagged = 0;
    for (let i = 0; i < body.n; i++) if (tb.map.detached[i] !== 0) tagged++;
    expect(tagged).toBe(0);
  });

  it('restore and heal drop every wound and held slab', () => {
    const tb = layeredDisc({ size: 50, seed: 4, x: 400, y: 290 });
    const { world, id } = make(3, tb);
    world.applyDamage(id, blow(8));
    world.tick();
    expect(world.diagnostics().heldSlabs).toBeGreaterThan(0);
    world.heal(id, 0.5, 7);
    expect(world.diagnostics().heldSlabs).toBe(0);
    let tagged = 0;
    for (let i = 0; i < tb.map.detached.length; i++) if (tb.map.detached[i] !== 0) tagged++;
    expect(tagged).toBe(0);
    for (let t = 0; t < 30; t++) world.tick();
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
  });
});

describe('debris pool policy', () => {
  it('a full pool never degrades young chunks while settled ones exist', () => {
    const world = createMatterWorld(5);
    const core = world.core;
    const pool = new ChunkPool(8);
    const add = (mass: number, age: number): Chunk => {
      const c = pool.add(
        core,
        new Uint32Array(9).fill(0xff808080),
        null,
        3,
        3,
        1.5,
        1.5,
        0,
        0,
        0,
        0,
        0,
        mass,
        -1,
        0.5,
        0,
      );
      c.age = age;
      return c;
    };
    // Four tiny but young chunks, four big settled ones. (Slots are reused at once: compare ids, not objects.)
    const young = [add(1, 10), add(1, 20), add(1, 30), add(1, 40)].map((c) => c.id);
    const old = [add(30, 2000), add(40, 2000), add(50, 2000), add(60, YOUNG_TICKS + 1)].map((c) => c.id);
    add(5, 0); // overflow
    const alive = new Set(pool.list.filter((c) => c.alive).map((c) => c.id));
    for (const id of young) expect(alive.has(id)).toBe(true);
    expect(old.filter((id) => !alive.has(id))).toEqual([old[0]]); // the smallest settled (and old) one went
  });

  it('degrading a chunk never interns new colour ramps (the ramp table cannot run out mid-fight)', () => {
    const tb = layeredDisc({ size: 34, seed: 4, x: 400, y: 290 });
    const { world, id } = make(3, tb);
    world.applyDamage(
      id,
      ev({ type: 'KINETIC', shape: { kind: 'point', x: 372, y: 290, r: 8 }, energy: 900 }),
    );
    for (let t = 0; t < 40; t++) world.tick();
    const core = world.core;
    const ramps = (core.particles as unknown as { rampCount: number }).rampCount;
    let n = 0;
    for (let i = 0; i < core.chunks.hi; i++) {
      const c = core.chunks.list[i]!;
      if (!c.alive) continue;
      expect(c.dustRamp).toBeGreaterThanOrEqual(0);
      degradeToDust(core, c);
      core.chunks.freeAt(i);
      n++;
    }
    expect(n).toBeGreaterThan(0);
    expect((core.particles as unknown as { rampCount: number }).rampCount).toBe(ramps);
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
  });

  it('near-class chunks over the per-frame budget are demoted, never dropped', () => {
    const world = createMatterWorld(9);
    const core = world.core;
    // 40 near-class chunks (ids whose class is 2), all on screen.
    let made = 0;
    for (let id = 1; made < 40 && id < 2000; id++) {
      const slot = ((id * 2654435761) >>> 0) % 8;
      core.chunks.nextId = id;
      const c = core.chunks.add(
        core,
        new Uint32Array(16).fill(0xff90a0b0),
        null,
        4,
        4,
        2,
        2,
        40 + (made % 10) * 60,
        60 + Math.floor(made / 10) * 70,
        0,
        0,
        0,
        5,
        -1,
        0.5,
        0,
      );
      c.age = 100;
      if (slot !== 7) {
        core.chunks.free(c);
        continue;
      }
      made++;
    }
    expect(made).toBe(40);
    const layers = world.renderLayers({ x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H }, 0);
    // Every chunk left a mark in some layer at its position.
    let drawn = 0;
    for (let i = 0; i < core.chunks.hi; i++) {
      const c = core.chunks.list[i]!;
      if (!c.alive) continue;
      const o = Math.floor(c.y) * LOGICAL_W + Math.floor(c.x);
      if (layers.some((l) => l.pixels[o]! >>> 24 !== 0)) drawn++;
    }
    expect(drawn).toBe(40);
  });
});
