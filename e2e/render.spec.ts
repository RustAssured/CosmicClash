import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { startRenderServer } from '../tools/render/devserver';

/**
 * Renderer, end to end, in a real WebGL2 context (headless Chromium on SwiftShader in CI):
 *
 *  1. the GPU conformance suite of `dev/render/verify.ts` (the same checks as `node tools/render/verify.mjs`): layer mapping
 *     against the contract pixel for pixel, blending, dirty-rect uploads, bloom / god rays / lensing / shockwaves, tick-locked
 *     grain, integer upscale, context loss and restore, non-blocking stage preparation, quality tiers and the adaptive
 *     controller, fighter readability on every stage and stage distinctness. Every check is its own soft assertion so one
 *     failure does not hide the others.
 *  2. every stage boots in the sandbox with a clean console and draws a non-blank, non-uniform frame; a screenshot of each goes
 *     to `.scratch/e2e/` for a human to look at.
 */
let server: ViteDevServer;
let base = '';
test.beforeAll(async () => {
  ({ server, url: base } = await startRenderServer());
});
test.afterAll(async () => {
  await server.close();
});

const SHOTS = '.scratch/e2e';
const STAGES = ['nursery', 'rim', 'redgiant', 'quasar', 'tussenruimte'] as const;

/** Console problems are collected, not thrown, so the test can report them with the check that provoked them. */
function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'error' || m.type() === 'warning') && !/Failed to load resource|context lost/i.test(t))
      problems.push(`console.${m.type()}: ${t}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

interface VerifyResult {
  name: string;
  ok: boolean;
  detail: string;
}

test('GPU conformance: every check of dev/render/verify.ts passes', async ({ page }) => {
  test.setTimeout(20 * 60_000);
  const problems = watchConsole(page);
  await page.goto(`${base}/dev/render/verify.html`, { waitUntil: 'commit' });
  await page.waitForFunction('window.__VERIFY__ && window.__VERIFY__.done', null, { timeout: 18 * 60_000 });
  const v = (await page.evaluate('window.__VERIFY__')) as {
    failed: number;
    results: VerifyResult[];
    error?: string;
  };
  expect(v.error, 'verify page threw').toBeUndefined();
  expect(v.results.length, 'the suite ran').toBeGreaterThan(30);
  for (const r of v.results) expect.soft(r.ok, `${r.name}${r.detail ? ` — ${r.detail}` : ''}`).toBe(true);
  expect(problems, 'no console errors or warnings').toEqual([]);
  expect(v.failed).toBe(0);
});

test.describe('every stage boots and draws', () => {
  test.beforeAll(() => {
    mkdirSync(SHOTS, { recursive: true });
  });
  for (const stage of STAGES) {
    test(`${stage}: clean console, non-blank, non-uniform frame`, async ({ page }) => {
      test.setTimeout(5 * 60_000);
      const problems = watchConsole(page);
      await page.goto(
        `${base}/dev/render/?stage=${stage}&quality=1&freeze=1&t=0&text=0&sparks=0&ui=0&intensity=0.2`,
        {
          waitUntil: 'commit',
        },
      );
      await page.waitForFunction("document.body.dataset.ready==='1'", null, { timeout: 180_000 });
      await page.evaluate(
        '(() => { const R = window.__RENDER__; R.loop.pause(); R.set({ time: 6, fa: 640, fb: 980, intensity: 0.2, flash: 0, aberration: 0 }); R.settle(); R.drawNow(); })()',
      );
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${SHOTS}/render-${stage}.png` });
      // luminance statistics of the drawn frame (logical 640x360, as the sandbox reads it back: RGBA bytes)
      const stats = (await page.evaluate(`(() => {
        const bin = atob(window.__RENDER__.captureBase64());
        let s = 0, s2 = 0, n = 0, lit = 0;
        for (let i = 0; i < bin.length; i += 28) {
          const l = 0.2126 * bin.charCodeAt(i) + 0.7152 * bin.charCodeAt(i + 1) + 0.0722 * bin.charCodeAt(i + 2);
          s += l; s2 += l * l; n++; if (l > 24) lit++;
        }
        const m = s / n;
        return { mean: m, sd: Math.sqrt(Math.max(0, s2 / n - m * m)), lit: lit / n };
      })()`)) as { mean: number; sd: number; lit: number };
      expect(stats.mean, 'not black').toBeGreaterThan(3);
      expect(stats.sd, 'not a flat colour').toBeGreaterThan(6);
      expect(stats.lit, 'some of the frame is lit, and some is dark').toBeGreaterThan(0.02);
      expect(stats.lit).toBeLessThan(0.98);
      expect(problems).toEqual([]);
    });
  }
});
