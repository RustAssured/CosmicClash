import type { Fighter, FighterFactory, FighterOptions } from '@/contracts';
import { FighterImpl } from './fighter';

/** The Fighter factory the Match uses (`FighterFactory`). */
export const createFighter: FighterFactory = (opts: FighterOptions): Fighter => new FighterImpl(opts);

export { FighterImpl } from './fighter';
export { Behaviour, DefaultBehaviour, type HitInfo, type InterceptResult } from './behaviour';
export { TUNING } from './tuning';
export { computeStats, topSpeed } from './stats';
