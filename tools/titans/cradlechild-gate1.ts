/**
 * CRADLE CHILD, Gate 1 stills (look and silhouette, WJ's brief docs/titans/cradlechild/BRIEF.md): the titan as the matter
 * world shows it, alone at 1× and 3×; the 64 px read beside the Cradle's; the pair side by side at true size; beside the roster
 * at true relative sizes (next to the Cradle). Prints the value numbers that prove the two are told apart. The fight frame
 * and the select screen come from tools/titans/still.ts.
 *
 *   npx tsx tools/titans/cradlechild-gate1.ts [--out=docs/gallery/cradlechild/gate1]
 */
import { DEFAULT_LIGHTING, type TitanId } from '@/contracts';
import { createMatterWorld } from '@/matter';
import { getTitanDef, renderPortrait } from '@/titans';
import { paintChild } from '@/titans/kit/cradlechild/paint';
import { resolveMaterials } from '@/titans/materialTable';
import { ROSTER } from '@/titans/roster';
import { writeContactSheet, writePng, type SheetItem } from '../lead/png';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const OUT = opt('out', 'docs/gallery/cradlechild/gate1');
const SEED = 1234;
const BG = 0xff140a0a; // the dark of space, a touch warm (packed ABGR)

/** Paint, put it in a real matter world (so `pixels` is what the game shows), crop to the live cells. */
function live(): SheetItem {
  const def = getTitanDef('cradlechild' as TitanId);
  const map = paintChild(def, SEED, DEFAULT_LIGHTING).map;
  const world = createMatterWorld(SEED);
  world.setLighting(DEFAULT_LIGHTING);
  const body = world.createBody({
    kind: 'titan',
    ownerSlot: 0,
    map,
    materials: resolveMaterials(def.materials),
    attributes: def.attributes,
    seed: SEED,
    transform: { x: 320, y: 200, anchorX: map.coreX, anchorY: map.coreY, facing: 1, lean: 0 },
  });
  for (let i = 0; i < 20; i++) world.tick();
  const m = body.map;
  let x0 = m.w;
  let y0 = m.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++)
      if (m.material[y * m.w + x] !== 0) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const pixels = new Uint32Array(w * h);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = y * m.w + x;
      if (m.material[i] !== 0) pixels[(y - y0) * w + (x - x0)] = m.pixels[i]! | 0xff000000;
    }
  return { pixels, w, h };
}

/** Box-filter to a scale factor k (alpha-aware), for the 64 px read. */
function scaleBy(src: SheetItem, k: number): SheetItem {
  const w = Math.max(1, Math.round(src.w * k));
  const h = Math.max(1, Math.round(src.h * k));
  const pixels = new Uint32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x / k);
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) / k));
      const sy0 = Math.floor(y / k);
      const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) / k));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < Math.min(src.h, sy1); sy++)
        for (let sx = sx0; sx < Math.min(src.w, sx1); sx++) {
          const c = src.pixels[sy * src.w + sx]!;
          n++;
          if (c >>> 24 === 0) continue;
          r += c & 255;
          g += (c >>> 8) & 255;
          b += (c >>> 16) & 255;
          a++;
        }
      if (a === 0 || a / n < 0.4) continue;
      pixels[y * w + x] =
        ((255 << 24) | (Math.round(b / a) << 16) | (Math.round(g / a) << 8) | Math.round(r / a)) >>> 0;
    }
  return { pixels, w, h };
}

/** Lay sprites in a row, bottoms aligned, on the space background. */
function row(items: SheetItem[], pad: number): SheetItem {
  const W = items.reduce((a, s) => a + s.w + pad, pad);
  const H = Math.max(...items.map((s) => s.h)) + pad * 2;
  const pixels = new Uint32Array(W * H).fill(BG);
  let ox = pad;
  for (const s of items) {
    const oy = H - pad - s.h;
    for (let y = 0; y < s.h; y++)
      for (let x = 0; x < s.w; x++) {
        const c = s.pixels[y * s.w + x]!;
        if (c >>> 24 !== 0) pixels[(oy + y) * W + ox + x] = c | 0xff000000;
      }
    ox += s.w + pad;
  }
  return { pixels, w: W, h: H };
}

/** Mean perceived lightness (0..1) of a sprite's live pixels, and the share that is light (> 0.6). */
function value(s: SheetItem): { mean: number; light: number } {
  let sum = 0;
  let light = 0;
  let n = 0;
  for (const c of s.pixels) {
    if (c >>> 24 === 0) continue;
    const l = (0.2126 * (c & 255) + 0.7152 * ((c >>> 8) & 255) + 0.0722 * ((c >>> 16) & 255)) / 255;
    sum += l;
    if (l > 0.6) light++;
    n++;
  }
  return { mean: sum / n, light: light / n };
}

const portrait = (id: string): SheetItem => {
  const e = ROSTER.find((r) => r.id === id)!;
  const p = renderPortrait(e.id, 1, DEFAULT_LIGHTING);
  const s: SheetItem = { pixels: p.pixels, w: p.w, h: p.h };
  return e.portraitScale === 1 ? s : scaleBy(s, e.portraitScale);
};

const child = live();
writePng(`${OUT}/cradlechild-x1.png`, child.pixels, child.w, child.h, 1, BG);
writePng(`${OUT}/cradlechild-x3.png`, child.pixels, child.w, child.h, 3, BG);
console.log(`cradle child: ${child.w}×${child.h} px`);

// the 64 px read: the Child and the Cradle, each shrunk to 64 px across its largest side, at ×3 so they can be seen
const cradle = portrait('cradle');
const at64 = (s: SheetItem): SheetItem => scaleBy(s, 64 / Math.max(s.w, s.h));
writeContactSheet(`${OUT}/cradlechild-64px.png`, [at64(child), at64(cradle)], 2, 3, 8, BG);

// the pair at true size, side by side (×2)
const pair = row([cradle, child], 12);
writePng(`${OUT}/cradlechild-vs-cradle.png`, pair.pixels, pair.w, pair.h, 2, BG);

// beside the roster at true relative sizes (game px), bottoms aligned, the Child right after the Cradle, at ×2
const line: { id: string; s: SheetItem }[] = [];
for (const e of ROSTER) {
  if (e.id === 'cradlechild') continue;
  line.push({ id: e.id, s: portrait(e.id) });
  if (e.id === 'cradle') line.push({ id: 'cradlechild', s: child });
}
const lineup = row(
  line.map((r) => r.s),
  10,
);
writePng(`${OUT}/cradlechild-roster-lineup.png`, lineup.pixels, lineup.w, lineup.h, 2, BG);
console.log(`lineup: ${line.map((r) => `${r.id} ${r.s.w}×${r.s.h}`).join(', ')}`);

const vc = value(child);
const vk = value(cradle);
console.log(
  `value: child mean ${vc.mean.toFixed(2)} (light ${(vc.light * 100).toFixed(0)} %), cradle mean ${vk.mean.toFixed(2)} (light ${(vk.light * 100).toFixed(0)} %)`,
);
