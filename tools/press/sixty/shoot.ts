import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { launch } from '../../lead/browser';
import { arg } from '../common';
import { takesNeeded, type Take } from './edl';
import { buildMatch } from './scan';
import { TAKES_DIR, cfgOf, schedule } from './takes';

/**
 * "WHAT'S LEFT": shoot the edit's takes in the REAL game (the production build served by `vite preview`, trailer mode: no
 * HUD, overlays or aftermath; frozen clock, one sim tick at a time; the final 640×360 frame read back with
 * `captureLogical`). A Node match runs in lockstep (the same match: checked by hash) for the counters' matter and the
 * held cameras. → press/sixty/takes/<id>.mkv (FFV1, lossless) + <id>.json (per frame: tick, alpha, cells, positions).
 *   npx vite build && npx vite preview --port 4173 --host 127.0.0.1 &
 *   npx tsx tools/press/sixty/shoot.ts [--only=a,b] [--redo=1] [--url=http://127.0.0.1:4173]
 */
const only = arg('only', '');
const redo = arg('redo', '0') === '1';
const url = arg('url', 'http://127.0.0.1:4173');
mkdirSync(TAKES_DIR, { recursive: true });
const LOG = `${TAKES_DIR}/shoot.log`;
const T0 = Date.now();
const log = (s: string): void => {
  appendFileSync(LOG, `[${((Date.now() - T0) / 1000).toFixed(0)}s] ${s}\n`);
  console.log(s);
};

async function open(key: string): Promise<Page> {
  const c = cfgOf(key);
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  page.on('pageerror', (e) => log(`  pageerror: ${e.message}`));
  await page.goto(
    `${url}/?mode=aivai&a=${c.a}&b=${c.b}&stage=${c.stage}&seed=${c.seed}&ai=4&trailer=1&freeze=1&q=1&hud=0&aftermath=0`,
  );
  for (;;) {
    if (await page.evaluate(() => window.__ADEUK__?.ready === true)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return page;
}

async function shoot(page: Page, take: Take, frames: number): Promise<void> {
  const sch = schedule(take, frames);
  const now = (await page.evaluate(() => window.__ADEUK__!.summary().tick)) as number;
  if (sch[0]!.tick > now) await page.evaluate((n) => window.__ADEUK__!.step(n), sch[0]!.tick - now);
  const m = buildMatch(cfgOf(take.key));
  while (m.tick < sch[0]!.tick) m.step();
  const g = (await page.evaluate(() => window.__ADEUK__!.summary())) as { tick: number; hash: number };
  if (g.tick !== m.tick || g.hash !== m.hash()) log(`  WARNING ${take.id}: game ${g.tick}/${g.hash} vs node ${m.tick}/${m.hash()}`);
  const ff = spawn(
    'ffmpeg',
    ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '640x360', '-r', '60', '-i', '-', '-c:v', 'ffv1', `${TAKES_DIR}/${take.id}.mkv`],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const done = new Promise<number>((res) => ff.on('exit', (c) => res(c ?? 1)));
  const meta: { tick: number; alpha: number; cells: number[]; mass: number[]; pos: number[] }[] = [];
  for (const s of sch) {
    while (m.tick < s.tick) {
      m.step();
      await page.evaluate(() => window.__ADEUK__!.step(1));
    }
    const v = m.fighters.map((f) => f.view);
    const cam =
      take.cam === undefined
        ? null
        : take.cam.follow === 'mid'
          ? { x: (v[0]!.x + v[1]!.x) / 2 + (take.cam.dx ?? 0), y: (v[0]!.y + v[1]!.y) / 2 + (take.cam.dy ?? 0), still: take.cam.still }
          : { x: v[take.cam.follow]!.x + (take.cam.dx ?? 0), y: v[take.cam.follow]!.y + (take.cam.dy ?? 0), still: take.cam.still };
    const b64 = (await page.evaluate(
      ([c, a]) => {
        const h = window.__ADEUK__!;
        h.setCamera(c);
        h.renderAt(a);
        const px = h.captureLogical();
        const u8 = new Uint8Array(px.buffer, px.byteOffset, px.byteLength);
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
        return btoa(s);
      },
      [cam, s.alpha] as const,
    )) as string;
    const buf = Buffer.from(b64, 'base64');
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    meta.push({
      tick: s.tick,
      alpha: s.alpha,
      cells: v.map((x) => (x.bodyStats as { cells: number }).cells),
      mass: v.map((x) => +x.bodyStats.massFrac.toFixed(3)),
      pos: v.flatMap((x) => [Math.round(x.x), Math.round(x.y)]),
    });
  }
  ff.stdin.end();
  const code = await done;
  writeFileSync(`${TAKES_DIR}/${take.id}.json`, JSON.stringify({ take, frames: meta }));
  log(`  ${take.id}: ${frames} frames, ticks ${sch[0]!.tick}–${sch[sch.length - 1]!.tick}, ffmpeg ${code}`);
}

const browser = await launch();
try {
  // one page per fight, its takes in tick order (a take that starts before the page's tick gets a fresh page)
  const want = takesNeeded().filter(({ take }) => (!only || only.split(',').includes(take.id)) && (redo || !existsSync(`${TAKES_DIR}/${take.id}.json`)));
  const byKey = new Map<string, { take: Take; frames: number }[]>();
  for (const w of want) byKey.set(w.take.key, [...(byKey.get(w.take.key) ?? []), w]);
  log(`${want.length} takes in ${byKey.size} fights`);
  for (const [key, list] of byKey) {
    list.sort((p, q) => p.take.t0 - q.take.t0);
    let page: Page | null = null;
    for (const { take, frames } of list) {
      const t = Date.now();
      const tick = page ? ((await page.evaluate(() => window.__ADEUK__!.summary().tick)) as number) : Infinity;
      if (!page || tick > take.t0) {
        await page?.close();
        page = await open(key);
        log(`${key}: ready in ${((Date.now() - t) / 1000).toFixed(0)} s`);
      }
      await shoot(page, take, frames);
      log(`  (${((Date.now() - t) / 1000).toFixed(0)} s)`);
    }
    await page?.close();
  }
} finally {
  await browser.close();
}
