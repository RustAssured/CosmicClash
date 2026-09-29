import { describe, expect, it } from 'vitest';
import { layerBounds } from '../toolkit/stars';
import { MAX_SEGMENTS, layoutPillars, type LayoutOpts } from './pillars';
import { STAGE_INFO } from '../info';

const bounds = layerBounds(STAGE_INFO.nursery.arena, 0.58, 70);
const base: LayoutOpts = {
  bounds,
  seed: 733,
  columns: [
    { x: 400, top: 120, r: 46, lean: -20, fingers: 3 },
    { x: 700, top: 260, r: 30, lean: 12, fingers: 2 },
  ],
  spacing: 300,
  height: [330, 440],
  radius: [36, 52],
  fingers: [1, 3],
  lightDir: [-0.7, -0.7],
};

describe('pillar layout', () => {
  it('is deterministic for a seed and changes with it', () => {
    const a = layoutPillars(base);
    const b = layoutPillars(base);
    const c = layoutPillars({ ...base, seed: 734 });
    expect(a.count).toBe(b.count);
    expect(a.segA).toEqual(b.segA);
    expect(a.segB).toEqual(b.segB);
    expect(c.segA).not.toEqual(a.segA);
  });

  it('never exceeds the shader segment budget and every segment is finite with a positive radius', () => {
    const l = layoutPillars({ ...base, fingers: [3, 3], spacing: 120 });
    expect(l.count).toBeGreaterThan(20);
    expect(l.count).toBeLessThanOrEqual(MAX_SEGMENTS);
    for (let i = 0; i < l.count; i++) {
      for (const arr of [l.segA, l.segB]) {
        for (let k = 0; k < 3; k++) expect(Number.isFinite(arr[i * 4 + k]!)).toBe(true);
        expect(arr[i * 4 + 2]!).toBeGreaterThan(0);
      }
    }
  });

  it('honours hand-placed columns: their crowns land where the art direction put them', () => {
    const l = layoutPillars({ ...base, spacing: 100000 }); // no fillers
    // the two columns produce tips near their requested x (lean and fingers move them a bit)
    const near = (x: number): boolean => l.tips.some((t) => Math.abs(t.x - x) < 140);
    expect(near(400)).toBe(true);
    expect(near(700)).toBe(true);
    // and the highest crown belongs to the column with the smaller `top`
    const highest = l.tips.reduce((m, t) => (t.y < m.y ? t : m));
    expect(Math.abs(highest.x - 400)).toBeLessThan(200);
  });

  it('fills gaps with random pillars but never on top of a hand-placed one', () => {
    const l = layoutPillars(base);
    const bases: number[] = [];
    for (let i = 0; i < l.count; i++) {
      if (l.segA[i * 4 + 1]! > bounds.y1 + 20) bases.push(l.segA[i * 4]!);
    }
    for (const a of bases) for (const b of bases) if (a !== b) expect(Math.abs(a - b)).toBeGreaterThan(20);
    expect(bases.length).toBeGreaterThan(2);
  });

  it('exposes lit-edge points on the light-facing side and tips above the base', () => {
    const l = layoutPillars(base);
    expect(l.litEdge.length).toBeGreaterThan(5);
    expect(l.tips.length).toBeGreaterThan(3);
    for (const t of l.tips) expect(t.y).toBeLessThan(bounds.y1);
  });
});
