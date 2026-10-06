import { describe, expect, it } from 'vitest';
import { rotRasterMode, rotSampleMaj4, rotWinner, type RotPartEx } from '@/contracts';
import { URI_ORDER } from '@/titans/uri/rig';
import { gate2A, uriRestBodies } from '../../tools/matter/uri2a';
import { createMatterWorld } from './index';
import { RotBox, drawnCell4At } from './rotation';

/**
 * Proposal 174 (S4, Phase 2A): 우리's 4-sample majority rotation (uri/docs/URI_SPEC.md §3) as a second sampler mode of the
 * shared contract, used by the renderer (GLSL twin, dev/render/verify.ts §10f) and by matter's hit masks; and Gate 2A's rest
 * pose from the real matter bodies (S2's loader, src/titans/uri/maps.ts) against the silhouette and the oracle.
 */

/** The parts as the sampler receives them: the bodies' displayed pixels, pivot = the anchor corner (built once). */
const displayed = (() => {
  const world = createMatterWorld(9);
  const ids = uriRestBodies(world, 0, 0);
  const out = new Map<string, { pixels: Uint32Array; w: number; h: number; px: number; py: number }>();
  ids.forEach((id, k) => {
    const b = world.core.bodyById[id]!;
    out.set(URI_ORDER[k]!, {
      pixels: b.map.pixels.slice(),
      w: b.w,
      h: b.h,
      px: b.transform.anchorX,
      py: b.transform.anchorY,
    });
  });
  return out;
})();

function partOf(name: string, step: number, facing: 1 | -1 = 1, wound = false): RotPartEx {
  const d = displayed.get(name)!;
  const pixels = d.pixels.slice();
  // a wounded part: about 9 % of its pixels cleared (dead or not yet redrawn cells), deterministic
  if (wound)
    for (let i = 0; i < pixels.length; i++)
      if (Math.imul(i + 3, 2654435761) >>> 0 < 0x18000000) pixels[i] = 0;
  return { pixels, w: d.w, h: d.h, px: d.px, py: d.py, step, facing };
}

describe('Gate 2A: 우리 at rest, from the real matter bodies', () => {
  it('covers the reference silhouette 100 % with no spill, and draws exactly what the oracle draws at rest', () => {
    const g = gate2A();
    expect(g.silhouette).toBe(77396);
    expect(g.covered).toBe(g.silhouette);
    expect(g.spill).toBe(0);
    expect(g.samePixels).toBe(g.oraclePixels);
    expect(g.sameColour).toBe(g.oraclePixels);
  }, 120_000);
});

