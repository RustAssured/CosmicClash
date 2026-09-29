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

Design intent encoded in the numbers: celadon/glass/crystal are brittle (`brittleness` 0.9+, FRACTURE resist 1.35–1.6): cracks run, slabs shear. ironNickel/chain/tendril are tough (FRACTURE 0.55–0.7,
bond 205–235): cuts run out of energy and cracks arrest. `ice` boils away (THERMAL 2.4, vaporize 450). `regolith` erodes (KINETIC/CRUSH 1.25–1.3, debris dust). `ocean`/`gas`/`cloud` soak heat (`heatAbsorb` 0.5–0.55).
`lattice` burns (ignition 320, ashTo ash) and infects readily (assimilable 1). `fuelGas` ignites at 140 and flash-burns. `plasma`/`corona`/gas are featherweight, resist solid attacks and are stripped by TIDAL (2–2.4).
`horizon` is immune to everything (all resist 0, bond 255).

### Measured effect (calibration table)

`npx tsx tools/matter/calibrate.ts` hits a uniform disc of one archetype with 500 energy of each type and reports **mass removed per energy** after 240 ticks (ASSIMILATION column = cells infected after 4 s). A baseline rock
cell is ~1 mass/energy for a perfect blow; tune archetypes so the matchups you want appear here.

| archetype | FRACTURE | ASSIMILATION | TIDAL | THERMAL | CRUSH | KINETIC |
|---|---:|---:|---:|---:|---:|---:|
| rock | 0.72 | 787 inf | 1.01 | 0.45 | 0.47 | 0.78 |
| regolith | 0.49 | 961 inf | 1.07 | 0.44 | 0.68 | 1.14 |
| mantle | 0.80 | 787 inf | 1.11 | 0.00 | 0.42 | 0.70 |
| ironNickel | 0.00 | 720 inf | 1.41 | 0.79 | 0.49 | 0.57 |
| ice | 0.43 | 863 inf | 0.94 | 0.34 | 0.46 | 0.61 |
| crystal | 0.98 | 666 inf | 1.16 | 0.74 | 1.03 | 1.28 |
| glass | 1.43 | 609 inf | 1.08 | 0.62 | 1.10 | 1.40 |
| celadon | 0.90 | 791 inf | 1.09 | 0.63 | 0.62 | 1.20 |
| eye | 0.72 | 1159 inf | 1.14 | 0.51 | 0.84 | 1.44 |
| tendril | 0.01 | 1157 inf | 1.16 | 0.40 | 0.13 | 0.41 |
| lattice | 0.52 | 0 inf | 1.01 | 0.40 | 0.49 | 1.01 |
| chain | 0.01 | 1368 inf | 1.28 | 0.91 | 0.36 | 0.64 |
| node | 0.94 | 1082 inf | 1.11 | 0.85 | 0.69 | 1.87 |
| plasma | 0.08 | 1382 inf | 1.85 | 0.00 | 0.06 | 0.05 |
| corona | 0.03 | 912 inf | 0.98 | 0.00 | 0.03 | 0.02 |
| gas | 0.02 | 751 inf | 0.62 | 0.00 | 0.02 | 0.01 |
| cloud | 0.08 | 774 inf | 1.23 | 0.00 | 0.07 | 0.02 |
| fuelGas | 0.03 | 751 inf | 0.62 | 0.07 | 0.02 | 0.01 |
| diskGas | 0.10 | 751 inf | 0.09 | 0.00 | 0.06 | 0.03 |
| jet | 0.01 | 578 inf | 0.05 | 0.00 | 0.02 | 0.01 |
| ocean | 0.34 | 781 inf | 1.53 | 0.00 | 0.71 | 0.12 |
| magma | 0.68 | 953 inf | 1.13 | 0.00 | 0.57 | 0.56 |
| core | 0.00 | 774 inf | 1.13 | 0.00 | 0.22 | 0.71 |


Reading it: the Last One (FRACTURE) wrecks glass/celadon/crystal (0.9–1.4) but barely scratches iron and chain (0.00–0.01 at 500 energy: it needs ~1500-energy Shatter Blows or the regolith/ice seams
of an asteroid); KINETIC is best against brittle and soft matter (1.1–1.9); THERMAL is the counter to flammables, ice and light matter and is ~0.4–0.9 against solids; TIDAL strips everything but is
by far the best against low-bond gas/plasma (many cells per energy; the `mass` column is low because gas is light); CRUSH is the broad, shallow, compacting hit.

