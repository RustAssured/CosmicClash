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
- **Confirmed by WJ at Gate C (2026-10-03):** keep D30.
- **(3) Rebalance after (1)–(2):** heavy-move damage per hit for the pair within about 2× of each other (164), with the match 45–55 %. S3 runs the balance pass across both definitions. S1 re-tunes the AI engagement gap so rounds sit inside 45–90 s without timeouts.

**D31 — Gate 0 of the 우리 / Mouth integration (WJ, 2026-10-06; docs/integration/GATE_0.md).**
- **(1) Plan approved.** It runs now, in place of the slice's Phase 3; Gate C's open items carry into Phase 4.
- **(2) 우리's buttons:** Strike = lead straight punch, Crush = rear cross-body smash, Signature = uppercut, Ultimate = double slam. For both new titans, Surge and Guard stay unbound when the packs give nothing to map.
- **(3) Health:** 우리's loop integrity is its health. The Mouth needs **something other than a health bar** (WJ: health bars 'kinda suck'); propose a readout at Gate 3A. Best of three rounds as now.
- **(4)** Master palette and one sky approved; show a before/after at Gate 1.
- **(5)** The hitstop cap is raised for the heavy and catastrophic VFX weights only.
- **(6)** The Planet is enlarged so it reads as an equal of 우리 and the Witness. WJ picked **220 px** (docs/gallery/integration/planet-sizes.png).
- **(7)** 우리 and the Mouth join the roster after their final gates.
- **Later (WJ):** new, vaster backdrops after the integration.

**D32 — Gate 1 (WJ, 2026-10-06; docs/integration/GATE_1.md).**
- **The unified look is approved.** The one sky becomes live in play (proposal 172).
- **The Planet's atmosphere glow comes back** under the shared bloom.
- **The Planet's size:** WJ found 220 px too big and asked the Lead to size it against 우리 and the Mouth. The Lead set **180 px**:
  - the Mouth's jaw-ring span is about 180 px;
  - about 0.66× the Witness (about 272 px) and about 0.6× 우리 (about 300 px);
  - it fits the original body limits.
- **Phase 2 (우리) starts.**

**D34 — Rebuild from the best of both (WJ, 2026-10-09; docs/COMPARISON_ORIGINAL_VS_NOW.md).** WJ compared the original six-titan
game (6728a3e) with now.

**Keep:** 360° orbit movement, weight and momentum, the Witness design, wounds that read.

**Bring back:**
- all six titans in the new engine, with the Witness replacing the Last One;
- original-like sizes (titans about 90–180 px on the 640×360 screen; the Witness about 180 px tall, the Planet 121 px; 우리 scaled down to match);
- vivid colour and spectacle: the per-stage palettes and bright emissives, and the **screen-wide effects and flashes** (WJ loves them). This relaxes D5 and the unification ceiling;
- a pace between the original's frantic and today's slow.

**Sound:** much more epic, cosmic and cataclysmic. Drop high-pitched sounds and whistles in favour of huge, dramatic impacts.

**Program:** the 우리 / Mouth integration pauses (우리 stays in the game, scaled; the Mouth is deferred). Supersedes parts of D5, D31-6/D32 (Planet 180 px) and the unification rules.

**D35 — The vibe is right; the Mouth becomes a final boss (WJ, 2026-10-09).** After round R1, WJ: "Love it… just love the vibe".
- **Balance:** imperfect balance against the AI is accepted for now.
- **The Mouth:** comes later as **a final boss** rather than a roster fighter. Gate 3A (docs/integration/GATE_3A.md) is the starting point for that design.
- **Next:** footage and shots for a website, and promotion.

**D36 — Two titans from one: the colossus is The Last One, the original returns as The Witness (WJ, 2026-10-11).** The
rebuilt big-eye colossus had taken over the original Last One's id (`witness=1`), so only one of them could exist.
- **Two roster titans, two ids.** `colossus` is the big-eye colossus (gold rim, celadon iris, tentacle arms), displayed as
  **The Last One / 마지막 하나** (already its Korean name). `lastone` is the returning original tendril titan, displayed as
  **The Witness / 목격자**. Ids are internal: the colossus's code keeps its historical Witness names (`witnessDef`,
  `WitnessBehaviour`, `witnessKit`, `WITNESS_*`); the tendril titan's keeps the LastOne names (`paintLastOne`,
  `LastOneBehaviour`, tendrils). The colossus's moves are `colossus.*`; its template is `src/titans/colossus.json` (the Last
  One's D34 JSON, frozen), so tuning the Witness never moves it. The `witness` URL flag is ignored.
- **The Witness has five eyes** (a lead eye, the gaze's source, and four smaller ones, each in its own socket, blinking out
  of step) and **its own palette**: violet glaze, rose-magenta eyes, a magenta heart, a silver-lilac halo ("amethyst";
  options in docs/gallery/roster/witness-palettes.png). Its original size (176 px map, about 114×149 px body) is kept.
- **The Witness on the D34 engine:** orbit footwork, PACE, blow weights (`lastone.*` in combat/weight.ts), its tendril shield
  and bared eyes, its own audio tuning (the temple voice in C♯ minor), AI coverage, and a first balance pass: `balance`
  power 0.98 (was 1.082), durability 1.1. AI L3 v L3, 10 fights per pair, sides alternated: 35 of 70 (50 %). By pair: Asteroid
  8–2, Supernova 10–0, 우리 6–4, the Last One 7–3, Planet 3–7, Nexus 1–9, Black Hole 0–10 (the Black Hole also beats the
  Last One 6–0: a family matchup for a later pass).
- Supersedes D34's "the Witness replaces the Last One".

