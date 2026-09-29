# 001 — Render contract clarifications (B1 → Lead)

Three small things the renderer had to decide because `contracts/render.ts` is silent. None blocks anyone; the renderer already implements the
choice below, so a doc-only contract change is enough. If the Lead prefers the opposite convention, the renderer change is ~10 lines each.

## 1. `FrameFx` positions are WORLD coordinates

`ShockwaveFx`, `LensFx` and `StageImpulseFx` carry `x, y` with no stated space. The renderer treats them as **world coordinates** and converts with the
interpolated integer `frame.view` (`screen = world − view.origin`). Reason: the producing events (`SimEvent` shockwave/hit/ko, `FighterView.x/y`)
are all world-space, and a screen-space fx would slide off its source while the camera glides. `radius`, `horizonR`, and `strength` are in px / unitless as documented.

**Proposed doc diff** (`src/contracts/render.ts`, above `ShockwaveFx`):
```ts
/** All FrameFx positions (x, y) are WORLD coordinates (logical px, +y down); the renderer subtracts the frame's view origin. */
```

## 2. The renderer consumes (and clears) `RenderLayer.dirty`

`RenderLayer.dirty` says "changed-cell rect since last upload". The renderer uploads only that rect (texSubImage2D) when the layer's `version` changed,
uploads the whole layer when `dirty` is `null` or covers ≥ 60 % of it, never re-uploads an unchanged `version`, and **sets `layer.dirty = null` after uploading**
(same rule as `MatterMap.dirty`: "renderer clears it after upload"). A producer that mirrors `map.dirty` into its layer must therefore copy it in (and
clear its own map rect) each `renderLayers()` call, and must bump `layer.version` whenever pixels or emissive change. The cache key is `layer.id`; a layer whose
`w`, `h`, `pixels` or `emissive` array identity changes gets a fresh texture. Layers not drawn for 240 frames are freed.

**Proposed doc diff** (`RenderLayer.dirty`): append "The renderer sets it to null once uploaded."

## 3. `RenderFrame.stage` drives the scenery

`Renderer.draw` switches scenery itself when `frame.stage` differs from the current stage (same cost as `setStage`: ~0.3 s warm, palette LUT + baked pillars).
Call `setStage` ahead of time (e.g. on the stage-select screen) to keep that hitch out of a round start.
