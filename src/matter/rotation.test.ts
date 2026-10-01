import { describe, expect, it } from 'vitest';
// The renderer's own CPU twin of its GPU sampler (pure TS): the hit truth must be exactly what it draws.
import { ANGLE_STEPS as RENDER_STEPS, rotSample, type RotPart } from '@/render/rotsprite';
import { createMatterWorld } from './index';
import type { Body } from './body';
import { ShapeQ } from './shape';
import { celadonBody, ribbedSlab } from './testing/bodies';
import {
  ANGLE_STEPS,
  RotMaskCache,
  buildRotMask,
  drawnCell,
  rotCellAt,
  rotCollect,
  rotSolidAt,
} from './rotation';

/**
 * Rotation spike: a region body with a quantised rotation is hit EXACTLY where the renderer draws it. The reference is S5's
 * `rotSample` (src/render/rotsprite.ts, the bit-exact CPU twin of the GPU clean-edge sampler, checked on the real GPU in
 * dev/render/verify.ts): for every angle, both facings and every destination pixel of the rotated map, the colour it draws must
 * be the colour of the cell matter's cached mask says is drawn there (and nothing where matter says nothing), and every
 * sub-pixel point of a dense grid inside that pixel must hit that cell.
 */

function body(kind: 'celadon' | 'slab', facing: 1 | -1, x: number, y: number): Body {
  const tb =
    kind === 'celadon'
      ? celadonBody({ size: 30, seed: 3, x, y, facing })
      : ribbedSlab({ size: 26, seed: 5, x, y, facing });
  const world = createMatterWorld(1);
  return world.core.bodyById[world.createBody(tb.spec).id]!;
}

/** The body as the renderer receives it: its displayed pixels (mirrored about the pivot for facing -1), pivot = map anchor. */
function asPart(b: Body, step: number): RotPart {
  const { w, h } = b;
  const t = b.transform;
  if (t.facing === 1) return { pixels: b.map.pixels, w, h, px: t.anchorX, py: t.anchorY, step };
  // mirror about the pivot corner: texel x' shows texel 2·anchorX − 1 − x' (texels beyond the map are void)
  const pixels = new Uint32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = 2 * t.anchorX - 1 - x;
      if (sx >= 0 && sx < w) pixels[y * w + x] = b.map.pixels[y * w + sx]!;
    }
  return { pixels, w, h, px: t.anchorX, py: t.anchorY, step };
}

