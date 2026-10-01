# SLICE PLAN — "The Witness and the World"

*Phase 0 output (audit + baseline). Written by the Lead from five specialist audits (S1–S5, read-only) and the Lead's own
reading and measurements. Every number here was measured on WJ's machine unless marked "estimate". Approve, amend or
reject at **Gate A** (`docs/gates/GATE_A.md`). No gameplay code has been written.*

---

## 0. Environment facts that shape the plan

| Fact | Consequence |
|---|---|
| WJ's machine: **Ryzen 5 5500U, integrated Radeon (Vega 7), ~6 GB usable RAM**, 1920×1080 @ 60 Hz | Not a discrete GPU. Render tier 1 is the realistic default; tier 2 must stay opt-in. At most ~2 heavy jobs (tests, tournaments, captures) at once. |
| The game runs at **58.9 fps mean** (1% low ≈ 18–26) on this GPU at 1080p, sim p99 ≈ 6.6 ms | The 60 fps / sim ≤ 5 ms targets are **not met today** (see §2). |
| Integer upscale: a 1080-px-tall canvas is needed for ×3. In a *windowed* browser the canvas is < 1080 px → **×2 (1280×720, letterboxed)** | WJ should play **full-screen (F11)**. Gate docs state it. |
| GitHub Desktop's git sets `core.autocrlf=true` → every file was CRLF → `npm run lint` failed on this machine for every file | Fixed: `.gitattributes` (`eol=lf`), working tree normalised (no content change). |
| No ffmpeg installed | Not needed: clips are recorded straight to `.webm` (hardware H.264 + Opus) and strips are grabbed in-page at exact sim ticks. ffmpeg would only add trimming/MP4; optional (Gate A question 13). |
| The D3D11 shader compiler (real GPU only) warns `use of potentially uninitialized variable (f_sampleScene)` | A console warning in every build on Windows; never seen in SwiftShader. S5 fixes it in Phase 1. |

## 1. Evidence tooling (built in Phase 0)

| Tool | What it gives |
|---|---|
| `tools/lead/rtcapture.ts <scenario>` | Headed, full-screen Edge on the **real GPU**, nothing stepped. Records `canvas.captureStream(60)` + the game's own audio output (`MediaRecorder`, H.264/Opus) → `evidence/<gate>/<name>.webm`; telemetry JSON + labelled 12-frame strips (exact sim ticks, logical pixels) → `docs/gates/evidence/<gate>/`. Scenarios: `aivai`, `aivai-mirror-*`, `moves-lastone`, `moves-planet`, `latency-*` (real key events through the browser input pipeline), `play` (WJ plays; records until the match ends). Resumable per scenario. |
| `src/telemetry/` (URL `tele=1` overlay + collect, `tele=2` collect only; `lum=0` disables the luminance read-back) | Input → accept and input → **first moved pixel** latency; settle time; per heavy hit: FX occlusion of the wound box (peak / clear ms), shear latency, first slab mass, mass lost within 2 ticks; hits / contacts / length per round; full-frame luminance per frame (max change in 100 ms, WCAG-style flashes/s); EBU R128 loudness on the speaker output and on the score bus (M/S/I, LRA, true peak, impact-over-bed, duck depth); fps, long frames with timestamps, sim ms/tick. Presentation-side only; never read by the sim. |
| `src/telemetry/loudness.ts` + `meterWorklet.ts` | BS.1770-4 K-weighting, gating, LRA, 4× true peak. Passes EBU Tech 3341 case 1/3 and Tech 3342 case 1 in unit tests; the AudioWorklet is tested sample-for-sample against the pure version. Also usable on OfflineAudioContext renders. |
| `tools/lead/pacing.ts` | Headless, deterministic: round length, hits/contacts per round, and per heavy hit how the target's mass left it (largest one-tick loss, routed to particles vs rigid chunks). 40 fights in ~3 min. |
| `tools/lead/browser.ts` | `launch()` now uses Edge on the real GPU on Windows (SwiftShader path kept for Linux/CI); `launchRealtime()` for headed full-screen runs. |

