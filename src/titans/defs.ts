import { ROSTER_IDS, type TitanDef, type TitanId } from '@/contracts';
import { kitDefs } from './kit';
import asteroidJson from './asteroid.json';
import blackholeJson from './blackhole.json';
import colossusJson from './colossus.json';
import lastoneJson from './lastone.json';
import nexusJson from './nexus.json';
import planetJson from './planet.json';
import supernovaJson from './supernova.json';
import { witnessDef } from './art/lastone';
import { uriDef } from './uri/def';
import { MOUTH_ID, mouthDef } from './mouth/def';

/**
 * Titans whose art, moves and behaviour exist: the roster (src/contracts/roster.ts). 우리 joined after its Gate 2D (D31-7).
 *
 * D36 (ids and names): `colossus` is the big-eye colossus displayed as **The Last One** (마지막 하나); its code keeps the
 * historical Witness names (witnessDef, WitnessBehaviour, witnessKit, WITNESS_*). `lastone` is the returning tendril titan
 * displayed as **The Witness** (목격자); its code keeps the LastOne names (paintLastOne, LastOneBehaviour, tendrils).
 */
export const IMPLEMENTED_TITANS: TitanId[] = [...ROSTER_IDS];

export const TITAN_DEFS: Partial<Record<TitanId, TitanDef>> = {
  lastone: lastoneJson as unknown as TitanDef,
  asteroid: asteroidJson as unknown as TitanDef,
  nexus: nexusJson as unknown as TitanDef,
  blackhole: blackholeJson as unknown as TitanDef,
  supernova: supernovaJson as unknown as TitanDef,
  planet: planetJson as unknown as TitanDef,
  // the titans built with the titan kit (src/titans/kit/<id>/)
  ...Object.fromEntries(kitDefs().map((d) => [d.id, d])),
};
// the colossus is built in code (witnessDef) from its frozen template (colossus.json: the Last One's D34 JSON, whose moves
// it clones); painting its eye cradle costs a little, so build it on first use
Object.defineProperty(TITAN_DEFS, 'colossus', {
  enumerable: true,
  configurable: false,
  get: () => witnessDef(colossusJson as unknown as TitanDef),
});
// 우리 is built in code from its packed asset (src/titans/uri/def.ts), which the browser loads at boot: build it on first use
Object.defineProperty(TITAN_DEFS, 'uri', { enumerable: true, configurable: false, get: uriDef });

/**
 * The definition of an implemented titan. Throws for titans that are not implemented yet. The Mouth (D37) is a locked boss:
 * not on the roster (IMPLEMENTED_TITANS / TITAN_DEFS) but built here on request (src/titans/mouth/def.ts).
 */
export function getTitanDef(id: TitanId): TitanDef {
  if (id === MOUTH_ID) return mouthDef();
  const def = TITAN_DEFS[id];
  if (!def) throw new Error(`titan '${id}' is not implemented yet`);
  return def;
}

export const isImplemented = (id: TitanId): boolean => IMPLEMENTED_TITANS.includes(id);
