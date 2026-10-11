/**
 * The Mouth in the real game, headless on this machine's GPU (Gate 3E evidence): boots the harness into an AI-vs-AI fight,
 * steps it, and saves stills of the whole frame (scenery, HUD with the jaw-ring emblem, the shared VFX):
 *   npx tsx tools/mouth/ingame.ts [--foe=lastone] [--stage=mausoleum] [--at=200,420,700] [--out=docs/gallery/mouth] [--tag=]
 *        [--perf=1]   (frame cost with the Mouth vs the same foe against the Witness, same stage)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { launch, openGame } from '../lead/browser';
import { startRenderServer } from '../render/devserver';

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const foe = arg('foe', 'lastone');
const stage = arg('stage', 'mausoleum');
const at = arg('at', '200,420,700')
  .split(',')
  .map((s) => +s);
const outDir = arg('out', 'docs/gallery/mouth');
const tag = arg('tag', '');
const seed = arg('seed', '3');
const p1 = arg('p1', 'ai');
mkdirSync(outDir, { recursive: true });

const { server, url } = await startRenderServer();
const browser = await launch();
try {
  const q = `?a=mouth&b=${foe}&mode=aivai&p1=${p1}&p2=ai&stage=${stage}&seed=${seed}&ai=3&aftermath=0&q=1`;
  const { page, errors } = await openGame(browser, `${url}/${q}`, { width: 1280, height: 720 });
  await page.evaluate(() => window.__ADEUK__!.run(false));
  let tick = 0;
  for (const t of at) {
    await page.evaluate((n) => window.__ADEUK__!.step(n), t - tick);
    tick = t;
    await page.evaluate(() => {
      window.__ADEUK__!.renderNow();
      window.__ADEUK__!.renderNow();
    });
    const px = (await page.evaluate(() => Array.from(window.__ADEUK__!.captureLogical()))) as number[];
    const png = new PNG({ width: 640, height: 360 });
    for (let i = 0; i < px.length; i++) {
      const v = px[i]!;
      png.data[i * 4] = v & 255;
      png.data[i * 4 + 1] = (v >>> 8) & 255;
      png.data[i * 4 + 2] = (v >>> 16) & 255;
      png.data[i * 4 + 3] = 255;
    }
    const file = `${outDir}/ingame-${foe}${tag ? '-' + tag : ''}-t${t}.png`;
    writeFileSync(file, PNG.sync.write(png));
    const s = (await page.evaluate(() => window.__ADEUK__!.summary())) as {
      phase: string;
      fighters: { titan: string; state: string; moveId: string | null; integrityPct: number }[];
    };
    console.log(
      `${file}: ${s.phase} ${s.fighters.map((f) => `${f.titan} ${f.state} ${f.moveId ?? ''} ${f.integrityPct.toFixed(0)}%`).join(' | ')}`,
    );
  }
  if (arg('perf', '0') === '1') {
    const perf = await page.evaluate(() => window.__ADEUK__!.benchFrames(240));
    console.log('perf with the Mouth', JSON.stringify(perf));
    await page.close();
    const other = await openGame(browser, `${url}/${q.replace('a=mouth', 'a=colossus')}`, {
      width: 1280,
      height: 720,
    });
    await other.page.evaluate(() => window.__ADEUK__!.run(false));
    await other.page.evaluate(() => window.__ADEUK__!.step(200));
    const perf2 = await other.page.evaluate(() => window.__ADEUK__!.benchFrames(240));
    console.log('perf with the colossus instead', JSON.stringify(perf2));
  }
  if (errors.length) console.log(`console: ${errors.slice(0, 8).join(' | ')}`);
  else console.log('no console problems');
} finally {
  await browser.close();
  await server.close();
}
