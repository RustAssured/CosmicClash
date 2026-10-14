import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import type { Sprite } from '../../src/ui/pixel/canvas';
import { COSMIC_STYLE, cosmicWordmark } from '../../src/ui/pixel/cosmicLogo';
import { logoSprite } from '../../src/ui/pixel/logo';
import { PRESS } from './common';

/**
 * The logotypes on transparency at ×6 and ×12 → press/logo/:
 *  - ADEUK: TITANS (the title screen's own sprite): adeuk-titans-logo-x6/x12.png;
 *  - COSMIC CLASH, the tournament mode's wordmark (src/ui/pixel/cosmicLogo.ts, one still of its loop):
 *    cosmic-clash-logo-x6/x12.png.
 */
function write(name: string, s: Sprite): void {
  for (const k of [6, 12]) {
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
    writeFileSync(`${PRESS}/logo/${name}-x${k}.png`, PNG.sync.write(png));
    console.log(`${name} ×${k}: ${s.w * k}×${s.h * k}`);
  }
}

mkdirSync(`${PRESS}/logo`, { recursive: true });
write('adeuk-titans-logo', logoSprite());
write('cosmic-clash-logo', cosmicWordmark(COSMIC_STYLE, 0));
