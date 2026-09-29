import {
  createMatterMap,
  type MaterialDef,
  type MatterMap,
  type StageLighting,
  type TitanDef,
  type TitanId,
} from '@/contracts';
import { paintAsteroid, type AsteroidRig } from './art/asteroid';
import { paintLastOne, type LastOneRig } from './art/lastone';
import { paintNexus, type NexusRig } from './art/nexus';
import { paintSupernova, type SupernovaRig } from './art/supernova';
import { resolveMaterials } from './materialTable';

/** Per-titan geometric rig produced alongside the pixels (anchor points the fighter needs: tendril roots, eye, core…). */
export type TitanRig = LastOneRig | AsteroidRig | NexusRig | SupernovaRig;

export interface PaintedTitan {
  map: MatterMap;
  rig: TitanRig;
}

type Painter = (def: TitanDef, seed: number, lighting: StageLighting) => PaintedTitan;

const PAINTERS: Partial<Record<TitanId, Painter>> = {
  lastone: paintLastOne as Painter,
  asteroid: paintAsteroid as Painter,
  nexus: paintNexus as Painter,
  supernova: paintSupernova as Painter,
};

/**
 * Paint a titan's pristine matter map (material ids, densities, lit base colours, relief, core) and its rig.
 * Pure and deterministic: same (def, seed, lighting) ⇒ identical bytes. Bonds/integrity/pixels are initialised by the matter world.
 */
export function paintTitanMap(def: TitanDef, seed: number, lighting: StageLighting): PaintedTitan {
  const painter = PAINTERS[def.id];
  if (!painter) throw new Error(`no art painter for titan '${def.id}'`);
  return painter(def, seed, lighting);
}

export interface GeneratedTitan extends PaintedTitan {
  materials: MaterialDef[];
}

const PAINT_CACHE = new Map<string, PaintedTitan>();
const PAINT_CACHE_MAX = 12;

/** Fresh copy of a painted map (typed-array memcpy: ~1 ms vs ~300 ms to paint). Only the generator's fields are copied. */
function cloneMap(src: MatterMap): MatterMap {
  const m = createMatterMap(src.w, src.h);
  m.material.set(src.material);
  m.density.set(src.density);
  m.baseColor.set(src.baseColor);
  m.height.set(src.height);
  m.coreX = src.coreX;
  m.coreY = src.coreY;
  m.coreRadius = src.coreRadius;
  return m;
}

/**
 * Generate a titan body ready for `world.createBody`: the painted matter map, the resolved material table
 * (`specs[i]` ⇒ id `i + 1`, 0 = void) and the rig (tendril roots, eye, core…). Deterministic. Painting is memoised per
 * (titan, seed, lighting) and every call returns a private copy of the map, so tournaments and rematches are cheap.
 */
export function generateTitanBody(def: TitanDef, seed: number, lighting: StageLighting): GeneratedTitan {
  const key = `${def.id}|${seed >>> 0}|${lighting.dir.join(',')}|${lighting.color}|${lighting.ambient}|${lighting.rim}`;
  let painted = PAINT_CACHE.get(key);
  if (!painted) {
    painted = paintTitanMap(def, seed, lighting);
    if (PAINT_CACHE.size >= PAINT_CACHE_MAX) PAINT_CACHE.delete(PAINT_CACHE.keys().next().value as string);
    PAINT_CACHE.set(key, painted);
  }
  const map = cloneMap(painted.map);
  rememberRig(map, painted.rig);
  return { map, rig: painted.rig, materials: resolveMaterials(def.materials) };
}

const RIGS = new WeakMap<MatterMap, TitanRig>();

/** Remember the rig of a generated map so a fighter re-created around `existingBody` can find it again. */
export function rememberRig(map: MatterMap, rig: TitanRig): void {
  RIGS.set(map, rig);
}
export const rigOfMap = (map: MatterMap): TitanRig | undefined => RIGS.get(map);
