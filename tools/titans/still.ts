/**
 * A titan in a real fight, as the game draws it (the dev server, the real renderer, headless Edge): an AI-vs-AI match
 * stepped to the given ticks and captured at the native 640×360 ×2. Also captures the VS AI titan select with the titan
 * hovered, to show it is on the menu.
 *
 *   npx tsx tools/titans/still.ts <id> [--b=planet] [--stage=nursery] [--seed=21] [--ticks=300,900] [--out=docs/gallery/kit]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, openGame } from '../lead/browser';
import { startRenderServer } from '../render/devserver';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const id = args.find((a) => !a.startsWith('--'));
if (!id) throw new Error('usage: npx tsx tools/titans/still.ts <id> [--b=planet] [--ticks=300,900]');
const b = opt('b', 'planet');
const stage = opt('stage', 'nursery');
const seed = opt('seed', '21');
const ticks = opt('ticks', '300,900')
  .split(',')
  .map(Number)
  .sort((x, y) => x - y);
const OUT = opt('out', 'docs/gallery/kit');
mkdirSync(OUT, { recursive: true });

const { server, url } = await startRenderServer();
const browser = await launch();
try {
  const { page, errors } = await openGame(
    browser,
    `${url}/?mode=aivai&a=${id}&b=${b}&stage=${stage}&seed=${seed}&ai=4&freeze=1&q=2`,
    { width: 1280, height: 720 },
  );
  for (const t of ticks) {
    const now = (await page.evaluate(() => window.__ADEUK__!.summary().tick)) as number;
    if (t > now) await page.evaluate((n) => window.__ADEUK__!.step(n), t - now);
    await page.evaluate(() => window.__ADEUK__!.renderNow());
    const path = `${OUT}/${id}-vs-${b}-${stage}-t${t}.png`;
    writeFileSync(path, await page.screenshot({ type: 'png' }));
    console.log(path);
  }
  if (errors.length) console.log(`console: ${errors.slice(0, 5).join(' | ')}`);
  await page.close();
  // the titan select, as the roster stands (and with the Mouth unlocked: one more tile)
  for (const [q, name] of [
    ['mode=select', 'select'],
    ['mode=select&mouth=1', 'select-mouth'],
  ] as const) {
    const s = await openGame(browser, `${url}/?${q}`, { width: 1280, height: 720 });
    await s.page.waitForTimeout(1500);
    const path = `${OUT}/${id}-${name}.png`;
    writeFileSync(path, await s.page.screenshot({ type: 'png' }));
    console.log(path);
    await s.page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
