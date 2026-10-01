# 141 — S4 → Lead (`src/telemetry`, `src/matter` render layers): count FX, not the wound's own slabs, as wound occluders

**Owners of the change:** Lead (`src/telemetry/telemetry.ts` `coverage`), optionally S4 (`src/matter/render.ts`).

## Problem

Telemetry's per-heavy-hit "FX occlusion" (`coverage()`, box r = 26 around the contact) counts every opaque pixel of the screen
layers with z in [10, 100). Matter draws the fight-plane debris chunks and all particles into the same layer (`fx-front`, z 10).
Since D1 the wound sheds its matter as rigid slabs one piece per tick, starting at the contact (they appear exactly where their
cells were, then fly off at the wound's speed). Those slabs ARE the wound reading — not an effect hiding it — but telemetry counts
them as occluders, so its "FX clear" lands after the last slab has left the box.

Measured headless (`npx tsx tools/matter/wounds.ts`, authored hit-stop, same box and 10 % / 3-frame rule as telemetry):

| blow | matter FX only (flash, sparks, dust, plumes) | + slabs (what telemetry counts) |
|---|---:|---:|
| planet.impact → planet | 333 ms | 333 ms |
| lastone.shatter → planet | 317 ms | 617 ms |
| lastone.lastlight shear → planet | 0 ms | 517 ms |
| planet.impact → lastone | 333 ms | 483 ms |
| planet.cataclysm quake → lastone | 333 ms | 517 ms |
| lastone.shatter → lastone | 317 ms | 483 ms |

## Proposal (pick one)

1. **Matter splits its output (S4, no contract change):** fight-plane chunks move from `fx-front` (z 10) into a new screen layer
   `debris-mid` at z 9 (still over the titans at z 0, under the particles). Telemetry's z ≥ 10 rule then excludes them with no
   change on its side. Cost: one more 640×360 screen layer upload per frame (the near/back ones exist already). Visual change:
   particles always draw over fight-plane debris (arguably better: sparks over rubble).
2. **Telemetry asks matter (Lead):** `MatterWorldEx.debrisMask(view)` returns the chunk pixels; `coverage()` subtracts them.
   No render change, a little more telemetry work per frame (telemetry already runs only with `tele=1`).

S4 recommends 1 (it keeps telemetry generic and the cost is one small upload); say which and S4 does its half in Phase 1.
