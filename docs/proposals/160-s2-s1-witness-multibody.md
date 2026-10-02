# 160 — S2 → S1: what the Witness needs from multi-body fighters (SLICE_PHASE2, S1 task 3)

**Owner of the change:** S1 (`src/combat/fighter.ts`, `behaviour.ts`). **Requested by:** S2 (`behaviours/lastone.ts`, `src/combat/rig/`).

## What S2 already has

- `paintWitness(seed, lighting)` in `src/titans/art/lastone.ts`.
  - It returns about 25 region maps. Each comes with:
    - `pivotX/pivotY`: the frame origin in body px, relative to the eye's centre;
    - `parent`;
    - `weld`: the interior reveal layers share the carapace's rig body;
    - `layer`: reveal layer 0–3;
    - `z`: draw order.
  - It also returns the arm joint chains, membranes and fibres.
- `buildWitnessRig(body, materials, x, y)` and `setWitnessHeading(wr, angle, tick)` in `src/combat/rig/witnessRig.ts`.
  - They build an `XpbdRig` with one rigid body per region (the eye is kinematic: the intent).
  - Mass and inertia come from live cells.
  - The rig is tuned to the scale spec: ω ≤ 7 rad/s on the carapace, ≤ 4 on everything else.

## Proposed API (additive)

### 1. Region bodies owned by a fighter

```ts
// Behaviour hook (default: none). Called once in the Fighter constructor, before the titan body is created.
createRegionBodies?(world: MatterWorld, spec: { x: number; y: number; facing: 1 | -1; seed: number }): RegionSet;

interface RegionSet {
  /** Region bodies, in draw order. Index 0 is the PRIMARY body (the eye cradle, the KO core): it becomes `f.body`. */
  bodies: MatterBody[];
  /** Per body: counts toward KO / mass / integrity (false for the halo arcs: they are the resource, like moons). */
  counts: boolean[];
}
```

- The Fighter keeps `f.body = bodies[0]`. Everything that reads `f.body` today keeps working:
  - the portrait;
  - `view.body`;
  - core integrity: the eye is the KO core per D27, so `coreIntegrity` stays the eye's.
- The behaviour owns the bodies' transforms (`x`, `y`, `rot` from the rig) and sets them in `update()` before `world.tick()`.

### 2. Aggregation

- **Mass and integrity:**
  - `view.bodyStats.mass` = the sum over the counted bodies;
  - `massFrac` = that sum ÷ the sum of their initial masses;
  - `cells` summed.
  - `regionGrid` may stay the primary body's.
  - KO by mass uses the aggregated `massFrac`. KO by core uses the primary body.
- **Bounds:** `liveBounds` = the union of the counted bodies' world AABBs (the camera and the tether use it).

### 3. Hit routing

- `probe(shape)`: `world.overlap` over all region bodies.
  - `cells` summed;
  - the centroid weighted by cells;
  - `nearestX/Y` from the nearest body.
  - `behaviour.probeParts` is still called after.
- `receive(ev)`: the defender's fighter calls a new behaviour hook first:
  ```ts
  routeDamage?(ev: DamageEvent, out: { results: DamageResult[] }): boolean; // true = handled, skip the default world.applyDamage on f.body
  ```
  - The Witness applies the event front to back: arms, carapace, channels, lattice, abyss, eye.
  - Energy passes through the holes of each front layer to the next. That is how the reveal layers work, and why a blow does not
    hit all four stacked layers at once.
  - The Fighter sums `cellsRemoved` / `massRemoved` / impulse over `results` for hit-stop, knockback and HUD exactly as today.

### 4. Rendering

- `Fighter.renderLayers` keeps pushing `f.body`'s layer.
- The behaviour pushes one layer with `parts` (proposal 151) for the other regions.
- Until S5 lands `parts`, the behaviour falls back to one world layer per region, drawn unrotated at its translated pivot.

### 5. Hashing

- The rig state must enter the match hash: `XpbdRig.hash()`.
- Proposal: `Behaviour.hash?(h: number): number`, folded into the fighter's hash.

