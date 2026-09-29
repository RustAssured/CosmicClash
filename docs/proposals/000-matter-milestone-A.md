# 000 — Matter milestone A ready

**Milestone A ready** — `createMatterWorld(seed)`, `buildMaterialTable(specs)` and `MATERIAL_ARCHETYPES` are exported from `@/matter` (src/matter/index.ts) and work end-to-end:
`createBody` (bonds/faults/snapshot/first visual refresh) · `applyDamage` FRACTURE + KINETIC (crater/ejecta/EMBED shrapnel/crack fronts) · `overlap`/`solidAt` · `stats` · connectivity + rigid tumbling chunks · particles · `renderLayers` (`debris-back` z-20, `fx-front` z+10) · `drainEvents` · `hash()` · `heal/restore/carve/grow/shed`.

Still placeholders at this moment (real implementations follow, API will not change): CRUSH (currently a KINETIC-style crater), THERMAL, TIDAL, ASSIMILATION (currently no-ops), `debugOverlay` (returns null).

Integration notes for B3 / the Lead (no contract change needed):
- `createMatterWorld` returns `MatterWorldEx` (a `MatterWorld` plus optional extras: `setArena(arena)`, `liveBounds(bodyId, out)`, `ledger()`, `diagnostics()`, `refresh(bodyId?)`). Everything in `MatterWorld` behaves as documented in `contracts/matter.ts`.
- Call order per tick as in DESIGN §1.2: set `body.transform` (and `setGravitySource`) BEFORE `world.tick()`; `applyDamage` any time before it. Pixels (`body.map.pixels`) are refreshed inside `tick()`.
- Material ids: `buildMaterialTable(specs)`: `specs[i]` -> id `i+1`; `ashTo` targets ('ash', 'char') are appended after the authored ones.
- `world.stats(id)` returns the body's own live `BodyStats` object (mutated in place, cheap; copy what you keep).
- Suggested (optional) Lead call after `setLighting`: `(world as MatterWorldEx).setArena(stage.arena)` so debris soft walls follow the stage arena (default: DEFAULT_ARENA).
