import { BODY_GLYPHS, MICRO_GLYPHS, type BitmapGlyph } from './font-data';
import { HANGUL_CELL, composeSyllable, isHangulSyllable } from './hangeul';
import type { PixelCanvas } from './canvas';

/**
 * Text engine: one call draws mixed Latin + Hangeul with correct baselines.
 *
 * Metrics (px). BODY line box is 12 tall — the Hangeul cell — and Latin glyphs sit inside it with the cap-height centred
 * against the Hangeul (`LATIN_TOP = 2`: caps span rows 2..8, descenders 9..10). MICRO is a 3×5 caps-only face.
 */
export type FontId = 'body' | 'micro';

export interface TextStyle {
  color: number;
  /** Drop shadow colour (1px down-right). */
  shadow?: number;
  /** 1px outline in this colour (all 8 neighbours). */
  outline?: number;
  /** Integer upscale of every glyph pixel. */
  scale?: number;
  font?: FontId;
  /** Extra px between glyphs (before scale). */
  tracking?: number;
  align?: 'left' | 'center' | 'right';
  /**
   * 'box' (default): `y` is the top of the 12-px line box. 'cap': `y` is the top of Latin capitals (Hangeul is drawn 2px
   * higher), so tight layouts can align caps to a pixel grid.
   */
  valign?: 'box' | 'cap';
}

export const BODY_LINE = HANGUL_CELL;
export const LATIN_TOP = 2;
const LATIN_ADVANCE = 6;
const MICRO_ADVANCE = 4;
const HANGUL_ADVANCE = HANGUL_CELL + 1;

interface Mask {
  w: number;
  h: number;
  data: Uint8Array;
  advance: number;
  /** Rows above the line-box top at which the mask is placed. */
  top: number;
}

const bodyCache = new Map<string, Mask>();
const microCache = new Map<string, Mask>();

function toMask(g: BitmapGlyph, advance: number, top: number): Mask {
  const h = g.rows.length;
  const data = new Uint8Array(g.w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < g.w; x++) data[y * g.w + x] = g.rows[y]![x] === '#' ? 1 : 0;
  return { w: g.w, h, data, advance, top };
}

function latinMask(ch: string, font: FontId): Mask {
  const cache = font === 'micro' ? microCache : bodyCache;
  let m = cache.get(ch);
  if (m) return m;
  if (font === 'micro') {
    const g = MICRO_GLYPHS[ch] ?? MICRO_GLYPHS[ch.toUpperCase()] ?? MICRO_GLYPHS['\ufffd']!;
    m = toMask(g, MICRO_ADVANCE, 0);
  } else {
    const g = BODY_GLYPHS[ch] ?? BODY_GLYPHS['\ufffd']!;
    m = toMask(g, LATIN_ADVANCE, LATIN_TOP);
  }
  cache.set(ch, m);
  return m;
}

const hangulMasks = new Map<number, Mask>();
function hangulMask(cp: number): Mask {
  let m = hangulMasks.get(cp);
  if (!m) {
    const g = composeSyllable(cp);
    m = { w: g.w, h: g.h, data: g.data, advance: HANGUL_ADVANCE, top: 0 };
    hangulMasks.set(cp, m);
  }
  return m;
}

function maskFor(cp: number, ch: string, font: FontId): Mask {
  if (isHangulSyllable(cp)) return hangulMask(cp);
  return latinMask(ch, font);
}

/** Does the string contain any Hangeul? */
export function hasHangul(s: string): boolean {
  for (const ch of s) if (isHangulSyllable(ch.codePointAt(0)!)) return true;
  return false;
}

/** Width in px of a string (at the given scale, tracking) — advance of each glyph minus the trailing gap. */
export function measureText(s: string, style: Pick<TextStyle, 'font' | 'tracking' | 'scale'> = {}): number {
  const font = style.font ?? 'body';
  const tr = style.tracking ?? 0;
  const sc = style.scale ?? 1;
  let w = 0;
  let n = 0;
  for (const ch of s) {
    const m = maskFor(ch.codePointAt(0)!, ch, font);
    w += m.advance + tr;
    n++;
  }
  if (n === 0) return 0;
  return (w - tr - 1) * sc + (font === 'micro' ? 0 : 0);
}

/** Height of the line box at a scale (body 12, micro 5). */
export const lineHeight = (font: FontId = 'body', scale = 1): number => (font === 'micro' ? 5 : BODY_LINE) * scale;

function stamp(cv: PixelCanvas, m: Mask, x: number, y: number, sc: number, c: number): void {
  for (let j = 0; j < m.h; j++) {
    for (let i = 0; i < m.w; i++) {
      if (m.data[j * m.w + i]) {
        if (sc === 1) cv.px(x + i, y + j, c);
        else cv.rect(x + i * sc, y + j * sc, sc, sc, c);
      }
    }
  }
}

/** Draw text; returns the drawn width. `x` is the left / centre / right edge depending on `align`. */
export function drawText(cv: PixelCanvas, s: string, x: number, y: number, style: TextStyle): number {
  const font = style.font ?? 'body';
  const sc = style.scale ?? 1;
  const tr = style.tracking ?? 0;
  const width = measureText(s, style);
  let cx = x;
  if (style.align === 'center') cx = Math.round(x - width / 2);
  else if (style.align === 'right') cx = x - width;
  const capOffset = style.valign === 'cap' && font === 'body' ? -LATIN_TOP : 0;

  const passes: [number, number, number][] = [];
  if (style.outline !== undefined) {
    for (const [dx, dy] of [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ] as const)
      passes.push([style.outline, dx, dy]);
  }
  if (style.shadow !== undefined) passes.push([style.shadow, sc, sc]);
  passes.push([style.color, 0, 0]);

  for (const [col, dx, dy] of passes) {
    let px = cx;
    for (const ch of s) {
      const m = maskFor(ch.codePointAt(0)!, ch, font);
      stamp(cv, m, px + dx, y + capOffset * sc + m.top * sc + dy, sc, col);
      px += (m.advance + tr) * sc;
    }
  }
  return width;
}

/** Wrap `s` on spaces to at most `maxW` px per line. Hangeul strings without spaces break between syllables. */
export function wrapText(s: string, maxW: number, style: Pick<TextStyle, 'font' | 'tracking' | 'scale'> = {}): string[] {
  const lines: string[] = [];
  for (const para of s.split('\n')) {
    let line = '';
    const words = para.split(' ');
    for (const word of words) {
      const trial = line ? `${line} ${word}` : word;
      if (measureText(trial, style) <= maxW) {
        line = trial;
        continue;
      }
      if (line) lines.push(line);
      if (measureText(word, style) <= maxW) line = word;
      else {
        // an over-long word (or unspaced Hangeul): break by glyph
        let part = '';
        for (const ch of word) {
          if (measureText(part + ch, style) > maxW && part) {
            lines.push(part);
            part = ch;
          } else part += ch;
        }
        line = part;
      }
    }
    lines.push(line);
  }
  return lines;
}
