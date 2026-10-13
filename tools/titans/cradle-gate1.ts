/**
 * THE CRADLE, Gate 1 stills (look and silhouette, WJ's brief docs/titans/cradle/BRIEF.md): the titan as the matter world
 * shows it, alone at native ×3; the 64 px read; beside the roster at true relative sizes; and the open variants (disc tilt,
 * tail treatment). The fight frame comes from tools/titans/still.ts.
 *
 *   npx tsx tools/titans/cradle-gate1.ts [--out=docs/gallery/cradle/gate1] [--only=base]
 */
import { DEFAULT_LIGHTING, type TitanDef, type TitanId } from '@/contracts';
import { createMatterWorld } from '@/matter';
import { getTitanDef, renderPortrait } from '@/titans';
import { paintCradle, type CradleParams } from '@/titans/kit/cradle/paint';
import { resolveMaterials } from '@/titans/materialTable';
import { ROSTER } from '@/titans/roster';
import { writeContactSheet, writePng, type SheetItem } from '../lead/png';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const OUT = opt('out', 'docs/gallery/cradle/gate1');
const ONLY = opt('only', '');
const SEED = 1234;
const BG = 0xff140a0a; // the dark of space, a touch warm (packed ABGR)

type Patch = (p: CradleParams) => void;
const VARIANTS: Record<string, { note: string; patch: Patch }> = {
  base: { note: 'eclipse tilt, hooked tail (jaw forward)', patch: () => {} },
  sail: {
    note: 'steeper sail tilt: the disc rolls further and opens toward the camera',
    patch: (p) => {
      p.disc.roll = -0.27;
      p.disc.ry = 52;
      p.disc.cy += 6;
      p.knot.dy = 30;
    },
  },
  trail: {
    note: 'trailing tail: the cord sweeps back under the body, then curls the jaw forward',
    patch: (p) => {
      // relative to the cord's root (the base layout's first point)
      const [x0, y0] = p.tail.pts[0]!;
      const rel: [number, number][] = [
        [0, 0],
        [9, 30],
        [1, 58],
        [-25, 76],
        [-43, 93],
        [-27, 107],
        [7, 109],
        [37, 103],
      ];
      p.tail.pts = rel.map(([x, y]) => [x0 + x, y0 + y]);
    },
  },
};

function variantDef(name: string): TitanDef {
  const def = JSON.parse(JSON.stringify(getTitanDef('cradle' as TitanId))) as TitanDef;
  VARIANTS[name]!.patch(def.art.params as unknown as CradleParams);
  return def;
}

/** Paint, put it in a real matter world (so `pixels` is what the game shows), crop to the live cells. */
function live(def: TitanDef): SheetItem {
  // the whole Cradle (every body composited at rest)
  const map = paintCradle(def, SEED, DEFAULT_LIGHTING).rig.portrait!;
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

/** Box-filter to a scale factor k (alpha-aware), for the 64 px read and 우리's reference-space portrait. */
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

const names = ONLY ? [ONLY] : Object.keys(VARIANTS);
const sprites: Record<string, SheetItem> = {};
for (const name of names) {
  const s = live(variantDef(name));
  sprites[name] = s;
  writePng(`${OUT}/cradle-${name}-x3.png`, s.pixels, s.w, s.h, 3, BG);
  console.log(`${name}: ${s.w}×${s.h} px (${VARIANTS[name]!.note})`);
}

// the 64 px read: each variant at 1:1 and shrunk to 64 px across, at ×3 so the small ones can be seen
const thumbs = names.map((n) => scaleBy(sprites[n]!, 64 / Math.max(sprites[n]!.w, sprites[n]!.h)));
writeContactSheet(`${OUT}/cradle-64px.png`, thumbs, thumbs.length, 3, 6, BG);

// beside the roster at true relative sizes (game px), bottoms aligned, at ×2
if (!ONLY) {
  const row: { id: string; s: SheetItem }[] = [];
  for (const e of ROSTER) {
    if (e.id === 'cradle') continue;
    const p = renderPortrait(e.id, 1, DEFAULT_LIGHTING);
    const s: SheetItem = { pixels: p.pixels, w: p.w, h: p.h };
    row.push({ id: e.id, s: e.portraitScale === 1 ? s : scaleBy(s, e.portraitScale) });
  }
  row.splice(2, 0, { id: 'cradle', s: sprites['base']! });
  const pad = 10;
  const W = row.reduce((a, r) => a + r.s.w + pad, pad);
  const H = Math.max(...row.map((r) => r.s.h)) + pad * 2;
  const sheet = new Uint32Array(W * H).fill(BG);
  let ox = pad;
  for (const { s } of row) {
    const oy = H - pad - s.h;
    for (let y = 0; y < s.h; y++)
      for (let x = 0; x < s.w; x++) {
        const c = s.pixels[y * s.w + x]!;
        if (c >>> 24 === 0) continue;
        sheet[(oy + y) * W + ox + x] = c | 0xff000000;
      }
    ox += s.w + pad;
  }
  writePng(`${OUT}/cradle-roster-lineup.png`, sheet, W, H, 2, BG);
  console.log(`lineup: ${row.map((r) => `${r.id} ${r.s.w}×${r.s.h}`).join(', ')}`);
}
