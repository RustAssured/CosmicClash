# Performance

Budgets (spec): simulation ≤ **5 ms per tick** for two full bodies + debris on a mid-range laptop; render ≤ 16 ms per frame.

How measured: `npm run perf` (Playwright → headless Chromium with **software WebGL** via SwiftShader) drives `window.__ADEUK__.benchSim/benchFrames`
on scripted AI-vs-AI fights. **Sim ms/tick is representative** (same V8, same typed-array code); **frame ms in software GL is pessimistic** — a real GPU
does the fill-rate-heavy post chain (bloom, god rays, dither) far faster. Builders also keep module-level benchmarks (`tools/matter/bench.ts`, …).

Each builder appends their own section below; the Lead's integrated numbers come last.

## Matter (B2)

Benchmark: `node --expose-gc --import tsx tools/matter/bench.ts` (`--json` machine output, `--assert` exit code on budget breaches, `REPS=n`); regression guard `tools/matter/perf.test.ts` (part of `vitest run`). Node 22, 4 vCPU Xeon @ 2.8 GHz, **shared with the other builders' processes (load average 3–13 on 4 cores while measuring)**.

**Method.** Wall-clock per-tick numbers on a shared machine are polluted by OS pre-emption, and `process.cpuUsage()` / `threadCpuUsage()` only advance in ~4 ms steps here, so neither can resolve one tick (main-thread CPU time is still reported, averaged over a whole run).
The simulation is deterministic, so every scenario is **replayed 5 times and the per-tick MINIMUM is judged** ("load-robust"): scheduler noise disappears, everything the simulation itself causes (allocation, GC it triggers, cache misses, JIT-independent work) stays. The pooled raw wall-clock samples of all replays are printed next to it.
A "step" is what `Match.step()` pays for the matter world: `applyDamage` (on the ticks that have a hit) + `world.tick()`. Bodies: a layered disc and a celadon ovoid; **r=84 (~22k cells each) is a stress size, twice a real titan; r=55 (~10k cells) is the real size** (Last One 176×176 map, Asteroid 144×128).
Every damage type in rotation, a gravity well on one body, the section profiler on.

Step = applyDamage + tick, ms, load-robust (min of 5 replays):

| scenario | ticks | avg | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| 22k cells, 60 s fight (a hit every 24 ticks, all six types) | 3600 | 0.31 | 0.28 | 0.80 | 1.36 | 4.22 |
| 22k cells, **saturated** (a hit every 4 ticks) | 1800 | 0.40 | 0.20 | 1.53 | **2.22** | **3.40** |
| 22k cells, pools full (400 chunks + 6000 particles), a hit every 4 ticks | 900 | 0.51 | 0.30 | 1.72 | **2.66** | **3.33** |
| 10k cells (real size), 60 s fight | 3600 | 0.07 | 0.01 | 0.42 | 0.79 | 1.53 |
| 10k cells, saturated | 1800 | 0.17 | 0.07 | 0.75 | 1.25 | 2.18 |
| 10k cells, pools full | 900 | 0.21 | 0.12 | 0.70 | 1.30 | 1.77 |

Raw wall clock of the same runs (all replays pooled, machine quiet at that moment): p99 2.4-3.4 ms / max 5.6-12.6 ms at 22k, p99 1.0-1.6 ms / max 4.4-7.1 ms at 10k; under load 10-13 the raw max reaches 40-170 ms (whole-process pre-emption, not reproducible tick-for-tick). CPU per tick (main thread, averaged): 0.47 / 0.52 / 0.76 ms at 22k, 0.13 / 0.26 / 0.43 ms at 10k.
`renderLayers` (every 3rd tick in the bench): avg 0.14-0.66 ms, p99 0.3-1.3 ms (5.7 ms once with both pools full at 10k under load).

