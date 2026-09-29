/**
 * Perf benchmark in headless Chromium (software WebGL, so frame numbers are pessimistic; sim ms/tick is representative).
 *   npx tsx tools/lead/perf.ts [--base=http://localhost:4173] [--ticks=3600] [--frames=240]
 * Runs a scripted AI-vs-AI fight per matchup pair and prints ms/tick (sim only, render off) and ms/frame (full frame).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, openGame } from './browser';
import type { HarnessPerf } from '@/contracts';

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const base = arg('base', 'http://localhost:4173');
const ticks = parseInt(arg('ticks', '3600'), 10);
const frames = parseInt(arg('frames', '240'), 10);
const pairs: [string, string, string][] = [
  ['lastone', 'asteroid', 'nursery'],
  ...(process.argv.includes('--all')
    ? ([
        ['nexus', 'planet', 'rim'],
        ['blackhole', 'supernova', 'quasar'],
        ['planet', 'blackhole', 'redgiant'],
        ['supernova', 'nexus', 'tussenruimte'],
      ] as [string, string, string][])
    : []),
];

const browser = await launch();
const rows: { pair: string; sim: HarnessPerf; frame: HarnessPerf }[] = [];
for (const [a, b, stage] of pairs) {
  const { page, errors } = await openGame(
    browser,
    `${base}/?mode=aivai&a=${a}&b=${b}&stage=${stage}&seed=11&ai=3&hud=1`,
  );
  const sim = await page.evaluate((n) => window.__ADEUK__!.benchSim(n), ticks);
  const frame = await page.evaluate((n) => window.__ADEUK__!.benchFrames(n), frames);
  rows.push({ pair: `${a} vs ${b} @ ${stage}`, sim, frame });
  if (errors.length) console.log(errors.join('\n'));
  await page.close();
}
await browser.close();

const f = (v: number): string => v.toFixed(2);
console.log(
  '\n| matchup | sim ms/tick mean | p95 | max | frame ms mean | draw ms mean | fps (software GL) |',
);
console.log('|---|---|---|---|---|---|---|');
for (const r of rows)
  console.log(
    `| ${r.pair} | ${f(r.sim.simMsMean)} | ${f(r.sim.simMsP95)} | ${f(r.sim.simMsMax)} | ${f(r.frame.frameMsMean)} | ${f(r.frame.drawMsMean)} | ${f(r.frame.fps)} |`,
  );
mkdirSync('.scratch', { recursive: true });
writeFileSync('.scratch/perf.json', JSON.stringify(rows, null, 2));
const worst = Math.max(...rows.map((r) => r.sim.simMsP95));
if (worst > 5) {
  console.error(`sim p95 ${f(worst)} ms exceeds the 5 ms budget`);
  process.exit(3);
}
