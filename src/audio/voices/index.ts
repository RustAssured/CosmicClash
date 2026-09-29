import type { TitanId } from '@/contracts';
import { createAsteroidVoice } from './asteroid';
import { createBlackHoleVoice } from './blackhole';
import { createLastOneVoice } from './lastone';
import { createNexusVoice } from './nexus';
import { createPlanetVoice } from './planet';
import { createSupernovaVoice } from './supernova';
import type { TitanVoice } from './types';

/** One voice file per titan (see `types.ts`). */
export const VOICES: Readonly<Record<TitanId, () => TitanVoice>> = {
  lastone: createLastOneVoice,
  nexus: createNexusVoice,
  blackhole: createBlackHoleVoice,
  supernova: createSupernovaVoice,
  planet: createPlanetVoice,
  asteroid: createAsteroidVoice,
};

/**
 * A fresh voice for `id`. An id this build has never heard of gets an empty voice (every handler is optional), which falls
 * through to the shared titan-neutral sounds: a titan without a voice still sounds like a fight.
 */
export const createTitanVoice = (id: TitanId): TitanVoice => VOICES[id]?.() ?? { titan: id };
