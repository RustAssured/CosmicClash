# Decisions log

Format: `D<n> — title — decision — why`. Newest last. The Lead appends; builders propose via `docs/proposals/`.

**D1 — Toolchain** — Vite 7, TypeScript 5.9 (strict), Vitest 3, ESLint 9 (flat) + typescript-eslint, Prettier 3, Playwright 1.56.1, three ^0.186.
Not the newest majors (Vite 8 / TS 7 / Vitest 5 exist): Playwright 1.56.1 is pinned because it matches the pre-installed Chromium build (1194);
TS 5.9 is the version typescript-eslint supports without caveats; Vite 7 + Vitest 3 are a matched, mature pair.

**D2 — Simulation stays on the main thread** — No SharedArrayBuffer/worker sim. GitHub Pages cannot set COOP/COEP headers (needed for SAB), and cross-thread
copies of 25k-cell maps per tick would cost more than they save. Workers are used only for offline work (Node `worker_threads` for the balance tournament;
optionally a worker for titan generation at load). Budget is met by dirty-rect processing, active-region sweeps, zero-allocation loops.

**D3 — World space** — Logical pixels, +y down. All damage geometry is WORLD space; matter converts via `contracts/space.ts`. Removes flip bugs from callers.

**D4 — Lean is an integer row shear, never rotation** — Pixel art must not alias. Hit tests use the same mapping (`space.ts`), so what you see is what is hit.

**D5 — No camera zoom-out; fighters are tethered** — A 640×360 view with 90–180 px bodies cannot zoom out without breaking pixel integrity. Fighters
may not separate beyond `MAX_FIGHTER_DX/DY`; the camera pans with a heavy dolly. Micro-zoom (≤6%) is applied only in the final nearest upscale.

**D6 — `RenderLayer` is the only pixel transport** — `MatterMap.pixels` is the titan sprite (matter refreshes it: heat glow, char, infection, cracks, rim on freshly
exposed edges over the generator's `baseColor`). Debris/particles are rasterised by matter into screen-space layers at logical res. UI is a screen-space layer.

**D7 — UI is rendered in-pixel, not DOM** — HUD/menus rasterise into a 640×360 layer for crisp integer scaling and consistency with the pixel pipeline (and headless testability).

**D8 — Materials: physics vs look** — Matter owns a library of physics archetypes tuned for the damage model; titan JSON picks an archetype (`base`), may override numbers,
and authors its own visual ramp. Keeps damage-rules coherent across titans while art stays with the art owner.

**D9 — Determinism scope** — Same JS engine (V8) reproducibility: fixed tick, sfc32 seeded RNG, no wall clock/Math.random in logic. Tests hash world+match state.

**D10 — Hit-stop = frozen ticks; KO slow-mo = fewer ticks per second** — The sim never sees variable dt. Time dilation is an engine accumulator scale; hit-stop is a Match state.

**D11 — Titans are authored facing right; mirroring is a transform** — No duplicated left-facing art.

**D12 — Input is one `InputFrame` per slot per tick for humans and AI alike** — AI has no privileged path; it observes only public `FighterView`s and applies a reaction delay.

**D13 — Deploy** — GitHub Pages via Actions, Vite `base: './'` (works under any repo path). Pages source must be set to "GitHub Actions" once in repo settings; CI deploys on push to `main`.

**D14 — Headless verification** — Playwright + preinstalled Chromium 1194 with SwiftShader (software WebGL2, float RTs and MRT available). Frame-time figures from it are pessimistic
vs. a real GPU and are reported alongside sim ms/tick (which is representative). See PERF.md.

**D15 — Working method** — Four builder agents share one working tree with strict directory ownership; the Lead commits at integration points. Vertical slice first
(Last One vs Asteroid, Stage 1: FRACTURE + KINETIC), then the roster.

**D16 — Harness semantics** — `t` counts fight ticks *after* the silently fast-forwarded intro; script tick 0 = the tick the fight goes live; `gap=` sets the starting distance (`MatchConfig.startGap`, default 380 px); `state=50|10` means **HUD integrity 50% / 10%** (mapped through `KO_MASS_FRAC`, since 10% *mass* is already a KO); `q=0|1|2|auto` forces the renderer tier; `hud=0` hides the UI layer entirely. `window.__ADEUK__` (contracts/harness.ts) is always installed.

**D17 — Fighter order alternates per tick** — Match steps fighter `tick & 1` first so neither slot has a systematic same-tick advantage (matters for the balance tournament).

**D18 — Hit-stop keeps inputs** — during a frozen tick the Match still polls sources and merges edges (`accumulateInput`), delivering them on the first unfrozen tick; fighters additionally keep their own 9-tick buffer.

**D19 — AI edges are derived, never supplied** — `createAiSource` computes `pressed/released` from the AI's `held` mask, so an AI cannot fabricate an edge or press Pause/Training.

**D20 — Parallel titan builders** — Two builder instances work on disjoint titan pairs (Nexus+Black Hole, Supernova+Planet) with additive-only edits to shared registries. Framework changes are minimal and reported.

**D21 — Software-GL testing caveat** — The only GL in the sandbox is SwiftShader (~1–2 fps for the full pipeline). Sim ms/tick numbers are representative; frame times are not. E2E tests must *poll for state*, never sleep for fixed durations; UI timers that accumulate real `dt` advance slowly there. The Lead app uses the renderer's `'auto'` tier by default.

**D22 — Menu scenery** — In menus the app drives a slow hand-made dolly over the stage (no sim); matches use the engine camera. UI is always the last screen-space layer.
