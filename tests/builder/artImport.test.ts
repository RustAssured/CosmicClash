import { describe, expect, it } from 'vitest';
import { convert, fillPolygon, keepLargest, type Source } from '../../dev/builder/artImport';
import { decodeCells } from '@/titans/kit/image';

/** A synthetic piece of key art: a pale disc with a violet band and a green streak, on a dark field. */
function art(): Source {
  const w = 200;
  const h = 200;
  const lab = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const r = Math.hypot(x - 100, y - 100);
      const i = (y * w + x) * 3;
      if (r > 80) lab.set([0.1, 0.01, -0.03], i);
      else if (r > 55) lab.set([0.8 + (x % 7) * 0.01, 0.01, 0.03], i);
      else if (Math.abs(y - 100) < 4) lab.set([0.75, -0.15, 0.12], i);
      else lab.set([0.35 + (r / 55) * 0.2, 0.12, -0.12], i);
    }
  return { w, h, lab, rgba: new Uint8ClampedArray(w * h * 4) };
}

describe('key art import', () => {
  it('turns a masked image into one connected body with a solid core, region materials and a vein', () => {
    const src = art();
    const mask = new Uint8Array(src.w * src.h);
    const disc: [number, number][] = [];
    for (let k = 0; k < 64; k++)
      disc.push([100 + Math.cos((k / 64) * Math.PI * 2) * 80, 100 + Math.sin((k / 64) * Math.PI * 2) * 80]);
    fillPolygon(mask, src.w, src.h, disc, 1);
    keepLargest(mask, src.w, src.h);
    const c = convert(src, mask, {
      target: 120,
      materials: 2,
      core: { x: 100, y: 130 },
      coreR: 6,
      kind: 'celestial',
      steps: 6,
      simplify: 0,
      vibrance: 1,
      structure: 0.8,
      veins: 1,
    });
    expect(Math.max(c.w, c.h)).toBe(120);
    const keys = c.materials.map((m) => m.key);
    expect(keys[keys.length - 1]).toBe('core');
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.some((k) => k.startsWith('green'))).toBe(true);
    for (const m of c.materials) expect(m.visual.ramp.length).toBeGreaterThanOrEqual(3);

    const { mat } = decodeCells(c.body);
    const { w, h } = c.body;
    // every material appears, the core disc is solid, and the body is one 4-connected piece
    for (let id = 1; id <= c.materials.length; id++) expect(mat.includes(id), keys[id - 1]).toBe(true);
    const cx = Math.round(c.body.core.x);
    const cy = Math.round(c.body.core.y);
    expect(mat[cy * w + cx]).toBe(c.materials.length);
    const seen = new Uint8Array(w * h);
    const stack = [cy * w + cx];
    seen[stack[0]!] = 1;
    let n = 0;
    while (stack.length) {
      const i = stack.pop()!;
      n++;
      for (const j of [i - 1, i + 1, i - w, i + w])
        if (j >= 0 && j < w * h && mat[j] && !seen[j] && Math.abs((j % w) - (i % w)) <= 1) {
          seen[j] = 1;
          stack.push(j);
        }
    }
    expect(n).toBe(mat.filter((m) => m).length);
  });

  it('refuses an empty mask and a core off the body', () => {
    const src = art();
    const opts = {
      target: 120,
      materials: 2,
      core: { x: 100, y: 100 },
      coreR: 6,
      kind: 'celestial' as const,
      steps: 6,
      simplify: 0,
      vibrance: 1,
      structure: 0.8,
      veins: 0,
    };
    expect(() => convert(src, new Uint8Array(src.w * src.h), opts)).toThrow(/empty/);
    const mask = new Uint8Array(src.w * src.h);
    fillPolygon(
      mask,
      src.w,
      src.h,
      [
        [20, 20],
        [60, 20],
        [60, 60],
        [20, 60],
      ],
      1,
    );
    fillPolygon(
      mask,
      src.w,
      src.h,
      [
        [120, 120],
        [180, 120],
        [180, 180],
        [120, 180],
      ],
      1,
    );
    expect(() => convert(src, mask, { ...opts, core: { x: 2, y: 2 } })).toThrow();
  });
});
