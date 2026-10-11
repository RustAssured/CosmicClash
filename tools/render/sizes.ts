import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { launch, openGame } from '../lead/browser';

/**
 * D34 evidence: every titan at its game size, rendered by the game itself (headless, the production bundle served by
 * `vite preview`, one frame per matchup after a few deterministic ticks, the full post pipeline).
 *   npx tsx tools/render/sizes.ts [--out=docs/gallery/compare/sizes.png] [--stage=shearfield] [--ticks=40] [--build=1]
 * The sheet: one 640×360 frame per matchup at ×2, two per row, each labelled by its URL in the console output.
 */
const opt = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const out = opt('out', 'docs/gallery/compare/sizes.png');
const stage = opt('stage', 'shearfield');
const ticks = Number(opt('ticks', '40'));
const MATCHUPS: readonly string[] = (
  opt('matchups', 'colossus:planet,uri:planet,blackhole:nexus,supernova:asteroid') as string
).split(',');

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

const frames: PNG[] = [];
const browser = await launch();
try {
  for (const mu of MATCHUPS) {
    const [a, b, flag] = mu.split(':');
    const url = `${base}/?mode=versus&a=${a}&b=${b}&stage=${stage}&seed=5&hud=1&freeze=1&aftermath=0${flag === 'witness' ? '&witness=1' : ''}`;
    console.log(`${mu}: ${url}`);
    const { page, errors } = await openGame(browser, url, { width: 1280, height: 720 });
    await page.evaluate((n) => {
      const h = window.__ADEUK__!;
      h.step(n);
      h.renderNow();
    }, ticks);
    frames.push(PNG.sync.read(await page.locator('#game').screenshot()));
    if (errors.length) console.log(`  console: ${errors.slice(0, 5).join(' | ')}`);
    await page.close();
  }
} finally {
  await browser.close();
  server?.kill();
}

const fw = frames[0]!.width;
const fh = frames[0]!.height;
const cols = 2;
const rows = Math.ceil(frames.length / cols);
const sheet = new PNG({ width: fw * cols, height: fh * rows });
frames.forEach((im, n) => {
  const ox = (n % cols) * fw;
  const oy = Math.floor(n / cols) * fh;
  for (let y = 0; y < Math.min(fh, im.height); y++)
    for (let x = 0; x < Math.min(fw, im.width); x++) {
      const s = (y * im.width + x) * 4;
      const d = ((oy + y) * sheet.width + ox + x) * 4;
      sheet.data[d] = im.data[s]!;
      sheet.data[d + 1] = im.data[s + 1]!;
      sheet.data[d + 2] = im.data[s + 2]!;
      sheet.data[d + 3] = 255;
    }
});
mkdirSync(out.slice(0, out.lastIndexOf('/')), { recursive: true });
writeFileSync(out, PNG.sync.write(sheet));
console.log(`saved ${out} (${frames.length} matchups, ${cols} per row)`);
