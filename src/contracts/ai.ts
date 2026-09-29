import type { InputFrame } from './input';
import type { ArenaInfo } from './render';
import type { FighterView } from './sim';

/** 1 (novice) … 5 (expert), 6 = "Titan" (max). Reaction time 180–350 ms depending on level. */
export type Difficulty = 1 | 2 | 3 | 4 | 5 | 6;
export const DIFFICULTIES: readonly Difficulty[] = [1, 2, 3, 4, 5, 6];
/** Reaction delay in ms per difficulty (spec: 180–350 ms). */
export const REACTION_MS: Record<Difficulty, number> = { 1: 350, 2: 310, 3: 270, 4: 230, 5: 200, 6: 180 };

/** What an AI may observe each tick: public state only (never the opponent's pending input). */
export interface AIContext {
  tick: number;
  self: FighterView;
  foe: FighterView;
  arena: ArenaInfo;
  roundTicksLeft: number;
  /** Ticks since the round became live. */
  roundTick: number;
}

export interface AIController {
  readonly level: Difficulty;
  reset(seed: number): void;
  /** Produce this tick's input from delayed observation of the public state. */
  decide(ctx: AIContext, out: InputFrame): void;
  /** Behaviour log for docs/AI.md and the review loop (ring buffer of recent decisions). */
  readonly log: readonly string[];
}
