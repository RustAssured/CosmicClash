/**
 * Titan legibility sheet. Renders every implemented titan intact / carved to 50 % / carved to 10 % (through the REAL matter world's
 * `carve`) at 1×, 3× and 4×, plus a 64 px thumbnail row, to `.scratch/titans/*.png` so the art can be LOOKED AT.
 *   npx tsx tools/titans/sheet.ts [titan id …] [--light=nursery|cold|noon] [--out=dir]
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { DEFAULT_LIGHTING, type MatterMap, type StageLighting, type TitanDef } from '@/contracts';
import { createMatterWorld } from '@/matter';
import { generateTitanBody } from '@/titans/generate';
import { writeContactSheet, writePng, type SheetItem } from '../lead/png';

/** Any titan with a `src/titans/<id>.json` can be sheeted, implemented or not (work in progress). */
const loadDef = (id: string): TitanDef => {
  const path = `src/titans/${id}.json`;
  if (!existsSync(path)) throw new Error(`no ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as TitanDef;
};
const ALL = ['lastone', 'asteroid', 'nexus', 'blackhole', 'supernova', 'planet'].filter((id) =>
  existsSync(`src/titans/${id}.json`),
);
const lights: Record<string, StageLighting> = {
  nursery: DEFAULT_LIGHTING,
  cold: {
    dir: [-0.3, -0.6, 0.74],
    color: '#cfe6ff',
    ambient: '#0e1a3a',
    rim: '#7fc8ff',
    screenPos: [0.3, -0.1],
  },
  noon: {
    dir: [0.0, -0.7, 0.71],
    color: '#fff3d6',
    ambient: '#2b2a3a',
    rim: '#ffd9a0',
    screenPos: [0.5, -0.2],
  },
};
const args = process.argv.slice(2);
const which = args.filter((a) => !a.startsWith('--'));
const lightName = (args.find((a) => a.startsWith('--light=')) ?? '--light=nursery').slice(8);
const outDir = (args.find((a) => a.startsWith('--out=')) ?? '--out=.scratch/titans').slice(6);
const lighting = lights[lightName] ?? DEFAULT_LIGHTING;
const SEED = 1234;
const THUMB = 64;

/** The visible pixels of a map (`map.pixels` where matter is live), cropped to the live bounding box with a 1 px margin. */
function crop(map: MatterMap): SheetItem {
  let x0 = map.w;
  let y0 = map.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < map.h; y++)
    for (let x = 0; x < map.w; x++)
      if (map.material[y * map.w + x] !== 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  const w = x1 - x0 + 3;
  const h = y1 - y0 + 3;
  const pixels = new Uint32Array(w * h);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = y * map.w + x;
      if (map.material[i] !== 0) pixels[(y - y0 + 1) * w + (x - x0 + 1)] = map.pixels[i]! | 0xff000000;
    }
  return { pixels, w, h };
}

/** Box-filter downscale so the longest side is `target` px (alpha-weighted so silhouettes keep their edge colour). */
function thumbnail(src: SheetItem, target: number): SheetItem {
  const k = target / Math.max(src.w, src.h);
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

mkdirSync(outDir, { recursive: true });
for (const id of which.length ? which : ALL) {
  const def = loadDef(id);
  const t0 = performance.now();
  const g = generateTitanBody(def, SEED, lighting);
  const ms = performance.now() - t0;
  const world = createMatterWorld(SEED);
  world.setLighting(lighting);
  const states: { name: string; frac: number }[] = [
    { name: 'intact', frac: 1 },
    { name: '50', frac: 0.5 },
    { name: '10', frac: 0.1 },
  ];
  const items: SheetItem[] = [];
  const thumbs: SheetItem[] = [];
  for (const st of states) {
    // a private body per state so the carved variants are independent of each other
    const gen = generateTitanBody(def, SEED, lighting);
    const body = world.createBody({
      kind: 'titan',
      ownerSlot: 0,
      map: gen.map,
      materials: gen.materials,
      attributes: def.attributes,
      seed: SEED,
      transform: { x: 320, y: 200, anchorX: gen.map.coreX, anchorY: gen.map.coreY, facing: 1, lean: 0 },
    });
    if (st.frac < 1) world.carve(body.id, st.frac, SEED + 5);
    for (let i = 0; i < 20; i++) world.tick();
    const c = crop(body.map);
    items.push(c);
    thumbs.push(thumbnail(c, THUMB));
    if (st.frac === 1) writePng(`${outDir}/${id}-${lightName}-4x.png`, c.pixels, c.w, c.h, 4);
    world.removeBody(body.id);
  }
  console.log(
    `${id}: ${g.map.w}x${g.map.h} painted+cloned in ${ms.toFixed(0)} ms; sprites ${items.map((i) => `${i.w}x${i.h}`).join(' ')}`,
  );
  writeContactSheet(`${outDir}/${id}-${lightName}-states.png`, items, 3, 3, 6);
  writeContactSheet(`${outDir}/${id}-${lightName}-thumbs.png`, thumbs, 3, 6, 4);
  // 1:1 (what the player sees on a 1× canvas) next to the 64 px thumbnails
  writeContactSheet(`${outDir}/${id}-${lightName}-1x.png`, [items[0]!, ...thumbs], 4, 1, 6);
}
