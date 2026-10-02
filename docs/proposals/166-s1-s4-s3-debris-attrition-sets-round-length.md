# 166 — S1 → S4, S3 (Lead to arbitrate): debris attrition, not the fight, sets round length

**Owners of the levers:** S4 (`src/matter/chunks.ts` debris impacts, `src/matter/world.ts` `chunkImpact`), S3
(`src/combat/behaviours/planet.ts` gravity well / Comet Shepherd), S2 + S3 (damage per hit, see proposal 164).
**From:** S1 (AI pacing, SLICE_PHASE2 S1.2).

## Measured (Witness vs Planet, orbit, real matter world, sides alternated, `.scratch/feel/s1pace.ts`)

Rounds today: **22–25 s** at AI levels 2–5 on only **3.5 contacts per round** (≈ 9 contacts per minute, already the §4
target). Where the matter goes (AI L3, 12 fights, 29 rounds, mass in "whole bodies", summed over all rounds):

| Mass lost by a body … | Witness | Planet |
|---|---|---|
| within 2 s of a hit on it (any move) | 7.3 | 4.1 |
| on a tick a drifting chunk struck it, no hit in the 2 s before | 3.8 | **6.6** |
| otherwise (cracks, joints, burning; no hit in the 2 s before) | **6.4** | 5.7 |

Two thirds of all lost matter is not the blow; it is what follows. Per fight log (`.scratch/feel/s1drain.ts --seed=1`):

- **The Planet's own well drags debris into itself.** `stepDraw` keeps a gravity source on the Planet at all times
  (`PHASE_GRAVITY`, growing with the phase) and adds +140 strength / +170 reach while Comet Shepherd charges. Free debris
  falls in faster than 120 px/s and `chunkImpact` wounds the Planet: it lost 24–59 % of a body per fight **while charging
  its own Comet Shepherd**, with no hit on it; most of the rest arrives while it simply moves (`state move`, gap 100–250 px).
- **Every full-speed move through wreckage wounds.** The debris threshold is 120 px/s of *relative* speed; top speeds are
  159 px/s (Planet) and 221 px/s (Witness). An AI that only stalked at 100 px/s while spacing cut the Witness's debris
  loss from 3.8 to 1.1 bodies and its "other" loss from 6.4 to 4.0, and rounds rose from 22 to 36 s — but the Planet
  (whose bleed is its own well, not its speed) then lost 24 rounds to 2. Not shippable as an AI change; it is a matter fix.
- The Witness's "other" loss (detaches with no impact) is a cascade: with debris impacts off it drops from 6.4 to 0.8.

## Projection: the same fights with drifting-debris wounds switched off (thrown chunks still hit)

`s1pace.ts --nodebris=all` replaces `core.chunkImpact` with a no-op inside the tool only.

| | rounds mean / median / p10 / p90 | contacts per round / per min | timeouts | rounds won W–P |
|---|---|---|---|---|
| L3, HEAD AI, real world | 21.8 / 18.1 / 11.1 / 37.7 s | 3.5 / 9.7 | 0 / 29 | 13–16 |
| L3, HEAD AI, no debris wounds | **78.9 / 86.0 / 51.9 / 91.7 s** | 12.0 / 9.2 | 11 / 25 | **1–24** |
| L4, HEAD AI, no debris wounds | 85.3 / 91.2 / 75.2 / 91.9 s | 13.5 / 9.5 | 18 / 25 | 1–24 |
| L3, HEAD AI, only the Planet immune | 47.0 / 41.9 / 27.6 / 77.5 s | 7.5 / 9.5 | 0 / 24 | 0–24 |

So: the AI's present pacing (~9 contacts a minute) already yields 45–90 s rounds once the bleed is gone (slightly long:
timeouts appear), and the 50/50 balance today exists only because the Planet bleeds to its own well. The Witness's blows
take too little matter from the Planet to win on hits (proposal 164 still stands).

## Asks

1. **S4/S3: a gravity owner is not wounded by the debris its own well pulls in.** Smallest version: in `collideBodies`,
   skip `chunkImpact` for a body whose `ownerSlot` has an active gravity source containing the chunk (thrown/launched chunks
   and the foe's well unchanged). Alternative: cap the in-fall speed the well can give a free chunk below 120 px/s.
2. **S4: debris wounds by the chunk's own speed, not the relative speed** (or a threshold above the titans' top speeds,
   ≥ 230 px/s relative), so walking through the arena's wreckage is not a wound; a flung slab still is.
3. **S2/S3 (after 1–2): rebalance damage per hit** for the pair (164). Then S1 re-tunes the AI's engagement gap: with no
   bleed the rounds sit at the top of the 45–90 s band with 40–70 % timeouts at L3/L4, so the gap will need to come down
   (the AI's no-stall rule already shortens it in lulls and in the last 25 s).

Reproduce: `npx tsx .scratch/feel/s1pace.ts --n=12 --la=3 --lb=3 [--ai=head] [--nodebris=all|planet|lastone]`
(~1 min per 12 fights).
