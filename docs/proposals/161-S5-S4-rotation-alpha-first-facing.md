# 161 — S5 + S4 → Lead (contracts): alpha-first vote and `facing` in `contracts/rotation.ts`

**Owner of the change:** Lead (`src/contracts/rotation.ts`). Matter (S4) and the renderer (S5) must stay bit-identical.

## Problem

1. **Colour decides coverage.** The contract's `rotSample` takes the colour majority of the nine sub-samples, with "empty" as one
   more colour. When a body is recoloured (a darkening crack, heat, infection), an edge pixel can flip between drawn and empty,
   so its hit mask changes without any matter being removed. S4 raised this.
2. **`facing` is missing.** The contract text says `facing = −1` mirrors the source about the pivot corner before rotating, but
   `rotSample` takes no facing.

## Change (S4 agreed alpha-first; S5 implemented and verified it)

Replace `rotSample` with the algorithm in `src/render/rotsprite.ts::rotSampleAt`, and add `facing` to `RotPart`:

```ts
export interface RotPart { pixels: Uint32Array; w: number; h: number; px: number; py: number; step: number;
  /** +1 as authored, −1 mirrored about the pivot corner before rotating (texel x' = 2·px − 1 − x). */
  facing?: 1 | -1; }
```

Per destination pixel:
1. Take the nine sub-samples, as today.
2. If `facing === −1`, mirror each sample: `x = 2·px − 1 − x`.
3. **Coverage:** draw the pixel only if at least 5 of the 9 are opaque.
4. **Colour, among the opaque samples only:** the majority colour. Ties keep the centre (if it is opaque), then the first in scan order.

`rotBounds` for a mirrored part uses `px' = w − px`, as `rotBoundsEx` does.

## Verified (S5, headless Edge on the real GPU, D3D11)

- GPU = CPU twin on all 256 angles, alternately mirrored: 0 of 16.8 M pixels differ (`dev/render/verify.ts` §10e).
- The compositor draws `RenderLayer.parts` exactly as the twin, with emissive taken from the winning texel (§10f).
- Coverage is independent of colour at every tested angle (`src/render/rotsprite.test.ts`).
- On one-colour parts the result is identical to today's sampler.
- No new colours, mirrored or not.
- GPU cost of 24 parts of 64 × 96: 0.43 ms. The shader is generated unrolled; the loop form drew a D3D11 "optimization did not
  converge" warning.

## Until it lands

The renderer already draws with the new rule. Matter, still on the old contract function, can disagree by at most a pixel on
multicoloured rotated edges. Please land this before S2 ships region bodies. It is a drop-in copy of `rotSampleAt` /
`rotRasterAt` / `rotBoundsEx` (then I re-export them).
