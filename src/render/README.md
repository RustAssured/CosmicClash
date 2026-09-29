# src/render — the pixel pipeline

Owner: B1 (Engine & Render). Three.js (WebGL2) is used as a thin GL wrapper; every pass is our own `RawShaderMaterial` (GLSL ES 3.00). The
palette / dither / viewport / layer-mapping / cache-planning maths lives in files that do **not** import three and is unit-tested in Node.

```ts
import { createRenderer } from '@/render';
const renderer = createRenderer();                       // DebuggableRenderer = Renderer (contracts/render.ts) + debug hooks
await renderer.init(canvas, { quality: 2, preserveDrawingBuffer: false });
renderer.setStage('nursery');                            // builds scenery + the stage's palette LUT (warm ≈ 0.3 s; do it on the stage screen)
renderer.resize(cssW, cssH, devicePixelRatio);           // integer scale, letterboxed; also sets the canvas CSS size
renderer.draw(frame);                                    // one RenderFrame per display frame
renderer.captureLogical();                               // final 640×360 image as packed RGBA, top row first (tests / screenshots)
renderer.stats;                                          // rolling CPU ms per draw(), scenery vs post, draw calls
```

## Pipeline (one `draw`)

```
StageScenery.render ─► HDR target (RGBA16F, 640×360 · tier 2: 1280×720 supersample; alpha = occluder opacity)
   │  lens (fx.lenses) ─► box/tent resolve ─► hue-preserving tone map ─► palette dither      (SCENERY_DITHER_FRAG)
   ▼
frameRT [MRT] colour(+occlusion α) · emissive        ◄── 2D layers, z-sorted, nearest, integer positions  (LayerCompositor)
   ├─► bloom: dual-filter pyramid (3/4/5 levels from the emissive attachment) ─► half-res, dithered add
   ├─► god rays: radial march (16/28/44 taps) toward the stage light, occluded by layer + dust alpha
   ▼
post @ 640×360: shockwave refraction ─► chromatic aberration ─► + bloom + rays ─► vignette ─► grain ─► flash
   ▼
final @ canvas: nearest integer upscale + micro-zoom + roll (camera) ─► UI layer composited last, un-zoomed, never bloomed
```

* **Scenery is dithered, layers are not.** Titans/debris/particles keep their own colours; only the 3D backdrop is quantised into the stage palette.
* **Palette dither** (`palette.ts`, `dither.ts`): the palette is split into *ramps* (`STAGE_RAMPS`, or inferred from lightness drops). A 3D LUT (32³/40³/48³ by tier, built once per stage,
  ~70–180 ms) stores, per sRGB node, the best pair (A, B): a single colour, or two **neighbours of one ramp** (or near-identical colours across ramps, OKLab distance ≤ `CROSS_RAMP_MAX` 0.11),
  chosen by OKLab error of the linear-light mix. The shader re-derives the exact ratio per pixel by projecting the true colour on A→B, quantises it to **4 levels** (25 % dots / 50 % checker / 75 %)
  and thresholds against a **4×4 Bayer** matrix locked to the logical pixel grid. Result: deliberate, hand-drawn-looking patterns; no confetti between unrelated hues; no banding.
* **Tone map** keeps hue below a 0.72 knee (colours authored on a ramp stay on it), soft shoulder above it, and bleeds very bright light toward white.
* **Bloom / rays / vignette are pixel-art too:** their contribution is quantised with the same Bayer matrix (14 / 12 levels) instead of adding smooth gradients over crisp pixels.
* **Grain** is pixel-sized and tick-locked (`frame.tick`), so identical frames render identically (checked in `verify`).

## Layer semantics (`RenderLayer`, contracts/render.ts)

* Sorted by `z` (stable); ≤ 48 layers per frame. `visible = false`, `alpha ≤ 0` or an off-screen destination rect cost nothing.
* `space: 'world'` → drawn at `round(lerp(prev, cur, alpha)) − view.origin` (a jump > 96 px per tick is treated as a teleport and not interpolated). Mirror (`facing`), row shear (`lean`) and
  anchor are evaluated per pixel in the shader with exactly the arithmetic of `contracts/space.ts` (`layerMap.ts` is the CPU twin; the GPU is checked against the *contract* pixel for pixel).
