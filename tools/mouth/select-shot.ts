/**
 * The character select with and without the Mouth's unlock flag (D37): `?mode=select` vs `?mode=select&mouth=1`.
 *   npx tsx tools/mouth/select-shot.ts [--out=docs/gallery/mouth]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { launch, openGame } from '../lead/browser';
import { startRenderServer } from '../render/devserver';

const outDir = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? 'docs/gallery/mouth';
mkdirSync(outDir, { recursive: true });
const { server, url } = await startRenderServer();
const browser = await launch();
try {
  for (const [name, q] of [
    ['select-locked', '?mode=select'],
    ['select-unlocked', '?mode=select&mouth=1'],
  ] as const) {
    const { page, errors } = await openGame(browser, `${url}/${q}`, { width: 1280, height: 720 });
    await page.waitForTimeout(1500);
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
    writeFileSync(`${outDir}/${name}.png`, PNG.sync.write(png));
    console.log(
      `${name}: ${outDir}/${name}.png ${errors.length ? errors.slice(0, 3).join(' | ') : 'no console problems'}`,
    );
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
