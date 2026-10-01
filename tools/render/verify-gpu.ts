import { launch } from '../lead/browser';
import { startRenderServer } from './devserver';

/**
 * The renderer's GPU conformance page (dev/render/verify.html) in a real WebGL2 context, self-contained: starts its own
 * throwaway Vite server, opens the page in the shared launcher (Edge on the real GPU on Windows, SwiftShader elsewhere),
 * prints every check and exits 1 on any failure or console error/warning.
 *   npx tsx tools/render/verify-gpu.ts [--only=stages] [--skipctx]
 */
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const skipctx = process.argv.includes('--skipctx');
const { server, url } = await startRenderServer();
const browser = await launch();
let code = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  page.on('console', (m) => {
    if (
      (m.type() === 'error' || m.type() === 'warning') &&
      !/Failed to load resource|WebGL context lost|context lost/i.test(m.text())
    )
      errors.push(`[console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  const q = new URLSearchParams();
  if (only) q.set('only', only);
  if (skipctx) q.set('skipctx', '1');
  await page.goto(`${url}/dev/render/verify.html${q.size ? `?${q}` : ''}`, { waitUntil: 'commit' });
  await page.waitForFunction('window.__VERIFY__ && window.__VERIFY__.done', null, { timeout: 900_000 });
  const v = (await page.evaluate('window.__VERIFY__')) as {
    results: { name: string; ok: boolean; detail: string }[];
    failed: number;
    error?: string;
  };
  for (const r of v.results)
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
  if (v.error) console.log('ERROR', v.error);
  for (const e of errors) console.log(e);
  console.log(
    `\n${v.results.length - v.failed}/${v.results.length} passed, ${errors.length} console errors/warnings`,
  );
  code = v.failed || errors.length || v.error ? 1 : 0;
} finally {
  await browser.close();
  await server.close();
}
process.exit(code);