## 3. The models

Every model: reads only the event's `params`/`flags`, conserves mass, is deterministic, and is cheap when idle (active tiles / fronts / fuses are only processed while something is going on).

### 3.1 FRACTURE — `fracture.ts`, `cuts.ts`, `cracks.ts`
*Shear the target apart along its weakest bonds.*
- **Bonds are created weak where breaks should happen.** At `createBody` every bond gets `min(material bonds) × layerFactor(0.62 across materials) × grainSeam × fault × noise(±14%) × cohesionScale`.
  *Grain seams*: a warped jittered-grid Voronoi partition (≈17-cell plates) whose boundary bonds are weakened by `0.52·(0.35+0.65·brittleness)`. *Faults*: 2–3 authored long, wobbling weak lines (×0.42). Damage therefore reveals layers and follows natural shear planes.
- **Cuts.** Crack paths run on the *dual lattice* (cell edges; every interior edge is one bond byte). A bond-weighted Dijkstra (`CutFinder`, preallocated, generation-stamped) finds the cheapest path between two outline points
  (or an interior end for a stab). Blows use **U-cuts**: outline corner → interior waypoint (depth from the energy: slab area ≈ 1.5·E_eff cells) → outline corner, so the slab between the cut and the outline is *isolated*; more energy = more and larger cuts (≤3).
  Line shapes cut along their own axis (Tendril Lash); shallow chords dive under the outline. Each severed bond costs `bond/255 · K_E(3.6) · cohesionScale / resist`; if the budget runs out the last bond is only weakened and a live crack tip is left.
- **Grinding**: cells beside a cut are bruised (integrity), shed dust/shards and glints, and die if pushed to zero. **Seam pop**: brittle matter loosens grains near the surface. **PIERCE + line**: bores a channel along the axis from the entry surface inward.
- **SEED_CRACK** plants `crackSeeds` **crack fronts** on the surviving side of the cuts. A front moves along dual edges, choosing the weakest of forward/left/right (bond + turn penalty + noise), breaks the edge if its stress exceeds
  `bond · cohesion · (0.26 + 0.5·toughness)`, pays `need·(0.36·(1-brittleness)+0.03)` in stress (brittle matter lets cracks run, ductile arrests them), branches in brittle matter, and stops at the outline, where connectivity releases the slab.
  Fronts advance 0.45–1.2 edges/tick so networks spread over 1–3 s.
- Released slabs inherit the blow: direction with the *inward* component removed (they slide off, never into their old body), speed `190·sqrt(E/(m+25))` px/s, spin from the lever arm.

### 3.2 KINETIC — `kinetic.ts`, `crater.ts`
*Craters, ejecta, shrapnel.* First contact = the covered cells nearest the shape origin, slid back along −direction to the outline. The bowl is an ellipse oriented on the surface normal, depth/width derived from the material
(`0.5 + 0.95·toughness·(1−0.45·brittleness)`: iron deep and clean, regolith wide and soft; `params.crater` overrides). Cells are ranked by normalised elliptical distance; the threshold radius is the smallest whose cumulative cost pays 78% of the
budget (so hard matter → small crater); the other 22% bruises and loosens the rim (radial cracks, spall). Removed matter becomes **directional ejecta**: 5×5 fragments of ≥6 cells leave as rigid chunks (probability 0.72 for chunky/shard debris), everything else as
dust/shards/embers per the material's `debris`; speeds are highest at the crater centre, biased along the blow and out of the surface. A flash of sparks marks the contact.
**EMBED** plants `embed` (default 3) shrapnel cells (flag SHRAPNEL, pulsing glint) past the crater floor along the direction of travel; each fuse counts down `embedDelay` (48) ticks then bursts: pulverises its own cells, breaks bonds in a radius (≈3+0.62·sqrt(E) cells) with
probability falling off from the centre, sparks, and lets connectivity pop the secondary chunks.

### 3.3 CRUSH — `crush.ts` (+ `crater.ts`)
*Compression, craters with shock rings, tectonics.* A wider/shallower crater (aspect 0.42 or from `params.compress`), mostly powder (chunk probability 0.22, slow ejecta), 36% of the budget to the rim. **Compaction**: 35% of the removed mass is packed
into the surrounding cells' density (density byte rises, cells darken; mass conserved; sustained crush keeps compacting/weakening). A **shock ring** (`Wave`) expands from the crater snapping *weak* bonds (seams, faults, layer boundaries) with probability
`0.9·(1−bond/150)²·falloff`, bruising and puffing dust, marked by a ring of light. **Tectonic faults**: 2–5 crack fronts start where the crater edge meets live matter and run outward along the weakest bonds (crust/mantle boundaries first).

