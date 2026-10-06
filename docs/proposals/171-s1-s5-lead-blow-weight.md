# 171 — S1 → S5, Lead: one blow-weight enum for hit-stop, shake and the shared VFX

**Contracts touched (additive, already in the working tree for the Lead to approve or revert):**

- `src/contracts/constants.ts`:
  - `type BlowWeight = 'light' | 'medium' | 'heavy' | 'catastrophic'`;
  - `BLOW_WEIGHTS`;
  - `BLOW_HITSTOP_TICKS` = 2 / 5 / 7 / 14 ticks (40 / 80 / 110 / 230 ms);
  - `BLOW_SHAKE_PX` = 3 / 6 / 10 / 14;
  - `HITSTOP_CATASTROPHIC_MAX_TICKS` = 15 (250 ms);
  - `HITSTOP_MIN_TICKS` is now 2 (40 ms, the light beat). It was 4.
- `src/contracts/sim.ts`: the `hit` event gets `weight?: BlowWeight`, the weight **as it landed**: one step lighter when Guard or the parts took more than half of it, and catastrophic for the blow that KOs.
- `src/contracts/damage.ts`: `DamageEvent.weight?: BlowWeight`, the same landed weight, for the matter world.
- `src/sim/match.ts`: hit-stop is clamped to `[HITSTOP_MIN_TICKS, HITSTOP_CATASTROPHIC_MAX_TICKS]` (D31-5). Light to heavy stay ≤ 135 ms by their table values.

## For S5

Key the VFX recipe (anticipation, star flash, distortion ring, debris, dust) on `hit.weight`. If it is absent (older recorded events), treat it as `medium`.

## Mapping (src/combat/weight.ts `MOVE_WEIGHTS`): proposed, for WJ / S2 / S3 to adjust

| Titan | Light | Medium | Heavy | Catastrophic |
|---|---|---|---|---|
| Witness | Halo Shards (each arc and shard), Fracture Gaze beam | gaze / shear fractures, Charge | Sweeping Architecture, Structural Shear, Revelation | the KO blow |
| Planet | Orbital Drift | Moon Slam, Magma Vent | Tidal Rush, Crust Breaker, Core Pulse, Comet Slingshot, Cataclysm | the KO blow |

- **Other titans:** a move may author `extra.weight`. Otherwise the weight falls back on slot and energy: crush and ultimate are medium from 200 and heavy from 500; signature 250 / 700; strike 220 / 800. Continuous beam slices are light (they have no hit-stop either way).
- **Not covered:** comet and debris impacts in the matter world carry no weight.
