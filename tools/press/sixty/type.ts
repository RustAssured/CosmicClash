import { hex } from '../../../src/contracts';
import { PixelCanvas, type Sprite } from '../../../src/ui/pixel/canvas';
import { drawLogo } from '../../../src/ui/pixel/logo';
import { drawText, measureText } from '../../../src/ui/pixel/text';
import { shadeType, type TypeStyle } from '../../../src/ui/pixel/titleType';

/**
 * "WHAT'S LEFT": the trailer's three typographic voices, all the game's own pixel type at native 640×360 (composited ×3
 * nearest, so they are as crisp as the sprites):
 *  - SLAM: one word in the pixel font, shaded like the emblem's title type (titleType.ts `shadeType`), big;
 *  - WHISPER: small centred lines that type in;
 *  - DATA: the matter counter, lower corners.
 */
export const INK = hex('#ecebe6');
export const EDGE = hex('#050407');
export const DIM = hex('#8f8a9a');
export const RED = hex('#ff4a3c');

/** Bone: pale and dead, a blood-dark block (the roster). */
export const BONE: TypeStyle = {
  ramp: ['#fffdf4', '#efe6d2', '#d4c6a8', '#ab9c80', '#7d705c'].map(hex),
  rim: hex('#ffffff'),
  extrude: ['#5a0f12', '#5a0f12', '#3e090c', '#3e090c', '#260507', '#260507'].map(hex),
  outline: hex('#050203'),
  cracks: { n: 3, dark: hex('#3a2a20'), light: hex('#fff6e0') },
};
/** Ember: the rule (molten, as the emblem's gold). */
export const EMBER: TypeStyle = {
  ramp: ['#fffbe0', '#ffe680', '#ffc838', '#ff9a1c', '#e8641a', '#b8380e'].map(hex),
  rim: hex('#ffffff'),
  extrude: ['#7a1c0a', '#7a1c0a', '#5a1208', '#5a1208', '#3c0a06', '#3c0a06'].map(hex),
  outline: hex('#140404'),
};
/** Void: 우리's blue core light (the hunt). */
export const VOID: TypeStyle = {
  ramp: ['#f2fdff', '#b8ecff', '#6cc4ff', '#3a86e8', '#2050b8'].map(hex),
  rim: hex('#ffffff'),
  extrude: ['#1a1450', '#1a1450', '#120c3a', '#120c3a', '#0a0624', '#0a0624'].map(hex),
  outline: hex('#05030f'),
  stars: 10,
};

const cache = new Map<string, Sprite>();
/** `text` in the pixel font, shaded in `style`, ×k. */
export function slamWord(text: string, style: TypeStyle, k: number): Sprite {
  const key = `${text}|${k}|${style.ramp[0]}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const w = measureText(text, { tracking: 1 }) + 2;
  const cv = new PixelCanvas(w, 14);
  cv.clear(0);
  drawText(cv, text, 1, 0, { color: 0xffffffff, tracking: 1 });
  const d = new Uint8Array(w * 14);
  for (let i = 0; i < d.length; i++) d[i] = cv.pixels[i]! >>> 24 ? 1 : 0;
  // trim empty rows so the shading spans the letters
  let top = 0;
  let bot = 13;
  const rowEmpty = (y: number): boolean => !d.subarray(y * w, y * w + w).some((v) => v);
  while (top < bot && rowEmpty(top)) top++;
  while (bot > top && rowEmpty(bot)) bot--;
  const s = shadeType({ d: d.slice(top * w, (bot + 1) * w), w, h: bot - top + 1 }, style, k, text.length);
  cache.set(key, s);
  return s;
}

/** Blit a sprite centred at (cx, y top), optionally only every pixel whose row < `reveal` (a wipe). */
export function blitCentred(cv: PixelCanvas, s: Sprite, cx: number, y: number, flash = false): void {
  const x0 = Math.round(cx - s.w / 2);
  for (let j = 0; j < s.h; j++)
    for (let i = 0; i < s.w; i++) {
      const c = s.pixels[j * s.w + i]!;
      if (!(c >>> 24)) continue;
      cv.px(x0 + i, y + j, flash ? 0xffffffff : c);
    }
}

/** A whisper line, typed in: `chars` characters shown (a cursor block after the last while typing). */
export function whisper(cv: PixelCanvas, s: string, cy: number, chars: number, scale = 1, color = INK): void {
  const shown = s.slice(0, Math.max(0, Math.floor(chars)));
  const full = measureText(s, { tracking: 1, scale });
  const x0 = Math.round(320 - full / 2);
  drawText(cv, shown, x0, cy, { color, outline: EDGE, tracking: 1, scale });
  if (chars < s.length) {
    const cx = x0 + measureText(shown, { tracking: 1, scale }) + (shown ? scale : 0);
    cv.rect(cx, cy + 3 * scale, 4 * scale, 7 * scale, color);
  }
}

export interface CounterState {
  name: string;
  ko: string;
  cells: number;
  start: number;
}
/** The DATA voice: `우리 URI` over `47,019 PX`, its share of the start as a thin bar; red below a third. */
export function counter(cv: PixelCanvas, c: CounterState, side: 'left' | 'right', alpha = 1): void {
  if (alpha <= 0) return;
  const frac = c.start ? c.cells / c.start : 1;
  const col = frac < 0.34 ? RED : INK;
  const num = `${Math.max(0, Math.round(c.cells)).toLocaleString('en-US')} PX`;
  const label = `${c.ko} ${c.name}`;
  const x = side === 'left' ? 14 : 640 - 14;
  const align = side === 'left' ? 'left' : 'right';
  drawText(cv, label, x, 318, { color: DIM, outline: EDGE, align, tracking: 1 });
  drawText(cv, num, x, 330, { color: col, outline: EDGE, align, tracking: 1, scale: 2 });
  // the bar: 120 px of what it started with
  const bw = 120;
  const fill = Math.round(bw * Math.min(1, frac));
  const bx = side === 'left' ? x : x - bw;
  cv.rect(bx - 1, 356, bw + 2, 3, EDGE);
  cv.rect(bx, 357, bw, 1, hex('#2a2630'));
  cv.rect(side === 'left' ? bx : bx + bw - fill, 357, fill, 1, col);
}

export function logo(cv: PixelCanvas, t: number): void {
  drawLogo(cv, 320, 140, t, { scale: 2 });
}

/** Darken a horizontal band (feathered top and bottom, Bayer-dithered) so type reads over any footage. */
export function scrim(cv: PixelCanvas, y0: number, y1: number, strength = 0.6, feather = 10): void {
  const B = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  for (let y = Math.max(0, y0 - feather); y < Math.min(360, y1 + feather); y++) {
    const edge = y < y0 ? (y - (y0 - feather)) / feather : y >= y1 ? (y1 + feather - y) / feather : 1;
    for (let x = 0; x < 640; x++) {
      const k = strength * edge * (0.75 + 0.25 * (1 - Math.abs(x - 320) / 320));
      const q = Math.round(k * 4) / 4 + (B[(y & 3) * 4 + (x & 3)]! / 16 - 0.5) * 0.25;
      const m = 1 - Math.max(0, Math.min(0.92, q));
      const c = cv.pixels[y * 640 + x]!;
      cv.pixels[y * 640 + x] =
        ((c & 0xff000000) | (Math.round(((c >>> 16) & 255) * m) << 16) | (Math.round(((c >>> 8) & 255) * m) << 8) | Math.round((c & 255) * m)) >>> 0;
    }
  }
}
