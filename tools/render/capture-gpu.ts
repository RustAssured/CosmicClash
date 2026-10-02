import { mkdirSync } from 'node:fs';
import { launch } from '../lead/browser';
import { startRenderServer } from './devserver';

/**
 * Screenshots and GPU cost of stages on the REAL GPU (headless Edge on Windows; SwiftShader elsewhere), through the render
 * sandbox (dev/render/index.html, window.__RENDER__).
 *   npx tsx tools/render/capture-gpu.ts [--stage=mausoleum,shearfield] [--quality=1] [--out=.scratch/render-gpu] [--perf]
 * Writes <out>/<stage>-<scenario>.png (1280×720). With --perf it also runs each stage live for a few seconds at 1920×1080
 * (×3, the director's display) and prints the GPU ms per frame from the renderer's timer query (p50 / p90).
 * LOOK at every image.
 */
const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const stages = arg('stage', 'mausoleum,shearfield').split(',');
const quality = arg('quality', '1');
const out = arg('out', '.scratch/render-gpu');
const perf = process.argv.includes('--perf');
/** Debug: draw only these scenery layers (names from the stage's kit), e.g. --layers=monoliths,rings. */
const onlyLayers = arg('layers', '');
const scenarios = arg('scenarios', '');
mkdirSync(out, { recursive: true });

type R = {
  loop: { pause(): void };
  set(s: Record<string, unknown>): void;
  settle(n?: number): void;
  point(x: number, y: number): void;
  fire(k: string): void;
  advance(n: number, dt?: number): void;
  drawNow(): void;
};
const SCENARIOS: { name: string; run: (r: R) => void }[] = [
  {
    name: 'calm',
    run: (r) => (r.set({ time: 3, fa: 640, fb: 980, intensity: 0.2 }), r.settle(), r.drawNow()),
  },
  {
    name: 'pan-left',
    run: (r) => (r.set({ time: 9, fa: 260, fb: 600, intensity: 0.2 }), r.settle(), r.drawNow()),
  },
  {
    name: 'pan-right',
    run: (r) => (r.set({ time: 14, fa: 1000, fb: 1340, intensity: 0.2 }), r.settle(), r.drawNow()),
  },
  {
    name: 'shock',
    run: (r) => (
      r.set({ time: 20, fa: 640, fb: 980, intensity: 0.7 }),
      r.settle(),
      r.point(820, 250),
      r.fire('shock'),
      r.advance(12, 0.2)
    ),
  },
  {
    name: 'shock-late',
    run: (r) => (
      r.set({ time: 20, fa: 640, fb: 980, intensity: 0.7 }),
      r.settle(),
      r.point(820, 250),
      r.fire('shock'),
      r.advance(150, 3)
    ),
  },
];

const { server, url } = await startRenderServer();
const browser = await launch();
let bad = 0;
try {
  for (const stage of stages) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('console', (m) => {
      if ((m.type() === 'error' || m.type() === 'warning') && !/Failed to load resource/.test(m.text())) {
        console.log(`[console.${m.type()}] ${m.text()}`);
        bad++;
      }
    });
    page.on('pageerror', (e) => {
      console.log(`[pageerror] ${e.message}`);
      bad++;
    });
    await page.goto(
      `${url}/dev/render/index.html?stage=${stage}&quality=${quality}&freeze=1&t=0&text=0&sparks=1&ui=1`,
      {
        waitUntil: 'commit',
      },
    );
    await page.waitForFunction("document.body.dataset.ready==='1'", null, { timeout: 180_000 });
    if (onlyLayers)
      await page.evaluate(
        `(() => { const L = window.__RENDER__.renderer.active.scenery.kit.layers; const keep = '${onlyLayers}'.split(','); for (const l of L) l.mesh.visible = keep.includes(l.name); })()`,
      );
    for (const sc of SCENARIOS) {
      if (scenarios && !scenarios.split(',').includes(sc.name)) continue;
      await page.evaluate(
        `(() => { const R = window.__RENDER__; R.loop.pause(); (${sc.run.toString()})(R); })()`,
      );
      await page.waitForTimeout(80);
      await page.screenshot({
        path: `${out}/${stage}-${sc.name}${onlyLayers ? '-' + onlyLayers.replace(/,/g, '+') : ''}.png`,
      });
    }
    console.log(`${stage}: ${SCENARIOS.length} shots in ${out}`);
    if (perf) {
      await page.setViewportSize({ width: 1920, height: 1080 });
      // draw frames ourselves (one per animation frame) and read the renderer's GPU timer query
      const samples = (await page.evaluate(`(async () => {
        const R = window.__RENDER__;
        R.loop.pause();
        R.set({ time: 5, fa: 640, fb: 980, intensity: 0.5 });
        R.settle(60);
        const out = [];
        for (let i = 0; i < 150; i++) {
          R.advance(1);
          await new Promise((res) => requestAnimationFrame(res));
          const g = R.renderer.stats.gpuMs;
          if (i > 30 && g !== null) out.push(g);
        }
        return out;
      })()`)) as number[];
      samples.sort((a, b) => a - b);
      const q = (p: number): string =>
        samples.length ? samples[Math.floor(p * (samples.length - 1))]!.toFixed(2) : 'n/a';
      const st = (await page.evaluate('window.__RENDER__.stats()')) as {
        frameMs: number;
        tier: number;
        drawCalls: number;
      };
      console.log(
        `  perf @1920×1080 tier ${st.tier}: GPU p50 ${q(0.5)} ms, p90 ${q(0.9)} ms (${samples.length} samples); CPU draw ${st.frameMs.toFixed(2)} ms, ${st.drawCalls} draw calls`,
      );
    }
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(bad ? 2 : 0);
