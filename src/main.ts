import { parseHarnessParams } from '@/contracts';
import { App } from '@/app/app';
import { installHarness } from '@/app/harness';
import { loadUriAsset } from '@/titans/uri/asset';
import uriBinUrl from '@/titans/uri/uri_rig.bin?url';

/** Entry point: builds the app, boots into the title (or a harness scenario when URL params ask for one). */
async function main(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const params = parseHarnessParams(location.search);
  // 우리's packed part grids (src/titans/uri/asset.ts): fetched once at boot, decoded in place before any match
  const uriAsset = loadUriAsset(uriBinUrl);
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
  await installHarness(app, params);
}

main().catch((e: unknown) => {
  console.error('ADEUK failed to start:', e);
});
