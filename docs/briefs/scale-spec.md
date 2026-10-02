# Scale of motion: the spec (Priority 0, D28)

Owner: S1. Tool: `tools/feel/scale.ts` (metrics in `tools/feel/spectrum.ts`). Applies to every owner of moving parts: the
fighter core (S1), the Witness and its tendrils/arms (S2), the Planet, its moons, clouds, aurora and ring (S3), and the camera.

WJ, Gate B: *"tendrils and such and certain moves feel as if much smaller critters are fighting, wobbling fast instead of
feeling like they're scaled in terms of planets."*

## The rule in one sentence

**Things this big cannot turn back quickly.** Input stays immediate: a command still changes a pixel on its accept tick. What
must slow down is how the consequence unfolds. Large masses take a long time to change direction, overshoot once, and
settle. Small parts (tips, moons, clouds) lag the mass they hang from. Nothing reverses direction more than about 1.5 times
a second.

## Targets

| Element | Target | How the tool measures it |
|---|---|---|
| Any body or part signal | Wobble ≤ **1.5 Hz**: no more than 3 turn-backs per second, counting swings > 0.3 px (2 mrad for angles) | `wob` |
| High-frequency motion | Rms of the part of the signal above **2.5 Hz** ≤ **0.3 px** (3 mrad), measured after the first 150 ms of the command or hit. Inside those 150 ms, hit shake is allowed. | `late` |
| Spectrum | ≤ **15 %** of a signal's (detrended) energy above **2 Hz**, unless that band is negligible | `hf` (and `hfA` = its rms) |
| Idle | Breathing period ≥ 3 s; sway ≥ 5 s | `idle` scenario |
| Tendril / arm sway | Period 2.5–4 s, travelling down the length; whip tips leave late and arrive later; no rapid back-and-forth | `parts` rows |
| Turns | ≥ 0.5 s, with counter-rotation (the top lags the new forward) | `reverse` + feel tests |
| Root velocity | Changes over ≥ 0.25 s after the first pixel (no one-tick velocity jumps) | `root x/y` rows: `late` |
| Recoil and knock-back | Long and slow: a shove that brakes over ≥ 0.6 s, a bend that returns in one slow overshoot. Never a spring jiggle. | `hit` scenario |
| Planet | Clouds, moons, aurora and ring move like weather and orbit: slow, continuous, lagging. Never twitchy. | `parts` rows (moons) |
| Camera shake | ≤ 4 Hz, heavily damped (≈ one swing) | `src/engine/camera.ts` tuning |

Rules of thumb for springs, at 60 Hz:
- A spring with natural frequency ω (rad/s) wobbles at ω/2π Hz. **ω ≤ 7 rad/s** for anything visible on a body (≈ 1.1 Hz),
  **ω ≤ 4** for parts that hang off it.
- Damping ratio **ζ ≥ 0.45**: one visible overshoot, not a ring.
- Never set a velocity in one tick. Ramp impulses over ≥ 8–10 ticks (smoothstep). A first pixel on the accept tick is still
  required; get it from a lean/pose kick or a 1-px root step, not from a velocity jump.
- A per-tick random jitter is only allowed as hit shake, and must be gone within 9 ticks.

## Using the tool

```
npx tsx tools/feel/scale.ts                       # orbit (the default footwork), fake world, both titans
npx tsx tools/feel/scale.ts --titans=lastone      # just the Witness
npx tsx tools/feel/scale.ts --json=.scratch/feel/scale-mine.json
npx tsx tools/feel/scale.ts --compare=.scratch/feel/scale-before.json   # before → after in every cell
```

Each scenario records 3 s at 60 Hz. The scenarios are idle, stick start/stop, vertical reversal, Strike, Crush, Surge,
Signature, Guard, and a heavy edge blow taken.

Signals:
- the body's continuous root x/y (with bob, sway, shudder and follow-through), its world lean (px) and its angle (mrad), from
  `FighterImpl.motionSample`;
- every tracked secondary point, as its x and y offset from the root (the body's own travel removed).

Rows outside the spec are starred, and a per-titan count closes the report.

**Tracked points (S2, S3):** implement `Behaviour.trackPoints(out)`. Push the world x,y of the parts that must read at planet
scale, in a stable order: tendril/arm tips and halo segments for the Witness; moons, cloud/aurora/ring markers for the
Planet. Until you do, the tool falls back to the current tendril tips (`sys`) and the moons (`moons`).

## Baseline (before Phase 2, orbit, fake world)

| | Body signals in spec | Part signals in spec | Worst offenders |
|---|---|---|---|
| Witness / Last One | 31 / 36 | 1 / 9 | tendril tips wobble 1.5–3.0 Hz (guard 3.0, hit 2.3, strike 2.2); Crush root and lean jump in one tick (`late` 1.6 / 0.8 px); lean spring 2.4 Hz |
| Planet | 33 / 36 | 7 / 9 | Impact spin keys are one-tick steps (angle `late` 13 mrad); moons in Guard swing 4.4 px above 2 Hz; Impact root jumps |

## Fighter core after S1's Phase 2 pass (same tool, orbit, fake world)

The before row was re-measured with the old numbers put back, so the tool and metric are the same on both sides.

| Change | Before | After |
|---|---|---|
| Lean spring | ω 15 rad/s (2.4 Hz), ζ 0.5 | ω 6.5 (≈ 1 Hz), ζ 0.6 |
| Torsion | ω 9 (1.4 Hz), ζ 0.4 | ω 5 (0.8 Hz), ζ 0.5 |
| Stick → velocity | 70 % of top speed in 0.2 s (ω 8.6) | about 70 % in 0.3–0.35 s (ω 6); orbit thrust 3.6 → 2.5 × top |
| Movement and spin keys | one-tick velocity jumps | smoothstep ramps over 10 ticks (6 for a Surge) |
| Body contact | instant separation and momentum exchange | soft: 12 % per tick, so a collision bends the path over ≈ 0.2 s (cores stay hard) |
| Knock-back | brake τ 0.4 s | τ 0.65 s, knock scale 0.62 → 0.5 (long and slow) |
| Follow-through | decay 0.84 per tick | 0.93 per tick |
| Camera shake | 5–9 Hz, τ 0.14 s | 2.5–4 Hz, τ 0.18 s |

Results:
- Witness/Last One body signals in spec: 33 → 35 of 36.
- Planet body signals in spec: 35 → 36 of 36.
- Lean wobble in strike, surge and turns: halved (e.g. 0.67 → 0.33 Hz). Lean high-frequency share: 8–20 % → 0–1 %.
- The steer `late` value still sits at 0.36 px, just over the 0.3 px limit; it comes from the soft contact at the end of the
  run toward the foe.

Parts (tendril tips, moons) are S2's and S3's; their worst cells are listed by the tool.
