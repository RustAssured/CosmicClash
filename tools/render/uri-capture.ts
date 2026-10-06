import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { launch } from '../lead/browser';
import { startRenderServer } from './devserver';

/**
 * Gate 2A render parity for 우리 (uri/docs/CLAUDE_CODE_PROMPT.md Gate A), headless on the real GPU:
 *   npx tsx tools/render/uri-capture.ts [--out=docs/gallery/integration] [--pose=1]
 *  - the rest silhouette vs uri/data/uri_silhouette_rest.png (coverage of the mask, pixels outside it);
 *  - uri-rest-side-by-side.png: the game's render (unified path, live cores / loop / orbit) next to the oracle's own canvas
 *    (uri/reference/demos/uri-LOCKED-kinetic-pass.html, paused, demo off) at ×2;
 *  - with --pose=1, uri-posed.png: arms and domes turned, to look at the live light on rotated parts.
 * LOOK at every image.
 */
const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const outDir = arg('out', 'docs/gallery/integration');
mkdirSync(outDir, { recursive: true });
const png = (u: string): PNG => PNG.sync.read(Buffer.from(u.slice(u.indexOf(',') + 1), 'base64'));
const OX = 120;
const OY = 16;

const { server, url } = await startRenderServer();
const browser = await launch();
let bad = 0;
try {
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
  await page.goto(`${url}/dev/render/uri.html`, { waitUntil: 'commit' });
  await page.waitForFunction("document.body.dataset.ready==='1'", null, { timeout: 180_000 });
  const game = png((await page.evaluate('window.__URI__.rest(true, 3)')) as string);

  // ---- silhouette: figure pixels = differ from the backdrop-only frame ----
  // fists compact (spread 1, the reference silhouette's own state) unless --spread says otherwise (rest per TUNING: 1.14)
  const sp = arg('spread', '1');
  const green = png((await page.evaluate(`window.__URI__.restOnGreen(3, false, ${sp})`)) as string);
  // the same frame over magenta: a figure pixel is the same over both backdrops, a backdrop pixel is not
  const greenBg = png((await page.evaluate(`window.__URI__.restOnGreen(3, true, ${sp})`)) as string);
  writeFileSync(`${outDir}/uri-rest-green.png`, PNG.sync.write(green));
  writeFileSync(`${outDir}/uri-rest-greenbg.png`, PNG.sync.write(greenBg));
  const mask = PNG.sync.read(readFileSync('uri/data/uri_silhouette_rest.png'));
  let inMask = 0;
  let covered = 0;
  let outside = 0;
  const missing: string[] = [];
  const fig = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= 640 || y >= 360) return false;
    const i = (y * 640 + x) * 4;
    // figure pixels do not depend on the backdrop (green vs magenta render); every backdrop pixel differs by hundreds of levels
    const d =
      Math.abs(green.data[i]! - greenBg.data[i]!) +
      Math.abs(green.data[i + 1]! - greenBg.data[i + 1]!) +
      Math.abs(green.data[i + 2]! - greenBg.data[i + 2]!);
    return d < 40;
  };
  const inM = (rx: number, ry: number): boolean =>
    rx >= 0 && ry >= 0 && rx < mask.width && ry < mask.height && mask.data[(ry * mask.width + rx) * 4]! > 127;
  for (let ry = 0; ry < mask.height; ry++)
    for (let rx = 0; rx < mask.width; rx++) {
      const sx = rx + OX;
      const sy = ry + OY;
      if (inM(rx, ry)) {
        inMask++;
        if (fig(sx, sy)) covered++;
        else if (missing.length < 12) missing.push(`${rx},${ry}`);
      } else if (fig(sx, sy)) {
        // the 1-px outline and the live loop may sit just outside the mask: count only what is ≥ 2 px away from it
        let near = false;
        for (let dy = -2; dy <= 2 && !near; dy++)
          for (let dx = -2; dx <= 2; dx++) if (inM(rx + dx, ry + dy)) near = true;
        if (!near) outside++;
      }
    }
  console.log(
    `rest silhouette (fist spread ${sp}): ${covered}/${inMask} mask pixels covered (${((100 * covered) / inMask).toFixed(2)} %), ${outside} figure pixels ≥ 2 px outside it${missing.length ? `; uncovered (reference px): ${missing.join(' ')}` : ''}`,
  );

  // ---- the oracle, paused, demo off, at its own rest frame ----
  const oracle = await ctx.newPage();
  await oracle.goto(
    'file:///' + process.cwd().replace(/\\/g, '/') + '/uri/reference/demos/uri-LOCKED-kinetic-pass.html',
  );
  await oracle.waitForTimeout(1500);
  const oracleUrl = (await oracle.evaluate(`(() => {
    window.__K.demo = false;
    window.__K.playing = false;
    // let any move in flight finish and the body settle back to rest (8 s of the oracle's own clock)
    for (let i = 0; i < 480; i++) window.__K.step(1 / 60);
    return document.getElementById('cvM').toDataURL('image/png');
  })()`)) as string;
  const orc = png(oracleUrl);
  const K = 2;
  const sheet = new PNG({ width: 640 * K * 2 + 8, height: 360 * K });
  for (let i = 0; i < sheet.data.length; i += 4) sheet.data[i + 3] = 255;
  [game, orc].forEach((s, k) => {
    for (let y = 0; y < 360 * K; y++)
      for (let x = 0; x < 640 * K; x++) {
        const si = (Math.floor(y / K) * s.width + Math.floor(x / K)) * 4;
        const di = (y * sheet.width + k * (640 * K + 8) + x) * 4;
        sheet.data[di] = s.data[si]!;
        sheet.data[di + 1] = s.data[si + 1]!;
        sheet.data[di + 2] = s.data[si + 2]!;
      }
  });
  writeFileSync(`${outDir}/uri-rest-side-by-side.png`, PNG.sync.write(sheet));
  console.log('uri-rest-side-by-side.png written (left: game, right: oracle)');

  if (arg('pose', '0') === '1') {
    const posed = (await page.evaluate(
      `window.__URI__.posed({ ta: 0.25, sL: -0.6, eL: 0.5, sR: 0.7, eR: -0.4 }, 3)`,
    )) as string;
    writeFileSync(`${outDir}/uri-posed.png`, Buffer.from(posed.slice(posed.indexOf(',') + 1), 'base64'));
    console.log('uri-posed.png written');
  }
  await ctx.close();
} finally {
  await browser.close();
  await server.close();
}
process.exit(bad ? 2 : 0);
