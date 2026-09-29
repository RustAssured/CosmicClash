# `src/matter` — the destruction simulation (Builder 2)

Pure TypeScript (no DOM / `three` / `Math.random` / wall clock) — runs identically in the browser and Node. Deterministic. Reference for the algorithms and every tuning
number: `docs/DESTRUCTION.md`. Performance numbers: `docs/PERF.md` → `## Matter (B2)`.

## Public API

```ts
import { createMatterWorld, buildMaterialTable, MATERIAL_ARCHETYPES, warmUp } from '@/matter';

const world: MatterWorldEx = createMatterWorld(seed);           // implements contracts MatterWorld (+ optional extras below)
const table: MaterialDef[] = buildMaterialTable(titan.materials); // index 0 = EMPTY, specs[i] -> id i+1, ash/char appended after authored ones
const body = world.createBody({ kind: 'titan', ownerSlot: 0, map, materials: table, attributes, seed, transform });
```

`MatterWorld` (see `src/contracts/matter.ts` for the semantics — the doc comments are law):
`createBody / removeBody / getBody · applyDamage(bodyId, ev): DamageResult · overlap(bodyId, shape, out?) · solidAt · tick() · drainEvents(into) · stats(bodyId) ·
grow / shed / heal / restore / carve · setGravitySource(slot, src|null) · spawnParticles / spawnChunk · setLighting · renderLayers(view, alpha) · debugOverlay(bodyId, mode) · hash()`.

`MatterWorldEx` adds (all optional for integrators):

| method | purpose |
|---|---|
| `setArena(arena)` | soft walls that keep debris in the play area (default `DEFAULT_ARENA`); call after `setLighting` when a stage is chosen |
| `liveBounds(bodyId, out)` | world AABB of a body's live cells (for `FighterView.bounds*`) |
| `refresh(bodyId?)` | force visual/stat refresh without ticking |
| `ledger()` | mass ledger report (`error` must be ≈ 0) |
| `diagnostics()` | live chunk/particle counts and masses |
| `settleBody(id)` | run the connectivity pass now (tests, carve) |
| `core` | internal state (tests/bench only; `core.clock` + `core.prof` enable the section profiler) |

`warmUp(ticks = 100)` runs a small private scene through every damage type once (~0.4 s, no shared state, hashes of real worlds unaffected — tested) so V8 has optimised code before the first real fight. Call it once while loading / on the title screen; without it the first ~20 ticks of a fight cost 13–26 ms instead of 3–9 ms.

### Call protocol (DESIGN §1.2)
1. Owner sets `body.transform` (+ `world.setGravitySource`) **before** `world.tick()`; it may call `applyDamage`/`overlap`/`solidAt` any time.
2. `world.tick()` advances: multi-tick damage jobs → crack fronts + shrapnel fuses → thermal → infection → connectivity/detachment → shock rings → chunks → particles → visual refresh → stats → events.
3. `map.pixels` / `map.emissive` are refreshed inside `tick()` (dirty 16×16 tiles only; `map.dirty` and `map.version` are updated). `renderLayers(view, alpha)` returns two pooled screen layers: `debris-back` (z −20) and `fx-front` (z +10, with emissive).
4. `drainEvents` yields `{t:'matter', kind: detach|ignite|crack|consume|harvest|impact|evaporate|boil, x, y, mass, slot}`; noisy kinds are aggregated over a time window.