**Measurement honesty.** Instrumentation costs were measured: bare 58.9 fps / 6 frames > 25 ms per 20 s; telemetry only 57.4 / 15; recording only 56.9 / 32; V8 GC tracing ~49 fps. So: perf numbers come only from runs without recording and without the luminance read-back; GC pauses come from a dedicated tracing run; clips are recorded separately and may show a few extra hitches that the game itself does not have (stated in every gate doc). "First moved pixel" counts root x / lean changes only (the idle bob moves y on its own); a move whose first cue is a light (eye flare) is under-credited.

## 2. Baseline vs §4 targets

Full table with sources: `docs/gates/GATE_A.md` §3. Headlines:

- **Rounds are a third of the target length**: mean 23.4 s (median 20.4 s); 5 of 93 rounds in 45–90 s. 26.4 hits / 9.2 distinct contacts per round (`pacing-baseline-L3.json`, 40 fights, L3).
- **D1 confirmed and quantified**: in the median heavy hit on the Planet, **51 % of all the mass it loses in 1.5 s leaves in a single tick, and 98 % of that tick becomes particles**. Overall 58–67 % of removed matter leaves as particles, not slabs.
- **FX clear ≈ 1.75–1.8 s** after a heavy hit (target ≤ 400 ms). **Loudness range ≈ 3 LU** (target ≥ 10). Integrated −16.6 LUFS in-engine (WJ's recording measured −28 → the recorder/OS chain cost ~11 dB; the flatness is real).
- **Input**: accept ≈ 17–19 ms (median, to frame submit), first moved pixel 18–36 ms median with tails to 86–158 ms (stick moves and lean-ramped moves). Settle 0.38–1.85 s (target 0.35–1.2).

## 3. Root causes of D1–D8

**D1 instant cut.** (S3, S4 agree.) The Planet's surface/crust/mantle/ocean/atmosphere carry `resist 4` for CRUSH/KINETIC/FRACTURE (`planet.json`, from `tools/titans/author/planet.ts:144-152`; docs say 3.4, the author tool and JSON disagree). A cell then costs ~0.18 energy, every heavy blow saturates the crater search (`crater.ts:165-177`, `thr = 1`, extent capped `Rl ≤ 50`), and the **whole bowl is removed in one call**; with CRUSH `chunkProb 0.22` and 6×6 blocks needing ≥ 9 cells (`crater.ts:197-311`), ~90 % becomes particles, coloured by the mantle/magma ramps → "small embers". FRACTURE's deferred **chisel** (`CHISEL_DELAY` 3, `fracture.ts:170`) fires right after hit-stop, *before* the slow cuts shear, pulverising the slab the cuts outlined (measured: Shatter → Planet, 381 mass in one tick at +267 ms, 97 % particles; Last Light → Planet 577 at +483 ms, 98 %). Secondary: CRUSH shock rings + tectonic fronts on weak layer bonds can unanchor a whole shell (`crush.ts:175-259`; "fluid never anchors solids", `connectivity.ts:405-438`) which then releases on the next tick (`CONN_NOW`).

**D2 no commitment.** (S1, S2.) Root motion is 1-D velocity keys along facing (`fighter.ts:908-927`); pose is a row-shear lean target (−8 → +11 → 3 px for Shatter); nothing has angular state, mass shift or follow-through. Shatter's +560 px/s lunge runs into the foe and is eaten by per-tick pushback (`vx *= 0.6`, `fighter.ts:1216-1223`) then frozen by hit-stop; Planet Impact nets ~0 px (−34 then +36). The "rake of parallel lines" is `steerWhips` pinning every tendril tip to the cone tip with straight interpolation (`behaviours/lastone.ts:393-429`, `tendrils.ts:204-264`). Knockback is a separate decaying velocity (`kvx/kvy`, τ 0.4 s), not momentum; `DamageResult.impulse` is scaled by 0.02 (negligible). **Every heavy blow hits the 13-tick hit-stop cap**, so hit-stop carries the weight.

**D3 rod tendrils.** (S2.) 12-node chains of 20–40 px, a strong rest spring onto a straight ray, hem tendrils all hanging down; rasterised as 11 independent capsules with linear radius, three fixed shading bands against a world-fixed light, no curve, no joints, no outline (`tendrils.ts:108-264, 476-532`; `fx/overlay.ts:208-258`).

**D4 static camera.** (S1.) Weighted-midpoint framing with 0.42/0.72 s half-lives, no windup awareness (`move/charge/release` ignored, `camera.ts:202-246`), push-in capped at 6 % and decaying in ~100 ms, zoom/roll applied as nearest resampling of the finished frame (uneven pixels, `shaders.ts:503-510`); the box tether keeps both inside 640×360 so the camera barely needs to move; a 31 px core gap + 9 px edge allowance lets silhouettes stack in the centre; scenery reacts only to rings above 800 energy.

**D5 full-screen washes.** (S5.) `fx.flash` whitens the scenery *and* the whole frame twice (`renderer.ts:919, 970` → `shaders.ts:169, 486`); KO flash 0.9 decays per *sim tick*, so under 0.3× KO slow-mo the white lasts ~0.8 s; scenery impulse glow tints ~the whole frame orange for up to 2.2 s (`toolkit/glsl.ts:90-103`, radius ×1.6); `intensity` steps global exposure and stage multipliers up to ×1.7 on every hit; bloom/aberration uncapped; the comfort slider only touches flash + aberration.

**D6 flattened audio.** (S5 + measured.) Ratio-5 compressor at −16 dB with automatic makeup gain (`engine.ts:192-197`) packs every heavy event into a narrow band; sub thumps dominate its detector; the "duck" is 0.4–1.4 dB on music only (`engine.ts:427, 527-537`); titan beds share the sfx bus with impacts (cannot be ducked); a 3.4 s reverb at 0.55 wet fills the gaps; the score gets *quieter* as the fight intensifies. Measured LRA ≈ 3 LU, true peak −3.4 dBTP, duck 1–2 dB.

**D7 cursor.** Nothing hides it (no `cursor` style anywhere in `index.html`/app).

**D8 feel never judged in motion.** Fixed by the tooling above; `feel.test.ts` asserts state, not pixels (S1) — Phase 1 tests assert pixels.

## 4. Architecture decisions (WJ decides at Gate A; Lead recommendation first)

1. **Witness rig = one MatterBody per rigid region** (eye cradle, carapace, shrine, halo segments, 2–4 segments per arm), connected by a deterministic XPBD graph in `src/combat/rig/`, with **LUT-quantised rotation per region body** and **one cached rotated mask per (body, angle) shared by hit-testing and rendering**. Recommended by S4 (matter owner) and S1: connectivity, stats, hashing and the mass ledger stay per-body and untouched for the other titans; severing a joint transfers a region body to a chunk exactly (`bodyToChunk`). Rejected: one body with per-cell region ids (S2's preference) — it breaks every row-range fast path in `body.ts` for all titans and gives bonds across rotated seams no meaning; pre-baked rotation frames (stale under destruction); translate-only regions (cannot make scythe arcs). Requires **amending D4**: "whole bodies keep integer row-shear lean; rig regions may rotate by quantised angles; hit truth = the same rotated mask the renderer samples; ≤ 1 px silhouette disagreement at rotated edges, tested." Rendering: one layer with **parts** (sub-rect + pivot + angle), sampled on the GPU with a clean-edge rotation shader (CPU RotSprite at 60 fps would cost 100–200 ms/frame — not viable). A **rotation spike** (S4 matter + S5 renderer + parity test) runs in Phase 1 so Phase 2 starts on proven ground.
2. **Camera push-in without breaking pixels**: Phase 1 pushes in with framing + a 3-D scenery dolly + parallax while sprites stay 1:1 (amends D5's "camera pans, does not zoom" only for scenery); a ≤ 10 % sprite push using a sharp-bilinear final upscale is built behind a flag for an A/B at Gate B.
3. **Orbital footwork** behind a flag (`orbit=1`) next to the current locomotion; the 360-px-tall view forces flattened elliptical orbits (y weighted ~1.6); the optional z-offset is prototyped behind `zdepth=1`. WJ decides at Gate B.
4. **Hit-stop rebudget**: heavy hit-stop cap lowered (13 → ~8 ticks) and the weight carried by real impulse (linear + angular, lever arm), knockback becomes momentum.
5. **Planet rotation model**: a *two-hemisphere world* — the shell (surface → mantle) exists twice (near face / far face), committed half-turns (Brace, Tidal Rush follow-through, side switch) swap them exactly, the core is shared; continuous spin is shown by clouds, aurora, moons and the debris ring; during a turn a globe overlay projects both faces. Damage geography becomes "which face is toward you". Rejected: continuously migrating cells (XL; breaks bonds, cuts, connectivity).
6. **Gravity button = R1** (`Btn.GRAVITY`), L1 stays Feint. Sideways single Joy-Con: Gravity on stick-click (it has no spare shoulder).
7. **Keep the id `lastone`**, display name "The Witness" (no registry/contract churn; old saves/remaps keep working).
8. **Witness art**: front-facing eye with a tracking pupil; the eye is the KO core ("its light goes out last"); **4 scythe arms** (thin arcs vanish at 64 px; 6 is the brief's maximum); the void cavity is an authored, palette-stable abyss with star specks (a literal see-through window would show each arena's colours, e.g. orange); white-gold/cyan wound light also replaces the hard-coded orange CRUSH fissure and the ember heat ramp on the Witness.
9. **Slice flag**: `SLICE` in `src/contracts/constants.ts` lists the two titans and (from Phase 2) the two arenas; menus, attract and the AI pick only from it; `?full=1` shows everything; the other four titans and five stages keep compiling and their tests stay green.
10. **Aftermath freezes at KO + 1.0 s** of the deciding round (debris still alive), not at match end (by then the 3 s outro has dissolved most particles).
11. **Loudness target −20 LUFS integrated**, −1 dBTP ceiling (lookahead true-peak limiter worklet), duck on a new bed bus.

## 5. File plan

Ownership: Lead = `src/contracts`, `src/sim`, `src/app`, `src/telemetry`, `docs/`, `tests/`, `e2e/`, `tools/lead`. S1 = `src/combat` (core, camera-facing events, `orbit`, `impact`, `pose`), `src/engine`, `src/ai`, `tools/feel`. S2 = `src/titans/lastone.json`, `src/titans/art/lastone.ts`, `src/combat/behaviours/{lastone,tendrils}.ts`, `src/combat/rig/`. S3 = `src/titans/planet.json`, `src/titans/art/{planet,comet}.ts`, `tools/titans/author/planet.ts`, `src/combat/behaviours/planet.ts`. S4 = `src/matter`, `tools/matter`, aftermath view logic (`src/app/aftermath.ts` via proposal). S5 = `src/render`, `src/stages`, `src/audio`. Cross-cutting needs → `docs/proposals/NNN-*.md`; the Lead applies contract/app changes.

**Reuse as is**: fixed-tick loop, input buffer (9 ticks), move phase machine and cancel windows (they meet §4), analytic hit shapes, `sim/sources.ts`, chunk rotation + nearest rasteriser, `extractChunk` (places pieces exactly), ArtCanvas paint toolkit and `paintEye`/`paintHaloDetail`, moon bodies/modes, `GravitySource`, stage toolkit (`bake`, `pillars`, `streams`, `nebula`, `stars`), body lights (4 shader slots, 2 used), voice primitives, the tournament/autotune harnesses.

**Modify** (owner): `fighter.ts` integrate/steer/separation/receive/pose/fireKeys/faceFoe, `move.ts`, `shapes.ts` (aim angle), `tuning.ts`, `feel.ts`, `camera.ts`, `ai/controller.ts` + `ai/moves.ts` (S1) · `art/lastone.ts`, `lastone.json`, `behaviours/lastone.ts`, `tendrils.ts` (→ fibres/membranes), `generate.ts` (S2) · `planet.json` (resist, lean, flash), `behaviours/planet.ts`, author tool resync (S3) · `crater.ts`, `fracture.ts`, `cracks.ts`, `debris.ts`, `chunks.ts`, `connectivity.ts`, `visual.ts`, `blowfx.ts`, `hash.ts`, `world.ts` (S4) · `shaders.ts`, `renderer.ts`, `foreground.ts`, `stages/types.ts`, `toolkit/glsl.ts`, `audio/engine.ts`, `audio/dsp/math.ts`, `score/engine.ts`, `dev/render/verify.ts` (its "flash brightens the frame" check is inverted) (S5) · `app/fx.ts`, `app/app.ts`, `contracts/*`, `sim/match.ts` (symmetric collision pass, hash additions) (Lead).

**Create**: `combat/orbit.ts`, `combat/impact.ts`, `combat/pose.ts`, `tools/feel/measure.ts`, `ai/space2d.ts` (S1) · `combat/rig/xpbd.ts`, `combat/rig/pose.ts` + tests (S2) · `art/comet.ts`, globe overlay (S3) · `matter/wound.ts`, `matter/orbit.ts` (Tidal Draw capture) (S4) · `stages/mausoleum/`, `stages/shearfield/`, `audio/worklets/limiter.ts`, Witness/Planet material voices (S5) · `sim/arena/comets.ts` (deterministic comet schedule, hashed) and `app/aftermath.ts` (Lead).

**Contract changes the Lead publishes before Phase 1 starts** (from the proposals in the audits): `SimEvent` `feel` (accept / respond / settle with pixel channel), `flash` gains x,y (and stops being full-screen), `LightFx.kind: 'body' | 'impact'`; `DamageEvent` optional impulse + hit-stop ticks; wound/hold fields are matter-internal; `Btn.GRAVITY`; `SLICE`; `MatchApi` symmetric pair resolution + hashed angle/ω/z state. Phase-1-end (after the spike): `BodyTransform.rot`, `RenderLayer.parts`, `MatterWorld.{bodyToChunk, jointHealth, chunksInShape, launchChunk, captureChunk}`, `FrameFx.comets/wells`.

## 6. Order of work

**Phase 1 — feel graybox (current art)**, in parallel by owner, integrated by the Lead at least twice a week with captures:
- **S1**: (1) pixel-first anticipation: every command moves a root pixel or a light on its accept tick; feel tests assert pixels; `feel` events. (2) Impact model: contact point + lever arm → linear and angular impulse; knockback as momentum; hit-stop rebudget; centre/edge/glancing/low classification. (3) Re-choreograph Shatter Blow and Impact as load → commit → recover (2-D root motion along the attack axis, whole-body lean/torsion, follow-through). (4) Orbital footwork integrator (`orbit=1`) + radial tether + symmetric 2-D separation; z-offset prototype (`zdepth=1`). (5) Camera: windup push-in (scenery dolly + framing), lagged pull-back, ω-driven roll ≤ 1.5°, impact parallax hook; sharp-bilinear sprite push behind a flag. (6) Minimal 2-D AI spacing so tournaments keep working; 100-fight check.
- **S4**: D1 — wound records; crater split (pulverise only a capped core, extract the rest as **held slabs** that are drawn in place with a visible crack on the impact frame and shear 80–300 ms later with the wound's momentum and lever-arm spin); chisel after shear; hairline cuts with per-wound deadlines; big islands split along grain seams; FX/plume timing so occluders clear ≤ 400 ms; pool policy (never degrade young/held chunks; near-cap demotion bug at `chunks.ts:646`); D1 regression test; recalibrate tables. Then the rotation spike (matter side).
- **S3**: Planet resist recalibration with S4; drop the pose lean (a world does not shear); remove the quake flash; spin/θ/L state with input-frame telegraphs (clouds streak, aurora, moon phase, ring tightening) on the existing moves; facing-override Brace prototype; commitment on Impact/Moon Slam.
- **S5**: D5 (flash → localized impact lights with a 3/s onset gate, localized refraction for KO, impulse-glow cap, intensity slew limit, comfort covers every path, a GPU luminance governor, verify checks inverted); D6 (buses: impact / bed / ui, lookahead true-peak limiter worklet, gentle bed glue, 4–8 dB bed duck for 300–600 ms on heavy hits, sub high-pass, reverb trim, score thin-at-neutral/swell-on-commitment, calibrated to −20 LUFS); fix the D3D shader warning; renderer side of the rotation spike.
- **S2**: D3 spline renderer (Catmull-Rom, tapered, per-pixel normal shading, outline, joints) applied to the current tendrils — it becomes the Witness arm/fibre renderer; Witness painter in rest pose as an offline contact sheet + 64 px thumbnail for Gate B (not wired into the game).
- **Lead**: contracts above; D7 cursor hide; `fx.ts` flash/intensity rework with S5; slice flag; telemetry consumes `feel` events; Gate B doc.

**Gate B** (WJ plays with a controller): z-offset yes/no, controller mapping via Controller Check, sprite push A/B.

**Phase 2**: Witness (rig, regions, painter, reveal layers, six moves, failure), Planet (two-hemisphere shell + globe overlay, phases, seven moves, Comet Shepherd, Tidal Draw with S4 capture API, failure), arenas (Mausoleum, Shearfield, ≥ 3 reactive depth layers, sim-side comets), aftermath screen, material voices, debris persistence/cooling/caps. **Gate C.** **Phase 3**: evidence loop to Gate D (blind readability test).

## 7. Risks (ranked) and mitigations

1. **Rotation vs pixel-accurate hits** (Witness). Mitigation: per-region bodies with quantised angles, one shared rotated mask, a dense-grid parity test, Phase 1 spike before Phase 2 commits.
2. **Performance on Vega 7**: sim p99 already 6.6 ms; held slabs, more debris, orbit, rig and two new arenas all add cost. Mitigation: perf runs every integration (bare, real GPU), pooled sprite arenas for slabs, chunk sleep with wells, tier-1 default, arena fill budget ≤ nursery, a perf owner per change.
3. **Balance/AI collapse** under orbital footwork and new kits. Mitigation: 2-D AI spacing first, tournaments `--titans=lastone,planet` with 2 workers (RAM), resumable.
4. **Determinism coverage**: new state (angle, ω, z, held slabs, waves, slow-cut contents) must be hashed; `forceFullConn` equivalence tests extended.
5. **Contract churn across 5 owners**. Mitigation: contracts published before Phase 1, additive-only during it.
6. **KO feels weaker without the wash**. Mitigation: stronger local light + refraction + audio hush; A/B clips at Gate B.
7. **Laptop RAM** (6 GB): ≤ 2 heavy processes; captures never overlap tournaments.

## 8. Docs to update as work lands

`DECISIONS.md` (D23+ below and the Gate A outcomes), `DESIGN.md` §1.1/§4 (orbit, rotation, camera), `DESTRUCTION.md` (wound sequencing), `TITANS.md` (regenerate), `PERF.md` (real-GPU section added in Phase 0), `REVIEW_LOG.md` (per-gate rounds), `README.md` (full-screen, slice flag).
