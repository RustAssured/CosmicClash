# BUILDER 2 — MATTER & DESTRUCTION

Read `docs/briefs/COMMON.md` first. **You own:** `src/matter/`, `dev/matter/`, `tools/matter/`. Pure TypeScript (no DOM/three/Math.random) except `dev/matter`. Port **5202**.

## Mission
Build the heart of the game: a deterministic, fast, gorgeous **destruction simulation** where a titan's body is a map of pixel matter and every damage type
takes it apart *in its own way*. Damage is not a health bar — it is removed, burned, infected, cracked, crushed, devoured pixels, and the remains fly, tumble, glow, fall as ash, or are
eaten. A finished fight must leave both bodies visibly carved and the arena littered with remains. Implement `MatterWorld` from `src/contracts/matter.ts` exactly
(`createMatterWorld(seed): MatterWorld` exported from `src/matter/index.ts`), plus `buildMaterialTable`.

Read `src/contracts/damage.ts` and `src/contracts/matter.ts` **line by line** — the doc comments define semantics (energy calibration: 1 energy ≈ destroys one baseline cell; world-space shapes;
`originX/Y` sinks; `DamageResult` fields; `BodyStats` incl. 8×8 world-oriented `regionGrid`; `heal/restore/carve/grow/shed`; screen-space `renderLayers`).
If a contract is insufficient, write a proposal in `docs/proposals/` and carry on with an internal extension.

