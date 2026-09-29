import { describe, expect, it } from 'vitest';
import { STAGE_IDS } from '@/contracts';
import { STAGES } from '@/stages';
import { STAGE_RAMPS } from '@/stages/info';
import { bayerRanks, bayerTexels, bayerThreshold, ditherQuantise } from './dither';
import {
  CROSS_RAMP_MAX,
  PALETTE_TEX_W,
  buildDitherLut,
  ditherToIndex,
  linearToOklab,
  linearToSrgb,
  lutNode,
  paletteTextures,
  preparePalette,
  srgbToLinear,
} from './palette';

const lab = (r: number, g: number, b: number): number[] => {
  const o = [0, 0, 0];
  linearToOklab(r, g, b, o, 0);
  return o;
};
const dist = (a: number[], b: number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

describe('colour maths', () => {
  it('sRGB transfer functions round-trip', () => {
    for (let v = 0; v <= 1; v += 0.05) expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6);
    expect(srgbToLinear(1)).toBeCloseTo(1, 9);
    expect(srgbToLinear(0)).toBe(0);
  });

  it('OKLab: white is L=1 with no chroma, black is 0, and L is monotonic in grey', () => {
    const w = lab(1, 1, 1);
    expect(w[0]).toBeCloseTo(1, 3);
    expect(Math.abs(w[1]!)).toBeLessThan(1e-3);
    expect(Math.abs(w[2]!)).toBeLessThan(1e-3);
    expect(lab(0, 0, 0)[0]).toBe(0);
    let prev = -1;
    for (let v = 0; v <= 1; v += 0.1) {
      const l = lab(v, v, v)[0]!;
      expect(l).toBeGreaterThan(prev);
      prev = l;
    }
  });
});

describe('bayer matrices', () => {
  it.each([2, 4, 8, 16])('%i×%i uses every rank exactly once', (n) => {
    const r = bayerRanks(n);
    expect([...r].sort((a, b) => a - b)).toEqual(Array.from({ length: n * n }, (_, i) => i));
  });

  it('matches the classic 4×4 Bayer matrix and tiles', () => {
    const r = bayerRanks(4);
    expect([...r]).toEqual([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
    expect(bayerThreshold(r, 4, 5, 6)).toBe(bayerThreshold(r, 4, 1, 2));
  });

  it('thresholds lie strictly inside (0,1) and average 0.5', () => {
    const r = bayerRanks(8);
    let sum = 0;
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const t = bayerThreshold(r, 8, x, y);
        expect(t).toBeGreaterThan(0);
        expect(t).toBeLessThan(1);
        sum += t;
      }
    expect(sum / 64).toBeCloseTo(0.5, 9);
  });

  it('8-bit texels are monotonic in rank and within a byte', () => {
    const t = bayerTexels(8);
    const r = bayerRanks(8);
    const byRank = [...r.keys()].sort((a, b) => r[a]! - r[b]!);
    for (let i = 1; i < byRank.length; i++) expect(t[byRank[i]!]!).toBeGreaterThanOrEqual(t[byRank[i - 1]!]!);
    expect(Math.max(...t)).toBeLessThanOrEqual(255);
  });

  it('rejects non power-of-two sizes', () => {
    expect(() => bayerRanks(6)).toThrow();
  });

  it('ditherQuantise stays within one level and preserves the mean', () => {
    const r = bayerRanks(8);
    for (const v of [0, 0.13, 0.5, 0.77, 1]) {
      let sum = 0;
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const q = ditherQuantise(v, 8, bayerThreshold(r, 8, x, y));
          expect(Math.abs(q - v)).toBeLessThanOrEqual(1 / 8 + 1e-9);
          sum += q;
        }
      expect(sum / 64).toBeCloseTo(v, 1);
    }
  });
});

