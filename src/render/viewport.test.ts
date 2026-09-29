import { describe, expect, it } from 'vitest';
import { computeViewport, physicalToLogical } from './viewport';

describe('computeViewport', () => {
  it('picks the largest integer scale and centres the letterbox', () => {
    const v = computeViewport(1280, 720);
    expect(v).toMatchObject({ scale: 2, x: 0, y: 0, w: 1280, h: 720 });
    const w = computeViewport(1920, 1080);
    expect(w.scale).toBe(3);
    const u = computeViewport(1900, 1000); // limited by height: 1000/360 = 2.77
    expect(u.scale).toBe(2);
    expect(u.x).toBe(Math.floor((1900 - 1280) / 2));
    expect(u.y).toBe(Math.floor((1000 - 720) / 2));
  });

  it('never goes below scale 1, even for tiny canvases (frame is then clipped, offsets negative)', () => {
    const v = computeViewport(400, 200);
    expect(v.scale).toBe(1);
    expect(v.x).toBeLessThan(0);
  });

  it('is exact at the boundaries (no float error at 3x)', () => {
    expect(computeViewport(1920, 1080).scale).toBe(3);
    expect(computeViewport(1919, 1080).scale).toBe(2);
    expect(computeViewport(640, 360).scale).toBe(1);
  });

  it('supports fractional fit when integer scaling is disabled', () => {
    const v = computeViewport(1000, 720, false);
    expect(v.scale).toBeCloseTo(1000 / 640, 6);
  });

  it('maps physical to logical coordinates', () => {
    const v = computeViewport(1900, 1000);
    const o = { x: 0, y: 0 };
    physicalToLogical(v, v.x + 2 * 100, v.y + 2 * 50, o);
    expect(o).toEqual({ x: 100, y: 50 });
  });
});
