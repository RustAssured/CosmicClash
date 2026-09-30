# AI — how the computer opponent thinks

Owner: Builder 3. Code: `src/ai/`. Tools: `tools/ai/duel.ts`. Contract: `src/contracts/ai.ts` (`AIController`, `AIContext`, `REACTION_MS`).

`createAI(level, titanDef, seed)` returns a `UtilityAI`. The match wraps it with `createAiSource(match, slot, ai)`, which
calls `decide(ctx, out)` once per tick and **derives the input edges itself** (`pressed`/`released` come from the held mask, so
an AI cannot fabricate an edge).

## What it may know (and what it may not)

* `decide` takes exactly `(AIContext, InputFrame)`. `AIContext` carries the two public `FighterView`s, the arena and the round
  clock. There is no path to the foe's `InputFrame`, its script or its pending buffer; a test pins that signature.
* The foe is seen **only through a ring buffer of snapshots that is `REACTION_MS[level]` old** (180 ms at level 6 up to 350 ms at
  level 1, i.e. 11 to 21 ticks). Position, velocity, state, move phase, telegraphed `threats`, bounds and the 8x8 integrity grid all
  arrive late. Its own body is known exactly (proprioception).
* A causality test replays a fight twice with the foe changing behaviour at tick T and asserts the AI's output is identical until
  T + delay.
* It cannot see cell-level silhouettes, only the bounds and the coarse integrity grid, so it aims at the middle of the body.

## Decision loop

Every `thinkEvery` ticks while no plan is running (5 at level 6, 16 at level 1), and immediately when an urgent threat appears:

