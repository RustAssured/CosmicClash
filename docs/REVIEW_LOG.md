# Review log

Each round: build → tests → perf → Playwright evidence → look at every image → score 10 categories (1–10) with justification → tasks for every category < 10 → dispatch → integrate.
Stop condition: a complete round yields no task a player would see or feel that is achievable in this architecture.

Categories: pixel-art fidelity & detail · 3D scenery & lighting · destruction readability & physicality · weight & responsiveness · AI intelligence · controller support · audio · UI/UX · performance · code quality & tests.

_(rounds are appended below as they happen)_

## Slice round 0 — Phase 0 baseline (Gate A)

First real-time evidence on WJ's machine (Vega 7, 1080p). Details and sources: `docs/gates/GATE_A.md` §3, `docs/SLICE_PLAN.md` §2–3.
Headlines: input → accept 17–19 ms but first moved pixel 18–36 ms median (tails 86–158 ms); FX occluding wounds ~1.7 s; D1 confirmed (half of a heavy hit's
1.5 s mass loss leaves in one tick, ~98 % as particles); rounds 23 s mean; LRA 3.4 LU, bed duck 1 dB; 59.6 fps mean, sim p99 4.9 ms, GC pauses > 4 ms present.
No scoring of the 10 categories this round: nothing was built; the per-titan questionnaire baseline is requested from WJ.
