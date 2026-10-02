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

**D23 — Evidence runs on the real GPU, in real time (slice Phase 0)** — Feel, flash, sound and performance claims cite `tools/lead/rtcapture.ts` runs on WJ's machine (headed full-screen Edge, ANGLE/D3D11, Vega 7) or the headless `tools/lead/pacing.ts`; never stepped stills. SwiftShader (D14/D21) remains for CI only.

**D24 — Instrumentation must not be the thing measured** — Measured costs on WJ's machine: telemetry ≈ −1.5 fps, recording ≈ −2 fps and +26 long frames/20 s, luminance read-back ≈ −12 fps, V8 tracing (all v8 categories) ≈ −10 fps. So: performance numbers come only from runs without recording or read-back; GC from a GC-category-only trace; flash metrics from dedicated runs; clips are recorded without the read-back. Telemetry is presentation-side only (`src/telemetry`), never read by the sim.

**D25 — LF line endings everywhere** — `.gitattributes` `* text=auto eol=lf`. GitHub Desktop's bundled git defaults to `core.autocrlf=true`, which made Prettier (and so `npm run lint`) fail on every file on Windows.

**D26 — Slice plan** — The two-titan vertical slice ("The Witness and the World") follows `docs/SLICE_PLAN.md`; its open architecture decisions (Witness region bodies + D4 amendment, camera push-in vs D5, hit-stop budget, two-hemisphere Planet, Gravity button) are recorded here once WJ answers Gate A (`docs/gates/GATE_A.md` §6).

**D27 — Gate A outcomes (WJ, 2026-10-01: "1–12 ok, Q10 speakers, ok to install")** — Plan approved as written. Each item below takes the recommendation in `docs/gates/GATE_A.md` §6:
- **Witness rig:** one MatterBody per rigid region, with LUT-quantised rotation and a single cached rotated mask per (body, angle) shared by hit tests and rendering. **D4 is amended:** whole bodies keep integer row-shear lean, rig regions may rotate, and silhouette disagreement may be at most 1 px (tested).
- **Camera push-in:** framing, a scenery dolly and parallax, with sprites staying 1:1. This amends D5 for scenery only. A sharp-bilinear sprite push (≤ 10 %) sits behind a flag for an A/B at Gate B.
- **Hit-stop:** the heavy cap drops to about 8 ticks; real momentum and torque carry the weight.
- **Planet rotation:** a two-hemisphere world.
- **Gravity button:** R1 (L1 stays Feint); on a sideways Joy-Con, stick-click.
- **Witness identity:** the id stays `lastone`, displayed as "The Witness".
- **Witness art:** front-facing eye with a tracking pupil, and the eye is the KO core; 4 scythe arms; an authored abyss for the void cavity; white-gold/cyan wound light everywhere on the Witness.
- **Aftermath:** freezes at KO + 1.0 s of the deciding round.
- **Loudness:** −20 LUFS integrated, −1 dBTP. **WJ listens on laptop speakers.** Tune for small speakers: high-pass subs (~45–60 Hz on the output), carry weight with the 80–250 Hz "knock" and mid transients, and check on speakers before trusting headphones.
- **Slice flag:** only the two slice titans and stages are shown; `?full=1` shows everything.
- **Flash compliance:** the §4 numbers are the standard. No formal WCAG/Harding certification. Comfort sliders default to 100 %, and the §4 limits must hold at that default (Lead's reading of "ok" on Q12).
- **ffmpeg:** installed (winget `Gyan.FFmpeg`) for MP4 conversion and trimmed clips.

**D28 — Gate B outcomes (WJ, 2026-10-02)**
- **Orbital footwork is the slice's combat space.** WJ: "an absolute banger… a unique feeling of freedom… reminiscent of classic shooter style gameplay on the 2D arcades". `footwork='orbit'` becomes the default; classic stays behind `orbit=0` for comparison only. AI, balance, pacing and audio calibration are tuned for orbit from now on.
- **Top-priority defect: scale of motion (D9 — "critters, not planets").** Tendrils and certain moves wobble fast, as if much smaller creatures were fighting. Motion must read at moon and planet scale: lower natural frequencies, slower secondary motion, heavier follow-through, no high-frequency jitter. Input must stay immediate (the accept-tick response stays). This pass outranks new content.
- **Depth offset and sprite push:** no verdict; they are subtle. Both stay behind their flags (off by default), to be shown again at Gate C with clips that isolate the moment they matter.
- **Controller mapping:** not yet confirmed. Re-ask at Gate C.
- **Phase 2 is approved** ("move forward with what you can").

**D29 — Between-round heal 0.6 → 0.85 (Lead, proposal 162).** With orbit pacing (~9 contacts/min), round 1 lasts ~48 s, but rounds 2–3 lasted ~15 s on 2 contacts because the loser started fragile. 0.85 keeps visible scars and structural memory ("damage persists as partially healed scars") while giving the loser a real round. Re-measured at Gate C.

**D30 — Debris wounds by its own speed; a gravity owner is not wounded by its own in-fall (Lead, proposals 166 and 164).**
S1 measured that two thirds of all lost matter came from drifting debris, not from blows. Rounds lasted 22–25 s at an on-target ~9 contacts per minute. The Planet's own well pulled wreckage into it, and it lost 24–59 % of a body per fight while charging Comet Shepherd. With debris wounds off, rounds land at 45–90 s, but the Planet wins 24–1, because the Witness's heavy blows remove 7–30× less matter per hit. The 50/50 balance rested on the Planet bleeding itself.
- **(1) Own in-fall:** a body is not wounded by chunks its own fighter's gravity source is drawing in. Thrown or launched chunks, comets and the foe's well still wound.
- **(2) Debris speed:** debris wounds by the chunk's own speed, not the relative speed. Moving through the arena's wreckage is not a wound; a flung slab still is. This keeps "the arena is occupied space" meaningful (debris is struck, shoved, launched) without slow attrition deciding rounds.
- **(3) Rebalance after (1)–(2):** heavy-move damage per hit for the pair within about 2× of each other (164), with the match 45–55 %. S3 runs the balance pass across both definitions. S1 re-tunes the AI engagement gap so rounds sit inside 45–90 s without timeouts.
