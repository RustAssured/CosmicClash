import { describe, expect, it } from 'vitest';
import { STAGE_IDS } from '@/contracts';
import { STAGES, createScenery, isStageImplemented } from './index';

describe('scenery registry (no GL needed to construct)', () => {
  it('every stage has its own bespoke scenery', () => {
    for (const id of STAGE_IDS) expect(isStageImplemented(id)).toBe(true);
  });

  it('each stage builds a different scenery class with its own noise seed (never a recolour)', () => {
    const names = new Set(STAGE_IDS.map((id) => createScenery(id).constructor.name));
    expect(names.size).toBe(STAGE_IDS.length);
    const seeds = new Set(
      STAGE_IDS.map((id) => (createScenery(id) as unknown as { noiseSeed: number }).noiseSeed),
    );
    expect(seeds.size).toBe(STAGE_IDS.length);
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

  it.each(STAGE_IDS)('%s reports its light at the stage lighting screenPos before any GL exists', (id) => {
    const s = createScenery(id);
    const out = { x: 0, y: 0 };
    s.lightScreenPos(out);
    // composed at the reference camera: the light sits where StageInfo says it does (within the whole-pixel parallax rounding)
    expect(Math.abs(out.x - STAGES[id].lighting.screenPos[0] * 640)).toBeLessThan(6);
    expect(Math.abs(out.y - STAGES[id].lighting.screenPos[1] * 360)).toBeLessThan(6);
  });
});
