import { DEFAULT_LIGHTING, type StageLighting, type TitanId } from '@/contracts';
import { getTitanDef } from './defs';
import { paintTitanMap } from './generate';
import { paintWitness } from './art/lastone';
import { uriPartMatter } from './uri/maps';
import { URI_ORDER, uriPart } from './uri/rig';

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
  // the colossus (D36: 'colossus', The Last One) is every painted region composited, not only its eye cradle
  if (id === 'colossus') {
    const p = witnessPortrait(seed, lighting);
    cache.set(key, p);
    return p;
  }
  if (id === 'uri') {
    const p = uriPortrait();
    cache.set(key, p);
    return p;
  }
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

/**
 * The whole of 우리 at rest: its 13 parts at their places in the asset's reference space, in the asset's draw order (the
 * same parts the game draws; no repainting). The cores, loop and moon field are drawn live in the game, not here.
 */
function uriPortrait(): Portrait {
  const parts = uriPartMatter(1);
  const at = new Map(parts.map((p) => [p.key, p]));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const k of URI_ORDER) {
    const P = uriPart(k);
    x0 = Math.min(x0, P.x0);
    y0 = Math.min(y0, P.y0);
    x1 = Math.max(x1, P.x0 + P.w);
    y1 = Math.max(y1, P.y0 + P.h);
  }
  const w = x1 - x0;
  const h = y1 - y0;
  const pixels = new Uint32Array(w * h);
  for (const k of URI_ORDER) {
    const P = uriPart(k);
    const m = at.get(k)!.map;
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        if (m.material[i] !== 0) pixels[(P.y0 + y - y0) * w + (P.x0 + x - x0)] = m.baseColor[i]!;
      }
  }
  return { pixels, w, h };
}

/** The whole Witness at rest (every region composited back to front), not only its eye cradle (the primary body's map). */
function witnessPortrait(seed: number, lighting: StageLighting): Portrait {
  const body = paintWitness(seed, lighting);
  const x0 = Math.floor(body.x0);
  const y0 = Math.floor(body.y0);
  const w = Math.ceil(body.x1) - x0;
  const h = Math.ceil(body.y1) - y0;
  const pixels = new Uint32Array(w * h);
  const order = body.regions.slice().sort((a, b) => a.z - b.z);
  for (const r of order) {
    const m = r.map;
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        if (m.material[i] === 0) continue;
        const px = Math.floor(r.ox + x) - x0;
        const py = Math.floor(r.oy + y) - y0;
        if (px >= 0 && py >= 0 && px < w && py < h) pixels[py * w + px] = m.baseColor[i]!;
      }
  }
  return { pixels, w, h };
}
