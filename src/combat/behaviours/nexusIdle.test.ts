import { describe, expect, it } from 'vitest';
import { LOGICAL_H, LOGICAL_W } from '@/contracts';
import { makeMatch, skipIntro } from '../testing/harness';
import { createMatterWorld } from '@/matter';
import type { FighterImpl } from '../fighter';

const view = { x0: 480, y0: 180, w: LOGICAL_W, h: LOGICAL_H };
const mk = (skip = true) => {
  const m = makeMatch({ a: 'nexus', b: 'nexus', seed: 21, createWorld: (s) => createMatterWorld(s) });
  if (skip) skipIntro(m);
  return m;
};
const hubId = (f: FighterImpl): { crystal: number; hubcore: number } =>
  (f.rig as unknown as { ids: { crystal: number; hubcore: number } }).ids;

describe('the Nexus living idle (idle handover, specs/nexus.md)', () => {
  it('is the same at any frame rate: rendered twice a tick or once every two ticks, the graph looks the same', () => {
    const a = mk();
    const b = mk();
    let la: Uint32Array | null = null;
    let lb: Uint32Array | null = null;
    for (let t = 1; t <= 300; t++) {
      a.step();
      b.step();
      la = a.fighters[0]!.renderLayers(view, 0)[0]!.pixels;
      la = a.fighters[0]!.renderLayers(view, 0.5)[0]!.pixels;
      if (t % 2 === 0) lb = b.fighters[0]!.renderLayers(view, 0)[0]!.pixels;
    }
    expect(Array.from(la!)).toEqual(Array.from(lb!));
  });

  it('composites in its own skin, never in the matter map, and the gems really move', () => {
    const m = mk();
    const f = m.fighters[0] as FighterImpl;
    const before = new Uint32Array(f.body.map.pixels);
    let moved = 0;
    for (let t = 0; t < 240; t++) {
      m.step();
      const body = f.renderLayers(view, 0)[0]!;
      expect(body.pixels).not.toBe(f.body.map.pixels);
      let d = 0;
      for (let i = 0; i < before.length; i++) if (body.pixels[i] !== f.body.map.pixels[i]) d++;
      moved = Math.max(moved, d);
    }
    expect(Array.from(f.body.map.pixels)).toEqual(Array.from(before));
    expect(moved).toBeGreaterThan(300);
  });

  it('at rest (no gem moved yet) the forged chains are the painted ones: only the heart differs', () => {
    const m = mk(false);
    const f = m.fighters[0] as FighterImpl;
    const ids = hubId(f);
    let body = f.renderLayers(view, 0)[0]!;
    for (let t = 0; t < 6; t++) {
      m.step();
      body = f.renderLayers(view, 0)[0]!;
    }
    const map = f.body.map;
    let off = 0;
    let live = 0;
    for (let i = 0; i < map.pixels.length; i++) {
      const mt = map.material[i]!;
      if (mt) live++;
      // the heart's facets turn all the time: they are the idle itself
      if (mt === ids.crystal || mt === ids.hubcore) continue;
      if (body.pixels[i] !== map.pixels[i]) off++;
    }
    expect(off / live).toBeLessThan(0.006);
  });

  it('keeps destroyed matter destroyed: a hole punched in a gem stays a hole', () => {
    // from the first tick: every gem still at home (a gem that has ticked carries its hole with it)
    const m = mk(false);
    const f = m.fighters[0] as FighterImpl;
    const map = f.body.map;
    const rig = f.rig as unknown as { nodes: { x: number; y: number }[] };
    const N = rig.nodes[7]!;
    const hole: number[] = [];
    for (let y = Math.round(N.y) - 2; y < Math.round(N.y) + 2; y++)
      for (let x = Math.round(N.x) - 2; x < Math.round(N.x) + 2; x++) {
        const i = y * map.w + x;
        (map.material as Uint8Array)[i] = 0;
        map.pixels[i] = 0;
        hole.push(i);
      }
    // nothing the idle draws may land in the hole while the gem is at home
    for (let t = 0; t < 6; t++) {
      m.step();
      const body = f.renderLayers(view, 0)[0]!;
      for (const i of hole) expect(body.pixels[i]).toBe(0);
    }
  });
});
