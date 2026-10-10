import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { logoSprite } from '../../src/ui/pixel/logo';
import { PRESS } from './common';

/** The ADEUK: TITANS logotype (the title screen's own sprite) on transparency at ×6 and ×12. → press/logo/ */
const s = logoSprite();
mkdirSync(`${PRESS}/logo`, { recursive: true });
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
  writeFileSync(`${PRESS}/logo/adeuk-titans-logo-x${k}.png`, PNG.sync.write(png));
  console.log(`logo ×${k}: ${s.w * k}×${s.h * k}`);
}
