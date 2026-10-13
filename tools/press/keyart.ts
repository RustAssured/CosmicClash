import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { DEFAULT_LIGHTING, type TitanId } from '../../src/contracts';
import { renderPortrait, type Portrait } from '../../src/titans/portrait';
import { ROSTER } from '../../src/titans/roster';
import { samplePortrait } from '../../src/ui/portrait';
import { logoSprite } from '../../src/ui/pixel/logo';
import { launch } from '../lead/browser';
import { startRenderServer } from '../render/devserver';
import { PRESS, WORK, arg } from './common';

/**
 * Key art and title grabs (real GPU, headless Edge):
 *  - the lineup: every roster titan together (their pristine portraits from the game's own painter, at their in-game relative
 *    sizes: the Witness and 우리 at 2/3 through the game's own portrait resampler) standing over an empty stage plate (the
 *    renderer sandbox with `fighters=0`), the logotype above; 1280×720 composed, ×3 → 3840×2160;
 *  - the title screen as the game draws it (harness `mode=title`), 1920×1080 and ×2 → 3840×2160.
 * → press/keyart/
 *   npx tsx tools/press/keyart.ts [--stage=nursery]
 */
const stage = arg('stage', 'nursery');
const OUT = `${PRESS}/keyart`;
mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });

function upscalePng(path: string, px: Uint32Array, w: number, h: number, k: number): void {
  const png = new PNG({ width: w * k, height: h * k });
  for (let y = 0; y < h * k; y++)
    for (let x = 0; x < w * k; x++) {
      const c = px[Math.floor(y / k) * w + Math.floor(x / k)]!;
      const o = (y * w * k + x) * 4;
      png.data[o] = c & 255;
      png.data[o + 1] = (c >>> 8) & 255;
      png.data[o + 2] = (c >>> 16) & 255;
      png.data[o + 3] = 255;
    }
  writeFileSync(path, PNG.sync.write(png));
}

const { server, url } = await startRenderServer();
const browser = await launch();
let plate: Uint32Array;
try {
  // the empty stage plate
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error(`[pageerror] ${e.message}`));
  await page.goto(
    `${url}/dev/render/index.html?stage=${stage}&quality=2&freeze=1&t=0&text=0&sparks=0&ui=0&fighters=0`,
    { waitUntil: 'commit' },
  );
  await page.waitForFunction("document.body.dataset.ready==='1'", null, { timeout: 180_000 });
  const b64 = (await page.evaluate(
    `(() => { const R = window.__RENDER__; R.loop.pause(); R.set({ time: 6, fa: 640, fb: 980, intensity: 0.3 }); R.settle(); R.drawNow(); return R.captureBase64(); })()`,
  )) as string;
  plate = new Uint32Array(new Uint8Array(Buffer.from(b64, 'base64')).buffer);
  await page.close();

  // the title screen
  const t = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await t.goto(`${url}/?mode=title&q=2`, { waitUntil: 'load' });
  await t.waitForFunction(() => window.__ADEUK__?.ready === true, null, { timeout: 120_000 });
  // a first visit opens HOW TO PLAY once (and remembers it): the second visit is the title screen itself
  await t.reload({ waitUntil: 'load' });
  await t.waitForFunction(() => window.__ADEUK__?.ready === true, null, { timeout: 120_000 });
  await t.waitForTimeout(4000);
  const shot = await t.screenshot({ type: 'png' });
  writeFileSync(`${OUT}/title-screen-1080p.png`, shot);
  const src = PNG.sync.read(shot);
  const tpx = new Uint32Array(new Uint8Array(src.data).buffer);
  upscalePng(`${OUT}/title-screen-4k.png`, tpx, src.width, src.height, 2);
  await t.close();
} finally {
  await browser.close();
  await server.close();
}

