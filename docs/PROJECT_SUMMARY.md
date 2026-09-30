# ADEUK: TITANS — project summary (for handing to another Claude)

*Written by the Lead agent at the end of the first build. Everything below is stated as honestly as I can: what exists, what was measured, what was only checked by machine, and what no person has verified yet.*

## 1. What it is

A 2.5D cosmic pixel-art fighting game for the browser (TypeScript + Three.js, no external assets). Two colossal cosmic entities fight, and **destruction is the health system**: each titan's body is a simulated map of pixel matter, and every blow removes, burns, infects, cracks, crushes or devours real pixels in the attacker's own way. A fight leaves both bodies visibly carved and the arena littered with their remains. Working title *ADEUK: TITANS* (아득, "far away / vast").

The human who commissioned it wrote one long "master prompt" (vision, six-titan roster with stats and signatures, feel targets, AI and balance requirements, Switch Pro controller support, visual pipeline, procedural audio, team structure, phases, a mandatory review loop). The Lead agent (me) built the contracts, docs and integration and directed four builder sub-agents in parallel with strict directory ownership. The first person to play it (the commissioner, keyboard only) called it "incredible", "visceral", and said it has "something golden in it" that they hadn't felt in fighters before, while also saying moves and feel are not perfect yet.

## 2. What exists (as of `main`)

- **Six playable titans**, each generated procedurally at load into a layered pixel matter map (damage reveals interior layers), with its own destruction signature and failure mode:
  - **The Last One** — celadon core, ancient eye, halo, 24 verlet tendrils. FRACTURE (shears along weakest bonds, spreading crack networks, piercing Gaze). Failure: tendrils sever, eye exposed.
  - **The Nexus** — crimson graph of nodes and forged chains around a crystal hub. ASSIMILATION (latch, infect, harvest lattice into its own graph; ultimate builds a cage). Failure: cut chains, far sub-graph goes dark and dies.
  - **Black Hole** — true-black horizon (immune), photon ring, Doppler-brightened accretion disk, jets, lenses the background. TIDAL CONSUMPTION (spaghettifies loose matter into streams that feed the disk; grows heavier and slower as it feeds). Failure: only the disk can be hurt.
  - **Supernova** — roiling star with granulation and prominences. THERMAL (heat diffusion, ignition, burning fronts, char, embers); fuel shrinks the star; collapses into a final nova. Failure: outer layers blow off.
  - **Planet** — atmosphere, clouds, oceans, continents, crust, mantle, magma core; real orbiting moons as separate bodies. CRUSH & TECTONICS (craters, shock rings, moon slams). Failure: crust cracks show magma, atmosphere stripped, moons lost.
  - **Asteroid** — iron-nickel rock with regolith and ice veins. KINETIC (craters, ejecta, embedded shrapnel that fractures later). Failure: rubble pile at low mass.
- **Five stages** with real 3D (Three.js) particle nebulae/galaxies rendered at 640×360, dithered into curated palettes, reactive to fights: Stellar Nursery, Galactic Rim, Red Giant's Wake, Quasar Void, Tussenruimte.
- **Render pipeline:** scenery → OKLab palette dither → 2D pixel layers (titans, debris, particles) → bloom, god rays, Black Hole lensing, shockwave refraction, chromatic aberration, grain → integer upscale. Bodies light each other and the scenery (dynamic light from bright titans, sprite relight, foreground depth pass, debris depth classes). Adaptive quality tiers.
- **Destruction simulation (`src/matter`)**: structure-of-arrays cell maps (up to ~25k cells), bond graph, connectivity/detachment into tumbling rigid chunks, heat diffusion, tidal streams, infection, crack propagation, mass ledger, deterministic, pure TypeScript (runs headless in Node). Six damage models with a per-material resistance table.
- **Combat (`src/combat`)**: fixed 60 Hz, input buffer, feint/cancel, hold-to-charge, aim up/forward/down, Guard shells by damage type, pixel-accurate hit detection on cell masks, hit-stop scaled by energy and masses, graded tether, mass-based locomotion (spring lag/overshoot, bobbing), ease-out knockback scaled by mass ratio, per-titan `feel` and `balance` blocks in JSON.
- **AI (`src/ai`)**: utility + frame-data lookahead, delayed observation by difficulty (180–350 ms), n-gram habit model, blunders; six levels.
- **Input**: Gamepad API with Nintendo Switch Pro first (standard + DirectInput tables, hat decoding, radial deadzone, calibration, remap persistence, Nintendo labels, rumble, optional WebHID), Joy-Cons, Xbox/PlayStation, two keyboard layouts, Controller Check screen.
- **UI**: all in-pixel at 640×360, Latin + all 11,172 Hangeul syllables composed from jamo; title, modes, assign, titan select with live portraits, stage select, Controller Check, options (incl. shake/flash comfort sliders), HOW TO PLAY, HUD with live body portraits and integrity %, pause, results, training overlay (frame data, hitboxes, matter debug), AI-vs-AI attract mode.
- **Audio**: fully procedural WebAudio, per-titan voices, adaptive score per stage, reverb, master limiter.
- **Docs** in `docs/`: DESIGN, DECISIONS, TITANS, DESTRUCTION, AI, BALANCE, PERF, ADDING_A_TITAN, REVIEW_LOG, gallery.

## 3. Numbers (measured, honest)

