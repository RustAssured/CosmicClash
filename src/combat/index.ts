import type { Fighter, FighterFactory, FighterOptions } from '@/contracts';
import { witnessDef } from '@/titans';
import { FighterImpl } from './fighter';

/**
 * The Fighter factory the Match uses (`FighterFactory`). With `witness` set (URL `witness=1`, proposal 163), the Last One is
 * played as the Witness: its definition becomes `witnessDef(def)` (the eye cradle as the primary body, the region bodies,
 * the halo arcs as the resource).
 */
export const createFighter: FighterFactory = (opts: FighterOptions): Fighter =>
  new FighterImpl(opts.witness && opts.def.id === 'lastone' ? { ...opts, def: witnessDef(opts.def) } : opts);

export { FighterImpl, PACE } from './fighter';
export { Behaviour, DefaultBehaviour, type HitInfo, type InterceptResult } from './behaviour';
export { TUNING } from './tuning';
export { computeStats, topSpeed } from './stats';
