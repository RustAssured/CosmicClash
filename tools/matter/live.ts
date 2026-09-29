/**
 * Integrated destruction strips: drive the REAL app (real titans, real renderer) through the harness and capture the final
 * 640x360 logical frame every few ticks, cropped around where the blow lands and upscaled with nearest sampling, into a contact
 * sheet with a tick counter burned into every cell. Use it to judge readability of impacts, cracks, craters, debris and glows.
 *   npx tsx tools/matter/live.ts "<harness query>" <out.png> [--every=3] [--n=12] [--cols=4] [--zoom=3] [--crop=x,y,w,h]
 *                                                             [--base=http://localhost:5202] [--after=<ticks stepped before frame 0>]
 *   e.g. npx tsx tools/matter/live.ts "stage=nursery&a=lastone&b=asteroid&seed=5&hud=0&freeze=1&gap=190&script0=4:crush" .scratch/x.png
 * `--crop=x,y,w,h` is in logical (640x360) pixels; the default is the whole frame. The camera pans during a fight, so look at one full
 * frame first (`--n=1`) and pick the window.
 * Serve the app first:  npx vite build --outDir .scratch/b2dist && npx vite preview --outDir .scratch/b2dist --port 5202 --strictPort
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';
import { launch, openGame } from '../lead/browser';

const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith('--'));
const opt = (k: string, d: string): string =>
  argv
    .find((a) => a.startsWith(`--${k}=`))
    ?.split('=')
    .slice(1)
    .join('=') ?? d;
const [query, out] = pos;
if (!query || !out) {
  console.error(
    'usage: live.ts "<harness query>" <out.png> [--every=3 --n=12 --cols=4 --zoom=3 --crop=x,y,w,h --base= --after=]',
  );
  process.exit(1);
}
const every = Number(opt('every', '3'));
const n = Number(opt('n', '12'));
const cols = Number(opt('cols', '4'));
const zoom = Number(opt('zoom', '3'));
const base = opt('base', 'http://localhost:5202');
const after = Number(opt('after', '0'));
const cropOpt = opt('crop', '0,0,640,360');
mkdirSync(dirname(out), { recursive: true });

/** 3x5 pixel digits for the tick counter. */
const DIGITS: Record<string, string> = {
  '0': '111101101101111',
  '1': '010110010010111',
  '2': '111001111100111',
  '3': '111001111001111',
  '4': '101101111001001',
  '5': '111100111001111',
  '6': '111100111101111',
  '7': '111001001001001',
  '8': '111101111101111',
  '9': '111101111001111',
  t: '111010010010010',
};

function label(img: PNG, text: string, x0: number, y0: number, s: number): void {
  let cx = x0;
  for (const ch of text) {
    const g = DIGITS[ch];
    if (g)
      for (let i = 0; i < 15; i++) {
        if (g[i] !== '1') continue;
        for (let dy = 0; dy < s; dy++)
          for (let dx = 0; dx < s; dx++) {
            const px = cx + (i % 3) * s + dx;
            const py = y0 + Math.floor(i / 3) * s + dy;
            if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
            const o = (py * img.width + px) * 4;
            img.data[o] = 255;
            img.data[o + 1] = 255;
            img.data[o + 2] = 80;
            img.data[o + 3] = 255;
          }
      }
    cx += 4 * s;
  }
}

const browser = await launch();
const { page, errors } = await openGame(browser, `${base}/?${query}`, { width: 1280, height: 720 });
if (after > 0) await page.evaluate((k) => window.__ADEUK__!.step(k), after);

interface Hit {
  x: number;
  y: number;
}
const W = 640;
const H = 360;
/** Crop window in logical pixels. */
let crop = { x: 0, y: 0, w: W, h: H };
{
  const [x, y, w, h] = cropOpt.split(',').map(Number);
  crop = { x: x!, y: y!, w: w!, h: h! };
}
let hit: Hit | null = null;
const frames: { px: Uint32Array; tick: number }[] = [];
let tick = 0;
for (let i = 0; i < n; i++) {
  if (i > 0) {
    await page.evaluate((k) => window.__ADEUK__!.step(k), every);
    tick += every;
  }
  const res = await page.evaluate((cr) => {
    const api = window.__ADEUK__!;
    const ev = api.drainEventLog() as { t: string; x?: number; y?: number; energy?: number }[];
    const cap = api.captureLogical();
    const out = new Uint32Array(cr.w * cr.h);
    for (let y = 0; y < cr.h; y++)
      for (let x = 0; x < cr.w; x++) out[y * cr.w + x] = cap[(cr.y + y) * 640 + cr.x + x]!;
    const bytes = new Uint8Array(out.buffer);
    let bin = '';
    for (let k = 0; k < bytes.length; k += 8192) bin += String.fromCharCode(...bytes.subarray(k, k + 8192));
    const s = api.summary();
    return {
      ev: ev.filter((e) => e.t === 'hit').map((e) => ({ x: e.x!, y: e.y!, energy: e.energy! })),
      b64: btoa(bin),
      f: s.fighters.map((f) => ({ x: f.x, y: f.y, massFrac: f.massFrac, cells: f.cells })),
    };
  }, crop);
  if (!hit && res.ev.length) hit = { x: res.ev[0]!.x, y: res.ev[0]!.y };
  if (res.ev.length)
    console.log(
      `tick +${tick}: hit`,
      res.ev.map((e) => `${e.energy.toFixed(0)}@${e.x.toFixed(0)},${e.y.toFixed(0)}`).join(' '),
    );
  console.log(
    `tick +${tick}: cells ${res.f.map((f) => f.cells).join('/')}  fighters ${res.f.map((f) => `${f.x.toFixed(0)},${f.y.toFixed(0)}`).join(' ')}`,
  );
  const buf = Buffer.from(res.b64, 'base64');
  frames.push({ px: new Uint32Array(buf.buffer, buf.byteOffset, buf.length >> 2).slice(), tick });
}
if (errors.length) console.log('console errors:', errors.slice(0, 5).join(' | '));
await browser.close();

function toPng(px: Uint32Array, w: number, h: number): PNG {
  const img = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const v = px[i]!;
    img.data[i * 4] = v & 255;
    img.data[i * 4 + 1] = (v >>> 8) & 255;
    img.data[i * 4 + 2] = (v >>> 16) & 255;
    img.data[i * 4 + 3] = 255;
  }
  return img;
}
console.log(`crop ${crop.x},${crop.y} ${crop.w}x${crop.h}, zoom ${zoom}`);
const fw = crop.w * zoom;
const fh = crop.h * zoom;
const rows = Math.ceil(frames.length / cols);
const sheet = new PNG({ width: fw * cols, height: fh * rows });
frames.forEach((f, k) => {
  const src = toPng(f.px, crop.w, crop.h);
  const ox = (k % cols) * fw;
  const oy = Math.floor(k / cols) * fh;
  for (let y = 0; y < fh; y++)
    for (let x = 0; x < fw; x++) {
      const s = (Math.floor(y / zoom) * crop.w + Math.floor(x / zoom)) * 4;
      const d = ((oy + y) * sheet.width + ox + x) * 4;
      sheet.data[d] = src.data[s]!;
      sheet.data[d + 1] = src.data[s + 1]!;
      sheet.data[d + 2] = src.data[s + 2]!;
      sheet.data[d + 3] = 255;
    }
  label(sheet, `t${f.tick}`, ox + 4, oy + 4, 2);
});
writeFileSync(out, PNG.sync.write(sheet));
console.log('saved', out);
