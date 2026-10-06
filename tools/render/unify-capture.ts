import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { launch } from '../lead/browser';
import { startRenderServer } from './devserver';

/**
 * Gate 1 deliverables of the unified look (docs/gallery/integration/), headless on the real GPU through dev/render/unify.html:
 *   npx tsx tools/render/unify-capture.ts [--out=docs/gallery/integration] [--only=weights|clip|fight] [--ticks=420]
 *  - vfx-weights.png: the four VFX weights on a neutral background, frame by frame;
 *  - vfx-weights.webm: the four weights played in real time, three times (recorded in-page from the canvas, ×2);
 *  - unify-before-after.png: the Witness vs the Planet in both slice arenas, classic path (left) vs unified (right);
 *    and the four single frames as unify-<stage>-<before|after>.png.
 * LOOK at every image.
 */
const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const outDir = arg('out', 'docs/gallery/integration');
const only = arg('only', '');
const ticks = Number(arg('ticks', '420'));
mkdirSync(outDir, { recursive: true });

const dataUrlToBuf = (u: string): Buffer => Buffer.from(u.slice(u.indexOf(',') + 1), 'base64');

const { server, url } = await startRenderServer();
const browser = await launch();
let bad = 0;
try {
  const want = (k: string): boolean => !only || only.split(',').includes(k);
  const open = async () => {
    const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
    const page = await ctx.newPage();
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
    await page.goto(`${url}/dev/render/unify.html`, { waitUntil: 'commit' });
    await page.waitForFunction("document.body.dataset.ready==='1'", null, { timeout: 180_000 });
    return { ctx, page };
  };

  if (want('weights')) {
    const { ctx, page } = await open();
    const png = (await page.evaluate('window.__UNIFY__.weightsSheet()')) as string;
    writeFileSync(`${outDir}/vfx-weights.png`, dataUrlToBuf(png));
    console.log(`vfx-weights.png written`);
    await ctx.close();
  }

  if (want('clip')) {
    const { ctx, page } = await open();
    await page.setViewportSize({ width: 1280, height: 720 });
    // the four weights played three times in real time (one VFX frame per animation frame), recorded from the canvas at ×2
    const webm = (await page.evaluate(`(async () => {
      const U = window.__UNIFY__;
      U.renderer.resize(1280, 720, 1);
      const canvas = document.getElementById('game');
      const rec = new MediaRecorder(canvas.captureStream(60), { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 8e6 });
      const chunks = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      const done = new Promise((r) => (rec.onstop = r));
      rec.start();
      for (let rep = 0; rep < 3; rep++)
        for (let f = 0; f < 180; f++) { U.weightsAt(f); await new Promise((r) => requestAnimationFrame(r)); }
      rec.stop();
      await done;
      const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      return btoa(s);
    })()`)) as string;
    writeFileSync(`${outDir}/vfx-weights.webm`, Buffer.from(webm, 'base64'));
    console.log(`vfx-weights.webm written (${Math.round((webm.length * 0.75) / 1024)} KB)`);
    await ctx.close();
  }
  if (only.split(',').includes('perf')) {
    const { ctx, page } = await open();
    await page.setViewportSize({ width: 1920, height: 1080 });
    for (const stage of ['mausoleum', 'shearfield'])
      for (const uni of [false, true]) {
        const r = await page.evaluate(`window.__UNIFY__.perf('${stage}', ${uni}, 150)`);
        console.log(
          `perf ${stage} ${uni ? 'unified' : 'classic'} @1920×1080 GPU ms p50/p90: ${JSON.stringify(r)}`,
        );
      }
    await ctx.close();
  }

  if (want('fight')) {
    const { ctx, page } = await open();
    const shots: PNG[] = [];
    for (const stage of ['mausoleum', 'shearfield']) {
      for (const uni of [false, true]) {
        const png = (await page.evaluate(`window.__UNIFY__.fight('${stage}', ${uni}, ${ticks})`)) as string;
        const buf = dataUrlToBuf(png);
        writeFileSync(`${outDir}/unify-${stage}-${uni ? 'after' : 'before'}.png`, buf);
        shots.push(PNG.sync.read(buf));
      }
    }
    // 2 × 2 at ×2: rows = arenas, columns = before | after
    const K = 2;
    const W = 640 * K;
    const H = 360 * K;
    const sheet = new PNG({ width: W * 2 + 8, height: H * 2 + 8 });
    sheet.data.fill(0);
    for (let i = 0; i < sheet.data.length; i += 4) sheet.data[i + 3] = 255;
    shots.forEach((s, i) => {
      const ox = (i % 2) * (W + 8);
      const oy = Math.floor(i / 2) * (H + 8);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const si = (Math.floor(y / K) * s.width + Math.floor(x / K)) * 4;
          const di = ((oy + y) * sheet.width + ox + x) * 4;
          sheet.data[di] = s.data[si]!;
          sheet.data[di + 1] = s.data[si + 1]!;
          sheet.data[di + 2] = s.data[si + 2]!;
        }
    });
    writeFileSync(`${outDir}/unify-before-after.png`, PNG.sync.write(sheet));
    console.log(
      'unify-before-after.png written (rows: mausoleum, shearfield; left: classic, right: unified)',
    );
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(bad ? 2 : 0);
