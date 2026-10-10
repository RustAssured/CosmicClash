import { readFileSync } from 'node:fs';
import { PixelCanvas } from '../../src/ui/pixel/canvas';
import { drawText } from '../../src/ui/pixel/text';
import { writePng } from '../lead/png';
import { launch, openGame } from '../lead/browser';
import { startRenderServer } from '../render/devserver';
import { WORK, arg, cfgKey, query } from './common';
import type { Candidate } from './pick';

/**
 * LOOK before rendering finals: contact sheets of the candidates (press/work/candidates.json or --file), each a row of frames
 * around its anchor (−60, −20, 0, +15, +40 ticks), half size, numbered. → press/work/preview-<n>.png (12 rows per sheet).
 *   npx tsx tools/press/preview.ts [--file=press/work/candidates.json] [--offs=-60,-20,0,15,40] [--cats=ko,uri-break]
 */
const file = arg('file', `${WORK}/candidates.json`);
const offs = arg('offs', '-60,-20,0,15,40').split(',').map(Number);
const cats = arg('cats', '');
const outDir = arg('out', WORK);
let cands = JSON.parse(readFileSync(file, 'utf8')) as Candidate[];
if (cats) cands = cands.filter((c) => cats.split(',').includes(c.cat));
const TW = 320;
const TH = 180;
const LABEL = 14;
const ROWS = 12;

const { server, url } = await startRenderServer();
const browser = await launch();
const rows = new Map<Candidate, Uint32Array[]>();
try {
  const groups = new Map<string, Candidate[]>();
  for (const c of cands) groups.set(cfgKey(c.cfg), [...(groups.get(cfgKey(c.cfg)) ?? []), c]);
  for (const [key, list] of groups) {
    const { page } = await openGame(
      browser,
      `${url}/?${query(list[0]!.cfg)}&freeze=1&aftermath=0&q=1&hud=0&trailer=1`,
      {
        width: 640,
        height: 360,
      },
    );
    const shots = list.flatMap((c) => offs.map((o) => ({ c, t: c.anchor + o }))).sort((a, b) => a.t - b.t);
    for (const s of shots) {
      const now = (await page.evaluate(() => window.__ADEUK__!.summary().tick)) as number;
      if (s.t > now) await page.evaluate((n) => window.__ADEUK__!.step(n), s.t - now);
      const b64 = (await page.evaluate(
        `(() => { const u = window.__ADEUK__.captureLogical(); const b = new Uint8Array(u.buffer, u.byteOffset, u.byteLength); let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return btoa(s); })()`,
      )) as string;
      const full = new Uint32Array(new Uint8Array(Buffer.from(b64, 'base64')).buffer);
      const half = new Uint32Array(TW * TH);
      for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) half[y * TW + x] = full[y * 2 * 640 + x * 2]!;
      const r = rows.get(s.c) ?? [];
      r.push(half);
      rows.set(s.c, r);
    }
    await page.close();
    console.log(`${key}: ${list.length}`);
  }
} finally {
  await browser.close();
  await server.close();
}
for (let sheet = 0; sheet * ROWS < cands.length; sheet++) {
  const part = cands.slice(sheet * ROWS, sheet * ROWS + ROWS);
  const W = TW * offs.length;
  const cv = new PixelCanvas(W, part.length * (TH + LABEL));
  cv.clear(0xff100808);
  part.forEach((c, i) => {
    const y0 = i * (TH + LABEL);
    drawText(
      cv,
      `${sheet * ROWS + i}  ${c.cat}  ${cfgKey(c.cfg)} @${c.anchor}  score ${c.score.toFixed(0)}`,
      4,
      y0 + 1,
      {
        color: 0xffffffff,
      },
    );
    (rows.get(c) ?? []).forEach((f, k) => {
      for (let y = 0; y < TH; y++)
        cv.pixels.set(f.subarray(y * TW, y * TW + TW), (y0 + LABEL + y) * W + k * TW);
    });
  });
  writePng(`${outDir}/preview-${sheet}.png`, cv.pixels, cv.w, cv.h, 1);
  console.log(`${outDir}/preview-${sheet}.png`);
}