**Verdict against the Lead's round-2 targets** (saturated: p99 <= 3 ms, max <= 5 ms; single `applyDamage` FRACTURE/KINETIC/CRUSH <= 1.5 ms): met at both sizes. The worst tick of the 22k fight is a full connectivity flood that frees a big slab (3.4 ms of 4.2). Regression assertion: `perf.test.ts` fails if the saturated 22k scenario's load-robust p99 exceeds 3.5 ms (and a real-size, pools-full run's p99 3 ms).

Mean ms per tick by section (22k saturated): jobs 0.10, cracks+fuses 0.00, thermal 0.04, infection 0.02, connectivity 0.05, waves 0.01, chunks 0.02, particles 0.04, visual refresh 0.10, stats 0.04. On the worst ticks the mass sits in connectivity (full floods), visual refresh (~0.5 ms) and jobs (TIDAL fields / the deferred FRACTURE chisel, ~0.3-0.4 ms).

Per `applyDamage` call on a 22k-cell body (load-robust, 40 random events per type at 300-2200 energy; p50 / p90 / max ms): FRACTURE 0.93 / 1.45 / 1.54, KINETIC 0.63 / 1.00 / 1.03, CRUSH 0.82 / 1.05 / 1.17, THERMAL 0.13 / 0.16 / 0.16, ASSIMILATION 0.09 / 0.22 / 0.24. At the real size (10k cells): FRACTURE 0.44 / 0.53 / 0.61, KINETIC 0.35 / 0.40 / 0.44, CRUSH (1500 energy) 0.83 / 0.87 / 1.40. `overlap` point r20 0.04 ms, cone 120 0.35 ms, `solidAt` < 1 us, `hash()` over two 22k-cell bodies 0.45 ms, `carve()` 100-520 ms (harness only).

What changed in round 2 to get here (before: p99 2.7-4.5 ms, applyDamage FRACTURE 2.8 / CRUSH 1.9 ms cold or under load, raw max up to 19 ms):
- **Crater engine**: candidates are scanned straight from the body-local box around the impact (no world-space shape query, no per-cell weight call), compacted in place to the cells the later passes can touch (elliptical distance <= 1.75), and the value noise is only evaluated in the band where it can change the outcome: CRUSH 1500 energy 1.5-2.5 ms -> 0.8-1.0 ms.
- **Deferred chisel**: FRACTURE's chewing share runs 3 ticks after the blow from the job queue (also keeps slabs intact: connectivity has released them by then), so the blow tick is cheaper.
- **Connectivity**: the full flood (O(body), ~1 ms at 22k cells) is replaced by a *local pass* from the changed spots whenever it can prove the result (nothing cut off, or only small complete islands): ~50% of the passes and ~80% of their cost in a fight; the full flood remains for big slabs, core-disc losses, fluids and matter added. Proven equivalent: `core.forceFullConn = true` gives bit-identical state hashes (16 scenarios in the unit tests, an 80-scenario sweep offline).
- Visual fast path no longer touches the material object for pristine cells; `warmUp()` pre-JITs the hot paths (worst of the first 20 fight ticks 13-26 ms cold -> 3-9 ms).
- Tried and dropped: goal-directed (A*) cut search (no gain: the heuristic is weak next to bond-weighted edge costs), a larger local-search budget (12000 cells made the worst ticks worse).

Allocation: **idle 1000 ticks (bodies, chunks, particles, burning, infection live) grow the heap by 8 KB with GC forced.** During fights allocation is at *event* rate only (chunk sprites, interned particle ramps, `applyDamage` results, job copies). Mass ledger residual after the 60 s fights: 8e-5 (exact conservation is asserted in the fuzz barrages and unit tests).

Not measured: real-GPU cost of the two 640x360 layers (upload belongs to the renderer), other JS engines, and the integrated Match.step() (fighter ticks + AI + sim).

## Render (B1)

Measured with `node tools/render/perf.mjs [--layers]` (Playwright → headless Chromium, **SwiftShader software WebGL2**, 1280×720 viewport, the nursery with two test bodies, a UI layer and sparks; the dev server on :5201). **The rasteriser runs on the same 4 shared vCPUs as everything else** (load average 7–10 while these numbers were taken, three other builders running tests), so wall times are heavily pessimistic and ±30 % noisy; they show *relative* cost. The representative numbers are the **CPU-side ms per `draw()`** (all our JS + GL command submission, no rasterisation) and the **fill estimate** (fragments shaded per frame, machine independent).

| tier | scenery target | CPU ms / `draw()` | software-GL wall ms / frame (no scenery layers → full) | scenery fragments / frame | + post & present |
|---|---|---|---|---|---|
| 0 | 640×360, ×0.4 particles, 3 bloom levels, 16 ray taps | 3.5 – 8 | 65 → 590 | 4.2 M | 1.6 M |
| 1 | 640×360, ×0.7 particles, 4 levels, 28 taps | 1.2 – 7 | 65 → 875 | 5.7 M | 1.6 M |
| 2 (showpiece) | 1280×720 supersample, ×1 particles, 5 levels, 44 taps | 3 – 4 | 85 → 2 700 | 28.3 M | 1.6 M |

* **CPU per `draw()` is 3–8 ms** (the spread is scheduler noise on the loaded box; a quiet-box median is ≈ 3.5 ms at every tier): one `renderer.render` for ~26 scenery layers, one for the 2D layers, ~14 full-screen passes, uniform packing. It is independent of scenery complexity (a GPU-bound frame). No per-frame allocation in our code (compositor, layer cache, fx packing and the scenery frame are preallocated; verified by reading the hot path — not by a heap profile).
* **The non-scenery part of the pipeline** (lens + palette dither + 2D layers + 5-level bloom + 44-tap god rays + post + integer upscale) costs 65–175 ms per frame *in software*, ≈ 1.6 M fragments; that is ≈ 0.6 ms on a 3 Gfrag/s integrated GPU.
* **Scenery fill** dominates. Per-layer wall cost at tier 2 (software; `--layers`): particle nebula 1.2 s, the fbm layers (`glow`, `gas-mid`, `sky`, `dust-lanes`, `mist`) 0.25–0.4 s each, pillars 0.06–0.12 s each, stars/wisps/hero stars < 0.05 s. At 3 Gfrag/s (a conservative blended-fragment rate for an integrated GPU) the estimate is **≈ 1.9 ms (tier 0), 2.4 ms (tier 1), 10 ms (tier 2)** — inside the 16 ms budget, but tier 2 is ALU-heavy (five fbm layers at 4× the pixels) so on an old iGPU it may not hold 60 fps. **Recommendation:** default to tier 1 (still full-quality art at the logical resolution) and enable tier 2 on discrete GPUs / when `renderer.stats` + frame pacing show headroom. *This is an estimate, not a measurement on real hardware.*
* **Load time:** `setStage('nursery')` ≈ 2.5 – 4 s in software (shader compilation ≈ 1 s, palette LUT 70–180 ms, two GPU pillar bakes ≈ 0.3 s on a real GPU); warm re-entry ≈ 0.3 s. The LUT build is CPU (`buildDitherLut`: 48³ nodes ≈ 180 ms in Node). Call `setStage` on the stage-select screen.
* **Uploads:** the layer texture cache uploaded exactly the dirty rect in the GPU verification (64 texels for an 8×8 change on a 640×360 layer) and nothing for unchanged versions (`node tools/render/verify.mjs`).
* Frame *interval* in the sandbox on this box is ~0.4–4 s (software), so real-time behaviour was judged from stills and from the deterministic checks, not from motion.

**Integrated per-stage sweep (round 3, all five stages, `npx tsx tools/lead/perf.ts --all --ticks=600 --frames=12` against a build in `.scratch/b1dist`, software GL, quality `auto` = tier 0 after the controller settles, loaded shared box).** Frame numbers are software rasteriser wall time and only show *relative* stage cost; sim ms is not mine (B2/B3 dominate it).

| matchup @ stage | frame ms (software) | draw ms (software) | fps (software) |
|---|---|---|---|
| lastone vs asteroid @ nursery | 698 | 297 | 1.4 |
| nexus vs planet @ rim | 562 | 289 | 1.8 |
| blackhole vs supernova @ quasar | 540 | 223 | 1.8 |
| planet vs blackhole @ redgiant | 388 | 274 | 2.6 |
| supernova vs nexus @ tussenruimte | 321 | 203 | 3.0 |

The nursery (two GPU-baked pillar layers + 5 fbm layers) is the most expensive stage; tussenruimte (sparse) the cheapest; rim's galaxy adds ≈ 40k instanced stars at tier 2 (thinned ×0.45/×0.75 at tiers 0/1). Stage load with `prepareStage` is spread over 36–55 frames of ≈ 5 ms slices (longest single slice = one shader compile: 35 ms quiet, up to 310 ms when the box was loaded). Unchanged: no real-GPU numbers exist.

Not measured: any real-GPU time; motion smoothness of the dithered scenery under camera pans (judged from stills only — see the Known issues in the final report).
