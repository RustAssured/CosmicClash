/**
 * The landing page's pixel art, drawn by the game's own code:
 *  - titan portraits from the titan painters (src/titans/portrait.ts): pristine, transparent, one PNG pixel per game pixel
 *    (the page scales them up with `image-rendering: pixelated`);
 *  - the ADEUK: TITANS wordmark (logo D, src/ui/pixel/wordmark.ts) in three sizes, the old one-line logotype
 *    (src/ui/pixel/logo.ts) and 아득, and each titan's Korean name, in the game's Hangeul face;
 *  - the favicon, cut from the Last One's eye (the colossus; D36).
 *
 *   npx tsx tools/site/art.ts              # every roster titan + the logotype + the favicon
 *   npx tsx tools/site/art.ts --only=<id>  # one titan's portrait and Korean name (the titan kit uses this)
 *   npx tsx tools/site/art.ts --wordmark   # just the wordmark
 *
 * Writes site/media/titans/<file>.png (+ sizes.json), site/media/type/ko-<file>.png, site/media/type/logo.png,
 * site/media/type/wordmark[-medium|-small].png,
 * site/media/favicon-180.png. The titans and their file names come from the roster (src/titans/roster.ts).
 *
 * Deterministic (seed 1, default lighting). Re-run when a titan's art changes. S5's press-kit character cards can replace
 * the portraits: drop a transparent PNG with the same name into site/media/titans/.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { DEFAULT_LIGHTING, type TitanId } from '@/contracts';
import { renderPortrait, type Portrait } from '@/titans/portrait';
import { SITE_ROSTER } from '@/titans/roster';
import { PixelCanvas } from '@/ui/pixel/canvas';
import { logoSprite } from '@/ui/pixel/logo';
import { wordmarkSprite } from '@/ui/pixel/wordmark';
import { COSMIC_STYLE, NEBULA_PERIOD, cosmicWordmark, cosmicWordmarkSize } from '@/ui/pixel/cosmicLogo';
import { C, alpha } from '@/ui/pixel/palette';
import { drawText, measureText } from '@/ui/pixel/text';

const OUT = 'site/media/titans';
/** Frames in the COSMIC CLASH wordmark's sprite sheet (one NEBULA_PERIOD; the site's CSS steps through them). */
const COSMIC_FRAMES = 32;
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
// D36: the colossus ('colossus') is The Last One (file 'lastone'); the tendril titan ('lastone') is The Witness ('witness')
const TITANS: { file: string; id: TitanId; ko: string }[] = SITE_ROSTER.filter(
  (r) => !only || r.id === only,
).map((r) => ({ file: r.site.file, id: r.id, ko: r.site.ko }));
if (only && !TITANS.length) throw new Error(`site art: '${only}' is not on the roster`);

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

if (process.argv.includes('--wordmark')) {
  // just the wordmark (npx tsx tools/site/art.ts --wordmark)
  wordmarkArt();
  process.exit(0);
}

if (process.argv.includes('--cosmic')) {
  // just the COSMIC CLASH wordmark (npx tsx tools/site/art.ts --cosmic)
  cosmicArt();
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });
const SIZES = `${OUT}/sizes.json`;
const sizes: Record<string, [number, number]> =
  only && existsSync(SIZES)
    ? (JSON.parse(readFileSync(SIZES, 'utf8')) as Record<string, [number, number]>)
    : {};
for (const t of TITANS) {
  const p = renderPortrait(t.id, 1, DEFAULT_LIGHTING);
  write(`${OUT}/${t.file}.png`, p);
  sizes[t.file] = [p.w, p.h];
  console.log(`${t.file}: ${p.w}x${p.h}`);
}
// one titan per line, as prettier keeps it (`npm run lint` checks it)
writeFileSync(
  SIZES,
  `{\n${Object.entries(sizes)
    .map(([k, [w, h]]) => `  ${JSON.stringify(k)}: [${w}, ${h}]`)
    .join(',\n')}\n}\n`,
);
mkdirSync('site/media/type', { recursive: true });
koWords(Object.fromEntries(TITANS.map((t) => [t.file, t.ko])));
if (!only) everythingElse();

