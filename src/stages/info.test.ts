import { describe, expect, it } from 'vitest';
import { STAGE_IDS, STAGE_PALETTE_MAX, STAGE_PALETTE_MIN, validateStageInfo, hex } from '@/contracts';
import { STAGES } from './index';
import { STAGE_RAMPS } from './info';

describe('stage info', () => {
  it('defines all five stages, indexed in STAGE_IDS order', () => {
    expect(Object.keys(STAGES).sort()).toEqual([...STAGE_IDS].sort());
    STAGE_IDS.forEach((id, i) => {
      expect(STAGES[id].id).toBe(id);
      expect(STAGES[id].index).toBe(i);
      expect(STAGES[id].name.length).toBeGreaterThan(2);
      expect(STAGES[id].nameKo.length).toBeGreaterThan(0);
    });
  });

  it.each(STAGE_IDS)('%s passes validateStageInfo', (id) => {
    expect(validateStageInfo(STAGES[id])).toEqual([]);
    const n = STAGES[id].palette.length;
    expect(n).toBeGreaterThanOrEqual(STAGE_PALETTE_MIN);
    expect(n).toBeLessThanOrEqual(STAGE_PALETTE_MAX);
  });

  it.each(STAGE_IDS)('%s palette has no duplicate colours and a genuinely dark end', (id) => {
    const pal = STAGES[id].palette;
    expect(new Set(pal.map((c) => c.toLowerCase())).size).toBe(pal.length);
    const lum = (c: string): number => {
      const p = hex(c);
      return ((p & 255) * 0.2126 + ((p >>> 8) & 255) * 0.7152 + ((p >>> 16) & 255) * 0.0722) / 255;
    };
    const ls = pal.map(lum);
    expect(Math.min(...ls)).toBeLessThan(0.05); // space must be able to be nearly black
    expect(Math.max(...ls)).toBeGreaterThan(0.85); // and stars must be able to be nearly white
  });

  it.each(STAGE_IDS)('%s publishes ramps that partition its palette into dark → light runs', (id) => {
    const info = STAGES[id];
    expect(info.ramps).toBeDefined();
    expect(info.ramps!.reduce((a, b) => a + b, 0)).toBe(info.palette.length);
    expect(info.ramps!.length).toBeGreaterThanOrEqual(5);
    let i = 0;
    for (const n of info.ramps!) {
      const lum = info.palette.slice(i, i + n).map((c) => {
        const p = hex(c);
        return (p & 255) * 0.2126 + ((p >>> 8) & 255) * 0.7152 + ((p >>> 16) & 255) * 0.0722;
      });
      for (let k = 1; k < lum.length; k++) expect(lum[k]!).toBeGreaterThan(lum[k - 1]!);
      i += n;
    }
  });

  it('lighting vectors are unit length and colours are hex', () => {
    for (const id of STAGE_IDS) {
      const l = STAGES[id].lighting;
      expect(Math.hypot(...l.dir)).toBeCloseTo(1, 6);
      for (const c of [l.color, l.ambient, l.rim]) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('every stage keeps the default arena (each stage owns its own copy)', () => {
    expect(STAGES.nursery.arena).toEqual(STAGES.rim.arena);
    expect(STAGES.nursery.arena).not.toBe(STAGES.rim.arena);
  });

  it.each(STAGE_IDS)('%s bridges its chromatic ramps: no hue gap wider than 0.55 of the circle', (id) => {
    const info = STAGES[id];
    const hues: number[] = [];
    let i = 0;
    for (const n of info.ramps!) {
      // hue of the middle step; ramps that are nearly neutral (near-black voids, pale stars) do not count
      const p = hex(info.palette[i + (n >> 1)]!);
      const r = (p & 255) / 255;
      const g = ((p >>> 8) & 255) / 255;
      const b = ((p >>> 16) & 255) / 255;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const c = mx - mn;
      if (mx > 0.05 && c / mx > 0.16) {
        const h = mx === r ? ((g - b) / c + 6) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
        hues.push(h / 6);
      }
      i += n;
    }
    hues.sort((a, b) => a - b);
    expect(hues.length).toBeGreaterThanOrEqual(3);
    let gap = 1 - hues[hues.length - 1]! + hues[0]!;
    for (let k = 1; k < hues.length; k++) gap = Math.max(gap, hues[k]! - hues[k - 1]!);
    expect(gap).toBeLessThan(0.55); // one deliberate accent ramp may sit across the wheel (quasar ember, redgiant teal)
  });

  it('STAGE_RAMPS mirrors the ramps published in StageInfo', () => {
    for (const id of STAGE_IDS) expect([...STAGE_RAMPS[id]]).toEqual(STAGES[id].ramps);
  });
});
