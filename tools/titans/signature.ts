/**
 * A titan's signature animation at rest, as the game draws it (dev server, real renderer, headless Edge on the real GPU): both
 * fighters are dummies, the match is stepped one tick per frame and a crop around the titan is saved per frame, then muxed into
 * a looping clip and a frame strip with ffmpeg. With --perf it also reads the renderer's GPU timer over live frames.
 *
 *   npx tsx tools/titans/signature.ts blackhole [--tag=after] [--sig=1] [--b=planet] [--t0=120] [--n=90] [--every=10]
 *     [--clip=x,y,w,h (px of the 1280×720 page; default: around fighter 0)] [--q=1] [--perf=1] [--out=docs/gallery/signature]
 *     [--mode=aivai (an AI fight instead of two dummies: a damaged body, the crop placed at t0)]
 *
 * --sig=0 switches the signature pass off (the plain body layer), for before/after and A/B GPU numbers.
 * Writes <out>/<id>-<tag>.mp4 (60 fps, one tick per frame), <out>/<id>-<tag>-strip.png (every `every`-th frame) and the frames
 * under .scratch/signature/<id>-<tag>/.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { launch, openGame } from '../lead/browser';
import { startRenderServer } from '../render/devserver';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const id = args.find((a) => !a.startsWith('--')) ?? 'blackhole';
const tag = opt('tag', 'after');
const sig = opt('sig', '1');
const b = opt('b', 'planet');
const t0 = +opt('t0', '120');
const n = +opt('n', '90');
const every = +opt('every', '10');
const q = opt('q', '1');
const perf = opt('perf', '0') === '1';
const OUT = opt('out', 'docs/gallery/signature');
const FR = `.scratch/signature/${id}-${tag}`;
rmSync(FR, { recursive: true, force: true });
mkdirSync(FR, { recursive: true });
mkdirSync(OUT, { recursive: true });

const ffmpeg = (a: string[]): void => {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...a], { stdio: 'inherit' });
  if (r.status !== 0) console.log(`ffmpeg failed (${r.status ?? r.error?.message})`);
};

const { server, url } = await startRenderServer();
const browser = await launch();
try {
  const { page, errors } = await openGame(
    browser,
    `${url}/?mode=${opt('mode', 'fight')}&a=${id}&b=${b}&seed=21&freeze=1&q=${q}&hud=0&aftermath=0&sig=${sig}`,
    { width: 1280, height: 720 },
  );
  const now = (await page.evaluate(() => window.__ADEUK__!.summary().tick)) as number;
  if (t0 > now) await page.evaluate((k) => window.__ADEUK__!.step(k), t0 - now);
  let clip = opt('clip', '');
  if (!clip) {
    // around fighter 0: world → logical px through the harness camera (zoom about the frame centre), ×2 on the page
    const c = (await page.evaluate(() => {
      const h = window.__ADEUK__!;
      return { cam: h.camera(), f: h.summary().fighters[0] };
    })) as { cam: { x: number; y: number; zoom: number }; f: { x: number; y: number } };
    const sx = 640 + (c.f.x - c.cam.x) * c.cam.zoom * 2;
    const sy = 360 + (c.f.y - c.cam.y) * c.cam.zoom * 2;
    const w = 400;
    const h = 300;
    clip = `${Math.max(0, Math.round(sx - w / 2))},${Math.max(0, Math.round(sy - h / 2))},${w},${h}`;
  }
  const [cx, cy, cw, ch] = clip.split(',').map(Number) as [number, number, number, number];
  console.log(`clip ${clip}`);
  for (let i = 0; i < n; i++) {
    await page.evaluate(() => {
      const h = window.__ADEUK__!;
      h.step(1);
      h.renderNow();
    });
    const png = await page.screenshot({ type: 'png', clip: { x: cx, y: cy, width: cw, height: ch } });
    writeFileSync(`${FR}/f${String(i).padStart(4, '0')}.png`, png);
  }
  ffmpeg([
    '-framerate',
    '60',
    '-i',
    `${FR}/f%04d.png`,
    '-c:v',
    'libx264',
    '-crf',
    '12',
    '-pix_fmt',
    'yuv420p',
    '-vf',
    'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    `${OUT}/${id}-${tag}.mp4`,
  ]);
  const cols = Math.ceil(n / every);
  ffmpeg([
    '-i',
    `${FR}/f%04d.png`,
    '-vf',
    `select='not(mod(n\\,${every}))',tile=${Math.min(cols, 5)}x${Math.ceil(cols / 5)}:padding=4:color=white`,
    '-frames:v',
    '1',
    `${OUT}/${id}-${tag}-strip.png`,
  ]);
  console.log(`${OUT}/${id}-${tag}.mp4, ${OUT}/${id}-${tag}-strip.png`);
  if (perf) {
    // live frames (one per animation frame, ticking), GPU ms from the renderer's timer query. The timer counts everything on
    // the GPU in that span (other apps too), so the pass is measured A/B INTERLEAVED in one page: blocks of frames with the
    // signature on and off (the dev server's own module instance of signature.ts), alternating, so drift hits both alike.
    const res = (await page.evaluate(async () => {
      const h = window.__ADEUK__!;
      const mod = (await import(/* @vite-ignore */ '/src/render/signature.ts')) as {
        SIGNATURE: { on: boolean };
      };
      const on: number[] = [];
      const off: number[] = [];
      for (let b = 0; b < 12; b++) {
        mod.SIGNATURE.on = b % 2 === 0;
        for (let i = 0; i < 50; i++) {
          h.step(1);
          h.renderNow();
          await new Promise((r) => requestAnimationFrame(r));
          const g = (h.renderStats() as { gpuMs: number | null }).gpuMs;
          // the timer reads a frame or two late: skip the start of each block
          if (i > 8 && g !== null) (mod.SIGNATURE.on ? on : off).push(g);
        }
      }
      mod.SIGNATURE.on = true;
      return { on, off };
    })) as { on: number[]; off: number[] };
    const p = (a: number[], k: number): string => {
      const s = a.slice().sort((x, y) => x - y);
      return s.length ? s[Math.floor(k * (s.length - 1))]!.toFixed(2) : 'n/a';
    };
    console.log(
      `perf q=${q} @1280×720 (interleaved): signature on GPU p50 ${p(res.on, 0.5)} / p90 ${p(res.on, 0.9)} ms; off p50 ${p(res.off, 0.5)} / p90 ${p(res.off, 0.9)} ms (${res.on.length}+${res.off.length} samples)`,
    );
  }
  if (errors.length) console.log(`console: ${errors.slice(0, 5).join(' | ')}`);
} finally {
  await browser.close();
  await server.close();
}
