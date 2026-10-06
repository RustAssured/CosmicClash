/**
 * Drive 우리's locked oracle page headlessly (uri/reference/demos/uri-LOCKED-kinetic-pass.html, through its `window.__K`
 * hook): for each move × opponent side, restore, place the target, settle 4 s at rest, begin the move and step it frame by frame at 60 fps,
 * recording every link, the phase, hitstop and (optionally) the canvas at chosen frames.
 *   npx tsx tools/uri/oracle.ts [--frames=180] [--out=.scratch/uri-oracle] [--shots=0,20,40,...]
 * Writes <out>/<move>-<side>.json ({ target, frames: [{ phase, hs, L: {k: x} }] }) and, with --shots, <move>-<side>-<f>.png.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from '../lead/browser';
import { URI_SIDES } from './sides';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const FRAMES = +opt('frames', '180');
const OUT = opt('out', '.scratch/uri-oracle');
const SHOTS = new Set(opt('shots', '').split(',').filter(Boolean).map(Number));
const MOVES = opt('moves', 'slam,punch,cross,upper').split(',');

mkdirSync(OUT, { recursive: true });
const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.goto(pathToFileURL(resolve('uri/reference/demos/uri-LOCKED-kinetic-pass.html')).href, {
    waitUntil: 'load',
  });
  await page.waitForTimeout(500);
  for (const move of MOVES)
    for (const [side, target] of Object.entries(URI_SIDES)) {
      const frames = await page.evaluate(
        ({ move, target, n }) => {
          const K = (window as unknown as { __K: Record<string, unknown> }).__K as unknown as {
            playing: boolean;
            demo: boolean;
            target: number[];
            restore(): void;
            begin(n: string): void;
            step(dt: number): void;
            readonly cur: { name: string; ph: number } | null;
            readonly hs: number;
            readonly L: Record<string, { x: number; v: number }>;
          };
          K.playing = false;
          K.demo = false;
          K.restore();
          K.target = target;
          // the loop, cores and pylons are not reset by restore(): let everything settle at rest first
          for (let f = 0; f < 240; f++) K.step(1 / 60);
          K.begin(move);
          const PH: Record<string, string[]> = {
            punch: ['load', 'drive', 'follow', 'taper'],
            cross: ['coil', 'release', 'follow', 'taper'],
            slam: ['load', 'rise', 'apex', 'fall', 'follow', 'taper'],
            upper: ['compress', 'launch', 'follow', 'taper'],
          };
          const out: { phase: string | null; hs: number; L: Record<string, number> }[] = [];
          for (let f = 0; f < n; f++) {
            K.step(1 / 60);
            const L: Record<string, number> = {};
            for (const [k, l] of Object.entries(K.L)) L[k] = l.x;
            const c = K.cur;
            out.push({ phase: c ? PH[c.name]![c.ph]! : null, hs: K.hs, L });
          }
          return out;
        },
        { move, target, n: FRAMES },
      );
      writeFileSync(`${OUT}/${move}-${side}.json`, JSON.stringify({ move, side, target, frames }));
      if (SHOTS.size) {
        // replay with screenshots of the canvas at the chosen frames
        await page.evaluate(
          ({ move, target }) => {
            const K = (
              window as unknown as { __K: { restore(): void; target: number[]; begin(n: string): void } }
            ).__K;
            K.restore();
            K.target = target;
            for (let f = 0; f < 240; f++) (K as unknown as { step(dt: number): void }).step(1 / 60);
            K.begin(move);
          },
          { move, target },
        );
        for (let f = 0; f < FRAMES; f++) {
          await page.evaluate(() =>
            (window as unknown as { __K: { step(dt: number): void } }).__K.step(1 / 60),
          );
          if (!SHOTS.has(f)) continue;
          const b64 = await page.evaluate(
            () => (document.getElementById('cvM') as HTMLCanvasElement).toDataURL('image/png').split(',')[1]!,
          );
          writeFileSync(`${OUT}/${move}-${side}-${f}.png`, Buffer.from(b64, 'base64'));
        }
      }
      console.log(`${move}/${side}: ${frames.length} frames`);
    }
} finally {
  await browser.close();
}
