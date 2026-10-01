# GATE A — audit, baseline and plan

**Status: waiting for WJ.** Phase 0 is done. No gameplay code was changed. What changed is evidence tooling, line endings, and an additive audio tap. The plan is in [`docs/SLICE_PLAN.md`](../SLICE_PLAN.md). This page holds the baseline evidence, what changed, the known issues, and the decisions only you can make (§6).

## 1. How to run

```bash
npm ci
npm run build
npx vite preview --port 4173
```

- Open <http://localhost:4173> in Edge or Chrome and press **F11**. A windowed browser on a 1080p screen drops the pixel scale from ×3 to ×2 (1280×720, letterboxed). The 60 fps targets assume full screen.
- To play the slice matchup straight away, with the telemetry strip at the bottom edge: <http://localhost:4173/?mode=fight&a=lastone&b=planet&p1=human&p2=ai&ai=3&tele=1>. Drop `&tele=1` for a clean screen.
- Real-time evidence: `npx tsx tools/lead/rtcapture.ts <scenario>`. It opens a full-screen Edge window on this GPU. Scenarios: `aivai`, `moves-lastone`, `moves-planet`, `latency-lastone`, `latency-planet`, `play` (you play; it records until the match ends).
- Headless pacing / D1: `npx tsx tools/lead/pacing.ts --n=40`.
- The whole Gate A set: `powershell -File tools/lead/baseline-gate-a.ps1`. It is resumable and takes over the screen for about 8 minutes.

## 2. Footage and strips (current build, real time, this machine's GPU)

**Graphics: ANGLE / Direct3D11 on AMD Radeon (Vega 7), tier `auto`.**

> **Correction (after Gate A).** Windows display scaling here is 125 %, and Playwright's launch flags did not make the capture window full-screen. The canvas was therefore 1285×883, and **every Phase 0 run above rendered at the ×2 scale (1280×720 output), not 1080p**. The clips are 1284×882.
>
> The capture tool now forces true full-screen through the DevTools protocol and records the canvas size and scale in every JSON. A re-run at ×3 (1920×1080, same build, `baseline-perf-1080.json`) gave **59.4 fps mean, 1 % low 24.8, 33 frames over 25 ms, sim p99 5.3 ms**. That run happened while the Phase 1 specialists were using the CPU (mean load 46 %), so it is pessimistic. A quiet-machine 1080p baseline is taken before Gate B. Everything up to the final upscale runs at 640×360 at any scale, so the other numbers here are unaffected. The video files are too big for git. They are in `evidence/gate-a/` inside the repo folder.

| File | What to look at |
|---|---|
| `evidence/gate-a/baseline-aivai.webm` (60 s, sound on) | The matchup as the AI plays it. Look at hits, wounds, the camera, flashes and the sound. |
| `evidence/gate-a/baseline-moves-lastone.webm` | Isolated moves against an idle Planet, in this order: Shatter Blow → Gaze → Sidestep → Tendril Lash → step right/left → The Last Light. |
| `evidence/gate-a/baseline-moves-planet.webm` | Impact → Moon Slam → Orbital Shift → Tidal Nudge → step right/left → Cataclysm. |
| `evidence/gate-a/strips/*.png` | 12-frame strips labelled in ms from the trigger, at exact pixels. Each covers one move (`shatter`, `gaze`, `sidestep`, `turn`, `lastlight`, `impact`, `moonslam`, `shift`, `cataclysm`) or one event (`heavy-hit-1/2`, `ko`, `lastone-crush`, `planet-crush`). |

What the strips show (I looked at every one; one sentence each for the ones that matter):

- **`baseline-moves-lastone-shatter`.** The Last One drifts a few pixels during the 0.5 s windup and its body never commits. At +867 ms the blow arrives as a horizontal **rake of straight, parallel tendril lines** (D2, D3). The camera does not move (D4).
- **`baseline-moves-planet-impact`.** The Planet shuffles in place. A flat orange ring flashes between the two at +717 ms. **The Impact never reaches the Last One**: its HUD stays at 100 % and there is no wound on that tick. The move nets about 0 px of travel (S1: −34 px, then +36 px).

## 3. Baseline numbers vs §4 targets

Sources:
- `docs/gates/evidence/gate-a/*.json`: real-time runs on this machine.
- `pacing-baseline-L3.json`: 40 headless fights, AI level 3.

Performance comes **only** from the run without recording or luminance read-back, because instrumentation costs frames (see §5).

