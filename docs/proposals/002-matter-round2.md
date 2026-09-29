# 002 — Matter round 2: calibration, tail latency, doc clarifications (B2)

No contract change is required. This lists the behaviour changes integrators (B3, the Lead) can observe, and the doc-comment clarifications to apply to `src/contracts/damage.ts` / `matter.ts`.

## 1. Behaviour changes (all inside `src/matter`)

- **Damage calibration.** A landed Strike (~300 energy, delivered like the real moves: Lash = 4 line hitboxes of 75, Glancing Blow = `r=27` point with `crater: 6`) now removes 1–4% of a titan-size body (8.5k cells) from every solid material and 3–9% from the matched ones; a Crush (~1500: Shatter Blow cone, Meteor ram) removes 5–12% from the worst-matched and 10–25% from the matched. Iron/chain/core are no longer ~0% under FRACTURE. Full tables: `docs/DESTRUCTION.md` (regenerate with `npx tsx tools/matter/calibrate.ts`).
  Mechanism: raw energy pays every cost (the mean resist was counted twice before), every model spends its whole budget, and no cell costs more than a cap to remove (FRACTURE chisel 1.8 energy/cell, THERMAL core melt 2.4, TIDAL floor 0.4/tear). The archetype resist table kept its character; a few floors were nudged (ironNickel FRACTURE 0.55→0.65, KINETIC 0.7→0.75; chain FRACTURE 0.6→0.7, CRUSH 0.8→0.85, KINETIC 0.8→0.85; core FRACTURE 0.7→0.8, CRUSH 0.6→0.75, KINETIC 0.8→0.85; tendril FRACTURE 0.7→0.75, CRUSH 0.6→0.7, KINETIC 0.8→0.85; mantle THERMAL 0.6→0.7; ocean THERMAL 0.45→0.6, KINETIC 0.4→0.45). Gases got a dispersal temperature (`vaporize` 1000–1600) so THERMAL can strip them, and softer `heatAbsorb` (gas 0.35, cloud 0.3, ocean 0.3).
- **FRACTURE is now cuts + grind + a deferred chisel.** The chewing share of the energy runs 3 ticks after the blow (job queue), so a FRACTURE `DamageResult` reports few `cellsRemoved`/`massRemoved` (the slabs arrive later as `detach` events, the pit as dust). Use `cellsTouched`, `impulse*`, `contact*`, `onDamagedFraction` for hit feedback, and the `detach`/`consume` sim events for what left the body. A short line (`penetration` < 24, no PIERCE: Lash, Thrust) now shears a slab sized by its energy instead of grooving 5 cells; beams and PIERCE lines still cut along their axis.
- **`params.crater` is a lower bound**, not an override: the bowl is at least this radius but the energy is always spent (a Strike with `crater: 6` used to waste 90% of its energy).
- **TIDAL** peels the outline first (loose matter deep inside scores 0.08 instead of 0.6) and no tear costs less than 0.4 energy (a Strike no longer strips a whole gas corona).
- **`MatterWorldEx.diagnostics()`** gained `jobs` (pending multi-tick slices + deferred chisels). `world.hash()` folds the job queue in. `warmUp()` is exported (see 001).
- **Connectivity** takes a local shortcut when it can prove the result (details in `docs/DESTRUCTION.md` §4); results are bit-identical to the full flood (`core.forceFullConn`).
- Immunity is per type and enforced everywhere (cut, crater, shrapnel, shock, blast, crack fronts): only cells whose resist for the type is 0 (the horizon) are immune.
- When the core disc is destroyed and the body splits, the LARGEST connected mass is anchored (before: the live cell nearest the old core, which could orphan the whole body).

## 2. Doc-comment clarifications for `contracts/damage.ts`

- `DamageParams.crater`: "KINETIC/CRUSH: minimum crater radius in cells; the energy is always spent, so a large blow may dig wider. Replaces 'overrides shape-derived default'."
- `DamageParams.penetration` (FRACTURE lines): "depth of the boring channel of a line; a line with penetration < 24 and no PIERCE additionally shears a slab like a blow."
- `DamageResult.cellsRemoved/massRemoved`: "removed by THIS call. FRACTURE frees most of its matter later (slabs via connectivity, a chisel a few ticks after): read the `detach` events."
- `DamageEvent.energy`: "1 energy destroys one baseline cell at full efficiency; matched types remove ~1–3 cells per energy, the worst-matched ~0.3–0.5 (never 0 except vs immune matter)".

## 3. Notes for B3

- Real move numbers (docs/TITANS.md) were used for the calibration; if hitboxes change a lot (energy per hitbox, point radius), re-run `tools/matter/calibrate.ts` and check the rows of the materials your titans are mostly made of stay above 1% (Strike) / 3% (Crush).
- Do not rely on `DamageResult.cellsRemoved` being proportional to the visible damage for FRACTURE (see above).
