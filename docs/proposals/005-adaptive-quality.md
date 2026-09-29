# 005 — `RendererOptions.quality: 'auto'` and `RenderStats.tier` (B1 → Lead)

**Why.** The showpiece scenery is heavy on weak GPUs (integrated laptop chips, low-end phones) and cheap on good ones. A fixed tier is either wasteful or
stuttering. The renderer can pick the tier itself by watching frame pacing, so the game never has to ask the player for a "graphics" setting.

**Proposed contract diff** (`src/contracts/render.ts`):

```ts
export interface RenderStats {
  // …existing members…
  /** Current quality tier (0 low … 2 showpiece). */
  tier: 0 | 1 | 2;
}

export interface RendererOptions {
  // …
  /** 0 | 1 | 2 fixes the tier; 'auto' (the default) starts at 1 and adapts to the device while playing. */
  quality?: 0 | 1 | 2 | 'auto';
}
```

**Behaviour (implemented in `src/render/quality.ts`, a pure controller with unit tests; wired in `renderer.ts`).**

* Starts at tier 1. Measures frame pacing from `requestAnimationFrame` deltas over ~1.5 s windows and, where the browser exposes
  `EXT_disjoint_timer_query_webgl2`, the real GPU time of the last frame.
* **Steps down** after sustained misses (two consecutive windows in which ≥ 20 % of the frames were late, i.e. > 1.2 × 16.7 ms apart), **steps up** cautiously and only after a long quiet
  run that also leaves GPU headroom for the higher tier (predicted from the measured GPU cost; without a timer it *probes* after a long clean run), with hysteresis, an exponentially backed-off probe after a failed step up,
  and at most one change per ~3 s. Tab switches / long hitches (> 5 s) are disruptions, ignored, not counted as misses.
* Changing tier is **cheap** (≈ 0.1–1 ms of CPU, no rebuild): the scenery draws a prefix of its particle clouds (brightness-compensated, so the picture keeps its
  look — verified: mean luminance differs by < 0.2 % between tiers), trims fbm octave counts, and the supersampled scenery target is resized.
* `stats.tier` always reports the current tier; the implementation's extended stats also expose `auto`, `gpuMs`, `lateRate` and `tierChanges` for the debug overlay.
* Software GL (SwiftShader in CI) misses every frame and correctly walks down to tier 0 and stays there — `verify.ts` asserts it.

**Today (local adapter, works).** `createRenderer()` returns `DebuggableRenderer`; `init(canvas, { quality: 'auto' | 0 | 1 | 2 })` is accepted and `'auto'` is the default when
`quality` is omitted. Callers that pass `0 | 1 | 2` keep the previous fixed behaviour. The extended stats type is `RenderStatsEx`.
