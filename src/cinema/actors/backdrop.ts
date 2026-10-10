import { Rng } from '@/contracts';
import type { Actor, CineContext, NativeBuffer } from '../types';
import { parallaxOf } from '../types';
import { registerActor } from './index';

/**
 * `backdrop`: deep space for cinema-only shots: an opaque near-black plate with a seeded star field that parallaxes with the
 * camera by its depth (covers the stage scenery). params: seed (1), density (stars per 10 000 px, 9), color ([4,3,8]).
 * The stars twinkle on whole-pixel steps only (no sub-pixel drift: they move when the camera moves a whole pixel).
 */
interface Star {
  x: number;
  y: number;
  c: number;
  e: number;
  tw: number;
}

const SPAN = 2048;

function packed(r: number, g: number, b: number): number {
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

registerActor('backdrop', (id, depth, params): Actor => {
  const seed = Number(params.seed ?? 1);
  const density = Number(params.density ?? 9);
  const col = (params.color as [number, number, number] | undefined) ?? [4, 3, 8];
  const bg = packed(col[0], col[1], col[2]);
  const rng = new Rng(seed);
  const stars: Star[] = [];
  const n = Math.round((SPAN * SPAN * density) / 10000);
  for (let i = 0; i < n; i++) {
    const k = rng.next();
    const v = Math.round(60 + 195 * Math.pow(rng.next(), 3));
    const tint = rng.next();
    const r = Math.round(v * (tint < 0.3 ? 0.8 : 1));
    const b = Math.round(v * (tint > 0.7 ? 0.82 : 1));
    stars.push({
      x: rng.next() * SPAN,
      y: rng.next() * SPAN,
      c: packed(r, v, b),
      e: k > 0.97 ? 200 : 0,
      tw: rng.next() * 6.283,
    });
  }
  const par = parallaxOf(depth);
  return {
    id,
    depth,
    draw(buf: NativeBuffer, ctx: CineContext): void {
      buf.pixels.fill(bg);
      const ox = Math.round(ctx.view.x0 * par);
      const oy = Math.round(ctx.view.y0 * par);
      for (const s of stars) {
        const x = Math.floor((((s.x - ox) % SPAN) + SPAN) % SPAN);
        const y = Math.floor((((s.y - oy) % SPAN) + SPAN) % SPAN);
        if (x >= buf.w || y >= buf.h) continue;
        // twinkle: a slow on/off for a few bright stars, in whole frames
        if (s.e && Math.sin(ctx.t * 1.7 + s.tw) < -0.6) continue;
        buf.pixels[y * buf.w + x] = s.c;
        buf.emissive[y * buf.w + x] = s.e;
      }
    },
  };
});
