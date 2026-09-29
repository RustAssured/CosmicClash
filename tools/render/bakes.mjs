#!/usr/bin/env node
/** Debug: dump the nursery's baked pillar textures (dust over a dark backdrop, glow) to .scratch/render/bake-*.png */
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';
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
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5201/dev/render/?stage=nursery&quality=1&freeze=1&t=5&text=0&ui=0');
await page.waitForFunction("document.body.dataset.ready==='1'", null, { timeout: 120000 });
const n = await page.evaluate(() => window.__RENDER__.renderer.scenery.bakes.length);
for (let b = 0; b < n; b++) {
  for (const idx of [0, 1]) {
    const r = await page.evaluate(
      ([b, idx]) => {
        const R = window.__RENDER__.renderer;
        const rt = R.scenery.bakes[b];
        const buf = new Uint8Array(rt.width * rt.height * 4);
        R.three.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf, undefined, idx);
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return { w: rt.width, h: rt.height, b64: btoa(s) };
      },
      [b, idx],
    );
    const buf = Buffer.from(r.b64, 'base64');
    const png = new PNG({ width: r.w, height: r.h });
    for (let y = 0; y < r.h; y++)
      for (let x = 0; x < r.w; x++) {
        const s = ((r.h - 1 - y) * r.w + x) * 4;
        const d = (y * r.w + x) * 4;
        const a = idx === 0 ? buf[s + 3] / 255 : 1;
        for (let k = 0; k < 3; k++) png.data[d + k] = Math.round(buf[s + k] * a + 12 * (1 - a));
        png.data[d + 3] = 255;
      }
    writeFileSync(`.scratch/render/bake-${b}-${idx === 0 ? 'dust' : 'glow'}.png`, PNG.sync.write(png));
    console.log('wrote bake', b, idx, r.w, r.h);
  }
}
await browser.close();
