/**
 * Hangeul syllable composer.
 *
 * Every one of the 11,172 precomposed syllables (U+AC00…U+D7A3) is composed at runtime from its jamo — initial (choseong),
 * medial (jungseong), final (jongseong) — the way a hand-built pixel font does it: the *layout* depends on the vowel
 * (vertical vowels sit to the right of the initial, horizontal ones below it, mixed ones do both) and on whether a final
 * consonant exists, and each jamo is drawn with a stroke recipe fitted to the box it lands in. A ㅁ in a 6×6 box and a ㅁ in
 * a 10×4 box are both crisp 1-pixel-stroke shapes, not a scaled bitmap.
 *
 * Glyphs are 12×12 (advance 13 in text). Larger sizes (the logotype) are integer upscales of these — pixel-honest.
 */

export const HANGUL_CELL = 12;

export interface HangulGlyph {
  w: number;
  h: number;
  /** 1 = ink. Row-major, w×h. */
  data: Uint8Array;
}

export const HANGUL_BASE = 0xac00;
export const HANGUL_END = 0xd7a3;

export const isHangulSyllable = (cp: number): boolean => cp >= HANGUL_BASE && cp <= HANGUL_END;

export interface Jamo {
  /** 0..18 */
  l: number;
  /** 0..20 */
  v: number;
  /** 0..27 (0 = none) */
  t: number;
}

export function decompose(cp: number): Jamo {
  const s = cp - HANGUL_BASE;
  return { l: Math.floor(s / 588), v: Math.floor((s % 588) / 28), t: s % 28 };
}

export function compose(j: Jamo): number {
  return HANGUL_BASE + (j.l * 21 + j.v) * 28 + j.t;
}

type Kind = 'g' | 'n' | 'd' | 'r' | 'm' | 'b' | 's' | 'o' | 'j' | 'c' | 'k' | 't' | 'p' | 'h';

/** Choseong 0..18 → stroke recipe(s). Doubles are two copies of the base shape side by side. */
const INITIALS: readonly (readonly Kind[])[] = [
  ['g'], ['g', 'g'], ['n'], ['d'], ['d', 'd'], ['r'], ['m'], ['b'], ['b', 'b'], ['s'],
  ['s', 's'], ['o'], ['j'], ['j', 'j'], ['c'], ['k'], ['t'], ['p'], ['h'],
]; // prettier-ignore

/** Jongseong 1..27 (index 0 unused). */
const FINALS: readonly (readonly Kind[])[] = [
  [], ['g'], ['g', 'g'], ['g', 's'], ['n'], ['n', 'j'], ['n', 'h'], ['d'], ['r'], ['r', 'g'], ['r', 'm'],
  ['r', 'b'], ['r', 's'], ['r', 't'], ['r', 'p'], ['r', 'h'], ['m'], ['b'], ['b', 's'], ['s'], ['s', 's'],
  ['o'], ['j'], ['c'], ['k'], ['t'], ['p'], ['h'],
]; // prettier-ignore

/** Vowel classes by jungseong index (ㅏ0 ㅐ1 ㅑ2 ㅒ3 ㅓ4 ㅔ5 ㅕ6 ㅖ7 ㅗ8 ㅘ9 ㅙ10 ㅚ11 ㅛ12 ㅜ13 ㅝ14 ㅞ15 ㅟ16 ㅠ17 ㅡ18 ㅢ19 ㅣ20). */
export type VowelClass = 'vertical' | 'horizontal' | 'mixed';
export function vowelClass(v: number): VowelClass {
  if (v <= 7 || v === 20) return 'vertical';
  if (v === 8 || v === 12 || v === 13 || v === 17 || v === 18) return 'horizontal';
  return 'mixed';
}

/* ------------------------------------------------------------------------------------------------ *
 *  raster (1-pixel strokes only)
 * ------------------------------------------------------------------------------------------------ */
class Mask {
  readonly d: Uint8Array;
  constructor(readonly n: number) {
    this.d = new Uint8Array(n * n);
  }
  dot(x: number, y: number): void {
    if (x >= 0 && y >= 0 && x < this.n && y < this.n) this.d[y * this.n + x] = 1;
  }
  clear(x: number, y: number): void {
    if (x >= 0 && y >= 0 && x < this.n && y < this.n) this.d[y * this.n + x] = 0;
  }
  hl(y: number, x0: number, x1: number): void {
    if (x1 < x0) [x0, x1] = [x1, x0];
    for (let x = x0; x <= x1; x++) this.dot(x, y);
  }
  vl(x: number, y0: number, y1: number): void {
    if (y1 < y0) [y0, y1] = [y1, y0];
    for (let y = y0; y <= y1; y++) this.dot(x, y);
  }
  /** Bresenham. */
  diag(x0: number, y0: number, x1: number, y1: number): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    for (;;) {
      this.dot(x, y);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
  }
}

