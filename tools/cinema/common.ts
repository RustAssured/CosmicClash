import { createHash } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';

/** Shared bits of the cinema tools: open a timeline in cinema render mode, read frames back, hash them. */
export const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

export interface CinemaFrame {
  shot: string;
  scene: Uint32Array;
  overlay: Uint32Array;
  zoom: number;
  focus: [number, number];
  matter: boolean;
  dutch: number;
}

export async function openCinema(
  browser: Browser,
  url: string,
  name: string,
): Promise<{ page: Page; errors: string[]; frames: number }> {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errors: string[] = [];
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !/Failed to load resource/.test(m.text()))
      errors.push(`[console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.goto(
    `${url}/?cinema=${name}&render=1${process.env.CINEMA_HIDE ? `&hide=${encodeURIComponent(process.env.CINEMA_HIDE)}` : ''}`,
    { waitUntil: 'load' },
  );
  await page.waitForFunction(() => window.__CINEMA__?.ready === true, null, { timeout: 180_000 });
  const frames = (await page.evaluate(() => window.__CINEMA__!.frames)) as number;
  return { page, errors, frames };
}

const u32 = (b64: string): Uint32Array => new Uint32Array(new Uint8Array(Buffer.from(b64, 'base64')).buffer);

export async function readFrame(page: Page, n: number): Promise<CinemaFrame> {
  const r = (await page.evaluate((i) => window.__CINEMA__!.frame(i), n)) as {
    shot: string;
    scene: string;
    overlay: string;
    zoom: number;
    focus: [number, number];
    matter: boolean;
    dutch: number;
  };
  return {
    shot: r.shot,
    scene: u32(r.scene),
    overlay: u32(r.overlay),
    zoom: r.zoom,
    focus: r.focus,
    matter: r.matter,
    dutch: r.dutch,
  };
}

/** SHA-1 of everything that decides a frame's output: scene, overlay, zoom and focus. */
export function frameHash(f: CinemaFrame): string {
  const h = createHash('sha1');
  h.update(new Uint8Array(f.scene.buffer));
  h.update(new Uint8Array(f.overlay.buffer));
  h.update(
    `${f.zoom.toFixed(6)}|${f.focus[0].toFixed(3)},${f.focus[1].toFixed(3)}|${f.matter ? 1 : 0}|${f.dutch}`,
  );
  return h.digest('hex').slice(0, 16);
}
