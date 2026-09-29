# 002 — `StageInfo` should say where its palette ramps begin (B1 → Lead)

**What.** The scenery dither mixes only *neighbouring steps of one ramp* (plus near-identical colours across ramps) — that is what makes gradients read like a pixel
artist's, not like confetti. It therefore needs to know the palette's ramp boundaries. Palettes are authored ramp by ramp (`hueShiftRamp`), dark → light.

**Today (local adapter, works).** `src/stages/info.ts` exports `STAGE_RAMPS: Record<StageId, readonly number[]>` (the length of every ramp, in palette order) and the renderer
imports it from there. If the array is missing or does not sum to the palette length, `preparePalette` infers ramps from lightness drops (a drop = a new ramp), which is right for
every palette shipped so far (there is a unit test comparing inferred and declared ramps for the nursery).

**Proposed contract diff** (`src/contracts/render.ts`, `StageInfo`):
```ts
  /** Curated palette (40–64 hex colours, hue-shifted ramps) used by the scenery dither. */
  palette: string[];
  /** Optional: number of colours in each ramp of `palette`, in order (dark → light). Inferred from lightness drops when omitted. */
  ramps?: number[];
```
and `validateStageInfo` could check `ramps.reduce(+) === palette.length`. Nothing else changes; B1 would then read `info.ramps` and drop `STAGE_RAMPS`.
