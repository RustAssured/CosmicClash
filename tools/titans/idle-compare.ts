/**
 * Living-idle port check (idle handover): the approved prototype page and the game, both idling, side by side at the same
 * pixel density (1 map cell = 1 px), in lockstep. The prototype runs on a virtual clock (its `performance.now` and
 * `requestAnimationFrame` are driven by this tool, 1/60 s a frame), the game is a mirror match of the titan with both
 * fighters as idle dummies, stepped one tick (one rendered frame) at a time and cropped round fighter 0 (the camera held
 * still on it), on the real GPU (headless Edge). Both sides therefore show the same elapsed idle time in every sample.
 *
 *   npx tsx tools/titans/idle-compare.ts <titan> --proto=<path to the prototype's built .html> [--frames=8] [--every=30]
 *       [--warm=120] [--seed=21] [--stage=nursery] [--w=256] [--h=240] [--out=docs/gallery/idle/<titan>-compare.png]
 *       [--foe=<titan>] [--extra=unify=0] (extra URL params for the game) [--video=<out.mp4> --seconds=6] (a 30 fps side-by-side clip)
 *
 * Sheet: row 1 prototype, row 2 game. Video: prototype left, game right, ×3, encoded with ffmpeg (frames kept in
 * the system temp folder, `adeuk-idle-frames`, when ffmpeg is not on PATH). The prototype's canvas is read with getImageData (`--canvas=#cv`).
 */
import { mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { LOGICAL_H, LOGICAL_W } from '@/contracts';
import { launch, openGame } from '../lead/browser';
import { writeContactSheet, writePng, type SheetItem } from '../lead/png';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const titan = args.find((a) => !a.startsWith('--'));
const proto = opt('proto', '');
if (!titan || !proto) {
  console.error('usage: idle-compare.ts <titan> --proto=<built prototype .html>');
  process.exit(1);
}
const video = opt('video', '');
const FRAMES = video ? Math.round(+opt('seconds', '6') * 30) : +opt('frames', '8');
const EVERY = video ? 2 : +opt('every', '30');
const WARM = +opt('warm', '120');
const CW = +opt('w', '256');
const CH = +opt('h', '240');
const out = opt('out', `docs/gallery/idle/${titan}-compare.png`);

const server = await createServer({
  root: resolve('.'),
  logLevel: 'error',
  // scratch and evidence folders are written by other tools and sessions while this runs: a file half written under a
  // watched folder crashes the watcher (Windows lstat UNKNOWN)
  server: {
    port: 5291,
    strictPort: false,
    watch: { ignored: ['**/.scratch/**', '**/evidence/**', '**/docs/gallery/**'] },
  },
});
await server.listen();
const base = server.resolvedUrls?.local[0] ?? 'http://localhost:5291/';
const browser = await launch();

// ---- the prototype, on a virtual clock ----
const pp = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await pp.addInitScript(() => {
  let t = 0;
  const q: FrameRequestCallback[] = [];
  performance.now = (): number => t;
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => q.push(cb);
  (window as unknown as { __adv: (n: number) => void }).__adv = (n: number): void => {
    for (let s = 0; s < n; s++) {
      t += 1000 / 60;
      for (const cb of q.splice(0)) cb(t);
    }
  };
});
await pp.goto(pathToFileURL(resolve(proto)).href);
// the page decodes its matter asynchronously (real time), then its first frame waits on the virtual clock
await pp.waitForTimeout(2500);
await pp.evaluate((n) => (window as unknown as { __adv: (n: number) => void }).__adv(n), WARM);
const readProto = async (): Promise<SheetItem> => {
  const px = await pp.evaluate(
    (sel) => {
      const c = (sel ? document.querySelector(sel) : document.querySelector('canvas')) as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
      return { w: c.width, h: c.height, data: Array.from(new Uint8Array(d.data.buffer)) };
    },
    opt('canvas', ''),
  );
  return { pixels: new Uint32Array(new Uint8Array(px.data).buffer), w: px.w, h: px.h };
};

// ---- the game: a mirror match of idle dummies, one rendered frame per tick ----
// `--foe=<titan>`: a different (smaller) foe when the mirror twin would crowd the frame (the Planet)
const url = `${base}?mode=fight&a=${titan}&b=${opt('foe', titan)}&stage=${opt('stage', 'nursery')}&seed=${opt('seed', '21')}&p1=dummy&p2=dummy&freeze=1&hud=0&aftermath=0&tele=0&q=1${opt('extra', '') ? `&${opt('extra', '')}` : ''}`;
const { page, errors } = await openGame(browser, url, { width: 1280, height: 720 });
await page.evaluate((n) => {
  for (let i = 0; i < n; i++) window.__ADEUK__!.step(1);
}, WARM);
const readGame = async (n: number): Promise<SheetItem> => {
  const px = await page.evaluate(
    ({ n }) => {
      const api = window.__ADEUK__!;
      const f = api.summary().fighters[0];
      api.setCamera({ x: f.x, y: f.y, zoom: 1, still: true });
      if (n === 0) api.step(0);
      for (let k = 0; k < n; k++) api.step(1);
      return Array.from(new Uint8Array(api.captureLogical().buffer));
    },
    { n },
  );
  const full = new Uint32Array(new Uint8Array(px).buffer);
  const crop = new Uint32Array(CW * CH);
  const x0 = (LOGICAL_W >> 1) - (CW >> 1);
  const y0 = (LOGICAL_H >> 1) - (CH >> 1);
  for (let y = 0; y < CH; y++)
    for (let x = 0; x < CW; x++) {
      const sx = x0 + x;
      const sy = y0 + y;
      if (sx >= 0 && sy >= 0 && sx < LOGICAL_W && sy < LOGICAL_H)
        crop[y * CW + x] = full[sy * LOGICAL_W + sx]!;
    }
  return { pixels: crop, w: CW, h: CH };
};

if (video) {
  // outside the repo: the game's dev server watches the working tree, and a frame half written under it crashed the watcher
  const dir = resolve(tmpdir(), 'adeuk-idle-frames');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < FRAMES; i++) {
    if (i > 0)
      await pp.evaluate((n) => (window as unknown as { __adv: (n: number) => void }).__adv(n), EVERY);
    const a = await readProto();
    const b = await readGame(i === 0 ? 0 : EVERY);
    // prototype left, game right, a 4 px gutter
    const W = a.w + 4 + b.w;
    const H = Math.max(a.h, b.h);
    const f = new Uint32Array(W * H).fill(0xff1a0c08);
    for (let y = 0; y < a.h; y++) f.set(a.pixels.subarray(y * a.w, (y + 1) * a.w), y * W);
    for (let y = 0; y < b.h; y++) f.set(b.pixels.subarray(y * b.w, (y + 1) * b.w), y * W + a.w + 4);
    writePng(`${dir}/f${String(i).padStart(4, '0')}.png`, f, W, H, 3);
  }
  const r = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-framerate',
      '30',
      '-i',
      `${dir}/f%04d.png`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '16',
      video,
    ],
    { stdio: 'inherit' },
  );
  console.log(
    r.error || r.status !== 0
      ? `ffmpeg unavailable: frames are in ${dir} (ffmpeg -framerate 30 -i ${dir}/f%04d.png ${video})`
      : `${video}: prototype left, game right (${titan} mirror, idle dummies), ${FRAMES / 30} s at 30 fps`,
  );
} else {
  const protoItems: SheetItem[] = [];
  const gameItems: SheetItem[] = [];
  for (let i = 0; i < FRAMES; i++) {
    if (i > 0)
      await pp.evaluate((n) => (window as unknown as { __adv: (n: number) => void }).__adv(n), EVERY);
    protoItems.push(await readProto());
    gameItems.push(await readGame(i === 0 ? 0 : EVERY));
  }
  writeContactSheet(out, [...protoItems, ...gameItems], FRAMES, 2, 4);
  console.log(`${out}: row 1 prototype, row 2 game (${titan} mirror, idle dummies), every ${EVERY} ticks`);
}
await browser.close();
await server.close();
if (errors.length) console.log(`console: ${errors.slice(0, 5).join(' | ')}`);
