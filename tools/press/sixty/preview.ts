import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { LOGICAL_H, LOGICAL_W, type ViewRect } from '../../../src/contracts';
import { PixelCanvas } from '../../../src/ui/pixel/canvas';
import { drawText } from '../../../src/ui/pixel/text';
import { blitLayers, makeFrame, paintBackdrop } from '../../../dev/titans/blit';
import { buildMatch, type SixtyCfg } from './scan';

/**
 * "WHAT'S LEFT": contact sheets of candidate moments, drawn fast by the software compositor (dev/titans/blit.ts: the game's
 * own layers, no GPU, a stand-in backdrop) so takes can be LOOKED at before the slow real-renderer shoot.
 *   npx tsx tools/press/sixty/preview.ts <list.json> <out.png>
 * list.json: [{ "label": "...", "key": "a-b-stage-seed", "ticks": [t, t, …] }]
 */
interface Cand {
  label: string;
  key: string;
  ticks: number[];
}
const [listPath, out] = process.argv.slice(2);
const list = JSON.parse(readFileSync(listPath!, 'utf8')) as Cand[];
const TW = 320;
const TH = 180;
const cols = Math.max(...list.map((c) => c.ticks.length));
const sheet = new PixelCanvas(cols * TW, list.length * (TH + 12));
sheet.clear(0xff000000);
// group by fight so each is run once, in tick order
const byKey = new Map<string, { row: number; c: Cand }[]>();
list.forEach((c, row) => byKey.set(c.key, [...(byKey.get(c.key) ?? []), { row, c }]));
for (const [key, items] of byKey) {
  const [a, b, stage, seed] = key.split('-');
  const m = buildMatch({ a, b, stage, seed: Number(seed) } as SixtyCfg);
  const shots = items.flatMap(({ row, c }) => c.ticks.map((t, col) => ({ t, row, col }))).sort((p, q) => p.t - q.t);
  for (const s of shots) {
    while (m.tick < s.t && m.phase !== 'matchend') m.step();
    const v0 = m.fighters[0]!.view;
    const v1 = m.fighters[1]!.view;
    const cx = (v0.x + v1.x) / 2;
    const cy = (v0.y + v1.y) / 2;
    const view: ViewRect = { x0: Math.round(cx - LOGICAL_W / 2), y0: Math.round(cy - LOGICAL_H / 2), w: LOGICAL_W, h: LOGICAL_H };
    const frame = makeFrame();
    paintBackdrop(frame);
    blitLayers(frame, [...m.fighters[0]!.renderLayers(view, 1), ...m.fighters[1]!.renderLayers(view, 1), ...m.world.renderLayers(view, 1)], view, 1);
    // half size, nearest
    for (let y = 0; y < TH; y++)
      for (let x = 0; x < TW; x++) sheet.put(s.col * TW + x, s.row * (TH + 12) + 12 + y, frame[y * 2 * LOGICAL_W + x * 2]!);
    drawText(sheet, `${s.t}`, s.col * TW + 4, s.row * (TH + 12) + 14, { color: 0xffffffff, outline: 0xff000000, font: 'micro' });
  }
  for (const { row, c } of items) drawText(sheet, `${c.label}  ${key}`, 4, row * (TH + 12), { color: 0xff9ae6ff, font: 'micro' });
}
const png = new PNG({ width: sheet.w, height: sheet.h });
for (let i = 0; i < sheet.pixels.length; i++) {
  const c = sheet.pixels[i]!;
  png.data.set([c & 255, (c >>> 8) & 255, (c >>> 16) & 255, 255], i * 4);
}
writeFileSync(out!, PNG.sync.write(png));
