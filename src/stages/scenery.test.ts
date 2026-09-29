import { describe, expect, it } from 'vitest';
import { STAGE_IDS } from '@/contracts';
import { STAGES, createScenery, isStageImplemented } from './index';

describe('scenery registry (no GL needed to construct)', () => {
  it('implements the nursery; every other stage is honest about using the stand-in', () => {
    expect(isStageImplemented('nursery')).toBe(true);
    for (const id of STAGE_IDS.filter((s) => s !== 'nursery')) expect(isStageImplemented(id)).toBe(false);
  });

  it.each(STAGE_IDS)('createScenery(%s) returns a StageScenery with a sane look', (id) => {
    const s = createScenery(id);
    expect(s.id).toBe(id);
    for (const fn of ['init', 'update', 'render', 'lightScreenPos', 'dispose'] as const)
      expect(typeof s[fn]).toBe('function');
    const l = s.look;
    expect(l.exposure).toBeGreaterThan(0.3);
    expect(l.exposure).toBeLessThan(3);
    expect(l.vignette).toBeGreaterThanOrEqual(0);
    expect(l.vignette).toBeLessThan(1);
    expect(l.godRayDecay).toBeGreaterThan(0.9);
    expect(l.godRayDecay).toBeLessThan(1);
    s.dispose(); // safe before init
  });

  it('light position defaults come from the stage lighting (screenPos) for the generic stand-in', () => {
    const s = createScenery('rim');
    const out = { x: 0, y: 0 };
    s.lightScreenPos(out);
    expect(out.x).toBeCloseTo(STAGES.rim.lighting.screenPos[0] * 640, 6);
    expect(out.y).toBeCloseTo(STAGES.rim.lighting.screenPos[1] * 360, 6);
  });
});
