import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { DEFAULT_LIGHTING, hex, type TitanId } from '../../src/contracts';
import { renderPortrait } from '../../src/titans/portrait';
import { ROSTER } from '../../src/titans/roster';
import { samplePortrait } from '../../src/ui/portrait';
import { BAYER4, type Sprite } from '../../src/ui/pixel/canvas';
import { CHROME, GOLD, titleType } from '../../src/ui/pixel/titleType';
import { PRESS } from './common';

/**
 * The ADEUK: TITANS emblem: the Last One looming out of a sunburst inside an orbit ring, the other titans riding the ring
 * around it, and the title below in two metals (ADEUK molten gold over TITANS chrome), all at native pixel size.
 * → press/logo/adeuk-titans-emblem-x1/x3/x6.png (transparent) and adeuk-titans-emblem-preview.png (on a dark plate).
 *   npx tsx tools/press/emblem.ts
 */
const W = 560;
const H = 480;
const CX = 280;
const CY = 200;
const R = 150;
/** The Last One's top edge (its crown pokes out over the ring) and its eye, where the sunburst comes from. */
const COLOSSUS_TOP = CY - R - 6;
const EYE_Y = COLOSSUS_TOP + 78;
const px = new Uint32Array(W * H);

const rgb = (c: number): [number, number, number] => [c & 255, (c >>> 8) & 255, (c >>> 16) & 255];
const put = (x: number, y: number, c: number): void => {
  if (x >= 0 && y >= 0 && x < W && y < H) px[y * W + x] = c;
};
const blit = (s: Sprite, x0: number, y0: number): void => {
  for (let y = 0; y < s.h; y++)
    for (let x = 0; x < s.w; x++) {
      const c = s.pixels[y * s.w + x]!;
      if (c >>> 24) put(x0 + x, y0 + y, c);
    }
};
const dith = (a: number, b: number, t: number, x: number, y: number): number =>
  Math.max(0, Math.min(1, t)) * 16 > BAYER4[(y & 3) * 4 + (x & 3)]! ? b : a;

// --- the disc: deep space, a sunburst behind the colossus, stars ----------------------------------------------------
const SPACE = ['#07051a', '#120a30', '#24114a'].map(hex);
const RAY = ['#ff8a1c', '#ffb43a', '#ffd870'].map(hex);
const RAY_DARK = ['#c2401a', '#e0601c'].map(hex);
let seed = 7;
const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const dx = x - CX;
    const dy = y - CY;
    const d = Math.hypot(dx, dy);
    if (d > R) continue;
    const r = d / R;
    // space darkens toward the rim
    let c = dith(SPACE[2]!, SPACE[1]!, r * 1.4, x, y);
    if (r > 0.7) c = dith(SPACE[1]!, SPACE[0]!, (r - 0.7) / 0.25, x, y);
    // sunburst: 16 rays from a point behind the colossus' eye, fading out by 0.85 R
    const sx = CX;
    const sy = EYE_Y;
    const sd = Math.hypot(x - sx, y - sy) / R;
    const ang = Math.atan2(y - sy, x - sx);
    const ray = Math.cos(ang * 16) > 0.35;
    const fade = 1 - sd / 0.95;
    if (fade > 0) {
      const core = sd < 0.32;
      const hot = core ? RAY[2]! : ray ? dith(RAY[0]!, RAY[1]!, fade * 1.3, x, y) : dith(RAY_DARK[0]!, RAY_DARK[1]!, fade, x, y);
      c = dith(c, hot, fade * 2.2, x, y);
    }
    put(x, y, c);
  }
for (let i = 0; i < 160; i++) {
  const a = rnd() * Math.PI * 2;
  const d = Math.sqrt(rnd()) * (R - 6);
  const x = Math.round(CX + Math.cos(a) * d);
  const y = Math.round(CY + Math.sin(a) * d);
  if (Math.hypot(x - CX, y - EYE_Y) / R < 0.9) continue;
  put(x, y, rnd() < 0.2 ? hex('#ffffff') : hex('#8a7cc8'));
}

// --- the rings: an outer gold band, an inner teal hairline --------------------------------------------------------
const ring = (r0: number, r1: number, cols: number[]): void => {
  for (let y = CY - r1 - 1; y <= CY + r1 + 1; y++)
    for (let x = CX - r1 - 1; x <= CX + r1 + 1; x++) {
      const d = Math.hypot(x - CX, y - CY);
      if (d < r0 || d >= r1) continue;
      const t = (d - r0) / (r1 - r0);
      // light from the top: the band's upper half is brighter
      const lit = (CY - y) / R;
      const k = Math.min(cols.length - 1, Math.floor(t * cols.length));
      put(x, y, lit > 0.2 && k > 0 ? cols[k - 1]! : cols[k]!);
    }
};
ring(R - 1, R + 7, ['#1a0804', '#fff0a0', '#ffc838', '#e07818', '#9a3a0c', '#1a0804'].map(hex));
ring(R - 13, R - 11, ['#5fe0d0', '#1a7a84'].map(hex));

