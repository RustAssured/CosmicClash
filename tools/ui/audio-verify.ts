import { launch } from '../lead/browser';
import { startDevServer } from './devserver';
import type { VerifyReport } from '../../dev/ui/audio-verify';
import type { TitanReport } from '../../dev/ui/audio-titans';
import type { StageReport } from '../../dev/ui/audio-stages';
import type { EventMetric } from '../../dev/ui/audio-render';
import type { RoundReport } from '../../dev/ui/audio-round';
import type { FightReport } from '../../dev/ui/audio-fight';

/**
 * Run the audio engine's OfflineAudioContext verification in headless Chromium and print the measurements.
 *   npx tsx tools/ui/audio-verify.ts [--json] [--quick | --titans | --stages]
 *   --quick   per-event levels of the first two titans only (about a minute)
 *   --titans  the four newer titans: events, character, and their continuous voices' behaviours
 *   --stages  the five stage scores: character, key, rhythm
 *   --body    just each titan's voice-only body character (seconds): the loop for tuning materials
 *   --round   D6: one scripted Witness-vs-Planet round through the real engine, measured like telemetry (LUFS, dBTP, LRA,
 *             impact over bed, bed duck); exit 1 if a D6 target is missed
 *   --fight   D6 on REAL fight density: a real AI-vs-AI Match (Witness vs Planet) drives the engine offline; same measures
 *             and targets, plus the limiter's gain-reduction histogram. [--seconds=60] [--seed=21] [--level=4]
 * Exit code 1 if the page errored or the report is missing.
 */
const json = process.argv.includes('--json');
const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const mode = process.argv.includes('--fight')
  ? 'fight'
  : process.argv.includes('--round')
    ? 'round'
    : process.argv.includes('--body')
      ? 'body'
      : process.argv.includes('--titans')
        ? 'titans'
        : process.argv.includes('--stages')
          ? 'stages'
          : process.argv.includes('--quick')
            ? 'quick'
            : '1';
const { server, url } = await startDevServer();
const browser = await launch();
let code = 0;
const f = (n: number, d = 1): string => (Number.isFinite(n) ? n.toFixed(d) : String(n));
const table = (events: EventMetric[]): void => {
  console.log('name'.padEnd(38), 'peak dB', 'rms dB', 'centroid', 'tail s');
  for (const e of events)
    console.log(
      e.name.padEnd(38),
      f(e.peakDb).padStart(7),
      f(e.rmsDb).padStart(6),
      f(e.centroidHz, 0).padStart(8),
      f(e.tailSec, 2).padStart(6),
    );
};
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // a missing favicon is the dev server's business, not the engine's
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  const extra =
    mode === 'fight'
      ? `&seconds=${arg('seconds', '60')}&seed=${arg('seed', '21')}&level=${arg('level', '4')}&orbit=${arg('orbit', '1')}`
      : '';
  await page.goto(`${url}/dev/ui/audio.html?verify=${mode}${extra}`);
  if (mode === 'round' || mode === 'fight') {
    await page.waitForFunction(() => window.__round !== undefined || window.__fight !== undefined, null, {
      timeout: 1_800_000,
    });
    const r = (await page.evaluate(() => window.__round ?? window.__fight)) as RoundReport | FightReport;
    console.log(JSON.stringify(r, null, json ? 2 : undefined));
    const miss: string[] = [];
    if (r.integrated < -21 || r.integrated > -19)
      miss.push(`integrated ${r.integrated} LUFS (target −20 ± 1)`);
    if (r.truePeak > -1) miss.push(`true peak ${r.truePeak} dBTP (> −1)`);
    if (r.range < 10) miss.push(`LRA ${r.range} LU (< 10)`);
    if (r.median.overShort < 10) miss.push(`impact over bed (short-term) ${r.median.overShort} dB (< 10)`);
    if (r.median.duck < 4 || r.median.duck > 8) miss.push(`bed duck ${r.median.duck} dB (outside 4–8)`);
    if (r.nonFinite) miss.push(`non-finite samples ${r.nonFinite}`);
    if (miss.length) {
      console.error(`D6 targets missed: ${miss.join('; ')}`);
      code = 1;
    }
  } else if (mode === 'body') {
    await page.waitForFunction(() => window.__body !== undefined, null, { timeout: 120_000 });
    console.table(await page.evaluate(() => window.__body));
  } else if (mode === 'titans') {
    await page.waitForFunction(() => window.__titans !== undefined, null, { timeout: 600_000 });
    const r = (await page.evaluate(() => window.__titans)) as TitanReport;
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      table(r.events);
      console.log('\ncharacter');
      console.table(
        r.character.map((c) => ({
          ...c,
          hitCentroidHz: Math.round(c.hitCentroidHz),
          hitSubShare: +c.hitSubShare.toFixed(3),
          bodyCentroidHz: Math.round(c.bodyCentroidHz),
          bedPeakDb: +c.bedPeakDb.toFixed(1),
          bedRmsDb: +c.bedRmsDb.toFixed(1),
          bedSubShare: +c.bedSubShare.toFixed(3),
        })),
      );
      console.log({ blackHole: r.blackHole, nexus: r.nexus, supernova: r.supernova, planet: r.planet });
    }
  } else if (mode === 'stages') {
    await page.waitForFunction(() => window.__stages !== undefined, null, { timeout: 600_000 });
    const r = (await page.evaluate(() => window.__stages)) as StageReport;
    console.log(JSON.stringify(r, null, json ? 2 : 1));
  } else {
    await page.waitForFunction(() => window.__report !== undefined, null, { timeout: 900_000 });
    const report = (await page.evaluate(() => window.__report)) as VerifyReport;
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      table(report.events);
      const { events: _events, titans: _titans, stages: _stages, ...rest } = report;
      console.log(rest);
    }
  }
  if (errors.length) {
    console.error(errors.join('\n'));
    code = 1;
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(code);
