# 134 — Lead (+ S5): arena comets for Comet Shepherd, and the Planet's new cue ids

From S3 (Planet), slice Phase 2.

## 1. Arena comets → Comet Shepherd

**Today (S3, shipped):** holding Signature *calls* a comet. The behaviour creates the nucleus as a matter body (`kind: 'part'`,
painted by `src/titans/art/comet.ts`):
- It spawns it at the arena edge on the side away from the foe and bends its path with an inverse-square pull while the button
  is held.
- It captures the comet into a flattened orbit (150 px) and spins it up from 1.4 to 5.2 rad/s.
- On release it lets go where the orbit points at the foe, at the speed the orbit gave it (≈ 600–790 px/s); energy is
  720 × (v / 620)².
- On impact the nucleus becomes a debris chunk. A comet never captured sails on and leaves the arena (its body is removed).

**When your arena module spawns comets** (big chunks on a readable cadence), the Shepherd should prefer one already in the
arena.
- **Needs:** a deterministic read of the live arena comets for the fighters (`FighterTickCtx.arena.comets` or `MatchApi`),
  each with id, position, velocity and mass; plus S4's `captureChunk` / `launchChunk` (proposal 132).
- **S3 side:**
  - if an arena comet is within ~400 px when Signature is pressed, shepherd that chunk through the capture API with the same
    bend → capture → spin-up → slingshot;
  - otherwise call one in as today.
- Either way, S5's Shearfield renders the sim comets, and the Planet draws its shepherded comet's tails itself.

## 2. New cue ids (for S5's Planet voice: tectonic crack, sub pressure, atmospheric tear, magma vent, moon impact)

All are `SimEvent { t: 'cue', titan: 'planet' }`:

| id | when | amount |
|---|---|---|
| `world-phase-2` … `world-phase-4` | the world enters damage phase 2 / 3 / 4 | phase / 4 |
| `moon-shatter` | a broken moon breaks on its target into fragments | 1 |
| `comet-call`, `comet-capture`, `comet-sling`, `comet-impact` | Comet Shepherd stages | 1 (sling: speed / 620) |
| `crust-armor` | Tidal Draw regrew crust | cells grown |
| `core-pulse` | Core Pulse fires | 1 |
| `atmo-vent`, `moons-drift`, `crust-slab`, `core-out` | the failure process after KO, in this order over ~3.3 s | 1 |

These are kept from before: `moon-lost`, `atmo-strip`, `ocean-boil`, `crust-crack`.
