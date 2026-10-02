import { parseHarnessParams } from '@/contracts';
import { App } from '@/app/app';
import { installHarness } from '@/app/harness';

/** Entry point: builds the app, boots into the title (or a harness scenario when URL params ask for one). */
async function main(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const params = parseHarnessParams(location.search);
  const app = new App();
  // preserveDrawingBuffer only for screenshot tooling: real-time evidence runs (tele) read frames right after drawing
  // and must pay exactly what a player's build pays
  await app.start(canvas, {
    preserveDrawingBuffer: params.active && !params.tele,
    quality: params.q,
    full: new URLSearchParams(location.search).get('full') === '1',
    footwork: params.orbit ? 'orbit' : 'classic',
    zdepth: params.zdepth,
    witness: params.witness,
  });
  await installHarness(app, params);
}

main().catch((e: unknown) => {
  console.error('ADEUK failed to start:', e);
});
