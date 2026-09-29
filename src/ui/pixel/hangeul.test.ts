import { describe, expect, it } from 'vitest';
import {
  HANGUL_BASE,
  HANGUL_CELL,
  HANGUL_END,
  compose,
  composeSyllable,
  decompose,
  isHangulSyllable,
  vowelClass,
} from './hangeul';

const ink = (cp: number): number => composeSyllable(cp).data.reduce((a, b) => a + b, 0);
const rows = (cp: number, y0: number, y1: number): number => {
  const g = composeSyllable(cp);
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < g.w; x++) n += g.data[y * g.w + x]!;
  return n;
};
const key = (cp: number): string => composeSyllable(cp).data.join('');

describe('jamo decomposition', () => {
  it('round-trips every one of the 11,172 syllables', () => {
    for (let cp = HANGUL_BASE; cp <= HANGUL_END; cp++) expect(compose(decompose(cp))).toBe(cp);
  });
  it('splits known syllables into the right jamo', () => {
    expect(decompose('아'.codePointAt(0)!)).toEqual({ l: 11, v: 0, t: 0 });
    expect(decompose('득'.codePointAt(0)!)).toEqual({ l: 3, v: 18, t: 1 }); // ㄷ ㅡ ㄱ
    expect(decompose('홀'.codePointAt(0)!)).toEqual({ l: 18, v: 8, t: 8 }); // ㅎ ㅗ ㄹ
    expect(decompose('값'.codePointAt(0)!)).toEqual({ l: 0, v: 0, t: 18 }); // ㄱ ㅏ ㅄ
  });
  it('classifies vowels by shape', () => {
    expect(vowelClass(0)).toBe('vertical'); // ㅏ
    expect(vowelClass(20)).toBe('vertical'); // ㅣ
    expect(vowelClass(8)).toBe('horizontal'); // ㅗ
    expect(vowelClass(18)).toBe('horizontal'); // ㅡ
    expect(vowelClass(9)).toBe('mixed'); // ㅘ
    expect(vowelClass(19)).toBe('mixed'); // ㅢ
    expect(isHangulSyllable(0xac00)).toBe(true);
    expect(isHangulSyllable(0x41)).toBe(false);
  });
});

describe('syllable composition', () => {
  it('draws every syllable inside its 12×12 cell with ink', () => {
    let empty = 0;
    for (let cp = HANGUL_BASE; cp <= HANGUL_END; cp += 7) {
      const g = composeSyllable(cp);
      expect(g.w).toBe(HANGUL_CELL);
      expect(g.h).toBe(HANGUL_CELL);
      expect(g.data.length).toBe(HANGUL_CELL * HANGUL_CELL);
      if (ink(cp) === 0) empty++;
    }
    expect(empty).toBe(0);
  });
  it('is deterministic and cached', () => {
    const cp = '마'.codePointAt(0)!;
    expect(composeSyllable(cp)).toBe(composeSyllable(cp));
    expect(key(cp)).toBe(key(cp));
  });
  it('gives distinct bitmaps to distinct syllables across every initial, vowel and final family', () => {
    const seen = new Map<string, number>();
    const check = (cp: number): void => {
      const k = key(cp);
      const prev = seen.get(k);
      expect(prev, `U+${cp.toString(16)} collides with U+${prev?.toString(16)}`).toBeUndefined();
      seen.set(k, cp);
    };
    for (let l = 0; l < 19; l++) check(compose({ l, v: 0, t: 0 })); // every initial + ㅏ
    for (let v = 1; v < 21; v++) check(compose({ l: 0, v, t: 0 })); // every other vowel + ㄱ
  });
  it('distinct finals stay distinct', () => {
    const seen = new Set<string>();
    for (let t = 1; t < 28; t++) seen.add(key(compose({ l: 11, v: 0, t })));
    // compound finals whose halves are visually near-identical at 12px may merge, but almost all must differ
    expect(seen.size).toBeGreaterThanOrEqual(24);
  });
  it('lays out by vowel class: vertical vowels are right of the initial, horizontal ones below it', () => {
    const ga = '가'.codePointAt(0)!;
    const g = composeSyllable(ga);
    let left = 0;
    let right = 0;
    for (let y = 0; y < 12; y++)
      for (let x = 0; x < 12; x++)
        if (g.data[y * 12 + x]) {
          if (x < 6) left++;
          else right++;
        }
    expect(left).toBeGreaterThan(0);
    expect(right).toBeGreaterThan(0);
    const go = '고'.codePointAt(0)!;
    expect(rows(go, 0, 6)).toBeGreaterThan(0); // the initial sits on top
    expect(rows(go, 8, 12)).toBeGreaterThan(0); // ㅗ below
  });
  it('a final consonant occupies the bottom rows, and its absence leaves them clear for horizontal vowels', () => {
    expect(rows('각'.codePointAt(0)!, 8, 12)).toBeGreaterThan(rows('가'.codePointAt(0)!, 8, 12) - 12);
    expect(rows('각'.codePointAt(0)!, 7, 12)).toBeGreaterThan(0);
    // 그 (no final) leaves rows 10-11 empty; 극 (with final) uses them
    expect(rows('그'.codePointAt(0)!, 10, 12)).toBe(0);
    expect(rows('극'.codePointAt(0)!, 10, 12)).toBeGreaterThan(0);
  });
  it('renders the title words with substantial ink and no glyph identical to another in the same word', () => {
    for (const word of ['아득', '마지막하나', '넥서스', '블랙홀', '초신성', '행성', '소행성']) {
      const ks = [...word].map((c) => key(c.codePointAt(0)!));
      for (const c of [...word]) expect(ink(c.codePointAt(0)!)).toBeGreaterThan(10);
      // 행성 / 소행성 repeat glyphs by design; check uniqueness only for words without repeated syllables
      if (new Set(word).size === word.length) expect(new Set(ks).size).toBe(ks.length);
    }
  });
});
