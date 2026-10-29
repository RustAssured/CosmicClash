import { mkdirSync, writeFileSync } from 'node:fs';
import { launch } from '../../lead/browser';
import { startRenderServer } from '../../render/devserver';

/**
 * "WHAT'S LEFT": render the score (dev/press/sixty.ts, cue sheet tools/press/sixty/cue.ts) → press/sixty/score.wav.
 *   npx tsx tools/press/sixty/score.ts
 */
mkdirSync('press/sixty', { recursive: true });
const { server, url } = await startRenderServer(5203);
const browser = await launch();
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(`[pageerror] ${e.message}`));
  await page.goto(`${url}/dev/press/sixty.html`);
  await page.waitForFunction(() => window.__sixty !== undefined, null, { timeout: 300_000 });
  const t = Date.now();
  const r = (await page.evaluate(() => window.__sixty!.render(60))) as { wav: string; peak: number };
  writeFileSync('press/sixty/score.wav', Buffer.from(r.wav, 'base64'));
  console.log(`press/sixty/score.wav: peak ${r.peak.toFixed(3)}, ${((Date.now() - t) / 1000).toFixed(0)} s`);
} finally {
  await browser.close();
  await server.close();
}
