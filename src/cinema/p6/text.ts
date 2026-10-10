import { PixelCanvas } from '@/ui/pixel/canvas';
import { drawText, measureText } from '@/ui/pixel/text';
import { nearestMaster } from '../p4/palette';
import { OUTLINE } from '../p4/palette';
import { hex } from '@/contracts';

/**
 * Cards for the P6 actors: the game's own pixel font (src/ui/pixel/text.ts: the 5×7 Latin face and the Hangeul composed
 * from jamo), the same as the cinema overlay's cards, at a whole-number scale with a 1 native px dark outline and no
 * partial alpha. Colours are snapped to the master palette.
 */
export interface Sprite {
  w: number;
  h: number;
  /** Packed RGBA, alpha 0 = transparent. */
  pixels: Uint32Array;
}

/** A master-palette colour from a #rrggbb accent. */
export const masterOf = (c: string | number): number => {
  const v = typeof c === 'number' ? c : hex(c);
  return nearestMaster(v & 255, (v >>> 8) & 255, (v >>> 16) & 255);
};

export function textSprite(text: string, color: string | number, scale = 1, tracking = 0): Sprite {
  const w = measureText(text, { scale, tracking }) + 2 * scale + 2;
  const h = 14 * scale + 4;
  const cv = new PixelCanvas(w, h);
  drawText(cv, text, 1 + scale, 1, { color: masterOf(color), outline: OUTLINE, scale, tracking });
  return { w, h, pixels: cv.pixels };
}

/** Blit a sprite into a native buffer (top-left at x, y), opaque pixels only; emissive as given. */
export function blit(
  buf: { w: number; h: number; pixels: Uint32Array; emissive: Uint8Array },
  s: Sprite,
  x: number,
  y: number,
  emissive = 0,
  scale = 1,
): void {
  const { w: W, h: H, pixels, emissive: em } = buf;
  for (let j = 0; j < s.h * scale; j++) {
    const Y = y + j;
    if (Y < 0 || Y >= H) continue;
    for (let i = 0; i < s.w * scale; i++) {
      const X = x + i;
      if (X < 0 || X >= W) continue;
      const c = s.pixels[Math.floor(j / scale) * s.w + Math.floor(i / scale)]!;
      if (!(c >>> 24)) continue;
      pixels[Y * W + X] = c;
      em[Y * W + X] = c === OUTLINE ? 0 : emissive;
    }
  }
}
