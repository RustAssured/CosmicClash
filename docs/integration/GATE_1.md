# GATE 1 — shared foundations

**Status: waiting for WJ's review.** Files are in `docs/gallery/integration/`.

## What's in (committed: 326fbb5 S1, 2e81d3d S5, abd7a78 S3)
- **Unified look (S5).**
  - A 128-colour master palette (the union of 우리's, the Mouth's, the Witness's, the Planet's and the effect ramps; locked
    oracle colours move ≤ 0.0175 OKLab), with an ordered Bayer snap on every titan and effect pixel.
  - One titan sky: upper-left-front, white key, rim `#7fb4ff`, ambient `#141414`.
  - Shared two-pass bloom (σ 3 / 10 px).
  - A one-pixel outline (two on the shadow side) and depth seams.
  - The highlight ceiling.
  - A lit-part foundation (normals and form light) for 우리.
  - On by default; `?unify=0` or the debug overlay switches it off.
- **Shared VFX (S5):** pinpoint and pull ring, stepped star flash, distortion ring, debris, dust. Four weights, keyed on
  `hit.weight`.
- **Blow weight (S1, proposal 171):**
  - hit-stop 40 / 80 / 110 / 230 ms and shake 3 / 6 / 10 / 14 px;
  - a KO is catastrophic;
  - the cap is raised only for catastrophic (D31-5).
- **Debug overlay (S1):** backquote or R3 cycles panel + diagnostics → diagnostics → off. `registerTuning` and
  `registerDiagnostics` for any titan.
- **Planet size (S3):** one config value. WJ picked **220 px**; making the moves and tests correct at that size is in progress.

## Captures
- `unify-before-after.png`: Witness vs Planet, Mausoleum and Shearfield, the same tick of the same fight, classic vs unified.
  - The Planet is lit from the upper left, and both titans are outlined.
  - The Planet's atmosphere glow is smaller (shared bloom).
  - Gold and bone stop below their top step.
  - Some Witness tones dither.
- `vfx-weights.png` / `.webm`: the four weights on a neutral grid.
- `planet-sizes.png`: 121 / 180 / 220 / 260 px.

## Open
- **GPU budget:** one clean run read 4.3–4.7 ms against ≤ 6 ms; it gets re-measured on a quiet machine before Phase 2.
- **One sky in play:** the captures use the one sky, but the game still lights titans per stage until `app.ts` passes the
  sky (proposal 172 §1). It gets wired once WJ approves the look.
- **Sky colours:** S5 picked the rim and ambient from the oracles; WJ can change them.
- **Planet glow:** the shared bloom makes the Planet's atmosphere glow smaller. Keep it or restore it?