- ~806 unit tests (805 passing on the last full run; the failing one was a perf guard later recalibrated), plus Playwright browser specs. Typecheck, lint and prettier clean.
- Sim cost: ~1 ms/tick mean integrated; p95 ~4–5 ms; spec budget 5 ms. A worst-case saturated two-22k-cell scenario measures p99 ≈ 4.6 ms (was 2.2 ms in round 2; later visual/feel work made it heavier — documented in PERF.md).
- Determinism verified in the browser: identical params give identical state hashes across page loads.
- Balance (level 3, 30–100 fights/pair): overall win rates Last One 41%, Asteroid 51%, Nexus 49%, Black Hole 65%, Supernova 57%, Planet 35% — all inside 35–65% but not the 45–55% target. Pair extremes remain (e.g. Black Hole vs Planet 93%, Nexus vs Black Hole ~0%, Nexus vs Planet 77%). Rock-paper-scissors cycles that global knobs cannot remove.
- Rounds average ~18–44 s (target 30–50); some pairs are shorter.
- AI difficulty ladder is weak: level 6 vs level 1 is 48–72% depending on titan, only loosely monotone.

## 4. What is NOT verified (important)

- **No human played it at 60 fps before the commissioner did.** The sandbox only had software WebGL (~1–2 fps full pipeline), so all visual/feel work was judged from stills and numbers, never from real-time motion.
- Switch Pro / Joy-Con / Xbox / PlayStation input is verified only against fake `Gamepad` objects. Vibration and WebHID are untested on hardware. The Controller Check screen exists so a real pad's mapping can be fixed in seconds.
- Audio has been measured offline (levels, spectra, limiter) but never listened to.
- Real-GPU performance is unknown (adaptive quality should help).
- Comfort (photosensitivity) settings exist but were not validated with anyone photosensitive; the game should be treated as unsuitable for photosensitive epilepsy until checked.
- GitHub Pages deployment workflow has never run on GitHub.

## 5. How it was built (process lessons)

- Contracts-first: typed interfaces in `src/contracts` (matter, damage, titan, input, render, audio, AI, sim, UI, harness) let four builders work in parallel. Pure-TS purity boundary (no DOM in sim modules) made headless tournaments and determinism tests possible.
- A URL-param debug harness (`?stage=&a=&b=&seed=&t=&state=&script0=&gap=&meter=&q=`) plus `window.__ADEUK__` made reproducible screenshots, strips, benchmarks and e2e tests possible.
- Real bugs found only by integrated evidence, not by reports: a landed Crush doing 0.7% damage (a graze consumed the blow + a deferred crack pass aimed at the old position after knockback); healed bodies kept losing mass (debris pelting + orphan regrown cells); `resist` applied in opposite senses in different models; slider/UI timers 10× too slow at low fps; a same-instant AudioParam automation bug that only real Chromium exposed.
- Balance could not be hand-tuned (every fix moved another matchup). What worked: per-titan `power`/`durability` knobs + an unattended autotuner over worker-threaded all-pairs tournaments, then structural material fixes. Still imperfect.
- Environment pain: the container restarted several times and killed long jobs; resumable tools and frequent commits were essential.

## 6. What I think is the real value (and the advice)

The destruction-as-health core works and is distinctive: every hit permanently changes the shape you're fighting, each titan breaks in its own way, matchups emerge from material physics, and the HUD portrait shows what you've lost. That is the "golden" part the player felt. Suggested priorities:

1. **Feel pass with a human at 60 fps** (keyboard and real controller): weight, hit-stop, knockback distance, recovery, approach speed, camera. Use a fixed feel questionnaire per titan. The per-titan `feel` JSON blocks and `TUNING` constants are the handles.
2. **Polish fewer titans deeper** if needed; each titan costs art + behaviour + AI + audio. `docs/ADDING_A_TITAN.md` documents the steps.
3. **Fix the worst matchups structurally** (Black Hole disk vs crush/kinetic and infection; Supernova plasma lightness) rather than with more scaling.
4. **Make AI difficulty matter** (the AI's damage model is wrong for delayed/structural damage).
5. **Listen to the audio**, test a real Switch Pro, measure on a real GPU.
6. Lean into the unsettling destruction: more readable impact, slabs, debris record, sound.

## 7. Advice for the next master prompt

Keep the concise vision + 3 non-negotiables + measurable targets + ownership + mandatory evidence loop. Change: build the tournament/validation/determinism infrastructure in phase 0; define balance as a budget (shared knobs + allowed counters + target bands); separate "destruction looks great" from "destruction is fair" (immediate vs delayed damage, per-blow caps, round-length target); require human-play checkpoints with a feel questionnaire; state environment limits (software GL, no controller) and plan real-hardware checks; scope the first release to 3–4 characters; require resumable long jobs and frequent commits.

## 8. Where things are

- `docs/DESIGN.md` (bible), `docs/DECISIONS.md` (D1–D22+), `docs/TITANS.md`, `docs/DESTRUCTION.md`, `docs/AI.md`, `docs/BALANCE.md` (tournament matrices + autotune log), `docs/PERF.md`, `docs/ADDING_A_TITAN.md`, `docs/REVIEW_LOG.md`, `docs/gallery/` (screenshots), `README.md` (how to play, controls, Bluetooth pairing, honesty list).
- Commands: `npm run dev|build|test|lint|e2e|perf|capture|balance|autotune`.
