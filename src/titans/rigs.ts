import type { TitanDef } from '@/contracts';
import { buildAsteroidRig } from './art/asteroid';
import { buildLastOneRig } from './art/lastone';
import type { TitanRig } from './generate';

/** Recompute a titan's rig from its recipe alone (no pixels). Used when a body is reused (`existingBody`). */
export function buildRigFor(def: TitanDef, seed: number): TitanRig {
  switch (def.id) {
    case 'lastone':
      return buildLastOneRig(def, seed);
    case 'asteroid':
      return buildAsteroidRig(def, seed);
    default:
      throw new Error(`no rig for titan '${def.id}'`);
  }
}
