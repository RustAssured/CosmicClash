# Balance — method, current numbers, and the Phase 3 plan

Owner: Builder 3 (titan data and AI). Target from DESIGN.md: a headless tournament of at least 100 fights per matchup at equal
difficulty, every matchup between 35 % and 65 %. Phase 1 has only one matchup (The Last One vs The Asteroid); this file records how
to measure it, what was measured, and what is known to distort the measurement, so the tournament in Phase 3 is a small step.

## Method

* `tools/ai/duel.ts` plays complete best-of-three matches between two titans at two AI levels on the REAL matter world, headless,
  in about 2 to 5 seconds of wall time per match (a busy machine doubles that). Flags: `--a --b --la --lb --n --seed --swap --dummy --fake --log`.
  `--swap` alternates which titan starts on the left (and swaps the levels with them), tallies are per titan. Seeds are `seed + i`, so
  a run is reproducible: same command, same numbers.
* One fight is high variance (a heavy hit is 10 to 30 % of a body), so read win rates with a standard error of about
  `0.5 / sqrt(n)`: 8 points at n = 40, 4.5 points at n = 120, 2.5 points at n = 400.
* `--fake` uses the test double instead of the matter world: about ten times faster, but its damage model is a different game
  (1 cell per energy, no debris, no cracks). It is used by the unit tests only. Do not balance on it.

## Snapshot at the end of Phase 1 (real world, sides alternated)

The Last One against the Asteroid, equal levels (Last One wins / fights):

| Levels | Last One | Asteroid | Note |
|---|---:|---:|---|
| 2 v 2 | 17 / 40 (42 %) | 23 | after the Kessler retune (below) |
| 4 v 4 | 17 / 40 (42 %) | 23 | |
| 6 v 6 | 14 / 40 (35 %) | 26 | edge of the band |
| all | 48 / 120 (40 %) | 72 | inside 35 to 65 %, at the low end |

Before the Kessler retune the same matchup read 12 / 30, 12 / 30, 13 / 30 at levels 2, 4, 6 (40, 40, 43 %), so the ultimate was not what
decided it. Early in Phase 1 the Asteroid won 4 to 0 at level 3 for a different reason: the Last One's Shatter Blow (1100 energy of
FRACTURE) removed no cells from the iron interior and only cracked it. Crack-driven damage lands later and shows up as chunks leaving
the Asteroid over the next seconds, which is why "cells removed per hit" understates the Last One.

Per-move efficiency, level 4, 8 fights (energy delivered, cells removed immediately per hit):

| Move | Hits | Energy / hit | Cells / hit |
|---|---:|---:|---:|
| asteroid.meteor (ram) | 6 | 1092 | 894 |
| asteroid.shoulder (poke) | 20 | 219 | 150 |
| lastone.gaze (beam, per hit event) | 71 | 54 | 10 |
| lastone.lash | 18 | 76 | 6 |
| lastone.shatter | 7 | 851 | 22 (plus a spreading crack network) |
| lastone.lastlight | 7 | 249 | 18 |

## What was found and changed during the balance pass

1. **The Kessler Cascade did nothing.** Its storm knocked the target about 300 px away before the slam, so an idle Asteroid or Last One lost
   only 2 to 5 % from the whole ultimate (the Last Light removed 26 to 30 %). Fix, in JSON only: the storm now drags the target inward
   (`knockback.x` -35 instead of +160), storm energy 150 to 100 per hit, slam 2600 to 2200. It now removes about 20 to 60 % of an idle
   body depending on debris luck. Re-measure it in Phase 3; the spread is large.
2. **The Meteor Strike is a collision.** Against an idle Asteroid it costs the attacker about as much matter as it costs the victim
   (17 % against 18 % at a 130 px gap). The AI knows this through `extra.recoil` in the move JSON (Meteor 0.9, Shoulder 0.55) and values
   such blows net of it. This is a titan-design decision as much as a tuning one: a ram that hurts the rammer is thematic, but make it
   deliberate.