| Target (§4) | Baseline | Verdict |
|---|---|---|
| Input → first visible response ≤ 1 frame (16.7 ms) | **Accept** (input → the draw that contains the accepting tick): median 19 ms (Last One), 17 ms (Planet). **First moved pixel**: median **36 ms** (Last One), 18 ms (Planet). Tails reach **86 / 158 ms**; stick moves are slowest (50–86 ms). | ✗ |
| Settle 0.35–1.2 s after a command | 383–1817 ms (Last One), 450–1850 ms (Planet); about half run over 1.2 s | ✗ |
| Heavy move: anticipation 0.3–0.6 s, total 1.0–2.0 s, feint window in the first 40 % | Shatter 0.50 s / 1.40 s ✓. Impact **0.67 s** / 1.87 s (anticipation too long). The feint window exists, but the AI never feints. | ~ |
| Crack visible on the impact frame | Shatter: no crack, only bruising and seam pops. Impact: an instant crater (a hole, not a crack). | ✗ |
| Impact FX peak ≤ 100 ms | 0 ms (white flash disc on the impact frame) | ✓ |
| FX occluding the wound cleared ≤ 400 ms | Median **1735 ms** (60 s fight). Shatter: 983–2420 ms. | ✗ |
| Slab shear begins 80–300 ms after impact, as slabs | **D1**: the Planet's CRUSH blows remove **818–1081 mass from the Last One within 2 ticks**. In the median heavy hit on the Planet, **51 % of the mass it loses over 1.5 s goes in a single tick, and 98 % of that tick becomes particles**. Shatter → Planet: 381 mass in one tick at +267 ms (the chisel), 97 % particles. The Last Light → Planet: 577 mass at +483 ms, 98 % particles. Overall, 58–67 % of removed matter leaves as particles. | ✗ |
| Detached chunks keep ≥ 60 % of the impact momentum, spin by lever arm | Slabs released more than 14 ticks after a blow do not inherit it at all; they drift at 16–42 px/s (S4, from code). | ✗ |
| Off-axis hits produce rotation ∝ lever arm | No angular state exists | ✗ |
| Flashes: no full-frame luminance change > 20 %, ≤ 3 flashes/s | Max change within 100 ms is **0.32 of full scale** (a 2.6× relative jump from dark). Opposing flash pairs reach at most 1–2/s. | ✗ (amplitude) |
| Audio: integrated −23 to −18 LUFS | **−17.0 LUFS** in-engine (your recording measured −28, so about 11 dB was lost in the recorder/OS chain) | ~ (slightly hot) |
| True peak ≤ −1 dBTP | −3.7 dBTP | ✓ (but see LRA) |
| Heavy impacts ≥ 10 dB above the bed (short-term) | Measured against the **score bus**: 13–15 dB. The titans' own drones are not in that bed (they share the effects bus with the impacts), so this flatters the game. | ~ |
| Bed ducks 4–8 dB for 300–600 ms on heavy hits | Median **1 dB**; it reaches 3.5–4 dB only during ultimates | ✗ |
| Loudness range ≥ 10 LU over a round | **3.4 LU** (60 s fight), 5.8–6.1 in the scripted move clips | ✗ |
| Round length 45–90 s; fewer, heavier contacts | Mean **23.4 s** (median 20.4); 5 of 93 rounds in range. 26.4 hits and 9.2 distinct contacts per round, 24 contacts per minute. | ✗ |
| Stable 60 fps at 1080p | **59.6 fps** mean, 1 % low 28.2, 9 frames over 25 ms per 60 s (the worst one is the first frame after start) | ~ |
| Sim p99 ≤ 5 ms per tick | **4.9 ms** over 60 s; max 37.7 ms. A 20 s run measured p99 6.6 ms. | ~ (on the edge) |
| Zero GC pauses > 4 ms in a 3-minute fight | 3-minute fight: 258 main-thread pauses, **6 over 4 ms, worst 14.0 ms** (`baseline-gc.json`) | ✗ |
| Readability blind test ≥ 16/20 | Not run yet (Gate D) | — |
| Equal-level matchup 45–55 % | Last One 43 % vs Planet at L3, n = 30 (BALANCE.md). Not re-run. | ~ |

Clip recording itself costs frames: the three clips ran at 57.6–58.3 fps (60 s clip: 103 frames > 25 ms vs 9 without recording), so a few hitches you see in the
video are the recorder's, not the game's (D24). Flash numbers come from earlier runs of the same scenarios with the luminance read-back on (`*-flash.json`).

## 4. What changed in Phase 0

- `src/telemetry/`: loudness math, worklet, meter, telemetry, strips. Presentation-side only; tested (7 tests, including EBU reference vectors).
- `src/app/app.ts`, `src/app/harness.ts`, `src/contracts/harness.ts`, `src/main.ts`: telemetry hooks and harness API (`run`, `gpu`, `enableTelemetry`, `telemetry`, `armStrip`, `takeStrips`, `unlockAudio`, `recordingStream`, `renderStats`); URL `tele`, `lum`. Rendering takes no extra work unless `tele` is set.
- `src/audio/engine.ts`: `taps()`, an additive accessor for the output, music and sfx nodes. No change to the signal path.
- `tools/lead/rtcapture.ts`, `pacing.ts`, `baseline-gate-a.ps1`, `browser.ts` (Edge on the real GPU on Windows).
- `.gitattributes` (LF everywhere) and line endings normalised. `npm run lint` used to fail on this machine for every file because GitHub Desktop's git checks out CRLF.
- `.gitignore`: `evidence/` (footage).
- Docs: `SLICE_PLAN.md`, this file, DECISIONS D23–D26, PERF real-GPU section, REVIEW_LOG round 0.