### 3.4 THERMAL — `thermal.ts`, `blast.ts`
Heat: `ΔT = perCellEnergy·HEAT_PER_ENERGY(1900)·resist / (heatCapacity·heatTolerance)` (or `params.heat` temperature units), 1.5× for infected matter. Heat **shields**: along the blow (row/column sweep) each layer transmits `1 − 0.5·heatAbsorb` and absorbs `heatAbsorb` of what reaches it, so an atmosphere protects
the crust beneath it unless PIERCE. **Diffusion** is an explicit red-black Gauss–Seidel stencil over ACTIVE 16×16 tiles, each update a convex combination (k = 0.25·conductivity, 4k ≤ 1) so it cannot overshoot/explode; radiative cooling (0.35%/tick bulk, 1.2% at the outline).
**Ignition** at `ignition·heatTolerance`: burning cells self-heat (`tuning.burnHeat` = 20% of ignition/tick: fire spreads and sustains), lose `burnRate` integrity/tick (×1.6 if infected), char below 130 integrity, and at 0 become their `ashTo` material (weak bonds; the mass
difference goes up as embers/smoke) or vanish as embers. Fire kills infection. **Ablation**: non-flammable matter above 50% of its vaporise temperature sheds integrity (glowing melt). **Vaporise** strips a cell into a gas/spark plume (`boil` event for oceans). `fuelGas` flash-burns with
fireball particles. `params.shock` launches a **blast ring** that blows already-loosened matter (burning, charred, hot, low integrity, very brittle) off the body radially.

### 3.5 TIDAL — `tidal.ts`, `stream.ts`, `particles.ts`
A field toward `(originX, originY)`. Candidates are outline cells and loose (bond ≤ 60) matter inside the field; each is scored `weight·exposure·pull / cost` where cost = `1.5·hardness·(0.25+0.75·holdFraction)·integrity·cohesion / resist` and exposure favours cells whose outline faces the source. They are torn in descending score until the energy
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
| slab area | `fracture.ts slabArea` | `1.5·E_eff` | size of the piece a blow isolates |
| `GRAIN`, seam factor, fault count/weakness | `bodyinit.ts` | 17, 0.52, 2–3 ×0.42 | natural shard size and shear planes |
| `MOMENTUM_K` | `dmg.ts` | 30 | `DamageResult.impulse` scale |
| crater budget split, chunk probability, ejecta speed | `crater.ts`, `kinetic.ts`, `crush.ts` opts | 0.22 lip, 0.72/0.22, 1/0.7 | crater feel |
| tidal cost factor / cadence / per-application cap | `tidal.ts`, `world.ts` | 1.5 / 3 ticks / 260 | how fast fields strip matter |
| infection spread rate, vein noise | `assimilation.ts` | see §3.6 | creep speed |
| `body.cohesionScale`, `body.heatScale` (LIVE, fighter-owned) | `MatterBody` | 1 | scale every bond / thermal threshold at runtime |
| `MAX_DEBRIS_CHUNKS`, `MAX_PARTICLES` | `contracts/constants.ts` | 400 / 6000 | pool caps |

## 6. Dev tooling

`dev/matter/index.html` (port 5202): click/drag to fire any type/shape/flags, overlays (temperature, integrity, bonds, infection, islands, stress, materials), stepper, carve/heal/restore, live ledger and ms/tick.
`tools/matter/gallery.ts` renders contact sheets (`fracture|kinetic|iron|crush|thermal|tidal|assim|star|carve`), `bench.ts` performance, `calibrate.ts` the table above, `tables.ts` the archetype tables.

## 7. Mass ledger

Every path that removes matter routes it: to a **chunk** (`chunkMass`), to **particles** that carry it (`particleMass`; credited on consumption, otherwise it *dissipates* when the particle expires/is recycled), or straight to `dissipated` (shed/evaporate). Sinks credit a body's **pool**
(`massGained`), which counts toward `mass` and is spent by `grow()`. `heal/restore/grow beyond the pool/spawnChunk` are `injected`; `removeBody`/restore trimming are `deleted`. `world.ledger().error` must stay ≈ 0 (tests assert `< 1e-2` after every scenario; the bench reports ~1e-5 after a 60 s fight).
