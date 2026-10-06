import { describe, expect, it } from 'vitest';
import { URI_ORDER } from '@/titans/uri/rig';
import { uriRestBodies } from '../../tools/matter/uri2a';
import { createMatterWorld, type MatterWorldEx } from './index';

/**
 * Gate 2C, matter side: 우리's chunk-group damage (uri/docs/URI_SPEC.md §7; the oracle's tear / hitAt / shatterPart /
 * breakApart, uri/src/30_breaking_compose.js).
 */

function uri(seed = 1): { world: MatterWorldEx; ids: number[]; id: (k: string) => number } {
  const world = createMatterWorld(seed);
  const ids = uriRestBodies(world, 120, 16);
  return { world, ids, id: (k: string) => ids[URI_ORDER.indexOf(k as (typeof URI_ORDER)[number])]! };
}

/** A world point on a live cell of group `g`'s interior (its first live cell's centre). */
function pointOf(world: MatterWorldEx, id: number, wantInterior = true): [number, number, number] {
  const b = world.core.bodyById[id]!;
  const groups = b.cellGroups!;
  const mat = b.map.material;
  for (let c = 0; c < b.n; c++) {
    if (mat[c] === 0) continue;
    const x = c % b.w;
    const y = (c - x) / b.w;
    if (
      wantInterior &&
      (x < 2 || y < 2 || mat[c - 1] === 0 || mat[c + 1] === 0 || mat[c - b.w] === 0 || mat[c + b.w] === 0)
    )
      continue;
    const p = { x: 0, y: 0 };
    b.cellWorld(x, y, p);
    return [p.x, p.y, groups[c]!];
  }
  throw new Error('no live cell');
}

const groupMass = (world: MatterWorldEx, id: number, g: number): number => {
  const b = world.core.bodyById[id]!;
  let m = 0;
  for (let c = 0; c < b.n; c++) if (b.map.material[c] !== 0 && b.cellGroups![c] === g) m += b.cellMass(c);
  return m;
};

