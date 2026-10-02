import { describe, expect, it } from 'vitest';
import {
  ANGLE_STEPS,
  ROT_LUT,
  ROT_ONE,
  angleToStep,
  rotBounds,
  rotRaster,
  rotSample,
  rotRasterAt,
  rotSampleAt,
  type RotPart,
} from './rotsprite';

/** An asymmetric test part: a 40×56 rectangle body with a notch, a hole and a 2-colour stripe, pivot off-centre. */
function testPart(step: number): RotPart {
  const w = 40;
  const h = 56;
  const pixels = new Uint32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const notch = x > 28 && y < 12;
      const hole = (x - 14) ** 2 + (y - 30) ** 2 < 25;
      if (notch || hole) continue;
      pixels[y * w + x] = (y >> 2) & 1 ? 0xff3060c0 : 0xff20a0e0;
    }
  return { pixels, w, h, px: 12, py: 40, step };
}

const solidRect = (w: number, h: number, step: number): RotPart => ({
  pixels: new Uint32Array(w * h).fill(0xff808080),
  w,
  h,
  px: Math.floor(w / 2),
  py: Math.floor(h / 2),
  step,
});

describe('rotsprite (clean-edge rotation, CPU twin of the GPU sampler)', () => {
  it('the LUT is Q14, exact at the quadrants and unit length everywhere', () => {
    expect(ROT_LUT.cos.length).toBe(ANGLE_STEPS);
    for (let i = 0; i < ANGLE_STEPS; i++) {
      const c = ROT_LUT.cos[i]! / ROT_ONE;
      const s = ROT_LUT.sin[i]! / ROT_ONE;
      expect(Math.abs(c * c + s * s - 1)).toBeLessThan(2e-4);
    }
    expect([ROT_LUT.cos[64], ROT_LUT.sin[64]]).toEqual([0, ROT_ONE]);
    expect(angleToStep(Math.PI / 2)).toBe(64);
    expect(angleToStep(-Math.PI / 2)).toBe(192);
  });

  it('angle 0 reproduces the source exactly; 90° steps are exact transposes', () => {
    const p0 = testPart(0);
    for (let y = 0; y < p0.h; y++)
      for (let x = 0; x < p0.w; x++)
        expect(rotSample(p0, x - p0.px, y - p0.py)).toBe(p0.pixels[y * p0.w + x]! >>> 0);
    const p90 = testPart(64);
    // clockwise by 90° about the pivot corner: source (x, y) lands at destination (−(y − py) − 1, x − px)
    for (let y = 0; y < p90.h; y++)
      for (let x = 0; x < p90.w; x++)
        expect(rotSample(p90, -(y - p90.py) - 1, x - p90.px)).toBe(p90.pixels[y * p90.w + x]! >>> 0);
  });

  it('never invents a colour, at every quantised angle', () => {
    const allowed = new Set([0, 0xff3060c0, 0xff20a0e0]);
    for (let step = 0; step < ANGLE_STEPS; step += 3) {
      const r = rotRaster(testPart(step));
      let bad = 0;
      for (const c of r.pixels) if (!allowed.has(c >>> 0)) bad++;
      expect(bad, `step ${step}`).toBe(0);
    }
  });

  it('keeps the area (± 3 %) and the silhouette within 1 px of the exact rotated rectangle at every angle', () => {
    const w = 33;
    const h = 51;
    for (let step = 0; step < ANGLE_STEPS; step++) {
      const part = solidRect(w, h, step);
      const r = rotRaster(part);
      const th = (2 * Math.PI * step) / ANGLE_STEPS;
      const c = Math.cos(th);
      const s = Math.sin(th);
      let area = 0;
      let off = 0;
      for (let y = 0; y < r.h; y++)
        for (let x = 0; x < r.w; x++) {
          const on = r.pixels[y * r.w + x] !== 0;
          if (on) area++;
          // the pixel centre mapped back exactly into source space: inside the rectangle?
          const dx = x - r.ox + 0.5;
          const dy = y - r.oy + 0.5;
          const sx = c * dx + s * dy + part.px;
          const sy = -s * dx + c * dy + part.py;
          const inside = sx >= 0 && sy >= 0 && sx <= w && sy <= h;
          if (on !== inside) {
            // a disagreement is allowed only within 1 px of the true edge
            const edge = Math.min(Math.abs(sx), Math.abs(sy), Math.abs(sx - w), Math.abs(sy - h));
            expect(edge, `step ${step} pixel ${x},${y}`).toBeLessThanOrEqual(1);
            off++;
          }
        }
      expect(Math.abs(area - w * h) / (w * h)).toBeLessThan(0.03);
      expect(off).toBeLessThan(2 * (w + h)); // only boundary pixels can disagree
    }
  });

  it('rotBounds always contains every drawn pixel', () => {
    for (let step = 0; step < ANGLE_STEPS; step += 7) {
      const part = testPart(step);
      const b = rotBounds(part);
      for (let y = b.y0 - 3; y < b.y1 + 3; y++)
        for (let x = b.x0 - 3; x < b.x1 + 3; x++) {
          if (x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1) continue;
          expect(rotSample(part, x, y)).toBe(0);
        }
    }
  });
});

describe('proposal 161: alpha-first vote and mirroring (rotSampleAt, the twin of the compositor shader)', () => {
  it('coverage never depends on colour: recolouring a body cannot change which pixels are drawn (or hit)', () => {
    for (let step = 0; step < ANGLE_STEPS; step += 5) {
      const a = testPart(step);
      const b = { ...a, pixels: a.pixels.slice() };
      // a "crack": recolour a scatter of opaque pixels
      for (let i = 0; i < b.pixels.length; i += 7) if (b.pixels[i]! >>> 24) b.pixels[i] = 0xff101820;
      const ra = rotRasterAt(a);
      const rb = rotRasterAt(b);
      let diff = 0;
      for (let i = 0; i < ra.pixels.length; i++) if ((ra.pixels[i] !== 0) !== (rb.pixels[i] !== 0)) diff++;
      expect(diff, `step ${step}`).toBe(0);
    }
  });

  it('a one-colour part draws exactly the coverage of the colour-majority sampler', () => {
    for (let step = 0; step < ANGLE_STEPS; step += 3) {
      const p = solidRect(33, 51, step);
      const ref = rotRaster(p);
      const got = rotRasterAt(p);
      expect(got.w).toBe(ref.w);
      expect([...got.pixels]).toEqual([...ref.pixels]);
    }
  });

  it('facing −1 mirrors about the pivot corner: at angle 0 it is the exact mirror of the source', () => {
    const p = { ...testPart(0), facing: -1 as const };
    for (let y = 0; y < p.h; y++)
      for (let x = 0; x < p.w; x++)
        expect(rotSampleAt(p, -(x - p.px) - 1, y - p.py)).toBe(p.pixels[y * p.w + x]! >>> 0);
  });

  it('never invents a colour, mirrored or not', () => {
    const allowed = new Set([0, 0xff3060c0, 0xff20a0e0]);
    for (let step = 0; step < ANGLE_STEPS; step += 9)
      for (const facing of [1, -1] as const) {
        const r = rotRasterAt({ ...testPart(step), facing });
        let bad = 0;
        for (const c of r.pixels) if (!allowed.has(c >>> 0)) bad++;
        expect(bad).toBe(0);
      }
  });
});
