import type { TitanDef, TitanId } from '@/contracts';
import asteroidJson from './asteroid.json';
import blackholeJson from './blackhole.json';
import lastoneJson from './lastone.json';
import nexusJson from './nexus.json';
import planetJson from './planet.json';
import supernovaJson from './supernova.json';
import { uriDef } from './uri/def';

/** Titans whose art, moves and behaviour exist. 우리 joined after its Gate 2D (D31-7). */
export const IMPLEMENTED_TITANS: TitanId[] = [
  'lastone',
  'asteroid',
  'nexus',
  'blackhole',
  'supernova',
  'planet',
  'uri',
];

export const TITAN_DEFS: Partial<Record<TitanId, TitanDef>> = {
  lastone: lastoneJson as unknown as TitanDef,
  asteroid: asteroidJson as unknown as TitanDef,
  nexus: nexusJson as unknown as TitanDef,
  blackhole: blackholeJson as unknown as TitanDef,
  supernova: supernovaJson as unknown as TitanDef,
  planet: planetJson as unknown as TitanDef,
};
// 우리 is built in code from its packed asset (src/titans/uri/def.ts), which the browser loads at boot: build it on first use
Object.defineProperty(TITAN_DEFS, 'uri', { enumerable: true, configurable: false, get: uriDef });

/** The definition of an implemented titan. Throws for titans that are not implemented yet. */
export function getTitanDef(id: TitanId): TitanDef {
  const def = TITAN_DEFS[id];
  if (!def) throw new Error(`titan '${id}' is not implemented yet`);
  return def;
}

export const isImplemented = (id: TitanId): boolean => IMPLEMENTED_TITANS.includes(id);
