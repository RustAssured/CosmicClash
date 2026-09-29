# BUILDER 1 — ENGINE & RENDER

Read `docs/briefs/COMMON.md` first. **You own:** `src/engine/`, `src/render/`, `src/stages/`, `dev/render/`, `tools/render/`.
Your tests live beside your code (`*.test.ts`). You may use `three` and browser APIs. Port **5201**.

## Mission
Make the universe. A fixed-tick engine with heavy, cinematic camera; a Three.js scenery renderer that draws real 3D nebulae/galaxies/dust
at **640×360**, dithers them into curated palettes, composites the 2D pixel layers the other modules hand you, runs bloom / god rays /
Black Hole lensing / shockwave refraction / chromatic aberration / grain / vignette, and integer-upscales it all crisply.
**The bar is higher than a previous film built on this exact pipeline whose 3D particle galaxies and nebulae were dithered into palettes: finer detail,
richer lighting, more life.** A player must be able to screenshot any frame and want to frame it.

## Contracts you implement (see `src/contracts/render.ts`)
- `Renderer` (`createRenderer(): Renderer` exported from `src/render/index.ts`): `init(canvas, opts)`, `setStage(id)`, `draw(frame: RenderFrame)`, `resize(cssW, cssH, dpr)`,
  `stats`, `captureLogical()`, `dispose()`.
- `CameraApi` (`createCamera(): CameraApi` from `src/engine/index.ts`).
- Fixed-timestep loop (`src/engine/loop.ts`), see below.
- `STAGES: Record<StageId, StageInfo>` and `createScenery(id)` / `isStageImplemented(id)` from `src/stages/index.ts`.

## 1. Engine (`src/engine`)
**Loop** — `createLoop({ tick: () => void, frame: (alpha, dtSec) => void, tickHz = 60 })`: rAF-driven accumulator. Requirements: `timeScale` (0.05…1, set by the app for KO
slow-mo — ticks/second scale, **never** a variable dt in the sim); max 5 catch-up ticks per frame then drop the remainder (no spiral of death); tab-hidden pause/resume without a burst
of ticks; `alpha ∈ [0,1)` for render interpolation; manual `stepTicks(n)` and `pause()/resume()` for the deterministic harness; injectable clock so it is unit-testable in Node;
rolling `msPerTick`, `msPerFrame`, `ticksPerFrame` stats (use `performance.now` here — engine is allowed browser APIs).

**Camera** — `createCamera()`. Feels like a huge, heavy crane, not a webcam:
- Framing: target = weighted midpoint of the two fighters (lean the weight toward the fighter who is *moving/attacking*), lookahead along mean velocity, clamped to the arena;
  no zoom-out (fighters are tethered by the sim, see DECISIONS D5). Vertical follow is gentler than horizontal.
- Motion: critically-damped (or slightly under-damped) springs with long half-lives (~0.3–0.5 s horizontal) so the camera *arrives late* — the universe moves with them.
- Events (`SimEvent`): `shake` → low-frequency (5–9 Hz) damped oscillation with directional bias (amplitude in px, decays ~0.4 s; **integer-snapped at sample time** so pixels never shimmer);
  `zoom` → micro-zoom pulse (peak ≤ 1.06, eased back over ~0.25 s); `roll` → |roll| ≤ 1.5° total; `ultimate` phase start/end → optional `focus` handled via `CameraTargets.focus`.
  `hit` events with high `energy`/`heavy` add proportional shake automatically if the fighters didn't emit one (defensive).
- `sample(alpha)` returns interpolated `CameraState` + integer `ViewRect` (`x0,y0` ints; `w=640,h=360`), clamped inside the arena.
- Pure & deterministic (no time source; advanced by `tick()`); unit-test spring convergence, clamping, integer snapping, shake decay, roll bound.

