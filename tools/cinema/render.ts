import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { composeFrame } from '../../src/cinema/camera';
import { NATIVE_H, NATIVE_W } from '../../src/cinema/types';
import { launch } from '../lead/browser';
import { startRenderServer } from '../render/devserver';
import { arg, frameHash, openCinema, readFrame } from './common';

/**
 * Offline render of a cinema timeline (TRAILER_V3 §2.2): the page steps the timeline frame by frame (`?cinema=…&render=1`),
 * the native frame is read back exactly, and this script composes it at whole-number scales (camera zoom as whole-pixel
 * blocks, letterbox and cards ×S; src/cinema/camera.ts) and streams raw RGB to ffmpeg (x264 -tune animation -crf 12).
 *   npx tsx tools/cinema/render.ts --timeline=p0 [--scales=3,6] [--from=0] [--to=all] [--out=press/cinema] [--stills=0,90]
 * Writes <out>/<timeline>-1080p.mp4 (×3) and -2160p.mp4 (×6), <timeline>-hashes.json (one hash per frame) and, for
 * --stills, lossless PNG frames at ×3.
 */
const name = arg('timeline', 'p0');
const scales = arg('scales', '3,6').split(',').map(Number);
const out = arg('out', 'press/cinema');
const stills = new Set(arg('stills', '').split(',').filter(Boolean).map(Number));
mkdirSync(out, { recursive: true });
const label = (s: number): string => `${NATIVE_H * s}p`;

const { server, url } = await startRenderServer();
const browser = await launch();
try {
  const { page, errors, frames } = await openCinema(browser, url, name);
  const from = Number(arg('from', '0'));
  const to = arg('to', 'all') === 'all' ? frames : Math.min(frames, Number(arg('to', '0')));
  const encoders: { s: number; ff: ChildProcess; done: Promise<number>; buf: Uint8Array }[] = scales.map(
    (s) => {
      const ff = spawn(
        'ffmpeg',
        [
          '-y',
          '-loglevel',
          'error',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          '-s',
          `${NATIVE_W * s}x${NATIVE_H * s}`,
          '-r',
          '60',
          '-i',
          '-',
          '-sws_flags',
          'neighbor',
          '-c:v',
          'libx264',
          '-preset',
          'slow',
          '-tune',
          'animation',
          '-crf',
          '12',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          `${out}/${name}-${label(s)}.mp4`,
        ],
        { stdio: ['pipe', 'inherit', 'inherit'] },
      );
      return {
        s,
        ff,
        done: new Promise<number>((r) => ff.on('exit', (c) => r(c ?? 1))),
        buf: new Uint8Array(NATIVE_W * s * NATIVE_H * s * 3),
      };
    },
  );
  const hashes: Record<number, string> = {};
  const t0 = Date.now();
  for (let n = from; n < to; n++) {
    const f = await readFrame(page, n);
    hashes[n] = frameHash(f);
    for (const e of encoders) {
      composeFrame(f.scene, f.overlay, f.zoom, f.focus, e.s, e.buf, f.matter, f.dutch);
      if (!e.ff.stdin!.write(e.buf)) await new Promise((r) => e.ff.stdin!.once('drain', r));
    }
    if (stills.has(n)) {
      const s = 3;
      const rgb = composeFrame(f.scene, f.overlay, f.zoom, f.focus, s, undefined, f.matter, f.dutch);
      const png = new PNG({ width: NATIVE_W * s, height: NATIVE_H * s });
      for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
        png.data[j] = rgb[i]!;
        png.data[j + 1] = rgb[i + 1]!;
        png.data[j + 2] = rgb[i + 2]!;
        png.data[j + 3] = 255;
      }
      writeFileSync(`${out}/${name}-f${String(n).padStart(4, '0')}.png`, PNG.sync.write(png));
    }
    if (n % 60 === 0)
      console.log(
        `  frame ${n}/${to}  ${f.shot}  zoom ${f.zoom.toFixed(2)}  focus ${f.focus.map((v) => v.toFixed(0)).join(',')}  ${((Date.now() - t0) / 1000).toFixed(0)} s`,
      );
  }
  for (const e of encoders) e.ff.stdin!.end();
  for (const e of encoders) console.log(`${out}/${name}-${label(e.s)}.mp4: ffmpeg ${await e.done}`);
  writeFileSync(`${out}/${name}-hashes.json`, JSON.stringify(hashes, null, 1));
  if (errors.length) console.log(`console:\n  ${errors.slice(0, 8).join('\n  ')}`);
} finally {
  await browser.close();
  await server.close();
}