**D33 — FRACTURE bites solids (Lead, 2026-10-06).** On the 180 px Planet, FRACTURE blows took their contact and slab sizing from
the outer atmosphere and ocean. They shed only fluid (1 solid mass in 1.5 s), which failed D1. FRACTURE now sizes its slabs from
the first solid cells; the fluid it crosses vents as spray. Hashes change by design. The approved sampler for 우리 is proposal
174 (4-sample majority).

**D37 — Gate 3A, the Mouth (아귀): "go with the recommendations" (WJ, 2026-10-11; docs/integration/GATE_3A.md).** All seven
answers are the proposal's recommendations. Built by S10 (Phases 3B–3E, see PROGRESS.md):
- **(1) Arena B.** A Mouth match plays in a rim arena: the stage's width (1600), 360 px tall (restY ± 180), so both long edges
  are always on screen; the camera's y is locked by the arena and its x keeps the anchored edge in view (the Mouth's live
  bounds are head + neck + the anchor's edge and exit). `arenaForMatch` (src/combat/mouth/arena.ts).
- **(2) Hurtboxes.** The capsule set (head along the funnel axis r 58; 23 neck capsules r ≈ 21–28; coil capsules r 40 only
  where they reach into the arena) and the analytic-fighter contract: `MouthFighter` implements `Fighter` directly (probe →
  synthetic overlap, receive → the prototype's damage model, power = energy / E_REF). Debris: the matter world's additive
  `setCapsules` / `drainCapsuleHits` (src/matter/capsules.ts): chunks bounce off the capsules by the D30 rules and their
  impacts queue for the fighter (coil −2·power).
- **(3) Coil & crush.** Grab circle r 75 at the locked target, checked as the reach beat ends (a miss goes straight to the
  release); the held foe's root is drawn to the coil centre (≈ 2 Hz) and its footwork damped; escapes by a Surge in the first
  0.35 s of the coil beat or 1.5 sever units of damage on the wrapped neck; the crush beat cannot be escaped. The wrap circles
  the foe's core (carapace / torso of the big titans: a radius from its live bounds) and its back half is drawn behind the foe.
- **(4) Corners.** The head's intent keeps 98 px from the coil spine (keep-out band); fixed draw order coils → [foe] → neck →
  head (the Mouth is two layers: back z −1.5, front z 9).
- **(5) Health readout.** The four jaw-ring emblem in the HUD (each ring 25 %; arc lost as its quarter goes, broken when it is
  gone; every hit chips the ring of the current quarter); the six neck strands below it (cut = red). `integrityPct` stays the
  number the rounds read.
- **(6) Input.** Bite = Strike, Sweep = Crush, Coil & crush = Signature; Surge / Guard / Ultimate unbound; slide = stick X,
  oracle literal (right = clockwise along the perimeter); height = stick Y held at the strike.
- **(7) Safe strip.** From a side wall the bite's centre stays out of the view's far 170 px (`safeStrip`, debug knob).
- **Boss and unlock (D35):** `mouthBossDef()` (health ×2, an enraged last ring: faster slide and strikes, shorter recovery,
  sharper tracking, ×1.2 power) for the ladder; the Mouth is not in `IMPLEMENTED_TITANS` and appears in the menus only when
  `isMouthUnlocked()` (`?mouth=1`, or `setMouthUnlocked(true)` which the ladder calls; persisted on the device).
- **Look:** the LOCKED renderer ported to the GPU (src/render/mouthPass.ts: instanced capsule impostors with the flesh shading,
  annuli, stamps; a depth stage then a shade stage), lit by the one titan sky (the oracle's rig turned 180°; the oracle's own
  light for parity stills, a debug knob). Its own impact visuals are replaced by the shared VFX (hit events).

**D38 — The logo is logo D, the wordmark (WJ, 2026-10-15).** After an emblem, a titan banner (from WJ's ChatGPT mockup) and
three type-only variants, WJ: "Yes, D is the logo. Put it on the site and in the game."
- **What it is:** ADEUK (cracked gold) over TITANS (chrome with stars), a horizon line of light between them, the Last One's
  eye at its centre, and six beads made from the original roster's own pixels, shrinking outward. Type, not titan art: the
  titans appear as tokens, so it reads at every size. src/ui/pixel/wordmark.ts.
- **Where:** the boot, title and attract screens, the site's hero and nav, the /play/ loading page and the press download.
  The old one-line logotype (logo.ts) stays where re-rendering is expensive (trailer, key art, social card) until those
  are next made.
- **Rule:** the beads are cut from the live portraits, so they follow the titans' art. A bead whose titan is missing is left
  out.

**D39 — The Asteroid's living idle turns and steps its body for real (WJ, 2026-10-17; docs/idle/PORT.md §3).** Amends D4 for
one titan. WJ took the three recommendations:
- **Real rotation:** the Asteroid's head snaps turn its whole body (`transform.rot`, the shared quantised sampler, as 우리's
  pelvis), so what is drawn is what is hit. Idle angles are within ±45° of the facing horizontal, in 4-step (5.6°)
  increments; the momentum spin is a full turn.
- **Real offsets, full range:** darts (±10 px x, ±8 px y), the feint's 15 px lunge and the hops move the body, as the bob
  and sway do (`Behaviour.bodyPose`, applied before each tick's hits). The lunge never reaches the foe (no auto-feint while
  its live bounds are within reach).
- **No momentum from idle:** the spin plays at the next idle moment after real momentum reaches 3. Idle feints add none.
- **Rules that keep moves exact:** the tick a move starts, the offset and rotation are 0. Hitstun, guard and the intro send
  the body home in 2 ticks. The pose is sim state (deterministic, in the hash); the smears, swarm and glints are drawn
  render-side.
