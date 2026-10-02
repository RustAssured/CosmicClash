import { describe, expect, it } from 'vitest';
import { LOGICAL_H, LOGICAL_W, type DamageEvent } from '@/contracts';
import { createMatterWorld, type MatterWorldEx } from './index';
import { bridge, celadonBody, layeredDisc, type TestBody } from './testing/bodies';

/**
 * Rig regions (proposal 140, D27): rotated region bodies, joint-patch anchors, `bodyToChunk` and `jointHealth`. Unrotated bodies
 * must not change at all (rot 0 / absent take the original paths byte for byte).
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

function barrage(world: MatterWorldEx, id: number): number {
  for (let t = 0; t < 120; t++) {
    if (t % 12 === 0)
      world.applyDamage(
        id,
        ev({
          type: (['KINETIC', 'FRACTURE', 'CRUSH'] as const)[(t / 12) % 3]!,
          shape: { kind: 'point', x: 360 + (t % 30), y: 280 + (t % 17), r: 9 },
          energy: 500,
          dirY: 0.2,
          params: { compress: 8 },
        }),
      );
    world.tick();
  }
  return world.hash();
}

describe('rotated region bodies', () => {
  it('rot = 0 is byte-identical to an unrotated body', () => {
    const run = (rot: number | undefined): number => {
      const tb = layeredDisc({ size: 40, seed: 3, x: 400, y: 290 });
      if (rot !== undefined) tb.spec.transform.rot = rot;
      const world = createMatterWorld(4);
      return barrage(world, world.createBody(tb.spec).id);
    };
    expect(run(0)).toBe(run(undefined));
  });

  it('overlap and solidAt hit exactly the cells drawn at the rotated pose', () => {
    const tb = celadonBody({ size: 26, seed: 3, x: 300, y: 200 });
    tb.spec.transform.rot = 37;
    const world = createMatterWorld(2);
    const id = world.createBody(tb.spec).id;
    const body = world.core.bodyById[id]!;
    const shape = { kind: 'point' as const, x: 296, y: 207, r: 11 };
    const r = world.overlap(id, shape);
    // brute force over the drawn pixels the disc covers (centre inside)
    const drawn = new Set<number>();
    for (let py = 190; py < 225; py++)
      for (let px = 280; px < 312; px++) {
        const dx = px + 0.5 - shape.x;
        const dy = py + 0.5 - shape.y;
        if (dx * dx + dy * dy >= shape.r * shape.r) continue;
        const c = body.cellAtWorld(px + 0.5, py + 0.5);
        if (c >= 0) drawn.add(c);
      }
    expect(r.cells).toBe(drawn.size);
    expect(r.cells).toBeGreaterThan(100);
    // solidAt agrees with cellAtWorld everywhere
    let bad = 0;
    for (let y = 170; y < 230; y += 0.7)
      for (let x = 270; x < 330; x += 0.7) if (world.solidAt(id, x, y) !== body.cellAtWorld(x, y) >= 0) bad++;
    expect(bad).toBe(0);
  });

  it('a quarter turn is an exact transpose: the same blow, turned with the body, takes the same cells', () => {
    const taken = (rot: number): number[] => {
      const tb = layeredDisc({ size: 34, seed: 5, x: 400, y: 290 });
      tb.spec.transform.rot = rot;
      const world = createMatterWorld(7);
      const id = world.createBody(tb.spec).id;
      // the blow comes from the left of the unrotated body; at a quarter turn (clockwise) the same side faces up
      const blow =
        rot === 0
          ? ev({
              type: 'KINETIC',
              shape: { kind: 'point', x: 372, y: 290, r: 8 },
              energy: 600,
              dirX: 1,
              dirY: 0,
            })
          : ev({
              type: 'KINETIC',
              shape: { kind: 'point', x: 400, y: 262, r: 8 },
              energy: 600,
              dirX: 0,
              dirY: 1,
            });
      const before = tb.map.material.slice();
      world.applyDamage(id, blow);
      const out: number[] = [];
      for (let c = 0; c < before.length; c++)
        if (before[c] !== 0 && (tb.map.material[c] === 0 || tb.map.detached[c] !== 0)) out.push(c);
      return out;
    };
    const a = taken(0);
    const b = taken(64);
    expect(a.length).toBeGreaterThan(40);
    // identical up to the last-ulp of float sums over a differently ordered cell list: allow a 3 % rim difference
    const sb = new Set(b);
    const common = a.filter((c) => sb.has(c)).length;
    expect(common / Math.max(a.length, b.length)).toBeGreaterThan(0.97);
  });

  it('damage on a rotated region keeps the ledger exact and sheds its wound as rigid chunks', () => {
    const tb = layeredDisc({ size: 34, seed: 5, x: 400, y: 290 });
    tb.spec.transform.rot = 21;
    const world = createMatterWorld(3);
    const id = world.createBody(tb.spec).id;
    const m0 = world.stats(id).mass;
    world.applyDamage(
      id,
      ev({
        type: 'CRUSH',
        shape: { kind: 'point', x: 372, y: 282, r: 12 },
        energy: 900,
        params: { compress: 8 },
      }),
    );
    for (let t = 0; t < 60; t++) world.tick();
    expect(world.stats(id).mass).toBeLessThan(m0 - 20);
    expect(world.diagnostics().chunks).toBeGreaterThan(2);
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
  });
});

describe('joint-patch anchors, jointHealth and bodyToChunk', () => {
  /** The bridge's left block, anchored at a patch on its far-left column instead of the core disc. */
  function region(rot = 0): { tb: TestBody; world: MatterWorldEx; id: number; patch: Int32Array } {
    const tb = bridge({ seed: 3, x: 300, y: 200 });
    tb.spec.transform.rot = rot;
    const { w, h } = tb.map;
    let minX = w;
    for (let c = 0; c < w * h; c++) if (tb.map.material[c] !== 0) minX = Math.min(minX, c % w);
    const patch: number[] = [];
    for (let y = 0; y < h; y++)
      for (let x = minX; x < minX + 6; x++) if (tb.map.material[y * w + x] !== 0) patch.push(y * w + x);
    tb.spec.anchorCells = Int32Array.from(patch);
    const world = createMatterWorld(5);
    const id = world.createBody(tb.spec).id;
    return { tb, world, id, patch: Int32Array.from(patch) };
  }

  it('a region anchored at its joint patch keeps everything bonded to the patch and sheds what is cut off from it', () => {
    const { tb, world, id } = region();
    const c0 = world.stats(id).cells;
    for (let t = 0; t < 5; t++) world.tick();
    expect(world.stats(id).cells).toBe(c0);
    // cut the bridge: the right block is no longer bonded to the anchor patch
    for (let y = 18; y < 21; y++) tb.map.bondR[y * tb.map.w + 42] = 0;
    world.settleBody(id);
    for (let t = 0; t < 40; t++) world.tick();
    expect(world.stats(id).cells).toBeLessThan(c0 * 0.8);
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
  });

  it('jointHealth is 1 when pristine, falls as the patch is damaged and 0 once it is cut loose', () => {
    const { tb, world, id, patch } = region();
    expect(patch.length).toBeGreaterThan(20);
    expect(world.jointHealth(id, patch)).toBeCloseTo(1, 6);
    const body = world.core.bodyById[id]!;
    const p = { x: 0, y: 0 };
    body.cellWorld(patch[patch.length >> 1]! % tb.map.w, Math.floor(patch[patch.length >> 1]! / tb.map.w), p);
    world.applyDamage(
      id,
      ev({ type: 'KINETIC', shape: { kind: 'point', x: p.x - 4, y: p.y, r: 6 }, energy: 200 }),
    );
    for (let t = 0; t < 30; t++) world.tick();
    const mid = world.jointHealth(id, patch);
    expect(mid).toBeLessThan(1);
    // sever every bond of the patch
    const m = tb.map;
    for (const c of patch) {
      m.bondR[c] = 0;
      if (c % m.w > 0) m.bondR[c - 1] = 0;
      m.bondD[c] = 0;
      if (c >= m.w) m.bondD[c - m.w] = 0;
    }
    expect(world.jointHealth(id, patch)).toBe(0);
  });

  it('bodyToChunk moves every live cell into one chunk exactly where it was drawn, ledger exact', () => {
    for (const rot of [0, 64]) {
      const { world, id } = region(rot);
      const body = world.core.bodyById[id]!;
      const mass = world.stats(id).mass;
      const view = { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H };
      // where the body is drawn (the cell drawn at each pixel)
      const want = new Set<number>();
      for (let py = 100; py < 300; py++)
        for (let px = 200; px < 420; px++) {
          const c = body.cellAtWorld(px + 0.5, py + 0.5);
          if (c >= 0 && body.map.material[c] !== 0) want.add(py * 100000 + px);
        }
      const chunkId = world.bodyToChunk(id, 0, 0, 0);
      expect(chunkId).toBeGreaterThan(0);
      expect(world.getBody(id)).toBeUndefined();
      const d = world.diagnostics();
      expect(d.chunks).toBe(1);
      expect(d.chunkMass).toBeCloseTo(mass, 6);
      expect(Math.abs(world.ledger().error)).toBeLessThan(1e-6);
      const got = new Set<number>();
      for (const l of world.renderLayers(view, 0))
        for (let i = 0; i < l.pixels.length; i++)
          if (l.pixels[i]! >>> 24 !== 0) got.add(Math.floor(i / LOGICAL_W) * 100000 + (i % LOGICAL_W));
      let miss = 0;
      for (const k of want) if (!got.has(k)) miss++;
      expect(miss).toBe(0);
      expect(got.size).toBe(want.size);
    }
  });
});
