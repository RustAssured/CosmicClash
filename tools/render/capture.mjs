#!/usr/bin/env node
/**
 * Screenshot every implemented stage in several fight states (headless Chromium + SwiftShader software WebGL2).
 *
 *   node tools/render/capture.mjs [--stage=nursery] [--quality=2] [--out=.scratch/render] [--only=calm,shock] [--url=http://localhost:5201/dev/render/]
 *
 * Needs the dev server:  npx vite --port 5201 --strictPort
 * Writes  <out>/<stage>-<scenario>.png  (1280×720 = the 640×360 logical frame at 2×) and prints renderer stats.
 * Exit code 2 if the page logged console errors/warnings (a clean run prints none).
 * LOOK at every image: the point of this tool is to iterate on beauty, not to pass.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.length ? v.join('=') : true];
    }),
);
const base = args.url || process.env.RENDER_URL || 'http://localhost:5201/dev/render/';
const outDir = args.out || '.scratch/render';
const quality = Number(args.quality ?? 2);
const stages = String(args.stage || 'nursery').split(',');
const only = args.only ? String(args.only).split(',') : null;
mkdirSync(outDir, { recursive: true });

/** Scenarios drive the sandbox through window.__RENDER__ (see dev/render/main.ts). Times are scenery seconds. */
const SCENARIOS = [
  { name: 'calm', run: (R) => R.set({ time: 3, fa: 640, fb: 980, intensity: 0.2 }) },
  {
    name: 'pan-left',
    run: (R) => {
      R.set({ time: 9, fa: 260, fb: 600, intensity: 0.2 });
      R.advance(200, 0); // let the heavy camera glide there
    },
  },
  {
    name: 'pan-right',
    run: (R) => {
      R.set({ time: 14, fa: 1000, fb: 1340, intensity: 0.2 });
      R.advance(200, 0);
    },
  },
  {
    name: 'shock',
    run: (R) => {
      R.set({ time: 20, fa: 640, fb: 980, intensity: 0.7 });
      R.point(820, 250);
      R.fire('shock');
      R.advance(14);
    },
  },
  {
    name: 'impulse',
    run: (R) => {
      R.set({ time: 25, fa: 640, fb: 980, intensity: 0.85 });
      R.point(700, 230);
      R.fire('impulse');
      R.advance(50);
    },
  },
  { name: 'lens', run: (R) => R.set({ time: 30, fa: 600, fb: 960, intensity: 0.4, lens: true }) },
  {
    name: 'ko',
    run: (R) => {
      R.set({ time: 36, fa: 640, fb: 980, intensity: 1 });
      R.point(900, 260);
      R.fire('ko');
      R.advance(10);
    },
  },
  { name: 'later', run: (R) => R.set({ time: 61, fa: 700, fb: 1020, intensity: 0.3, lens: false }) },
];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-angle=swiftshader',
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
  ],
});
let bad = 0;
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
  const t0 = Date.now();
  await page.goto(
    `${base}?stage=${stage}&quality=${quality}&freeze=1&t=0&text=0&sparks=1&ui=1&intensity=0.2`,
  );
  await page.waitForFunction("document.body.dataset.ready==='1'", null, { timeout: 180000 });
  console.log(`${stage}: ready in ${((Date.now() - t0) / 1000).toFixed(1)} s (quality ${quality})`);
  for (const sc of SCENARIOS) {
    if (only && !only.includes(sc.name)) continue;
    const t1 = Date.now();
    await page.evaluate(
      `(() => { const R = window.__RENDER__; R.loop.pause(); (${sc.run.toString()})(R); if (!${sc.run.toString().includes('advance')}) R.drawNow(); })()`,
    );
    await page.waitForTimeout(100);
    const file = `${outDir}/${stage}-${sc.name}.png`;
    await page.screenshot({ path: file });
    const st = await page.evaluate('window.__RENDER__.stats()');
    console.log(
      `  ${sc.name.padEnd(10)} ${file}  cpu ${st.frameMs.toFixed(1)} ms (scenery ${st.sceneryMs.toFixed(1)}, post ${st.postMs.toFixed(1)}), ${st.drawCalls} draws, wall ${((Date.now() - t1) / 1000).toFixed(1)} s`,
    );
  }
  await page.close();
}
await browser.close();
process.exit(bad ? 2 : 0);