## Interfaces you must honour with the other builders
- **Material archetypes.** Titan JSON (`MaterialSpec.base`) names *your* physics archetypes. Export `MATERIAL_ARCHETYPES: Record<string, MaterialPhysics>` and provide **at least these keys**
  (B3 is authoring against this list now; add more if you need, never rename): `rock, regolith, mantle, ironNickel, ice, crystal, glass, celadon, eye, tendril, lattice, chain, node, plasma, corona, gas, cloud,
  fuelGas, diskGas, jet, ocean, magma, core, horizon, ash, char`. Tune each so that the **resist table** produces the intended rock-paper-scissors *emergently* (e.g. `celadon`/`glass`/`crystal` brittle → FRACTURE shears them;
  `ironNickel`/`chain` tough → resists FRACTURE, weak to THERMAL less so; `ice` melts/boils away under THERMAL; `regolith` erodes to dust under KINETIC; `ocean`/`gas`/`cloud` soak heat (`heatAbsorb`);
  `lattice` ignites/burns; `fuelGas` flammable; `horizon` immune to everything; `plasma`/`corona` are low-density, gas-debris, resist KINETIC/CRUSH but are stripped by TIDAL). Document the table in `docs/DESTRUCTION.md`
  (you own that file: write it as you go — the resist matrix, each model's algorithm, tuning knobs).
- `buildMaterialTable(specs: MaterialSpec[]): MaterialDef[]` — **index 0 is the reserved EMPTY material; `specs[i]` gets id `i+1`** (B3 relies on this so it can fill `map.material` before your code runs).
  `ashTo` keys resolve against the same table; if a spec references `'ash'`/`'char'` and the titan didn't list one, append the archetype automatically (and put appended ids after the authored ones).
  Hex colours → packed; `glowRamp` default = generic ember ramp (dark red → orange → yellow → white).
- **What the generator hands you** in `createBody(spec)`: `map.material`, `map.density`, `map.baseColor`, `map.height`, `coreX/Y/Radius` filled (integrity may be 0 = "unset" → you set 255). **You** initialise
  bonds (`bondR/bondD` from the two cells' material `bond` × titan `attributes.cohesion` scale × small deterministic noise; **weaker across material-layer boundaries** and along authored fault seams so damage
  *reveals* layers), integrity, flags (SURFACE), emissive, `pixels` (initial refresh), stats, and snapshot for `restore/heal`. Map dims may exceed the intact body (room to grow).
- **Pixels are yours to refresh.** `map.pixels` = what the player sees. Layer on `baseColor`: heat glow (`glowRamp` by temperature), char/ash darkening, infection tint (assimilated crimson lattice look — Nexus), crack lines
  on low-bond cells, freshly exposed **edges re-lit** with the stage light (`setLighting`) using `height` gradients + neighbour presence (rim highlight on the lit side, deep shadow on the other), integrity dimming, plus
  `emissive` output for bloom. Refresh only dirty rects; bump `map.version`, expand `map.dirty`.
- **Transforms.** Owners mutate `body.transform` each tick before `world.tick()`. Damage/probe geometry is WORLD space; convert with `contracts/space.ts` (mirror + lean-shear aware).

## The destruction models (priority order — ship in this order, report where you stopped)
Core engine first (bodies, bonds, connectivity, detachment, chunks/particles, render, stats, determinism, perf), then per model. Each model must be **unmistakable at a glance** and *physically motivated*.

1. **FRACTURE** (Last One): strikes shear the enemy apart *piece by piece along its weakest bonds*. Given a shape, find the weakest bond paths through the covered region (e.g. bond-weighted shortest/`min-cut`-ish
   paths via a cheap graph search or randomised walker guided by bond strength) and break them, producing straight-ish clean shear lines; detached islands become tumbling rigid chunks with spin from the impulse.
   `SEED_CRACK` plants crack seeds whose **fronts propagate over the following ~1–3 s** along low-bond/high-stress bonds (stress from the blow, decays with distance, higher in brittle materials, tougher materials arrest cracks);
   cracked bonds render as dark fissure lines and can finally shear whole slabs off. `line` shapes carve a channel (Tendril Lash, Gaze with `PIERCE`/`CONTINUOUS`).
2. **KINETIC** (Asteroid): ballistic impacts carve **craters** (radius from energy/`crater`, shock-loosened rim, raised lip cells damaged), spray **ejecta** (chunks + dust particles, momentum-conserving, directional along `dirX/Y`),
   and `EMBED` leaves **shrapnel** (flag `SHRAPNEL`, glints) that **fractures outward after `embedDelay` ticks** (a small radial burst that breaks bonds → secondary chunks). Regolith craters wide/soft, iron deep/clean.
3. **CRUSH** (Planet; also Asteroid heavy hits): compression front — cells crush toward the impact (density up, integrity down), **impact craters with shock rings** (emit `matter`/shock through SimEvent? no — return via `DamageResult` and
   spawn ring-shaped particle/bond-break wave inside the sim), tectonic crack lines along bond faults; sustained crush on the same region keeps compressing.
4. **THERMAL** (Supernova): heat diffuses into cells (stable explicit scheme, `conductivity`, `heatCapacity`, `heatAbsorb` soak for atmosphere/oceans); above `ignition` cells **burn** (`BURNING`), **burning fronts spread** neighbour to neighbour
   over time (rate by material), cells **char → ash → ablate as embers** (`ashTo`, `debris:'ember'`); `vaporize` strips instantly; `oceans` boil (steam particles) and stop conducting; `flammableGas` ignites (fireball particles that can be
   pulled by TIDAL fields — matchup emergence). Shock rings (`params.shock`) blast loosened/burning material outward.
5. **TIDAL** (Black Hole): field-shaped force toward `(originX,originY)`; a cell whose tidal stress `> bond` (stress ∝ pull × gradient across the bond × 1/cohesion) is torn away, **stretched (spaghettified) along the pull** into streams of particles that **spiral inward** (angular momentum!) into the
   sink and are **consumed** at `GravitySource.consumeRadius`, crediting mass to `creditBodyId` (`massGained/massLost` in `stats`). Loose/low-bond matter goes first; gas/plasma strips easily; `horizon` immune. `GravitySource` also pulls all debris/particles (slot-owned via `setGravitySource`).
6. **ASSIMILATION** (Nexus): `LATCH` infects cells at the contact; `infection` spreads along bonds over time (rate by `assimilable`), converted cells (`ASSIMILATED`) become lattice look (`infect` colour), slow/weaken, and — with `harvest` — are **torn out** and
   fly to `(originX,originY)`, credited as mass to `sourceBodyId` (harvest). Infection can be burned out (THERMAL kills infected cells faster: emergent).

Every model must: conserve mass (see below), be deterministic, be cheap when idle (active-region tracking: iterate only regions with heat/cracks/infection/fuses), and respect **`params`/`flags`** on the event.

## Core systems
- **Connectivity & detachment:** after bonds/cells change (dirty flag; at most a few times per second per body, cheap incremental where possible), flood-fill from the core anchor over live cells with intact bonds (use an int stack, no recursion, no allocation);
  unanchored islands (excluding `fluid` materials, which just disperse) become `DebrisChunk`s (extract sprite pixels + emissive, compute centre of mass and inertia, inherit momentum from the blow, spin). Tiny islands (< ~6 cells) become dust particles.
  Emit `SimEvent {t:'matter', kind:'detach'}` with mass/position. **Chunks tumble** as rigid bodies (rotation, drag, arena soft walls, mutual soft repulsion optional), respond to gravity sources, can collide with bodies (`takesDebrisImpacts`: a fast heavy chunk hitting a body deals a KINETIC event — modest, capped),
  and can fracture again when they hit something hard. Persist (cap `MAX_DEBRIS_CHUNKS`, oldest/smallest degrade to dust). Slowly drift; the arena becomes a record of the fight.
- **Particles:** pooled struct-of-arrays (≤ `MAX_PARTICLES`): spark, ember (cools ramp, fades), dust, gas (soft, drifts), ash, glint, plasma, shard, mote. Emissive → bloom. Stable, no allocation. `spawnParticles` is also the VFX API for combat.
- **Mass economy:** `mass` in `MatterMap` and `BodyStats`; ledger tests: `initialMass − currentMass == Σ(chunk mass + particle mass + evaporated + transferred out)` within ε at all times; `grow/shed/heal/restore/carve` obey it (restore/heal *create* matter from the snapshot — account it as `healed`).
- **`stats()`** incremental: `mass, massFrac, cells, coreIntegrity, anchoredFrac, exposedCoreFrac, burning/infected/cracked counts, massGained/Lost, regionGrid (8×8, WORLD orientation, accounts for facing)`.
- **`overlap()/solidAt()`** pixel-accurate against live cells with lean/mirror (this is the game's hit detection — make it fast: iterate the shape's AABB in local space; early out).
- **`carve(id, massFrac, seed)`** (harness `?state=50|10`): apply a deterministic *sequence of realistic damage* (mix of the model types suited to the body's materials, biased to leave the core last) until `massFrac` is reached; must produce believable scarring, not noise. **`heal(id, fraction, seed)`**: restore part of the missing matter *as scars* (restored cells come back with reduced integrity, cracks, char).
- **Debug overlays** (`debugOverlay(id, mode)`): temperature, integrity, bonds, infection, islands, stress, materials → a world-space `RenderLayer` (z above titan) for Training mode. Cheap, allocation-free (reuse a layer).
- **`renderLayers(view, alpha)`** returns pooled screen-space layers: `debris-back` (z −20: settled/drifting chunks behind titans) and `fx-front` (z +10: chunks in front, particles, embers; with `emissive`). Rotated chunk rasterisation with nearest sampling and per-chunk lit shading; `alpha` extrapolates by velocity.
  Add subtle depth cheats (a few chunks in front, most behind) deterministically from chunk id.
- **`hash()`** covers all state incl. RNG; **two runs with identical seed + call sequence must match**, including after `carve`, damage of every type, and 600+ ticks of aftermath.

## Performance (hard)
≤ **5 ms/tick** for two ~150×150 bodies (≈22k cells each) + 400 chunks + 6000 particles under continuous damage; target ≤ 2.5 ms typical. Techniques: per-body dirty rects & active tile lists (e.g. 16×16 tiles flagged when heat/cracks/infection/fuses live there),
flat typed-array loops, integer math where possible, pre-sized pools, no closures/allocation in ticks, connectivity only when needed, refresh visuals only for changed tiles. Write `tools/matter/bench.ts` (run with `npx tsx`) that reports avg/p50/p95/p99/max ms per tick over
a scripted 60 s fight with all damage types, plus an allocation check (heap delta over 1000 idle-damage ticks). Put numbers in `docs/PERF.md` under `## Matter (B2)` (create if absent; append only your section).

## Testing (required)
- Determinism (hash equality across two runs; different seeds diverge). Mass conservation. `overlap/solidAt` vs brute force incl. mirrored/leaning bodies. Connectivity/detachment correctness on hand-built shapes (a bridge cut in two → the far half detaches).
  Each damage type has a behavioural test that asserts *what it does differently from the others* on the same target (e.g. FRACTURE yields few large chunks, KINETIC many small + crater, THERMAL yields no chunks but burning/ash, TIDAL yields consumed mass credited to the source, ASSIMILATION converts cells and harvests).
  Stability: heat scheme never NaN/explodes over 10k ticks; cracks terminate. Serialization-free `restore()` exactness.
- Use synthetic test bodies: build `src/matter/testing/bodies.ts` (layered disc: crust/mantle/core with faults; ribbed slab; sparse lattice; gas-shrouded planet) with your own `MaterialSpec`s — the real titan generators come from B3 later and will be integrated by the Lead.

## Dev sandbox
`dev/matter/index.html`: a 2D-canvas viewer (draw `map.pixels` ×3 + `world.renderLayers` output), two synthetic bodies, click/drag to fire any damage type/shape/energy/direction, sliders for energy, toggles for debug overlays, tick stepper, live stats (mass ledger, ms/tick).
Screenshot it with `tools/lead/shot.mjs`, **look at the PNGs**: fracture lines must read as fracture, craters as craters, burning as burning, tidal streams as spiral streams. Curate 3–6 best frames into `docs/gallery/matter-*.png`.

## Deliverables checklist (Phase 1)
- [ ] `src/matter/index.ts` exporting `createMatterWorld`, `buildMaterialTable`, `MATERIAL_ARCHETYPES` (+ types). `src/matter/README.md` (API, invariants, knobs).
- [ ] Core + FRACTURE + KINETIC excellent; then CRUSH, THERMAL, TIDAL, ASSIMILATION in that order (working baselines at minimum, tuned as time allows).
- [ ] `docs/DESTRUCTION.md`, tests, bench + PERF numbers, dev sandbox screenshots looked at, final report per COMMON.md.
- [ ] **Early milestone:** as soon as bodies + `applyDamage` (FRACTURE/KINETIC basic) + `overlap` + `renderLayers` + `stats` work end-to-end (target: first ~third of your session) write a one-line `docs/proposals/000-matter-milestone-A.md` saying "milestone A ready" — B3 integrates against the real world from then on.
