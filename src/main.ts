import { parseHarnessParams } from '@/contracts';
import { App } from '@/app/app';
import { installHarness } from '@/app/harness';

/** Entry point: builds the app, boots into the title (or a harness scenario when URL params ask for one). */
async function main(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const params = parseHarnessParams(location.search);
  const app = new App();
  await app.start(canvas, { preserveDrawingBuffer: params.active });
  await installHarness(app, params);
}

main().catch((e: unknown) => {
  console.error('ADEUK failed to start:', e);
});