### Semantics worth knowing
- **All geometry is WORLD space.** Cell `(i,j)` centre: `t.x + (i+.5−anchorX)·facing + leanShift(lean, j)`, `t.y + (j+.5−anchorY)` (integer row shear, exactly `space.ts`).
- **Energy:** 1 ≈ destroys one baseline cell. `duration > 1` delivers `energy/duration` per tick (or `energy` per tick with CONTINUOUS) through a job queue; calling every tick with `duration: 1` works equally.
- `stats(id)` returns the body's own live `BodyStats` object, updated in place (copy what you keep). `mass` includes the *pool* (mass received from sinks not yet built into cells), so accretors exceed `massFrac` 1; `grow()` builds cells from the pool first.
- `body.cohesionScale` / `body.heatScale` are read live by every model (the Asteroid's rubble-pile drops cohesionScale as mass falls).
- `takesDebrisImpacts` defaults to true for `kind: 'titan'`.
- `carve()` is a harness tool (100–500 ms for a 22k-cell body); `heal`/`restore` cancel pending damage jobs and shock rings aimed at the body.

## Layout

| file | role |
|---|---|
| `world.ts` | `createMatterWorld`, tick order, damage jobs, extras |
| `warmup.ts` | `warmUp()` JIT pre-warm on a private scene |
| `body.ts` | `Body` (internal `MatterBody`): coordinates, tiles, region stats, fronts/fuses storage |
| `bodyinit.ts` | bonds (grain seams, faults, layers), surface flags, snapshot |
| `cells.ts` | the only cell-removal / bond-break primitives (`killCell`, `breakBond*`) |
| `connectivity.ts`, `debris.ts`, `chunks.ts`, `particles.ts`, `stream.ts`, `render.ts` | detachment, chunk extraction/physics/raster, particles, homing streams, screen layers |
| `fracture.ts`, `cuts.ts`, `cracks.ts` | FRACTURE: dual-lattice Dijkstra cuts, crack fronts |
| `kinetic.ts`, `crater.ts`, `impact.ts` | KINETIC and the shared bowl-crater engine; first-contact geometry |
| `crush.ts` | CRUSH: compaction, shock rings, tectonic faults |
| `thermal.ts`, `blast.ts` | THERMAL: diffusion/burning/ablation/vaporise, blast rings |
| `tidal.ts` | TIDAL peeling into spiralling streams |
| `assimilation.ts` | ASSIMILATION: latch, spreading infection, harvest |
| `visual.ts` | `map.pixels`/`emissive` refresh (lighting, heat glow, crack lines, lattice…) |
| `lifecycle.ts` | restore / heal / grow / shed / carve |
| `materials.ts`, `archetypes.ts` | `buildMaterialTable`, `MATERIAL_ARCHETYPES` |
| `debug.ts`, `hash.ts`, `shape.ts`, `dmg.ts`, `core.ts`, `util.ts` | overlays, state hash, shape queries, damage context/result, shared world state, helpers |
| `testing/bodies.ts` | synthetic test bodies (layered disc, ribbed slab, lattices, planets, star, black hole, bridge, uniform disc) |

## Invariants (all enforced by tests)
1. **Determinism:** same seed + same call sequence ⇒ identical `world.hash()` (incl. carve, every damage type and 600 ticks of aftermath).
2. **Mass conservation:** `world.ledger().error ≈ 0` after every scenario (see DESTRUCTION §7).
3. **Bond graph consistency:** a bond byte is non-zero only between two live cells; void cells have zero integrity/bonds; SURFACE flags equal "has a void 4-neighbour".
4. **No allocation in the tick** after warm-up (bench: ~4 KB heap growth over 1000 ticks with GC forced); chunk/ramp creation allocate at *event* rate only.
5. `restore()` returns every per-cell array to its pristine values exactly.
6. Hit detection (`overlap`, `solidAt`) equals brute force over the live cells for mirrored and leaning bodies.

## Testing & tooling
```
npx vitest run src/matter                          # 60 tests: contract behaviour, determinism, ledger, per-model behaviour, lifecycle, render
npx tsx tools/matter/bench.ts                      # per-tick ms (avg/p50/p95/p99/max), section breakdown, worst-case pools, idle allocation
node --expose-gc --import tsx tools/matter/bench.ts   # forces GC around the allocation check
npx tsx tools/matter/calibrate.ts                  # mass removed per energy, per archetype x damage type
npx tsx tools/matter/gallery.ts all                # contact sheets into .scratch/
npx vite --port 5202 --strictPort  ->  http://localhost:5202/dev/matter/   # interactive sandbox
```
