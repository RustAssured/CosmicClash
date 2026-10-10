import { launch } from '../lead/browser';
import { startRenderServer } from '../render/devserver';
import { arg, frameHash, openCinema, readFrame } from './common';

/**
 * Determinism check (TRAILER_V3 §2.2): render the same frames twice, each time in a fresh page from a cold start, and
 * compare their hashes (scene, overlay and camera). Exit 1 on any difference. Also re-renders each frame a second time in
 * the same page (rebuilding its shot) to prove a frame does not depend on what was rendered before it.
 *   npx tsx tools/cinema/determinism.ts [--timeline=p0] [--frames=0,1,2,3,4]
 */
const name = arg('timeline', 'p0');
const frames = arg('frames', '0,1,2,3,4').split(',').map(Number);

const { server, url } = await startRenderServer();
const browser = await launch();
let bad = 0;
try {
  const runs: string[][] = [];
  for (let run = 0; run < 2; run++) {
    const { page, errors } = await openCinema(browser, url, name);
    const h: string[] = [];
    for (const n of frames) h.push(frameHash(await readFrame(page, n)));
    // the same frames again in this page: each request for an earlier frame rebuilds its shot from the start
    for (let i = 0; i < frames.length; i++) {
      const again = frameHash(await readFrame(page, frames[i]!));
      if (again !== h[i]) {
        console.log(
          `run ${run}: frame ${frames[i]} re-rendered in the same page differs (${h[i]} vs ${again})`,
        );
        bad++;
      }
    }
    runs.push(h);
    if (errors.length) console.log(`run ${run} console:\n  ${errors.join('\n  ')}`);
    await page.close();
  }
  frames.forEach((n, i) => {
    const same = runs[0]![i] === runs[1]![i];
    if (!same) bad++;
    console.log(`frame ${n}: ${runs[0]![i]}  ${runs[1]![i]}  ${same ? 'same' : 'DIFFERENT'}`);
  });
  console.log(
    bad
      ? `${bad} mismatches`
      : `deterministic: ${frames.length} frames, same hash in two cold runs and on re-render`,
  );
} finally {
  await browser.close();
  await server.close();
}
process.exit(bad ? 1 : 0);
