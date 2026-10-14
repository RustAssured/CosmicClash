/**
 * Render-side companion of tools/perf/ultspikes.ts (S19): every titan's Ultimate in the REAL game, a production build in
 * headless Edge on this machine's GPU, one sim tick + one rendered frame at a time, timed per frame.
 *
 *   npx tsx tools/perf/ultframes.ts [--root=.] [--build=1] [--out=.scratch/perf/play] [--only=cradle] [--foe=planet]
 *       [--frames=300] [--json=…]
 *
 * `--root`: the source tree to build (a checkout of another commit works: its own index.html / vite.config.ts / src).
 * `--build=0` reuses the build in `--out`.
 * Per frame: `cpu` = the harness `step(1)` (one tick + camera + layers + renderer.draw + UI: everything on the main thread),
 * `sync` = the same plus a read-back of the final frame, which waits for the GPU to finish it (an upper bound of what the
 * frame costs with the GPU's share). Reported: p50 / p95 / p99 / max per titan.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build, preview } from 'vite';
import { launch, openGame } from '../lead/browser';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const ROOT = resolve(opt('root', '.'));
const OUT = resolve(opt('out', '.scratch/perf/play'));
const FRAMES = +opt('frames', '300');
const FOE = opt('foe', 'planet');
const only = opt('only', '');
const TITANS = only
  ? only.split(',')
  : ['colossus', 'lastone', 'asteroid', 'nexus', 'blackhole', 'supernova', 'planet', 'uri', 'cradle'];

if (opt('build', '1') === '1') {
  await build({
    root: ROOT,
    configFile: resolve(ROOT, 'vite.config.ts'),
    logLevel: 'warn',
    build: { outDir: OUT, emptyOutDir: true, sourcemap: false },
  });
}
const server = await preview({
  root: ROOT,
  configFile: resolve(ROOT, 'vite.config.ts'),
  build: { outDir: OUT },
  preview: { port: 4317, strictPort: false, host: '127.0.0.1' },
  logLevel: 'error',
});
const base = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:4317/';

interface Row {
  titan: string;
  foe: string;
  cpu: number[];
  sync: number[];
  gpu: string;
  errors: string[];
}
const pct = (a: number[], q: number): number => {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] ?? 0;
};

const browser = await launch();
const rows: Row[] = [];
for (const a of TITANS) {
  const foe = a === FOE ? 'cradle' : FOE;
  const url = `${base}?a=${a}&b=${foe}&seed=7&stage=nursery&p1=dummy&p2=dummy&script0=10:ult&meter=1&gap=210&freeze=1&hud=1&aftermath=0&tele=0&lum=0`;
  const { page, errors } = await openGame(browser, url);
  const res = await page.evaluate(async (frames: number) => {
    const api = window.__ADEUK__!;
    const cpu: number[] = [];
    const sync: number[] = [];
    // let the GPU settle and the first frames upload everything
    for (let i = 0; i < 3; i++) {
      api.renderNow();
      api.captureLogical();
      await new Promise((r) => setTimeout(r, 30));
    }
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      api.step(1);
      const t1 = performance.now();
      api.captureLogical();
      const t2 = performance.now();
      cpu.push(t1 - t0);
      sync.push(t2 - t0);
      // yield now and then (a long synchronous loop starves the page's own tasks)
      if (i % 30 === 29) await new Promise((r) => setTimeout(r, 0));
    }
    return { cpu, sync, gpu: api.gpu() };
  }, FRAMES);
  rows.push({ titan: a, foe, ...res, errors: errors.slice(0, 5) });
  await page.close();
  const f = (v: number): string => v.toFixed(1).padStart(6);
  console.log(
    `${a.padEnd(9)} v ${foe.padEnd(8)} cpu p50 ${f(pct(res.cpu, 0.5))} p95 ${f(pct(res.cpu, 0.95))} p99 ${f(pct(res.cpu, 0.99))} max ${f(pct(res.cpu, 1))}` +
      `  | +gpu sync p95 ${f(pct(res.sync, 0.95))} max ${f(pct(res.sync, 1))}` +
      (errors.length ? `  (${errors.length} console errors)` : ''),
  );
}
console.log(`GPU: ${rows[0]?.gpu ?? '?'}`);
await browser.close();
server.httpServer.close();
const json = opt('json', '');
if (json)
  writeFileSync(
    json,
    JSON.stringify(
      rows.map((r) => ({
        ...r,
        cpu: undefined,
        sync: undefined,
        stats: {
          cpu: { p50: pct(r.cpu, 0.5), p95: pct(r.cpu, 0.95), p99: pct(r.cpu, 0.99), max: pct(r.cpu, 1) },
          sync: {
            p50: pct(r.sync, 0.5),
            p95: pct(r.sync, 0.95),
            p99: pct(r.sync, 0.99),
            max: pct(r.sync, 1),
          },
        },
      })),
      null,
      1,
    ),
  );
process.exit(0);
