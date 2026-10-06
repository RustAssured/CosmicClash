# 174 — S4 → Lead (cc S5, S2): the 4-sample majority rotation as a second sampler mode

**Status:** implemented in the working tree and waiting for approval. It is additive: the Witness and Planet hashes are unchanged.

## Why

우리's parts rotate by the 4-sample majority rule (uri/docs/URI_SPEC.md §3; the oracle's `drawPart` in
uri/src/10_parts_render.js):

- each screen pixel samples the part at 4 sub-positions;
- it is drawn iff at least 2 samples land on matter;
- unrotated parts copy 1:1.

The shared sampler (D27, proposal 161) is the 3×3 alpha-first vote. What is drawn must stay what is hit, so 우리 needs its own
mode in the same contract, used by the renderer and by matter.

## The rule ('majority4')

The sampler works on destination pixel (dx, dy), relative to the destination pivot corner.

- **Sample positions:** the 4 sub-positions are at ((k + ½) / 2) of the pixel, which puts them at quarter offsets.
- **Mapping:** each sample is mapped back with the same Q14 LUT and the same exact biased floor division as the 3×3 mode.
  Destination offsets are in 1/4 px (`ROT4_DEN = 4`). Mirroring and the pivot convention are also the same.
- **Coverage:** the pixel is drawn iff ≥ 2 samples are opaque.
- **Colour:** the (¾, ¾) sample if it is opaque, otherwise the first opaque sample in scan order. This is the oracle's
  `center` rule. The winning texel is reported in `rotWinner`.
- **Step 0:** an exact 1:1 copy.

Angles stay quantised to 256 steps. The oracle rotates by a float angle about a fractional pivot, so rotated pixels differ from
it by at most the 1.4° step and a ≤ 0.5 px pivot rounding. The rest pose is identical.

## Changes

| File | Change |
|---|---|
| `src/contracts/rotation.ts` | `RotMode` (`'vote9'` default \| `'majority4'`), `ROT4_SUB` / `ROT4_DEN`, `rotSampleMaj4`, `rotRasterMode` |
| `src/contracts/render.ts` | `RenderPart.sampler?: RotMode` |
| `src/contracts/matter.ts` | `BodySpec.sampler?: RotMode` |
| `src/render/rotsprite.ts` | GLSL twin `rotSample4GL` (unrolled, integer only), `uniform int uRotMode`, dispatcher `rotSampleModeGL` |
| `src/render/shaders.ts`, `compositor.ts` | the part pass calls `rotSampleModeGL`; `uRotMode` comes from `RenderPart.sampler` (0 when unset) |
| `src/render/rotspritePass.ts` | `draw(..., { mode })` for the verify page |
| `src/matter/rotation.ts`, `body.ts` | `drawn4Core` / `drawnCell4At`. A body created with `sampler: 'majority4'` hit-tests, collects and probes with it; the hit memo and row clipping apply unchanged |
| `src/combat/behaviours/uri.ts` (S2's) | two one-line fields: `sampler: 'majority4'` on 우리's BodySpecs and RenderParts |

## Evidence

**CPU (vitest, `src/matter/rotation4.test.ts`):**

- **1:1 copy at step 0:** 3 parts, both facings.
- **Hit mask = sampler:** matter's hit mask equals the contract sampler pixel for pixel (> 400k pixels). This covers every
  3rd angle, both facings, and pristine and wounded parts.
- **Rotated body:** `world.solidAt` on a rotated 우리 body equals the sampler's coverage.
- **30°, 90° and 150°, all 13 parts:**
  - no colour outside the part's own (no smear);
  - no new isolated specks or pinholes (no sparkle);
  - the area changes by only +0.7 to +2.1 %.

**GPU:** `dev/render/verify.ts` §10f renders the majority4 mode on the GPU and checks it against `rotRasterMode` pixel for
pixel, at all 256 angles, mirrored on odd steps. This needs the Lead's browser run, the same as §10e.
