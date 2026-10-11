import type { Fighter, FighterFactory, FighterOptions } from '@/contracts';
import { FighterImpl } from './fighter';
import { isMouthDef } from '@/titans/mouth/def';
import { MouthFighter } from './mouth/fighter';

/**
 * The Fighter factory the Match uses (`FighterFactory`). D36: the colossus is its own titan ('colossus', whose definition is
 * already `witnessDef(...)`), so the old `witness` flag no longer swaps the Last One's definition; it is ignored.
 */
export const createFighter: FighterFactory = (opts: FighterOptions): Fighter =>
  // the Mouth (D37) is analytic, not matter: its own Fighter (src/combat/mouth/fighter.ts)
  isMouthDef(opts.def) ? new MouthFighter(opts) : new FighterImpl(opts);

export { FighterImpl, PACE } from './fighter';
export { Behaviour, DefaultBehaviour, type HitInfo, type InterceptResult } from './behaviour';
export { TUNING } from './tuning';
export { computeStats, topSpeed } from './stats';
