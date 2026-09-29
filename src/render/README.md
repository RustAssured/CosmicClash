# src/render — the pixel pipeline

Owner: B1 (Engine & Render). Three.js (WebGL2) is used as a thin GL wrapper; every pass is our own `RawShaderMaterial` (GLSL ES 3.00). The
palette / dither / viewport / layer-mapping / cache-planning maths lives in files that do **not** import three and is unit-tested in Node.

```ts
import { createRenderer } from '@/render';
const renderer = createRenderer();                       // DebuggableRenderer = Renderer (contracts/render.ts) + debug hooks
await renderer.init(canvas, { quality: 'auto', preserveDrawingBuffer: false });   // 0 | 1 | 2 fixes the tier; 'auto' (default) starts at 1 and adapts
await renderer.prepareStage('nursery', (f) => ui.setLoading(f)); // NON-BLOCKING: builds scenery + palette LUT + shaders in ≈ 5 ms slices over many frames (docs/proposals/004)
renderer.setStage('nursery');                            // the blocking equivalent (tests, tools): builds everything now
renderer.resize(cssW, cssH, devicePixelRatio);           // integer scale, letterboxed; also sets the canvas CSS size
renderer.draw(frame);                                    // one RenderFrame per display frame
renderer.captureLogical();                               // final 640×360 image as packed RGBA, top row first (tests / screenshots)
renderer.stats;                                          // rolling CPU ms per draw(), scenery vs post, draw calls, tier, adaptive-controller state, last stage load
```

## Pipeline (one `draw`)

