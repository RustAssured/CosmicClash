import type { AIController, Difficulty, TitanDef } from '@/contracts';
import { UtilityAI } from './controller';
import { MouthAI } from './mouth';
import { isMouthDef } from '@/titans/mouth/def';

/**
 * Build the fighting AI for a titan at a difficulty (1 novice … 5 expert, 6 "Titan"). The AI observes only public state through a
 * reaction delay of `REACTION_MS[level]`; see src/ai/README.md.
 */
export function createAI(
  level: Difficulty,
  def: TitanDef,
  seed: number,
  opts: { footwork?: 'classic' | 'orbit' } = {},
): AIController {
  // the Mouth (D37) is a crane at the edge, not a body that moves: its own AI (src/ai/mouth.ts)
  if (isMouthDef(def)) return new MouthAI(level, def, seed);
  return new UtilityAI(level, def, seed, opts);
}

export { UtilityAI } from './controller';
export { levelParams, type LevelParams } from './levels';
