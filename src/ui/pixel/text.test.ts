import { describe, expect, it } from 'vitest';
import { PixelCanvas } from './canvas';
import { BODY_GLYPHS, MICRO_GLYPHS } from './font-data';
import { drawText, hasHangul, measureText, wrapClamp, wrapText } from './text';

const inked = (cv: PixelCanvas): { x0: number; x1: number; y0: number; y1: number; n: number } => {
  let x0 = cv.w;
  let x1 = -1;
  let y0 = cv.h;
  let y1 = -1;
  let n = 0;
  for (let y = 0; y < cv.h; y++)
    for (let x = 0; x < cv.w; x++)
      if (cv.pixels[y * cv.w + x]! >>> 24) {
        n++;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  return { x0, x1, y0, y1, n };
};

describe('bitmap font data', () => {
  it('covers every printable ASCII character in the body face', () => {
    for (let c = 32; c < 127; c++)
      expect(BODY_GLYPHS[String.fromCharCode(c)], `'${String.fromCharCode(c)}'`).toBeDefined();
  });
  it('has rectangular glyphs (every row as wide as the glyph) with at most 9 rows', () => {
    for (const [ch, g] of Object.entries(BODY_GLYPHS)) {
      expect(g.rows.length, ch).toBeLessThanOrEqual(9);
      for (const r of g.rows) expect(r.length, `${ch}: ${r}`).toBe(g.w);
    }
    for (const [ch, g] of Object.entries(MICRO_GLYPHS)) {
      expect(g.rows.length, ch).toBeLessThanOrEqual(5);
      for (const r of g.rows) expect(r.length, `${ch}: ${r}`).toBe(g.w);
    }
  });
  it('micro face covers digits and capitals', () => {
    for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:.-+/%') expect(MICRO_GLYPHS[c], c).toBeDefined();
  });
  it('gives every distinct body glyph a distinct picture', () => {
    const seen = new Map<string, string>();
    for (const [ch, g] of Object.entries(BODY_GLYPHS)) {
      if (ch === ' ' || g.rows.length === 0) continue;
      const k = g.rows.join('|');
      const prev = seen.get(k);
      // the two minus signs and the hyphen are intentionally the same picture
      if (prev && !['-', '−'].includes(ch)) expect(prev, `${ch} duplicates ${prev}`).toBeUndefined();
      seen.set(k, ch);
    }
  });
});

describe('measureText / drawText', () => {
  it('measures Latin at a 6px advance (5 + 1) minus the trailing gap, Hangeul at 13, micro at 4', () => {
    expect(measureText('')).toBe(0);
    expect(measureText('A')).toBe(5);
    expect(measureText('ABC')).toBe(17);
    expect(measureText('아')).toBe(12);
    expect(measureText('아득')).toBe(25);
    expect(measureText('ABC', { font: 'micro' })).toBe(11);
    expect(measureText('AB', { tracking: 2 })).toBe(13);
    expect(measureText('AB', { scale: 2 })).toBe(22);
  });
  it('draws inside the measured width and honours alignment', () => {
    const cv = new PixelCanvas(200, 40);
    const w = drawText(cv, 'HELLO', 100, 10, { color: 0xffffffff, align: 'center' });
    const b = inked(cv);
    expect(b.n).toBeGreaterThan(20);
    expect(b.x1 - b.x0 + 1).toBeLessThanOrEqual(w);
    expect(Math.abs((b.x0 + b.x1) / 2 - 100)).toBeLessThanOrEqual(2);
    cv.clear();
    drawText(cv, 'HELLO', 190, 10, { color: 0xffffffff, align: 'right' });
    expect(inked(cv).x1).toBe(189);
  });
  it('places Latin capitals centred against the Hangeul cell in a mixed line', () => {
    const a = new PixelCanvas(120, 30);
    drawText(a, 'A', 0, 4, { color: 0xffffffff });
    const la = inked(a);
    expect(la.y0).toBe(6); // caps start two rows below the box top …
    expect(la.y1).toBe(12); // … and end on the baseline
    const b = new PixelCanvas(120, 30);
    drawText(b, '가', 0, 4, { color: 0xffffffff });
    const lb = inked(b);
    expect(lb.y0).toBeGreaterThanOrEqual(4);
    expect(lb.y1).toBeLessThanOrEqual(15);
  });
  it("'cap' vertical alignment puts the top of capitals at y", () => {
    const cv = new PixelCanvas(40, 30);
    drawText(cv, 'H', 0, 10, { color: 0xffffffff, valign: 'cap' });
    expect(inked(cv).y0).toBe(10);
  });
  it('scales glyph pixels by an integer and draws an outline and shadow', () => {
    const cv = new PixelCanvas(60, 40);
    drawText(cv, 'I', 5, 5, { color: 0xffffffff, scale: 3, outline: 0xff000000 });
    const plain = new PixelCanvas(60, 40);
    drawText(plain, 'I', 5, 5, { color: 0xffffffff, scale: 3 });
    expect(inked(cv).n).toBeGreaterThan(inked(plain).n);
    expect(inked(plain).x1 - inked(plain).x0 + 1).toBe(15);
  });
  it('never draws outside the canvas (clipped)', () => {
    const cv = new PixelCanvas(20, 12);
    expect(() => drawText(cv, 'OVERFLOWING TEXT 한글', -10, -3, { color: 0xffffffff })).not.toThrow();
  });
  it('detects Hangeul', () => {
    expect(hasHangul('abc')).toBe(false);
    expect(hasHangul('a아')).toBe(true);
  });
});

describe('wrapping', () => {
  it('wraps on spaces to the pixel width', () => {
    const lines = wrapText('the quick brown fox jumps over the lazy dog', 80);
    for (const l of lines) expect(measureText(l)).toBeLessThanOrEqual(80);
    expect(lines.join(' ')).toBe('the quick brown fox jumps over the lazy dog');
    expect(lines.length).toBeGreaterThan(2);
  });
  it('breaks over-long words and unspaced Hangeul by glyph', () => {
    const lines = wrapText('가나다라마바사아자차카타파하', 60);
    for (const l of lines) expect(measureText(l)).toBeLessThanOrEqual(60);
    expect(lines.join('')).toBe('가나다라마바사아자차카타파하');
  });
  it('honours explicit newlines', () => {
    expect(wrapText('a\nb', 100)).toEqual(['a', 'b']);
  });
  it('wrapClamp truncates with an ellipsis that still fits', () => {
    const lines = wrapClamp('one two three four five six seven eight nine ten eleven twelve', 70, 2);
    expect(lines.length).toBe(2);
    expect(lines[1]!.endsWith('…')).toBe(true);
    for (const l of lines) expect(measureText(l)).toBeLessThanOrEqual(70);
    expect(wrapClamp('short', 100, 2)).toEqual(['short']);
  });
});
