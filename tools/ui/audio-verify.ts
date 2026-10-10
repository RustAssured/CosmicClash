import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from '../lead/browser';
import type { AuditReport } from '../../dev/ui/audio-audit';
import type { TrailerReport } from '../../dev/ui/audio-trailer';
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
 *             and targets, plus the limiter's gain-reduction histogram and the output's spectral balance. [--seconds=60]
 *             [--seed=21] [--level=4] [--titans=lastone,planet] [--stage=nursery] [--wav=<dir> [--prefix=audio-]]
 *   --pairs   --fight for every pair in PAIRS (every titan twice) or --list="a,b;c,d", one summary row per pair (LUFS, dBTP,
 *             LRA, impact over bed, duck, band shares); [--out=report.json] [--wav=<dir>] and the --fight options
 *   --trailer the trailer's sound (dev/ui/audio-trailer.ts) from press/trailer/cuesheet.json or the TRAILER.md default:
 *             press/trailer/mix-<cut>.wav and .json (sync report). [--cut=60|15] [--stems] [--out-dir=press/trailer]
 *   --audit   every sound source alone, measured for its energy above 2 kHz (the whistle audit); [--top=40] [--out=file.json]
 *             [--only=prefix,prefix]
 * Exit code 1 if the page errored or the report is missing.
 */
const json = process.argv.includes('--json');
const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
/** The pairs `--pairs` renders: every titan twice, each against a different foe. */
const PAIRS = [
  'lastone,planet',
  'asteroid,nexus',
  'blackhole,supernova',
  'uri,lastone',
  'planet,asteroid',
  'nexus,blackhole',
  'supernova,uri',
];
const mode = process.argv.includes('--trailer')
  ? 'trailer'
  : process.argv.includes('--pairs')
    ? 'pairs'
    : process.argv.includes('--audit')
      ? 'audit'
      : process.argv.includes('--fight')
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
  const fightQuery = (titans: string, wav: boolean): string =>
    `&seconds=${arg('seconds', '60')}&seed=${arg('seed', '21')}&level=${arg('level', '4')}&orbit=${arg('orbit', '1')}` +
    `&titans=${titans}&stage=${arg('stage', 'nursery')}${wav ? '&wav=1' : ''}`;
  /** Write a report's WAV (if any) to `<dir>/<prefix><a>-<b>.wav` and drop it from the report. */
  const saveWav = (r: FightReport, dir: string, prefix: string): void => {
    if (!r.wav) return;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${prefix}${r.titans.join('-')}.wav`);
    writeFileSync(file, Buffer.from(r.wav, 'base64'));
    console.error(`wrote ${file}`);
    delete r.wav;
  };
  const wavDir = arg('wav', '');
  const prefix = arg('prefix', 'audio-');
  if (mode === 'trailer') {
    // the trailer's mix: press/trailer/mix-<cut>.wav (+ stems on --stems) and a sync report
    const cut = arg('cut', '60');
    const dir = arg('out-dir', 'press/trailer');
    await page.goto(
      `${url}/dev/ui/audio.html?verify=trailer&cut=${cut}${process.argv.includes('--stems') ? '&stems=1' : ''}`,
    );
    await page.waitForFunction(() => window.__trailer !== undefined, null, { timeout: 3_600_000 });
    const r = (await page.evaluate(() => window.__trailer)) as TrailerReport;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `mix-${cut}.wav`), Buffer.from(r.wav, 'base64'));
    for (const [k, v] of Object.entries(r.stems ?? {}))
      writeFileSync(join(dir, `mix-${cut}-stem-${k}.wav`), Buffer.from(v, 'base64'));
    const { wav: _w, stems: _s, ...rest } = r;
    writeFileSync(join(dir, `mix-${cut}.json`), JSON.stringify(rest, null, 1));
    console.log(JSON.stringify(rest, null, 1));
  } else if (mode === 'pairs') {
    // every pair in turn (a fresh page each), then one summary line per pair; --out=file.json keeps the full reports
    const rows: Record<string, unknown>[] = [];
    const reports: FightReport[] = [];
    for (const pair of arg('list', PAIRS.join(';')).split(';')) {
      await page.goto(`${url}/dev/ui/audio.html?verify=fight${fightQuery(pair, !!wavDir)}`);
      await page.waitForFunction(() => window.__fight !== undefined, null, { timeout: 1_800_000 });
      const r = (await page.evaluate(() => window.__fight)) as FightReport;
      if (wavDir) saveWav(r, wavDir, prefix);
      reports.push(r);
      rows.push({
        pair,
        LUFS: r.integrated,
        laptop: r.laptopIntegrated,
        dBTP: r.truePeak,
        LRA: r.range,
        overBed: r.median.overShort,
        duck: r.median.duck,
        heavy: r.heavyHits,
        limNone: r.limiterGrHistogram.none,
        sub: r.bands.sub,
        low: r.bands.low,
        mid: r.bands.mid,
        hi2k: +(r.bands.high + r.bands.air).toFixed(4),
        air6k: r.bands.air,
      });
      console.error(`${pair}: done`);
    }
    console.table(rows);
    const out = arg('out', '');
    if (out) writeFileSync(out, JSON.stringify({ rows, reports }, null, 1));
  } else if (mode === 'audit') {
    await page.goto(
      `${url}/dev/ui/audio.html?verify=audit${arg('only', '') ? `&only=${arg('only', '')}` : ''}`,
    );
    await page.waitForFunction(() => window.__audit !== undefined, null, { timeout: 1_800_000 });
    const r = (await page.evaluate(() => window.__audit)) as AuditReport;
    const out = arg('out', '');
    if (out) writeFileSync(out, JSON.stringify(r, null, 1));
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log({
        totalHiShare: r.totalHiShare,
        totalBrightShare: r.totalBrightShare,
        totalLowShare: r.totalLowShare,
        sources: r.rows.length,
      });
      console.table(
        r.rows
          .slice(0, +arg('top', '40'))
          .map(({ source, peakDb, rmsDb, centroidHz, lowShare, upperShare, hiShare, brightDb, hiDb }) => ({
            source,
            peakDb,
            rmsDb,
            centroidHz,
            lowShare,
            upperShare,
            hiShare,
            brightDb,
            hiDb,
          })),
      );
    }
  } else {
    await page.goto(
      `${url}/dev/ui/audio.html?verify=${mode}${mode === 'fight' ? fightQuery(arg('titans', 'lastone,planet'), !!wavDir) : ''}`,
    );
    if (mode === 'round' || mode === 'fight') {
      await page.waitForFunction(() => window.__round !== undefined || window.__fight !== undefined, null, {
        timeout: 1_800_000,
      });
      const r = (await page.evaluate(() => window.__round ?? window.__fight)) as RoundReport | FightReport;
      if (wavDir && 'wav' in r) saveWav(r, wavDir, prefix);
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