## 2. Renderer (`src/render`)
Three.js (WebGL2). Suggested pipeline — you may improve it, but keep these guarantees:
1. **Scenery pass:** `StageScenery` renders 3D into a render target at logical res (you may supersample 2× and box-filter down *before* the dither if it helps thin structures).
2. **Palette + dither pass:** quantise into the stage's curated palette (StageInfo.palette, 40–64 hex colours in hue-shifted ramps). Ordered Bayer (8×8/16×16) or blue-noise;
   perform matching in a perceptual space (OKLab or similar; build a 3D LUT on the CPU when the stage loads). Aim for clean, deliberate pixel-art dithering — gradients that look
   *drawn*, not banded, not noisy. Precompute what you can; keep the shader cheap. Pure palette/LUT/dither-matrix code lives in files that don't import three, and is unit-tested.
3. **Lensing (scenery only):** `frame.fx.lenses` — screen-space gravitational lensing of the scenery around each `LensFx` (Einstein ring, mirrored/warped stars near the horizon).
   The Black Hole's own sprite is drawn by combat; you only bend what's behind it.
4. **2D layer compositor:** all `RenderLayer`s sorted by `z`. `space:'world'` layers: draw at the integer pixel position `round(lerp(prev,curr,alpha) − view.origin)`, honour
   `anchorX/Y`, `facing` (mirror around the anchor) and `lean` (integer per-row shear via `leanShift` in `contracts/space.ts` — implement identically in the shader; a test should compare
   against the contract function), nearest filtering, `alpha`, `blend: 'add'|'normal'`. `space:'screen'` layers are exactly 640×360 and drawn 1:1. Upload textures via `DataTexture`/`texSubImage2D`
   using `layer.dirty` rect and `layer.version` (do **not** re-upload unchanged layers; do **not** allocate per frame). Cache textures by layer id; free stale ones.
5. **Emissive/bloom:** `layer.emissive` (0..255) feeds bloom (MRT or a second target). Bloom at logical/half resolution so glow reads as chunky pixels; tasteful, additive, colour-preserving.
6. **God rays** from `StageInfo.lighting.screenPos` (radial blur) **occluded by the 2D layers' alpha** (titans/debris cut the shafts). **Shockwave refraction:** `frame.fx.shockwaves` → radial ring
   displacement of everything composited so far. **Chromatic aberration** (subtle, grows with `fx.aberration` and screen edge), **film grain** (tiny, temporal, pixel-sized), **vignette**, `fx.flash`.
7. **UI:** `frame.ui` (screen-space, 640×360) is composited *after* post at logical res — crisp, never bloomed or aberrated.
8. **Upscale:** integer scale (largest that fits × devicePixelRatio, ≥1), letterboxed, nearest. `camera.zoom` (micro-zoom) and `camera.roll` are applied in this last nearest-neighbour
   step (accept the classic uneven-pixel look for 0.2 s pulses). Canvas CSS size follows `resize`.
9. `captureLogical()` returns the final 640×360 image as packed RGBA (top row first) for tests/screenshots. `preserveDrawingBuffer` only when `opts.preserveDrawingBuffer`.
10. No console errors/warnings from three or GL (e.g. no feedback loops, no un-disposed textures). Handle context loss gracefully (log once, try restore).

Performance: target ≤ 16 ms CPU+GPU on a mid-range laptop; in this sandbox only software GL exists (SwiftShader) so report both **CPU ms/draw (`renderer.stats`)** and wall ms/frame, at 1280×720 viewport.
Provide quality tiers (`RendererOptions.quality` 0/1/2) that scale particle counts / raymarch steps / bloom taps; tier 2 is the showpiece.