1. **Perceive**: push the current foe view into the ring; read the snapshot `delay` ticks old; update habit statistics; roll a
   per-think position error (`noisePx`, Gaussian, stable for the whole think as a human's misjudgement would be).
2. **Candidates** (each carries a score and a one-line reason):
   * *defend* (only if a foe telegraph will land): sidestep with the Surge along the clearest of 8 directions (the Last One follows a
     sidestep with its lunging Strike), Guard (scored by the shell's absorb for that damage type, read from the titan JSON), back
     off, or a fast counter that lands before the threat goes live;
   * *punish* (foe in recovery, hit-stun or guard-break): every aim variant of Strike/Crush/Signature that fits inside the window;
   * *ultimate*, when the meter is full and it can connect (or the foe is stuck);
   * *neutral attacks*: each aim variant scored by expected damage (energy x hit probability x weak-region boost) minus time cost,
     commitment risk and the chance the foe reacts; a **passive foe** (nothing threatening for 2.5 s) is simply attacked for
     maximum damage per second;
   * *spacing*: approach, dash in, retreat, strafe to line up height, wait, pre-emptive guard.
3. **Choose**: softmax over the scores at the level's temperature (0.9 at level 1 down to 0.18 at level 6). With probability
   `blunder` the pick is a random plausible action instead.
4. **Execute** as a short script (`Plan`): steering modes (toward / away / fixed / neutral) with button presses, each press delayed
   by up to `jitter` ticks, never early. Charged beams hold the button only as long as the distance needs.

Feinting out of a move (`considerFeint`) exists but is switched off at every level: measured after B2's heal-stability fix, it made levels 4 to 6 lose to level 3 in the Asteroid and Nexus mirrors (6 v 3: 34 % and 14 % with feints, 52 % and 50 % without).

### Lookahead without cloning the sim

`moves.ts` precomputes, per move and aim variant, the union hit region relative to the anchor (both ends of sweeps), frame data,
nominal energy, lunge travel from its movement keys, and for beams the axis of the line. `evalMove` then asks "if I press this now,
where will the foe be when the hitbox goes live?" using the same glide model as the fighter (`v * tau * (1 - exp(-t/tau))`
applied to the *delayed* observation), and measures coverage: box overlap for blows, samples along the axis inside the body's
central ellipse and live integrity cells for beams. Nothing is simulated; a decision costs a few microseconds.

### Learning from whiffs

Every committed attack is judged a little later from the delayed foe view: did the foe lose mass or stagger? Consecutive whiffs of the
same move variant multiply its hit probability by 0.4 each (forgotten after 10 s, cleared by any success), so an AI whose beam keeps
passing through a notch it cannot see tries a different aim. A blocked or dodged attack is not counted.

From level 3 (the levels that model the foe) the AI also keeps a **long-run record per move variant** for the whole match, in two forms.
*Landing rate*: the observed share of uses that connected, shrunk toward the model's own prediction by three pseudo-samples, scales the
hit probability (0.25x to 1.25x), so a slow blow a mobile foe keeps sidestepping stops being chosen. *Damage worth*: the matter the foe
really lost after each use, relative to what the model promised (against the same ratio over everything tried), scales the expected
damage (0.35x to 3x), so damage the model cannot see (delayed cracks, orbiting swarms) is discovered by trying. Both are
public information only (the delayed view of the foe's mass).

An **assimilation setup/payoff** is understood from the move data, not per titan: a move whose damage plants an infection (`latch`)
is worth more while little of the foe is infected, a move that tears infected matter out (`harvest`) is worth what is already
infected (the foe's public `infectedCells / cells`).

### Habits

`predict.ts` keeps a small n-gram model over the foe's coarse action tokens (approach, retreat, strike, crush, signature, guard,
hurt...). From level 3 it uses the predicted probability that the foe attacks soon to decide between waiting, guarding early and
walking in. It only ever sees actions after the reaction delay.

## Levels

| Level | Reaction | Blunder | Jitter (ticks) | Position error (px) | Think every | Temperature | Habits | Feints | Punish skill | Defends |
|---:|---:|---:|---:|---:|---:|---:|:-:|:-:|---:|---:|
| 1 | 350 ms | 45% | 6 | 24 | 16 | 0.90 | no | no | 0.35 | 0.25 |
| 2 | 310 ms | 28% | 5 | 18 | 13 | 0.70 | no | no | 0.55 | 0.50 |
| 3 | 270 ms | 12% | 4 | 13 | 10 | 0.50 | yes | no | 0.72 | 0.70 |
| 4 | 230 ms | 7% | 3 | 9 | 8 | 0.38 | yes | no | 0.85 | 0.85 |
| 5 | 200 ms | 3.5% | 2 | 5 | 6 | 0.26 | yes | no | 0.94 | 0.94 |
| 6 ("Titan") | 180 ms | 0% | 1 | 2 | 5 | 0.18 | yes | no | 1.00 | 1.00 |

(`levels.ts` is the single source of truth; the reaction times come from `REACTION_MS` in the contract: 350/310/270/230/200/180 ms. "Defends" is the chance
a telegraph is noticed and answered; "punish skill" the chance an opening is taken.) Level 6 is not omniscient: it is
the level with human-limit reaction time, near-clean execution and the best model, and it can still be out-guessed.

## Personalities (from the titan JSON, `ai.weights`)

`aggression, patience, zoning, retreat, trap, punish, gaze` shape the scores above and the preferred range
(`120 + reach*14 + zoning*110 - aggression*50`).

* **The Last One** (aggression 0.35, patience 0.85, zoning 0.45, punish 0.9, gaze 0.6): waits at range, sidesteps a committed blow and
  answers the recovery (its Surge opens a lunging Strike window), fires the Gaze from range and spends its meter on the Last Light
  when it can connect or the foe is stuck.
* **The Asteroid** (aggression 0.7, patience 0.25, retreat 0.65): hit-and-run. Dashes in with the Surge, strikes or rams, and leaves
  before the punish; guards against threats its regolith shell absorbs well (KINETIC) and sidesteps the rest.

New titans need only their JSON weights; the AI is otherwise data-driven from move frame data.

## The decision log

`ai.log` is a ring of the last 80 decisions, oldest first, one string each:

```
t=1291 attack Gaze (forward): hitP 1.00 dmg 759 [score 1.08]
t=1355 attack Gaze (down): hitP 1.00 dmg 639 [score 0.75]
t=2237 retreat: make room [score 0.10]
t=2278 ultimate The Last Light: meter full, hitP 0.87 [score 6.86]
```

`t` is the match tick, then the plan name, the reason (with hit probability and expected damage for attacks, remaining window for
punishes, threat type and countdown for defences) and the winning score. Blunders are marked. The training overlay and the review
loop read this ring.

## Running it

```
npx tsx tools/ai/duel.ts --a=lastone --b=asteroid --la=4 --lb=4 --n=10 --seed=1      # real matter world
npx tsx tools/ai/duel.ts --la=6 --dummy=b --n=4 --log                                   # vs a do-nothing dummy, with decision logs
npx tsx tools/ai/duel.ts --fake --n=40                                                  # test double world: ~10x faster, different balance
npx vitest run src/ai                                                                    # ~3.5 minutes (long, seeded fights)
```

`duel.ts` prints each fight's winner, why the last round ended, rounds and integrities, then a tally. It exports `playMatch`
so the Phase 3 tournament (`tools/ai/balance.ts`, `worker_threads`) is a small wrapper: see `docs/BALANCE.md`.

## What the tests pin

* the public-only input channel, the reaction delay per level (measured), causality;
* competence: levels 2 to 6 beat a do-nothing dummy with both titans; time-to-KO does not get worse with level and no round stalls out;
* skill shows in mechanics: an isolated telegraphed Crush lands on level 1 far more often than on level 3, and on level 3 more than on
  level 5 (which dodges most of it);
* blunder rate falls with level and is zero at level 6; determinism per seed; personalities visible in the log;
* cost per decision (microseconds).

## Known limits

* **Level does not translate into win rate (round 2 measurement).** Level 6 against level 1 in mirrors, real world, n = 40 to 50: Last One
  18 to 22, Asteroid 13 to 27, Nexus 5 to 35 (before a Nexus retune: 11 to 29). The mechanical tests show the skill (dodging a telegraphed
  Crush: level 1 lands it half the time, level 6 never; punishing; no stalling) but in fights mass dealt is about equal between
  levels while level 6 acts almost twice as often and lands a smaller share of what it throws. Two structural confounders, both outside
  the AI: (1) the healed loser of a round starts the next one with spreading cracks and can lose most of its mass with no hit landed
  (measured against a do-nothing dummy), so rounds 2 and 3 are a lottery; (2) a large share of matter loss is delayed and chaotic.
  Tried and kept: a long-run per-move landing and damage memory (levels 3+), an infection setup/payoff rule, higher blunder rates at
  levels 1 and 2. Tried and dropped: raising position noise, jitter and think interval at low levels (it made level 6 beat level 1
  in the Last One mirror 34 to 16 but broke the dodge test's ordering of levels 1 and 3). Re-measure after B2's delayed-damage rebalance.
* A titan's `ai.weights` swing results far more than a level does (the Black Hole went from 20 to 0 to 1 to 9 against the same opponents by
  moving three weights); balance passes must treat them as balance levers.
* The AI cannot read silhouettes, so a beam aimed at a carved notch is only corrected after it whiffs (whiff memory, above).
* It does not model the tendril shield: it counts a blow that only touches the Last One's tendrils as a hit on the body until the
  foe's mass fails to drop and the whiff memory notices.
* It never adapts its spacing to a human's spacing habits beyond the n-gram action model, and it has no long-term memory across rounds.
* Passive-foe detection (six seconds of no move, guard or surge) fades the AI toward pure damage-per-second; a human who stands still
  for that long will be treated the same way.
