import type { TitanDef, TitanId } from '@/contracts';
import asteroidJson from './asteroid.json';
import blackholeJson from './blackhole.json';
import lastoneJson from './lastone.json';
import nexusJson from './nexus.json';
import planetJson from './planet.json';
import supernovaJson from './supernova.json';

/** Titans whose art, moves and behaviour exist. The other four are Phase 2 content. */
export const IMPLEMENTED_TITANS: TitanId[] = ['lastone', 'asteroid', 'nexus', 'supernova', 'planet'];

export const TITAN_DEFS: Partial<Record<TitanId, TitanDef>> = {
  lastone: lastoneJson as unknown as TitanDef,
  asteroid: asteroidJson as unknown as TitanDef,
  nexus: nexusJson as unknown as TitanDef,
  blackhole: blackholeJson as unknown as TitanDef,
  supernova: supernovaJson as unknown as TitanDef,
  planet: planetJson as unknown as TitanDef,
};

/** The definition of an implemented titan. Throws for titans that are not implemented yet. */
export function getTitanDef(id: TitanId): TitanDef {
  const def = TITAN_DEFS[id];
  if (!def) throw new Error(`titan '${id}' is not implemented yet`);
  return def;
}

export const isImplemented = (id: TitanId): boolean => IMPLEMENTED_TITANS.includes(id);
