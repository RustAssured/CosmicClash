import type { MaterialDef, MatterMap, StageLighting, TitanDef, TitanId } from '@/contracts';
import { paintAsteroid, type AsteroidRig } from './art/asteroid';
import { paintLastOne, type LastOneRig } from './art/lastone';
import { resolveMaterialsLocal } from './materialTable';

/** Per-titan geometric rig produced alongside the pixels (anchor points the fighter needs: tendril roots, eye, core…). */
export type TitanRig = LastOneRig | AsteroidRig;

export interface PaintedTitan {
  map: MatterMap;
  rig: TitanRig;
}

type Painter = (def: TitanDef, seed: number, lighting: StageLighting) => PaintedTitan;

const PAINTERS: Partial<Record<TitanId, Painter>> = {
  lastone: paintLastOne as Painter,
  asteroid: paintAsteroid as Painter,
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

/**
 * Generate a titan body ready for `world.createBody`: the painted matter map, the resolved material table
 * (`specs[i]` ⇒ id `i + 1`, 0 = void) and the rig (tendril roots, eye, core…). Deterministic.
 */
export function generateTitanBody(def: TitanDef, seed: number, lighting: StageLighting): GeneratedTitan {
  const painted = paintTitanMap(def, seed, lighting);
  rememberRig(painted.map, painted.rig);
  return { ...painted, materials: resolveMaterialsLocal(def.materials) };
}

const RIGS = new WeakMap<MatterMap, TitanRig>();

/** Remember the rig of a generated map so a fighter re-created around `existingBody` can find it again. */
export function rememberRig(map: MatterMap, rig: TitanRig): void {
  RIGS.set(map, rig);
}
export const rigOfMap = (map: MatterMap): TitanRig | undefined => RIGS.get(map);