// compose the lineup at 1280×720: the plate ×2, titans at their own pixel size
const W = 1280;
const H = 720;
const art = new Uint32Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) art[y * W + x] = plate[(y >> 1) * 640 + (x >> 1)]!;
// a floor of shade under the row so the bodies read on any plate
for (let y = 0; y < H; y++) {
  const k = Math.max(0, (y - 300) / 420) * 0.55;
  for (let x = 0; x < W; x++) {
    const c = art[y * W + x]!;
    const f = 1 - k;
    art[y * W + x] =
      (0xff000000 |
        (Math.round(((c >>> 16) & 255) * f) << 16) |
        (Math.round(((c >>> 8) & 255) * f) << 8) |
        Math.round((c & 255) * f)) >>>
      0;
  }
}
const scaled = (id: TitanId, k: number): Portrait => {
  const p = renderPortrait(id, 1, DEFAULT_LIGHTING);
  if (k === 1) return p;
  return samplePortrait(p, Math.round(p.w * k), Math.round(p.h * k));
};
// the composed order of the original lineup, then every other roster titan (the Witness, the kit's newcomers) at its game
// size; a row wider than the frame is shrunk as a whole (the game's own resampler) so everyone fits
const CURATED: [TitanId, number][] = [
  ['asteroid', 1],
  ['nexus', 1],
  ['supernova', 1],
  ['uri', 2 / 3],
  ['colossus', 2 / 3],
  ['blackhole', 1],
  ['planet', 1],
];
const lineup: [TitanId, number][] = [
  ...CURATED.filter(([id]) => ROSTER.some((r) => r.id === id)),
  // work-in-progress titans (kit.wip) stay out of the press key art until they ship
  ...ROSTER.filter((r) => !r.wip && !CURATED.some(([id]) => id === r.id)).map((r): [TitanId, number] => [
    r.id,
    r.portraitScale,
  ]),
];
const gap = 6;
const natural = lineup.reduce((a, [id, k]) => a + renderPortrait(id, 1, DEFAULT_LIGHTING).w * k, 0);
const fit = Math.min(1, (W - 40 - gap * (lineup.length - 1)) / natural);
const row: { p: Portrait }[] = lineup.map(([id, k]) => ({ p: scaled(id, k * fit) }));
const total = row.reduce((a, r) => a + r.p.w, 0) + gap * (row.length - 1);
let x0 = (W - total) >> 1;
const base = 650;
for (const { p } of row) {
  const y0 = base - p.h;
  for (let y = 0; y < p.h; y++)
    for (let x = 0; x < p.w; x++) {
      const c = p.pixels[y * p.w + x]!;
      if (c >>> 24 && x0 + x >= 0 && x0 + x < W && y0 + y >= 0) art[(y0 + y) * W + x0 + x] = c;
    }
  x0 += p.w + gap;
}
// the logotype ×2, top centre
const logo = logoSprite();
const lk = 2;
const lx = (W - logo.w * lk) >> 1;
const ly = 60;
for (let y = 0; y < logo.h * lk; y++)
  for (let x = 0; x < logo.w * lk; x++) {
    const c = logo.pixels[Math.floor(y / lk) * logo.w + Math.floor(x / lk)]!;
    const a = c >>> 24;
    if (!a) continue;
    const i = (ly + y) * W + lx + x;
    if (a === 255) art[i] = c;
    else {
      const d = art[i]!;
      const t = a / 255;
      const mix = (s: number): number => Math.round(((c >>> s) & 255) * t + ((d >>> s) & 255) * (1 - t)) << s;
      art[i] = (0xff000000 | mix(16) | mix(8) | mix(0)) >>> 0;
    }
  }
upscalePng(`${OUT}/lineup-4k.png`, art, W, H, 3);
upscalePng(`${OUT}/lineup-720p.png`, art, W, H, 1);
console.log(`lineup: ${W}×${H} ×3 → ${W * 3}×${H * 3} (and ×1), title screen 1080p + 4K`);