* `space: 'screen'` → exactly 640×360, drawn 1:1. `frame.ui` is a screen layer composited after post at logical res (crisp, never bloomed / aberrated / zoomed).
* `emissive` (R8, same dims) → bloom source = `pixel colour × emissive/255 × 1.5`. Layers without it do not glow. `blend: 'add'` layers add colour and never occlude god rays.
* Textures wrap the layer's own typed arrays (no copies). Cache key = `layer.id`; **unchanged `version` ⇒ nothing uploaded**; a changed `version` uploads only the `dirty` rect
  (`texSubImage2D` with `UNPACK_ROW_LENGTH`) or the whole layer if `dirty` is null / ≥ 60 % of it; `layer.dirty` is set to `null` after upload (see docs/proposals/001). A layer whose size or
  backing arrays change gets a new texture; layers not drawn for 240 frames are freed.

## `FrameFx` (contracts/render.ts)

Positions are **world** coordinates (converted with the frame's view). Shockwaves refract everything composited so far (ring width grows with radius) *and* push the scenery; impulses swirl and warm
the scenery; lenses (≤ 4) bend the **scenery only** (Einstein-ring mapping, θE = 0.9…1.8 × `horizonR`); `flash` whitens; `aberration` widens the chromatic fringe; `intensity` brightens the scene, tightens the
stage and speeds its flow; `timeScale` slows the scenery clock with the sim (KO slow-mo). Limits: 8 shockwaves, 6 impulses, 4 lenses.

## Quality tiers (`RendererOptions.quality`)

| tier | scenery target | scenery particles | bloom levels | god-ray taps | LUT |
|---|---|---|---|---|---|
| 0 | 640×360 | ×0.4 | 3 | 16 | 32³ |
| 1 | 640×360 | ×0.7 | 4 | 28 | 40³ |
| 2 (showpiece) | 1280×720 supersampled (4-tap tent) | ×1 | 5 | 44 | 48³ |

The HDR target is RGBA16F; without renderable float targets it falls back to RGBA8 (less headroom, same output).

## Robustness

* Context loss: logged once (`console.error`), `draw()` becomes a no-op; on restore every GL object is dropped (never `dispose`d — that only spams "object does not belong to this context") and rebuilt.
* `RenderFrame.stage` differing from the current stage triggers `setStage` inside `draw`.
* No per-frame allocation in `draw` in our code (the compositor, layer cache, fx packing and scenery frame are preallocated).

## Files

| file | role |
|---|---|
| `renderer.ts` | `createRenderer()`: targets, passes, per-frame orchestration, present, capture, context loss |
| `shaders.ts` | all GLSL: scenery resolve+dither, layer quad, bloom down/up, god rays, post, final |
| `compositor.ts`, `layerTextures.ts`, `layerMap.ts`, `layerCache.ts` | layer draw, GPU texture cache, mapping maths (pure), upload planning (pure) |
| `palette.ts`, `dither.ts`, `viewport.ts` | OKLab palette + LUT builder + CPU reference of the shader decision, Bayer matrices, integer-scale/letterbox (all pure) |
| `gl.ts` | render-target and full-screen-pass helpers |

## Tuning knobs

Per stage (`SceneryLook`, in the scenery): `exposure`, `contrast`, `bloomThreshold/Gain`, `godRayGain/Gas/Halo/Decay`, `vignette`. Global (`renderer.ts` / `shaders.ts`): `TIERS`, `uLevels` (dither patterns, 4),
`uBloomLevels` / vignette levels in `POST_FRAG`, `CROSS_RAMP_MAX` (`palette.ts`), tone-map knee, shockwave displacement (`packFx`), `emisGain`.

## Testing

* `npx vitest run src/render` — palette maths (OKLab, ramp inference, LUT pairs only between ramp neighbours, exact-colour reproduction, dithered tile ≈ target), Bayer matrices, viewport/letterbox maths, layer mapping vs
  the contract over ~100 k pixels, upload planning (dirty rect / full / none / recreate), stale registry.
* `node tools/render/verify.mjs` (needs `npx vite --port 5201 --strictPort`) — **28 GPU checks in a real WebGL2 context**: mirror/lean/anchor exact vs `space.ts`, integer placement, normal/additive blending, dirty-rect
  upload counts, no re-upload of unchanged layers, stale free, bloom locality, UI exactness, determinism, shockwave / flash / aberration / lens, zoom+roll leave UI alone, exact integer upscale + letterbox, context loss + restore, stage switching.
* `node tools/render/capture.mjs` — screenshots per stage in eight fight states → `.scratch/render/`; `node tools/render/perf.mjs [--layers]` — perf report; `npx tsx tools/render/dither-preview.ts` and `palette-sheet.ts` — palette / dither
  on synthetic images without a GPU; `tools/render/layers.mjs` (isolate scenery layers) and `bakes.mjs` (dump baked textures) for art iteration. Sandbox: `dev/render/index.html`.