3. **Tendrils spend a blow.** A hitbox that touches only tendrils (not body cells) connects, severs some tendrils, is absorbed a
   little (5 to 10 %) and is then used up (sweeping hitboxes hit once per move), so an approaching poke or ram that reaches the tendril
   tips first does no damage to the Last One's body. That is the tendrils acting as the eye's shield as the design asks, but it is
   a large defensive effect and one of the first things to look at if the Last One is over-performing at some level.
4. **The attacker of a heavy blow loses matter too.** After a Shoulder that took 2.1 % of the victim's mass the attacker was down 1.3 %
   (isolated test, idle victim); the Meteor case above is the extreme. The cause was not isolated: debris chunks, body contact and
   embedded shrapnel all exist in the matter model (see docs/proposals/300).

## Known confounder: level does not translate into win rate yet

The AI has measurable skill in mechanical tests (a telegraphed Crush lands on level 1 far more often than on level 6; time to KO a dummy;
reaction delay; blunder rate) but win rates barely move with level in AI-versus-AI matches on the real world:

| Matchup (n) | Result |
|---|---|
| Last One mirror, L6 v L1 (20) | 14 to 6 (70 %) |
| Last One mirror, L6 v L3 (20) | 11 to 9 (55 %) |
| Asteroid mirror, L6 v L3 (120) | 57 to 63 |
| Asteroid mirror, L6 v L1 (120) | 58 to 62 |
| Asteroid mirror, L3 v L1 (120) | 55 to 65 |
| Asteroid mirror, L4 v L2 (120) | 61 to 59 |
| Last One L6 v Asteroid L1 (40) | 14 to 26 |
| Last One L1 v Asteroid L6 (40) | 21 to 19 |

The Last One mirror shows a ladder; the Asteroid mirror and the cross-titan matches do not. Two likely reasons, from reading fight logs (not proven): fights are
attritional over the three rounds (a partly healed loser starts the next round low), and a large share of every body's matter loss
is delayed (cracks spreading, connectivity detaching chunks, embedded shrapnel, debris backlash), so what a player does in a
given second matters less than where the first few heavy hits landed. Both are properties of the fight structure and the destruction model rather than of the AI, but that is a hypothesis to test in Phase 3 (for example by measuring how much of each round's matter loss happens in the seconds after a hit).
Do not "fix" it by making the AI cheat; look at how much of a blow's effect is delayed and random.

## Phase 3 plan: `tools/ai/balance.ts`

1. Roster loop over `IMPLEMENTED_TITANS`: every ordered pair (a, b), a <= b, both sides of the screen, levels 2, 4, 6 (and 1 v 6 for
   the ladder), at least 100 fights each, `seed = base + fightIndex` shared across pairs so differences are not seed noise.
2. Parallelism: `worker_threads`, one fight per task, one `createMatterWorld` per fight. `playMatch` is already exported from
   `tools/ai/duel.ts` and returns the winner, rounds, ticks and integrities; the wrapper only needs to fan out and aggregate.
3. Output: a win-rate matrix with standard errors, mean fight length, the share of rounds ended by timeout, mean integrity of the winner,
   and per-move damage/efficiency (the `dbg` tallies above, promoted to a flag). Write the matrix into this file between markers.
4. Levers, in the order to try them: move energies in the titan JSON (`hitboxes[].damage.energy`), knockback (`hitboxes[].knockback`),
   frame data (`frame.*`), `attributes.*` (MASS/COHESION/TEMPO), guard shell absorb table (`extra.shell.absorb`), then material
   `physics` overrides. Change one lever at a time and re-run the same seeds.
5. Acceptance: every pair between 35 and 65 % at equal levels; the ladder check (L6 v L1 above 60 %) as an AI-side gate; no round
   ending in timeout against a passive dummy.