## 3. Stages (`src/stages`)
`STAGES` must contain **all five** `StageInfo`s **immediately** (other builders depend on `lighting` and `arena`): write `src/stages/info.ts` FIRST (within your first steps) with final-quality palettes and lighting.
Starting points (tune freely, keep unit-length `dir`, palette 40–64 colours in **hue-shifted ramps** — validated by `validateStageInfo` in `contracts/validate.ts`, run it in a test):
1. `nursery` **Stellar Nursery** 별의 요람 — magenta/amber; key `#ffb36b` from upper-left-back (`dir ≈ [-0.55,-0.55,0.63]`), ambient `#3b1d4a`, rim `#ff5fb0`.
2. `rim` **Galactic Rim** 은하의 끝 — teal/gold; a rotating 3D spiral galaxy behind; key `#ffe2a8` from the galactic core side (right-back), ambient `#0f2a3a`, rim `#5fd6c4`.
3. `redgiant` **Red Giant's Wake** 붉은 거성의 잔영 — ember red/orange/violet; planetary-nebula rings around a dying sun; key `#ff7a3c` from top, ambient `#2a0f18`, rim `#ffb35f`.
4. `quasar` **Quasar Void** 퀘이사 공허 — near-black sky, ice-blue/violet relativistic jets; key `#bfd8ff` from top-right, ambient `#050814`, rim `#7aa8ff`.
5. `tussenruimte` **Tussenruimte** 틈 — celadon & black, stillness; distant galaxies, sparse dust; key `#a8bdb2` (soft, low), ambient `#070b0a`, rim `#d8efe4`.
All use the default arena (`DEFAULT_ARENA`) unless you have a reason.

`StageScenery` (your interface, in `src/stages/types.ts`): `init(gl-context stuff)`, `update(fx: FrameFx, cam: CameraState, dtSec, timeSec)`, `render(target)`, `dispose()`.
Three.js scene per stage with: deep parallax (≥5 depth layers responding to `camera.x/y`), **volumetric-feeling particle nebulae** (tens of thousands of soft additive sprites with noise-driven colour and
curl-noise motion, layered slabs, maybe a low-res raymarched fbm fog at tier 2), dust, stars with subtle twinkle, ambient life (comets, distant supernova flickers), and **reaction to the fight**:
nebulae swirl faster/tinted after `impulses`/`shockwaves`, dust sheets ripple, starlight bends near `lenses`, overall `intensity` brightens/tightens the scene. Scenery time follows `fx.timeScale` (KO slow-mo).

**This phase: implement Stage 1 (Stellar Nursery) to showpiece quality**: towering dust pillars (Pillars-of-Creation feel) sculpted from many particles with lit rims facing the key light, newborn blue-white stars with
glow and diffraction hints, magenta/amber emission clouds, foreground dust that slides past at high parallax. `isStageImplemented(id)` returns true only for implemented stages (Phase 2 will do the rest —
but design the scenery framework so stages 2–5 are content, not new engineering; consider building a small shared particle-nebula toolkit in `src/stages/toolkit/`).

## 4. Dev sandbox & tools
- `dev/render/index.html` (+ TS): a stage viewer. Loads a stage, feeds **synthetic test layers** (a few procedural pixel sprites with dirty-rect updates, a debris screen layer, a UI test layer), fake `FrameFx` you can trigger with keys
  (shockwave, lens, flash, impulse), camera shake keys, quality toggle, live stats. Parameters: `?stage=&quality=&t=`. This is **your** test bed — the real fighters come from other builders later.
- `tools/render/capture.mjs`: screenshot each implemented stage in several fight states to `.scratch/render/*.png` (use `tools/lead/shot.mjs` as a base). **Look at every image** and iterate on beauty.
- Dev pages are served by `vite` dev only (Vite multi-page is not configured for build; keep `dev/` out of the production bundle).

## 5. Deliverables checklist (Phase 1)
- [ ] `src/stages/info.ts` (all 5 StageInfo, validated) — **do first**.
- [ ] `src/engine/{loop,camera,index}.ts` + tests. `src/engine/README.md`.
- [ ] `src/render/*` pipeline + tests for the pure parts (palette/LUT, dither, lean mapping, layer cache logic, integer-scale/letterbox maths). `src/render/README.md`.
- [ ] Stage 1 scenery at showpiece quality, reactive to `FrameFx`.
- [ ] `dev/render` sandbox + `tools/render/capture.mjs`; screenshots looked at and iterated.
- [ ] Perf report (numbers) appended to `docs/PERF.md` under a `## Render (B1)` heading (create the file if absent; append only your section).
- [ ] Final report per COMMON.md format.

Non-goals now: stages 2–5 scenery (Phase 2), UI, fighters, sim.
