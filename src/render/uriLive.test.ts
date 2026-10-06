import { describe, expect, it } from 'vitest';
import { URI_LOOP_REST, coreSurface, h3, n3, uriLoopPixels, type UriLiveFx } from './uriLive';

const fx = (over: Partial<UriLiveFx> = {}): UriLiveFx => ({
  hotX: 346.7,
  hotY: 171,
  coldX: 301.7,
  coldY: 134.3,
  hotR: 36,
  coldR: 19,
  t: 3,
  spin: 0.75,
  hp: 100,
  loop: URI_LOOP_REST,
  afterZ: 7,
  ...over,
});

describe("우리's live elements (the oracle's cores, loop and orbit)", () => {
  it("ports the oracle's hash and value noise exactly", () => {
    // h3 is the oracle's integer hash: deterministic, in [0, 1]
    expect(h3(1, 2, 3)).toBe(h3(1, 2, 3));
    for (let i = 0; i < 50; i++) {
      const v = n3(i * 0.37, i * 0.11, 2.5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // value noise interpolates the lattice: at integer points it IS the hash
    expect(n3(3, 4, 5)).toBeCloseTo(h3(3, 4, 5), 12);
  });

  it('builds the core surfaces at the oracle size (TW = round(2πR), TH = 2R), two materials', () => {
    const s = coreSurface(36, true);
    expect(s.w).toBe(Math.round(Math.PI * 2 * 36));
    expect(s.h).toBe(72);
    const mats = new Set<number>();
    for (let i = 0; i < s.w * s.h; i++) mats.add(s.data[i * 4]!);
    expect([...mats].sort()).toEqual([1, 2]);
  });

  it('draws the loop and the orbit: both halves, the white-hot crossing, a second row at full integrity', () => {
    const back = new Float32Array(4096 * 5);
    const front = new Float32Array(4096 * 5);
    const n = uriLoopPixels(fx(), 0, 0, back, front);
    expect(n.back).toBeGreaterThan(300);
    expect(n.front).toBeGreaterThan(300);
    let white = 0;
    for (let i = 0; i < n.front; i++)
      if (front[i * 5 + 2] === 255 && front[i * 5 + 3] === 255 && front[i * 5 + 4] === 255) white++;
    expect(white).toBeGreaterThan(0);
    // integer screen pixels
    for (let i = 0; i < n.back; i++) expect(Number.isInteger(back[i * 5])).toBe(true);
    // below 40 integrity the second row goes, and past 60 % damage the loop starts to break up
    const hurt = uriLoopPixels(fx({ hp: 20 }), 0, 0, back, front);
    expect(hurt.back + hurt.front).toBeLessThan((n.back + n.front) / 2);
  });
});
