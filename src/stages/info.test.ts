import { describe, expect, it } from 'vitest';
import { STAGE_IDS, STAGE_PALETTE_MAX, STAGE_PALETTE_MIN, validateStageInfo, hex } from '@/contracts';
import { STAGES } from './index';

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
});