/** Inclusive pixel box. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* ------------------------------------------------------------------------------------------------ *
 *  consonant recipes
 * ------------------------------------------------------------------------------------------------ */
function consonant(m: Mask, kind: Kind, b: Box): void {
  if (b.w < 1 || b.h < 1) return;
  const x0 = b.x;
  const y0 = b.y;
  const xe = b.x + b.w - 1;
  const ye = b.y + b.h - 1;
  const mid = y0 + Math.floor((b.h - 1) / 2);
  switch (kind) {
    case 'g':
      m.hl(y0, x0, xe);
      m.vl(xe, y0, ye);
      break;
    case 'n':
      m.vl(x0, y0, ye);
      m.hl(ye, x0, xe);
      break;
    case 'd':
      m.hl(y0, x0, xe);
      m.vl(x0, y0, ye);
      m.hl(ye, x0, xe);
      break;
    case 'r':
      if (b.h >= 5) {
        const a = y0 + Math.floor((b.h - 1) / 2);
        m.hl(y0, x0, xe);
        m.vl(xe, y0, a);
        m.hl(a, x0, xe);
        m.vl(x0, a, ye);
        m.hl(ye, x0, xe);
      } else {
        // Too short for three bars: the classic squeezed ㄹ — top bar, right stroke, left stroke, bottom bar.
        m.hl(y0, x0, xe);
        m.vl(xe, y0, y0 + Math.max(0, b.h - 3));
        m.vl(x0, ye - Math.max(0, b.h - 3), ye);
        if (b.h >= 4) {
          m.dot(xe, y0 + 1);
          m.dot(x0, ye - 1);
        }
        m.hl(ye, x0, xe);
        if (b.h === 3) m.hl(mid, x0, xe);
      }
      break;
    case 'm':
      m.hl(y0, x0, xe);
      m.hl(ye, x0, xe);
      m.vl(x0, y0, ye);
      m.vl(xe, y0, ye);
      break;
    case 'b': {
      const a = b.h >= 5 ? mid : y0 + 1;
      m.vl(x0, y0, ye);
      m.vl(xe, y0, ye);
      m.hl(a, x0, xe);
      m.hl(ye, x0, xe);
      break;
    }
    case 's':
      apex(m, b);
      break;
    case 'o':
      ring(m, b);
      break;
    case 'j':
      m.hl(y0, x0, xe);
      apex(m, { x: b.x, y: b.y + 1, w: b.w, h: b.h - 1 });
      break;
    case 'c': {
      const cx = x0 + Math.floor((b.w - 1) / 2);
      if (b.h >= 5) {
        m.dot(cx, y0);
        m.hl(y0 + 1, x0, xe);
        apex(m, { x: b.x, y: b.y + 2, w: b.w, h: b.h - 2 });
      } else {
        m.hl(y0, x0 + 1, xe - 1);
        apex(m, { x: b.x, y: b.y + 1, w: b.w, h: b.h - 1 });
        m.dot(cx, y0 - 1);
      }
      break;
    }
    case 'k':
      m.hl(y0, x0, xe);
      m.hl(mid, x0, xe);
      m.vl(xe, y0, ye);
      break;
    case 't':
      m.hl(y0, x0, xe);
      m.hl(mid, x0, xe);
      m.hl(ye, x0, xe);
      m.vl(x0, y0, ye);
      break;
    case 'p': {
      const inset = b.w >= 5 ? 1 : 0;
      m.hl(y0, x0, xe);
      m.hl(ye, x0, xe);
      m.vl(x0 + inset, y0, ye);
      m.vl(xe - inset, y0, ye);
      break;
    }
    case 'h': {
      const cx = x0 + Math.floor((b.w - 1) / 2);
      if (b.h >= 5) {
        m.hl(y0, cx - 1, cx + 1);
        m.hl(y0 + 1, x0, xe);
        ring(m, { x: x0 + (b.w >= 6 ? 1 : 0), y: y0 + 2, w: b.w - (b.w >= 6 ? 2 : 0), h: b.h - 2 });
      } else {
        m.dot(cx, y0);
        m.hl(y0 + 1, x0, xe);
        ring(m, { x: x0 + 1, y: y0 + 2, w: Math.max(3, b.w - 2), h: b.h - 2 });
      }
      break;
    }
  }
}

/** ㅅ: two strokes leaving one apex. */
function apex(m: Mask, b: Box): void {
  const cx = b.x + Math.floor((b.w - 1) / 2);
  const ye = b.y + b.h - 1;
  const xe = b.x + b.w - 1;
  const run = b.h >= 6 ? 1 : 0; // a short vertical at the apex for tall boxes
  m.vl(cx, b.y, b.y + run);
  m.diag(cx - 1, b.y + run + 1, b.x, ye);
  m.diag(cx + 1, b.y + run + 1, xe, ye);
  if (b.w % 2 === 0) m.dot(cx + 1, b.y); // even-width apex is two pixels wide
}

