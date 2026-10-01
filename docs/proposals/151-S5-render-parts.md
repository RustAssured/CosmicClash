# 151 — S5 → Lead (contracts) and S4 (matter): `RenderLayer.parts` and the shared rotation LUT

**Owners of the change:** Lead (`src/contracts`), S4 (`src/matter`: rotated hit masks), S5 (`src/render`: drawing).
**Requested by:** S5, after the Phase 1 rotation spike (SLICE_PLAN §4.1, D27: rig regions rotate by quantised angles; hit truth =
the mask the renderer samples; ≤ 1 px silhouette disagreement, tested).

## What the spike proved (Phase 1, measured)

| Check | Result | Where |
|---|---|---|
| GPU clean-edge sampler = CPU twin, every destination pixel, all 256 angles (256 × 256 px each, 16.8 M pixels) | **0 mismatches** | `dev/render/verify.ts` §10e, headless Edge on the real GPU (ANGLE/D3D11, Vega 7) |
| Silhouette vs the exact rotated rectangle, all 256 angles | every disagreement ≤ 1 px from the true edge; area within ± 3 % | `src/render/rotsprite.test.ts` |
| No invented colours (palette-safe), angle 0 = source, 90° steps = exact transposes | yes | `src/render/rotsprite.test.ts` |
| GPU cost, 24 parts of 64 × 96 px per frame (≈ a Witness rig: 4 arms × 3 segments + body regions) | **1.70 ms** (timer query) | §10e |
| CPU twin, one 64 × 96 mask | **1.34 ms** (one-off per body and angle; cache it) | §10e |

## The sampler (`src/render/rotsprite.ts`, pure TS)

- `ANGLE_STEPS = 256` per turn (1.406°; at a 90 px radius one step moves the rim ≈ 2.2 px). The LUT holds **Q14 integer cos/sin**,
  exact at the quadrants. The GPU receives the integer pair as a uniform, so nothing transcendental runs on it.
- Each destination pixel takes **3 × 3 sub-samples**. Each is mapped back with integer arithmetic (exact floor division, biased
  positive), and the pixel keeps the **majority colour** (ties → the centre sample). The result has no new colours, no
  single-pixel spurs or holes on rotated edges, and is exact at 0° and on 90° steps.
- A part's pivot is a pixel **corner** `(px, py)` in its source, drawn at a destination pixel corner. Positive steps are
  clockwise on screen (y down).
- `rotSample(part, dx, dy)` is the per-pixel twin, `rotRaster(part)` the whole mask over `rotBounds(part)`, and `ROTSPRITE_GLSL`
  the shader twin (`rotSampleGL`).

## Proposed contract (Lead)

1. **Move `src/render/rotsprite.ts` (minus `ROTSPRITE_GLSL`) to `src/contracts/rotation.ts`.** Matter is pure and may not
   import `src/render`. Then S4's rotated mask and the renderer run the same function. The renderer keeps the GLSL twin and
   its parity test.
2. Add `BodyTransform.rot?: number` = the quantised step (0..255), not radians, so sim and render can never disagree.
3. Add `RenderLayer.parts?: RenderPart[]` (absent = today's behaviour):

```ts
export interface RenderPart {
  /** Sub-rectangle of the layer's pixels holding this part (layer-local cells). */
  sx: number; sy: number; sw: number; sh: number;
  /** Pivot corner inside the sub-rect, and where it lands in WORLD px (integer). */
  px: number; py: number;
  wx: number; wy: number;
  /** Quantised angle step, 0..ANGLE_STEPS−1 (clockwise). */
  step: number;
  /** Draw order inside the layer (low first). */
  z: number;
}
```

The renderer draws each part with the rotated sampler, and its emissive with the same mapping. `facing` mirrors before rotation.
Row-shear `lean` does not apply to parts: whole bodies keep lean, regions rotate (amended D4).

## S4 alignment

- Hit masks: `rotRaster({ pixels: maskAsColours, w, h, px, py, step })` gives exactly the drawn coverage. Treat a non-zero
  pixel as solid. Cache one mask per (body, step): about 1.3 ms to build for a 64 × 96 region; build it lazily when a region
  first reaches a step.
- If you need sub-step physics angles, keep them in the sim, but draw and hit-test the rounded step (`angleToStep`).
- Changing `ANGLE_STEPS` changes the LUT and every cached mask, so keep it in one place: the contract.

## Not done in Phase 1

The compositor does not draw `parts` yet: the spike pass is `src/render/rotspritePass.ts`, used only by verification. Wiring
it in is about one day once the contract lands. Each part is one instanced quad, using the layer textures already uploaded.
