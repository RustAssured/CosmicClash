/**
 * D34 evidence: 우리 today (the asset at reference size, about 300 px tall) beside 우리 at its game size (URI_SCALE, about
 * 200 px), both at 1:1 on a 640×360 frame and shown ×2, with the 121 px Planet's disc for scale. Each is the matter itself at
 * rest (every part's at-rest colours composited in the draw order; the live cores and loop are the game's live pass).
 *   npx tsx tools/uri/scaleshot.ts [--out=docs/gallery/compare/uri-scale.png]
 */
import { uriPartMatter } from '@/titans/uri/maps';
import { URI_ORDER, URI_PARTS, URI_SCALE } from '@/titans/uri/rig';
import { uriGridOf } from '@/titans/uri/scale';
import { writePng } from '../lead/png';

const out = (
  process.argv.find((a) => a.startsWith('--out=')) ?? '--out=docs/gallery/compare/uri-scale.png'
).slice(6);
const W = 640;
const H = 360;

function frame(scale: number): Uint32Array {
  const img = new Uint32Array(W * H).fill(0xff140c0c);
  // the Planet (121 px) on the right, for scale
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (Math.hypot(x + 0.5 - 545, y + 0.5 - 200) < 60.5) img[y * W + x] = 0xff8a5a2a;
  const parts = new Map(uriPartMatter(scale).map((p) => [p.key, p]));
  // the body's reference centre (200, 170) at screen (240, 190)
  const ox = 240 - Math.round(200 * scale);
  const oy = 190 - Math.round(170 * scale);
  for (const k of URI_ORDER) {
    const g = uriGridOf(
      URI_PARTS.find((p) => p.key === k)!,
      scale,
    );
    const m = parts.get(k)!.map;
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        if (!m.material[i]) continue;
        const X = ox + g.x0 + x;
        const Y = oy + g.y0 + y;
        if (X >= 0 && Y >= 0 && X < W && Y < H) img[Y * W + X] = m.baseColor[i]! | 0xff000000;
      }
  }
  return img;
}

const a = frame(1);
const b = frame(URI_SCALE);
const sheet = new Uint32Array(W * 2 * H);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    sheet[y * W * 2 + x] = a[y * W + x]!;
    sheet[y * W * 2 + W + x] = b[y * W + x]!;
  }
writePng(out, sheet, W * 2, H, 2);
console.log(`saved ${out} (left: today, the asset at 1:1; right: URI_SCALE ${URI_SCALE.toFixed(3)})`);
