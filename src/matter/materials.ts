import {
  hex,
  type MaterialDef,
  type MaterialPhysics,
  type MaterialSpec,
  type MaterialVisual,
} from '@/contracts';
import { DEFAULT_GLOW_RAMP, DEFAULT_INFECT, DEFAULT_VISUALS, MATERIAL_ARCHETYPES } from './archetypes';

/** The reserved EMPTY material (id 0): void. */
function emptyMaterial(): MaterialDef {
  return {
    id: 0,
    key: '',
    density: 0,
    bond: 0,
    toughness: 0,
    brittleness: 0,
    resist: { FRACTURE: 0, ASSIMILATION: 0, TIDAL: 0, THERMAL: 0, CRUSH: 0, KINETIC: 0 },
    heatCapacity: 1,
    conductivity: 0,
    ignition: 0,
    burnRate: 0,
    vaporize: 0,
    heatAbsorb: 0,
    flammableGas: false,
    assimilable: 0,
    debris: 'none',
    ashTo: '',
    fluid: false,
    ramp: [0],
    emissive: 0,
    glowRamp: [0],
    char: 0,
    crack: 0,
    infect: 0,
    debrisColor: 0,
    ashId: 0,
  };
}

function resolvePhysics(spec: MaterialSpec): MaterialPhysics {
  const arch = MATERIAL_ARCHETYPES[spec.base];
  if (!arch) throw new Error(`matter: unknown material archetype "${spec.base}" for material "${spec.key}"`);
  const o = spec.physics ?? {};
  const { resist: resistOverride, ...rest } = o;
  return { ...arch, ...rest, resist: { ...arch.resist, ...(resistOverride ?? {}) } };
}

function makeDef(id: number, key: string, phys: MaterialPhysics, vis: MaterialVisual): MaterialDef {
  const ramp = vis.ramp.map(hex);
  return {
    ...phys,
    resist: { ...phys.resist },
    id,
    key,
    ramp,
    emissive: Math.max(0, Math.min(255, vis.emissive | 0)),
    glowRamp: (vis.glowRamp && vis.glowRamp.length ? vis.glowRamp : DEFAULT_GLOW_RAMP).map(hex),
    char: hex(vis.char),
    crack: hex(vis.crack),
    infect: hex(vis.infect ?? DEFAULT_INFECT),
    debrisColor: vis.debris ? hex(vis.debris) : ramp[ramp.length >> 1]!,
    ashId: 0,
  };
}

/**
 * Resolve titan MaterialSpec[] into the material table used by a body.
 *  - index 0 is the reserved EMPTY material; `specs[i]` gets id `i + 1` (generators rely on this);
 *  - `ashTo` keys resolve within the same table; if a spec (or its archetype default) references a key the titan did not
 *    list and it names an archetype with a default look (ash/char), that material is appended AFTER the authored ones.
 */
export function buildMaterialTable(specs: readonly MaterialSpec[]): MaterialDef[] {
  const table: MaterialDef[] = [emptyMaterial()];
  const byKey = new Map<string, number>();
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]!;
    if (byKey.has(s.key)) throw new Error(`matter: duplicate material key "${s.key}"`);
    byKey.set(s.key, i + 1);
    table.push(makeDef(i + 1, s.key, resolvePhysics(s), s.visual));
  }
  // Resolve ashTo, appending default archetypes where needed. Newly appended materials may themselves reference ashTo.
  for (let i = 1; i < table.length; i++) {
    const def = table[i]!;
    if (!def.ashTo) continue;
    let id = byKey.get(def.ashTo);
    if (id === undefined) {
      const arch = MATERIAL_ARCHETYPES[def.ashTo];
      const vis = DEFAULT_VISUALS[def.ashTo];
      if (!arch || !vis)
        throw new Error(
          `matter: material "${def.key}" ashTo "${def.ashTo}" is not in the table and has no default look`,
        );
      id = table.length;
      byKey.set(def.ashTo, id);
      table.push(makeDef(id, def.ashTo, { ...arch, resist: { ...arch.resist } }, vis));
    }
    def.ashId = id;
  }
  if (table.length > 255) throw new Error('matter: material table exceeds 255 entries');
  return table;
}
