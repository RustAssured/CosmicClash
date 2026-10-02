# DESTRUCTION — how matter dies (`src/matter`)

Owner: Builder 2. This document is the algorithm reference and tuning guide for the destruction simulation. Contract: `src/contracts/matter.ts` +
`damage.ts`. API/invariants: `src/matter/README.md`. Numbers: `docs/PERF.md` (`## Matter (B2)`).

**Destruction IS the health system.** A titan body is a map of pixel matter (1 cell = 1 logical px). Damage never subtracts from a bar: it *removes,
burns, infects, cracks, crushes or devours cells*, and the remains (rigid chunks, dust, embers, gas, streams) stay in the world. The material table
decides what each damage type does; the matchups in the roster emerge from it.

## 1. Conventions

- World space is logical px, +y down. **All damage geometry is WORLD space.** Body-local ↔ world uses `contracts/space.ts` semantics evaluated per integer row:
  cell `(i, j)` has its centre at `x = t.x + (i + .5 - anchorX) * facing + leanShift(lean, j)`, `y = t.y + (j + .5 - anchorY)`. `overlap`/`solidAt`/damage all use exactly this
  (tests brute-force it for mirrored and leaning bodies). Detached chunks are built in world orientation (mirror and shear baked in), verified to land exactly on
  the pixels the body drew (`world.test.ts`).
- **Energy calibration:** 1 energy ≈ enough to destroy ONE baseline cell (density 1, integrity 255, resist 1). Energy is spread over the cells inside the shape weighted by the
  shape's falloff (point/line/cone/ring/field weights are documented in `shape.ts`). Hardness of a cell is `sqrt(materialDensity · density/128)`; the per-type cost of destroying it is
  `hardness · integrity/255 / resist[type]`.
