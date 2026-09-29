import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';

/**
 * Write packed-RGBA pixels (see src/contracts/color.ts) to a PNG with nearest-neighbour integer upscaling.
 * `bg` (packed) is composited behind transparent pixels — default a dark space blue so silhouettes read.
 * Builders use this (and read the PNGs back with the Read tool) to LOOK at their pixel art.
 */
export function writePng(
  path: string,
  pixels: Uint32Array,
  w: number,
  h: number,
  scale = 1,
  bg = 0xff1a0c08,
): void {
  const png = new PNG({ width: w * scale, height: h * scale });
  const out = png.data;
  for (let y = 0; y < h * scale; y++) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < w * scale; x++) {
      const sx = Math.floor(x / scale);
      const c = pixels[sy * w + sx]!;
      const a = c >>> 24;
      const o = (y * w * scale + x) * 4;
      const bgc = bg;
      const t = a / 255;
      out[o] = Math.round((c & 255) * t + (bgc & 255) * (1 - t));
      out[o + 1] = Math.round(((c >>> 8) & 255) * t + ((bgc >>> 8) & 255) * (1 - t));
      out[o + 2] = Math.round(((c >>> 16) & 255) * t + ((bgc >>> 16) & 255) * (1 - t));
      out[o + 3] = 255;
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG.sync.write(png));
}

export interface SheetItem {
  pixels: Uint32Array;
  w: number;
  h: number;
}

/** Lay items out left→right in rows of `cols` on a shared grid with `pad` px gutters, upscale, write PNG. */
export function writeContactSheet(
  path: string,
  items: SheetItem[],
  cols: number,
  scale = 2,
  pad = 4,
  bg = 0xff1a0c08,
): void {
  const cw = Math.max(...items.map((i) => i.w));
  const ch = Math.max(...items.map((i) => i.h));
  const rows = Math.ceil(items.length / cols);
  const W = cols * (cw + pad) + pad;
  const H = rows * (ch + pad) + pad;
  const sheet = new Uint32Array(W * H).fill(bg);
  items.forEach((it, n) => {
    const ox = pad + (n % cols) * (cw + pad) + ((cw - it.w) >> 1);
    const oy = pad + Math.floor(n / cols) * (ch + pad) + ((ch - it.h) >> 1);
    for (let y = 0; y < it.h; y++)
      for (let x = 0; x < it.w; x++) {
        const c = it.pixels[y * it.w + x]!;
        const a = c >>> 24;
        if (a === 0) continue;
        if (a === 255) sheet[(oy + y) * W + ox + x] = c;
        else {
          const d = sheet[(oy + y) * W + ox + x]!;
          const t = a / 255;
          const r = Math.round((c & 255) * t + (d & 255) * (1 - t));
          const g = Math.round(((c >>> 8) & 255) * t + ((d >>> 8) & 255) * (1 - t));
          const b = Math.round(((c >>> 16) & 255) * t + ((d >>> 16) & 255) * (1 - t));
          sheet[(oy + y) * W + ox + x] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
        }
      }
  });
  writePng(path, sheet, W, H, scale, bg);
}
