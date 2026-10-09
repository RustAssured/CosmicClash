import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { uriPartMatter, URI_MAT } from './maps';
import { URI_PARTS, URI_REF, URI_SCALE, uriPart } from './rig';
import { uriGridOf } from './scale';

/** D34: 우리 at its game size (about 200 px tall), resampled from the asset at load. */
describe('우리 at URI_SCALE (D34)', () => {
  const LIGHTS = new Set<number>([URI_MAT.field, URI_MAT.civ, URI_MAT.slit, URI_MAT.habitat, URI_MAT.crack]);
  const parts = uriPartMatter();

  it('is about 200 px tall, and every part grid sits at URI_SCALE × its reference place', () => {
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const pm of parts) {
      const g = uriGridOf(uriPart(pm.key), URI_SCALE);
      expect([pm.map.w, pm.map.h], pm.key).toEqual([g.w, g.h]);
      const P = uriPart(pm.key);
      // the pivot is the same point of the part, scaled
      expect(g.x0 + g.pivX).toBeCloseTo(P.pgX * URI_SCALE, 9);
      expect(g.y0 + g.pivY).toBeCloseTo(P.pgY * URI_SCALE, 9);
      for (let i = 0; i < pm.map.material.length; i++)
        if (pm.map.material[i]) {
          const y = g.y0 + Math.floor(i / pm.map.w);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y + 1);
        }
    }
    expect(y1 - y0).toBeGreaterThanOrEqual(195);
    expect(y1 - y0).toBeLessThanOrEqual(205);
  });

  it('keeps the reference silhouette (IoU ≥ 0.95 against it, area-resampled) and its lights crisp', () => {
    const png = PNG.sync.read(readFileSync('uri/data/uri_silhouette_rest.png'));
    const on = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= URI_REF.w || y >= URI_REF.h) return false;
      const i = (y * png.width + x) * 4;
      return png.data[i + 3]! > 127 && png.data[i]! + png.data[i + 1]! + png.data[i + 2]! > 0;
    };
    // the reference silhouette resampled to the game's grid: an output cell is on where half of its source square is
    const W = Math.ceil(URI_REF.w * URI_SCALE);
    const H = Math.ceil(URI_REF.h * URI_SCALE);
    const want = new Uint8Array(W * H);
    const inv = 1 / URI_SCALE;
    for (let Y = 0; Y < H; Y++)
      for (let X = 0; X < W; X++) {
        let a = 0;
        for (let y = Math.floor(Y * inv); y < Math.ceil((Y + 1) * inv); y++)
          for (let x = Math.floor(X * inv); x < Math.ceil((X + 1) * inv); x++) {
            const wx = Math.min((X + 1) * inv, x + 1) - Math.max(X * inv, x);
            const wy = Math.min((Y + 1) * inv, y + 1) - Math.max(Y * inv, y);
            if (wx > 0 && wy > 0 && on(x, y)) a += wx * wy;
          }
        want[Y * W + X] = a >= 0.5 * inv * inv ? 1 : 0;
      }
    const got = new Uint8Array(W * H);
    let lightsGot = 0;
    for (const pm of parts) {
      const g = uriGridOf(uriPart(pm.key), URI_SCALE);
      for (let i = 0; i < pm.map.material.length; i++) {
        if (!pm.map.material[i]) continue;
        const X = g.x0 + (i % pm.map.w);
        const Y = g.y0 + Math.floor(i / pm.map.w);
        if (X >= 0 && Y >= 0 && X < W && Y < H) got[Y * W + X] = 1;
        if (LIGHTS.has(pm.shade[i * 4 + 3]!)) lightsGot++;
      }
    }
    let inter = 0;
    let uni = 0;
    for (let i = 0; i < want.length; i++) {
      if (want[i] && got[i]) inter++;
      if (want[i] || got[i]) uni++;
    }
    expect(inter / uni).toBeGreaterThanOrEqual(0.95);
    // the lights (field, civilisation, slit) survive as lights: about URI_SCALE² as many cells, none blurred away or grown
    let lightsRef = 0;
    for (const pm of uriPartMatter(1))
      for (let i = 0; i < pm.map.material.length; i++) if (LIGHTS.has(pm.shade[i * 4 + 3]!)) lightsRef++;
    const ratio = lightsGot / (lightsRef * URI_SCALE * URI_SCALE);
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1.3);
    // every part keeps all its chunks but the smallest slivers (chunk ids survive the resample)
    for (const pm of parts) {
      const ref = new Set(uriPartMatter(1).find((q) => q.key === pm.key)!.chunks);
      const live = new Set<number>();
      for (let i = 0; i < pm.map.material.length; i++) if (pm.map.material[i]) live.add(pm.chunks[i]!);
      expect(live.size / ref.size, pm.key).toBeGreaterThan(0.85);
    }
  });

  it('is the asset itself at scale 1', () => {
    for (const P of URI_PARTS)
      expect(uriGridOf(P, 1)).toEqual({ x0: P.x0, y0: P.y0, w: P.w, h: P.h, pivX: P.pivX, pivY: P.pivY });
  });
});