describe("proposal 174: the 'majority4' sampler", () => {
  it('copies an unrotated part 1:1 (both facings)', () => {
    for (const name of ['moon', 'fistL', 'domeL'])
      for (const facing of [1, -1] as const) {
        const p = partOf(name, 0, facing);
        let bad = 0;
        for (let y = 0; y < p.h; y++)
          for (let x = 0; x < p.w; x++) {
            const dx = facing === 1 ? x - p.px : p.px - 1 - x;
            const src = p.pixels[y * p.w + x]!;
            if (rotSampleMaj4(p, dx, y - p.py) !== (src >>> 24 === 0 ? 0 : src >>> 0)) bad++;
          }
        expect(bad).toBe(0);
      }
  });

  it("matter's hit mask is the renderer's sampler, pixel for pixel: every 3rd angle, both facings, pristine and wounded", () => {
    let pixels = 0;
    let bad = 0;
    for (const name of ['moon', 'fistR', 'pyL'])
      for (const facing of [1, -1] as const) {
        const pristine = partOf(name, 0, facing);
        const material = new Uint8Array(pristine.w * pristine.h);
        for (let i = 0; i < material.length; i++) material[i] = pristine.pixels[i]! >>> 24 !== 0 ? 1 : 0;
        for (const wound of [false, true])
          for (let step = 0; step < 256; step += 3) {
            const p = partOf(name, step, facing, wound);
            const body = {
              w: p.w,
              h: p.h,
              map: { material, integrity: material, pixels: p.pixels },
              transform: { x: 0, y: 0, anchorX: p.px, anchorY: p.py, facing },
            };
            const box = new RotBox().of(body, step);
            for (let v = -1; v <= box.h; v++)
              for (let u = -1; u <= box.w; u++) {
                const dx = box.x0 + u;
                const dy = box.y0 + v;
                const col = rotSampleMaj4(p, dx, dy);
                const c = drawnCell4At(body, step, box, dx, dy);
                pixels++;
                if (col === 0 ? c !== -1 : c !== rotWinner.y * p.w + rotWinner.x) bad++;
              }
          }
      }
    expect(pixels).toBeGreaterThan(400000);
    expect(bad).toBe(0);
  }, 120_000);

  it('a rotated 우리 body is hit exactly where the sampler draws it (world.solidAt, both facings)', () => {
    for (const facing of [1, -1] as const) {
      const world = createMatterWorld(4);
      const ids = uriRestBodies(world, 300, 200);
      const id = ids[URI_ORDER.indexOf('faR')]!;
      const b = world.core.bodyById[id]!;
      b.transform.facing = facing;
      b.transform.rot = 37;
      b.transform.x += 0.4; // the pivot lands on the rounded world pixel
      const p: RotPartEx = {
        pixels: b.map.pixels,
        w: b.w,
        h: b.h,
        px: b.transform.anchorX,
        py: b.transform.anchorY,
        step: 37,
        facing,
      };
      const PX = Math.round(b.transform.x);
      const PY = Math.round(b.transform.y);
      let bad = 0;
      let drawn = 0;
      for (let dy = -160; dy < 160; dy++)
        for (let dx = -160; dx < 160; dx++) {
          const want = rotSampleMaj4(p, dx, dy) !== 0;
          if (want) drawn++;
          if (world.solidAt(id, PX + dx + 0.5, PY + dy + 0.5) !== want) bad++;
        }
      expect(drawn).toBeGreaterThan(7000);
      expect(bad).toBe(0);
    }
  });

  /** Isolated drawn pixels (no drawn 4-neighbour) and pinholes (empty, all four 4-neighbours drawn). */
  function sparkle(
    px: Uint32Array,
    w: number,
    h: number,
  ): { isolated: number; holes: number; drawn: number } {
    const on = (x: number, y: number): boolean =>
      x >= 0 && y >= 0 && x < w && y < h && px[y * w + x]! >>> 24 !== 0;
    let isolated = 0;
    let holes = 0;
    let drawn = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const n = +on(x - 1, y) + +on(x + 1, y) + +on(x, y - 1) + +on(x, y + 1);
        if (on(x, y)) {
          drawn++;
          if (n === 0) isolated++;
        } else if (n === 4) holes++;
      }
    return { isolated, holes, drawn };
  }

  it('no smear, no sparkle at 30°, 90°, 150° on all 13 parts: source colours only, no new specks or pinholes, area kept', () => {
    const rows: string[] = [];
    for (const name of URI_ORDER)
      for (const step of [21, 64, 107]) {
        const p = partOf(name, step);
        const src = sparkle(p.pixels, p.w, p.h);
        const r = rotRasterMode(p, 'majority4');
        const out = sparkle(r.pixels, r.w, r.h);
        const palette = new Set(Array.from(p.pixels, (c) => c >>> 0));
        let foreign = 0;
        for (const c of r.pixels) if (c >>> 24 !== 0 && !palette.has(c >>> 0)) foreign++;
        rows.push(
          `${name}@${step}: drawn ${out.drawn}/${src.drawn} isolated ${out.isolated}/${src.isolated} holes ${out.holes}/${src.holes}`,
        );
        expect(foreign).toBe(0); // no smear: never a colour the part does not have
        expect(out.isolated).toBeLessThanOrEqual(src.isolated); // no sparkle: no new specks ...
        expect(out.holes).toBeLessThanOrEqual(src.holes); // ... and no pinholes
        // neither erodes nor bloats: area within 3 % (measured +0.7…+2.1 %, the small command moon highest)
        expect(Math.abs(out.drawn - src.drawn)).toBeLessThanOrEqual(src.drawn * 0.03);
      }
    expect(rows.length).toBe(39);
    if (process.env.URI_SPARKLE) console.log(rows.join('\n'));
  }, 120_000);
});
