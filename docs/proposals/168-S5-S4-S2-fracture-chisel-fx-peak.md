# 166 — S5 → S4 (cc Lead, S2): Gate C "FX peak ≤ 100 ms" regression is the deferred FRACTURE chisel

**Owner of the change:** S4 (`src/matter`), with S2 for the Witness's own overlay. **Author:** S5. **Status:** proposed.

## Finding

Live Gate C captures show a median FX peak of 179–184 ms (target ≤ 100 ms; before the rebalance it was 56–92 ms).

I measured it offline with a real AI-vs-AI orbit match, the Witness against the Planet (seed 21 and up, 420 s). The script reproduces telemetry's `coverage()` box (r = 26, following the target) on wall-clock frames, hit-stop included.

**Planet CRUSH on the Witness peaks on time.**

| Energy | Peak | Peak coverage |
|---|---|---|
| 1029 | 17 ms | 0.07 |
| 923 | 33 ms | 0.08 |
| 717 | 0 ms | 0.08 |
| 672 | 33 ms | 0.09 |
| 753 | 0 ms | 0.13 |

**Witness FRACTURE on the Planet peaks late.**

| Energy | Peak | Peak coverage | Main occluders at the peak |
|---|---|---|---|
| 1086 | 250 ms | 0.17 | lastone-fx 0.13 |
| 974 | 233 ms | 0.18 | fx-front 0.10, planet-fx 0.07 |
| 932 | 217 ms | 0.19 | fx-front 0.17 |
| 793 | 167 ms | 0.18 | fx-front 0.18 |
| 1159 | 183 ms | 0.38 | fx-front 0.20, lastone-fx 0.17 |
| 1110 | 417 ms | 0.19 | debris-near 0.14 |
| 1085 | 467 ms | 0.11 | — |
| 2223 | 117 ms | 0.44 | fx-front 0.43 |

These are all after the 133 ms hit-stop.

## Cause

`impactBurst` (blowfx.ts) peaks on frame 0 as designed, and its size saturates at energy ≈ 830 (`k ≤ 2.6`).

The late peak is the deferred chisel instead. `fracture.ts` sets `ctx.chisel = … (Eraw × GOUGE_BASE + unspent cut energy)`, and `world.queueChisel` runs it one tick after the wound's shear, which comes after the hit-stop. Its dust and shards land in `fx-front` / `debris-near` on the wound, after the opening burst has already faded.

The chisel budget scales with the RAW event energy, and that energy now carries `balance.power` 3.0. So the late pit, and its dust, is about three times what it was, and it outgrows the opening burst.

## Asks

1. **S4:**
   - Cap the chisel's VISIBLE output relative to the blow's opening burst: fewer, smaller and fainter particles, with a short life. The pit itself is unchanged.
   - Or emit the chisel's dust behind the body (z < 10, or not `PF_NEAR` / `fx-front`) rather than in front of the wound.
   - Either way, the FX coverage stays highest on the impact frame.
   - Suggested acceptance: a re-run of the measurement above shows a median peak ≤ 100 ms for FRACTURE.
2. **S4 / Lead:** decide whether the chisel and slab sizing should see balance-free energy at all. Balance is a gameplay knob; it should not resize presentation.
3. **S2:** `lastone-fx` (the Witness's attack overlay) covers the struck wound at 180–250 ms on two of the hits (0.13 and 0.17). Its trail should fade by the end of the hit-stop where it crosses the wound.

## What S5 changed on its side

- Audio, FxState lights, rings and the score's heat now use presentation energy, which is the event energy ÷ the attacker's `balance.power` (`src/audio/balance.ts`).
- None of S5's layers occlude the wound box. The renderer's sprites sit below z 10, and the scenery and foreground are not in `layers`.

The measurement script, `.scratch/fxpeak.ts`, is uncommitted and can be handed over on request.
