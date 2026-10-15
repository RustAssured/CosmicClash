import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { DEFAULT_LIGHTING, type TitanId } from '../../src/contracts';
import { renderPortrait } from '../../src/titans/portrait';
import type { Sprite } from '../../src/ui/pixel/canvas';
import { wordmarkSprite, type WordmarkSize } from '../../src/ui/pixel/wordmark';
import { PRESS } from './common';

/**
 * The wordmark (logo D, src/ui/pixel/wordmark.ts) for the press kit: each size on transparency at ×1, ×3 and ×6.
 * → press/logo/adeuk-titans-wordmark-<size>-x<k>.png
 *   npx tsx tools/press/wordmark.ts
 */
function writePng(path: string, s: Sprite, k: number): void {
  const png = new PNG({ width: s.w * k, height: s.h * k });
  for (let y = 0; y < s.h * k; y++)
    for (let x = 0; x < s.w * k; x++) {
      const c = s.pixels[Math.floor(y / k) * s.w + Math.floor(x / k)]!;
      const o = (y * s.w * k + x) * 4;
      png.data[o] = c & 255;
      png.data[o + 1] = (c >>> 8) & 255;
      png.data[o + 2] = (c >>> 16) & 255;
      png.data[o + 3] = c >>> 24;
    }
  writeFileSync(path, PNG.sync.write(png));
  console.log(`${path}: ${s.w * k}×${s.h * k}`);
}

mkdirSync(`${PRESS}/logo`, { recursive: true });
const portraits = (id: TitanId): Sprite => renderPortrait(id, 1, DEFAULT_LIGHTING);
for (const size of ['large', 'medium', 'small'] as WordmarkSize[])
  for (const k of [1, 3, 6]) writePng(`${PRESS}/logo/adeuk-titans-wordmark-${size}-x${k}.png`, wordmarkSprite(size, portraits), k);
