# 177 — S2 → S4, S1, S5: the Witness and 우리 at D34 sizes

**Author:** S2. **Status:** applied in the working tree for review (not committed). D34 (WJ, 2026-10-09): original-like sizes.

## Result

| | before | now |
|---|---|---|
| The Witness | about 272 px (matter 256) | about 180 px (matter 171), `WITNESS_SCALE` = 2/3 |
| 우리 | about 300 px | 200 px, `URI_SCALE` = 2/3 |
| The Planet (S3) | 180 | 121 |

The evidence is in two stills. `docs/gallery/compare/sizes.png` is the game's own render (tools/render/sizes.ts): the Witness vs the Planet, 우리 vs the Planet, the Black Hole vs the Nexus, and the Supernova vs the Asteroid. `docs/gallery/compare/uri-scale.png` shows 우리 today beside 우리 at its game size (tools/uri/scaleshot.ts).

## The Witness (S2's files)

The painter keeps its v3 design constants in "design px" (the 272 px body). It paints at `WITNESS_SCALE`: each output pixel is evaluated at its design point. What must read at the small size is kept in OUTPUT px:
- line, edge and strand widths;
- the arm-cell, plate and seam grain (fewer, bolder cells);
- the orb-eyes and the eye's catchlight.

Everything the painter returns is in output px: regions, pivots, arm joints and widths, and anchors. The behaviour, the kit and the AI reach scale only what belongs to the body:
- the staged wound;
- the drift of severed parts;
- light sizes;
- the halo and blade volumes;
- the shear path.

Beam lengths and blow energies are unchanged, because they are the original game's ranges.

The scale-of-motion spec still passes: Witness body 36/36, parts 9/9. The passover, multibody and witness tests pass.

## 우리: how it is scaled (the choice asked of S2 and S4)

- **(a) Re-run uri/tools/pipeline at 0.66 — rejected.** Python is not available here, and step 4 imports a `rigfit.py` that is not in the folder. Step 3 is a stochastic fit, so it would also change the anatomy WJ locked.
- **(b) Downsample at load — chosen, with rules per field (src/titans/uri/scale.ts).** The asset stays the source of truth. Each part's grids are resampled once, at decode. Each output cell reads a 1.5 × 1.5 source square with area weights:
  - **Silhouette:** a cell is matter where at least half of the square is matter. IoU against the reference silhouette, area-resampled: ≥ 0.95, which is tested.
  - **Lights** (field, civilisation, slit, habitat, crack) win at ≥ 30 % of the cell's matter. A one-pixel light stays one crisp pixel: the count is URI_SCALE² × reference ± 30 %, which is tested.
  - **Crevices** win at ≥ 40 %. Otherwise the cell takes the weighted majority.
  - **Surface and chunk ids** take the weighted majority. ≥ 85 % of each part's chunks survive, which is tested.
  - **Tone, form and normals** take the area mean, with normals renormalised.
  - **Edge distance** is recomputed on the new silhouette, so the outline is one output pixel.
- **Kinetics and damage keep working because the rig and the kinetic system stay in reference px.** They are untouched, so oracle parity holds: the 16 oracle traces still pass. The behaviour maps world = offset + URI_SCALE × reference, and the target goes into the kinetic system as (world − offset) / URI_SCALE. The following are scaled:
  - neck radii and joints;
  - the chain's drift velocities;
  - core radii;
  - pylon exhaust points;
  - diagnostics.

## Edits made in other owners' files (please review)

- **S4, `src/titans/uri/maps.ts`:**
  - `decodeAll(fields, scale)` resamples through scale.ts and builds each map on `uriGridOf(part, scale)`.
  - `uriPartMatter(scale = URI_SCALE)` is cached per scale.
  - `uriPartMatterFrom(fields, scale = URI_SCALE)`.
  - `uriPartMatter(1)` is the asset at reference size. It is now used by `src/titans/portrait.ts`, `tools/matter/uri2a.ts` and my oracle tools (strip, video).
- **S1, `src/ai/controller.ts`:** `URI_CM_ABOVE = 67 * URI_SCALE`. The AI's view of 우리's centre of mass is in world px.
- **S1, `src/ai/moves.ts` (not edited):** `URI_REACH` and `KIT_REACH` (the sweep and halo spread) are now overridden by each move's own `extra.aiReach` (proposal 167), at the D34 scale. They are published in `src/titans/uri/def.ts` and `witnessMoves`. The stand-ins can be dropped.
- **S5, `src/render/uriLive.ts` (not edited):** the loop and orbit follow the core positions and `hotR`, so they scale by themselves. The plume length (16 + 30·th px) and the loop noise amplitudes are still in reference px. Consider × URI_SCALE.

## Not changed

- 우리's tear velocities inside `src/matter/groups.ts` (S4's `TEAR` constants, in oracle px per frame) are not scaled. The pieces fly 1.5× faster relative to the body than in the oracle. S4 may want a per-body scale.
- 우리 scale spec: parts 0/9 both before (URI_SCALE = 1) and after, so this is pre-existing. Body 34/36 after: strike root hf 32 % / 16 %, at sub-pixel amplitude (0.29 / 0.39 px).
