import { expect, test } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { startDevServer } from '../tools/ui/devserver';
import type { VerifyReport } from '../dev/ui/audio-verify';

/**
 * Numeric verification of the audio engine, run in a REAL browser: every scenario renders through an OfflineAudioContext
 * (the same graph and voices as the game) and the samples are measured (see dev/ui/audio-verify.ts).
 *
 * What a green run means: the mix never exceeds full scale, the voices are finite, every sound is audible against the
 * ambience, the score reacts to intensity, latency and volume behave. What it CANNOT mean: that anything sounds good. Nobody
 * has listened to this yet (`dev/ui/audio.html` is the audition page; put on headphones).
 */
let server: ViteDevServer;
let base = '';
test.beforeAll(async () => {
  ({ server, url: base } = await startDevServer());
});
test.afterAll(async () => {
  await server.close();
});

// Windups that are silent ON PURPOSE: another event carries the sound (see the note in audio-verify.ts).
const SILENT_BY_DESIGN = new Set(['move lastone.gaze']);

test('audio engine: numeric verification in a real browser', async ({ page }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`${base}/dev/ui/audio.html?verify=1`);
  await page.waitForFunction(() => window.__report !== undefined, null, { timeout: 400_000 });
  const r = (await page.evaluate(() => window.__report)) as VerifyReport;
  await page.screenshot({ path: '.scratch/e2e/audio-page.png' });
  expect(errors).toEqual([]);

  // --- nothing diverges, nothing is silent, nothing is deafening
  expect(r.nonFiniteSamples, 'a NaN in the graph would silence the game for good').toBe(0);
  expect(r.fuzzRuns).toBeGreaterThanOrEqual(24);
  expect(r.fuzzWorstRawPeak, 'a voice diverged (Chromium overlapping-automation bug: 1e8+)').toBeLessThan(4);
  expect(r.silenceRmsDb).toBeLessThan(-100);
  for (const e of r.events) {
    if (SILENT_BY_DESIGN.has(e.name)) {
      expect(e.peakDb, e.name).toBeLessThan(-80);
      continue;
    }
    expect(e.peakDb, `${e.name} is inaudible`).toBeGreaterThan(-30);
    expect(e.peakDb, `${e.name} is hot before the limiter`).toBeLessThan(-2);
    expect(e.tailSec, `${e.name} never decays`).toBeLessThan(6);
  }
  // menu sounds sit above the menu score (calm score ≈ −28 dB rms): audible, but the biggest ones are not louder than a KO
  for (const e of r.events.filter((x) => x.name.startsWith('ui ')))
    expect(e.peakDb, e.name).toBeGreaterThan(-26);
  expect(r.uiPeakDb).toBeLessThan(-3);

  // --- the safety net
  expect(r.stormEvents).toBeGreaterThan(1500);
  expect(r.stormPeak, 'nothing may clip after the limiter').toBeLessThanOrEqual(0.98 + 1e-6);
  expect(
    r.stormPeakNoLimiter,
    'the storm must be loud enough to prove the limiter is doing real work',
  ).toBeGreaterThan(1.2);
  expect(r.stormRmsDb).toBeLessThan(-6);

  // --- latency (engine side: scheduling look-ahead + the compressor's own 6 ms; the output device adds its own on top)
  expect(r.latencyMs).toBeLessThan(30);
  expect(r.latencyMs).toBeGreaterThan(0);

  // --- reverb tail of the heaviest blow, on the event alone
  expect(r.heavyHitTailSec).toBeGreaterThan(0.8);
  expect(r.heavyHitTailSec).toBeLessThan(4);

  // --- character: glass is brighter than rock (centroid above 300 Hz, the shared sub-bass thump excluded)
  expect(r.glassCentroidHz).toBeGreaterThan(1.5 * r.rockCentroidHz);

  // --- the adaptive score reacts to intensity, and is repeatable
  expect(r.scoreRepeatDiffDb, 'same seed must render the same score (up to float noise)').toBeLessThan(-60);
  expect(r.scoreHotPeakDb - r.scoreCalmPeakDb, 'rhythm layers should lift the peaks').toBeGreaterThan(4);
  expect(
    r.scoreHotDynDb - r.scoreCalmDynDb,
    'rhythm layers should make the score more dynamic',
  ).toBeGreaterThan(4);
  expect(r.scoreCalmRmsDb).toBeGreaterThan(-45);
  expect(r.scoreHotRmsDb).toBeLessThan(-12);

  // --- volume: master 0 is silent, master 0.5 is −12 dB (squared taper) because master sits AFTER the dynamics
  expect(r.gainMasterZeroPeak).toBeLessThan(1e-4);
  expect(r.gainHalfDb).toBeGreaterThan(-13.5);
  expect(r.gainHalfDb).toBeLessThan(-10.5);
});

test('audition page: every button fires without errors and the meter shows a limited signal', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`${base}/dev/ui/audio.html`);
  await page.click('#score'); // any click is the user gesture that unlocks audio
  await page.waitForFunction(() => window.__audio?.ready === true, null, { timeout: 15_000 });
  const buttons = page.locator('#groups button');
  const n = await buttons.count();
  expect(n).toBeGreaterThan(45);
  for (let i = 0; i < n; i++) await buttons.nth(i).click({ noWaitAfter: true });
  await page.waitForTimeout(600);
  const seen = await page.evaluate(() => window.__meter!);
  expect(seen.maxPre, 'the meter saw no signal at all').toBeGreaterThan(0.01);
  expect(seen.maxPost, 'the output must never pass the limiter ceiling').toBeLessThanOrEqual(0.98 + 1e-3);
  await page.screenshot({ path: '.scratch/e2e/audio-audition.png' });
  expect(errors).toEqual([]);
});
