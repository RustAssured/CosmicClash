import { describe, expect, it } from 'vitest';
import { LOGICAL_H, LOGICAL_W, type DamageEvent, type RenderLayer } from '@/contracts';
import { createMatterWorld, type MatterWorldEx } from './index';
import { layeredDisc } from './testing/bodies';

/**
 * Aftermath support (D28 task 6, with S5): a frozen world renders from any view without changing the simulation, and the
 * supersampled export path draws the same debris at k× resolution.
 */

const blow = (type: DamageEvent['type'], x: number, y: number): DamageEvent => ({
  type,
  shape: { kind: 'point', x, y, r: 10 },
  energy: 900,
  dirX: 1,
  dirY: -0.2,
  duration: 1,
  sourceMass: 6,
  sourceBodyId: -1,
  originX: x - 50,
  originY: y,
  flags: 0,
  params: { compress: 8 },
});

function fought(): MatterWorldEx {
  const world = createMatterWorld(21);
  const id = world.createBody(layeredDisc({ size: 44, seed: 4, x: 320, y: 190 }).spec).id;
  (['KINETIC', 'CRUSH', 'FRACTURE', 'KINETIC'] as const).forEach((t, k) => {
    world.applyDamage(id, blow(t, 278 + k * 2, 180 + k * 8));
    for (let i = 0; i < 25; i++) world.tick();
  });
  return world;
}

const opaque = (ls: RenderLayer[]): number => {
  let n = 0;
  for (const l of ls) for (let i = 0; i < l.pixels.length; i++) if (l.pixels[i]! >>> 24 !== 0) n++;
  return n;
};
const copy = (ls: RenderLayer[]): Uint32Array[] => ls.map((l) => l.pixels.slice());

describe('aftermath', () => {
  it('rendering a frozen world from any view never changes the simulation, and a view renders the same every time', () => {
    const world = fought();
    const h0 = world.hash();
    const home = { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H };
    const a = copy(world.renderLayers(home, 0));
    for (const v of [
      { x0: 120, y0: -40, w: LOGICAL_W, h: LOGICAL_H },
      { x0: -200, y0: 60, w: LOGICAL_W, h: LOGICAL_H },
    ]) {
      world.renderLayers(v, 0);
      world.renderExport(v, 2);
    }
    const b = copy(world.renderLayers(home, 0));
    expect(world.hash()).toBe(h0);
    for (let k = 0; k < a.length; k++) expect(b[k]).toEqual(a[k]);
    expect(opaque(world.renderLayers(home, 0))).toBeGreaterThan(50);
  });

  it('export at k = 1 is the frame; at k = 3 it is the same debris at 3x resolution', () => {
    const world = fought();
    const view = { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H };
    const frame = copy(world.renderLayers(view, 0));
    const one = world.renderExport(view, 1);
    for (let k = 0; k < frame.length; k++) expect(one[k]!.pixels).toEqual(frame[k]);
    const three = world.renderExport(view, 3);
    expect(three[0]!.w).toBe(LOGICAL_W * 3);
    expect(three[0]!.h).toBe(LOGICAL_H * 3);
    const ratio = opaque(three) / opaque(one);
    expect(ratio).toBeGreaterThan(9 * 0.75);
    expect(ratio).toBeLessThan(9 * 1.25);
  });
});
