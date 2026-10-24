import { describe, expect, it } from 'vitest';
import { TITAN_KINDS } from '@/contracts';
import { MATERIAL_ARCHETYPES } from '@/matter/archetypes';
import { ROSTER } from '../roster';
import { BLOB_KEYS, KIND_PRESETS, kindMaterials } from './kinds';
import { buildRamp } from './palette';

describe('titan kinds', () => {
  it('has a preset for every kind, built from real archetypes', () => {
    for (const k of TITAN_KINDS) {
      const p = KIND_PRESETS[k];
      expect(p.id).toBe(k);
      for (const key of BLOB_KEYS)
        expect(MATERIAL_ARCHETYPES[p.materials[key].base], `${k}.${key}`).toBeDefined();
      // every authored material must appear in the body: the eye material needs at least one eye
      expect(p.shape.eyes, k).toBeGreaterThanOrEqual(1);
    }
  });

  it('gives the blob its five materials, ramps around the hue', () => {
    for (const k of TITAN_KINDS) {
      const mats = kindMaterials(k, 200);
      expect(mats.map((m) => m.key)).toEqual([...BLOB_KEYS]);
      for (const m of mats) {
        expect(m.visual.ramp.length).toBeGreaterThanOrEqual(3);
        for (const c of m.visual.ramp) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it('keeps organic as the plain blob the scaffold always made', () => {
    const [skin, flesh, marking, eye, core] = kindMaterials('organic', 40);
    expect([skin!.base, flesh!.base, marking!.base, eye!.base, core!.base]).toEqual([
      'regolith',
      'regolith',
      'crystal',
      'crystal',
      'ironNickel',
    ]);
    expect(skin!.visual.ramp).toEqual(buildRamp(40, 8, 0.45, 0.07, 0.82));
    expect(core!.physics).toEqual({ density: 3, toughness: 0.9 });
  });

  it('tags every shipped roster titan with a known kind', () => {
    for (const r of ROSTER) if (!r.wip) expect(TITAN_KINDS, r.id).toContain(r.kind);
  });
});
