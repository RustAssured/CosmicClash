import { describe, expect, it } from 'vitest';
// The renderer's own CPU twin of its GPU sampler (pure TS): the hit truth must be exactly what it draws.
import { ANGLE_STEPS as RENDER_STEPS, rotSampleAt, rotWinner, type RotPartEx } from '@/render/rotsprite';
import type { DamageShape } from '@/contracts';
import { createMatterWorld } from './index';
import type { Body } from './body';
import { ShapeQ } from './shape';
import { celadonBody, ribbedSlab } from './testing/bodies';
import {
  ANGLE_STEPS,
  RotBox,
  RotHitCache,
  RotMaskCache,
  buildRotMask,
  drawnCell,
  drawnCellAt,
  rotCellAt,
  rotCellAtDirect,
  rotCollect,
  rotCollectDirect,
  rotSolidAt,
} from './rotation';

/**
 * A region body with a quantised rotation is hit EXACTLY where the renderer draws it. The reference is S5's `rotSampleAt`
 * (src/render/rotsprite.ts: the alpha-first sampler of proposal 161, bit-exact CPU twin of the compositor's GLSL, checked on the
 * real GPU in dev/render/verify.ts): for every angle, both facings and every destination pixel of the rotated map, the texel
 * that wins the renderer's vote must be the cell matter says is drawn there (and nothing where matter says nothing), and every
 * sub-pixel point inside that pixel must hit that cell.
 */

function body(kind: 'celadon' | 'slab', facing: 1 | -1, x: number, y: number): Body {
  const tb =
    kind === 'celadon'
      ? celadonBody({ size: 30, seed: 3, x, y, facing })
      : ribbedSlab({ size: 26, seed: 5, x, y, facing });
  const world = createMatterWorld(1);
  return world.core.bodyById[world.createBody(tb.spec).id]!;
}

/** The body as the renderer receives it: its displayed pixels, pivot = the map anchor, mirrored by the sampler for facing -1. */
function asPart(b: Body, step: number): RotPartEx {
  const t = b.transform;
  return { pixels: b.map.pixels, w: b.w, h: b.h, px: t.anchorX, py: t.anchorY, step, facing: t.facing };
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
        let badDirect = 0;
        const box = new RotBox();
        for (let k = 0; k < ANGLE_STEPS; k++) {
          const m = cache.get(k);
          const part = asPart(b, k);
          box.of(b, k);
          expect([box.x0, box.y0, box.w, box.h]).toEqual([m.x0, m.y0, m.w, m.h]);
          for (let v = -2; v < m.h + 2; v++)
            for (let u = -2; u < m.w + 2; u++) {
              const dx = m.x0 + u;
              const dy = m.y0 + v;
              const col = rotSampleAt(part, dx, dy);
              const c = drawnCell(b, m, u, v);
              pixelsChecked++;
              if (col >>> 24 !== 0) drawnPx++;
              if (col >>> 24 === 0 ? c !== -1 : c !== rotWinner.y * b.w + rotWinner.x) bad++;
              // the mask-free query bodies use is bit-identical to the cached mask
              if (drawnCellAt(b, k, box, dx, dy) !== c) badDirect++;
              if (rotCellAtDirect(b, k, box, PX + dx + 0.5, PY + dy + 0.5) !== c) badDirect++;
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
        expect(badDirect).toBe(0);
        expect(cache.builds).toBe(ANGLE_STEPS);
      }
  }, 120_000);

  it('the mask-free query equals the mask on a wounded body (dead cells, cleared pixels, colour ties) at every angle', () => {
    for (const facing of [1, -1] as const) {
      const b = body('slab', facing, 300.6, 200.2);
      const { material, pixels } = b.map;
      // deterministic damage: dead cells, cells whose pixel is cleared but still live, and runs of one colour (vote ties)
      for (let c = 0; c < b.n; c++) {
        const h = Math.imul(c + 7, 2654435761) >>> 0;
        if (h % 11 === 0) material[c] = 0;
        else if (h % 13 === 0) pixels[c] = pixels[c]! & 0x00ffffff;
        else if (h % 5 === 0) pixels[c] = 0xff336699;
      }
      const box = new RotBox();
      let bad = 0;
      let drawn = 0;
      for (let k = 0; k < ANGLE_STEPS; k++) {
        const m = buildRotMask(b, k);
        box.of(b, k);
        for (let v = -1; v < m.h + 1; v++)
          for (let u = -1; u < m.w + 1; u++) {
            const c = drawnCell(b, m, u, v);
            if (c >= 0) drawn++;
            if (drawnCellAt(b, k, box, m.x0 + u, m.y0 + v) !== c) bad++;
          }
      }
      expect(drawn).toBeGreaterThan(50000);
      expect(bad).toBe(0);
    }
  }, 120_000);

  it('the mask-free collect equals the mask collect for every shape kind, both facings, every angle (with the hit memo)', () => {
    const shapes: DamageShape[] = [
      { kind: 'point', x: 300, y: 200, r: 70 },
      { kind: 'point', x: 288, y: 214, r: 11 },
      { kind: 'cone', x: 250, y: 190, dirX: 1, dirY: 0.3, range: 90, halfAngle: 0.6 },
      { kind: 'cone', x: 340, y: 240, dirX: -0.4, dirY: -1, range: 60, halfAngle: 1.2 },
      { kind: 'line', x0: 240, y0: 170, x1: 360, y1: 235, width: 14 },
      { kind: 'ring', x: 300, y: 205, r0: 10, r1: 26 },
      { kind: 'field', x: 310, y: 190, r: 40, falloff: 2 },
    ];
    const q = new ShapeQ();
    for (const facing of [1, -1] as const) {
      const b = body('slab', facing, 300.4, 200.7);
      const stamp = new Uint32Array(b.n);
      const idx = new Int32Array(b.n);
      const wgt = new Float32Array(b.n);
      const idx2 = new Int32Array(b.n);
      const wgt2 = new Float32Array(b.n);
      const memo = new RotHitCache();
      let gen = 1;
      let total = 0;
      for (let k = 0; k < ANGLE_STEPS; k += 3) {
        const m = buildRotMask(b, k);
        const box = new RotBox().of(b, k);
        memo.begin(b, k, box, 0, 0);
        for (const s of shapes)
          for (let pass = 0; pass < 2; pass++) {
            // pass 0 fills the memo, pass 1 reads it back
            q.set(s);
            const n = rotCollect(b, m, q, idx, wgt, stamp, ++gen);
            const n2 = rotCollectDirect(b, k, box, q, idx2, wgt2, stamp, ++gen, memo);
            total += n;
            expect(n2).toBe(n);
            expect(Array.from(idx2.subarray(0, n2))).toEqual(Array.from(idx.subarray(0, n)));
            expect(Array.from(wgt2.subarray(0, n2))).toEqual(Array.from(wgt.subarray(0, n)));
          }
      }
      expect(total).toBeGreaterThan(20000);
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
        // the mask-free collect bodies use: same cells, same weights, same order
        const idx2 = new Int32Array(b.n);
        const wgt2 = new Float32Array(b.n);
        const n2 = rotCollectDirect(b, k, new RotBox().of(b, k), q, idx2, wgt2, stamp, ++gen);
        expect(n2).toBe(n);
        expect(Array.from(idx2.subarray(0, n2))).toEqual(Array.from(idx.subarray(0, n)));
        expect(Array.from(wgt2.subarray(0, n2))).toEqual(Array.from(wgt.subarray(0, n)));
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
