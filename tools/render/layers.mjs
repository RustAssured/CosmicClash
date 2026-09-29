#!/usr/bin/env node
/**
 * Debug: screenshot the render sandbox with only some scenery layers visible.
 *   node tools/render/layers.mjs <out.png> [--only=a,b] [--hide=a,b] [--url=...query] [--list]
 *   --eval="js"     run JS in the page after layers are toggled (window.__RENDER__ is the sandbox API), then redraw
 *   --crop=x,y,w,h  screenshot only that region of the 1280x720 canvas (2x logical pixels)
 * Layer names are those given to kit.addSprites/addFullscreen/addQuad (e.g. sky, gas-far, pillars-dust, wisps).
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--'));
const opt = Object.fromEntries(
  args
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.length ? v.join('=') : true];
    }),
);
const base = process.env.RENDER_URL || 'http://localhost:5201/dev/render/';
const query = opt.url || 'stage=nursery&quality=2&freeze=1&t=5&text=0&ui=0&sparks=0';
mkdirSync(dirname(out || '.scratch/render/x.png'), { recursive: true });
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
page.on(
  'console',
  (m) =>
    (m.type() === 'error' || m.type() === 'warning') &&
    !/404/.test(m.text()) &&
    console.log(`[console.${m.type()}]`, m.text()),
);
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${base}?${query}`);
await page.waitForFunction("document.body.dataset.ready==='1'", null, { timeout: 120000 });
const only = opt.only ? String(opt.only).split(',') : null;
const hide = opt.hide ? String(opt.hide).split(',') : [];
const names = await page.evaluate(
  ([only, hide]) => {
    const R = window.__RENDER__.renderer;
    const layers = R.scenery.kit.layers;
    for (const l of layers) l.mesh.visible = only ? only.includes(l.name) : !hide.includes(l.name);
    window.__RENDER__.drawNow();
    return layers.map((l) => l.name);
  },
  [only, hide],
);
if (opt.list) console.log(names.join(' '));
if (opt.eval) {
  await page.evaluate(String(opt.eval));
  await page.evaluate('window.__RENDER__.drawNow()');
}
await page.waitForTimeout(200);
const clip = opt.crop ? String(opt.crop).split(',').map(Number) : null;
if (out)
  await page.screenshot({
    path: out,
    ...(clip ? { clip: { x: clip[0], y: clip[1], width: clip[2], height: clip[3] } } : {}),
  });
await browser.close();
if (out) console.log('saved', out);
