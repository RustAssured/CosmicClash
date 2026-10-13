/**
 * The titan select in every mode, as the game draws it (dev server, headless Edge, the native 640×360 at ×2):
 * VERSUS, VS AI (your pick, then the opponent's), TRAINING and the TOURNAMENT select with its ladder panel, each with the
 * Mouth locked and unlocked, plus the cursor on the bottom row (the tiles nearest the prompt).
 *
 *   npx tsx tools/ui/select-shots.ts [--prefix=after] [--extra=wip=cradle] [--out=docs/gallery/select]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, openGame } from '../lead/browser';
import { startRenderServer } from '../render/devserver';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const prefix = opt('prefix', 'after');
const extra = opt('extra', '');
const OUT = opt('out', 'docs/gallery/select');
mkdirSync(OUT, { recursive: true });

/** [name, query, keys pressed after load] */
const CASES: [string, string, string[]][] = [
  ['versus', 'mode=select', []],
  ['vsai', 'mode=select&smode=vsai', []],
  ['vsai-opponent', 'mode=select&smode=vsai', ['Space']],
  ['training', 'mode=select&smode=training', []],
  ['training-bottom', 'mode=select&smode=training', ['KeyS', 'KeyS', 'KeyS', 'KeyS']],
  ['tournament', 'ladder=select', []],
  ['tournament-bottom', 'ladder=select', ['KeyS', 'KeyS', 'KeyS', 'KeyS']],
];

const { server, url } = await startRenderServer();
const browser = await launch();
try {
  for (const mouth of [false, true])
    for (const [name, q, keys] of CASES) {
      const full = `${q}${mouth ? '&mouth=1' : ''}${extra ? `&${extra}` : ''}`;
      const { page, errors } = await openGame(browser, `${url}/?${full}`, { width: 1280, height: 720 });
      await page.waitForTimeout(1200);
      for (const k of keys) {
        await page.keyboard.down(k);
        await page.waitForTimeout(90);
        await page.keyboard.up(k);
        await page.waitForTimeout(140);
      }
      await page.waitForTimeout(400);
      const path = `${OUT}/${prefix}-${name}${mouth ? '-mouth' : ''}.png`;
      writeFileSync(path, await page.screenshot({ type: 'png' }));
      console.log(path + (errors.length ? `  (${errors[0]})` : ''));
      await page.close();
    }
} finally {
  await browser.close();
  await server.close();
}
