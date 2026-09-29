#!/usr/bin/env node
/**
 * Renderer performance report (headless Chromium + SwiftShader software WebGL2, 1280×720 viewport).
 *   node tools/render/perf.mjs [--stage=nursery] [--frames=6] [--tiers=0,1,2]
 * Reports, per quality tier: setStage time, JS ms per draw() call (renderer.stats.frameMs style, measured around draw()),
 * and WALL ms per frame including the software rasteriser (the draw is forced to complete with a 1×1 readback).
 * SwiftShader executes on the CPU, so wall numbers are pessimistic vs any real GPU; the JS-side numbers and the
 * pixel/texel counts printed alongside are the representative part. Needs the dev server on :5201.
 */
import { chromium } from '@playwright/test';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const stage = arg('stage', 'nursery');
const frames = Number(arg('frames', 6));
const tiers = arg('tiers', '0,1,2').split(',').map(Number);
const perLayer = process.argv.includes('--layers');
const base = process.env.RENDER_URL || 'http://localhost:5201/dev/render/';
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
console.log(
  `stage ${stage}, ${frames} frames per measurement, 1280x720 viewport, SwiftShader (software) WebGL2`,
);
for (const q of tiers) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${base}?stage=${stage}&quality=${q}&freeze=1&t=10&text=0&ui=1&sparks=1`, {
    waitUntil: 'commit',
  });
  await page.waitForFunction("document.body.dataset.ready==='1'", null, { timeout: 300000 });
  const r = await page.evaluate(
    ([stage, frames, perLayer]) => {
      const R = window.__RENDER__;
      const rend = R.renderer;
      const gl = rend.three.getContext();
      const px = new Uint8Array(4);
      const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const measure = (label) => {
        R.drawNow(); // warm (shader compile, texture upload)
        sync();
        let js = 0;
        const t0 = performance.now();
        for (let i = 0; i < frames; i++) {
          const a = performance.now();
          R.drawNow();
          js += performance.now() - a;
        }
        sync();
        const wall = (performance.now() - t0) / frames;
        return { label, jsMs: +(js / frames).toFixed(1), wallMs: +wall.toFixed(0) };
      };
      const t = performance.now();
      rend.setStage(stage);
      sync();
      const setStageMs = Math.round(performance.now() - t);
      const out = { setStageMs, runs: [] };
      out.runs.push(measure('full frame'));
      const layers = rend.scenery.kit.layers;
      layers.forEach((l) => (l.mesh.visible = false));
      out.runs.push(measure('no scenery layers (dither + 2D + bloom + rays + post + present)'));
      layers.forEach((l) => (l.mesh.visible = true));
      if (perLayer) {
        out.perLayer = [];
        for (const l of layers) {
          layers.forEach((m) => (m.visible = false));
          layers.forEach((m) => (m.mesh.visible = false));
          l.mesh.visible = true;
          const m = measure(l.name);
          out.perLayer.push({ name: l.name, wallMs: m.wallMs });
        }
        layers.forEach((l) => (l.mesh.visible = true));
      }
      // Fill-rate estimate (machine independent): fragments shaded per frame in the scenery pass at the reference camera.
      const ss = rend.tier.supersample;
      let sceneryFrags = 0;
      for (const l of layers) {
        const u = l.uniforms;
        const geo = l.mesh.geometry;
        const pos = geo.getAttribute('aPos');
        if (pos && geo.getAttribute('aShape')) {
          const shape = geo.getAttribute('aShape');
          const par = u.uParallax.value;
          let frags = 0;
          for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i) - 480 * par;
            const y = pos.getY(i) - 110 * par;
            const hw = shape.getX(i);
            const hh = shape.getY(i);
            if (x < -hw || y < -hh || x > 640 + hw || y > 360 + hh) continue;
            frags += 4 * hw * hh * ss * ss;
          }
          sceneryFrags += frags;
        } else {
          sceneryFrags += 640 * 360 * ss * ss;
        }
      }
      const post =
        640 * 360 * (1 /*dither*/ + 1 /*post*/ + 0.25 /*god*/ + 0.6) /*bloom chain*/ +
        1280 * 720; /*present at 2x*/
      out.fill = { sceneryMFrags: +(sceneryFrags / 1e6).toFixed(1), postMFrags: +(post / 1e6).toFixed(1) };
      const drawn = { calls: rend.stats.drawCalls, layers: layers.length };
      out.drawn = drawn;
      return out;
    },
    [stage, frames, perLayer],
  );
  console.log(
    `\nquality ${q}: setStage ${r.setStageMs} ms (incl. shader compile + bakes), ${r.drawn.layers} scenery layers, ${r.drawn.calls} draw calls`,
  );
  console.log(
    `  fill estimate: scenery ${r.fill.sceneryMFrags} Mfrag + post/present ${r.fill.postMFrags} Mfrag per frame (at 3 Gfrag/s blended ≈ ${((r.fill.sceneryMFrags + r.fill.postMFrags) / 3).toFixed(1)} ms on an integrated GPU)`,
  );
  for (const run of r.runs)
    console.log(
      `  ${run.label.padEnd(72)} JS ${String(run.jsMs).padStart(6)} ms/draw   wall ${String(run.wallMs).padStart(5)} ms/frame`,
    );
  if (r.perLayer) {
    const base = r.runs[1].wallMs;
    console.log('  per-layer wall cost (layer alone, minus the no-scenery baseline):');
    for (const l of r.perLayer.sort((a, b) => b.wallMs - a.wallMs))
      console.log(`    ${l.name.padEnd(22)} ${String(Math.max(0, l.wallMs - base)).padStart(6)} ms`);
  }
  await page.close();
}
await browser.close();