## Why

- Hit-stop, knockback, KO, HUD and AI stay in the fighter core.
- The Witness keeps its anatomy (rig, layers, routing) in its behaviour.
- The other titans are unaffected: every hook is optional, with today's behaviour as the default.

---

## S1 answer (2026-10-02): accepted, with four amendments. Implemented in `src/combat/fighter.ts`, `behaviour.ts`, `damageSum.ts`; tested in `src/combat/multibody.test.ts`.

1. **No constructor hook.** The primary body stays the one the fighter creates from the titan generator. For the Witness, the
   lastone generator returns the **eye cradle** map, so `f.body` is the eye cradle: KO core, portrait, impact frame. The
   behaviour creates the other regions in `attach()` with `world.createBody({ kind: 'part', ownerSlot, anchorCells, transform:
   { …, rot } })` and registers each with **`f.addRegion(body, counts = true)`**. Halo arcs use `counts = false`.
   - **Sever:** call **`f.removeRegion(id)` BEFORE `world.bodyToChunk(id, …)`**. The region's pristine mass stays in the
     total, so the loss counts toward KO.
   - **Between rounds:** `nextRound` heals every registered region. To regrow a severed one in `reset()`, create it and call
     `f.addRegion(body, counts, true)`; its pristine mass then stops counting as lost.
2. **Placement:** use **`Behaviour.placeRegions()`**, not `update()`. It is called right after the primary's transform,
   BEFORE this tick's hits are resolved, so a blow meets the regions where they are drawn. `resolvePair` calls it again after
   a contact shifts the root. Set `x`, `y` and `rot` there; `lean` stays 0 on rotated regions.
3. **Routing:** `routeDamage(ev, out: DamageSum): boolean`. Fold each world result in at once with
   `addDamageResult(out, world.applyDamage(id, ev))` (`src/combat/damageSum.ts`), because the world may reuse its result
   object. Return true when handled. The default (false) applies the blow to the primary, or, for a multi-body fighter,
   splits it over every touched body in proportion to the cells touched on each. Hit-stop, knockback, the impact model, the
   HUD and the hit event all read the sum.
4. **Hash:** `Behaviour.hash(h): number` (default h), exposed as `FighterImpl.stateHash(h)`. The Match must fold it in; that
   asks the Lead for one line in `match.hash()` (proposal 162).

As proposed:
- **Aggregation:** mass, massFrac, cells and the burning/infected/cracked counts are summed over the primary and the counted
  regions (plus the pristine share of severed ones). `coreIntegrity`, `exposedCoreFrac`, `anchoredFrac` and `regionGrid` are
  the primary's. KO uses both.
- **Bounds:** `view.bounds*` = the union over ALL region bodies, counted or not, so the camera, tether and AI see the whole
  silhouette.
- **probe:** cells are summed, the centroid is cell-weighted, and `nearestX/Y` comes from the body with the most cells.
  `probeParts` runs after.
- **Rendering:** as proposed. The fighter keeps pushing the primary's layer; the behaviour pushes the parts layer.

The impact model (centre/edge/glancing/low, the lever arm) uses the **primary's** centre of mass and gyration. If the
Witness should spin about the whole rig's centre of mass, expose it (e.g. `Behaviour.massFrame(out)`) and I will read it.
## S1 follow-up: the whole rig's mass frame (Lead, 2026-10-02)

Agreed: whole-rig torque is closer to the brief ("redistributes load"). The new hook is
**`Behaviour.massFrame(out: { x, y, gyration, radius }): boolean`**. Return true and give the WORLD centre of mass of the
whole fighter (all counted regions, weighted by live mass), its radius of gyration and its outer radius (px). The impact
model then turns blows about that frame: the lever arm, the inertia and the centre/edge/glancing/low classification. It
returns false by default, which keeps the primary's own mass properties. Proposal 163 (`createFighter` + `witnessDef`) has
landed in `src/combat/index.ts`.