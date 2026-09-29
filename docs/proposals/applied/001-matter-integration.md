# 001 — Matter: small contract additions and integration notes (B2)

Nothing here blocks integration: `createMatterWorld` returns a `MatterWorldEx` (a `MatterWorld` plus optional extras) and everything works without any of these. Applying the proposals just
promotes the extras to the contract so B3/Lead can rely on them.

## 1. Promote three helpers to `MatterWorld` (contracts/matter.ts)
```diff
 export interface MatterWorld {
   ...
   /* ---- rendering ---- */
   setLighting(l: StageLighting): void;
+  /** Arena used for the soft walls that keep debris in the play area (default DEFAULT_ARENA). Call with the stage arena at match start. */
+  setArena(a: ArenaInfo): void;
   ...
   /* ---- queries ---- */
   stats(bodyId: number): BodyStats;
+  /** World AABB of a body's live cells (FighterView.bounds*). false if the body is gone or empty. */
+  liveBounds(bodyId: number, out: { x0: number; y0: number; x1: number; y1: number }): boolean;
+  /** Mass-conservation report (tests/debug): `error` must be ≈ 0. */
+  ledger(): { created: number; injected: number; deleted: number; dissipated: number; cellMass: number; poolMass: number; chunkMass: number; particleMass: number; error: number };
```
Until then the Lead can call `(world as MatterWorldEx).setArena(stage.arena)` after `setLighting`.

## 2. Doc-comment clarifications (no code change)
- `DamageParams.heat`: *temperature units added per cell at full shape weight* (before the material's `resist`, `heatAbsorb` and heat tolerance). 1900 units vaporise a baseline rock cell; ignition of the lattice is 320. If absent, heat comes from `energy` (1 energy ≈ 1900 units on a heatCapacity-1 cell).
- `DamageParams.pull`: 1 = the reference field strength (multiplies tear scores and stream homing acceleration).
- `MatterWorld.stats()` returns the body's own live `BodyStats` object, updated in place (cheap to call every tick; copy what you keep). `BodyStats.mass` includes the *pool* (mass received from sinks but not yet built into cells), so accretors exceed `massFrac = 1`; `grow()` converts pool → cells.
- `ParticleSpawn.life` is in ticks, `drag` defaults per kind, `size` 1..3.
- `DamageResult.impulse` = `30·sqrt(energy·sourceMass)·sqrt(coverage)` along the blow (mass·px/s): divide by the target's effective mass for knockback.

## 3. Notes for B3 (titans/combat)
- Call `world.heal(bodyId, fraction, seed)` between rounds: it cancels pending multi-tick damage jobs and shock rings aimed at the body and regrows missing matter as scars from the surviving edge.
- Set `body.cohesionScale` / `body.heatScale` each tick if the titan's stats should modulate bonds / thermal thresholds (e.g. Asteroid rubble pile: lower cohesionScale as mass falls).
- Gravity sources: `creditBodyId` = the accretor's body id; a chunk or stream entering `consumeRadius` is consumed and its mass credited (`massGained`); TIDAL streams also home on the source of the event's `sourceBodyId` (its slot's active gravity source, else `originX/Y`).
- `carve()` is a harness tool (100–500 ms for a 22k-cell body): call it at match construction, not per frame.
- Hit detection: `overlap()` is the pixel-accurate probe (mirror + lean aware, verified against brute force); it allocates nothing when you pass `out`.
- Call `warmUp()` (exported from `@/matter`, ~0.4 s, private scene, no effect on real worlds' hashes) once while loading: the first ~20 fight ticks on a cold JIT cost 13–26 ms, after warm-up 3–9 ms.
