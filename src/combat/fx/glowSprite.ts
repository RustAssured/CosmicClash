import { makeLayer, rgba, type RenderLayer } from '@/contracts';

/**
 * A static, precomputed radial glow used as an additive backdrop behind a body. Nothing is redrawn per tick: the layer's
 * `alpha` carries the pulse and its position follows the body, so the halo costs one texture upload for the whole match.
 * The falloff is quantised and ordered-dithered so it stays pixel art rather than a smooth gradient.
 */
export class GlowSprite {
  readonly layer: RenderLayer;
  readonly r: number;

  /** `r`: radius in px; `rgb`: peak colour; `core`: fraction of the radius that stays near full strength. */
  constructor(id: string, z: number, r: number, rgb: [number, number, number], core = 0.28, steps = 7) {
    const size = Math.ceil(r) * 2 + 2;
    const L = makeLayer(id, 'world', z, size, size);
    L.blend = 'add';
    L.anchorX = size >> 1;
    L.anchorY = size >> 1;
    const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / r;
        if (d >= 1) continue;
        const t = d <= core ? 1 : Math.pow(1 - (d - core) / (1 - core), 2.1);
        const q = t * steps;
        const fl = Math.floor(q);
        const lvl = fl + (q - fl > (bayer[((y & 3) << 2) | (x & 3)]! + 0.5) / 16 ? 1 : 0);
        const k = Math.min(1, lvl / steps);
        if (k <= 0) continue;
        L.pixels[y * size + x] = rgba(rgb[0] * k, rgb[1] * k, rgb[2] * k, 255);
      }
    L.version = 1;
    this.layer = L;
    this.r = r;
  }

  /** Place the halo at world (x, y) with the given intensity (0..1). */
  place(x: number, y: number, prevX: number, prevY: number, alpha: number): void {
    const L = this.layer;
    L.x = x;
    L.y = y;
    L.prevX = prevX;
    L.prevY = prevY;
    L.alpha = alpha;
    L.visible = alpha > 0.01;
  }
}
