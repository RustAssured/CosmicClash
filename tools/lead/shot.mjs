#!/usr/bin/env node
/**
 * Screenshot a page with headless Chromium + software WebGL2 (SwiftShader).
 *   node tools/lead/shot.mjs <url> <out.png> [--wait=1500] [--w=1280] [--h=720] [--selector=#game] [--waitfor="window.__READY__"] [--eval="js"] [--log]
 * Prints console errors/warnings and page errors (a clean run prints none). Exit code 2 if the page logged errors.
 * Use a running dev server (npx vite --port 52xx) or `npm run build && npx vite preview`.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const pos = args.filter((a) => !a.startsWith('--'));
const opt = Object.fromEntries(
  args
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.length ? v.join('=') : true];
    }),
);
const [url, out] = pos;
if (!url || !out) {
  console.error(
    'usage: shot.mjs <url> <out.png> [--wait=ms] [--w= --h=] [--selector=] [--waitfor=js] [--eval=js] [--log]',
  );
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: exe,
  args: [
    '--use-angle=swiftshader',
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: +(opt.w || 1280), height: +(opt.h || 720) } });
let bad = 0;
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning' || opt.log) {
    console.log(`[console.${m.type()}] ${m.text()}`);
    if (m.type() === 'error') bad++;
  }
});
page.on('pageerror', (e) => {
  console.log(`[pageerror] ${e.message}`);
  bad++;
});
await page.goto(url, { waitUntil: 'load' });
if (opt.waitfor) await page.waitForFunction(opt.waitfor, null, { timeout: 90000 });
await page.waitForTimeout(+(opt.wait || 1500));
if (opt.eval) console.log('eval →', JSON.stringify(await page.evaluate(opt.eval)));
const target = opt.selector ? page.locator(opt.selector) : page;
await target.screenshot({ path: out });
await browser.close();
console.log(`saved ${out}${bad ? `  (${bad} console/page errors!)` : ''}`);
process.exit(bad ? 2 : 0);
