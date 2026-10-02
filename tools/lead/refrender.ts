import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, openGame } from './browser';

/**
 * DETERMINISTIC REFERENCE RENDER (SLICE_PLAN evidence, D24): a fight rendered frame by frame at exactly 60 fps, one sim tick
 * per frame, with the full post pipeline, and encoded to H.264. Unlike rtcapture (real time, real vsync, what WJ's machine
 * really does), nothing here can drop or double a frame: it shows what the game DRAWS, so motion can be judged without
 * capture artefacts. Never use it for performance numbers. Video only (the audio of a real-time capture is the reference).
 *
 *   npx tsx tools/lead/refrender.ts [--params="mode=aivai&a=lastone&b=planet&stage=shearfield&seed=21&ai=4&witness=1"]
 *                                   [--seconds=30] [--skip=0] [--name=ref] [--out=evidence/ref] [--crf=10] [--build=1]
 * `--skip` steps that many seconds without drawing first (jump to the moment you want). Needs ffmpeg on PATH.
 */
const opt = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const params = opt('params', 'mode=aivai&a=lastone&b=planet&stage=shearfield&seed=21&ai=4&witness=1');
const seconds = Number(opt('seconds', '30'));
const skip = Number(opt('skip', '0'));
const name = opt('name', 'ref');
const out = opt('out', 'evidence/ref');
const crf = opt('crf', '10');
mkdirSync(out, { recursive: true });

const VITE = 'node_modules/vite/bin/vite.js';
const base = 'http://localhost:4173';
async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}
let server: ChildProcess | null = null;
if (opt('build', '0') === '1' || !existsSync('dist/index.html')) {
  console.log('building production bundle...');
  await new Promise<void>((res, rej) => {
    const b = spawn(process.execPath, [VITE, 'build', '--logLevel', 'warn'], { stdio: 'inherit' });
    b.on('exit', (c) => (c === 0 ? res() : rej(new Error(`vite build exited ${c}`))));
  });
}
if (!(await reachable(base))) {
  server = spawn(process.execPath, [VITE, 'preview', '--port', '4173', '--strictPort'], { stdio: 'ignore' });
  for (let i = 0; i < 60 && !(await reachable(base)); i++) await new Promise((r) => setTimeout(r, 500));
}

const file = join(out, `${name}.mp4`);
const url = `${base}/?${params}&freeze=1&aftermath=0&q=2`;
console.log(`${name}: ${url}`);
const browser = await launch();
try {
  // 1920×1080 at dpr 1: the 480×270 logical frame at ×4, every game pixel a 4×4 block (chroma subsampling stays inside it)
  const { page, errors } = await openGame(browser, url, { width: 1920, height: 1080 });
  await page.evaluate(() => window.__ADEUK__!.run(false));
  if (skip > 0) await page.evaluate((n) => window.__ADEUK__!.step(n), Math.round(skip * 60));
  const ff = spawn(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-framerate',
      '60',
      '-i',
      '-',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      crf,
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      file,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const done = new Promise<number>((res) => ff.on('exit', (c) => res(c ?? 1)));
  const frames = Math.round(seconds * 60);
  const t0 = Date.now();
  for (let i = 0; i < frames; i++) {
    await page.evaluate(() => {
      const h = window.__ADEUK__!;
      h.step(1);
      h.renderNow();
    });
    const png = await page.screenshot({ type: 'png' });
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 600 === 0) {
      const s = await page.evaluate(() => window.__ADEUK__!.summary());
      console.log(
        `  frame ${i}/${frames}  tick ${s.tick}  ${s.phase}  round ${s.round}  wins ${s.wins.join('-')}`,
      );
    }
    if (await page.evaluate(() => window.__ADEUK__!.matchPhase() === 'matchend')) {
      console.log(`  match ended at frame ${i}`);
      break;
    }
  }
  ff.stdin.end();
  const code = await done;
  console.log(`${file}: ffmpeg exit ${code}, ${((Date.now() - t0) / 1000).toFixed(0)} s wall`);
  if (errors.length) console.log(`console errors:\n  ${errors.slice(0, 10).join('\n  ')}`);
} finally {
  await browser.close();
  server?.kill();
}
