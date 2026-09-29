import { Rng } from '@/contracts';
import { SpriteBuilder, type SpriteBuffer } from './kit';

/** Blackbody-ish star tints in linear light, bluest → reddest. */
export const STAR_TINTS: readonly (readonly [number, number, number])[] = [
  [0.72, 0.84, 1.0],
  [0.9, 0.95, 1.0],
  [1.0, 1.0, 1.0],
  [1.0, 0.88, 0.62],
  [1.0, 0.66, 0.4],
  [1.0, 0.45, 0.32],
];

/** Layer-space rectangle a layer of parallax `p` must cover so no edge is ever visible for any camera position. */
export interface LayerBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function layerBounds(
  arena: { minX: number; maxX: number; minY: number; maxY: number },
  parallax: number,
  margin = 48,
): LayerBounds {
  return {
    x0: arena.minX * parallax - margin,
    y0: arena.minY * parallax - margin,
    x1: (arena.maxX - 640) * parallax + 640 + margin,
    y1: (arena.maxY - 360) * parallax + 360 + margin,
  };
}

export interface StarFieldOpts {
  count: number;
  bounds: LayerBounds;
  /** Star weight table: index into STAR_TINTS by probability. */
  tintWeights?: readonly number[];
  /** Half-size range in px (1 = single pixel). */
  size: [number, number];
  /** Brightness (HDR) of the dimmest star, and the extra a "hero" star can add (power-law: few are bright). */
  base: number;
  boost: number;
  power?: number;
  /** Extra tint multiplier so a stage can push all stars toward its palette. */
  tint?: readonly [number, number, number];
  seed: number;
}

/** A field of point stars (use with `snap: true` so each is a crisp pixel). */
export function makeStarField(o: StarFieldOpts): SpriteBuffer {
  const rng = new Rng(o.seed);
  const b = new SpriteBuilder();
  const w = o.tintWeights ?? [3, 4, 5, 3, 2, 1];
  const total = w.reduce((a, c) => a + c, 0);
  const tint = o.tint ?? [1, 1, 1];
  for (let i = 0; i < o.count; i++) {
    let t = rng.next() * total;
    let k = 0;
    while (k < w.length - 1 && t > w[k]!) {
      t -= w[k]!;
      k++;
    }
    const c = STAR_TINTS[k]!;
    const br = o.base + o.boost * Math.pow(rng.next(), o.power ?? 6);
    const s = o.size[0] + (o.size[1] - o.size[0]) * Math.pow(rng.next(), 2.5);
    b.push(
      o.bounds.x0 + rng.next() * (o.bounds.x1 - o.bounds.x0),
      o.bounds.y0 + rng.next() * (o.bounds.y1 - o.bounds.y0),
      0,
      rng.next(),
      s,
      s,
      0,
      c[0] * tint[0] * br,
      c[1] * tint[1] * br,
      c[2] * tint[2] * br,
      1,
    );
  }
  return b.build();
}
