/**
 * Tournament ladder stills (the `?ladder=` dev flag, src/app/harness.ts): the title menu, the tower, story cards, the defeat
 * menu, the ending and the select after the Mouth's unlock, captured at the native 640×360.
 *   npx tsx tools/ladder/shots.ts [--out=docs/gallery/ladder]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { launch, openGame } from '../lead/browser';
import { startRenderServer } from '../render/devserver';

const outDir = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? 'docs/gallery/ladder';
mkdirSync(outDir, { recursive: true });

interface Shot {
  name: string;
  q: string;
  wait: number;
  /** Runs before the capture (key presses, stored progress + reload). */
  prep?: (page: Page) => Promise<void>;
}

const BEST = JSON.stringify({ run: null, best: { uri: 9, planet: 5, asteroid: 3, colossus: 7, mouth: 2 } });

const shots: Shot[] = [
  {
    name: 'menu',
    q: '?mode=title',
    wait: 800,
    prep: async (page) => {
      // a returning player: the HOW TO PLAY pages do not open by themselves
      await page.evaluate(() => localStorage.setItem('adeuk.ui.v1', JSON.stringify({ seenHowTo: true })));
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => window.__ADEUK__?.ready === true, null, { timeout: 120_000 });
      await page.waitForTimeout(800);
      for (let i = 0; i < 2; i++) {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(250);
      }
      await page.waitForTimeout(600);
    },
  },
  { name: 'tower-uri-rung4', q: '?ladder=4', wait: 1500 },
  { name: 'tower-planet-rung7', q: '?ladder=7&as=planet', wait: 1500 },
  { name: 'tower-lose', q: '?ladder=5&as=supernova&view=lose', wait: 1500 },
  { name: 'card-rung1', q: '?ladder=1&view=card', wait: 2600 },
  { name: 'card-subboss-lastone', q: '?ladder=7&view=card', wait: 3200 },
  { name: 'card-subboss-uri', q: '?ladder=7&as=nexus&view=card', wait: 3200 },
  { name: 'card-final-mouth', q: '?ladder=8&view=card', wait: 3400 },
  { name: 'ending', q: '?ladder=end', wait: 5600 },
  { name: 'ending-mouth', q: '?ladder=end&as=mouth', wait: 5600 },
  {
    name: 'select-unlocked',
    q: '?ladder=select&mouth=1',
    wait: 1500,
    prep: async (page) => {
      await page.evaluate((b) => localStorage.setItem('adeuk.ladder.v1', b), BEST);
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => window.__ADEUK__?.ready === true, null, { timeout: 120_000 });
      await page.waitForTimeout(1500);
    },
  },
];

const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const { server, url } = await startRenderServer();
const browser = await launch();
try {
  for (const s of shots) {
    if (only && !s.name.includes(only)) continue;
    const { page, errors } = await openGame(browser, `${url}/${s.q}`, { width: 1280, height: 720 });
    await page.waitForTimeout(s.wait);
    if (s.prep) await s.prep(page);
    await page.evaluate(() => window.__ADEUK__!.renderNow());
    const px = (await page.evaluate(() => Array.from(window.__ADEUK__!.captureLogical()))) as number[];
    const png = new PNG({ width: 640, height: 360 });
    for (let i = 0; i < px.length; i++) {
      const v = px[i]!;
      png.data[i * 4] = v & 255;
      png.data[i * 4 + 1] = (v >>> 8) & 255;
      png.data[i * 4 + 2] = (v >>> 16) & 255;
      png.data[i * 4 + 3] = 255;
    }
    writeFileSync(`${outDir}/${s.name}.png`, PNG.sync.write(png));
    console.log(`${s.name}: ${errors.length ? errors.slice(0, 3).join(' | ') : 'no console problems'}`);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
