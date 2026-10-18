import { describe, expect, it } from 'vitest';
import { DEFAULT_LIGHTING } from '@/contracts';
import { getTitanDef } from '@/titans';
import { paintPlanet, paintPlanetFace } from './planet';

/** The face-only painter (the living idle's rotation frames) must give the full painter's colours on the disc. */
describe('paintPlanetFace (idle handover, specs/planet.md §2)', () => {
  const def = getTitanDef('planet');
  for (const fi of [0, 60, 120, 180])
    it(`frame ${fi}: identical to paintPlanet's baseColor on every face cell`, () => {
      const lon = (fi / 240) * Math.PI * 2;
      const full = paintPlanet(def, 21, DEFAULT_LIGHTING, lon).map;
      const face = paintPlanetFace(def, 21, DEFAULT_LIGHTING, lon).colors;
      const ids = paintPlanet(def, 21, DEFAULT_LIGHTING, 0).rig.ids;
      const rig = paintPlanet(def, 21, DEFAULT_LIGHTING, 0).rig;
      let cells = 0;
      let diff = 0;
      for (let i = 0; i < full.material.length; i++) {
        const m = full.material[i]!;
        if (!m || m === ids.atmosphere || m === ids.cloud || rig.nz[i] === 0) continue;
        cells++;
        if (face[i] !== full.baseColor[i]) diff++;
      }
      expect(cells).toBeGreaterThan(8000);
      expect(diff).toBe(0);
    });
});
