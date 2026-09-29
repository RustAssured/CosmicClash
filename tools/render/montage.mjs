#!/usr/bin/env node
/**
 * Tile several screenshots into one contact sheet so a whole stage (or all stages) can be judged at a glance.
 *   node tools/render/montage.mjs out.png in1.png in2.png … [--cols=2] [--scale=0.5]
 * Uses headless Chromium's canvas (no image library needed).
 */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = Object.fromEntries(
  args
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.length ? v.join('=') : true];
    }),
);
const files = args.filter((a) => !a.startsWith('--'));
const out = files.shift();
if (!out || !files.length) {
  console.error('usage: montage.mjs out.png in1.png [in2.png …] [--cols=2] [--scale=0.5]');
  process.exit(1);
}
const cols = Number(opt.cols ?? 2);
const scale = Number(opt.scale ?? 0.5);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
const urls = files.map((f) => `data:image/png;base64,${readFileSync(f).toString('base64')}`);
const png = await page.evaluate(
  async ({ urls, cols, scale }) => {
    const imgs = await Promise.all(
      urls.map(
        (u) =>
          new Promise((res, rej) => {
            const i = new Image();
            i.onload = () => res(i);
            i.onerror = rej;
            i.src = u;
          }),
      ),
    );
    const w = Math.round(imgs[0].width * scale);
    const h = Math.round(imgs[0].height * scale);
    const rows = Math.ceil(imgs.length / cols);
    const c = document.createElement('canvas');
    c.width = w * cols;
    c.height = h * rows;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    imgs.forEach((im, k) => g.drawImage(im, (k % cols) * w, Math.floor(k / cols) * h, w, h));
    return c.toDataURL('image/png').split(',')[1];
  },
  { urls, cols, scale },
);
writeFileSync(out, Buffer.from(png, 'base64'));
await browser.close();
console.log('saved', out);
