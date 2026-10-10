import { PixelCanvas } from '@/ui/pixel/canvas';
import { drawText, lineHeight, measureText } from '@/ui/pixel/text';
import type { Card, Shot } from './timeline';
import { keyValue } from './timeline';
import { NATIVE_H, NATIVE_W } from './types';

/**
 * The film's own pixels, drawn at native resolution over the picture (never zoomed, never bloomed): the 2.39:1 letterbox
 * and the cards. Cards use the game's pixel font (the same type the press kit and the HUD use) at whole-number scales with a
 * 1-px dark outline; there is no anti-aliasing anywhere, so they cut on and off instead of fading.
 */

/** Picture height with the bars closed: 640×268 (2.39:1). */
export const SCOPE_H = 268;
/** Bar height with the bars closed. */
export const BAR_H = (NATIVE_H - SCOPE_H) / 2;

/** Top and bottom bar heights (native px) for an opening 0 (scope) … 1 (full 16:9) and a vertical shake (native px). */
export function bars(open: number, shakeY = 0): { top: number; bottom: number } {
  const h = Math.round(BAR_H * (1 - Math.min(1, Math.max(0, open))));
  if (h <= 0) return { top: 0, bottom: 0 };
  // the bars shake with the camera: one moves in, the other out, so the picture height holds
  return { top: Math.max(0, h + shakeY), bottom: Math.max(0, h - shakeY) };
}

const INK = 0xfff0ece8;
const SCRATCH = new PixelCanvas(NATIVE_W, NATIVE_H);
const OUTLINE = 0xff0a0606;

function parseColor(c: Card['color']): number {
  if (typeof c === 'number') return c >>> 0;
  if (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) {
    const v = parseInt(c.slice(1), 16);
    return (0xff000000 | ((v & 0xff) << 16) | (v & 0xff00) | ((v >> 16) & 0xff)) >>> 0;
  }
  return INK;
}

/**
 * The overlay of one frame: letterbox bars and the cards live at shot second `shotT`. Returns a reused canvas (packed RGBA,
 * transparent where the picture shows through).
 */
export function drawOverlay(
  shot: Shot,
  shotT: number,
  shakeY: number,
  cv = new PixelCanvas(NATIVE_W, NATIVE_H),
): PixelCanvas {
  cv.clear(0);
  const open = keyValue(shot.letterbox, shotT, 0);
  const b = bars(open, shakeY);
  if (b.top) cv.pixels.fill(0xff000000, 0, b.top * NATIVE_W);
  if (b.bottom) cv.pixels.fill(0xff000000, (NATIVE_H - b.bottom) * NATIVE_W);
  const scratch = SCRATCH;
  scratch.clear(0);
  for (const c of shot.cards ?? []) {
    if (shotT < c.t[0] || shotT >= c.t[1]) continue;
    const lines = c.text.split('\n');
    const lh = lineHeight('body', c.scale);
    const total = lines.length * lh + (lines.length - 1) * 2 * c.scale;
    let y = c.y ?? Math.round((NATIVE_H - total) / 2);
    for (const l of lines) {
      drawText(scratch, l, c.x ?? NATIVE_W / 2, y, {
        color: parseColor(c.color),
        scale: c.scale,
        align: 'center',
        tracking: 1,
      });
      y += lh + 2 * c.scale;
    }
  }
  // one native pixel of dark outline round every glyph, whatever the scale, then the glyphs over it
  const s = scratch.pixels;
  const d = cv.pixels;
  for (let y = 0; y < NATIVE_H; y++)
    for (let x = 0; x < NATIVE_W; x++) {
      const i = y * NATIVE_W + x;
      if (s[i]! >>> 24) continue;
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < NATIVE_W && yy < NATIVE_H && s[yy * NATIVE_W + xx]! >>> 24) {
            edge = true;
            break;
          }
        }
      if (edge) d[i] = OUTLINE;
    }
  for (let i = 0; i < s.length; i++) if (s[i]! >>> 24) d[i] = s[i]!;
  return cv;
}

/** Width in native px a card line takes (for layout checks). */
export const cardWidth = (text: string, scale: number): number => measureText(text, { scale, tracking: 1 });
