import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { logoSprite } from '../../../src/ui/pixel/logo';
import { PixelCanvas } from '../../../src/ui/pixel/canvas';
import { drawText, measureText } from '../../../src/ui/pixel/text';
import { OPEN_FRAMES, OPEN_TOUCH, TWORK } from './paths';

/**
 * The trailer's made-in-code pixels, all at the game's 640×360 (composited ×3 nearest): the opening (shot 1: black, one
 * pixel of light, a second far away, they touch: a tiny flash), the text cards in the game's own pixel font at whole-number
 * scales (transparent overlays and black cards), and the logo card (shot 8).
 *   npx tsx tools/press/trailer/art.ts
 */
const LW = 640;
const LH = 360;
const INK = 0xfff0ece8;
const EDGE = 0xff0a0606;

function writeFrame(path: string, cv: PixelCanvas, opaque: boolean): void {
  const png = new PNG({ width: cv.w, height: cv.h });
  for (let i = 0; i < cv.pixels.length; i++) {
    const c = cv.pixels[i]!;
    png.data[i * 4] = c & 255;
    png.data[i * 4 + 1] = (c >>> 8) & 255;
    png.data[i * 4 + 2] = (c >>> 16) & 255;
    png.data[i * 4 + 3] = opaque ? 255 : c >>> 24;
  }
  writeFileSync(path, PNG.sync.write(png));
}

/** A line of text, centred, at a whole-number scale, with a 1-px (×scale) dark outline so it reads over any picture. */
function line(cv: PixelCanvas, s: string, y: number, scale: number, color = INK, tracking = 1): void {
  drawText(cv, s, LW >> 1, y, { color, outline: EDGE, scale, align: 'center', tracking });
}

interface CardSpec {
  id: string;
  lines: { s: string; scale: number; color?: number; gap?: number }[];
  /** 'over': transparent overlay at `y` (top of the block, game px); 'black': centred on black */
  kind: 'over' | 'black';
  y?: number;
}

const CARDS: CardSpec[] = [
  { id: 'adeuk', kind: 'over', y: 268, lines: [{ s: '아득', scale: 4 }] },
  ...(['PERCEPTION', 'GRAVITY', 'MOMENTUM', 'POSSESSION', 'ABSENCE', 'SACRIFICE'] as const).map(
    (w): CardSpec => ({ id: `word-${w.toLowerCase()}`, kind: 'over', y: 300, lines: [{ s: w, scale: 3 }] }),
  ),
  { id: 'two-worlds', kind: 'black', lines: [{ s: 'TWO WORLDS. ONE BODY.', scale: 3 }] },
  { id: 'uri', kind: 'over', y: 262, lines: [{ s: '우리', scale: 5 }] },
  { id: 'no-health-bars', kind: 'black', lines: [{ s: 'NO HEALTH BARS.', scale: 4 }] },
  { id: 'body-is-the-bar', kind: 'black', lines: [{ s: 'YOUR BODY IS THE BAR.', scale: 3 }] },
  { id: 'something-felt-it', kind: 'over', y: 150, lines: [{ s: 'SOMETHING FELT IT.', scale: 3 }] },
];

function card(c: CardSpec): PixelCanvas {
  const cv = new PixelCanvas(LW, LH);
  if (c.kind === 'black') cv.clear(0xff000000);
  const heights = c.lines.map((l) => 12 * l.scale);
  const total = heights.reduce((a, h) => a + h, 0) + c.lines.slice(1).reduce((a, l) => a + (l.gap ?? 6), 0);
  let y = c.kind === 'black' ? (LH - total) >> 1 : c.y!;
  c.lines.forEach((l, i) => {
    line(cv, l.s, y, l.scale, l.color);
    y += heights[i]! + (c.lines[i + 1]?.gap ?? 6);
  });
  return cv;
}

/** Shot 8: the logo ×4 with the three lines under it, on black. */
function logoCard(): PixelCanvas {
  const cv = new PixelCanvas(LW, LH);
  cv.clear(0xff000000);
  const logo = logoSprite();
  const k = 2;
  const x0 = (LW - logo.w * k) >> 1;
  const y0 = 92;
  for (let y = 0; y < logo.h * k; y++)
    for (let x = 0; x < logo.w * k; x++) {
      const c = logo.pixels[Math.floor(y / k) * logo.w + Math.floor(x / k)]!;
      const a = c >>> 24;
      if (!a) continue;
      const t = a / 255;
      const m = (s: number): number => Math.round(((c >>> s) & 255) * t) << s;
      cv.pixels[(y0 + y) * LW + x0 + x] = (0xff000000 | m(16) | m(8) | m(0)) >>> 0;
    }
  line(cv, '아득', y0 + logo.h * k + 14, 2, 0xffe8dcc8);
  line(cv, 'FREE IN YOUR BROWSER', 236, 2);
  line(cv, 'FINAL BOSS: COMING', 276, 2, 0xff3a3ac8);
  return cv;
}

/** Shot 1: 4 s at 60 fps. Black; a warm pixel; a cool one far away; they drift together; a tiny flash where they touch. */
function opening(f: number): PixelCanvas {
  const cv = new PixelCanvas(LW, LH);
  cv.clear(0xff000000);
  const warm = 0xff8fd8ff; // packed ABGR: a warm white
  const cool = 0xffffd2a8; // a cool blue-white
  const cy = 182;
  const u = Math.min(1, f / OPEN_TOUCH);
  const e = u * u * (3 - 2 * u);
  const ax = Math.round(232 + (319 - 232) * e);
  const bx = Math.round(470 + (321 - 470) * e);
  if (f >= 20 && f < OPEN_TOUCH) cv.put(ax, cy, warm);
  if (f >= 70 && f < OPEN_TOUCH) cv.put(bx, cy, cool);
  // the flash: a 1-px point, then a small stepped star, gone in under a second
  const t = f - OPEN_TOUCH;
  if (t >= 0 && t < 40) {
    const r = t < 3 ? 1 : t < 8 ? 3 : t < 16 ? 2 : t < 26 ? 1 : 0;
    const c = t < 8 ? 0xffffffff : t < 16 ? 0xffc8f0ff : 0xff80c8ff;
    cv.put(320, cy, c);
    for (let k = 1; k <= r; k++) {
      cv.put(320 + k, cy, c);
      cv.put(320 - k, cy, c);
      cv.put(320, cy + k, c);
      cv.put(320, cy - k, c);
    }
    if (t >= 3 && t < 12) {
      cv.put(321, cy + 1, c);
      cv.put(319, cy - 1, c);
      cv.put(321, cy - 1, c);
      cv.put(319, cy + 1, c);
    }
  }
  return cv;
}

mkdirSync(`${TWORK}/cards`, { recursive: true });
for (const c of CARDS) writeFrame(`${TWORK}/cards/${c.id}.png`, card(c), c.kind === 'black');
writeFrame(`${TWORK}/cards/logo-card.png`, logoCard(), true);
mkdirSync(`${TWORK}/opening`, { recursive: true });
for (let f = 0; f < OPEN_FRAMES; f++)
  writeFrame(`${TWORK}/opening/${String(f).padStart(4, '0')}.png`, opening(f), true);
console.log(
  `cards: ${CARDS.length + 1}, opening: ${OPEN_FRAMES} frames (touch at frame ${OPEN_TOUCH}); widest card ${Math.max(...CARDS.flatMap((c) => c.lines.map((l) => measureText(l.s, { scale: l.scale, tracking: 1 }))))} px of ${LW}`,
);
