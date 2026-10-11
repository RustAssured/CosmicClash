import type { ArenaInfo, TitanId } from '@/contracts';
import { MOUTH_LIVE } from './tuning';

/**
 * Arena B (Gate 3A §1, D37): when the Mouth plays, the stage's arena keeps its width but is 360 px tall, restY ± 180, so
 * the top and the bottom edge are both always on screen (the camera's y is then locked by the arena clamp) and the coils bleed
 * off the frame exactly as in the oracle. Soft walls, comets and scenery are unchanged.
 */
export function mouthArena(a: ArenaInfo): ArenaInfo {
  const half = MOUTH_LIVE.arenaHalfH;
  const minY = Math.max(a.minY, a.restY - half);
  const maxY = Math.min(a.maxY, minY + 2 * half);
  return { ...a, minY, maxY, restY: (minY + maxY) / 2 };
}

/** The arena a match between these titans plays in: arena B when either is the Mouth, else the stage's own. */
export function arenaForMatch(a: ArenaInfo, titans: readonly TitanId[]): ArenaInfo {
  return titans.includes('mouth') ? mouthArena(a) : a;
}