/** ㅇ: rectangular ring with the four corner pixels removed (reads as round at small sizes). */
function ring(m: Mask, b: Box): void {
  const xe = b.x + b.w - 1;
  const ye = b.y + b.h - 1;
  if (b.h <= 2) {
    // Two rows: a bowl (the lower half of a ring) — with a bar above it this still reads as ㅎ.
    m.dot(b.x, b.y);
    m.dot(xe, b.y);
    m.hl(ye, b.x + 1, xe - 1);
    return;
  }
  const cut = b.w >= 4 && b.h >= 4 ? 1 : 0;
  m.hl(b.y, b.x + cut, xe - cut);
  m.hl(ye, b.x + cut, xe - cut);
  m.vl(b.x, b.y + cut, ye - cut);
  m.vl(xe, b.y + cut, ye - cut);
  if (cut === 0 && b.h === 3 && b.w >= 3) m.clear(b.x + Math.floor((b.w - 1) / 2), b.y + 1);
}

function drawConsonants(m: Mask, kinds: readonly Kind[], b: Box): void {
  if (kinds.length === 0) return;
  if (kinds.length === 1) {
    consonant(m, kinds[0]!, b);
    return;
  }
  const gap = b.w >= 8 ? 1 : 0;
  const w0 = Math.ceil((b.w - gap) / 2);
  const w1 = b.w - gap - w0;
  consonant(m, kinds[0]!, { x: b.x, y: b.y, w: w0, h: b.h });
  consonant(m, kinds[1]!, { x: b.x + w0 + gap, y: b.y, w: w1, h: b.h });
}

/* ------------------------------------------------------------------------------------------------ *
 *  vowel recipes
 * ------------------------------------------------------------------------------------------------ */
interface VertFlavour {
  nubs: 0 | 1 | 2;
  /** +1: nubs on the right of the stem (ㅏ family). −1: on the left (ㅓ family). */
  dir: 1 | -1;
  /** ㅐ ㅔ ㅒ ㅖ: a second stem. */
  stem2: boolean;
}
const VERT: Record<number, VertFlavour> = {
  0: { nubs: 1, dir: 1, stem2: false }, // ㅏ
  1: { nubs: 1, dir: 1, stem2: true }, // ㅐ
  2: { nubs: 2, dir: 1, stem2: false }, // ㅑ
  3: { nubs: 2, dir: 1, stem2: true }, // ㅒ
  4: { nubs: 1, dir: -1, stem2: false }, // ㅓ
  5: { nubs: 1, dir: -1, stem2: true }, // ㅔ
  6: { nubs: 2, dir: -1, stem2: false }, // ㅕ
  7: { nubs: 2, dir: -1, stem2: true }, // ㅖ
  20: { nubs: 0, dir: 1, stem2: false }, // ㅣ
};

/** Vertical vowel (ㅏ ㅐ ㅑ ㅒ ㅓ ㅔ ㅕ ㅖ ㅣ) in box b: stem(s) full height, nubs at 1/2 (or 1/3 & 2/3). */
function vertVowel(m: Mask, v: number, b: Box): void {
  const f = VERT[v]!;
  const ye = b.y + b.h - 1;
  const xe = b.x + b.w - 1;
  const nubLen = b.w >= 5 ? 2 : 1;
  let rows: number[];
  if (f.nubs === 0) rows = [];
  else if (f.nubs === 1) rows = [b.y + Math.floor((b.h - 1) / 2)];
  else {
    const a = b.y + Math.round((b.h - 1) * 0.3);
    rows = [a, Math.min(ye, Math.max(a + 2, b.y + Math.round((b.h - 1) * 0.7)))];
  }
  if (f.nubs === 0) {
    m.vl(b.x + Math.floor((b.w - 1) / 2), b.y, ye);
    return;
  }
  if (f.dir === 1) {
    // ㅏ family: stem at the left edge, nubs to its right; ㅐ ㅒ add a stem that the nub bridges to.
    const sx = b.x;
    m.vl(sx, b.y, ye);
    const nubEnd = f.stem2 ? sx + 2 : sx + nubLen;
    for (const y of rows) m.hl(y, sx + 1, nubEnd);
    if (f.stem2) m.vl(nubEnd, b.y, ye);
  } else {
    // ㅓ family: nubs to the LEFT of the stem; ㅔ ㅖ add a second stem to its right.
    const sx = f.stem2 ? xe - 2 : xe - (b.w >= 5 ? 1 : 0);
    const stem = Math.min(sx, xe);
    m.vl(stem, b.y, ye);
    for (const y of rows) m.hl(y, stem - nubLen, stem - 1);
    if (f.stem2) m.vl(Math.min(xe, stem + 2), b.y, ye);
  }
}

