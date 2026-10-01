# 140 — S4 → Lead (contracts), S5, S1/S2: rotated region bodies — `BodyTransform.rot`, `bodyToChunk`, `jointHealth`

**Owners of the change:** Lead (`src/contracts`), S4 (`src/matter`), S5 (`src/render`, already proposed in 151), S2 (`src/combat/rig`).
**From:** S4, after the Phase 1 rotation spike (SLICE_PLAN §4.1, D27: one MatterBody per rig region, quantised rotation, hit
truth = what the renderer samples, ≤ 1 px silhouette disagreement).

## What the spike proved (measured)

`src/matter/rotation.ts` + `rotation.test.ts` + `tools/matter/rotbench.ts`:

| Check | Result |
|---|---|
| Matter's rotated hit-test vs **S5's own sampler** (`rotSample` from `src/render/rotsprite.ts`, the bit-exact CPU twin of the GPU clean-edge shader), every destination pixel of all 256 angles, both facings, two bodies (celadon r = 30, ribbed slab), fractional body position | **0 mismatches** in > 500 000 pixels per body/facing (colour drawn ⇔ cell matter hits, transparent ⇔ nothing); sub-pixel points of the pixel hit the same cell |
| Angle 0 vs today's `Body.cellAtWorld` (dense 0.4 px grid, both facings) | identical |
| `rotCollect` (the input of every damage model: same contract as `Body.collect`) vs the drawn pixels the shape covers | identical sets, each cell once |
| Silhouette | drawn area within the outline band of the live cell count at every angle; worst-angle share of cells not drawn (hence not hittable at that angle): 17–24 % |
| Cost (`rotbench`, this laptop) | mask build 0.7 ms (84×40 / 76×76 region) … 5.9 ms (212×212 map) per (body, angle), built once; 40–445 KB per mask (5 B per destination pixel); `cellAt` ≈ 0.21 µs (plain 0.02 µs); `collect` of a r = 20 point ≈ 0.29 ms (plain 0.03 ms) |

The mask stores, per destination pixel, the texel its centre sub-sample reads and whether all nine sub-samples read that texel;
it is pure geometry, so it never goes stale under destruction (liveness and colour are read at query time; only edge pixels run
the 9-sample vote).

## Proposed contract

1. **One sampler, in contracts.** Accept 151's move of `src/render/rotsprite.ts` (minus the GLSL) to `src/contracts/rotation.ts`.
   Matter then imports it instead of carrying its bit-exact copy (`rotation.ts` `subCell`/`drawnCell`), and the parity test
   keeps both honest. Two additions to the shared module:
   - **Mirroring**: `facing = -1` mirrors the source about the pivot corner before rotating — texel `x' = 2·px − 1 − x`
     (matter's `subCell` already does this; the renderer must do the same for mirrored parts).
   - **Pivot placement**: the source pivot is the map anchor (an integer corner); it is drawn at world pixel
     `(round(t.x), round(t.y))`.
2. **`BodyTransform.rot?: number`** — the quantised step `0..ANGLE_STEPS-1` (absent = 0). Rotated bodies keep `lean = 0` (the
   amended D4). Matter routes, when `rot !== 0`: `cellAtWorld`/`solidAt` → `rotCellAt`; `collect` (overlap and every damage
   model) → `rotCollect`; `cellWorld`/`localToWorldF` → `rotCellWorld`; `worldToLocalF` → inverse LUT; the world AABB → the
   mask bounds; `extractChunk` → copy the LOCAL sprite and give the chunk `angle = rot·2π/ANGLE_STEPS` (chunks already rotate);
   local blow directions (`ldx/ldy`) → inverse rotation. All are per-body branches; bodies with `rot = 0` keep today's fast paths.
   One mask cache per body (`RotMaskCache`, LRU of 12 angles).
3. **`MatterWorld.bodyToChunk(bodyId, vx, vy, spin): number`** — a severed region leaves as ONE rigid chunk: every live cell is
   extracted (exact ledger transfer: cells → `chunkMass`, no `injected`/`deleted`, unlike today's `spawnChunk` + `removeBody`
   used by Planet moons), the body is removed, the chunk id is returned. Wound sequencing applies (it is held for its shear beat
   like any other piece when the sever comes from a blow).
4. **`MatterWorld.jointHealth(bodyId, cells: Int32Array | readonly number[]): number`** — 0..1 = Σ integrity of the live,
   still-bonded cells of a joint patch (the cells around a constraint anchor, chosen by S2's rig) / their pristine Σ. A held
   (shearing) cell counts as lost. Cheap (patch-sized), allocation-free, read by the XPBD graph to weaken or break a constraint.
   Matter also needs the region's anchor: **`BodySpec.anchorCells?: Int32Array`** — the connectivity seeds of a region body (its
   joint patch) instead of the core disc, so a region does not shed matter merely because it has no "core".

## Asks to the other owners

- **S5:** consider voting on **alpha first** (opaque majority of the nine sub-samples decides coverage), then colour among the
  opaque samples. Today coverage depends on colour: a darkening crack can flip an edge pixel between drawn and empty, and a hit
  follows it (matter reproduces it exactly, so it is consistent — just less stable for gameplay).
- **S2:** pick joint patches from the painted regions (a few cells either side of each joint) and pass them in `BodySpec`.
- **Lead:** `rot` and the new world methods are additive; nothing changes for bodies without `rot`.

## Not done in Phase 1

Nothing is wired into `Body`/`world`: the module and its tests stand alone so Phase 2 starts on proven arithmetic. Known cost:
`collect` on a rotated body is ~10× the plain path (the vote at edge pixels); acceptable for region-sized bodies and the hit rate
of a fight, and cacheable per tile if it ever shows in a profile.
