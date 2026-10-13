import { hex, type MatterMap, type TitanDef } from '@/contracts';
import { hash01 } from '../../art/noise';

/**
 * THE CRADLE'S WRONG DEVELOPMENT (differentiation failure, brief "Weakness"): turn one tissue into another, cell by cell, in
 * a matter map, keeping each cell's place in its light (its colour's rank in its old material's ramp is carried over to the
 * same rank in the new material's ramp), so a calcified patch is lit like the membrane it replaced. Pure and deterministic.
 *
 * Used on the Cradle's own maps: regrown cord links (calcified, malformed), membrane turning to bone, sacs where spokes were.
 */

/** Packed ramps (dark → light) per material id, from a definition's JSON (index 0 unused). */
export function rampsOf(def: TitanDef): number[][] {
  return [[], ...def.materials.map((m) => m.visual.ramp.map(hex))];
}

const lum = (c: number): number => (c & 255) * 0.3 + ((c >>> 8) & 255) * 0.59 + ((c >>> 16) & 255) * 0.11;

/** A colour's rank 0..1 in a ramp (by luminance against the ramp's own steps). */
export function rankIn(ramp: readonly number[], c: number): number {
  const l = lum(c);
  const lo = lum(ramp[0]!);
  const hi = lum(ramp[ramp.length - 1]!);
  return hi > lo ? Math.max(0, Math.min(1, (l - lo) / (hi - lo))) : 0.5;
}

/** The ramp colour at rank t (0..1), dithered between steps by a per-cell hash. */
export function atRank(ramp: readonly number[], t: number, x: number, y: number, seed: number): number {
  const s = Math.max(0, Math.min(1, t)) * (ramp.length - 1);
  const f = Math.floor(s);
  const up = hash01(x, y, seed) < s - f ? 1 : 0;
  return ramp[Math.min(ramp.length - 1, f + up)]! | 0xff000000;
}

/**
 * Rewrite cells of `map`: `rule(material, x, y)` returns the new material (0 = keep). `shift` nudges the new colour's rank
 * (calcified tissue lighter, a sac darker), `density` the new density byte (0 = keep). Returns how many cells changed.
 * Bumps `map.version` and marks the whole map dirty when anything changed.
 */
export function transmute(
  map: MatterMap,
  ramps: readonly (readonly number[])[],
  rule: (m: number, x: number, y: number) => number,
  seed: number,
  shift = 0,
  density = 0,
): number {
  let n = 0;
  for (let y = 0; y < map.h; y++)
    for (let x = 0; x < map.w; x++) {
      const i = y * map.w + x;
      const m = map.material[i]!;
      if (m === 0) continue;
      const to = rule(m, x, y);
      if (to === 0 || to === m) continue;
      const from = ramps[m];
      const into = ramps[to];
      if (!from || !into || into.length === 0) continue;
      const t = rankIn(from, map.baseColor[i]!) + shift;
      const c = atRank(into, t, x, y, seed);
      map.material[i] = to;
      map.baseColor[i] = c;
      map.pixels[i] = c;
      if (density > 0) map.density[i] = density;
      n++;
    }
  if (n > 0) {
    map.version++;
    map.dirty = { x0: 0, y0: 0, x1: map.w, y1: map.h };
  }
  return n;
}
