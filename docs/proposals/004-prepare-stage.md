# 004 — `Renderer.prepareStage`: load a stage without freezing the game (B1 → Lead)

**Why.** `setStage(id)` builds a stage synchronously: particle fields, GPU bakes (dust pillars, the sculpted signed-distance field), the
palette LUT and every shader program. On real hardware that is 0.3–2 s in one frame — a visible freeze exactly at "round start". The stages
are now heavier (rotating galaxies of tens of thousands of stars, ember winds), so the freeze would only grow. The renderer can do that work in
small slices between frames, and the UI can show a progress bar while it does.

**Proposed contract diff** (`src/contracts/render.ts`, `Renderer`):

```ts
export interface Renderer {
  // …existing members unchanged…

  /**
   * Build a stage's scenery, palette LUT and shaders in the background, spread over frames (≈ 5 ms of work per frame), so the game
   * keeps running and a loading screen can show progress. Resolves when the stage is ready; the first `draw()` whose `frame.stage`
   * matches (or `setStage`) then switches to it instantly. Calling it for a stage that is ready or already preparing is free
   * (returns the same promise). `onProgress` receives monotonically non-decreasing fractions in 0..1 and finally 1.
   */
  prepareStage(id: StageId, onProgress?: (fraction: number) => void): Promise<void>;
  /** True when `setStage(id)` / a matching `draw()` would switch instantly (the stage is active or prepared). */
  isStageReady(id: StageId): boolean;
}
```

**Semantics (all implemented and covered by `dev/render/verify.ts`, section 13).**

* `prepareStage` returns at once (≈ 0.1 ms); nothing blocks. The work is a resumable generator per stage (`StageScenery.prepare`, which yields at every
  point where pausing is safe) driven by a 5 ms-per-frame time-slicer (`src/render/slicer.ts`). Shader compiles run off-thread where the browser
  exposes `KHR_parallel_shader_compile`; otherwise one layer per frame.
* **`draw()` never shows garbage.** While a stage is preparing, `draw(frame)` keeps drawing the *previous* stage (the last active one), or plain black
  with the 2D layers and UI on top if there is none. The frame it finishes, the next `draw()` with a matching `frame.stage` switches over in one call.
* **`draw()` for a never-prepared stage does not block either.** It starts the background job and keeps the current stage (this replaces the old
  synchronous build). `setStage(id)` still exists and still builds synchronously — use it in tests and tools that cannot wait.
* **Context loss.** After a `webglcontextrestored` the active stage is rebuilt through the same path: 2D layers keep drawing over black meanwhile.
* **Cancellation.** Disposing the renderer, or asking for another stage while one is preparing, lets the running job finish (it is cheap to keep) but
  never activates a stage the caller no longer wants: activation happens only in `draw()` for the stage named in the frame.
* **Stats.** `RenderStats` gains nothing in the contract; the implementation's `stats.prepare` (`{ stage, wallMs, cpuMs, frames, maxSliceMs }`) is
  available on `DebuggableRenderer` for the loading screen and the perf tools.

**Suggested app use.** When the player confirms a stage on the select screen call `renderer.prepareStage(id, (f) => ui.setLoading(f))` right away — the
few seconds of "pick fighters / countdown" hide the whole load — and start the round when it resolves. A cold start on the title screen can prepare the
last-used stage in the same way.

**Today (local adapter, works).** `src/render/renderer.ts` exports `DebuggableRenderer` (= `Renderer` + `prepareStage` + `isStageReady` + debug hooks)
returned by `createRenderer()`; the app can import that type instead of `Renderer` until the contract is extended. Nothing else in the repository needs to change.
