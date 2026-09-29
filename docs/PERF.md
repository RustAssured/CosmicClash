# Performance

Budgets (spec): simulation ≤ **5 ms per tick** for two full bodies + debris on a mid-range laptop; render ≤ 16 ms per frame.

How measured: `npm run perf` (Playwright → headless Chromium with **software WebGL** via SwiftShader) drives `window.__ADEUK__.benchSim/benchFrames`
on scripted AI-vs-AI fights. **Sim ms/tick is representative** (same V8, same typed-array code); **frame ms in software GL is pessimistic** — a real GPU
does the fill-rate-heavy post chain (bloom, god rays, dither) far faster. Builders also keep module-level benchmarks (`tools/matter/bench.ts`, …).

Each builder appends their own section below; the Lead's integrated numbers come last.

## Matter (B2)

Benchmark: `node --expose-gc --import tsx tools/matter/bench.ts` (add `--json` for machine output). Node 22, 4 vCPU Xeon @ 2.8 GHz, **shared with three other builders' processes (load average 6–9 on 4 cores)**, so the `max` columns include OS pre-emption and are an upper bound; averages and percentiles are stable to ±15% between runs. Per-tick time is `world.tick()` only, measured with `performance.now()` around the call (the sim itself never reads a clock; `core.clock`/`core.prof` enable the per-section profiler for the bench). The bench warms the JIT with a 300-tick run first. Bodies: a 168 px layered disc and a 180 px celadon ovoid (~22k cells each), every damage type in rotation, tidal well on one body.

| scenario | ticks | avg | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| 60 s scripted fight (a hit every 24 ticks, all six types) | 3600 | 0.58 | 0.38 | 1.64 | 3.99 | 16.4 (8.5 on a quieter run) |
| saturated: a hit every 4 ticks for 30 s | 1800 | 0.62 | 0.23 | 2.80 | 5.48 | 9.2 |
| pools pre-filled (400 chunks + 6000 particles) + a hit every 4 ticks | 900 | 0.84 | 0.54 | 2.44 | 6.32 | 18.6 (9.7 on a quieter run) |

All values in ms per tick. `renderLayers` (called every 3rd tick in the bench): avg 0.24 ms, p99 0.73 (standard fight); avg 0.58, p99 1.51 with both pools full.

**Verdict against the 5 ms/tick budget:** the mean is 0.6–0.8 ms even with both pools saturated, i.e. ~85% headroom. The p99 (4.0–6.3 ms) sits at or just above the budget only on the ticks where a large blow lands (a FRACTURE cut or a crush shock ring plus the connectivity flood fill of a freshly split body); those ticks are ≤ 1–2% of ticks. Nothing here is amortised across ticks by cheating: TIDAL runs every 3rd tick with its cost carried, connectivity has three urgency levels (6/3/1 ticks), and visuals refresh only dirty 16×16 tiles (glow/infection at 30 Hz). The rare 9–18 ms `max` outliers were not reproducible on a quiet machine (8.5–9.7 ms there) and are worst in the first ~25 ticks of a cold JIT; **call `warmUp()` while loading** (measured: worst of the first 20 fight ticks 13–26 ms cold, 3–9 ms after `warmUp()`; costs ~0.4 s).

Mean ms per tick by section (standard fight): jobs 0.03, cracks+fuses 0.002, thermal 0.03, infection 0.08, connectivity 0.10, shock waves 0.02, chunks 0.03, particles 0.02, visual refresh 0.23, stats 0.05. On the ticks > 2.5 ms the dominant sections are visuals (~1.4 ms), connectivity (~1.3 ms) and chunk extraction (~0.7 ms).

Per call: `applyDamage` FRACTURE 2.8 ms (Dijkstra cuts + crack seeding, the most expensive single call), KINETIC 1.6 ms, CRUSH 1.9 ms, THERMAL 0.08 ms, ASSIMILATION 0.19 ms; `overlap` point r20 91 µs, cone 461 µs; `solidAt` 0.15 µs; `hash()` over two 22k-cell bodies 1.5 ms; `carve()` 100–520 ms (harness only).

Allocation: **idle 1000 ticks (bodies, chunks, particles, burning and infection live) grow the heap by ~6 KB with GC forced.** During fights, allocation happens at *event* rate only (chunk sprites, interned particle ramps, `applyDamage` results); a 1800-tick barrage allocates ~100 MB in total, of which the remainder is `refreshRect` (visual refresh) and shock-ring stepping. Scavenges of that garbage are the likeliest source of the residual p99 tail (V8 `--trace-gc` showed 7–14 ms scavenges under load).

Mass ledger after the 60 s fight: residual −2.5e-5 (exact conservation is asserted in 24 fuzz barrages and the unit tests).

Not measured: real-GPU cost of the layers (matter only fills two pooled 640×360 logical-resolution RGBA layers; upload cost belongs to the renderer), and behaviour on other JS engines.

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

Not measured: any real-GPU time; motion smoothness of the dithered scenery under camera pans (judged from stills only — see the Known issues in the final report).
