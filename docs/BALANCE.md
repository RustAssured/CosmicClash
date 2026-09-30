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

## Round 2 snapshot: the roster grows to four (Nexus, Black Hole)

Tools: `tools/ai/moves.ts` (a per-move table: mass removed, as a percentage of the defender's initial mass, over 300 ticks after one press at gaps
70 to 295 px against an idle and a guarding dummy on the real world) and `tools/ai/duel.ts` (now also prints round-length statistics).
Everything below was measured after the P0 fix (a blow that touches only a foe's parts no longer uses itself up; a lunging once-per-move
hitbox is applied at its deepest overlap) and with `ROUND_HEAL_FRACTION = 0.6`. B2's delayed-damage rebalance had not landed, so **re-run
both tools when it does**; the numbers move.

Pacing target: Strike about 2 to 5 %, Crush 6 to 15 %, Ultimate 25 to 45 % of an opposing body (idle dummy, mean over the gaps that connect).

| Move | vs Asteroid | vs Last One | Note |
|---|---:|---:|---|
| nexus.constrict (crush) | 5 to 8 % | 4 to 11 % | roots the foe (0.5x speed for 90 ticks, breaks at 450 energy); 850 energy |
| nexus.harvest (signature) | 8 % | 12 % | tears out infected lattice; what the foe loses while it runs is banked and built into new lattice |
| nexus.latch (strike) | 0 % now | 0 % now | plants an infection; the payoff is Harvest, so read it as a setup (about 400 infected cells) |
| nexus.oog (ultimate) | 17 % | 19 % | under target: the cage crush is capped by what CRUSH can bore, raising energy did nothing (see below) |
| blackhole.shear (strike) | 2.4 % | 4.2 % | tidal field plus a kinetic rake |
| blackhole.maw (crush) | 6 % | 7 % | tidal field plus a jaws-closing crush point |
| blackhole.well (signature) | 6 % | 5 % | 9 field ticks; costs 30 of the Accreted bar |
| blackhole.spaghetti (ultimate) | 25 % | 19 % | the Asteroid is at the bottom of the band, the Last One below it |

The Nexus ultimate stays under the band because the cage's closing blow is a CRUSH at a point: the world bores only so deep whatever the
energy (2800, 5200 and 9000 all read 16 to 19 %). Making it larger would need more compress/crater, or a follow-up the cage shape owns; that
is a design call for Phase 3.

### Duels at level 3, n = 20 (real world, sides alternated, seed 200), final settings of this round

| Matchup | Result | Mean round | Round 1 |
|---|---|---:|---:|
| Nexus v Asteroid | 19 to 1 | 12 s | 17 s |
| Nexus v Last One | 20 to 0 | 14 s | 23 s |
| Black Hole v Asteroid | 17 to 3 | 18 s | 25 s |
| Black Hole v Last One | 5 to 15 | 24 s | 35 s |
| Black Hole v Nexus | 6 to 14 | 18 s | 23 s |

**The Nexus is not balanced: it wins 95 to 100 % against the two Phase 1 titans.** Idle it dies in about 13 s (as fast as an idle Asteroid),
so it is not durable; the asymmetry is that a moving Nexus keeps the fight at a range where its Harvest field and Constrict connect and the
foe's blows mostly find the gaps between its nodes (in one traced round the Nexus lost 3 % of its mass while the Asteroid lost 82 %).
Levers tried without effect: Constrict energy 1300 to 650, root 150 to 30 ticks, latch amounts, node resist, harvest strength, AI personality.
The one that mattered was crediting: harvested matter used to be credited to the Nexus's pool (mass above 1.0), which made it unkillable;
the harvest now carries `extra.noCredit` and building is paid from what the foe loses. Remaining candidates: bulk up the nodes so blows land,
shorten the Harvest reach, or give the Constrict a real whiff cost. A Phase 3 balance pass should start here.

The Black Hole is a rock-paper-scissors: strong against the Asteroid, behind against the Last One and the Nexus. Its story, because it
cost most of the round:

* Its AI personality is the largest lever measured anywhere: with `aggression 0.3, patience 0.85, zoning 0.9` it won 20 to 0 against everyone, even
  at a quarter of its damage; with `0.65, 0.4, 0.5` it lost 1 to 9. The shipped `0.36 / 0.72 / 0.8` is where the sweep landed (it keeps
  its distance, which is thematic, but no longer outwaits the foe AIs).
* Its horizon is immune, so mass floors: at density 3 the horizon alone was 48 % of the hole's mass and `KO_MASS_FRAC = 0.22` could never be
  reached. The horizon is now 0.15 density (about 5 % of the hole).
* `massGained` is credited to a body's pool and counts toward `massFrac`, so an accretor that eats the foe's debris climbs past 1.0 without
  bound (4.7x in one match) and can never be KO'd. The Black Hole's tidal moves therefore carry `extra.noCredit` (the fighter then sets
  `sourceBodyId = -1`) and the gravity well credits nobody; the Accreted bar is fed from the foe's mass loss instead and pays for disk regrowth.
* `world.shed` removes cells (not pool mass), so it cannot be used to bleed accretion: 22 % of the body per call in an early build.
* `resist` reads opposite ways in different damage modules (KINETIC and FRACTURE divide by it, TIDAL multiplies), so a per-titan override needs
  measuring, not reasoning.

### The AI ladder (level 6 against level 1, mirrors, real world)

The Last One mirror is a ladder only weakly (18 to 22 at n = 40 with the final settings; 34 to 16 at n = 50 with a noisier level table that failed the
dodge test); the Asteroid mirror reads 13 to 27 and the Nexus mirror 11 to 29. Measured with `.scratch` scripts on this build, mass dealt is about
equal between levels while level 6 acts almost twice as often and lands a smaller share of what it throws (a slow Crush thrown at a foe that
keeps moving). Changes made: the blunder rate of levels 1 and 2 (45 % and 28 %), a long-run per-move landing-rate and damage-worth memory from
level 3 up (`docs/AI.md`), an assimilation setup/payoff rule, and the foe's infected share in the snapshot. None of them yields the 70 % target in
the Asteroid and Nexus mirrors. Delayed damage is the main confounder: a healed loser starts the next round with spreading cracks and can
lose 60 % of its mass with no hit landed on it (measured against a do-nothing dummy), which turns rounds 2 and 3 into a lottery.
Re-measure after B2's rebalance before changing the AI further.

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

<!-- balance-ladder:begin (generated by tools/ai/balance.ts --ladder; do not edit by hand) -->

## AI ladder (generated)

Mirror matches, real matter world, seed base 6000, target 50 fights per cell, sides alternated. Cells are the win rate of the HIGHER level (a draw counts half) with one standard error. Targets: 6v1 at least 70 %, and every adjacent-level cell above 50 %. * marks a cell at or below 50 %.

| titan | 6 v 1 | 6 v 3 | 3 v 1 | 5 v 3 | monotone |
|---|---:|---:|---:|---:|---|
| lastone | 64% ±7% (50) | 54% ±7% (50) | 74% ±6% (50) | 66% ±7% (50) | NO |
| asteroid | 50%* ±7% (50) | 52% ±7% (50) | 68% ±7% (50) | 48%* ±7% (50) | NO |
| nexus | 54% ±7% (50) | 60% ±7% (50) | 68% ±7% (50) | 50%* ±7% (50) | NO |
| blackhole | 72% ±6% (50) | 68% ±7% (50) | 56% ±7% (50) | 68% ±7% (50) | yes |
| supernova | 48%* ±7% (50) | 60% ±7% (50) | 50%* ±7% (50) | 60% ±7% (50) | NO |
| planet | 60% ±7% (50) | 50%* ±7% (50) | 66% ±7% (50) | 58% ±7% (50) | NO |

<!-- balance-ladder:end -->
