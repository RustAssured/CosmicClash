import { rgba } from '@/contracts';
import type { Sprite } from './pixel/canvas';

/**
 * Area-sampled portraits. The HUD shows a *live* thumbnail of each titan's remaining body (so carved-away matter is visible
 * in the HUD), and the select screen shows pristine bodies at several sizes; both go through this one resampler.
 *
 * Resampling is a box filter with coverage thresholding: colour is the alpha-weighted mean of the cells in the box, and the
 * output pixel is solid when enough of the box is matter. That keeps the silhouette crisp (no half-transparent fringe) while
 * a missing chunk still opens a visible hole in the thumbnail.
 */
export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Tight bounding box of non-transparent pixels (x1/y1 exclusive); null if the sprite is empty. */
export function alphaBounds(px: Uint32Array, w: number, h: number): Bounds | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[y * w + x]! >>> 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

export interface SampleOptions {
  /** Source rectangle to fit (default: whole sprite). Fitted with aspect preserved and centred. */
  crop?: Bounds;
  flipX?: boolean;
  /** Coverage needed for a solid output pixel (default 0.34). */
  threshold?: number;
  /** 1px outline colour drawn around the silhouette (packed, opaque). */
  outline?: number;
  /** Use this many px of the output as margin (kept clear so the outline fits). */
  margin?: number;
}

/**
 * Resample `src` into `dst` (w×h, reused if given). Zero allocation when `dst` is passed and `scratch` is provided.
 */
export function samplePortrait(
  src: Sprite,
  outW: number,
  outH: number,
  o: SampleOptions = {},
  dst?: Sprite,
): Sprite {
  const out: Sprite = dst ?? { pixels: new Uint32Array(outW * outH), w: outW, h: outH };
  out.pixels.fill(0);
  const crop = o.crop ?? { x0: 0, y0: 0, x1: src.w, y1: src.h };
  const bw = crop.x1 - crop.x0;
  const bh = crop.y1 - crop.y0;
  if (bw <= 0 || bh <= 0) return out;
  const m = o.margin ?? (o.outline !== undefined ? 1 : 0);
  const aw = outW - m * 2;
  const ah = outH - m * 2;
  // px of source per px of output: fit inside, preserving aspect
  const step = Math.max(bw / aw, bh / ah);
  const cw = Math.min(aw, Math.ceil(bw / step));
  const ch = Math.min(ah, Math.ceil(bh / step));
  const ox = m + ((aw - cw) >> 1);
  const oy = m + ((ah - ch) >> 1);
  const thr = o.threshold ?? 0.34;
  const s = src.pixels;
  for (let y = 0; y < ch; y++) {
    const sy0 = crop.y0 + Math.floor(y * step);
    const sy1 = Math.min(crop.y1, Math.max(sy0 + 1, crop.y0 + Math.floor((y + 1) * step)));
    for (let x = 0; x < cw; x++) {
      const sx0 = crop.x0 + Math.floor(x * step);
      const sx1 = Math.min(crop.x1, Math.max(sx0 + 1, crop.x0 + Math.floor((x + 1) * step)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      let cnt = 0;
      for (let yy = sy0; yy < sy1; yy++) {
        const row = yy * src.w;
        for (let xx = sx0; xx < sx1; xx++) {
          const c = s[row + xx]!;
          cnt++;
          if (c >>> 24) {
            r += c & 255;
            g += (c >>> 8) & 255;
            b += (c >>> 16) & 255;
            n++;
          }
        }
      }
      if (n === 0 || n / cnt < thr) continue;
      const dx = o.flipX ? ox + (cw - 1 - x) : ox + x;
      out.pixels[(oy + y) * outW + dx] = rgba(r / n, g / n, b / n, 255);
    }
  }
  if (o.outline !== undefined) {
    const px = out.pixels;
    const oc = o.outline;
    const add: number[] = [];
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        if (px[y * outW + x]! >>> 24) continue;
        if (
          (x > 0 && px[y * outW + x - 1]! >>> 24) ||
          (x < outW - 1 && px[y * outW + x + 1]! >>> 24) ||
          (y > 0 && px[(y - 1) * outW + x]! >>> 24) ||
          (y < outH - 1 && px[(y + 1) * outW + x]! >>> 24)
        )
          add.push(y * outW + x);
      }
    }
    for (const i of add) px[i] = oc;
  }
  return out;
}

/** Silhouette (alpha) of a sprite in one flat colour — used for the "ghost of what was lost" behind the live portrait. */
export function silhouette(src: Sprite, color: number): Sprite {
  const px = new Uint32Array(src.pixels.length);
  const c = color >>> 0;
  for (let i = 0; i < px.length; i++) if (src.pixels[i]! >>> 24) px[i] = c;
  return { pixels: px, w: src.w, h: src.h };
}
