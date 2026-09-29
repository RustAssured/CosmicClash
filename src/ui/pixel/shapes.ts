import type { PixelCanvas } from './canvas';
import { setAlpha } from './canvas';
import { C, alpha, mixRgb, type AccentRamp } from './palette';
import { drawText, measureText, type TextStyle } from './text';

/* ------------------------------------------------------------------------------------------------ *
 *  ICONS — tiny hand-drawn glyphs. '#' = ink.
 * ------------------------------------------------------------------------------------------------ */
const ICONS: Record<string, readonly string[]> = {
  chevron: ['#....', '##...', '###..', '####.', '###..', '##...', '#....'],
  chevronL: ['....#', '...##', '..###', '.####', '..###', '...##', '....#'],
  arrowR: ['#..', '##.', '###', '##.', '#..'],
  arrowL: ['..#', '.##', '###', '.##', '..#'],
  arrowU: ['..#..', '.###.', '#####'],
  arrowD: ['#####', '.###.', '..#..'],
  diamond: ['..#..', '.###.', '#####', '.###.', '..#..'],
  diamondHollow: ['..#..', '.#.#.', '#...#', '.#.#.', '..#..'],
  diamondSm: ['.#.', '###', '.#.'],
  dot: ['.##.', '####', '####', '.##.'],
  check: ['....#', '...##', '#.##.', '.##..', '..#..'],
  cross: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  lock: ['.###.', '#...#', '#...#', '#####', '##.##', '#####'],
  star: ['..#..', '..#..', '#####', '.###.', '##.##'],
  bolt: ['..##', '.##.', '####', '.##.', '##..'],
  plus: ['..#..', '..#..', '#####', '..#..', '..#..'],
  minus: ['#####'],
};

export type IconName = keyof typeof ICONS | (string & {});

export function iconSize(name: IconName): { w: number; h: number } {
  const rows = ICONS[name] ?? ICONS.dot!;
  return { w: rows[0]!.length, h: rows.length };
}

export function drawIcon(cv: PixelCanvas, name: IconName, x: number, y: number, color: number, scale = 1): void {
  const rows = ICONS[name] ?? ICONS.dot!;
  for (let j = 0; j < rows.length; j++) {
    for (let i = 0; i < rows[j]!.length; i++) {
      if (rows[j]![i] === '#') {
        if (scale === 1) cv.px(x + i, y + j, color);
        else cv.rect(x + i * scale, y + j * scale, scale, scale, color);
      }
    }
  }
}

/* ------------------------------------------------------------------------------------------------ *
 *  PANELS & RULES
 * ------------------------------------------------------------------------------------------------ */
export interface PanelOptions {
  fill?: number;
  border?: number;
  /** Accent colour for the corner brackets / top notch. */
  accent?: number;
  /** Dithered inner shading strip along the top edge. */
  shade?: boolean;
}

/**
 * A quiet panel: translucent ink fill, a 1px hairline, four corner brackets in the accent colour and a short bright notch
 * on the top edge. The corners are cut (one pixel) so it never reads as a default rectangle.
 */
export function panel(cv: PixelCanvas, x: number, y: number, w: number, h: number, o: PanelOptions = {}): void {
  const fill = o.fill ?? alpha(C.ink1, 0.84);
  const border = o.border ?? C.line1;
  cv.rect(x + 1, y, w - 2, h, fill);
  cv.rect(x, y + 1, 1, h - 2, fill);
  cv.rect(x + w - 1, y + 1, 1, h - 2, fill);
  // hairline with cut corners
  cv.hline(x + 1, y, w - 2, border);
  cv.hline(x + 1, y + h - 1, w - 2, border);
  cv.vline(x, y + 1, h - 2, border);
  cv.vline(x + w - 1, y + 1, h - 2, border);
  if (o.shade !== false) cv.dither(x + 1, y + 1, w - 2, 3, alpha(C.ink3, 0.9), 6);
  if (o.accent !== undefined) {
    const a = o.accent;
    for (const [cx, cy, sx, sy] of [
      [x, y, 1, 1],
      [x + w - 1, y, -1, 1],
      [x, y + h - 1, 1, -1],
      [x + w - 1, y + h - 1, -1, -1],
    ] as const) {
      cv.px(cx + sx, cy, a);
      cv.px(cx + sx * 2, cy, a);
      cv.px(cx, cy + sy, a);
      cv.px(cx, cy + sy * 2, a);
    }
    cv.hline(x + 5, y, 9, a);
  }
}

/** A hairline rule with an optional centred diamond. */
export function rule(cv: PixelCanvas, x: number, y: number, w: number, color: number, diamond = true): void {
  if (!diamond) {
    cv.hline(x, y, w, color);
    return;
  }
  const mid = x + Math.floor(w / 2);
  cv.hline(x, y, Math.floor(w / 2) - 5, color);
  cv.hline(mid + 5, y, w - Math.floor(w / 2) - 5, color);
  drawIcon(cv, 'diamondSm', mid - 1, y - 1, color);
}

/* ------------------------------------------------------------------------------------------------ *
 *  BARS & PIPS
 * ------------------------------------------------------------------------------------------------ */
export interface SegBarOptions {
  segW?: number;
  segH?: number;
  gap?: number;
  empty?: number;
}

