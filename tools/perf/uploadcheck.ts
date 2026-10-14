/**
 * S21 correctness check for the partial texture uploads (the matter debris / particle layers' dirty rectangles, the UI's
 * diffed rectangle, unchanged layers not uploaded at all): a production build plays deterministic scenarios in headless Edge
 * on the GPU with `?layercheck=1`, and after EVERY frame each layer texture drawn in it is read back and compared with that
 * layer's pixels (src/render/layerTextures.ts `debugVerify`). Any stale texel is reported.
 *
 *   npx tsx tools/perf/uploadcheck.ts [--build=1] [--frames=360] [--out=.scratch/perf/uc]
 *
 * Scenarios: AI-vs-AI fights (debris everywhere, HUD changing) and Ultimates on a still foe. Exit code 1 on any mismatch.
 */
import { resolve } from 'node:path';
import { build, preview } from 'vite';
import { launch, openGame } from '../lead/browser';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const OUT = resolve(opt('out', '.scratch/perf/uc'));
const FRAMES = +opt('frames', '360');

const SCENARIOS = [
  'mode=aivai&a=lastone&b=planet&stage=nursery&seed=21&ai=5',
  'mode=aivai&a=uri&b=supernova&stage=nursery&seed=4&ai=5',
  'a=planet&b=cradle&seed=7&stage=nursery&p1=dummy&p2=dummy&script0=10:ult&meter=1&gap=210',
  'a=cradle&b=planet&seed=7&stage=nursery&p1=dummy&p2=dummy&script0=10:ult&meter=1&gap=210',
  'a=asteroid&b=planet&seed=7&stage=nursery&p1=dummy&p2=dummy&script0=10:ult&meter=1&gap=210',
];

if (opt('build', '1') === '1')
  await build({ logLevel: 'warn', build: { outDir: OUT, emptyOutDir: true, sourcemap: false } });
const server = await preview({
  build: { outDir: OUT },
  preview: { port: 4319, strictPort: false, host: '127.0.0.1' },
  logLevel: 'error',
});
const base = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:4319/';
const browser = await launch();

let bad = 0;
for (const sc of SCENARIOS) {
  const { page } = await openGame(
    browser,
    `${base}?${sc}&freeze=1&hud=1&aftermath=0&tele=0&q=1&layercheck=1`,
  );
  await page.evaluate('window.__name = (f) => f');
  const res = await page.evaluate((frames: number) => {
    const api = window.__ADEUK__!;
    const check = (window as unknown as { __ADEUK_LAYERCHECK__: () => { checked: number; bad: string[] } })
      .__ADEUK_LAYERCHECK__;
    let checked = 0;
    const errs: string[] = [];
    for (let i = 0; i < frames; i++) {
      api.step(1);
      const r = check();
      checked += r.checked;
      for (const b of r.bad) if (errs.length < 8) errs.push(`frame ${i + 1}: ${b}`);
    }
    return { checked, errs };
  }, FRAMES);
  await page.close();
  if (res.errs.length) bad++;
  console.log(
    `${res.errs.length ? 'STALE' : 'OK   '} ${sc.slice(0, 64).padEnd(64)} ${FRAMES} frames, ${res.checked} textures read back`,
  );
  for (const e of res.errs) console.log(`        ${e}`);
}
await browser.close();
server.httpServer.close();
process.exit(bad ? 1 : 0);
