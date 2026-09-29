# Performance

Budgets (spec): simulation ≤ **5 ms per tick** for two full bodies + debris on a mid-range laptop; render ≤ 16 ms per frame.

How measured: `npm run perf` (Playwright → headless Chromium with **software WebGL** via SwiftShader) drives `window.__ADEUK__.benchSim/benchFrames`
on scripted AI-vs-AI fights. **Sim ms/tick is representative** (same V8, same typed-array code); **frame ms in software GL is pessimistic** — a real GPU
does the fill-rate-heavy post chain (bloom, god rays, dither) far faster. Builders also keep module-level benchmarks (`tools/matter/bench.ts`, …).

Each builder appends their own section below; the Lead's integrated numbers come last.
