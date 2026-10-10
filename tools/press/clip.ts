import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { AudioResult } from '../../dev/press/press';
import { launch, openGame } from '../lead/browser';
import { startRenderServer } from '../render/devserver';
import { WORK, arg, openWorker, query } from './common';
import { SHOTS } from './shots';

/**
 * Render the shot list (tools/press/shots.ts): for each shot, the game's own sound for its ticks (the worker, offline) and
 * the real game drawing one tick per frame at 1920×1080 (the 640×360 frame at ×3, full post, q=2, no HUD). Frames are
 * retimed onto the sound's clock (KO slow motion holds frames exactly as long as the audio stretches) and muxed:
 * press/work/clips/<name>.mov (H.264 4:4:4 near-lossless, 60 fps, PCM) + <name>.json (frame ↔ tick map) and the shot's
 * still ticks as lossless PNGs in press/work/stills/<name>-<tick>.png.
 *   npx tsx tools/press/clip.ts [--only=a,b] [--redo=1]
 */
const only = arg('only', '');
const redo = arg('redo', '0') === '1';
const CLIPS = `${WORK}/clips`;
const STILLS = `${WORK}/stills`;
mkdirSync(CLIPS, { recursive: true });
mkdirSync(STILLS, { recursive: true });

const { server, url } = await startRenderServer();
const browser = await launch();
try {
  const worker = await openWorker(browser, url);
  for (const s of SHOTS) {
    if (only && !only.split(',').includes(s.name)) continue;
    if (!redo && existsSync(`${CLIPS}/${s.name}.mov`)) continue;
    const t = Date.now();
    const au = (await worker.evaluate(([c, a, b]) => window.__press!.audio(c, a, b, 3), [
      s.cfg,
      s.t0,
      s.t1,
    ] as const)) as AudioResult;
    const wav = `${CLIPS}/${s.name}.wav`;
    writeFileSync(wav, Buffer.from(au.wav, 'base64'));
    const ticks = au.times.length;
    // output frame j (time j/60) shows the last tick that ran at or before it
    const frames = Math.round(au.seconds * 60);
    const showOf: number[] = [];
    for (let j = 0, i = 0; j < frames; j++) {
      while (i + 1 < ticks && au.times[i + 1]! <= j / 60 + 1e-6) i++;
      showOf.push(i);
    }
    const repeat = new Array<number>(ticks).fill(0);
    for (const i of showOf) repeat[i]!++;

    const { page, errors } = await openGame(
      browser,
      `${url}/?${query(s.cfg)}&freeze=1&aftermath=0&q=2&hud=0`,
      { width: 1920, height: 1080 },
    );
    const now = (await page.evaluate(() => window.__ADEUK__!.summary().tick)) as number;
    await page.evaluate((n) => window.__ADEUK__!.step(n), s.t0 - 1 - now);
    const ff = spawn(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'image2pipe',
        '-framerate',
        '60',
        '-i',
        '-',
        '-i',
        wav,
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '8',
        '-pix_fmt',
        'yuv444p',
        '-c:a',
        'pcm_s16le',
        '-shortest',
        `${CLIPS}/${s.name}.mov`,
      ],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
    const done = new Promise<number>((res) => ff.on('exit', (c) => res(c ?? 1)));
    for (let i = 0; i < ticks; i++) {
      await page.evaluate(() => {
        const h = window.__ADEUK__!;
        h.step(1);
        h.renderNow();
      });
      const png = await page.screenshot({ type: 'png' });
      if (s.stills.includes(s.t0 + i)) writeFileSync(`${STILLS}/${s.name}-${s.t0 + i}.png`, png);
      for (let r = 0; r < repeat[i]!; r++)
        if (!ff.stdin.write(png)) await new Promise((res) => ff.stdin.once('drain', res));
    }
    ff.stdin.end();
    const code = await done;
    await page.close();
    writeFileSync(
      `${CLIPS}/${s.name}.json`,
      JSON.stringify({ shot: s, seconds: au.seconds, times: au.times, showOf }),
    );
    console.log(
      `${s.name}: ${ticks} ticks → ${frames} frames (${au.seconds.toFixed(2)} s), ffmpeg ${code}, ${((Date.now() - t) / 1000).toFixed(0)} s${errors.length ? `, console: ${errors[0]}` : ''}`,
    );
  }
} finally {
  await browser.close();
  await server.close();
}