describe('우리 chunk tearing (Gate 2C)', () => {
  it('a blow tears out exactly the struck chunk as one tumbling piece with its own colours and mass; the hole glows', () => {
    const { world, id } = uri();
    const dome = id('domeR');
    const [x, y, g] = pointOf(world, dome);
    const b = world.core.bodyById[dome]!;
    const m0 = groupMass(world, dome, g);
    const n0 = world.diagnostics().chunks;
    expect(world.groupAt(dome, x, y)).toBe(g);
    expect(world.hitTear(dome, x, y, 1)).toBe(1);
    expect(world.diagnostics().chunks).toBe(n0 + 1);
    expect(groupMass(world, dome, g)).toBe(0);
    const pool = world.core.chunks;
    const ch = pool.list
      .slice(0, pool.hi)
      .filter((c) => c.alive)
      .pop()!;
    expect(ch.mass).toBeCloseTo(m0, 6);
    expect(ch.origin).toBe(dome);
    // its colours are the cells' displayed pixels (no new colours)
    const palette = new Set(Array.from(b.map.baseColor, (c) => c >>> 0));
    for (let i = 0; i < ch.w * ch.h; i++)
      if (ch.pixels[i]! >>> 24 !== 0) expect(palette.has(ch.pixels[i]! >>> 0)).toBe(true);
    // the wound glows: bordering cells of other chunks became habitat / crack
    const hab = b.materials.findIndex((m) => m.key === 'habitat');
    const crk = b.materials.findIndex((m) => m.key === 'crack');
    let glow = 0;
    for (let c = 0; c < b.n; c++) if (b.map.material[c] === hab || b.map.material[c] === crk) glow++;
    expect(glow).toBeGreaterThan(5);
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
    // no instant vanish: the piece flies off, alive, keeping its push
    const x0 = ch.x;
    const y0 = ch.y;
    for (let t = 0; t < 30; t++) world.tick();
    expect(ch.alive).toBe(true);
    expect(Math.hypot(ch.x - x0, ch.y - y0)).toBeGreaterThan(5);
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
  });

  it("proposal 175's tearCells: the listed cells as one piece at the given velocity, the wound lit with the given materials", () => {
    const { world, id } = uri(8);
    const dome = id('domeL');
    const b = world.core.bodyById[dome]!;
    const g = b.cellGroups![b.map.material.findIndex((m) => m !== 0)]!;
    const cells: number[] = [];
    for (let c = 0; c < b.n; c++) if (b.map.material[c] !== 0 && b.cellGroups![c] === g) cells.push(c);
    const m0 = groupMass(world, dome, g);
    const hab = b.materials.findIndex((m) => m.key === 'habitat');
    const crk = b.materials.findIndex((m) => m.key === 'crack');
    const cid = world.tearCells(dome, Int32Array.from(cells), cells.length, -120, 40, 1.5, {
      mats: [hab, crk],
      chance: 1,
    });
    expect(cid).toBeGreaterThan(0);
    const s = {
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
    };
    expect(world.chunkState(cid, s)).toBe(true);
    expect(s.mass).toBeCloseTo(m0, 6);
    expect(s.vx).toBeCloseTo(-120, 6);
    // chance 1: every live neighbour of the hole is now wound matter
    let wound = 0;
    for (let c = 0; c < b.n; c++) if (b.map.material[c] === hab || b.map.material[c] === crk) wound++;
    expect(wound).toBeGreaterThan(cells.length / 4);
    expect(world.tearCells(dome, Int32Array.from(cells), cells.length, 0, 0, 0)).toBe(-1); // already gone
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
  });

  it('a heavy blow takes neighbouring chunks too (up to 2 × power), deterministically', () => {
    const run = (): { torn: number; hash: number } => {
      const { world, id } = uri(7);
      const ch = id('chamber');
      const [x, y] = pointOf(world, ch);
      const torn = world.hitTear(ch, x, y, 3);
      for (let t = 0; t < 20; t++) world.tick();
      return { torn, hash: world.hash() };
    };
    const a = run();
    const b = run();
    expect(a.torn).toBeGreaterThanOrEqual(3);
    expect(a.torn).toBeLessThanOrEqual(6);
    expect(b).toEqual(a);
  });

  it('a rotated part tears its chunk where it is drawn', () => {
    const { world, id } = uri(3);
    const fa = id('faL');
    const b = world.core.bodyById[fa]!;
    b.transform.rot = 40;
    world.tick();
    // a drawn pixel of the rotated part
    let hit: [number, number] | null = null;
    for (let y = 100; y < 360 && !hit; y++)
      for (let x = 0; x < 300 && !hit; x++)
        if (world.groupAt(fa, x + 0.5, y + 0.5) >= 0) hit = [x + 0.5, y + 0.5];
    expect(hit).not.toBeNull();
    const g = world.groupAt(fa, hit![0], hit![1]);
    expect(world.hitTear(fa, hit![0], hit![1], 1)).toBe(1);
    expect(groupMass(world, fa, g)).toBe(0);
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
  });

  it('held by fields: a piece a ring of holes cuts off stays on the part (the oracle); without the flag matter sheds it', () => {
    const run = (held: boolean): { cells: number; chunks: number } => {
      const { world, id } = uri(6);
      const dome = id('domeR');
      const b = world.core.bodyById[dome]!;
      expect(world.setFieldHeld(dome, held)).toBe(true);
      // tear every group around one central group: it is left floating, cut off from the joint patch
      const groups = b.cellGroups!;
      let c0 = -1;
      for (let c = 0; c < b.n && c0 < 0; c++) {
        const x = c % b.w;
        const y = (c - x) / b.w;
        if (b.map.material[c] !== 0 && Math.abs(x - b.w * 0.75) < 2 && Math.abs(y - b.h * 0.3) < 2) c0 = c;
      }
      const g0 = groups[c0]!;
      const ring = new Set<number>();
      for (let c = 0; c < b.n; c++) {
        if (b.map.material[c] === 0 || groups[c] !== g0) continue;
        const x = c % b.w;
        for (const j of [
          c - 1,
          c + 1,
          c - b.w,
          c + b.w,
          c - 2,
          c + 2,
          c - 2 * b.w,
          c + 2 * b.w,
          c - b.w - 1,
          c + b.w + 1,
        ])
          if (j >= 0 && j < b.n && b.map.material[j] !== 0 && groups[j] !== g0 && Math.abs((j % b.w) - x) < 3)
            ring.add(groups[j]!);
      }
      for (const g of ring) world.tearGroup(dome, g, 0, 0, 0.5);
      const chunks0 = world.diagnostics().chunks;
      for (let t = 0; t < 60; t++) world.tick();
      let left = 0;
      for (let c = 0; c < b.n; c++) if (b.map.material[c] !== 0 && groups[c] === g0) left++;
      expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
      return { cells: left, chunks: world.diagnostics().chunks - chunks0 };
    };
    const held = run(true);
    const free = run(false);
    expect(held.cells).toBeGreaterThan(0); // the cut-off chunk stays on the part
    expect(free.cells).toBe(0); // plain matter sheds it
    expect(free.chunks).toBeGreaterThan(held.chunks);
  });

  it('neck integrity: the live fraction of a joint patch (wound cells still count)', () => {
    const { world, id } = uri(4);
    const ua = id('uaL');
    const b = world.core.bodyById[ua]!;
    const patch: number[] = [];
    for (let c = 0; c < b.n; c++) if (b.map.material[c] !== 0 && patch.length < 200) patch.push(c);
    expect(world.liveFraction(ua, patch)).toBe(1);
    const g = b.cellGroups![patch[0]!]!;
    const p = { x: 0, y: 0 };
    b.cellWorld(patch[0]! % b.w, Math.floor(patch[0]! / b.w), p);
    world.tearGroup(ua, g, p.x - 10, p.y, 1);
    const f = world.liveFraction(ua, patch);
    expect(f).toBeLessThan(1);
    expect(f).toBeGreaterThan(0.5);
  });

  it('the 50 % rule / break-apart: a part lets go as its chunks; a short pool merges neighbours instead of dusting them', () => {
    const { world, id } = uri(5);
    const fist = id('fistR');
    const s0 = world.stats(fist);
    expect(s0.cells / s0.initialCells).toBe(1);
    const nGroups = new Set(
      Array.from(world.cellGroups(fist)!).filter((_, c) => world.core.bodyById[fist]!.map.material[c] !== 0),
    ).size;
    const made = world.releaseGroups(fist, 400, 300, 0.55);
    expect(made).toBe(nGroups);
    expect(world.stats(fist).cells).toBe(0);
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
    // the chamber with only 40 free slots: merged into ≤ 40 pieces, none degraded
    const ch = id('chamber');
    const before = world.ledger().dissipated;
    const pieces = world.releaseGroups(ch, 330, 150, 0.35, 40);
    expect(pieces).toBeLessThanOrEqual(40);
    expect(pieces).toBeGreaterThan(10);
    expect(world.stats(ch).cells).toBe(0);
    expect(world.ledger().dissipated).toBeCloseTo(before, 6);
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
  });
});
