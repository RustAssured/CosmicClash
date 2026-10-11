/**
 * The Witness's palette options (D36): the returning tendril titan (id 'lastone') painted in each candidate palette beside the
 * colossus (The Last One), at native size and at 4x, so WJ can pick the one that reads as a different creature at a glance.
 * The in-game palette is the one in src/titans/lastone.json ('amethyst').
 *   npx tsx tools/titans/witness-palettes.ts [--out=docs/gallery/roster]
 */
import { mkdirSync } from 'node:fs';
import { DEFAULT_LIGHTING, type TitanDef } from '@/contracts';
import { getTitanDef, paintTitanMap, renderPortrait } from '@/titans';
import { writeContactSheet, type SheetItem } from '../lead/png';

type Pal = Record<string, { ramp: string[] }>;

export const WITNESS_PALETTES: Record<string, Pal> = {
  // A (in game): violet glaze, rose-magenta eyes, a magenta heart, a silver-lilac halo
  amethyst: {},
  // B: the same violet body with acid-green eyes and heart (alien; the strongest contrast with the body)
  acid: {
    iris: { ramp: ['#08140a', '#123a14', '#1f6a1c', '#3ea02a', '#7cd43a', '#c4f27a', '#f2ffd0'] },
    core: { ramp: ['#16380e', '#2c6a16', '#52a81e', '#8fe03a', '#d0ff8a', '#f6ffe2'] },
    eye: { ramp: ['#2c2a24', '#4a4638', '#726c52', '#a29c78', '#d0cca6', '#f4f2dc'] },
  },
  // C: obsidian basalt with ember-red eyes and heart and an iron halo (no violet at all)
  ember: {
    shell: { ramp: ['#0c0d12', '#16181f', '#22252e', '#30343f', '#424754', '#5a606e', '#7a8090', '#a3a9b6'] },
    seam: { ramp: ['#060609', '#0c0d12', '#14161c', '#1e2129', '#2a2e38', '#3a3f4b'] },
    inner: { ramp: ['#1e1416', '#3a2024', '#5c2e30', '#8a4438', '#bc6a48', '#e0a070', '#f8dcb4'] },
    core: { ramp: ['#3a0a06', '#7a160a', '#c0300e', '#ff6418', '#ffb060', '#fff0d0'] },
    eye: { ramp: ['#2a2220', '#4a3a34', '#6e5a50', '#9a847a', '#c8b4a8', '#efe4dc'] },
    iris: { ramp: ['#160404', '#400a06', '#7e1608', '#c4300c', '#f2641c', '#ffac58', '#ffe8c0'] },
    gilt: { ramp: ['#141416', '#2a2a2e', '#46464c', '#6c6c74', '#9a9aa4', '#d0d0d8'] },
  },
};

const withPalette = (def: TitanDef, pal: Pal): TitanDef => ({
  ...def,
  materials: def.materials.map((m) =>
    pal[m.key] ? { ...m, visual: { ...m.visual, ramp: pal[m.key]!.ramp } } : m,
  ),
});

const out = (process.argv.find((a) => a.startsWith('--out=')) ?? '--out=docs/gallery/roster').slice(6);
mkdirSync(out, { recursive: true });

const crop = (pixels: Uint32Array, w: number, h: number): SheetItem => {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (pixels[y * w + x]! >>> 24) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const p = new Uint32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) p[y * cw + x] = pixels[(y + y0) * w + x + x0]!;
  return { pixels: p, w: cw, h: ch };
};

const base = getTitanDef('lastone');
const items: SheetItem[] = [];
for (const [name, pal] of Object.entries(WITNESS_PALETTES)) {
  const { map } = paintTitanMap(withPalette(base, pal), 1, DEFAULT_LIGHTING);
  const px = new Uint32Array(map.w * map.h);
  for (let i = 0; i < px.length; i++) if (map.material[i] !== 0) px[i] = map.baseColor[i]!;
  const it = crop(px, map.w, map.h);
  items.push(it);
  writeContactSheet(`${out}/witness-palette-${name}.png`, [it], 1, 4, 6);
  console.log(`${out}/witness-palette-${name}.png  ${it.w}x${it.h}`);
}
// the colossus beside them, for the at-a-glance comparison
const col = renderPortrait('colossus', 1, DEFAULT_LIGHTING);
items.push({ pixels: col.pixels, w: col.w, h: col.h });
writeContactSheet(`${out}/witness-palettes.png`, items, items.length, 2, 8);
console.log(`${out}/witness-palettes.png (A amethyst, B acid, C ember, then the colossus)`);
