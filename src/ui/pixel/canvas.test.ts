import { describe, expect, it } from 'vitest';
import { rgba } from '@/contracts';
import { BAYER4, PixelCanvas, over, setAlpha, withAlpha } from './canvas';

const red = rgba(255, 0, 0);
const blue = rgba(0, 0, 255);

describe('over (source-over)', () => {
  it('opaque source wins, transparent source keeps the destination', () => {
    expect(over(red, blue)).toBe(red);
    expect(over(0, blue)).toBe(blue);
  });
  it('blends 50% red over opaque blue to purple, alpha 255', () => {
    const c = over(rgba(255, 0, 0, 128), blue);
    expect(c & 255).toBeGreaterThan(120);
    expect(c & 255).toBeLessThan(135);
    expect((c >>> 16) & 255).toBeGreaterThan(120);
    expect(c >>> 24).toBe(255);
  });
  it('over a transparent destination keeps the source (incl. its alpha)', () => {
    const s = rgba(10, 20, 30, 100);
    expect(over(s, 0)).toBe(s);
  });
  it('alpha helpers', () => {
    expect(withAlpha(red, 0.5) >>> 24).toBe(128);
    expect(setAlpha(red, 10) >>> 24).toBe(10);
  });
});

describe('PixelCanvas', () => {
  it('rect clips to the canvas and to the clip stack', () => {
    const cv = new PixelCanvas(10, 10);
    cv.rect(-5, -5, 30, 30, red);
    expect(cv.pixels.every((p) => p === red)).toBe(true);
    cv.clear();
    cv.pushClip(2, 2, 3, 3);
    cv.rect(0, 0, 10, 10, blue);
    let n = 0;
    for (const p of cv.pixels) if (p) n++;
    expect(n).toBe(9);
    cv.popClip();
    cv.rect(0, 0, 1, 1, red);
    expect(cv.get(0, 0)).toBe(red);
  });
  it('frame and corners draw only edge pixels', () => {
    const cv = new PixelCanvas(10, 10);
    cv.frame(1, 1, 8, 8, red);
    expect(cv.get(1, 1)).toBe(red);
    expect(cv.get(4, 4)).toBe(0);
    let n = 0;
    for (const p of cv.pixels) if (p) n++;
    expect(n).toBe(28);
    cv.clear();
    cv.corners(0, 0, 10, 10, red, 3);
    expect(cv.get(2, 0)).toBe(red);
    expect(cv.get(5, 0)).toBe(0);
  });
  it('line draws a connected Bresenham line including both endpoints', () => {
    const cv = new PixelCanvas(20, 20);
    cv.line(1, 1, 15, 8, red);
    expect(cv.get(1, 1)).toBe(red);
    expect(cv.get(15, 8)).toBe(red);
    let n = 0;
    for (const p of cv.pixels) if (p) n++;
    expect(n).toBe(15);
  });
  it('dither covers exactly level/16 of a 4×4 block, and 0 or 16 cover none or all', () => {
    for (const level of [0, 4, 8, 12, 16]) {
      const cv = new PixelCanvas(4, 4);
      cv.dither(0, 0, 4, 4, red, level);
      let n = 0;
      for (const p of cv.pixels) if (p) n++;
      expect(n).toBe(level);
    }
    expect([...BAYER4].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i));
  });
  it('gradientV runs from the first ramp colour to the last using only ramp colours', () => {
    const cv = new PixelCanvas(8, 32);
    const ramp = [rgba(0, 0, 0), rgba(100, 0, 0), rgba(200, 0, 0)];
    cv.gradientV(0, 0, 8, 32, ramp);
    const used = new Set(cv.pixels);
    for (const c of used) expect(ramp).toContain(c);
    expect(cv.get(0, 0)).toBe(ramp[0]);
    expect(cv.get(1, 31)).toBe(ramp[2]);
  });
  it('blit supports flip, scale, alpha, silhouette and grey', () => {
    const s = { pixels: Uint32Array.from([red, 0, 0, blue]), w: 2, h: 2 };
    const cv = new PixelCanvas(6, 6);
    cv.blit(s, 0, 0);
    expect(cv.get(0, 0)).toBe(red);
    expect(cv.get(1, 1)).toBe(blue);
    expect(cv.get(1, 0)).toBe(0);
    cv.clear();
    cv.blit(s, 0, 0, { flipX: true });
    expect(cv.get(1, 0)).toBe(red);
    cv.clear();
    cv.blit(s, 0, 0, { scale: 2 });
    expect(cv.get(1, 1)).toBe(red);
    expect(cv.get(2, 2)).toBe(blue);
    expect(cv.get(3, 3)).toBe(blue);
    cv.clear();
    cv.blit(s, 0, 0, { alpha: 0.5 });
    expect(cv.get(0, 0) >>> 24).toBe(128);
    cv.clear();
    cv.blit(s, 0, 0, { silhouette: rgba(1, 2, 3) });
    expect(cv.get(0, 0) & 0xffffff).toBe(rgba(1, 2, 3) & 0xffffff);
    cv.clear();
    cv.blit(s, 0, 0, { grey: 1 });
    const g = cv.get(0, 0);
    expect(Math.abs((g & 255) - ((g >>> 8) & 255))).toBeLessThan(40);
  });
  it('px outside the canvas is a no-op and never throws', () => {
    const cv = new PixelCanvas(4, 4);
    expect(() => {
      cv.px(-1, 0, red);
      cv.px(4, 4, red);
      cv.put(99, 99, red);
    }).not.toThrow();
    expect(cv.get(-1, -1)).toBe(0);
  });
});