describe('palette + dither LUT', () => {
  const pal = preparePalette(STAGES.nursery.palette, STAGE_RAMPS.nursery);
  const lut = buildDitherLut(pal);
  const bayer = bayerRanks(8);

  /** Dither a flat colour over one Bayer tile; returns palette index → pixel count. */
  const tile = (lr: number, lg: number, lb: number): Map<number, number> => {
    const m = new Map<number, number>();
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const i = ditherToIndex(pal, lut, lr, lg, lb, bayerThreshold(bayer, 8, x, y));
        m.set(i, (m.get(i) ?? 0) + 1);
      }
    return m;
  };

  it('builds deterministically and quickly', () => {
    const t0 = performance.now();
    const again = buildDitherLut(pal);
    const ms = performance.now() - t0;
    expect(Buffer.from(again.data).equals(Buffer.from(lut.data))).toBe(true);
    expect(ms).toBeLessThan(4000); // ~70 ms unloaded; generous so a busy CI box does not flake
  });

  it('every LUT entry references valid palette indices with a ratio byte', () => {
    let invalid = 0;
    for (let i = 0; i < lut.data.length; i += 4)
      if (lut.data[i]! >= pal.count || lut.data[i + 1]! >= pal.count) invalid++;
    expect(invalid).toBe(0);
  });

  it('an exact palette colour is reproduced (its tile averages to within a hair of itself)', () => {
    const lut48 = buildDitherLut(pal, { size: 48 });
    let worst = 0;
    for (let i = 0; i < pal.count; i++) {
      const tl = pal.linear.subarray(i * 3, i * 3 + 3);
      const m = new Map<number, number>();
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const k = ditherToIndex(pal, lut48, tl[0]!, tl[1]!, tl[2]!, bayerThreshold(bayer, 8, x, y));
          m.set(k, (m.get(k) ?? 0) + 1);
        }
      const avg = [0, 0, 0];
      for (const [idx, c] of m) for (let k = 0; k < 3; k++) avg[k] += (pal.linear[idx * 3 + k]! * c) / 64;
      worst = Math.max(worst, dist(lab(avg[0]!, avg[1]!, avg[2]!), lab(tl[0]!, tl[1]!, tl[2]!)));
    }
    expect(worst).toBeLessThan(0.03);
  });

  it('midway between two adjacent palette colours the tile is a mix of exactly those two', () => {
    const pairs: [number, number][] = [
      [10, 11],
      [16, 17],
      [23, 24],
    ];
    for (const [a, b] of pairs) {
      const m = tile(
        (pal.linear[a * 3]! + pal.linear[b * 3]!) / 2,
        (pal.linear[a * 3 + 1]! + pal.linear[b * 3 + 1]!) / 2,
        (pal.linear[a * 3 + 2]! + pal.linear[b * 3 + 2]!) / 2,
      );
      const keys = [...m.keys()];
      expect(keys.length).toBeLessThanOrEqual(3);
      const ca = m.get(a) ?? 0;
      const cb = m.get(b) ?? 0;
      expect(ca + cb).toBeGreaterThanOrEqual(56);
      expect(Math.abs(ca - cb)).toBeLessThanOrEqual(24);
    }
  });

  it('the dithered tile reproduces the input colour (in linear light) better than nearest-colour quantisation', () => {
    let ditherErr = 0;
    let nearestErr = 0;
    let n = 0;
    for (let a = 0; a < pal.count - 1; a += 2) {
      for (const t of [0.3, 0.5, 0.7]) {
        const b = a + 1;
        const target = [0, 1, 2].map((k) => pal.linear[a * 3 + k]! * (1 - t) + pal.linear[b * 3 + k]! * t);
        const m = tile(target[0]!, target[1]!, target[2]!);
        const avg = [0, 0, 0];
        for (const [idx, c] of m) for (let k = 0; k < 3; k++) avg[k] += (pal.linear[idx * 3 + k]! * c) / 64;
        ditherErr += dist(lab(avg[0]!, avg[1]!, avg[2]!), lab(target[0]!, target[1]!, target[2]!));
        let best = Infinity;
        for (let i = 0; i < pal.count; i++)
          best = Math.min(
            best,
            dist(
              [pal.lab[i * 3]!, pal.lab[i * 3 + 1]!, pal.lab[i * 3 + 2]!],
              lab(target[0]!, target[1]!, target[2]!),
            ),
          );
        nearestErr += best;
        n++;
      }
    }
    expect(ditherErr / n).toBeLessThan(nearestErr / n);
  });

  it('only mixes neighbouring steps of one ramp (or near-identical colours): clean ramps, never confetti', () => {
    const ramps = STAGE_RAMPS.nursery;
    expect(pal.rampOf[pal.count - 1]).toBe(ramps.length - 1);
    let mixed = 0;
    let cross = 0;
    for (let i = 0; i < lut.data.length; i += 4) {
      const a = lut.data[i]!;
      const b = lut.data[i + 1]!;
      if (a === b) continue;
      mixed++;
      if (pal.rampOf[a] === pal.rampOf[b]) {
        expect(Math.abs(a - b)).toBe(1);
      } else {
        cross++;
        const d = Math.hypot(
          pal.lab[a * 3]! - pal.lab[b * 3]!,
          pal.lab[a * 3 + 1]! - pal.lab[b * 3 + 1]!,
          pal.lab[a * 3 + 2]! - pal.lab[b * 3 + 2]!,
        );
        expect(d).toBeLessThanOrEqual(CROSS_RAMP_MAX + 1e-6);
      }
    }
    expect(mixed).toBeGreaterThan(1000);
    expect(cross).toBeLessThan(mixed);
  });

  it('infers ramps from lightness drops when boundaries are not given', () => {
    const inferred = preparePalette(STAGES.nursery.palette);
    expect(Array.from(inferred.rampOf)).toEqual(Array.from(pal.rampOf));
  });

  it('lutNode agrees with the shader convention at the corners', () => {
    expect(lutNode(32, 0, 0, 0)).toBe(0);
    expect(lutNode(32, 1, 1, 1)).toBe((31 * 32 * 32 + 31 * 32 + 31) * 4);
    expect(lutNode(32, 1, 0, 0)).toBe(31 * 4);
    expect(lutNode(32, 0, 1, 0)).toBe(31 * 32 * 4);
  });

  it('paletteTextures pads to the fixed texture width with the last colour', () => {
    const t = paletteTextures(pal);
    expect(t.srgb8.length).toBe(PALETTE_TEX_W * 4);
    expect(t.linear32.length).toBe(PALETTE_TEX_W * 4);
    const last = pal.count - 1;
    expect(t.srgb8[(PALETTE_TEX_W - 1) * 4]).toBe(pal.srgb[last * 3]);
    expect(t.srgb8[3]).toBe(255);
  });

  it('every stage palette builds', () => {
    for (const id of STAGE_IDS) {
      const p = preparePalette(STAGES[id].palette);
      const l = buildDitherLut(p, { size: 8 });
      expect(l.data.length).toBe(8 * 8 * 8 * 4);
    }
  });

  it('rejects palettes that are too small or too large', () => {
    expect(() => preparePalette(['#000000'])).toThrow();
    expect(() =>
      preparePalette(Array.from({ length: 65 }, (_, i) => `#${(i * 3).toString(16).padStart(2, '0')}0000`)),
    ).toThrow();
  });
});