```
StageScenery.render ─► HDR target (RGBA16F, 640×360 · tier 2: 1280×720 supersample; alpha = occluder opacity)
   │  lens (fx.lenses) ─► box/tent resolve ─► hue-preserving tone map ─► READABILITY GRADE ─► palette dither   (SCENERY_DITHER_FRAG)
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
* **Palette dither** (`palette.ts`, `dither.ts`): the palette is split into *ramps* (`StageInfo.ramps`, or inferred from lightness drops). A 3D LUT (32³/40³/48³ by tier, built once per stage,
  ~70–180 ms) stores, per sRGB node, the best pair (A, B): a single colour, or two **neighbours of one ramp** (or near-identical colours across ramps, OKLab distance ≤ `CROSS_RAMP_MAX` 0.11),
  chosen by OKLab error of the linear-light mix. The shader re-derives the exact ratio per pixel by projecting the true colour on A→B, quantises it to **4 levels** (25 % dots / 50 % checker / 75 %)
  and thresholds against a **4×4 Bayer** matrix locked to the logical pixel grid. Result: deliberate, hand-drawn-looking patterns; no confetti between unrelated hues; no banding.
* **Readability grade** (see below) sits between the tone map and the dither, so the darkening it applies is quantised into the palette like everything else.
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

## Fighter readability

Fighters must read against ANY backdrop (a pale celadon body on a bright nebula, a near-black one on black space). Two things do it, tuned per stage in `SceneryLook` (see `src/stages/README.md`):

* **Sprite halo + contact rim.** The compositor's coverage (alpha of everything drawn from the 2D layers) is blurred (`HALO_BLUR_FRAG`, two separable 9-tap passes, radius `spriteHalo.radius` ≈ 9 px, at half resolution) and used to darken and slightly
  desaturate the *scenery* underneath and around each sprite — capped at `strength` ≈ 24–30 % so it reads as a soft shadow, not a black hole — plus a thin (1–2 px) darker rim just outside the silhouette. Around **dark** bodies the surround is instead lifted to a faint
  backlight floor (`lift`), so a basalt body never sinks into black space. The grade happens before the palette dither, so it costs no extra colours.
* **Fight band.** In the vertical strip where fighters live (`fightBand`: world px around `arena.restY`, feathered) scenery highlights above `ceiling` are compressed toward it (`keep` of the excess survives) — a bright cloud or a god-ray shaft never sits right behind a body.
* **Glow damping.** Bloom and god rays are damped on sprite pixels (`glowDamp`) so glow never washes a sprite's edges out; the glow still spills around it.

`verify.mjs` renders a pale celadon and a near-black basalt body over **every** stage at two arena positions and requires luma contrast (interior vs the surrounding ring) — celadon ≥ 30, basalt ≥ 10 levels; measured 75–144 and 15–40.

## Stage preparation (non-blocking load)

`prepareStage(id, onProgress?)` runs the stage's `prepare` generator (`StageScenery.prepare`: particle fields, GPU bakes, layer creation — it yields at every safe pause point and reports progress) through `runSliced` (`slicer.ts`): ≈ 5 ms of work per animation frame
(`prepareBudgetMs`), waiting for shader compiles off-thread where `KHR_parallel_shader_compile` exists (one layer per frame otherwise), then builds the palette LUT incrementally (`LutBuilder`, sliced too). `draw()` keeps showing the **previous stage** (black
with the 2D layers and UI if there is none) until the new one is ready, then switches in one call — never garbage, never a freeze. Drawing a never-prepared stage starts the job instead of blocking. Contract note: `docs/proposals/004-prepare-stage.md`.
Measured with the nursery (heaviest: 2 pillar bakes) on software GL: 55 progress callbacks over 36 frames, longest slice 35 ms (a single shader compile; ≈ 5 ms elsewhere), 50 frames drawn during the load with the previous stage intact.

## Quality tiers and adaptive quality (`RendererOptions.quality`)

| tier | scenery target | scenery particles | fbm octaves | bloom levels | god-ray taps |
|---|---|---|---|---|---|
| 0 | 640×360 | ×0.45 | −2 | 3 | 16 |
| 1 | 640×360 | ×0.75 | −1 | 4 | 28 |
| 2 (showpiece) | 1280×720 supersampled (4-tap tent) | ×1 | full | 5 | 44 |

One palette LUT resolution (40³) serves every tier so a tier change never rebuilds it. Additive particle clouds draw a prefix of their (randomly ordered) instances and brighten the rest to compensate, and god rays are normalised to the 44-tap reference,
so the picture keeps its look across tiers (mean luminance differs < 0.2 %; verified). **Changing tier is cheap** (0.1–1 ms of CPU: a target resize and a couple of uniforms — no scenery rebuild).

`quality: 'auto'` (default) starts at tier 1 and hands frame timings to a **pure controller** (`quality.ts`, unit-tested with a fake clock): rAF deltas plus, where the browser has `EXT_disjoint_timer_query_webgl2` (`gpuTimer.ts`), the GPU time of the last frame. It steps **down** after two
consecutive ~1.5 s windows with ≥ 20 % late frames, steps **up** only after a long quiet run that leaves predicted GPU headroom (or, with no timer, probes after a long clean run and doubles the delay after a failed probe), never changes more than once per ~3 s,
and ignores hidden tabs / hitches > 5 s and the frames right after a stage switch or resize. `stats.tier`, `auto`, `gpuMs`, `lateRate`, `tierChanges` expose it. In software GL (CI, this sandbox) every frame is late, so it walks to tier 0 and stays: `verify` asserts that.
Contract note: `docs/proposals/005-adaptive-quality.md`. The HDR target is RGBA16F; without renderable float targets it falls back to RGBA8 (less headroom, same output).

## Robustness

* Context loss: logged once (`console.error`), `draw()` becomes a no-op; on restore every GL object is dropped (never `dispose`d — that only spams "object does not belong to this context") and the active stage is re-prepared in the background
  (2D layers keep drawing over black meanwhile); the GPU timer is recreated.
* `RenderFrame.stage` differing from the current stage triggers `setStage` inside `draw`.
* No per-frame allocation in `draw` in our code (the compositor, layer cache, fx packing and scenery frame are preallocated).

## Files

| file | role |
|---|---|
| `renderer.ts` | `createRenderer()`: targets, passes, per-frame orchestration, stage preparation jobs, adaptive quality wiring, present, capture, context loss |
| `shaders.ts` | all GLSL: scenery resolve + readability grade + dither, coverage blur, layer quad, bloom down/up, god rays, post, final |
| `slicer.ts` | time-sliced execution of generators (`runSliced`, `runToEnd`, `scaled`, `animationFrame`) — pure, unit-tested |
| `quality.ts`, `gpuTimer.ts` | the adaptive-quality controller (pure, unit-tested) and the optional GPU timer (`EXT_disjoint_timer_query_webgl2`) |
| `compositor.ts`, `layerTextures.ts`, `layerMap.ts`, `layerCache.ts` | layer draw, GPU texture cache, mapping maths (pure), upload planning (pure) |
| `palette.ts`, `dither.ts`, `viewport.ts` | OKLab palette + LUT builder + CPU reference of the shader decision, Bayer matrices, integer-scale/letterbox (all pure) |
| `gl.ts` | render-target and full-screen-pass helpers |

## Tuning knobs

Per stage (`SceneryLook`, in the scenery): `exposure`, `contrast`, `bloomThreshold/Gain`, `godRayGain/Gas/Halo/Decay`, `vignette`, and the readability trio `spriteHalo`, `fightBand`, `glowDamp` (defaults `DEFAULT_SPRITE_HALO`, `DEFAULT_FIGHT_BAND`, `DEFAULT_GLOW_DAMP`). Global (`renderer.ts` / `shaders.ts`): `TIERS`, `uLevels` (dither patterns, 4),
`uBloomLevels` / vignette levels in `POST_FRAG`, `CROSS_RAMP_MAX` (`palette.ts`), tone-map knee, shockwave displacement (`packFx`), `emisGain`.

## Testing

* `npx vitest run src/render` — palette maths (OKLab, ramp inference, LUT pairs only between ramp neighbours, exact-colour reproduction, dithered tile ≈ target), Bayer matrices, viewport/letterbox maths, layer mapping vs
  the contract over ~100 k pixels, upload planning (dirty rect / full / none / recreate), stale registry.
* `node tools/render/verify.mjs` (needs `npx vite --port 5201 --strictPort`) — **42 GPU checks in a real WebGL2 context** (also run in CI by `e2e/render.spec.ts`): mirror/lean/anchor exact vs `space.ts`, integer placement, normal/additive blending, dirty-rect
  upload counts, no re-upload of unchanged layers, stale free, bloom locality, UI exactness, determinism, shockwave / flash / aberration / lens, zoom+roll leave UI alone, exact integer upscale + letterbox, context loss + restore, god-ray shafts cast by occluders, stage switching, non-blocking preparation (previous stage kept, time-sliced, instant switch), tier switching and adaptive quality, fighter readability on every stage, stage distinctness. `?only=stages` runs just the per-stage checks (≈ 1 min).
* `node tools/render/capture.mjs --stage=rim` — screenshots per stage in eight fight states → `.scratch/render/` (`tools/render/montage.mjs` tiles them into a contact sheet); `node tools/render/perf.mjs [--layers]` — perf report; `npx tsx tools/render/dither-preview.ts` and `palette-sheet.ts` — palette / dither
  on synthetic images without a GPU; `tools/render/layers.mjs` (isolate scenery layers) and `bakes.mjs` (dump baked textures) for art iteration. Sandbox: `dev/render/index.html`.
