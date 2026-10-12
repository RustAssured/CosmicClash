import type { TitanId } from '@/contracts';
import { createAsteroidVoice } from './asteroid';
import { createBlackHoleVoice } from './blackhole';
import { createColossusVoice, createLastOneVoice } from './lastone';
import { createNexusVoice } from './nexus';
import { createPlanetVoice } from './planet';
import { createSupernovaVoice } from './supernova';
import type { TitanVoice } from './types';
import { createUriVoice } from './uri';
import { createKitVoice } from './kitVoice';
import { kitTitan } from '@/titans/kit';

/** One voice file per titan (see `types.ts`). */
export const VOICES: Readonly<Partial<Record<TitanId, () => TitanVoice>>> = {
  // D36: the colossus (The Last One) and the Witness (id 'lastone') share the temple voice in two tunings
  colossus: createColossusVoice,
  lastone: createLastOneVoice,
  nexus: createNexusVoice,
  blackhole: createBlackHoleVoice,
  supernova: createSupernovaVoice,
  planet: createPlanetVoice,
  asteroid: createAsteroidVoice,
  uri: createUriVoice,
};

/**
 * A fresh voice for `id`. An id this build has never heard of gets an empty voice (every handler is optional), which falls
 * through to the shared titan-neutral sounds: a titan without a voice still sounds like a fight.
 */
export const createTitanVoice = (id: TitanId): TitanVoice =>
  VOICES[id]?.() ?? kitVoiceOf(id) ?? { titan: id };

/** A titan built with the titan kit is voiced by its JSON's `kit.voice` tuning (kitVoice.ts). */
function kitVoiceOf(id: TitanId): TitanVoice | null {
  const tuning = kitTitan(id)?.def.kit?.voice;
  return tuning ? createKitVoice(id, tuning) : null;
}
