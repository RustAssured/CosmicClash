import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { HarnessCamera } from '../../../src/contracts';
import { launch, openGame } from '../../lead/browser';
import { startRenderServer } from '../../render/devserver';
import { arg, query } from '../common';
import { TWORK } from './paths';
import { GAME_SHOTS, type GameShot } from './shots';

/**
 * Shoot the trailer's game shots (docs/site/TRAILER.md, capture rules 1–2): the real game in trailer mode (`trailer=1`:
 * no HUD, overlays or aftermath), AI vs AI on a fixed seed, one sim tick at a time, at exactly 1920×1080 (the 640×360 frame
 * ×3, nearest, full post), 60 fps. Slow motion is render-time interpolation between sim ticks (`renderAt(alpha)`), never
 * held frames; the game's own time-scales (KO slow motion) are honoured the same way. A shot can script the camera
 * (`setCamera`: view centre, zoom, scenery dolly, no shake).
 * → press/trailer/work/<id>.mov (H.264 4:4:4 near-lossless, no sound) + <id>.json (per output frame: tick, alpha, rate)
 *   npx tsx tools/press/trailer/shoot.ts [--only=a,b] [--redo=1]
 */
const only = arg('only', '');
const redo = arg('redo', '0') === '1';
mkdirSync(TWORK, { recursive: true });

/** Piecewise rate (sim ticks per output frame) at a tick; 1 = real time, 0.25 = ×0.25. */
const rateAt = (s: GameShot, tick: number): number => {
  let r = 1;
  for (const [t, v] of s.rate ?? []) if (tick >= t) r = v;
  return r;
};
/** The scripted camera at a tick (keys interpolated linearly, smoothstepped), or null for the game camera. */
const camAt = (s: GameShot, tick: number): HarnessCamera | null => {
  const k = s.cam;
  if (!k || !k.length) return null;
  let a = k[0]!;
  let b = k[k.length - 1]!;
  for (let i = 0; i + 1 < k.length; i++)
    if (tick >= k[i]!.tick && tick <= k[i + 1]!.tick) {
      a = k[i]!;
      b = k[i + 1]!;
    }
  const u = b.tick > a.tick ? Math.min(1, Math.max(0, (tick - a.tick) / (b.tick - a.tick))) : 0;
  const e = u * u * (3 - 2 * u);
  const mix = (p?: number, q?: number): number | undefined =>
    p === undefined ? q : q === undefined ? p : p + (q - p) * (tick <= a.tick ? 0 : e);
  return {
    x: mix(a.x, b.x),
    y: mix(a.y, b.y),
    zoom: mix(a.zoom, b.zoom),
    dolly: mix(a.dolly, b.dolly),
    still: a.still ?? b.still,
  };
};

async function shoot(page: Page, s: GameShot): Promise<void> {
  const now = (await page.evaluate(() => window.__ADEUK__!.summary().tick)) as number;
  if (s.t0 - 1 > now) await page.evaluate((n) => window.__ADEUK__!.step(n), s.t0 - 1 - now);
  await page.evaluate(() => window.__ADEUK__!.step(1));
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
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '8',
      '-pix_fmt',
      'yuv444p',
      `${TWORK}/${s.id}.mov`,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const done = new Promise<number>((res) => ff.on('exit', (c) => res(c ?? 1)));
  const log: { tick: number; alpha: number; rate: number }[] = [];
  let tick = s.t0;
  let p = 0;
  while (tick < s.t1) {
    const native = (await page.evaluate(() => window.__ADEUK__!.timeScale())) as number;
    const rate = rateAt(s, tick) * (s.ignoreNative ? 1 : native);
    const cam = camAt(s, tick + p);
    await page.evaluate(
      ([c, a]) => {
        const h = window.__ADEUK__!;
        h.setCamera(c);
        h.renderAt(a);
      },
      [cam, p] as const,
    );
    const png = await page.screenshot({ type: 'png' });
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
    log.push({ tick, alpha: +p.toFixed(4), rate: +rate.toFixed(4) });
    p += rate;
    while (p >= 1 - 1e-9 && tick < s.t1) {
      await page.evaluate(() => window.__ADEUK__!.step(1));
      tick++;
      p -= 1;
    }
  }
  ff.stdin.end();
  const code = await done;
  writeFileSync(`${TWORK}/${s.id}.json`, JSON.stringify({ shot: s, frames: log }));
  console.log(
    `${s.id}: ticks ${s.t0}–${s.t1} → ${log.length} frames (${(log.length / 60).toFixed(2)} s), ffmpeg ${code}`,
  );
}

const { server, url } = await startRenderServer();
const browser = await launch();
try {
  for (const s of GAME_SHOTS) {
    if (only && !only.split(',').includes(s.id)) continue;
    if (!redo && existsSync(`${TWORK}/${s.id}.json`)) continue;
    const t = Date.now();
    const { page, errors } = await openGame(browser, `${url}/?${query(s.cfg)}&trailer=1&freeze=1&q=2`, {
      width: 1920,
      height: 1080,
    });
    await shoot(page, s);
    await page.close();
    console.log(
      `  ${((Date.now() - t) / 1000).toFixed(0)} s wall${errors.length ? `; console: ${errors.slice(0, 3).join(' | ')}` : ''}`,
    );
  }
} finally {
  await browser.close();
  await server.close();
}
