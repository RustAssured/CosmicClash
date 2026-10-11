export { IMPLEMENTED_TITANS, TITAN_DEFS, getTitanDef, isImplemented } from './defs';
export {
  generateTitanBody,
  paintTitanMap,
  rememberRig,
  rigOfMap,
  type GeneratedTitan,
  type PaintedTitan,
  type TitanRig,
} from './generate';
export type { LastOneRig, TendrilRoot, WitnessBody, WitnessRegion, WitnessTitanRig } from './art/lastone';
export {
  isWitnessDef,
  witnessDef,
  WITNESS_MATERIALS,
  WITNESS_SCALE,
  WITNESS_SHRINE_LIGHT_Y,
} from './art/lastone';
export type { AsteroidRig } from './art/asteroid';
export type { BlackHoleRig } from './art/blackhole';
export {
  groupNexusCells,
  type NexusRig,
  type NexusNode,
  type NexusEdge,
  type NexusGroups,
} from './art/nexus';
export { LINK, linkIndex, rasterLink, RIVET_OFFSET, type LinkSink } from './art/chainLink';
export type { SupernovaRig } from './art/supernova';
export type { PlanetRig, MoonSpec } from './art/planet';
export { generateMoonBody } from './art/planet';
export { renderPortrait, type Portrait } from './portrait';
export { blend } from './art/color';
export { hash01 } from './art/noise';
export { uriDef, isUriDef, URI_ID, URI_PRIMARY, type UriTitanRig } from './uri/def';
export { URI_MATERIALS, uriPartMatter, cloneUriMap, type UriPartMatter } from './uri/maps';
export { MOUTH_ID, mouthDef, mouthBossDef, isMouthDef, isMouthBossDef } from './mouth/def';
export { isMouthUnlocked, setMouthUnlocked, MOUTH_UNLOCK_KEY } from './mouth/unlock';
