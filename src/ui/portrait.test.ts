import { describe, expect, it } from 'vitest';
import { rgba } from '@/contracts';
import { alphaBounds, samplePortrait, silhouette } from './portrait';

const solid = (w: number, h: number, x0: number, y0: number, x1: number, y1: number, c: number) => {
  const px = new Uint32Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[y * w + x] = c;
  return { pixels: px, w, h };
};
const count = (px: Uint32Array): number => px.reduce((a, c) => a + (c >>> 24 ? 1 : 0), 0);
const green = rgba(0, 200, 0);

describe('alphaBounds', () => {
  it('finds the tight box (x1/y1 exclusive) or null when empty', () => {
    const s = solid(20, 20, 4, 6, 12, 15, green);
    expect(alphaBounds(s.pixels, 20, 20)).toEqual({ x0: 4, y0: 6, x1: 12, y1: 15 });
    expect(alphaBounds(new Uint32Array(9), 3, 3)).toBeNull();
  });
});

describe('samplePortrait', () => {
  it('fits a cropped body into the target preserving aspect and centring it', () => {
    const s = solid(200, 200, 50, 80, 150, 120, green); // a 100×40 bar
    const out = samplePortrait(s, 50, 50, { crop: alphaBounds(s.pixels, 200, 200)! });
    const b = alphaBounds(out.pixels, 50, 50)!;
    expect(b.x1 - b.x0).toBe(50);
    expect(b.y1 - b.y0).toBeGreaterThanOrEqual(19);
    expect(b.y1 - b.y0).toBeLessThanOrEqual(21);
    expect(Math.abs((b.y0 + b.y1) / 2 - 25)).toBeLessThanOrEqual(1);
  });
  it('keeps colours (alpha-weighted mean of matter only)', () => {
    const s = solid(40, 40, 0, 0, 40, 40, green);
    const out = samplePortrait(s, 10, 10);
    expect(out.pixels[55]).toBe(green);
  });
  it('carved-away matter opens a visible hole in the thumbnail, and a tiny nick does not', () => {
    const s = solid(64, 64, 0, 0, 64, 64, green);
    for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) s.pixels[y * 64 + x] = 0; // big hole
    const holed = samplePortrait(s, 16, 16);
    expect(holed.pixels[8 * 16 + 8]! >>> 24).toBe(0);
    expect(holed.pixels[1 * 16 + 1]! >>> 24).toBe(255);
    const s2 = solid(64, 64, 0, 0, 64, 64, green);
    s2.pixels[30 * 64 + 30] = 0;
    const nicked = samplePortrait(s2, 16, 16);
    expect(count(nicked.pixels)).toBe(256);
  });
  it('flips horizontally and adds a 1px outline around the silhouette', () => {
    const s = solid(20, 10, 0, 0, 10, 10, green); // left half only
    const flipped = samplePortrait(s, 20, 10, { flipX: true });
    expect(flipped.pixels[5]! >>> 24).toBe(0);
    const out = samplePortrait(solid(20, 20, 4, 4, 16, 16, green), 20, 20, {
      outline: rgba(9, 9, 9),
      margin: 1,
    });
    const black = out.pixels.filter((c) => c === rgba(9, 9, 9)).length;
    expect(black).toBeGreaterThan(20);
  });
  it('reuses a destination sprite (no allocation) and clears it first', () => {
    const dst = { pixels: new Uint32Array(100), w: 10, h: 10 };
    dst.pixels.fill(0xffffffff);
    const out = samplePortrait(solid(40, 40, 0, 0, 5, 5, green), 10, 10, {}, dst);
    expect(out).toBe(dst);
    expect(dst.pixels[99]).toBe(0);
  });
  it('is a no-op on an empty crop', () => {
    const out = samplePortrait(solid(4, 4, 0, 0, 0, 0, green), 8, 8, {
      crop: { x0: 2, y0: 2, x1: 2, y1: 2 },
    });
    expect(count(out.pixels)).toBe(0);
  });
});

describe('silhouette', () => {
  it('flattens every solid pixel to one colour and leaves the void', () => {
    const s = solid(4, 4, 1, 1, 3, 3, green);
    const sil = silhouette(s, rgba(5, 5, 5, 80));
    expect(count(sil.pixels)).toBe(4);
    expect(sil.pixels[5]).toBe(rgba(5, 5, 5, 80));
  });
});
