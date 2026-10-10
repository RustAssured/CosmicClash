/**
 * Render WJ's story teaser (trailer.html) frame by frame from the site's own scenes (site/story.js), here on Windows.
 *
 *   npm run build:site                              # the site build: story.js and media/ are served from dist/
 *   npx tsx tools/teaser/render.mjs check           # fonts, 우리's sprite, and the weld timing against cues.json
 *   npx tsx tools/teaser/render.mjs stills 5 11 26  # PNG stills (×3) into press/teaser/stills/
 *   npx tsx tools/teaser/render.mjs video           # press/trailer/story-teaser.mp4 (1920×1080, 30 fps, with score.wav)
 *
 * - The page is trailer.html copied into dist/ (so './story.js' and 'media/' resolve), served by vite preview, and driven
 *   by headless Edge (tools/lead/browser.ts launch()).
 * - Weld timing: the page gets tools/teaser/cues.json as window.__CUES, and story.js takes every weld's moment from it,
 *   so each chunk lands on its clank in press/teaser/score.wav. The check compares trailer.html's own cues() with
 *   cues.json (they must agree within one frame); cues.json is never rewritten here (score.wav was made from it).
 * - Frames are 640×360 RGBA, scaled ×3 nearest-neighbour to 1080p by ffmpeg and muxed with the score.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { preview } from 'vite';
import { launch } from '../lead/browser.ts';

const mode = process.argv[2] || 'check';
const CUES = JSON.parse(readFileSync('tools/teaser/cues.json', 'utf8'));
const FPS = 30;
const OUT = 'press/trailer/story-teaser.mp4';
const SCORE = 'press/teaser/score.wav';

copyFileSync('tools/teaser/trailer.html', 'dist/__teaser.html');
const server = await preview({
  preview: { port: 4196, strictPort: false, host: '127.0.0.1' },
  build: { outDir: 'dist' },
  logLevel: 'warn',
});
const base = server.resolvedUrls.local[0];
const b = await launch();
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', (e) => console.log('ERR', String(e)));
p.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE', m.text());
});
await p.addInitScript(`window.__CUES = ${JSON.stringify(CUES)};`);
await p.goto(`${base}__teaser.html`, { waitUntil: 'load' });
await p.waitForFunction('window.film');
await p.evaluate('window.film.ready()');
// the scale shot's sprites load beside 우리; wait for them too
await p.waitForTimeout(500);
const info = await p.evaluate('({ frames: window.film.frames, cues: window.film.cues() })');

// ---------------------------------------------------------------- timing check against the score's cue sheet
{
  const key = (w) => `${w[1]}|${w[2]}`;
  const group = (ws) => {
    const m = new Map();
    for (const w of ws) (m.get(key(w)) || m.set(key(w), []).get(key(w))).push(w[0]);
    for (const v of m.values()) v.sort((a, c) => a - c);
    return m;
  };
  const a = group(info.cues.welds),
    c = group(CUES.welds);
  let worst = 0,
    missing = 0;
  for (const [k, v] of c) {
    const o = a.get(k) || [];
    v.forEach((t, i) => (o[i] == null ? missing++ : (worst = Math.max(worst, Math.abs(o[i] - t)))));
  }
  const shotsOk = CUES.shots.every((s, i) => Math.abs(s.start - info.cues.shots[i].start) < 1e-9);
  const fonts = await p.evaluate(
    `['32px "Jersey 10"', '16px "Silkscreen"', '32px "DotGothic16"'].map((f) => document.fonts.check(f, '아득'))`,
  );
  console.log(`frames ${info.frames} (${(info.frames / FPS).toFixed(2)} s), total ${info.cues.total} s`);
  console.log(
    `welds: ${info.cues.welds.length} rendered, ${CUES.welds.length} in cues.json, worst |Δt| ${(worst * 1000).toFixed(3)} ms (1 frame = ${(1000 / FPS).toFixed(1)} ms), unmatched ${missing}`,
  );
  console.log(
    `shots match cues.json: ${shotsOk}; fonts loaded (Jersey 10, Silkscreen, DotGothic16): ${fonts}`,
  );
  if (worst > 1 / FPS || missing || !shotsOk) {
    console.log('TIMING MISMATCH: the clanks in score.wav would drift');
    process.exitCode = 1;
  }
}

const frame = async (n) => Buffer.from(await p.evaluate(`window.film.frame(${n})`), 'base64');

if (mode === 'stills') {
  const { PNG } = await import('pngjs');
  mkdirSync('press/teaser/stills', { recursive: true });
  for (const s of process.argv.slice(3).map(Number)) {
    const rgba = await frame(Math.round(s * FPS));
    const png = new PNG({ width: 1920, height: 1080 });
    for (let y = 0; y < 1080; y++)
      for (let x = 0; x < 1920; x++) {
        const i = (((y / 3) | 0) * 640 + ((x / 3) | 0)) * 4,
          o = (y * 1920 + x) * 4;
        png.data[o] = rgba[i];
        png.data[o + 1] = rgba[i + 1];
        png.data[o + 2] = rgba[i + 2];
        png.data[o + 3] = 255;
      }
    const f = `press/teaser/stills/teaser-${s.toFixed(1)}s.png`;
    writeFileSync(f, PNG.sync.write(png));
    console.log(f);
  }
} else if (mode === 'video') {
  mkdirSync('press/trailer', { recursive: true });
  const ff = spawn(
    'ffmpeg',
    // raw 640×360 frames on stdin → ×3 nearest → H.264, with the score (AAC 256k); the film is exactly cues.total long
    [
      '-y',
      '-v',
      'error',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      '640x360',
      '-r',
      String(FPS),
      '-i',
      '-',
      '-i',
      SCORE,
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-vf',
      'scale=1920:1080:flags=neighbor',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '14',
      '-tune',
      'animation',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '256k',
      '-t',
      String(info.cues.total),
      '-movflags',
      '+faststart',
      OUT,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const t0 = Date.now();
  for (let n = 0; n < info.frames; n++) {
    if (!ff.stdin.write(await frame(n))) await new Promise((r) => ff.stdin.once('drain', r));
    if (n % 150 === 0) console.log('frame', n, `${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log(`done: ${OUT} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

await b.close();
await new Promise((r) => server.httpServer.close(() => r()));
rmSync('dist/__teaser.html', { force: true });
