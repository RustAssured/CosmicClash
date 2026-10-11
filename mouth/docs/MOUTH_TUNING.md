# THE MOUTH — approved tuning
Source of truth: `src/30_mouth_core_motion_damage.js`. WJ's tuning is the default.

## Feel (sliders, 1.00 = neutral)
slide speed **243 px/s** · strike speed **1.18** · neck weight (lag) **1.00** · reach **0.90** · tracking speed **1.39**

## Anchor and arena
perimeter = arena rectangle; corners rounded (normal blend radius 110 px); neck exit 48 px inward from the edge
slide: velocity eases toward target at 2.2/s; ×0.55 at corners; ×0.2 during a strike or knockout
auto-aim arc ±1.35 rad around the edge normal; target locked at the moment of commanding a strike

## Moves (seconds; strike/sweep durations ÷ strike speed × height factor)
bite: load .42 · strike .18 · bite .16 · hold .12 · recover .70
sweep: load .38 · sweep .50 · bite .14 · recover .75 (arc ±1.1 rad around the aim)
coil & crush: reach .36 · coil .70 · crush .40 · release .80
height: high = duration ÷ 0.85 (slower), reach × 1.12, arc offset −200 px · low = duration ÷ 1.3 (faster), reach × 0.88, arc offset +200 px · straight = 1, 1, 0
max reach 520 px × reach × height factor; idle reach min(230, 0.55 × distance)

## Head and neck
head spring: idle k = 7 × tracking × (0.5 + 0.5·hp) / (lag × (1 + 0.8·(1−hp))); in moves k = 28 × beat stiffness; ζ 0.9
head speed cap: 520 px/s (rest), 1300 px/s (strike/sweep)
neck: 24 samples; authored cubic from exit to head (bend, wind-up folding waves amplitude up to 26 px)
neck sample springs: k = 150 × (1 − 0.72·sin(πf)) × (1.5 in moves) / lag, ζ 0.95; base samples pinned
neck strands: 8; braid radius (25 − 7f) × vol (+ flare at the funnel); strand radius (14.5 − 4.5f) × vol; vol = √(250/L) clamped 0.82–1.22
head: Rh 58 px, funnel length 1.9 Rh, neck radius at funnel 24 px

## Head behaviour layer (targets per beat: gape · ring spread · roll · stutter · grind)
rest 1 ± 0.14 breathing (rare +0.12 twitch) · 0.08 · ±0.25 · 0.12 · 0
load/reach 1.5 · 1.05 · 1.1 · 0.6 · 0 — strike/sweep 1.55 · −0.3 · 2.0 · 0.3 · 0 — bite/hold/crush 0.42 · −0.4 · 2.4 · 1.0 · 1
coil 1.25 · 0.35 · 1.8 · 0.5 · 0 — recover/release 0.95 · 0.15 · 0.6 · 0.35 · 0
springs: gape k 210 ζ 0.46 (the snap) · spread k 90 ζ 0.55 · roll k 22 ζ 0.8 · pulse 0.018 × sin(t·(2.2 + 3·stutter))
ring spin rate per beat: rest 1 · load 3 · strike 4 · bite 0.3–0.4 · recover 1–1.2; ring clamp at bite: radius × 0.76

## Impact
hitstop 0.11 s · shake 13 · three shockwaves (420 px/s) · flash · debris 170 (60 rock, 70 slime, 40 bone) — placeholder visuals, see shared VFX spec

## Coils
4 strands × 4 sub-strands; braid radius 35 ± 5; strand radius 27 ± 5; perimeter control points at −330…+340 px around the anchor; depths −130…+8 px (beyond the edge); slow writhe; pay-out tightens loops (depth × (1 − 0.35·pay), spacing × (1 − 0.18·pay))

## Damage
health 100; head hit −4 × power (teeth + ring chip; ring hp 5); neck −5 × power (× 1.6 when stretched: strike/bite/hold/recover/sweep/release); coil −2 × power
strand severs at 2.5 accumulated; severed strands ≥ 3 at KO → severed knockout
degradation: slide × (0.55 + 0.45·hp); tracking × (0.5 + 0.5·hp); lag × (1 + 0.8·(1 − hp)); stutter + 1.2·(1 − hp)
KO timeline (drag): 0–0.9 s convulse · 0.9–2.2 s slack · 2.2–5.2 s dragged over the edge · restore (prototype) 8.5 s
KO timeline (sever): head loose (drifts, rotates, rings fall at 1 s + 0.6 s each) · stump retracts over 1.6 s · coils withdraw from 2.5 s