- **Determinism:** fixed tick, sfc32 RNG (per body + world), integer hash noise, no `Map/Set` iteration, no wall clock. `world.hash()` folds every state array, chunk, particle, the
  ledger and RNG state (bodies' `pixels` included, so a nondeterministic refresh would be caught).
- **Mass ledger** (exact, tested): `created + injected = Σ(cells + pools) + chunkMass + particleMass + dissipated + deleted` (see §7).

## 2. Materials (physics archetypes)

Titan JSON picks a physics archetype with `MaterialSpec.base`, may override numbers and authors its own look. `buildMaterialTable(specs)` resolves them: index 0 is the reserved EMPTY
material, `specs[i]` gets id `i + 1`, `ashTo` keys resolve in the same table and the default `ash`/`char` archetypes are appended after the authored materials if referenced.

### Resist matrix (multiplier on incoming energy; 0 = immune, 1 = baseline)

| archetype | FRACT | ASSIM | TIDAL | THERM | CRUSH | KINET |
|---|---:|---:|---:|---:|---:|---:|
| rock | 1 | 0.9 | 1 | 0.7 | 1 | 1 |
| regolith | 0.8 | 1.1 | 1.2 | 0.8 | 1.25 | 1.3 |
| mantle | 0.85 | 0.9 | 1 | 0.7 | 0.9 | 0.9 |
| ironNickel | 0.65 | 0.6 | 0.9 | 0.65 | 0.85 | 0.75 |
| ice | 1.3 | 1 | 1.2 | 2.4 | 1.1 | 1 |
| crystal | 1.5 | 0.8 | 1 | 0.9 | 1.2 | 1.2 |
| glass | 1.6 | 0.7 | 1 | 0.8 | 1.3 | 1.3 |
| celadon | 1.35 | 1.1 | 1 | 0.8 | 1.1 | 1.2 |
| eye | 1.6 | 1.2 | 1.2 | 1.3 | 1.3 | 1.5 |
| tendril | 0.75 | 1 | 1.4 | 1.2 | 0.7 | 0.85 |
| lattice | 1.1 | 0.2 | 1.2 | 1.7 | 1.1 | 1.25 |
| chain | 0.7 | 0.5 | 1 | 0.9 | 0.85 | 0.85 |
| node | 1.2 | 0.4 | 0.9 | 1 | 1.1 | 1.4 |
| plasma | 0.35 | 0.6 | 2 | 0.2 | 0.4 | 0.4 |
| corona | 0.25 | 0.5 | 2.4 | 0.15 | 0.3 | 0.3 |
| gas | 0.2 | 0.5 | 2.2 | 0.5 | 0.3 | 0.2 |
| cloud | 0.3 | 0.6 | 2 | 0.5 | 0.4 | 0.25 |
| fuelGas | 0.2 | 0.5 | 2.2 | 2.4 | 0.3 | 0.2 |
| diskGas | 0.3 | 0.5 | 0.25 | 0.35 | 0.4 | 0.35 |
| jet | 0.2 | 0.4 | 0.3 | 0.3 | 0.3 | 0.2 |
| ocean | 0.5 | 0.7 | 1.6 | 0.6 | 0.6 | 0.45 |
| magma | 0.6 | 0.8 | 1 | 0.25 | 0.7 | 0.8 |
| core | 0.8 | 0.6 | 0.8 | 0.3 | 0.75 | 0.85 |
| horizon | 0 | 0 | 0 | 0 | 0 | 0 |
| ash | 1.2 | 1.2 | 1.5 | 0.3 | 1.3 | 1.4 |
| char | 1.1 | 1 | 1.3 | 0.6 | 1.2 | 1.2 |

### Physics

| archetype | density | bond | tough | brittle | heatCap | cond | ignition | burn | vaporize | absorb | assim | debris | ash | fluid |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| rock | 1 | 150 | 0.55 | 0.65 | 1 | 0.3 | - | - | 1900 | - | 0.3 | chunk | - | - |
| regolith | 0.8 | 70 | 0.2 | 0.2 | 1 | 0.25 | - | - | 1700 | - | 0.4 | dust | - | - |
| mantle | 1.25 | 135 | 0.5 | 0.45 | 1.3 | 0.4 | - | - | 2200 | - | 0.3 | chunk | - | - |
| ironNickel | 2.4 | 205 | 0.85 | 0.3 | 0.8 | 0.6 | - | - | 2600 | - | 0.25 | chunk | - | - |
| ice | 0.6 | 90 | 0.3 | 0.85 | 1.4 | 0.2 | - | - | 450 | 0.12 | 0.35 | shard | - | - |
| crystal | 1.3 | 120 | 0.35 | 0.95 | 1 | 0.3 | - | - | 1800 | - | 0.2 | shard | - | - |
| glass | 1.1 | 70 | 0.25 | 0.98 | 1 | 0.25 | - | - | 1500 | - | 0.15 | shard | - | - |
| celadon | 1.15 | 95 | 0.4 | 0.9 | 1 | 0.3 | - | - | 1700 | - | 0.3 | shard | - | - |
| eye | 0.9 | 60 | 0.2 | 0.5 | 1 | 0.3 | - | - | 1300 | - | 0.5 | dust | - | - |
| tendril | 0.7 | 205 | 0.6 | 0.1 | 0.9 | 0.3 | - | - | 1500 | - | 0.5 | dust | - | - |
| lattice | 0.7 | 105 | 0.4 | 0.6 | 0.9 | 0.35 | 320 | 5 | 1500 | - | 1 | chunk | ash | - |
| chain | 1.6 | 235 | 0.85 | 0.2 | 0.8 | 0.5 | - | - | 2300 | - | 0.6 | shard | - | - |
| node | 1.5 | 185 | 0.6 | 0.7 | 1 | 0.3 | - | - | 2000 | - | 0.5 | shard | - | - |
| plasma | 0.15 | 28 | 0.05 | 0.05 | 0.3 | 0.6 | - | - | 1600 | - | 0.6 | gas | - | yes |
| corona | 0.08 | 15 | 0.02 | 0.02 | 0.25 | 0.7 | - | - | 1400 | - | 0.4 | gas | - | yes |
| gas | 0.05 | 12 | 0.02 | 0.05 | 0.2 | 0.5 | - | - | 1000 | 0.35 | 0.3 | gas | - | yes |
| cloud | 0.1 | 18 | 0.05 | 0.05 | 0.5 | 0.4 | - | - | 1000 | 0.3 | 0.3 | gas | - | yes |
| fuelGas | 0.05 | 10 | 0.02 | 0.05 | 0.1 | 0.6 | 140 | 38 | - | - | 0.3 | gas | - | yes |
| diskGas | 0.12 | 18 | 0.02 | 0.05 | 0.5 | 0.5 | - | - | 1400 | - | 0.3 | gas | - | yes |
| jet | 0.05 | 10 | 0.02 | 0.02 | 0.4 | 0.6 | - | - | 1400 | - | 0.2 | gas | - | yes |
| ocean | 0.95 | 20 | 0.05 | 0.05 | 3 | 0.3 | - | - | 700 | 0.3 | 0.3 | liquid | - | yes |
| magma | 1.3 | 55 | 0.15 | 0.2 | 1.6 | 0.5 | - | - | 3000 | - | 0.4 | liquid | - | - |
| core | 2 | 200 | 0.8 | 0.4 | 1.5 | 0.6 | - | - | 3500 | - | 0.3 | ember | - | - |
| horizon | 3 | 255 | 1 | 0 | 100 | 0 | - | - | - | - | 0 | none | - | - |
| ash | 0.3 | 30 | 0.05 | 0.4 | 0.8 | 0.15 | - | - | 2000 | - | 0.1 | dust | - | - |
| char | 0.5 | 55 | 0.1 | 0.5 | 0.9 | 0.2 | - | - | 1900 | - | 0.2 | ember | - | - |

Design intent encoded in the numbers: celadon/glass/crystal are brittle (`brittleness` 0.9+, FRACTURE resist 1.35–1.6): cracks run, slabs shear. ironNickel/chain/tendril are tough (FRACTURE 0.65–0.75,
bond 205–235): cuts run out of energy and cracks arrest, so the blow is chewed into a pit instead (see *Damage floors*). `ice` boils away (THERMAL 2.4, vaporize 450). `regolith` erodes (KINETIC/CRUSH 1.25–1.3, debris dust). `ocean`/`gas`/`cloud` soak heat (`heatAbsorb` 0.3–0.35).
`lattice` burns (ignition 320, ashTo ash) and infects readily (assimilable 1). `fuelGas` ignites at 140 and flash-burns. `plasma`/`corona`/gas are featherweight, resist solid attacks and are stripped by TIDAL (2–2.4).
`horizon` is immune to everything (all resist 0, bond 255).

### Measured effect (calibration table)

`npx tsx tools/matter/calibrate.ts` hits a uniform ~104 px disc (radius 52, ~8.5k cells: a titan) of one archetype with ONE landed blow and reports the **percent of the body's initial mass removed** after 240 ticks
(ASSIMILATION column: percent of cells infected after 4 s). The blows are delivered the way the real moves deliver them (`docs/TITANS.md`): the FRACTURE Strike is the Tendril Lash (four 75-energy line hitboxes, width 9, penetration 5) or the Charging Thrust
(two 150-energy lines, penetration 8/10), the KINETIC Strike is the Glancing Blow (a `r=27` point with `crater: 6`), the FRACTURE Crush is the Shatter Blow cone (PIERCE | SEED_CRACK, 6 seeds), the KINETIC Crush is the Meteor ram (`r=36`, EMBED, `crater: 20`); TIDAL is delivered
CONTINUOUS over 30/60 ticks. Design targets (Lead, round 2): a Strike (~300 energy) removes **3-8%** for the matched type and **1-3%** for the worst-matched, never ~0; a Crush (~1500) **8-20%** / **3-8%**.
Every row must stay above the floor; the *shape* of the table is the rock-paper-scissors (glass/celadon/crystal/eye shear under FRACTURE, iron/chain/core resist it but still get chewed; ice boils under THERMAL; lattice burns; gas/plasma are stripped by TIDAL and crushed).

Re-measured in slice Phase 1 with wound sequencing (§ Round 8). In each cell: **before → after**. "Before" is the committed tree
(`2f5d6bb`) measured on the same day; the tables that used to be here dated from round 2 and were stale (rounds 4–7 had already
moved them, e.g. eye Lash 8.7 % → 3.8 %).

**Strike, 300 energy**

| archetype | FRACTURE lash | FRACTURE thrust | ASSIMILATION | TIDAL | THERMAL | CRUSH | KINETIC |
|---|---:|---:|---:|---:|---:|---:|---:|
| rock | 1.5 → 1.8 | 1.3 → 1.9 | 8.3 | 3.3 | 1.7 | 1.9 → 1.9 | 3.0 → 3.0 |
| regolith | 2.4 → 2.7 | 3.2 → 2.5 | 10.2 | 4.3 | 2.1 | 3.2 → 2.9 | 3.9 → 3.9 |
| mantle | 1.8 → 1.5 | 2.4 → 1.3 | 8.3 | 3.0 | 1.0 | 1.6 → 1.6 | 2.3 → 2.3 |
| ironNickel | 1.2 → 1.2 | 1.1 → 1.0 | 7.5 | 1.9 | 1.3 | 1.1 → 1.1 | 1.4 → 1.4 |
| ice | 3.1 → 2.8 | 4.1 → 2.6 | 9.3 | 5.0 | 6.2 | 2.9 → 2.8 | 3.9 → 3.9 |
| crystal | 1.9 → 2.6 | 2.8 → 1.9 | 6.9 | 3.0 | 2.4 | 3.3 → 2.1 | 3.2 → 5.4 |
| glass | 3.1 → 2.7 | 3.9 → 3.5 | 6.1 | 3.2 | 2.4 | 4.6 → 3.9 | 3.7 → 4.7 |
| celadon | 2.9 → 3.3 | 3.8 → 2.9 | 8.4 | 3.1 | 2.1 | 2.1 → 2.2 | 3.4 → 3.4 |
| eye | 3.8 → 3.1 | 4.9 → 4.3 | 12.2 | 4.1 | 4.9 | 3.0 → 3.0 | 3.8 → 3.8 |
| tendril | 2.3 → 2.3 | 2.4 → 2.3 | 12.2 | 5.4 | 4.3 | 1.6 → 1.6 | 3.1 → 3.1 |
| lattice | 2.6 → 2.5 | 4.2 → 3.4 | 0.0 | 4.6 | 27.4 | 2.8 → 2.7 | 3.9 → 3.9 |
| chain | 1.3 → 1.3 | 1.3 → 1.7 | 14.6 | 2.7 | 2.4 | 1.2 → 1.2 | 2.0 → 2.0 |
| node | 1.7 → 2.0 | 1.1 → 1.1 | 11.3 | 2.4 | 2.4 | 1.7 → 1.9 | 3.5 → 6.5 |
| plasma | 2.7 → 2.6 | 3.1 → 3.2 | 14.7 | 8.0 | 2.1 | 4.7 → 4.0 | 3.1 → 3.1 |
| corona | 2.7 → 3.0 | 3.0 → 3.1 | 9.8 | 8.0 | 2.1 | 9.9 → 8.7 | 3.0 → 3.0 |
| gas | 2.2 → 3.0 | 2.4 → 2.5 | 7.9 | 8.0 | 5.6 | 10.5 → 9.8 | 1.9 → 1.9 |
| cloud | 2.8 → 3.0 | 2.1 → 3.2 | 8.2 | 8.0 | 3.5 | 9.3 → 13.7 | 2.3 → 2.3 |
| fuelGas | 2.3 → 2.8 | 2.5 → 2.6 | 7.9 | 8.0 | 10.9 | 12.3 → 10.9 | 1.9 → 1.9 |
| diskGas | 2.8 → 3.0 | 3.0 → 3.1 | 7.9 | 2.4 | 2.4 | 10.8 → 9.1 | 3.0 → 3.0 |
| jet | 2.4 → 2.9 | 2.5 → 2.7 | 5.4 | 3.3 | 2.4 | 12.3 → 10.9 | 1.9 → 1.9 |
| ocean | 2.0 → 2.6 | 2.0 → 2.4 | 8.3 | 5.3 | 1.0 | 5.3 → 4.3 | 1.3 → 1.3 |
| magma | 1.8 → 1.8 | 1.8 → 3.1 | 10.1 | 2.9 | 1.0 | 1.8 → 1.5 | 2.1 → 2.1 |
| core | 1.3 → 1.3 | 1.1 → 1.1 | 8.2 | 1.9 | 1.0 | 1.0 → 1.0 | 1.8 → 1.8 |

**Crush, 1500 energy**

| archetype | FRACTURE | ASSIMILATION | TIDAL | THERMAL | CRUSH | KINETIC |
|---|---:|---:|---:|---:|---:|---:|
| rock | 7.7 → 8.0 | 13.8 | 16.5 | 8.6 | 10.4 → 10.1 | 20.9 → 19.5 |
| regolith | 13.5 → 16.9 | 16.4 | 22.3 | 11.6 | 13.7 → 12.4 | 18.9 → 22.0 |
| mantle | 8.0 → 10.4 | 13.8 | 14.7 | 5.5 | 8.2 → 8.0 | 18.3 → 17.7 |
| ironNickel | 6.3 → 10.0 | 12.7 | 9.7 | 7.8 | 5.3 → 7.7 | 12.6 → 11.8 |
| ice | 10.5 → 10.9 | 15.1 | 25.6 | 13.4 | 15.9 → 12.6 | 21.2 → 20.1 |
| crystal | 12.3 → 9.6 | 12.0 | 14.7 | 12.3 | 10.8 → 11.7 | 18.8 → 24.4 |
| glass | 7.7 → 11.9 | 11.2 | 16.0 | 13.0 | 13.8 → 12.7 | 19.1 → 20.3 |
| celadon | 11.0 → 9.2 | 13.9 | 15.6 | 11.6 | 12.0 → 10.2 | 20.2 → 22.3 |
| eye | 13.3 → 12.6 | 19.5 | 21.1 | 13.4 | 13.5 → 12.5 | 19.9 → 22.0 |
| tendril | 10.5 → 14.9 | 19.5 | 27.6 | 13.4 | 8.3 → 8.2 | 22.4 → 19.6 |
| lattice | 9.8 → 8.5 | 35.3 | 23.6 | 13.4 | 12.6 → 12.5 | 20.5 → 20.8 |
| chain | 6.4 → 10.0 | 22.7 | 13.1 | 11.9 | 6.5 → 6.6 | 14.8 → 17.9 |
| node | 9.4 → 11.3 | 18.8 | 12.4 | 12.3 | 8.8 → 12.6 | 20.2 → 31.1 |
| plasma | 14.0 → 17.2 | 22.7 | 42.9 | 10.1 | 13.3 → 11.0 | 19.7 → 21.7 |
| corona | 13.5 → 16.9 | 16.1 | 42.9 | 10.1 | 12.8 → 12.3 | 19.7 → 19.0 |
| gas | 10.6 → 12.8 | 13.5 | 42.9 | 13.4 | 15.9 → 19.0 | 14.2 → 15.1 |
| cloud | 14.8 → 17.4 | 13.6 | 42.9 | 13.4 | 14.7 → 13.1 | 19.4 → 16.8 |
| fuelGas | 10.7 → 12.9 | 13.5 | 42.9 | 20.3 | 14.4 → 14.8 | 14.2 → 15.1 |
| diskGas | 13.7 → 16.6 | 13.5 | 11.9 | 12.3 | 12.5 → 12.4 | 19.8 → 18.0 |
| jet | 11.1 → 13.2 | 11.2 | 16.5 | 13.0 | 14.4 → 15.7 | 14.6 → 14.8 |
| ocean | 10.2 → 16.4 | 13.6 | 26.9 | 5.5 | 25.7 → 27.6 | 11.1 → 12.5 |
| magma | 8.9 → 4.9 | 16.3 | 14.4 | 4.7 | 7.4 → 6.8 | 15.7 → 15.8 |
| core | 7.5 → 10.6 | 13.6 | 9.3 | 4.7 | 5.2 → 5.2 | 14.1 → 17.1 |

The wounds change *when and how* matter leaves, not what a blow pays for: ASSIMILATION/TIDAL/THERMAL are untouched, and the
held models move by the noise of a re-seeded random stream (± ~1 point at Strike level, ± ~3 at Crush level) with three systematic
effects: (1) the deferred chisel now bites fresh matter after the slab is gone instead of pulverising the slab (FRACTURE Crush up
on most rows); (2) KINETIC on brittle node/crystal is up (3.5 → 6.5, 18.8 → 24.4): the calibration's tidal sink pulls the faster
slabs back across the disc and they land as debris impacts (now capped per tick, see Round 8); (3) a held bowl's lip no longer dies
outright (CRUSH slightly down). Every row stays above the floor. Matched FRACTURE Lash: glass 3.1 → 2.7 and eye 3.8 → 3.1
(glass now 0.3 under the 3 % band edge, celadon/crystal went up); worth a look when the slice titans are recalibrated.

Reading it (round-2 analysis, still the intent of the shape). *Floors:* the worst rows are ironNickel/chain/core/mantle at 1.0-1.4% for FRACTURE/CRUSH/THERMAL at Strike level and 5-10% at Crush level (iron under the Meteor 12%, under the Shatter Blow 9.9%): tough matter is chewed, not sheared. *Matched:* FRACTURE
vs glass/eye/celadon/crystal 3-9% (Lash), KINETIC vs most solids 3-4%, THERMAL vs ice 6% and lattice 27% (fire spreads for seconds; the lattice is *meant* to burn), TIDAL vs gas/plasma/cloud 8% (capped by `TEAR_COST_FLOOR`) and 43% at Crush level, CRUSH vs gas/ocean 6-11% / 27%.
Above the band by design: lattice under ASSIMILATION/THERMAL and TIDAL vs gas at Crush level (the counters); KINETIC at Crush level is 20-25% on soft matter (the Meteor is ~1350, so ~18%).

**Real moves on the real generated titans** (`npx tsx tools/matter/moves.ts`: forward aim, each hitbox landing once, continuous ones swept every `rehit` ticks, raw matter result: no Guard shell, no part interception, no lunge movement; % of the target's mass 300 ticks later):

Slice Phase 1 (wound sequencing in; titan data as the other specialists left it the same day — Witness, Planet and energies
changed concurrently, so this is not a matter-only comparison):

| attacker move | nominal energy | -> lastone | -> planet | -> asteroid |
|---|---:|---:|---:|---:|
| lastone.lash (strike) | 340 | 1.5% | 2.1% | 1.9% |
| lastone.lunge (strike) | 260 | 2.0% | 2.5% | 1.9% |
| lastone.shatter (crush) | 1100 | 6.3% | 8.1% | 7.2% |
| lastone.gaze (signature) | 480 | 2.7% | 5.2% | 1.9% |
| lastone.lastlight (ultimate) | 5382 | 68.8% | 23.3% | 25.8% |
| planet.nudge (strike) | 252 | 1.0% | 0.9% | 1.4% |
| planet.impact (crush) | 700 | 4.6% | 3.4% | 3.9% |
| planet.moonslam (signature) | 84 | 0.4% | 1.3% | 0.5% |
| planet.cataclysm (ultimate) | 1750 | 10.0% | 9.4% | 14.3% |
| asteroid.meteor (crush) | 1147.5 | 12.1% | 9.7% | 12.3% |
| asteroid.kessler (ultimate) | 1720 | 19.6% | 22.0% | 23.1% |

Round 2 table (for reference):

| attacker move | nominal energy | -> lastone | -> asteroid |
|---|---:|---:|---:|
| lastone.lash (strike) | 340 | 6.4% | 2.0% |
| lastone.lunge (strike) | 260 | 4.1% | 2.5% |
| lastone.shatter (crush) | 1100 | 9.9% | 9.1% |
| lastone.gaze (signature) | 800 | 5.1% | 3.2% |
| lastone.lastlight (ultimate) | 4680 | 57.0% | 27.9% |
| asteroid.shoulder (strike) | 260 | 2.3% | 2.0% |
| asteroid.meteor (crush) | 1350 | 16.3% | 15.2% |
| asteroid.swarm (signature) | 140 | 0.0% | 1.1% |
| asteroid.kessler (ultimate) | 2300 | 28.3% | 29.4% |

So a Last One vs Asteroid fight needs ~30 Lashes/Thrusts or ~5 Meteors to wear the Asteroid down to a third; the Guard shells (absorb 20-75%) and misses lengthen that, they are the combat layer's dial. The Lash is the weakest Strike against the Asteroid (2.0%): regolith/iron shrug shearing, which is the intended matchup, but it is never ~0.

### Damage floors (why nothing is immune except the horizon)

Every model spends its whole energy budget; what its primary mechanism cannot use falls through to a cheaper fallback, and no cell costs more than a cap to remove:

- **Single-resist accounting.** A cell's cost is `hardness · integrity/255 / resist[type]` (already divided by its own resistance), so budgets are RAW energy. (Before round 2 the budget was also multiplied by the mean resist, squaring the matchup: iron FRACTURE was 0.00.)
- **FRACTURE** = cuts + grind + a **deferred chisel**: `Eraw · 0.5` (+ unspent cut energy) becomes a crater-engine bite (`chisel()`, cost capped at 1.8 energy/cell) that runs one tick after the blow's wound shears (`CHISEL_DELAY` = 3 ticks only when wounds are off: harness carving), once connectivity has released the slabs the cuts isolated; its pit sheds as that wound's slabs. Scaled by `1 - 0.95·brittleness`:
  brittle matter shears into slabs and wastes almost nothing, tough matter can only be chewed. A short stab (a line with `penetration < 24`, no PIERCE) shears like a blow (U-cuts sized by the energy), it does not cut along its own 5-cell axis.
- **KINETIC / CRUSH** = the shared crater engine with RAW energy; `params.crater` is a **lower bound** on the bowl (the energy is always spent: `Rl = max(crater, 0.8 · energy-derived)`); lip share 14% / 26%, CRUSH compaction 25%.
- **THERMAL** = 75% of the energy is a **focused core**: cells nearest the shape centre (descending shape weight) receive exactly the dose that vaporises them, until the energy or `1.6 cells/energy` is used; no cell costs more than **2.4 energy** to vaporise (so core/magma/ocean are not immune), and it ignores the
  atmosphere in front (it is what makes the pit); the remaining 25% heats the whole shape (ignition, glow, ablation) and is still shielded (`heatAbsorb`, 25% of it per cell; a vaporised cell stops shielding). Gases have a dispersal temperature (`vaporize` 1000-1600).
- **TIDAL**: every tear costs at least `TEAR_COST_FLOOR` = 0.4 energy (a Strike must not vaporise a whole corona), and loose matter deep inside is scored 0.08 (not 0.6): the outline is peeled first.
- **Immunity** is per damage type: a cell whose resist for the type is 0 (the horizon, all types) is never cut, cratered, loosened, shocked or compacted (`isImmune`).

## 3. The models

Every model: reads only the event's `params`/`flags`, conserves mass, is deterministic, and is cheap when idle (active tiles / fronts / fuses are only processed while something is going on).

### 3.1 FRACTURE — `fracture.ts`, `cuts.ts`, `cracks.ts`
*Shear the target apart along its weakest bonds.*
- **Bonds are created weak where breaks should happen.** At `createBody` every bond gets `min(material bonds) × layerFactor(0.62 across materials) × grainSeam × fault × noise(±14%) × cohesionScale`.
  *Grain seams*: a warped jittered-grid Voronoi partition (≈17-cell plates) whose boundary bonds are weakened by `0.52·(0.35+0.65·brittleness)`. *Faults*: 2–3 authored long, wobbling weak lines (×0.42). Damage therefore reveals layers and follows natural shear planes.
- **Cuts.** Crack paths run on the *dual lattice* (cell edges; every interior edge is one bond byte). A bond-weighted Dijkstra (`CutFinder`, preallocated, generation-stamped) finds the cheapest path between two outline points
  (or an interior end for a stab). Blows use **U-cuts**: outline corner → interior waypoint (depth from the energy: slab area ≈ 1.25·E_eff cells, `E_eff` = raw energy × mean resist: it only SIZES the slab) → outline corner, so the slab between the cut and the outline is *isolated*; more energy = more and larger cuts (≤3).
  Beams and PIERCE lines cut along their own axis (Gaze); a short stab (Tendril Lash / Charging Thrust: `penetration` < 24) shears like a blow, so it frees a slab sized by its energy instead of cutting a 5-cell groove. Each severed bond costs `bond/255 · K_E(3.6) · cohesionScale / resist`; if the budget runs out the last bond is only weakened and a live crack tip is left.
- **Grinding**: cells beside a cut are bruised (integrity), shed dust/shards and glints, and die if pushed to zero. **Seam pop**: brittle matter loosens grains near the surface. **PIERCE + line**: bores a channel along the axis from the entry surface inward.
- **SEED_CRACK** plants `crackSeeds` **crack fronts** on the surviving side of the cuts. A front moves along dual edges, choosing the weakest of forward/left/right (bond + turn penalty + noise), breaks the edge if its stress exceeds
  `bond · cohesion · (0.26 + 0.5·toughness)`, pays `need·(0.36·(1-brittleness)+0.03)` in stress (brittle matter lets cracks run, ductile arrests them), branches in brittle matter, and stops at the outline, where connectivity releases the slab.
  Fronts advance 0.45–1.2 edges/tick so networks spread over 1–3 s.
- **Deferred chisel**: the energy shearing could not use is chewed out of the contact by the crater engine `CHISEL_DELAY` = 3 ticks later (see *Damage floors*); this is why a FRACTURE `DamageResult` reports few removed cells: the slabs arrive later as `detach` events and the pit as dust.
- Released slabs inherit the blow: direction with the *inward* component removed (they slide off, never into their old body), speed `190·sqrt(E/(m+25))` px/s, spin from the lever arm.

### 3.2 KINETIC — `kinetic.ts`, `crater.ts`
*Craters, ejecta, shrapnel.* First contact = the covered cells nearest the shape origin, slid back along −direction to the outline. The bowl is an ellipse oriented on the surface normal, depth/width derived from the material
(`0.5 + 0.95·toughness·(1−0.45·brittleness)`: iron deep and clean, regolith wide and soft; `params.crater` is a lower bound on the radius, the energy is always spent). Cells are ranked by normalised elliptical distance; the threshold radius is the smallest whose cumulative cost pays 86% of the
budget (so hard matter → small crater); the other 14% bruises and loosens the rim (radial cracks, spall). Removed matter becomes **directional ejecta**: 5×5 fragments of ≥6 cells leave as rigid chunks (probability 0.72 for chunky/shard debris), everything else as
dust/shards/embers per the material's `debris`; speeds are highest at the crater centre, biased along the blow and out of the surface. A flash of sparks marks the contact.
**EMBED** plants `embed` (default 3) shrapnel cells (flag SHRAPNEL, pulsing glint) past the crater floor along the direction of travel; each fuse counts down `embedDelay` (48) ticks then bursts: pulverises its own cells, breaks bonds in a radius (≈3+0.62·sqrt(E) cells) with
probability falling off from the centre, sparks, and lets connectivity pop the secondary chunks.

### 3.3 CRUSH — `crush.ts` (+ `crater.ts`)
*Compression, craters with shock rings, tectonics.* A wider/shallower crater (aspect 0.42 or from `params.compress`), mostly powder (chunk probability 0.22, slow ejecta), 26% of the budget to the rim. **Compaction**: 25% of the removed mass is packed
into the surrounding cells' density (density byte rises, cells darken; mass conserved; sustained crush keeps compacting/weakening). A **shock ring** (`Wave`) expands from the crater snapping *weak* bonds (seams, faults, layer boundaries) with probability
`0.9·(1−bond/150)²·falloff`, bruising and puffing dust, marked by a ring of light. **Tectonic faults**: 2–5 crack fronts start where the crater edge meets live matter and run outward along the weakest bonds (crust/mantle boundaries first).

### 3.4 THERMAL — `thermal.ts`, `blast.ts`
Heat: 75% of the energy is a **focused core** (the cells nearest the centre get exactly their vaporising dose, ≤ 2.4 energy/cell, ≤ 1.6 cells/energy); the rest is spread: `ΔT = perCellEnergy·HEAT_PER_ENERGY(1900)·resist / (heatCapacity·heatTolerance)` (or `params.heat` temperature units, exact, no core), 1.5× for infected matter. Heat **shields**: along the blow (row/column sweep) each cell transmits `1 − 0.25·heatAbsorb` (a vaporised cell not at all) and absorbs `heatAbsorb` of what reaches it, so an atmosphere protects
the crust beneath it unless PIERCE. **Diffusion** is an explicit red-black Gauss–Seidel stencil over ACTIVE 16×16 tiles, each update a convex combination (k = 0.25·conductivity, 4k ≤ 1) so it cannot overshoot/explode; radiative cooling (0.35%/tick bulk, 1.2% at the outline).
**Ignition** at `ignition·heatTolerance`: burning cells self-heat (`tuning.burnHeat` = 20% of ignition/tick: fire spreads and sustains), lose `burnRate` integrity/tick (×1.6 if infected), char below 130 integrity, and at 0 become their `ashTo` material (weak bonds; the mass
difference goes up as embers/smoke) or vanish as embers. Fire kills infection. **Ablation**: non-flammable matter above 50% of its vaporise temperature sheds integrity (glowing melt). **Vaporise** strips a cell into a gas/spark plume (`boil` event for oceans). `fuelGas` flash-burns with
fireball particles. `params.shock` launches a **blast ring** that blows already-loosened matter (burning, charred, hot, low integrity, very brittle) off the body radially.

### 3.5 TIDAL — `tidal.ts`, `stream.ts`, `particles.ts`
A field toward `(originX, originY)`. Candidates are outline cells and loose (bond ≤ 60) matter inside the field; each is scored `weight·exposure·pull / cost` where cost = `max(0.4, 1.5·hardness·(0.25+0.75·holdFraction)·integrity·cohesion / resist)` and exposure favours cells whose outline faces the source. They are torn in descending score until the energy
(per tick with CONTINUOUS) runs out (≤260 cells/application; applied every 3rd tick with the skipped energy carried — same total, a third of the cost). Torn cells become **stream particles**: launched toward the sink with a tangential component, then homing with a swirl that
*conserves angular momentum at launch and bleeds it off* (tangential damping, stronger with age) so streams **spiral in**; drawn as velocity-aligned streaks (spaghettification); consumed within 10 px of the sink (or inside a `GravitySource.consumeRadius`), crediting the mass to `sourceBodyId`
(`massGained`/`massLost` in `stats`; `BodyStats.mass` includes the un-built pool, so accretors exceed massFrac 1). `horizon` (resist 0) can never be torn.

### 3.6 ASSIMILATION — `assimilation.ts`
`LATCH` deposits infection `latch·weight·(0.5+0.5·assimilable)·resist` (default from the energy) and roots the contact (cells with infection ≥ 100 convert immediately). `stepInfection` spreads infection along **intact** bonds only (cracks stop it) over active tiles: per neighbour
`(2 + 0.06·v)·(0.3+0.7·assimilable)` gated by a per-cell hash and a low-frequency *vein* noise (branching, not a disc); two-phase (accumulate/apply) so there is no scan-order bias. Cells reaching 200 become ASSIMILATED (lattice look: wire strands with glowing nodes over a dark crimson body; the front is an ordered
dither), and are weakened (bonds ×0.65, integrity ≤ 210). With `params.harvest`, converted outline lattice is **torn out** (probability `harvest·0.03`/tick, config lasts 300 ticks after the last event) and streams to the Nexus hub, crediting `sourceBodyId`. THERMAL burns infection out (1.5× heat, 1.6× burn) — emergent.

## 4. Core systems

- **Connectivity & detachment** (`connectivity.ts`): iterative flood fill (int stack, generation stamps, no allocation) from the live core-disc cells over intact bonds; fluid cells never anchor solids. Unreached solids form islands: ≥5 cells → one rigid chunk (pixels copied into a world-orientation sprite,
  centre of mass, edge normals for tumbling rim light), smaller/fluid → particles. Urgency levels (`CONN_SOFT` 6 ticks / `CONN_STEADY` 3 / `CONN_NOW` next tick) keep the cost low while cracks/burn erode.
  **Local shortcut** (`localPass`): every removal (killed cell, broken bond) is an *event* whose live neighbours form the change *frontier* (`Body.noteKill/noteBreak`, events unioned when they touch). Since the previous pass every component was anchored, so any path crossed a removal through the frontier of ONE cluster: if the frontier of every cluster still reaches itself
  (a breadth-first growth from all frontier cells at once, ≤ 64 rings / 6000 cells) nothing was cut off and the full flood is skipped; complete components found the same way (no core cell inside, and each cluster chain keeps exactly one still-growing group) are released as islands without the flood. Otherwise — a big slab, a spent budget, an anchor (core-disc) cell
  that died, fluid materials, matter added by heal/grow/restore — the full flood runs. Islands are released in a canonical order (ascending lowest cell, cells sorted) on both paths, so `core.forceFullConn = true` must give bit-identical hashes (tested on 16 scenarios in `timeslice.test.ts` + an 80-scenario offline sweep). About half of the passes and ~80% of their cost disappear in a fight.
- **Chunks** (`chunks.ts`): rigid bodies (rotation, slow drag, soft arena walls, gravity sources, consumption), cap `MAX_DEBRIS_CHUNKS`: overflow degrades the oldest/smallest to dust; gravel (<5 mass, >25 s) wears away. A fast heavy chunk hitting a body applies a capped KINETIC point blow and bounces; brittle fast chunks fracture (Voronoi split, momentum
  conserving). ~1 in 4 chunks render in front of the titans, the rest behind and slightly darker.
- **Particles** (`particles.ts`): pooled SoA (`MAX_PARTICLES`), interned colour ramps, drag, gravity, homing, consumption; pixel-art dithering instead of alpha. Kinds: spark, ember, dust, gas, ash, glint, plasma, shard, mote.
- **Visuals** (`visual.ts`): `map.pixels`/`emissive` are recomputed per dirty 16×16 tile from cell state: integrity dimming, compression tint, char, lattice/infection, crack fissures (dark far wall, lit near lip), freshly-exposed edges re-lit with the stage light (rim highlight / deep shadow,
  hue-shifted toward the light colour), heat glow along the material's `glowRamp`, shrapnel glints. Idempotent, so `restore()` is exact.
- **Stats** (`body.ts`): region-granular incremental recompute (8×8 grid); `coreIntegrity` over the core disc; `exposedCoreFrac` = fraction of 16 rays from the core that meet no matter; `regionGrid` in WORLD orientation (mirrors with facing).
- **Lifecycle** (`lifecycle.ts`): `restore` (exact snapshot), `heal` (Euclidean regrowth from surviving edges as scars: weaker, cracked/charred cells), `grow` (mass from the pool first), `shed` (surface cells, core last, mass dissipates), `carve` (harness: realistic damage biased outward; two phases + settle; then purges dust and calms debris).

## 5. Tuning knobs

| knob | where | default | effect |
|---|---|---|---|
| resist / bond / toughness / brittleness / heat numbers | `archetypes.ts` (or titan `physics` overrides) | see tables | the matchups |
| `HEAT_PER_ENERGY` | `thermal.ts` | 1900 | temperature per energy (1 energy ≈ vaporises a baseline rock cell) |
| `tuning.burnHeat` | `thermal.ts` | 0.2 | fire self-heating: spread speed/sustain |
| `K_E` | `fracture.ts` | 3.6 | energy per full-strength bond severed |
| slab area | `fracture.ts slabArea` | `1.25·E_eff` | size of the piece a blow isolates |
| `GOUGE_BASE`, chisel cost cap, `CHISEL_DELAY` | `fracture.ts` | 0.5, 1.8, 3 ticks | how much tough matter is chewed off per blow (the FRACTURE floor) |
| `CORE_SHARE`, `CORE_CELLS_PER_ENERGY`, `CORE_COST_CAP` | `thermal.ts` | 0.75, 1.6, 2.4 | the focused melt of a THERMAL blow (the THERMAL floor) |
| `TEAR_COST_FLOOR` | `tidal.ts` | 0.4 | cheapest tear (caps how much gas a Strike strips) |
| `LOCAL_BUDGET`, `LOCAL_DEPTH` | `connectivity.ts` | 6000 cells, 64 rings | reach of the local connectivity shortcut |
| `GRAIN`, seam factor, fault count/weakness | `bodyinit.ts` | 17, 0.52, 2–3 ×0.42 | natural shard size and shear planes |
| `MOMENTUM_K` | `dmg.ts` | 30 | `DamageResult.impulse` scale |
| crater budget split, chunk probability, ejecta speed | `crater.ts`, `kinetic.ts`, `crush.ts` opts | 0.14/0.26 lip, 0.72/0.22, 1/0.7 | crater feel |
| tidal cost factor / cadence / per-application cap | `tidal.ts`, `world.ts` | 1.5 / 3 ticks / 260 | how fast fields strip matter |
| infection spread rate, vein noise | `assimilation.ts` | see §3.6 | creep speed |
| `body.cohesionScale`, `body.heatScale` (LIVE, fighter-owned) | `MatterBody` | 1 | scale every bond / thermal threshold at runtime |
| `DEBRIS_CHUNK_CAP` (`chunks.ts`, = max(`MAX_DEBRIS_CHUNKS`, 640)), `MAX_PARTICLES` | `chunks.ts` / `contracts/constants.ts` | 640 / 6000 | pool caps |
| `SHEAR_TARGET_MS` | `wound.ts` | 140 ms | when a wound's slabs begin to shear (wall time, hit-stop included) |
| `SHED_PER_TICK`, grain per type | `wound.ts`, crater/fracture opts | 8 %; FRACTURE 8, KINETIC 20, CRUSH 18 | how a wound sheds: budget per tick, pieces per hold |
| `CORE_FRAC`, `HOLD_MIN` | `crater.ts` | 0.2 of the bowl radius, 40 cells | pulverised-at-once core of a crater; smaller bowls go at once |
| `STAGGER_MIN`, `BIG_ISLAND` | `wound.ts` | 40 cells; 1500 cells or 25 % | islands split and released a piece per tick |
| `YOUNG_TICKS`, `FRESH_SLAB_TICKS` | `chunks.ts` | 240, 60 | never degraded to make room; no impact damage while fresh |
| `DEBRIS_TICK_BUDGET` | `world.ts` | 60 | debris-impact energy a body takes per tick |

## 6. Dev tooling

`dev/matter/index.html` (port 5202): click/drag to fire any type/shape/flags, overlays (temperature, integrity, bonds, infection, islands, stress, materials), stepper, carve/heal/restore, live ledger and ms/tick.
`tools/matter/gallery.ts` renders contact sheets (`fracture|kinetic|iron|crush|thermal|tidal|assim|star|carve`), `bench.ts` performance (`--assert` fails on budget breaches; `harness.ts` is its shared replay/min-of-N timing), `perf.test.ts` the regression guard,
`calibrate.ts` the tables above (`ONLY=rock,ironNickel TYPES=FRACTURE npx tsx tools/matter/calibrate.ts` to focus), `moves.ts` the real titan moves on the real bodies, `tables.ts` the archetype tables. `warmUp()` (exported from `@/matter`) pre-JITs the hot paths on a private scene (~0.4 s): call it while loading.

## 7. Mass ledger

Every path that removes matter routes it: to a **chunk** (`chunkMass`), to **particles** that carry it (`particleMass`; credited on consumption, otherwise it *dissipates* when the particle expires/is recycled), or straight to `dissipated` (shed/evaporate). Sinks credit a body's **pool**
(`massGained`), which counts toward `mass` and is spent by `grow()`. `heal/restore/grow beyond the pool/spawnChunk` are `injected`; `removeBody`/restore trimming are `deleted`. `world.ledger().error` must stay ≈ 0 (tests assert `< 1e-2` after every scenario; the bench reports ~1e-5 after a 60 s fight).

## Round 3: integrated-game findings

- **Impact burst (`src/matter/blowfx.ts`)**: every landed FRACTURE/KINETIC/CRUSH blow emits, on its first slice and before the damage model runs, a white-hot flash disc (emissive, 5-15 px by energy), a starburst of stretched sparks fanned around the outward normal, a fan of dust puffs and a few shards. It exists on frame 0, so it is visible through the hit-stop freeze (the world is not ticked while frozen). Big particle blobs (size >= 6) are rasterised round.
- **Deferred chisel follows the body** (`world.ts`, `shiftEvent`): the chisel re-runs the blow's world-space shape 3 ticks later; the knockback of the same blow moves the body ~20 px/tick, so in the game the pit landed on empty air (a landed Crush removed 0.46% instead of 6.2%). The queued event is now translated by the body's movement. Test: `damage.test.ts` "deferred chisel follows a body".
- **"Delayed" loss is a measurement artefact**: `DamageResult.massRemoved` excludes the cuts and the chisel (slabs are freed by the connectivity pass on the next tick, the chisel 3 ticks later). Measured with `tools/matter/integrated.ts` on the real Match: 96-100% of the mass a body loses is gone within 30 ticks (0.5 s) of the latest blow, 0-4% later, nothing beyond 300 ticks; multi-blow sequences included. Crack networks do not keep eating matter afterwards, so no rebalance was made; only the return value under-reports.

## Round 4: visible fissures, chunk shading, tail spike

- **Slow cuts** (`cracks.ts` `queueSlowEdge`/`stepSlowCuts`): a FRACTURE cut is planned and paid at the blow, but its bonds are severed progressively from the contact end (>= 2 edges/tick, ~pending/60 per tick, so ~0.5-1.5 s), a glinting tip leading the fissure; the slab shears when the last bond goes (CONN_NOW). Queue lives on the body (hashed, cleared by lifecycle). Tests that read bonds right after a blow now run some ticks first.
- Fissure rendering: darker/bolder far wall, warm hue-shifted lip glint with a little emissive.
- Chunks: stronger key-light edge (0.5), cool-violet dark rim on the unlit side, underside shading top 1.11 -> bottom 0.86; kinetic ejecta blocks are 6x6 with >= 9 cells to be a chunk (fewer confetti).
- Tail spike: the 54-100 ms ticks seen in the page benchSim are NOT the matter world. Headless per-tick timing of the same aivai match (seed 11, 3800 ticks) shows the worst world.tick is 3.9 ms; the >20 ms steps are the first 2 ticks of the match (JIT) and the rest are outside matter (page GC / fighters / software-GL host load).

## Round 5: thermal, crush and slab visuals in the integrated app

- Slow-cut window capped: `stepSlowCuts` severs max(2, pending/36) edges per tick (~0.6 s for a long seam). Crack FRONTS planted by SEED_CRACK still finish their cuts later (measured Lastone Crush: 14 chunks by tick 60), so the last small slabs can shear ~1 s after the blow.
- Fissures: on bodies >= 90 cells wide both walls of a broken bond are dark (2-px fissures); the lip glint is kept on small bodies.
- Magma: `Body.magma` is set by any CRUSH blow; from then on strong fissure cells show molten rock (orange, emissive 110, 2-px on big bodies) except in gas materials. Planet crush strips show the glowing tectonic network.
- Atmosphere: gas-debris materials heated above the glow threshold glow warm orange-white themselves (the rim glows, not the surface ramp).
- Vapour: MODE_VAPOR gas particles use a shared warm ramp (white-orange, ember red, soot grey) instead of the material's pale gas colour.
- Crater dust plume (`crater.ts`): 5-14 big soft dust puffs (3-4 px) lift along the surface normal, drift up and fade over 0.6-1 s.

## Round 6: healed-body stability, `resist` semantics, pool-aware shed, tidal/assimilation visuals

- **Healed bodies bled mass with no hit landed. Two causes, both fixed.** (1) `heal()` regrew cells that touched the body only diagonally or had every bond severed (the 14% scar cut), so the connectivity pass turned them into dust on the first ticks of the next round (~6% of the body). Regrown cells now need a live 4-neighbour (several passes) and always keep one bond. (2) Debris chunks of the previous round (up to 400, 13k mass in a real match) kept colliding with the weakened bodies as KINETIC blows ("no hit landed" was the old debris). Chunk impacts now need a relative speed > 120 px/s and scale with the speed above 100 (capped at 60 energy), and a healed body ignores debris impacts for 360 ticks (`Body.debrisImmuneUntil`). Regression test: `lifecycle.test.ts` "a healed body is stable" (carve, heal 0.6, idle 1000 ticks, massFrac non-decreasing). Measured with a real Match (`.scratch/round.ts`-style: Lastone vs Lastone, scripted crushes): intro of round 2 now holds 0.648 massFrac, was 0.630 -> 0.571.
- **`resist` semantics (unified): a multiplier on the damage a material takes, per damage type. resist > 1 = takes MORE damage, < 1 = less, 0 = immune** (this is what `archetypes.ts` always documented and what crater cost, fracture cost, thermal heating/ignition, tidal cost and assimilation latch already did). Two sites used it the opposite way and were flipped: KINETIC surface bruising (`kinetic.ts`) and FRACTURE seam grinding (`fracture.ts grindCell`); both now multiply. Effect: Lastone Shatter on Asteroid 7.1% -> 6.3% idle, Last Light 23.2% -> 21.0% (tools/ai/moves.ts). No titan JSON needed changing: `physics.resist` overrides exist in blackhole, nexus, planet and supernova; all were written against "multiplier on incoming energy", i.e. they already assume this sense (Builders 3/3b: keep writing them that way; e.g. TIDAL 2.4 on a plasma cloud = stripped 2.4x easier).
- **`world.shed` is pool-aware**: it drains the accretion pool first (ledger `dissipated`, pool and stats updated, exact) and only takes the remainder from cells. No interface change. Black Hole / Nexus can now be bled by disk damage while their cells are intact. Test in `lifecycle.test.ts`.
- **FRACTURE seams are progressive** but `carve()` now flushes them per blow (`flushSlowCuts`) so harness carving lands on the requested fraction.
- **Tidal**: PF_STRETCH streams tint white-hot, then orange-hot, as they speed up toward the sink (particles.ts). **Assimilation**: darker converted body, brighter lattice nodes/strands, creeping infection front glows slightly.

## Round 7: depth for debris and impacts

- **Depth classes** (`chunks.ts` `chunkDepth`, render-only, deterministic from chunk id; never read by the sim or hashed): 0 back (~1/2 of chunks, hazier and darker, parallax 0.9), 1 the fight plane (~3/8, 1x, drawn over the titans, parallax 1.0), 2 near (~1/8, **2x nearest-neighbour pixel doubling**, harder underside shade, stronger dark rim, parallax 1.35). Near chunks go in a third layer `debris-near` (z +15, emissive mask); at most 24 are drawn per frame. A chunk that is big (>= 20 cells) and thrown fast (>= 140 px/s) by a blow is near for ticks 6-55 of its life ("thrown at the viewer"), then falls back to its class. A fresh chunk always appears exactly where its cells were (fight plane for its first 6 ticks); the parallax offset is measured from the view origin of its first drawn frame, so it never pops when it detaches.
- **Heaviness** (sim, deterministic, hashed): a chunk's velocity ramps 35% -> 100% (smoothstep) over `4 + 1.6*sqrt(mass)` ticks (max 30) and its spin is ramped in later and scaled by `1.4/(1 + mass/60)` (0.25..1.4), so big slabs start slowly, accelerate and tumble lazily while gravel scatters at once.
- **Impact presence** (`blowfx.ts`): heavy hits (energy >= 400) add dust that travels along the surface in both tangent directions and a plume of 3-8 large soft near-camera puffs (`PF_NEAR`, drawn 2x in the near layer, growing as they age, dithered fade, shaded underside); the flash/starburst/dust ring stays.
- Tests: chunk depth is deterministic and covers the three classes, a fresh chunk is mid, launch boost only after age 6, layer set is now back/near/front, a barrage rendered at varying alpha hashes identically twice.
- Perf note: the saturated-scenario p99 in `tools/matter/perf.test.ts` currently reads 3.6-4.3 ms on this (shared) machine although `speedFactor()` reports 1.0. The same replay on the round-2 commit (d76f41f) measures avg 0.88 / p50 0.66 / p99 3.55 ms today (PERF.md recorded 0.40 / 0.20 / 2.22 on a quiet machine), the current tree avg 0.97 / p50 0.75 / p99 3.6-3.7: the machine, not the code, is ~2x slower right now; the code is ~10% heavier than round 2 (slow cuts, blow FX).

## Round 8 (slice Phase 1): wound sequencing — D1 "the instant cut"

**Damage may count instantly; separation takes time.** A heavy blow used to delete its whole crater (and, for FRACTURE, the slab its
deferred chisel pulverised) in ONE tick, ~98 % of it as particles: on the Planet (resist 4 shell, density 0.5-0.6) a single
Impact or Shatter emptied a hemisphere into "small embers" between two frames. Now (`src/matter/wound.ts`):

- **Wounds.** Every FRACTURE/KINETIC/CRUSH blow opens a wound (ring of 8 per body, hashed): contact (body-local, so it follows
  the body through knockback), launch direction (the blow with its inward part removed, blended with the outward normal by the
  type's radial share), energy, source mass, grain, and its **shear tick**: `SHEAR_TARGET_MS` (140) of wall time after the
  impact frame **minus the blow's hit-stop** (`DamageEvent.hitstop`; the world is frozen during it), at least one tick. So a
  heavy blow with an 8-13 tick hit-stop shears on its first world tick (150-233 ms wall), a blow without one 8 ticks later.
- **Held slabs.** A crater (KINETIC, CRUSH, the FRACTURE chisel) pulverises only its core (`d <= 0.2·thr`, ~4 % of the bowl:
  the punch) and HOLDS the rest: the bowl is partitioned along the weakest bonds (farthest-point seeds, bond-weighted region
  growing so borders fall on grain seams, oversized pieces halved, crumbs merged) into ~`grain` pieces (FRACTURE 8, CRUSH 18,
  KINETIC 20), every piece outlined with **hairline bonds** (bond byte 1: still connected, drawn as a fissure on the impact
  frame) and tagged in `map.detached` with its slab slot. Held slabs are connectivity anchors. FRACTURE cut edges become
  hairlines at the blow and are severed by a per-wound deadline (the wound's shear tick) instead of the old ~0.6-1.9 s queue.
- **Shear.** On its tick a slab's boundary bonds are severed and the connectivity pass releases it. Pieces go nearest the contact
  first, one tick at a time within the wound's budget (`SHED_PER_TICK` = 8 % of its held mass per tick; a bigger piece goes
  alone). Islands that a wound frees before its shear wait for it; islands bigger than `STAGGER_MIN` (40 cells) in a wound's
  window, or bigger than 1500 cells / 25 % of the body at any time, are split and released the same way. A held core-disc cell
  stops anchoring and stops counting toward `coreIntegrity` at once (the KO counts now, the slab leaves later).
- **Momentum and spin.** Every piece of a wound leaves at the wound's speed (`190·√(E/(M+25))·sm`, M = the first held mass)
  along its direction, plus a lateral fan by its offset from the contact, so Σm·v·d̂ = P_w (measured 98-101 %). Spin is the lever
  arm of that impulse on the piece's contact-facing side over its own moment of inertia (`Chunk.inertia`, from its cells):
  ω = 0.06·((p − c) × m·v) / I, clamped ±8 rad/s; pieces either side of the blow line spin in opposite senses (100 % agree).
  Wound pieces (`Chunk.fast`) skip the old 35 %→100 % heaviness ramp (the hold was the beat) and deal no impact damage for 60
  ticks (they bounce); any body takes at most 60 energy of debris impacts per tick.
- **Ledger.** Nothing leaves the cells before its shear; CRUSH compaction takes the packed share out of a held cell's density
  at once and packs exactly that into the rim. Exact (tests assert < 1e-3 every tick).
- **Determinism.** Wounds, slabs, the shear schedule, `map.detached`, slow-cut contents, waves, chunk heat/age/flags/inertia, the
  last blow, debris budget and tidal cadence are all hashed now (closing the Phase 0 gaps). `forceFullConn` equivalence still holds
  on the 16 scenarios. Harness carving (`carve`) runs with `core.woundsOff` (instant separation) and now never digs through the core.
- **FX timing.** The flash disc lives 4 + 1.5k ticks; the near-camera plume and the crater dust plume start 40+ px / above the
  bowl and are thrown clear; the dust ring is faster and shorter. Matter FX clear a 52 px wound box in 283-333 ms wall after
  every slice heavy blow (`tools/matter/wounds.ts`; telemetry baseline ≈ 1.75 s with S5's washes).
- **Pool policy.** The overflow victim is the smallest settled chunk (age ≥ 240 ticks, the oldest first); young chunks are only
  degraded when every chunk is young. Near-class chunks over the 24/frame budget are drawn 1x in the fight plane (same parallax),
  never dropped. Degrading uses the chunk's own interned material ramp (`Chunk.dustRamp`): the 512-entry ramp table is no
  longer filled by debris.
- **Measured** (`npx tsx tools/matter/wounds.ts`, real titans, authored hit-stop; `wound.test.ts` asserts all of it):

| blow | 1.5 s loss | max 1-tick share | to chunks (solids) | shear ms | momentum | FX clear ms |
|---|---:|---:|---:|---:|---:|---:|
| planet.impact → planet | 181 | 11 % | 100 % | 250 | 100 % | 333 |
| lastone.shatter → planet | 519 | 11 % | 91 % | 233 | 101 % | 317 |
| lastone.lastlight shear → planet | 724 | 10 % | 95 % | 250 | 99 % | 0 |
| planet.impact → lastone | 562 | 7 % | 92 % | 233 | 99 % | 333 |
| planet.cataclysm quake → lastone | 1446 | 8 % | 85 % | 233 | 99 % | 333 |
| lastone.shatter → lastone | 1167 | 9 % | 95 % | 217 | 99 % | 317 |

  In real AI fights (`npx tsx tools/lead/pacing.ts --n=10`, the whole tree as of this round): the median heavy hit's largest
  one-tick loss fell from 48 % to 12 % of its 1.5 s loss on the Planet (that tick: 98 % → 58 % particles) and from 36 % to 6 % on
  the Witness. What still leaves in bulk as particles: the Last Light beam's PIERCE channel (every tick, by design), fluids and
  gas, pulverised cores, and settled debris degraded when the 400-chunk pool overflows.

## Round 9 (slice Phase 2): rotation, capture, persistence, the two-face shell

- **Rotated regions** (proposal 140/161). `BodyTransform.rot` routes every hit test, collection and chunk extraction
  through the contract sampler's alpha-first vote (`@/contracts/rotation`). The matter-drawn cell equals the renderer's
  winner: 0 mismatches over the parity test. `rot` 0 or absent is byte-identical (hash test).
- **Joint patches and severed regions.** `anchorCells` replaces the core disc as connectivity seeds. `jointHealth` and
  `bodyToChunk` were added.
- **Parallel wounds.** The shear budget and the slow-cut quota are now per wound. Five overlapping blows each shear on
  their own beat (impact + 1 + shearDelay). The spread is ≤ 22 ticks, where before the five blows queued for ~2 s.
- **Capture** (proposal 142).
  - Owner rings (`setOrbit`, with `flatten`). Captured chunks are pinned and never degraded.
  - `launchChunk` gives an uncapped KINETIC blow of ½·m·(v/60)², credited to the thrower and passing through its bodies.
    In the test, a thrown 160-mass rock removes more than 3× the mass the same rock does flying in freely.
  - `strikeChunk` breaks a ring chunk into free pieces. `retireChunk` books the chunk's mass as dissipated.
- **Persistence.**
  - The chunk cap is 640, with no measurable bench cost.
  - Gravel lives 60 s, up from 25.
  - `Chunk.temp` cools along the chunk's dominant material `glowRamp`: a molten chunk dims its emissive pixels, and a
    heavy blow's slabs leave glowing at min(0.7, E/2000).
  - Settled chunks drift at 2.5 px/s.
- **Wound light belongs to the body.** CRUSH fissures glow only with `Body.fissureGlow` (molten rock by default on a
  magma-bearing body, or `setFissureGlow`). The blow flash and sparks, vapour and streak heat follow the struck
  material's `glowRamp`; there are no fixed orange ramps left.
- **Two-face shell** (`shell.ts`). The far face is the pristine body mirrored about the core column. It is stored in its
  post-turn coordinates, so a swap is an exact per-cell exchange and two swaps are the identity. Edge bonds swap with
  their face. Ledger and stats count both faces. A swap settles wounds in flight first. swap + tick takes 7.9 ms p50 on
  a 216² map with 44.7k shell cells; the cost is the full rebuild, paid once per half-turn.
- **Aftermath.** Rendering never steps the world (test: three views, same hash, the same view gives the same pixels).
  `renderExport(view, k)` resamples chunks at k×; particles are upscaled nearest.
- **GC** (`tools/matter/gc.ts`, 3 minutes, render every tick): 2 minor pauses, max 0.46 ms, none over 4 ms. This came from
  int32 colour arithmetic in `visual.ts` and render targets built once.