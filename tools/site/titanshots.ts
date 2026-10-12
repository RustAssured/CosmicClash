/**
 * Screenshots of the landing page's titan section (the roster grid) at desktop, tablet and phone widths, from the built
 * site in dist/ (`npm run build:site` first).
 *
 *   npx tsx tools/site/titanshots.ts [--tag=after]     # → docs/gallery/site/titans-<width>-<tag>.png
 */
import { mkdirSync } from 'node:fs';
import { preview } from 'vite';
import { launch } from '../lead/browser';

const tag = process.argv.find((a) => a.startsWith('--tag='))?.slice(6) ?? 'after';
const OUT = 'docs/gallery/site';
mkdirSync(OUT, { recursive: true });

const server = await preview({
  preview: { port: 4189, strictPort: false, host: '127.0.0.1' },
  build: { outDir: 'dist' },
});
const base = server.resolvedUrls!.local[0]!;
const browser = await launch();
const WIDTHS: [string, number, number][] = [
  ['desktop', 1920, 1080],
  ['laptop', 1280, 800],
  ['tablet', 1024, 1366],
  ['phone', 390, 844],
];
for (const [name, width, height] of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'load' });
  await page.addStyleTag({ content: 'html{scroll-behavior:auto!important}.nav{display:none!important}' });
  await page.evaluate(() => document.fonts.ready);
  await page.locator('#titans').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  const path = `${OUT}/titans-${name}-${tag}.png`;
  await page.locator('#titans').screenshot({ path });
  console.log(path);
  await ctx.close();
}
await browser.close();
await new Promise<void>((r) => server.httpServer.close(() => r()));
