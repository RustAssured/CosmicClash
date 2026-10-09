/**
 * The landing page's pixel art, drawn by the game's own code:
 *  - titan portraits from the titan painters (src/titans/portrait.ts): pristine, transparent, one PNG pixel per game pixel
 *    (the page scales them up with `image-rendering: pixelated`);
 *  - the ADEUK: TITANS logotype (src/ui/pixel/logo.ts) and 아득, and each titan's Korean name, in the game's Hangeul face;
 *  - the favicon, cut from the Witness's eye.
 *
 *   npx tsx tools/site/art.ts       # writes site/media/titans/*.png, site/media/type/*.png, site/media/favicon-180.png
 *
 * Deterministic (seed 1, default lighting). Re-run when a titan's art changes. S5's press-kit character cards can replace
 * the portraits: drop a transparent PNG with the same name into site/media/titans/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { DEFAULT_LIGHTING, type TitanId } from '@/contracts';
import { renderPortrait, type Portrait } from '@/titans/portrait';
import { PixelCanvas } from '@/ui/pixel/canvas';
import { logoSprite } from '@/ui/pixel/logo';
import { C, alpha } from '@/ui/pixel/palette';
import { drawText, measureText } from '@/ui/pixel/text';

const OUT = 'site/media/titans';
const TITANS: { file: string; id: TitanId; witness?: boolean }[] = [
  { file: 'witness', id: 'lastone', witness: true },
  { file: 'planet', id: 'planet' },
  { file: 'asteroid', id: 'asteroid' },
  { file: 'nexus', id: 'nexus' },
  { file: 'blackhole', id: 'blackhole' },
  { file: 'supernova', id: 'supernova' },
  { file: 'uri', id: 'uri' },
];

/** Packed RGBA (R in the low byte) to a transparent PNG, nearest-neighbour `scale`. */
function write(
  path: string,
  p: Portrait,
  scale = 1,
  crop?: { x: number; y: number; w: number; h: number },
): void {
  const c = crop ?? { x: 0, y: 0, w: p.w, h: p.h };
  const png = new PNG({ width: c.w * scale, height: c.h * scale });
  for (let y = 0; y < c.h * scale; y++)
    for (let x = 0; x < c.w * scale; x++) {
      const sx = c.x + Math.floor(x / scale);
      const sy = c.y + Math.floor(y / scale);
      const v = sx >= 0 && sy >= 0 && sx < p.w && sy < p.h ? p.pixels[sy * p.w + sx]! : 0;
      const o = (y * c.w * scale + x) * 4;
      png.data[o] = v & 255;
      png.data[o + 1] = (v >>> 8) & 255;
      png.data[o + 2] = (v >>> 16) & 255;
      png.data[o + 3] = v >>> 24;
    }
  writeFileSync(path, PNG.sync.write(png));
}

mkdirSync(OUT, { recursive: true });
const sizes: Record<string, [number, number]> = {};
for (const t of TITANS) {
  const p = renderPortrait(t.id, 1, DEFAULT_LIGHTING, t.witness ?? false);
  write(`${OUT}/${t.file}.png`, p);
  sizes[t.file] = [p.w, p.h];
  console.log(`${t.file}: ${p.w}x${p.h}`);
}
writeFileSync(`${OUT}/sizes.json`, JSON.stringify(sizes, null, 2) + '\n');

// favicon: the Witness's eye (the brightest compact disc near the body's centre), cut square
const w = renderPortrait('lastone', 1, DEFAULT_LIGHTING, true);
const eye = findEye(w);
let pupil = findPupil(w, eye);
// re-centre on the dark disc with a tighter radius (the carapace's dark gaps pull the first guess off-centre)
for (let i = 0; i < 4; i++) pupil = findPupil(w, { ...pupil, r: 10 });
// 45 px square around the pupil: ×4 is the 180 px apple-touch icon; tools/site/media.ts scales the rest
const box = { x: pupil.x - 22, y: pupil.y - 22, w: 45, h: 45 };
write('site/media/favicon-180.png', w, 4, box);
write('site/media/titans/witness-eye.png', w, 1, box);
console.log(`favicon pupil at ${pupil.x},${pupil.y}`);

// type: the logotype (no glint) and the Hangeul words, transparent, 1 px per game pixel
mkdirSync('site/media/type', { recursive: true });
const logo = logoSprite();
write('site/media/type/logo.png', { pixels: logo.pixels, w: logo.w, h: logo.h });
console.log(`logo: ${logo.w}x${logo.h}`);
const WORDS: Record<string, string> = {
  adeuk: '아득',
  witness: '마지막 하나',
  planet: '행성',
  asteroid: '소행성',
  nexus: '넥서스',
  blackhole: '블랙홀',
  supernova: '초신성',
  uri: '우리',
};
for (const [file, word] of Object.entries(WORDS)) {
  const tracking = file === 'adeuk' ? 3 : 1;
  const w = measureText(word, { tracking }) + 2;
  const cv = new PixelCanvas(w, 14);
  drawText(cv, word, 0, 0, { color: C.celadon, tracking, shadow: alpha(C.void, 0.85) });
  write(`site/media/type/ko-${file}.png`, { pixels: cv.pixels, w: cv.w, h: cv.h });
}

/** The pupil: the centroid of the darkest opaque pixels within `r` of the eye's light centroid. */
function findPupil(p: Portrait, e: { x: number; y: number; r: number }): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = e.y - e.r; y <= e.y + e.r; y++)
    for (let x = e.x - e.r; x <= e.x + e.r; x++) {
      if (x < 0 || y < 0 || x >= p.w || y >= p.h) continue;
      const v = p.pixels[y * p.w + x]!;
      const l = 0.3 * (v & 255) + 0.59 * ((v >>> 8) & 255) + 0.11 * ((v >>> 16) & 255);
      if (v >>> 24 > 200 && l < 30) {
        sx += x;
        sy += y;
        n++;
      }
    }
  return n ? { x: Math.round(sx / n), y: Math.round(sy / n) } : { x: e.x, y: e.y };
}

/** The Witness's eye: the centroid of its lightest opaque pixels in the body's middle third, and their radius. */
function findEye(p: Portrait): { x: number; y: number; r: number } {
  let sx = 0;
  let sy = 0;
  let n = 0;
  const lum = (v: number): number => 0.3 * (v & 255) + 0.59 * ((v >>> 8) & 255) + 0.11 * ((v >>> 16) & 255);
  const x0 = Math.floor(p.w / 3);
  const x1 = Math.ceil((p.w * 2) / 3);
  const y0 = Math.floor(p.h / 5);
  const y1 = Math.ceil((p.h * 3) / 5);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const v = p.pixels[y * p.w + x]!;
      if (v >>> 24 > 200 && lum(v) > 150) {
        sx += x;
        sy += y;
        n++;
      }
    }
  const cx = Math.round(sx / Math.max(1, n));
  const cy = Math.round(sy / Math.max(1, n));
  return { x: cx, y: cy, r: Math.round(Math.sqrt(n / Math.PI)) + 3 };
}