/** A row of discrete segments — the attribute bars (1..10). Filled segments carry the accent ramp with a lit top pixel row. */
export function segBar(
  cv: PixelCanvas,
  x: number,
  y: number,
  segs: number,
  filled: number,
  ramp: AccentRamp,
  o: SegBarOptions = {},
): number {
  const sw = o.segW ?? 4;
  const sh = o.segH ?? 5;
  const gap = o.gap ?? 1;
  for (let i = 0; i < segs; i++) {
    const sx = x + i * (sw + gap);
    if (i < filled) {
      cv.rect(sx, y, sw, sh, ramp.base);
      cv.hline(sx, y, sw, ramp.light);
      cv.hline(sx, y + sh - 1, sw, ramp.dim);
    } else {
      cv.rect(sx, y, sw, sh, o.empty ?? C.ink3);
      cv.hline(sx, y + sh - 1, sw, C.ink2);
    }
  }
  return segs * (sw + gap) - gap;
}

export interface MeterOptions {
  /** Draw quarter tick marks over the fill. */
  ticks?: boolean;
  /** Track colour. */
  track?: number;
  /** Trailing "recent damage" ghost fraction (0..1) drawn behind the fill in a warning colour. */
  ghost?: number;
  ghostColor?: number;
  /** Fill from the right instead of the left (P2 bars mirror toward the centre). */
  rtl?: boolean;
}

/** Continuous meter: dark track, a hairline frame, a fill with a lit top row and a dim bottom row, optional ghost trail. */
export function meterBar(
  cv: PixelCanvas,
  x: number,
  y: number,
  w: number,
  h: number,
  frac: number,
  ramp: AccentRamp,
  o: MeterOptions = {},
): void {
  const f = Math.max(0, Math.min(1, frac));
  cv.rect(x, y, w, h, o.track ?? C.ink2);
  cv.frame(x - 1, y - 1, w + 2, h + 2, C.line0);
  const inner = w;
  const fw = Math.round(inner * f);
  const gw = o.ghost !== undefined ? Math.round(inner * Math.max(f, Math.min(1, o.ghost))) : 0;
  const at = (ox: number, ow: number): number => (o.rtl ? x + inner - ox - ow : x + ox);
  if (gw > fw) cv.rect(at(fw, gw - fw), y, gw - fw, h, o.ghostColor ?? alpha(C.danger, 0.85));
  if (fw > 0) {
    const fx = at(0, fw);
    cv.rect(fx, y, fw, h, ramp.base);
    cv.hline(fx, y, fw, ramp.light);
    if (h >= 4) cv.hline(fx, y + h - 1, fw, ramp.dim);
    if (h >= 6) cv.hline(fx, y + 1, fw, mixRgb(ramp.base, ramp.light, 0.4));
  }
  if (o.ticks) {
    for (let i = 1; i < 4; i++) {
      const tx = x + Math.round((inner * i) / 4);
      cv.vline(tx, y, h, setAlpha(C.ink0, 150));
    }
  }
}

/** Diamond pips (round wins, resource units). `filled` of `count` lit. */
export function pips(
  cv: PixelCanvas,
  x: number,
  y: number,
  count: number,
  filled: number,
  on: number,
  off: number,
  gap = 2,
  kind: 'diamond' | 'dot' = 'diamond',
  rtl = false,
): number {
  const sz = kind === 'diamond' ? 5 : 4;
  for (let i = 0; i < count; i++) {
    const idx = rtl ? count - 1 - i : i;
    const px = x + i * (sz + gap);
    if (idx < filled) drawIcon(cv, kind === 'diamond' ? 'diamond' : 'dot', px, y, on);
    else drawIcon(cv, kind === 'diamond' ? 'diamondHollow' : 'dot', px, y, off);
  }
  return count * (sz + gap) - gap;
}

/* ------------------------------------------------------------------------------------------------ *
 *  BUTTON PROMPT CHIP
 * ------------------------------------------------------------------------------------------------ */
/**
 * A small key/button cap with a label inside: round-ish for single characters (face buttons), a wider plate for shoulder /
 * key names. Returns its width. `y` is the top of the 9-px chip.
 */
export function chip(
  cv: PixelCanvas,
  x: number,
  y: number,
  label: string,
  o: { color?: number; text?: number; fill?: number } = {},
): number {
  const col = o.color ?? C.mid;
  const tx = o.text ?? C.text;
  const fill = o.fill ?? alpha(C.ink3, 0.95);
  const tw = measureText(label, { font: 'micro' });
  const single = Array.from(label).length === 1;
  const w = single ? 9 : tw + 6;
  const h = 9;
  cv.rect(x + 1, y, w - 2, h, fill);
  cv.rect(x, y + 1, w, h - 2, fill);
  cv.hline(x + 2, y, w - 4, col);
  cv.hline(x + 2, y + h - 1, w - 4, col);
  cv.vline(x, y + 2, h - 4, col);
  cv.vline(x + w - 1, y + 2, h - 4, col);
  cv.px(x + 1, y + 1, col);
  cv.px(x + w - 2, y + 1, col);
  cv.px(x + 1, y + h - 2, col);
  cv.px(x + w - 2, y + h - 2, col);
  // PlayStation symbols and other non-micro glyphs come from the body font (5×7): centre them.
  const useBody = /[-↑-↓←→]/.test(label);
  if (useBody) drawText(cv, label, x + Math.floor(w / 2), y - 1, { color: tx, align: 'center', valign: 'cap' });
  else drawText(cv, label, x + Math.floor(w / 2), y + 2, { color: tx, font: 'micro', align: 'center' });
  return w;
}

/** Draw `text` with an optional trailing hairline underline whose colour animates (menu focus). */
export function underlineText(
  cv: PixelCanvas,
  s: string,
  x: number,
  y: number,
  style: TextStyle,
  lineColor: number,
): void {
  const w = drawText(cv, s, x, y, style);
  const lx = style.align === 'center' ? Math.round(x - w / 2) : style.align === 'right' ? x - w : x;
  cv.hline(lx, y + 12, w, lineColor);
}
