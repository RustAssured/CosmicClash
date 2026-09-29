import { REACTION_MS, msToTicks, type Difficulty } from '@/contracts';

/**
 * How human each difficulty is. Level 1 is a slow, sloppy novice; level 6 ("Titan") reacts at the spec's 180 ms floor and
 * executes almost cleanly, but is never omniscient: everything it knows about the foe arrives through the reaction delay.
 */
export interface LevelParams {
  level: Difficulty;
  /** Foe observations are this many ticks old (REACTION_MS[level]). */
  reactionTicks: number;
  /** Probability that a fresh decision is a blunder (a random, usually poor, action). */
  blunder: number;
  /** Buttons are pressed up to this many ticks late (uniform), never early. */
  jitter: number;
  /** Std-dev (px) of the error in judging the foe's position and range. */
  noisePx: number;
  /** Ticks between re-evaluations of the situation while no plan is running. */
  thinkEvery: number;
  /** Softmax temperature over plan scores (lower = more consistently optimal). */
  temperature: number;
  /** Uses the n-gram model of the foe's habits. */
  predicts: boolean;
  /** Baits with feints. */
  feints: boolean;
  /** How reliably it converts a punish window (0..1). */
  punishSkill: number;
  /** Uses Guard / Surge as reactions to telegraphs. */
  defends: number;
}

const TABLE: Record<Difficulty, Omit<LevelParams, 'level' | 'reactionTicks'>> = {
  1: { blunder: 0.32, jitter: 6, noisePx: 24, thinkEvery: 16, temperature: 0.9, predicts: false, feints: false, punishSkill: 0.35, defends: 0.25 },
  2: { blunder: 0.2, jitter: 5, noisePx: 18, thinkEvery: 13, temperature: 0.7, predicts: false, feints: false, punishSkill: 0.55, defends: 0.5 },
  3: { blunder: 0.12, jitter: 4, noisePx: 13, thinkEvery: 10, temperature: 0.5, predicts: true, feints: false, punishSkill: 0.72, defends: 0.7 },
  4: { blunder: 0.07, jitter: 3, noisePx: 9, thinkEvery: 8, temperature: 0.38, predicts: true, feints: true, punishSkill: 0.85, defends: 0.85 },
  5: { blunder: 0.035, jitter: 2, noisePx: 5, thinkEvery: 6, temperature: 0.26, predicts: true, feints: true, punishSkill: 0.94, defends: 0.94 },
  6: { blunder: 0.0, jitter: 1, noisePx: 2, thinkEvery: 5, temperature: 0.18, predicts: true, feints: true, punishSkill: 1, defends: 1 },
};

export function levelParams(level: Difficulty): LevelParams {
  return { level, reactionTicks: Math.max(1, msToTicks(REACTION_MS[level])), ...TABLE[level] };
}
