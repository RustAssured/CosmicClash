import { DEFAULT_LIGHTING, type StageLighting, type TitanId } from '@/contracts';
import { getTitanDef } from './defs';
import { paintTitanMap } from './generate';

/** A cropped, pristine sprite of a titan for menus (select screen, results). */
export interface Portrait {
  pixels: Uint32Array;
  w: number;
  h: number;
}

const cache = new Map<string, Portrait>();

/**
 * Render a titan's pristine sprite cropped to its live cells (packed RGBA, transparent outside). Results are cached per
 * (titan, seed, light) since generation costs a few hundred ms. Facing right.
 */
export function renderPortrait(id: TitanId, seed = 1, lighting: StageLighting = DEFAULT_LIGHTING): Portrait {
  const key = `${id}:${seed}:${lighting.color}:${lighting.rim}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { map } = paintTitanMap(getTitanDef(id), seed, lighting);
  let x0 = map.w;
  let y0 = map.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < map.h; y++)
    for (let x = 0; x < map.w; x++)
      if (map.material[y * map.w + x] !== 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const pixels = new Uint32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y + y0) * map.w + (x + x0);
      if (map.material[i] !== 0) pixels[y * w + x] = map.baseColor[i]!;
    }
  const p = { pixels, w, h };
  cache.set(key, p);
  return p;
}
