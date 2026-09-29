import { describe, expect, it } from 'vitest';
import { Rng, type BodyTransform, type ViewRect } from '@/contracts';
import { contractCell, makePlacement, placeLayer, snapInterp, sourceCell, TELEPORT_PX } from './layerMap';

const view: ViewRect = { x0: 300, y0: 100, w: 640, h: 360 };

function layerFor(t: BodyTransform, w: number, h: number) {
  return {
    space: 'world' as const,
    x: t.x,
    y: t.y,
    prevX: t.x,
    prevY: t.y,
    anchorX: t.anchorX,
    anchorY: t.anchorY,
    facing: t.facing,
    lean: t.lean,
    w,
    h,
  };
}

describe('layer placement + source-cell mapping', () => {
  it('matches the contract (space.ts worldToLocal + leanShift) for every pixel over random transforms', () => {
    const rng = new Rng(4242);
    const p = makePlacement();
    const got = { x: 0, y: 0 };
    const want = { x: 0, y: 0 };
    let checked = 0;
    let mismatches = 0;
    for (let trial = 0; trial < 120; trial++) {
      const w = rng.intRange(20, 150);
      const h = rng.intRange(20, 150);
      const t: BodyTransform = {
        x: rng.intRange(320, 1200),
        y: rng.intRange(150, 450),
        anchorX: rng.intRange(0, w),
        anchorY: rng.intRange(0, h),
        facing: rng.chance(0.5) ? 1 : -1,
        lean: rng.intRange(-14, 14),
      };
      placeLayer(layerFor(t, w, h), view, 0, p);
      // the renderer places the anchor at the integer world position, so the contract is evaluated with the same integers
      const tw: BodyTransform = { ...t, x: p.ax + view.x0, y: p.ay + view.y0 };
      for (let py = p.y0 - 2; py < p.y1 + 2; py++) {
        for (let px = p.x0 - 2; px < p.x1 + 2; px++) {
          const hit = sourceCell(p, px, py, got);
          contractCell(tw, px + view.x0, py + view.y0, want);
          const inside = want.x >= 0 && want.x < w && want.y >= 0 && want.y < h;
          if (hit !== inside || (inside && (got.x !== want.x || got.y !== want.y))) mismatches++;
          checked++;
        }
      }
    }
    expect(mismatches).toBe(0);
    expect(checked).toBeGreaterThan(100_000);
  });

  it('the destination rectangle covers every pixel that maps to the sprite (no clipped shear)', () => {
    const rng = new Rng(7);
    const p = makePlacement();
    const cell = { x: 0, y: 0 };
    let outside = 0;
    for (let trial = 0; trial < 60; trial++) {
      const w = rng.intRange(30, 120);
      const h = rng.intRange(30, 120);
      const t: BodyTransform = {
        x: 600,
        y: 300,
        anchorX: rng.intRange(0, w),
        anchorY: rng.intRange(1, h),
        facing: rng.chance(0.5) ? 1 : -1,
        lean: rng.intRange(-20, 20),
      };
      placeLayer(layerFor(t, w, h), view, 0, p);
      for (let py = -20; py < 400; py++)
        for (let px = -20; px < 700; px++)
          if (sourceCell(p, px, py, cell) && (px < p.x0 || px >= p.x1 || py < p.y0 || py >= p.y1)) outside++;
    }
    expect(outside).toBe(0);
  });

  it('lean shears rows by leanShift: zero at the anchor row, opposite sign above and below', () => {
    const p = makePlacement();
    const t: BodyTransform = { x: 600, y: 300, anchorX: 40, anchorY: 40, facing: 1, lean: 8 };
    placeLayer(layerFor(t, 80, 80), view, 0, p);
    const c = { x: 0, y: 0 };
    // the sprite's centre column, traced through each row
    const colAtRow = (row: number): number => {
      for (let px = p.x0; px < p.x1; px++)
        if (sourceCell(p, px, p.ay + row - 40, c) && c.x === 40) return px - p.ax;
      return NaN;
    };
    expect(colAtRow(40)).toBe(0); // anchor row: no shift
    expect(colAtRow(0)).toBe(8); // top leans toward +x world
    expect(colAtRow(79)).toBeLessThan(0); // rows below the anchor shear the other way
  });

  it('facing -1 mirrors around the anchor without shifting the anchor pixel', () => {
    const p1 = makePlacement();
    const p2 = makePlacement();
    const base: BodyTransform = { x: 600, y: 300, anchorX: 30, anchorY: 30, facing: 1, lean: 0 };
    placeLayer(layerFor(base, 90, 60), view, 0, p1);
    placeLayer(layerFor({ ...base, facing: -1 }, 90, 60), view, 0, p2);
    const c = { x: 0, y: 0 };
    // anchor cell (30,30) draws at the pixel right of the anchor in both cases relative mirror rules
    expect(sourceCell(p1, p1.ax, p1.ay, c)).toBe(true);
    expect(c.x).toBe(30);
    expect(sourceCell(p2, p2.ax - 1, p2.ay, c)).toBe(true);
    expect(c.x).toBe(30);
    // a cell far to the right in the sprite appears on the LEFT when mirrored
    sourceCell(p2, p2.ax - 40, p2.ay, c);
    expect(c.x).toBe(30 + 39);
  });

  it('screen layers map 1:1', () => {
    const p = makePlacement();
    placeLayer(
      { ...layerFor({ x: 0, y: 0, anchorX: 0, anchorY: 0, facing: 1, lean: 0 }, 640, 360), space: 'screen' },
      view,
      0,
      p,
    );
    const c = { x: 0, y: 0 };
    expect(sourceCell(p, 123, 45, c)).toBe(true);
    expect(c).toEqual({ x: 123, y: 45 });
    expect(sourceCell(p, 640, 0, c)).toBe(false);
    expect(sourceCell(p, -1, 0, c)).toBe(false);
  });

  it('snaps interpolated positions to integers and does not slide across teleports', () => {
    expect(snapInterp(10, 20, 0.5)).toBe(15);
    expect(Number.isInteger(snapInterp(10.2, 20.9, 0.37))).toBe(true);
    expect(snapInterp(0, 1000, 0.5)).toBe(1000);
    expect(snapInterp(1000, 0, 0.5)).toBe(0);
    expect(snapInterp(0, TELEPORT_PX, 0.5)).toBe(TELEPORT_PX / 2);
  });
});
