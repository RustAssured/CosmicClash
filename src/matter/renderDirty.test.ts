import { describe, expect, it } from 'vitest';
import { LOGICAL_H, LOGICAL_W, rgba, type RenderLayer } from '@/contracts';
import { createMatterWorld } from './index';

/**
 * S21: the pooled debris / particle screen layers hand the renderer a dirty rectangle instead of a whole 640×360 upload. The
 * rectangle must cover every pixel that changed: what is drawn now and what was drawn last time (cleared now); a layer that
 * was empty both times must not change version at all. (Render-only bookkeeping: the sim never reads it.)
 */
const view = { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H };

const drawn = (l: RenderLayer): number[] => {
  const out: number[] = [];
  for (let i = 0; i < l.pixels.length; i++) if (l.pixels[i]! >>> 24 !== 0) out.push(i);
  return out;
};
const inside = (i: number, d: { x0: number; y0: number; x1: number; y1: number }): boolean => {
  const x = i % LOGICAL_W;
  const y = (i / LOGICAL_W) | 0;
  return x >= d.x0 && x < d.x1 && y >= d.y0 && y < d.y1;
};

describe('matter screen layers: dirty rectangles', () => {
  it('cover what is drawn now and what was drawn before; untouched layers keep their version', () => {
    const world = createMatterWorld(3);
    const px = new Uint32Array(6 * 4).fill(rgba(200, 120, 60, 255));
    world.spawnChunk({ pixels: px, w: 6, h: 4, x: 320, y: 180, vx: 0, vy: 0, spin: 0, mass: 5 });
    const layers = world.renderLayers(view, 0).slice();
    const holder = layers.find((l) => drawn(l).length > 0)!;
    expect(holder).toBeDefined();
    const d0 = holder.dirty!;
    expect(d0).not.toBeNull();
    for (const i of drawn(holder)) expect(inside(i, d0)).toBe(true);
    // the rectangle is local, not the whole layer
    expect((d0.x1 - d0.x0) * (d0.y1 - d0.y0)).toBeLessThan(LOGICAL_W * LOGICAL_H * 0.05);
    const before = drawn(holder);
    const others = layers.filter((l) => l !== holder && drawn(l).length === 0);
    const otherVersions = others.map((l) => l.version);

    // the renderer consumed it; the view moves: the chunk is drawn elsewhere, and its old place must be in the rect
    holder.dirty = null;
    world.renderLayers({ ...view, x0: 40, y0: 20 }, 0);
    const d1 = holder.dirty!;
    expect(d1).not.toBeNull();
    for (const i of drawn(holder)) expect(inside(i, d1)).toBe(true);
    for (const i of before) expect(inside(i, d1)).toBe(true);
    others.forEach((l, k) => expect(l.version).toBe(otherVersions[k]));

    // not consumed (the layer was skipped): the next rect keeps the pending area too
    const pending = { ...d1 };
    world.renderLayers({ ...view, x0: -40, y0: -20 }, 0);
    const d2 = holder.dirty!;
    expect(d2.x0).toBeLessThanOrEqual(pending.x0);
    expect(d2.y0).toBeLessThanOrEqual(pending.y0);
    expect(d2.x1).toBeGreaterThanOrEqual(pending.x1);
    expect(d2.y1).toBeGreaterThanOrEqual(pending.y1);

    // the chunk leaves the frame: one more update clears its last place, then the layer is left alone
    holder.dirty = null;
    const last = drawn(holder);
    world.renderLayers({ ...view, x0: 5000, y0: 5000 }, 0);
    expect(drawn(holder)).toHaveLength(0);
    for (const i of last) expect(inside(i, holder.dirty!)).toBe(true);
    holder.dirty = null;
    const v = holder.version;
    world.renderLayers({ ...view, x0: 5000, y0: 5000 }, 0);
    expect(holder.version).toBe(v);
    expect(holder.dirty).toBeNull();
  });
});
