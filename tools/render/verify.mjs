#!/usr/bin/env node
/**
 * GPU conformance of the renderer in a real WebGL2 context (headless Chromium + SwiftShader).
 *   node tools/render/verify.mjs [--url=http://localhost:5201/dev/render/verify.html]
 * Needs the dev server (npx vite --port 5201 --strictPort). Exit code 1 if any check fails or the page logs errors.
 */
import { chromium } from '@playwright/test';

const url =
  process.argv.find((a) => a.startsWith('--url='))?.slice(6) ||
  'http://localhost:5201/dev/render/verify.html';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-angle=swiftshader',
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
let bad = 0;
page.on('console', (m) => {
  if (
    (m.type() === 'error' || m.type() === 'warning') &&
    !/Failed to load resource|WebGL context lost|context lost/i.test(m.text())
  ) {
    console.log(`[console.${m.type()}] ${m.text()}`);
    bad++;
  }
});
page.on('pageerror', (e) => {
  console.log(`[pageerror] ${e.message}`);
  bad++;
});
await page.goto(url, { waitUntil: 'commit' });
await page.waitForFunction('window.__VERIFY__ && window.__VERIFY__.done', null, { timeout: 600000 });
const v = await page.evaluate('window.__VERIFY__');
for (const r of v.results)
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
if (v.error) console.log('ERROR', v.error);
console.log(
  `\n${v.results.length - v.failed}/${v.results.length} passed${bad ? `, ${bad} console errors` : ''}`,
);
await browser.close();
process.exit(v.failed || bad ? 1 : 0);
