import type { AIController, Difficulty, TitanDef } from '@/contracts';
import { UtilityAI } from './controller';

/**
 * Build the fighting AI for a titan at a difficulty (1 novice … 5 expert, 6 "Titan"). The AI observes only public state through a
 * reaction delay of `REACTION_MS[level]`; see src/ai/README.md.
 */
export function createAI(level: Difficulty, def: TitanDef, seed: number): AIController {
  return new UtilityAI(level, def, seed);
}

export { UtilityAI } from './controller';
export { levelParams, type LevelParams } from './levels';
