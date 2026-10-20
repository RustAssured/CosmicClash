import { parseHarnessParams } from '@/contracts';
import { App } from '@/app/app';
import { installHarness } from '@/app/harness';
import { loadUriAsset } from '@/titans/uri/asset';
import uriBinUrl from '@/titans/uri/uri_rig.bin?url';
import { requestCradleFrames } from '@/titans/kit/cradle/frames';
import cradleFramesUrl from '@/titans/kit/cradle/cradle_frames.bin?url';

/** Entry point: builds the app, boots into the title (or a harness scenario when URL params ask for one). */
async function main(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  // cinema mode (docs/cinema/TRAILER_V3.md): the trailer's own renderer loop, no menus or input; loaded only when asked for
  const q = new URLSearchParams(location.search);
  const cinema = q.get('cinema');
  const params = parseHarnessParams(location.search);
  // capture tooling (cinema, harness scenarios) films the bare canvas: no loading screen, no full screen button
  if (cinema || params.active) for (const id of ['boot', 'fs']) document.getElementById(id)?.remove();
  if (cinema) {
    const { startCinema } = await import('@/cinema/cinema');
    await startCinema(canvas, cinema, q.get('render') === '1');
    return;
  }
  // 우리's packed part grids (src/titans/uri/asset.ts): fetched once at boot, decoded in place before any match
  const uriAsset = loadUriAsset(uriBinUrl);
  // the Cradle's living sail frames (src/titans/kit/cradle/frames.ts): presentation only, never awaited (until they are in,
  // the sail draws its painted rest disc)
  requestCradleFrames(cradleFramesUrl);
  const app = new App();
  // preserveDrawingBuffer only for screenshot tooling: real-time evidence runs (tele) read frames right after drawing
  // and must pay exactly what a player's build pays
  await uriAsset;
  await app.start(canvas, {
    preserveDrawingBuffer: params.active && !params.tele,
    quality: params.q,
    full: new URLSearchParams(location.search).get('full') === '1',
    footwork: params.orbit ? 'orbit' : 'classic',
    zdepth: params.zdepth,
    witness: params.witness,
    aftermath: params.aftermath,
  });
  // a CHALLENGE A FRIEND link (`?room=CODE`) goes straight into joining that room (docs/netplay/STEP1.md)
  app.openOnlineFromUrl(location.search);
  await installHarness(app, params);
}

main().catch((e: unknown) => {
  console.error('ADEUK failed to start:', e);
  // the loading screen (index.html) turns into a short explanation instead of loading forever
  document.documentElement.dataset.boot = 'failed';
});