## 5. Known issues

- **Instrumentation costs frames, and the costs were measured** (20 s each: fps / frames over 25 ms):

  | Run | fps | Frames > 25 ms |
  |---|---|---|
  | Bare | 58.9 | 6 |
  | Telemetry | 57.4 | 15 |
  | Recording | 56.9 | 32 |
  | Luminance read-back | ≈ 46–48 | — |
  | V8 tracing (all categories) | ≈ 49 | — |

  So: performance figures come from bare runs, GC from a GC-only trace, and flash metrics from the clips that had the read-back on. The clips in `evidence/` were re-recorded with the read-back off (57.6–58.3 fps); the remaining extra hitches are the recorder's.
- **New finding, not caused by Phase 0:** the D3D11 shader compiler warns `use of potentially uninitialized variable (f_sampleScene)` on every Windows load. It was never visible in SwiftShader. S5 fixes it in Phase 1.
- Tests: typecheck, ESLint and Prettier are clean; the last full unit run passed **815/815**. The matter perf guard (`tools/matter/perf.test.ts`) is a wall-clock test. It failed in 2 of 3 full runs on this laptop under full-suite parallel load (p99 6.4 ms vs 5), and it passes alone every time. Phase 1 (S4) will run it serially so it measures the code, not the scheduler.
- The production bundle is 1341 KB, above Vite's 1200 KB warning limit. This is a warning, not an error. Phase 1 will lazy-load the telemetry.
- "First moved pixel" ignores y (the idle bob) and lights (eye flares). Phase 1 replaces it with fighter-reported `feel` events.
- The audio "bed" is the score bus only, until S5 splits the buses in Phase 1.
- Your D1 recording is not in the repo. If you can drop it into `evidence/`, S4 can confirm which path made the hemisphere vanish. The two candidates are the ultimate's shear and a CRUSH shock ring.

## 6. Decisions for you (Gate A questionnaire)

Answer by number. "OK" accepts the recommendation.

1. **Approve the plan** (`SLICE_PLAN.md` §5–6) and its order of work?
2. **Witness rig**: one matter body per rigid region with quantised rotation and a shared rotated hit/render mask (recommended), instead of one body with per-cell region ids. This **amends D4** (no rotation of pixel art) for rig regions only.
3. **Camera push-in**: Phase 1 pushes in with framing, a 3-D scenery dolly and parallax, with sprites staying pixel-exact (recommended). A ≤ 10 % sprite zoom with a sharp-bilinear upscale is built behind a flag for an A/B at Gate B. Accept?
4. **Hit-stop**: lower the heavy cap (13 → about 8 ticks) and carry the weight with real momentum and torque?
5. **Planet rotation**: a two-hemisphere world (committed half-turns swap near and far faces; continuous spin shown by clouds, aurora, moons and ring) rather than continuously rotating surface cells?
6. **Gravity button**: R1, with L1 kept as Feint? On a single sideways Joy-Con, stick-click?
7. **Keep the id `lastone`**, displayed as "The Witness"?
8. **Witness art**:
   - (a) A front-facing eye with a tracking pupil; the eye is the KO core.
   - (b) **4** scythe arms (rather than 6), for the 64 px test.
   - (c) An authored abyss with star specks for the void cavity, rather than a literal see-through window.
   - (d) White-gold/cyan wound light replaces orange everywhere on the Witness, including heat glow and crush fissures.
   - Note: concept panel 04 paints red wounds; I follow the brief.
9. **Aftermath freezes at KO + 1.0 s** of the deciding round?
10. **Loudness**: −20 LUFS integrated. Do you listen on **laptop speakers or headphones**? This sets the sub-bass budget. And what did you record the playtest with?
11. **Slice flag**: menus show only the two titans (and, from Phase 2, the two arenas); `?full=1` shows everything. OK?
12. **Comfort default**: should the flash/shake comfort setting default below 100 %? Do you need formal WCAG 2.3.1 / Harding-style compliance, or are the §4 numbers enough?
13. **ffmpeg** is not installed. Nothing needs it, but it would let me hand you MP4s and trimmed clips. Install it (`winget install Gyan.FFmpeg`), yes or no?

Optional, but useful later: after watching `baseline-aivai.webm`, score the current build 1–5 on the per-titan questionnaire (DESIGN brief §13). That gives us a "before" to compare Gate B against.
