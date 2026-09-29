import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { rgba } from '@/contracts';
import { writeContactSheet, writePng } from './png';

describe('png tools', () => {
  it('writes scaled PNGs with transparent pixels composited over bg', () => {
    const dir = mkdtempSync(join(tmpdir(), 'png-'));
    const px = new Uint32Array([rgba(255, 0, 0), 0, 0, rgba(0, 255, 0)]);
    const p = join(dir, 'a.png');
    writePng(p, px, 2, 2, 3);
    expect(existsSync(p)).toBe(true);
    const img = PNG.sync.read(readFileSync(p));
    expect(img.width).toBe(6);
    expect(img.data[0]).toBe(255);
    const sheet = join(dir, 's.png');
    writeContactSheet(
      sheet,
      [
        { pixels: px, w: 2, h: 2 },
        { pixels: px, w: 2, h: 2 },
      ],
      2,
      2,
    );
    expect(existsSync(sheet)).toBe(true);
  });
});
