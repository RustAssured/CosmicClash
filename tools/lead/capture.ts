/**
 * Evidence capture for the review loop (Playwright, headless Chromium, software WebGL2).
 *   npx tsx tools/lead/capture.ts <suite> [--base=http://localhost:4173] [--out=.scratch/evidence] [--titans=a,b] [--stages=x,y]
 * suites:
 *   titans      every titan (vs a fixed foe) intact / 50% / 10% on every stage         → titans-<stage>-<titan>-<state>.png
 *   strips      12-frame strips of each titan's Crush and Signature                   → strip-<titan>-<move>.png
 *   aivai       AI-vs-AI frame sequence per matchup                                    → aivai-<a>-<b>.png
 *   screens     title / mode / select / controller check screens                       → screen-<name>.png
 *   thumbs      64 px thumbnails of every titan (legibility check)                     → thumbs.png
 */
import { mkdirSync } from 'node:fs';
import { PNG } from 'pngjs';
import { launch, openGame } from './browser';
import { writeFileSync } from 'node:fs';
import { STAGE_IDS, TITAN_IDS } from '@/contracts';

const arg = (k: string, d: string): string =>
  process.argv
    .find((a) => a.startsWith(`--${k}=`))
    ?.split('=')
    .slice(1)
    .join('=') ?? d;
const suite = process.argv[2] ?? 'titans';
const base = arg('base', 'http://localhost:4173');
const out = arg('out', '.scratch/evidence');
const titans = arg('titans', TITAN_IDS.join(',')).split(',');
const stages = arg('stages', STAGE_IDS.join(',')).split(',');
mkdirSync(out, { recursive: true });

const browser = await launch();
let failures = 0;

async function shot(url: string, file: string, ticks = 0, wait = 200): Promise<void> {
  const { page, errors } = await openGame(browser, url);
  if (ticks) await page.evaluate((n) => window.__ADEUK__!.step(n), ticks);
  await page.waitForTimeout(wait);
  await page.locator('#game').screenshot({ path: `${out}/${file}` });
  if (errors.length) {
    failures += errors.length;
    console.log(`${file}: ${errors.join(' | ')}`);
  }
  await page.close();
}

/** Compose PNG buffers into a grid contact sheet (nearest, downscale by `div`). */
function montage(frames: Buffer[], cols: number, div: number, file: string): void {
  const imgs = frames.map((b) => PNG.sync.read(b));
  const fw = Math.floor(imgs[0]!.width / div);
  const fh = Math.floor(imgs[0]!.height / div);
  const rows = Math.ceil(imgs.length / cols);
  const sheet = new PNG({ width: fw * cols, height: fh * rows });
  imgs.forEach((im, n) => {
    const ox = (n % cols) * fw;
    const oy = Math.floor(n / cols) * fh;
    for (let y = 0; y < fh; y++)
      for (let x = 0; x < fw; x++) {
        const s = (y * div * im.width + x * div) * 4;
        const d = ((oy + y) * sheet.width + ox + x) * 4;
        sheet.data[d] = im.data[s]!;
        sheet.data[d + 1] = im.data[s + 1]!;
        sheet.data[d + 2] = im.data[s + 2]!;
        sheet.data[d + 3] = 255;
      }
  });
  writeFileSync(`${out}/${file}`, PNG.sync.write(sheet));
}

async function strip(url: string, file: string, stepEvery: number, n = 12, div = 2): Promise<void> {
  const { page, errors } = await openGame(browser, url);
  const frames: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) await page.evaluate((k) => window.__ADEUK__!.step(k), stepEvery);
    frames.push(await page.locator('#game').screenshot());
  }
  montage(frames, 4, div, file);
  if (errors.length) {
    failures += errors.length;
    console.log(`${file}: ${errors.join(' | ')}`);
  }
  await page.close();
}

const foe = (t: string): string => (t === 'asteroid' ? 'lastone' : 'asteroid');
/** Close the gap, then perform the move. Script tick 0 = the moment the fight goes live. */
const SCRIPTS: Record<string, string> = {
  crush: '4:crush',
  signature: '4:sig*45',
  ultimate: '4:ult',
};
const GAP = 190;

if (suite === 'titans' || suite === 'all') {
  for (const stage of stages)
    for (const t of titans)
      for (const state of ['intact', '50', '10'])
        await shot(
          `${base}/?stage=${stage}&a=${t}&b=${foe(t)}&state=${state}&seed=5&hud=1&freeze=1`,
          `titans-${stage}-${t}-${state}.png`,
          30,
        );
}
if (suite === 'strips' || suite === 'all') {
  for (const t of titans)
    for (const [move, script] of Object.entries(SCRIPTS))
      await strip(
        `${base}/?stage=nursery&a=${t}&b=${foe(t)}&seed=5&hud=0&freeze=1&gap=${GAP}&meter=1&script0=${encodeURIComponent(script)}`,
        `strip-${t}-${move}.png`,
        move === 'ultimate' ? 18 : 9,
      );
}
if (suite === 'aivai' || suite === 'all') {
  const pairs: [string, string][] = [
    ['lastone', 'asteroid'],
    ...titans.slice(0, 5).map((t, i) => [t, titans[(i + 1) % titans.length]!] as [string, string]),
  ];
  for (const [a, b] of pairs)
    await strip(
      `${base}/?mode=aivai&stage=nursery&a=${a}&b=${b}&seed=21&ai=4&hud=1&freeze=1`,
      `aivai-${a}-${b}.png`,
      60,
    );
}
if (suite === 'screens' || suite === 'all') {
  for (const m of ['title', 'menu', 'select', 'controller'])
    await shot(`${base}/?mode=${m}`, `screen-${m}.png`, 0, 800);
}
if (suite === 'thumbs' || suite === 'all') {
  const frames: Buffer[] = [];
  for (const t of titans) {
    const { page } = await openGame(
      browser,
      `${base}/?stage=nursery&a=${t}&b=${foe(t)}&seed=5&hud=0&freeze=1`,
    );
    await page.evaluate(() => window.__ADEUK__!.step(20));
    frames.push(await page.locator('#game').screenshot());
    await page.close();
  }
  montage(frames, 3, 4, 'thumbs.png');
}
await browser.close();
if (failures) {
  console.error(`${failures} console errors/warnings during capture`);
  process.exit(2);
}
console.log(`evidence written to ${out}`);
