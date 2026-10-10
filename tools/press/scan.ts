import { mkdirSync, writeFileSync } from 'node:fs';
import type { StageId, TitanId } from '../../src/contracts';
import type { PressCfg, ScanResult } from '../../dev/press/press';
import { launch, openGame } from '../lead/browser';
import { startRenderServer } from '../render/devserver';
import { WORK, arg, cfgKey, openWorker, query } from './common';

/**
 * Find the moments (no hand-scrubbing): long deterministic AI-vs-AI runs of many matchups and arenas, headless, with every
 * heavy / catastrophic blow, KO, cue and ultimate by tick → press/work/scan.json. `--check` first proves the worker's match
 * is the game's (same hash at the same ticks as the real game harness).
 *   npx tsx tools/press/scan.ts [--check] [--seeds=21,22] [--ticks=14000]
 */
const PAIRS: [TitanId, TitanId, StageId][] = [
  ['lastone', 'planet', 'nursery'],
  ['supernova', 'blackhole', 'shearfield'],
  ['uri', 'lastone', 'mausoleum'],
  ['planet', 'supernova', 'quasar'],
  ['nexus', 'asteroid', 'redgiant'],
  ['blackhole', 'nexus', 'tussenruimte'],
  ['asteroid', 'uri', 'rim'],
  ['supernova', 'uri', 'redgiant'],
  ['planet', 'blackhole', 'rim'],
  ['lastone', 'supernova', 'quasar'],
  ['nexus', 'planet', 'shearfield'],
  ['uri', 'blackhole', 'nursery'],
  ['asteroid', 'lastone', 'tussenruimte'],
  ['supernova', 'nexus', 'mausoleum'],
];
const seeds = arg('seeds', '21,22').split(',').map(Number);
const maxTicks = Number(arg('ticks', '14000'));
mkdirSync(WORK, { recursive: true });

const { server, url } = await startRenderServer();
const browser = await launch();
try {
  const worker = await openWorker(browser, url);
  if (process.argv.includes('--check')) {
    const c: PressCfg = { a: 'uri', b: 'lastone', stage: 'mausoleum', seed: 21, ai: 4 };
    const r = (await worker.evaluate(([c, n]) => window.__press!.scan(c, n), [c, 1300] as const)) as ScanResult;
    const { page } = await openGame(browser, `${url}/?${query(c)}&freeze=1&aftermath=0&q=0&hud=0`, {
      width: 640,
      height: 360,
    });
    let bad = 0;
    for (const [t, h] of r.hashes) {
      const now = (await page.evaluate(() => window.__ADEUK__!.summary().tick)) as number;
      await page.evaluate((n) => window.__ADEUK__!.step(n), t - now);
      const g = (await page.evaluate(() => window.__ADEUK__!.summary())) as { tick: number; hash: number };
      console.log(`tick ${t}: worker ${h} game ${g.hash} (game tick ${g.tick})`);
      if (g.hash !== h || g.tick !== t) bad++;
    }
    await page.close();
    if (bad) throw new Error(`${bad} hash mismatches: the worker's match is not the game's`);
    console.log('worker match == game match');
  }
  const out: Record<string, ScanResult & { cfg: PressCfg }> = {};
  for (const seed of seeds)
    for (const [a, b, stage] of PAIRS) {
      const c: PressCfg = { a, b, stage, seed, ai: 4 };
      const t0 = Date.now();
      const r = (await worker.evaluate(([c, n]) => window.__press!.scan(c, n), [c, maxTicks] as const)) as ScanResult;
      out[cfgKey(c)] = { ...r, cfg: c };
      const n = (k: string, d?: string): number => r.moments.filter((m) => m.k === k && (!d || m.d === d)).length;
      console.log(
        `${cfgKey(c)}: end ${r.endTick}, cat ${n('hit', 'catastrophic')}, heavy ${n('hit', 'heavy')}, ko ${n('ko')}, cues ${n('cue')}, ult ${n('ult')} (${((Date.now() - t0) / 1000).toFixed(0)} s)`,
      );
      writeFileSync(`${WORK}/scan.json`, JSON.stringify(out));
    }
} finally {
  await browser.close();
  await server.close();
}
