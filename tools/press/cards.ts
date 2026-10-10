import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { DEFAULT_LIGHTING, type TitanDef, type TitanId } from '../../src/contracts';
import { getTitanDef, witnessDef } from '../../src/titans';
import { renderPortrait, type Portrait } from '../../src/titans/portrait';
import { PixelCanvas } from '../../src/ui/pixel/canvas';
import { drawText, lineHeight, wrapText } from '../../src/ui/pixel/text';
import { PRESS } from './common';

/**
 * Character cards: each titan's pristine portrait (the game's own painter, src/titans/portrait.ts) with its English and
 * Korean name, tagline and a short line of its mechanic, in the game's pixel font, on transparency, every game pixel ×6.
 * Plus the bare portraits at ×6. → press/cards/<titan>-card.png, press/cards/<titan>-portrait.png
 *   npx tsx tools/press/cards.ts
 */
const S = 6;
const OUT = `${PRESS}/cards`;
mkdirSync(OUT, { recursive: true });

const TITANS: { file: string; id: TitanId }[] = [
  { file: 'witness', id: 'lastone' },
  { file: 'planet', id: 'planet' },
  { file: 'asteroid', id: 'asteroid' },
  { file: 'nexus', id: 'nexus' },
  { file: 'blackhole', id: 'blackhole' },
  { file: 'supernova', id: 'supernova' },
  { file: 'uri', id: 'uri' },
];

const hex = (h: string): number => {
  const v = parseInt(h.slice(1), 16);
  return (0xff000000 | ((v & 0xff) << 16) | (v & 0xff00) | ((v >> 16) & 0xff)) >>> 0;
};
const INK = 0xfff0ece8;
const DIM = 0xffb8aca4;
const EDGE = 0xff140a0a;
const firstSentence = (s: string): string => (/^.*?[.!?](\s|$)/.exec(s)?.[0] ?? s).trim();

function writeScaled(path: string, cv: { pixels: Uint32Array; w: number; h: number }): void {
  const png = new PNG({ width: cv.w * S, height: cv.h * S });
  for (let y = 0; y < cv.h * S; y++)
    for (let x = 0; x < cv.w * S; x++) {
      const c = cv.pixels[Math.floor(y / S) * cv.w + Math.floor(x / S)]!;
      const o = (y * cv.w * S + x) * 4;
      png.data[o] = c & 255;
      png.data[o + 1] = (c >>> 8) & 255;
      png.data[o + 2] = (c >>> 16) & 255;
      png.data[o + 3] = c >>> 24;
    }
  writeFileSync(path, PNG.sync.write(png));
}

function card(def: TitanDef, p: Portrait): PixelCanvas {
  const W = Math.max(p.w, 216) + 16;
  const textW = W - 16;
  const tag = wrapText(def.ui.tagline, textW);
  const mech = wrapText(`${def.passive.name}: ${firstSentence(def.passive.text)}`, textW);
  const fail = wrapText(`When it breaks: ${def.failureMode.name}`, textW);
  const L = lineHeight();
  const H = 8 + p.h + 10 + 2 * L + 4 + L + 6 + tag.length * L + 6 + mech.length * L + 2 + fail.length * L + 8;
  const cv = new PixelCanvas(W, H);
  const px = (W - p.w) >> 1;
  for (let y = 0; y < p.h; y++)
    for (let x = 0; x < p.w; x++) {
      const c = p.pixels[y * p.w + x]!;
      if (c >>> 24) cv.pixels[(8 + y) * W + px + x] = c;
    }
  const accent = hex(def.ui.accent);
  const accent2 = hex(def.ui.accent2);
  let y = 8 + p.h + 10;
  const english = def.id === 'uri' ? 'URI' : def.name.toUpperCase();
  drawText(cv, english, W >> 1, y, { color: accent, outline: EDGE, scale: 2, align: 'center', tracking: 1 });
  y += 2 * L + 4;
  drawText(cv, def.nameKo, W >> 1, y, { color: INK, outline: EDGE, align: 'center' });
  y += L + 6;
  for (const l of tag) {
    drawText(cv, l, W >> 1, y, { color: accent2, outline: EDGE, align: 'center' });
    y += L;
  }
  y += 6;
  for (const l of mech) {
    drawText(cv, l, W >> 1, y, { color: INK, outline: EDGE, align: 'center' });
    y += L;
  }
  y += 2;
  for (const l of fail) {
    drawText(cv, l, W >> 1, y, { color: DIM, outline: EDGE, align: 'center' });
    y += L;
  }
  return cv;
}

for (const t of TITANS) {
  const base = getTitanDef(t.id);
  const def = t.id === 'lastone' ? witnessDef(base) : base;
  const p = renderPortrait(t.id, 1, DEFAULT_LIGHTING, t.id === 'lastone');
  writeScaled(`${OUT}/${t.file}-portrait.png`, p);
  const cv = card(def, p);
  writeScaled(`${OUT}/${t.file}-card.png`, cv);
  console.log(`${t.file}: portrait ${p.w}×${p.h} → ×${S}, card ${cv.w * S}×${cv.h * S}`);
}