/** Horizontal vowel (ㅗ ㅛ ㅜ ㅠ ㅡ) in box b; nub length is derived from the box height. */
function horzVowel(m: Mask, v: number, b: Box): void {
  const xe = b.x + b.w - 1;
  const ye = b.y + b.h - 1;
  if (v === 18) {
    m.hl(b.y + Math.floor((b.h - 1) / 2), b.x, xe);
    return;
  }
  const up = v === 8 || v === 12; // ㅗ ㅛ: stems point up from a line at the bottom
  const two = v === 12 || v === 17;
  const lineY = up ? ye : b.y;
  m.hl(lineY, b.x, xe);
  const cx = b.x + Math.floor((b.w - 1) / 2);
  const stems = two ? [b.x + Math.round((b.w - 1) * 0.3), b.x + Math.round((b.w - 1) * 0.7)] : [cx];
  for (const sx of stems) {
    if (up) m.vl(sx, b.y, lineY);
    else m.vl(sx, lineY, ye);
  }
}

/* ------------------------------------------------------------------------------------------------ *
 *  syllable layout on the 12×12 grid
 * ------------------------------------------------------------------------------------------------ */
const cache = new Map<number, HangulGlyph>();

/** Compose one syllable into a 12×12 mask. Results are cached. */
export function composeSyllable(cp: number): HangulGlyph {
  const hit = cache.get(cp);
  if (hit) return hit;
  const { l, v, t } = decompose(cp);
  const m = new Mask(HANGUL_CELL);
  layout(m, l, v, t);
  const g: HangulGlyph = { w: HANGUL_CELL, h: HANGUL_CELL, data: m.d };
  if (cache.size > 4000) cache.clear();
  cache.set(cp, g);
  return g;
}

function layout(m: Mask, l: number, v: number, t: number): void {
  const cls = vowelClass(v);
  const init = INITIALS[l]!;
  const fin = FINALS[t]!;
  const hasFinal = fin.length > 0;

  if (cls === 'vertical') {
    if (!hasFinal) {
      drawConsonants(m, init, { x: 0, y: 2, w: 6, h: 8 });
      vertVowel(m, v, { x: 7, y: 0, w: 5, h: 12 });
    } else {
      drawConsonants(m, init, { x: 0, y: 0, w: 6, h: 6 });
      vertVowel(m, v, { x: 7, y: 0, w: 5, h: 6 });
      drawConsonants(m, fin, { x: 1, y: 7, w: 10, h: 5 });
    }
    return;
  }

  if (cls === 'horizontal') {
    if (!hasFinal) {
      drawConsonants(m, init, { x: 2, y: 1, w: 8, h: 6 });
      horzVowel(m, v, { x: 0, y: 8, w: 12, h: v === 18 ? 1 : 3 });
    } else if (v === 18) {
      // ㅡ + final: ㅡ is a single line, which leaves room for a full 5-row final.
      drawConsonants(m, init, { x: 3, y: 0, w: 6, h: 4 });
      horzVowel(m, v, { x: 0, y: 5, w: 12, h: 1 });
      drawConsonants(m, fin, { x: 1, y: 7, w: 10, h: 5 });
    } else {
      drawConsonants(m, init, { x: 3, y: 0, w: 6, h: 4 });
      horzVowel(m, v, { x: 0, y: 5, w: 12, h: 2 });
      drawConsonants(m, fin, { x: 1, y: 8, w: 10, h: 4 });
    }
    return;
  }

  // mixed: horizontal part under the initial (left), vertical part on the right
  const vertOf: Record<number, number> = { 9: 0, 10: 1, 11: 20, 14: 4, 15: 5, 16: 20, 19: 20 };
  const horzOf: Record<number, number> = { 9: 8, 10: 8, 11: 8, 14: 13, 15: 13, 16: 13, 19: 18 };
  if (!hasFinal) {
    drawConsonants(m, init, { x: 0, y: 1, w: 6, h: 5 });
    horzVowel(m, horzOf[v]!, { x: 0, y: 7, w: 7, h: horzOf[v] === 18 ? 1 : 3 });
    vertVowel(m, vertOf[v]!, { x: 8, y: 0, w: 4, h: 12 });
  } else {
    drawConsonants(m, init, { x: 0, y: 0, w: 6, h: 4 });
    horzVowel(m, horzOf[v]!, { x: 0, y: 5, w: 7, h: horzOf[v] === 18 ? 1 : 2 });
    vertVowel(m, vertOf[v]!, { x: 8, y: 0, w: 4, h: 7 });
    drawConsonants(m, fin, { x: 1, y: 8, w: 10, h: 4 });
  }
}
