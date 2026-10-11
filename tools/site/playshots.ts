/**
 * Screenshot the built game at play/ (dist/, from `npm run build:site`) at the display sizes that matter, into
 * docs/gallery/play/<label>-<case>-<screen>.png, and print the integer scale each one reaches.
 *
 *   npx tsx tools/site/playshots.ts after
 *
 * Cases: WJ's laptop (1920×1080 panel at 125 %) full screen (1536×864 CSS) and in a maximised Edge window (≈1536×742 CSS),
 * and a plain 1080p desktop (1920×1080 at 100 %). Screens: the boot screen (press any button) and a frozen fight.
 */
import { mkdirSync } from 'node:fs';
import { preview } from 'vite';
import { launch } from '../lead/browser';

const label = process.argv[2] ?? 'shot';
const OUT = 'docs/gallery/play';
mkdirSync(OUT, { recursive: true });

const server = await preview({
  preview: { port: 4189, strictPort: false, host: '127.0.0.1' },
  build: { outDir: 'dist' },
});
const base = server.resolvedUrls!.local[0]!;
const browser = await launch();

const CASES = [
  { id: '1536x864@1.25', width: 1536, height: 864, dpr: 1.25 },
  { id: '1536x742@1.25', width: 1536, height: 742, dpr: 1.25 },
  { id: '1920x1080@1', width: 1920, height: 1080, dpr: 1 },
];
const SCREENS = [
  { id: 'boot', query: '', fill: false },
  { id: 'fight', query: '?t=150&hud=1', fill: false },
  // Options › FILL SCREEN on (stored setting): the non-integer nearest fit
  { id: 'fight-fill', query: '?t=150&hud=1', fill: true },
];

for (const c of CASES) {
  for (const s of SCREENS) {
    const ctx = await browser.newContext({
      viewport: { width: c.width, height: c.height },
      deviceScaleFactor: c.dpr,
    });
    if (s.fill)
      await ctx.addInitScript(() => localStorage.setItem('adeuk.ui.v1', JSON.stringify({ fill: true })));
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    if (s.id === 'boot' && label !== 'before') {
      // the loading screen, before the game is ready: hold the game's module back until the shot is taken
      let release = (): void => undefined;
      const held = new Promise<void>((r) => (release = r));
      await page.route(/\/play\/assets\/index-[^/]*\.js$/, async (route) => {
        await held;
        await route.continue();
      });
      // (module scripts hold DOMContentLoaded back, so wait for the overlay's own images and fonts instead)
      await page.goto(`${base}play/${s.query}`, { waitUntil: 'commit' });
      await page.waitForFunction(
        () => !!document.getElementById('boot') && [...document.images].every((i) => i.complete),
      );
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/${label}-${c.id}-loading.png` });
      release();
      await page.waitForLoadState('load');
    } else await page.goto(`${base}play/${s.query}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ADEUK__?.ready === true, null, { timeout: 120_000 });
    await page.waitForTimeout(1500);
    const m = await page.evaluate(() => {
      const cv = document.getElementById('game') as HTMLCanvasElement;
      const fit = Math.min(cv.width / 640, cv.height / 360);
      return { canvas: [cv.width, cv.height], dpr: devicePixelRatio, fit };
    });
    const file = `${OUT}/${label}-${c.id}-${s.id}.png`;
    await page.screenshot({ path: file });
    const k = s.fill ? m.fit : Math.max(1, Math.floor(m.fit + 1e-9));
    const frame = `${Math.round(640 * k)}×${Math.round(360 * k)}`;
    console.log(
      `${label} ${c.id} ${s.id}: canvas ${m.canvas.join('×')} device px, ×${+k.toFixed(3)} (${frame}) → ${file}` +
        (errors.length ? `  ERRORS: ${errors.join(' | ')}` : ''),
    );
    await ctx.close();
  }
}

await browser.close();
await new Promise<void>((r) => server.httpServer.close(() => r()));
process.exit(0);