describe('rotation spike: one cached rotated mask per (body, angle) is the hit truth', () => {
  it('uses the renderer quantisation', () => {
    expect(ANGLE_STEPS).toBe(RENDER_STEPS);
  });

  it('at angle 0 the rotated hit-test is exactly the ordinary body hit-test (both facings)', () => {
    for (const facing of [1, -1] as const) {
      const b = body('celadon', facing, 300, 200);
      const m = buildRotMask(b, 0);
      let n = 0;
      let bad = 0;
      for (let wy = 160; wy < 240; wy += 0.37)
        for (let wx = 260; wx < 340; wx += 0.41) {
          n++;
          const ref = b.cellAtWorld(wx, wy);
          const live = ref >= 0 && b.map.material[ref] !== 0;
          if (rotCellAt(b, m, wx, wy) !== (live ? ref : -1)) bad++;
        }
      expect(n).toBeGreaterThan(30000);
      expect(bad).toBe(0);
    }
  });

  it("every pixel and sub-pixel of every angle and both facings hits what the renderer's sampler draws", () => {
    for (const kind of ['celadon', 'slab'] as const)
      for (const facing of [1, -1] as const) {
        const b = body(kind, facing, 410.4, 233.6); // fractional position: the renderer snaps the pivot to a pixel
        const cache = new RotMaskCache(b, 4);
        const PX = Math.round(b.transform.x);
        const PY = Math.round(b.transform.y);
        let pixelsChecked = 0;
        let drawnPx = 0;
        let bad = 0;
        for (let k = 0; k < ANGLE_STEPS; k++) {
          const m = cache.get(k);
          const part = asPart(b, k);
          for (let v = -2; v < m.h + 2; v++)
            for (let u = -2; u < m.w + 2; u++) {
              const dx = m.x0 + u;
              const dy = m.y0 + v;
              const col = rotSample(part, dx, dy);
              const c = drawnCell(b, m, u, v);
              pixelsChecked++;
              if (col >>> 24 !== 0) drawnPx++;
              if (col >>> 24 === 0 ? c !== -1 : c < 0 || b.map.pixels[c] !== col) bad++;
              // a few sub-pixel points of the pixel hit the same cell
              if ((u + v) % 7 === 0)
                for (const [sx, sy] of [
                  [0.05, 0.05],
                  [0.5, 0.5],
                  [0.95, 0.3],
                ] as const) {
                  if (rotCellAt(b, m, PX + dx + sx, PY + dy + sy) !== c) bad++;
                  if (rotSolidAt(b, m, PX + dx + sx, PY + dy + sy) !== c >= 0) bad++;
                }
            }
        }
        expect(pixelsChecked).toBeGreaterThan(500000);
        expect(drawnPx).toBeGreaterThan(100000);
        expect(bad).toBe(0);
        expect(cache.builds).toBe(ANGLE_STEPS);
      }
  }, 120_000);

  it('collect (the input of every damage model) is exactly the set of live cells drawn inside the shape', () => {
    const b = body('celadon', -1, 300, 200);
    const q = new ShapeQ();
    const stamp = new Uint32Array(b.n);
    const idx = new Int32Array(b.n);
    const wgt = new Float32Array(b.n);
    let gen = 1;
    for (let k = 0; k < ANGLE_STEPS; k += 11) {
      const m = buildRotMask(b, k);
      for (const [x, y, r] of [
        [300, 200, 9],
        [286, 190, 14],
        [318, 214, 6],
      ] as const) {
        q.set({ kind: 'point', x, y, r });
        const n = rotCollect(b, m, q, idx, wgt, stamp, ++gen);
        const got = new Set<number>();
        for (let i = 0; i < n; i++) {
          expect(got.has(idx[i]!)).toBe(false);
          got.add(idx[i]!);
          expect(wgt[i]!).toBeGreaterThan(0);
        }
        // brute force over the drawn pixels whose centres the shape covers
        const want = new Set<number>();
        for (let py = Math.floor(y - r) - 1; py <= Math.ceil(y + r) + 1; py++)
          for (let px = Math.floor(x - r) - 1; px <= Math.ceil(x + r) + 1; px++) {
            if (q.weight(px + 0.5, py + 0.5) <= 0) continue;
            const c = rotCellAt(b, m, px + 0.5, py + 0.5);
            if (c >= 0) want.add(c);
          }
        expect([...got].sort((a, c) => a - c)).toEqual([...want].sort((a, c) => a - c));
      }
    }
  });

  it('the silhouette survives rotation: drawn area within the outline band of the live cell count, most cells visible', () => {
    const b = body('slab', 1, 300, 200);
    let live = 0;
    let perim = 0;
    const { material } = b.map;
    for (let c = 0; c < b.n; c++) {
      if (material[c] === 0) continue;
      live++;
      const x = c % b.w;
      if (x === 0 || x === b.w - 1 || c < b.w || c >= b.n - b.w) perim++;
      else if (
        material[c - 1] === 0 ||
        material[c + 1] === 0 ||
        material[c - b.w] === 0 ||
        material[c + b.w] === 0
      )
        perim++;
    }
    let worstVisible = 1;
    for (let k = 0; k < ANGLE_STEPS; k += 4) {
      const m = buildRotMask(b, k);
      let drawn = 0;
      const seen = new Uint8Array(b.n);
      let distinct = 0;
      for (let v = 0; v < m.h; v++)
        for (let u = 0; u < m.w; u++) {
          const c = drawnCell(b, m, u, v);
          if (c < 0) continue;
          drawn++;
          if (!seen[c]) {
            seen[c] = 1;
            distinct++;
          }
        }
      // area is preserved up to the outline (the ≤ 1 px silhouette disagreement of the amended D4) ...
      expect(Math.abs(drawn - live)).toBeLessThanOrEqual(perim);
      worstVisible = Math.min(worstVisible, distinct / live);
    }
    // ... and most cells are drawn (hence hittable) at every angle; rotation skips some (they are hittable at other angles).
    expect(worstVisible).toBeGreaterThan(0.7);
  });
});