// --- the titans --------------------------------------------------------------------------------------------------
const shown = ROSTER.filter((r) => !r.wip).map((r) => r.id);
const fit = (id: TitanId, box: number, outline: number): Sprite => {
  const p = renderPortrait(id, 1, DEFAULT_LIGHTING);
  // never upscale: a titan is at most its own pixel size
  const k = Math.min(1, box / p.w, box / p.h);
  return samplePortrait(p, Math.round(p.w * k) + 2, Math.round(p.h * k) + 2, { outline, margin: 1 });
};
const OUT = hex('#05030f');
/**
 * Rim light from the sunburst: a body pixel whose neighbour toward the Last One's eye is empty (or outline) catches the
 * glow, so dark titans still read against dark space.
 */
const RIM = hex('#ffc070');
const rimLit = (s: Sprite, ox: number, oy: number): Sprite => {
  const out = s.pixels.slice();
  const solid = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < s.w && y < s.h && s.pixels[y * s.w + x]! >>> 24 !== 0 && s.pixels[y * s.w + x] !== OUT;
  for (let y = 0; y < s.h; y++)
    for (let x = 0; x < s.w; x++) {
      if (!solid(x, y)) continue;
      const dx = CX - (ox + x);
      const dy = EYE_Y - (oy + y);
      const n = Math.hypot(dx, dy) || 1;
      if (solid(x + Math.round(dx / n), y + Math.round(dy / n))) continue;
      const [r, g, b] = rgb(s.pixels[y * s.w + x]!);
      const [rr, rg, rb] = rgb(RIM);
      out[y * s.w + x] =
        (0xff000000 | (((b + rb) >> 1) << 16) | (((g + rg) >> 1) << 8) | ((r + rr) >> 1)) >>> 0;
    }
  return { pixels: out, w: s.w, h: s.h };
};
const rider = (id: TitanId, deg: number, box: number, r = R + 2): void => {
  if (!shown.includes(id)) return;
  const s = fit(id, box, OUT);
  const a = (deg * Math.PI) / 180;
  const x = Math.round(CX + Math.cos(a) * r) - (s.w >> 1);
  const y = Math.round(CY + Math.sin(a) * r) - (s.h >> 1);
  blit(rimLit(s, x, y), x, y);
};
// the two heavies flank the title from behind it, outside the ring (angles in degrees, 0 = right, 90 = down)
rider('uri', 146, 104, R + 26);
rider('cradle', 40, 100, R + 18);
// the Last One at native size, centre: its crown breaks out of the top of the ring
const colossus = fit('colossus', 999, OUT);
blit(colossus, CX - (colossus.w >> 1), COLOSSUS_TOP);
// the ring riders: three a side
const RIDERS: [TitanId, number, number][] = [
  ['lastone', -134, 60],
  ['supernova', -166, 84],
  ['asteroid', 166, 58],
  ['planet', -46, 62],
  ['blackhole', -14, 84],
  ['nexus', 10, 66],
];
for (const [id, deg, box] of RIDERS) rider(id, deg, box);

// --- the title: ADEUK gold over TITANS chrome, overlapping the lower ring --------------------------------------------
const adeuk = titleType('ADEUK', GOLD);
const titans = titleType('TITANS', CHROME);
const ty = CY + R - 66;
blit(adeuk, CX - (adeuk.w >> 1), ty);
blit(titans, CX - (titans.w >> 1), ty + adeuk.h - 4);

// --- out ---------------------------------------------------------------------------------------------------------
// crop to content
let x0 = W;
let y0 = H;
let x1 = 0;
let y1 = 0;
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++)
    if (px[y * W + x]! >>> 24) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
const cw = x1 - x0 + 1;
const ch = y1 - y0 + 1;
const write = (path: string, k: number, plate?: number): void => {
  const pad = plate === undefined ? 0 : 24;
  const ow = (cw + pad * 2) * k;
  const oh = (ch + pad * 2) * k;
  const png = new PNG({ width: ow, height: oh });
  for (let y = 0; y < oh; y++)
    for (let x = 0; x < ow; x++) {
      const sx = Math.floor(x / k) - pad + x0;
      const sy = Math.floor(y / k) - pad + y0;
      const inside = sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1;
      let c = inside ? px[sy * W + sx]! : 0;
      if (!(c >>> 24) && plate !== undefined) c = plate;
      const [r, g, b] = rgb(c);
      const o = (y * ow + x) * 4;
      png.data[o] = r;
      png.data[o + 1] = g;
      png.data[o + 2] = b;
      png.data[o + 3] = c >>> 24;
    }
  writeFileSync(path, PNG.sync.write(png));
  console.log(`${path}: ${ow}×${oh}`);
};
mkdirSync(`${PRESS}/logo`, { recursive: true });
for (const k of [1, 3, 6]) write(`${PRESS}/logo/adeuk-titans-emblem-x${k}.png`, k);
write(`${PRESS}/logo/adeuk-titans-emblem-preview.png`, 2, hex('#0a0a14'));
