import { launch } from '../lead/browser';
import { startDevServer } from './devserver';
import type { VerifyReport } from '../../dev/ui/audio-verify';

/**
 * Run the audio engine's OfflineAudioContext verification in headless Chromium and print the measurements.
 *   npx tsx tools/ui/audio-verify.ts [--json] [--quick]   (--quick: per-event levels only, ~1 minute)
 * Exit code 1 if the page errored or the report is missing.
 */
const json = process.argv.includes('--json');
const quick = process.argv.includes('--quick');
const { server, url } = await startDevServer();
const browser = await launch();
let code = 0;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`${url}/dev/ui/audio.html?verify=${quick ? 'quick' : '1'}`);
  await page.waitForFunction(() => window.__report !== undefined, null, { timeout: 240_000 });
  const report = (await page.evaluate(() => window.__report)) as VerifyReport;
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    const f = (n: number, d = 1): string => (Number.isFinite(n) ? n.toFixed(d) : String(n));
    console.log('name'.padEnd(34), 'peak dB', 'rms dB', 'centroid', 'tail s');
    for (const e of report.events)
      console.log(
        e.name.padEnd(34),
        f(e.peakDb).padStart(7),
        f(e.rmsDb).padStart(6),
        f(e.centroidHz, 0).padStart(8),
        f(e.tailSec, 2).padStart(6),
      );
    const { events: _events, ...rest } = report;
    console.log(rest);
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
