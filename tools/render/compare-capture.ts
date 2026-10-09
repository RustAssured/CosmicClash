import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { launch, openGame } from '../lead/browser';
import { startRenderServer } from './devserver';

/**
 * D34 before / after stills of the comparison scenes (docs/COMPARISON_ORIGINAL_VS_NOW.md): the real game (harness boot, AI vs AI,
 * seed 21, level 4), one sim tick per step, frames at fixed ticks, the 640×360 logical frame 1:1.
 *   npx tsx tools/render/compare-capture.ts --tag=after [--out=docs/gallery/compare] [--scenes=all] [--extra=unify=0]
 * Writes <out>/<tag>-<scene>.png (one row of frames per scene) and <out>/<tag>-sheet.png (all scenes). LOOK at every image.
 */
const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const tag = arg('tag', 'after');
const outDir = arg('out', 'docs/gallery/compare');
const extra = arg('extra', '');
mkdirSync(outDir, { recursive: true });

const SCENES: Record<string, string> = {
  'witness-planet-nursery': 'a=lastone&b=planet&stage=nursery',
  'blackhole-nexus-nursery': 'a=blackhole&b=nexus&stage=nursery',
  'supernova-planet-nursery': 'a=supernova&b=planet&stage=nursery',
  'witness-asteroid-rim': 'a=lastone&b=asteroid&stage=rim',
  'witness-planet-mausoleum': 'a=lastone&b=planet&stage=mausoleum',
  'supernova-blackhole-shearfield': 'a=supernova&b=blackhole&stage=shearfield',
  'nexus-asteroid-redgiant': 'a=nexus&b=asteroid&stage=redgiant',
  'planet-supernova-quasar': 'a=planet&b=supernova&stage=quasar',
};
const TICKS = [150, 330, 520, 700, 880, 1080];
const scenes = arg('scenes', 'all') === 'all' ? Object.keys(SCENES) : arg('scenes', '').split(',');
const W = 960;
const H = 540;

const { server, url } = await startRenderServer();
const browser = await launch();
const rows: PNG[] = [];
try {
  for (const s of scenes) {
    const { page, errors } = await openGame(
      browser,
      `${url}/?mode=aivai&${SCENES[s]}&seed=21&ai=4&freeze=1&aftermath=0&q=1${extra ? '&' + extra : ''}`,
      { width: W, height: H },
    );
    const row = new PNG({ width: 640 * TICKS.length, height: 360 });
    let at = 0;
    for (let k = 0; k < TICKS.length; k++) {
      const n = TICKS[k]! - at;
      at = TICKS[k]!;
      await page.evaluate(`(() => { window.__ADEUK__.step(${n}); window.__ADEUK__.renderNow(); })()`);
      // the final logical frame (640 × 360, the governor's gain applied by the final pass is not in it), 1:1
      // (as base64: a 230 400-element array through the protocol is very slow)
      const b64 = (await page.evaluate(
        `(() => { const u = window.__ADEUK__.captureLogical(); const b = new Uint8Array(u.buffer, u.byteOffset, u.byteLength); let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return btoa(s); })()`,
      )) as string;
      const raw = Buffer.from(b64, 'base64');
      const px = new Uint32Array(new Uint8Array(raw).buffer);
      for (let y = 0; y < 360; y++)
        for (let x = 0; x < 640; x++) {
          const v = px[y * 640 + x]!;
          const di = (y * row.width + k * 640 + x) * 4;
          row.data[di] = v & 255;
          row.data[di + 1] = (v >>> 8) & 255;
          row.data[di + 2] = (v >>> 16) & 255;
          row.data[di + 3] = 255;
        }
    }
    writeFileSync(`${outDir}/${tag}-${s}.png`, PNG.sync.write(row));
    rows.push(row);
    console.log(`${tag}-${s}.png${errors.length ? ` (${errors.length} console errors: ${errors[0]})` : ''}`);
    await page.close();
  }
  const sheet = new PNG({ width: rows[0]!.width, height: rows.reduce((a, r) => a + r.height, 0) });
  let y0 = 0;
  for (const r of rows) {
    r.data.copy(sheet.data, y0 * sheet.width * 4);
    y0 += r.height;
  }
  writeFileSync(`${outDir}/${tag}-sheet.png`, PNG.sync.write(sheet));
  console.log(`${tag}-sheet.png`);
} finally {
  await browser.close();
  await server.close();
}
