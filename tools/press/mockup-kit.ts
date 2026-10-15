import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { DEFAULT_LIGHTING, hex } from '../../src/contracts';
import { renderPortrait } from '../../src/titans/portrait';
import { ROSTER } from '../../src/titans/roster';
import { PixelCanvas, type Sprite } from '../../src/ui/pixel/canvas';
import { logoSprite, logotypeMask } from '../../src/ui/pixel/logo';
import { drawText } from '../../src/ui/pixel/text';
import { CHROME, GOLD, titleType } from '../../src/ui/pixel/titleType';
import { PRESS } from './common';

/**
 * A loose kit for mocking up logo ideas elsewhere: the title type (bare letter shapes, the current celadon logotype, ADEUK
 * gold, TITANS chrome, the stacked pair) and every shipped titan on its own, all on transparency and integer-upscaled with
 * nearest neighbour, plus one labelled roster sheet on a dark plate.
 * → press/mockup-kit/
 *   npx tsx tools/press/mockup-kit.ts
 */
const OUT = `${PRESS}/mockup-kit`;
mkdirSync(`${OUT}/titans`, { recursive: true });

function write(path: string, s: Sprite, k: number, plate?: number): void {
  const png = new PNG({ width: s.w * k, height: s.h * k });
  for (let y = 0; y < s.h * k; y++)
    for (let x = 0; x < s.w * k; x++) {
      let c = s.pixels[Math.floor(y / k) * s.w + Math.floor(x / k)]!;
      if (!(c >>> 24) && plate !== undefined) c = plate;
      const o = (y * s.w * k + x) * 4;
      png.data[o] = c & 255;
      png.data[o + 1] = (c >>> 8) & 255;
      png.data[o + 2] = (c >>> 16) & 255;
      png.data[o + 3] = c >>> 24;
    }
  writeFileSync(`${OUT}/${path}`, PNG.sync.write(png));
  console.log(`${path}: ${s.w * k}×${s.h * k}`);
}

// --- type ----------------------------------------------------------------------------------------------------------
const shapes = (text: string): Sprite => {
  const m = logotypeMask(text);
  const white = hex('#ffffff');
  return { pixels: Uint32Array.from(m.d, (v) => (v ? white : 0)), w: m.w, h: m.h };
};
write('type-1-letter-shapes-white.png', shapes('ADEUK: TITANS'), 8);
write('type-2-current-logo.png', logoSprite(), 6);
const adeuk = titleType('ADEUK', GOLD);
const titans = titleType('TITANS', CHROME);
write('type-3-adeuk-gold.png', adeuk, 4);
write('type-4-titans-chrome.png', titans, 4);
// the stacked pair as in the emblem draft
const sw = Math.max(adeuk.w, titans.w);
const stack = new PixelCanvas(sw, adeuk.h + titans.h - 4);
const put = (s: Sprite, x0: number, y0: number): void => {
  for (let y = 0; y < s.h; y++)
    for (let x = 0; x < s.w; x++) {
      const c = s.pixels[y * s.w + x]!;
      if (c >>> 24) stack.pixels[(y0 + y) * sw + x0 + x] = c;
    }
};
put(adeuk, (sw - adeuk.w) >> 1, 0);
put(titans, (sw - titans.w) >> 1, adeuk.h - 4);
write('type-5-stacked-gold-chrome.png', stack, 4);

// --- titans ----------------------------------------------------------------------------------------------------------
const shown = ROSTER.filter((r) => !r.wip);
const portraits = shown.map((r) => ({
  r,
  p: renderPortrait(r.id, 1, DEFAULT_LIGHTING),
  name: r.site?.name ?? r.id,
}));
portraits.forEach(({ r, p, name }, i) => {
  // about 1000 px on the long side, integer factor, never under ×2
  const k = Math.max(2, Math.floor(1000 / Math.max(p.w, p.h)));
  const file = `${String(i + 1).padStart(2, '0')}-${(r.site?.file ?? r.id).toLowerCase()}`;
  write(`titans/${file}.png`, p, k);
  console.log(`  ${name}`);
});

// --- the roster sheet: 3 across, each titan as large as an integer factor fits its cell, name under it ----------------
const CELL = 420;
const LABEL = 48;
const cols = 3;
const rows = Math.ceil(portraits.length / cols);
const sheet = new PixelCanvas(cols * CELL, rows * (CELL + LABEL));
sheet.pixels.fill(hex('#0c0b18'));
portraits.forEach(({ p, name }, i) => {
  const cx = (i % cols) * CELL;
  const cy = Math.floor(i / cols) * (CELL + LABEL);
  const k = Math.max(1, Math.floor((CELL - 30) / Math.max(p.w, p.h)));
  const x0 = cx + ((CELL - p.w * k) >> 1);
  const y0 = cy + ((CELL - p.h * k) >> 1);
  for (let y = 0; y < p.h * k; y++)
    for (let x = 0; x < p.w * k; x++) {
      const c = p.pixels[Math.floor(y / k) * p.w + Math.floor(x / k)]!;
      if (c >>> 24) sheet.pixels[(y0 + y) * sheet.w + x0 + x] = c;
    }
  drawText(sheet, name.toUpperCase(), cx + CELL / 2, cy + CELL + 4, {
    color: hex('#f2ead8'),
    shadow: hex('#000000'),
    scale: 3,
    align: 'center',
  });
});
write('roster-sheet.png', sheet, 1);
