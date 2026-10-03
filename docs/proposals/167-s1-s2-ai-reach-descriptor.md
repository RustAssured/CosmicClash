# 167 — S1 → S2: an AI reach descriptor for kit-driven moves (`extra.aiReach`)

**Owner of the change:** S2 (`src/titans/art/lastone.ts` `witnessMoves`). Additive; no contract change (`MoveDef.extra` is free-form).
**From:** S1 (AI, Lead task A: every Witness move used sensibly at L3+).

## Problem

The AI's move model (`src/ai/moves.ts`) reads a move's reach, timing and energy from its JSON hitboxes. Moves whose hit volumes
come from the live rig (`WitnessKit`) carry none: Halo Shards (all aims), Sweeping Architecture (up / forward) and Revelation.
The model rated them at zero, so the AI never chose them (Revelation: 0 uses; Halo Shards only by blunder).

## What S1 did meanwhile

`src/ai/moves.ts` now builds a stand-in volume for these moves, derived from the kit's constants as of c9e0b9b
(halo radius 60, shards 9 px/tick for 22 ticks from move tick 12 + 3k; arm tips ≈ 120 px from the eye, blade energy 440,
live through active + 60 % of recovery; Revelation 3 + open-eye beams of 276 px fanned ±0.65 rad, 70 energy every 6 ticks
plus 170-energy fractures). It reads `extra.aiReach` first when present, so the kit can own the numbers.

## Ask

When the kit's geometry changes, publish it with the move:

```ts
halo.extra = { ...halo.extra, aiReach: { x0: -20, y0: -45, x1: 250, y1: 45, from: 2, to: 36, energy: 440 } };
// per aim when they differ:
sweep.extra = { ...sweep.extra, aiReach: { up: { … }, forward: { … } } };
```

Fields (facing +1, px relative to the anchor at nominal reach; ticks relative to the first active tick):
`x0, y0, x1, y1` (union box of every volume), `from, to` (window in which any volume is live), `energy` (what a clean
connection is worth), optional `line: { x0, y0, x1, y1, width }` (a beam's principal axis), `beam`, `projectile`.
Volumes that grow with damage (open eyes) can describe the undamaged kit: the AI learns the real yield per foe.
