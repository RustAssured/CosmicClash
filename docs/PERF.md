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
