# src/ai — the computer opponent

Pure TypeScript, deterministic (seeded `Rng`, no `Math.random`, no DOM), allocation-free in `decide`. Full write-up: `docs/AI.md`.

```ts
import { createAI } from '@/ai';
const ai = createAI(4, getTitanDef('asteroid'), seed);   // AIController: level, decide(ctx, out), reset(seed), log
match.setSources(humanOrScript, createAiSource(match, 1, ai));
```

| File | Role |
|---|---|
| `index.ts` | `createAI`, re-exports `UtilityAI`, `levelParams`. |
| `levels.ts` | One table: reaction ticks (from `REACTION_MS`), blunder rate, jitter, position noise, think interval, softmax temperature, habits/feints, punish skill, defend chance. |
| `observe.ts` | `Snapshot` (a flat copy of a public `FighterView`) and `ObservationRing`: the foe is read `reactionTicks` old, never fresher. |
| `moves.ts` | `buildMoveInfos(def)`: per move and aim variant, the hit region, frame data, energy, lunge travel and beam axis. `surgeDistance`. |
| `predict.ts` | n-gram model over the foe's coarse actions (approach, retreat, strike, crush, signature, guard, hurt...). |
| `plan.ts` | `Plan`: a short script of (buttons, steering, ticks) executed with jitter; the AI's only output path. |
| `controller.ts` | `UtilityAI`: perceive, score candidates (defend, punish, ultimate, neutral attacks, spacing), sample, execute, log. |
| `ai.test.ts` | Contract, reaction delay, causality, competence, mechanical skill, blunders, determinism, personalities, cost. Slow (about 3.5 minutes): it plays full seeded fights. |

## Rules it keeps

* `decide` reads only `AIContext`. There is no channel to the foe's inputs.
* Foe information is `REACTION_MS[level]` old; its own state is exact.
* Output is one `InputFrame` per tick; edges are derived by the match's `createAiSource`, not by the AI.
* Data-driven: everything titan-specific comes from `TitanDef` (move frame data, shell profile, `ai.weights`), so a new titan needs
  content, not code.

## Tuning knobs

Level feel lives in `levels.ts`; titan style in the JSON `ai.weights`; the scoring formulas are commented in
`controller.ts` (`attackCandidates`, `think`). Use `tools/ai/duel.ts` to look at fights and `ai.log` to see why it chose what it chose.
