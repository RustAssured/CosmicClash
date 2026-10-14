/**
 * The COSMIC CLASH wordmark directions as stills, for WJ to steer (src/ui/pixel/cosmicLogo.ts):
 * docs/gallery/cosmicclash/wordmark-<style>.png (three moments of its life, ×3, with the live badge and 우주 대결) and
 * wordmark-directions.png (all three side by side at ×2).
 *
 *   npx tsx tools/ui/cosmic-wordmark.ts [--out=docs/gallery/cosmicclash] [--count=9]
 */
import { ROSTER } from '@/titans/roster';
import {
  COSMIC_STYLES,
  cosmicWordmark,
  cosmicWordmarkSize,
  drawCosmicBadge,
  drawCosmicWordmark,
  type CosmicStyle,
} from '@/ui/pixel/cosmicLogo';
import { PixelCanvas } from '@/ui/pixel/canvas';
import { C } from '@/ui/pixel/palette';
import { drawText } from '@/ui/pixel/text';
import { writePng } from '../lead/png';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const OUT = opt('out', 'docs/gallery/cosmicclash');
const count = parseInt(opt('count', String(ROSTER.filter((r) => !r.wip).length)), 10);
const BG = 0xff140a06; // the game's ink, as packed ABGR

const LABEL: Record<CosmicStyle, string> = {
  deepfield: 'A  DEEP FIELD',
  nebula: 'B  NEBULA',
  orbit: 'C  ORBIT',
};

/** One direction: its name, three moments (t = 0.3 / 1.7 / 3.1 s), the Korean and the badge. */
function panelOf(style: CosmicStyle): PixelCanvas {
  const { w, h } = cosmicWordmarkSize(style);
  const W = Math.max(w + 24, 250);
  const rowH = h + 6;
  const cv = new PixelCanvas(W, 18 + rowH * 3 + 34);
  cv.rect(0, 0, cv.w, cv.h, BG);
  drawText(cv, LABEL[style], 8, 4, { color: C.gold, font: 'micro', tracking: 1 });
  [0.3, 1.7, 3.1].forEach((t, i) => {
    const s = cosmicWordmark(style, t);
    cv.blit(s, Math.round((W - w) / 2), 16 + i * rowH);
  });
  const y = 16 + rowH * 3 + 2;
  drawText(cv, '우주 대결', W / 2, y, { color: C.celadon, align: 'center', tracking: 2 });
  drawCosmicBadge(cv, W / 2, y + 16, count, 0.2);
  return cv;
}

for (const style of COSMIC_STYLES) {
  const p = panelOf(style);
  writePng(`${OUT}/wordmark-${style}.png`, p.pixels, p.w, p.h, 3, BG);
  console.log(`${OUT}/wordmark-${style}.png  ${p.w}x${p.h} ×3`);
}

// the three side by side, one moment each, as they would sit on a 640×360 screen
{
  const cv = new PixelCanvas(640, 150);
  cv.rect(0, 0, cv.w, cv.h, BG);
  COSMIC_STYLES.forEach((style, i) => {
    const y = 8 + i * 47;
    drawText(cv, LABEL[style], 12, y + 12, { color: C.gold, font: 'micro', tracking: 1 });
    const r = drawCosmicWordmark(cv, 320, y, 1.1, { style });
    drawCosmicBadge(cv, r.x + r.w + 8, y + 12, count, 0.2, 'left');
  });
  writePng(`${OUT}/wordmark-directions.png`, cv.pixels, cv.w, cv.h, 2, BG);
  console.log(`${OUT}/wordmark-directions.png`);
}