/** Each titan's Korean name in the game's Hangeul face, transparent, 1 px per game pixel: site/media/type/ko-<file>.png. */
function koWords(words: Record<string, string>): void {
  for (const [file, word] of Object.entries(words)) {
    const tracking = file === 'adeuk' ? 3 : 1;
    const w = measureText(word, { tracking }) + 2;
    const cv = new PixelCanvas(w, 14);
    drawText(cv, word, 0, 0, { color: C.celadon, tracking, shadow: alpha(C.void, 0.85) });
    write(`site/media/type/ko-${file}.png`, { pixels: cv.pixels, w: cv.w, h: cv.h });
  }
}

function everythingElse(): void {
  // favicon: the Last One's eye (the colossus, D36: the brightest compact disc near the body's centre), cut square
  const w = renderPortrait('colossus', 1, DEFAULT_LIGHTING);
  const eye = findEye(w);
  let pupil = findPupil(w, eye);
  // re-centre on the dark disc with a tighter radius (the carapace's dark gaps pull the first guess off-centre)
  for (let i = 0; i < 4; i++) pupil = findPupil(w, { ...pupil, r: 10 });
  // 45 px square around the pupil: ×4 is the 180 px apple-touch icon; tools/site/media.ts scales the rest
  const box = { x: pupil.x - 22, y: pupil.y - 22, w: 45, h: 45 };
  write('site/media/favicon-180.png', w, 4, box);
  write('site/media/titans/lastone-eye.png', w, 1, box);
  console.log(`favicon pupil at ${pupil.x},${pupil.y}`);

  // type: the logotype (no glint) and 아득, transparent, 1 px per game pixel
  const logo = logoSprite();
  write('site/media/type/logo.png', { pixels: logo.pixels, w: logo.w, h: logo.h });
  console.log(`logo: ${logo.w}x${logo.h}`);
  koWords({ adeuk: '아득' });
  wordmarkArt();
  cosmicArt();
}

/**
 * The wordmark (logo D, src/ui/pixel/wordmark.ts) with its roster beads, transparent, 1 px per game pixel, in its three
 * stacked sizes and its one-line lockup: site/media/type/wordmark.png (large: the press download), wordmark-medium.png
 * (the hero and the game's loading page), wordmark-small.png, wordmark-inline.png (the nav bar).
 */
function wordmarkArt(): void {
  mkdirSync('site/media/type', { recursive: true });
  const portraits = (id: TitanId): Portrait => renderPortrait(id, 1, DEFAULT_LIGHTING);
  for (const [size, file] of [
    ['large', 'wordmark'],
    ['medium', 'wordmark-medium'],
    ['small', 'wordmark-small'],
    ['inline', 'wordmark-inline'],
  ] as const) {
    const s = wordmarkSprite(size, portraits);
    write(`site/media/type/${file}.png`, s);
    console.log(`${file}: ${s.w}x${s.h}`);
  }
}

/**
 * The COSMIC CLASH wordmark (src/ui/pixel/cosmicLogo.ts), transparent, 1 px per game pixel: a still
 * (site/media/type/cosmicclash.png) and its living loop as a vertical sprite sheet of COSMIC_FRAMES frames over one
 * NEBULA_PERIOD (cosmicclash-sheet.png; the site steps through it in CSS). Its Korean, 우주 대결, as ko-cosmicclash.png.
 */
function cosmicArt(): void {
  mkdirSync('site/media/type', { recursive: true });
  const { w, h } = cosmicWordmarkSize(COSMIC_STYLE);
  const still = cosmicWordmark(COSMIC_STYLE, 0);
  write('site/media/type/cosmicclash.png', still);
  const sheet = new PixelCanvas(w, h * COSMIC_FRAMES);
  for (let f = 0; f < COSMIC_FRAMES; f++)
    sheet.blit(cosmicWordmark(COSMIC_STYLE, (f * NEBULA_PERIOD) / COSMIC_FRAMES), 0, f * h);
  write('site/media/type/cosmicclash-sheet.png', { pixels: sheet.pixels, w: sheet.w, h: sheet.h });
  koWords({ cosmicclash: '우주 대결' });
  console.log(`cosmic clash: ${w}x${h}, ${COSMIC_FRAMES} frames`);
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

/** The colossus's eye: the centroid of its lightest opaque pixels in the body's middle third, and their radius. */
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
