import { DAMAGE_TYPES, hex, type MaterialDef, type MaterialPhysics, type MaterialSpec } from '@/contracts';

/**
 * Resolve a titan's JSON materials into the packed table the matter world uses: index 0 is the reserved EMPTY material,
 * `specs[i]` gets id `i + 1`. This module is the single place the titans package depends on the matter library.
 */

const EMPTY_PHYS: MaterialPhysics = {
  density: 0,
  bond: 0,
  toughness: 0,
  brittleness: 0,
  resist: { FRACTURE: 1, ASSIMILATION: 1, TIDAL: 1, THERMAL: 1, CRUSH: 1, KINETIC: 1 },
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
};

const DEFAULT_PHYS: MaterialPhysics = {
  ...EMPTY_PHYS,
  density: 1,
  bond: 140,
  toughness: 0.5,
  brittleness: 0.5,
  conductivity: 0.3,
  vaporize: 1900,
  assimilable: 0.3,
  debris: 'chunk',
};

/** Fallback resolver used until (and unless) the matter library's own `buildMaterialTable` is wired in. */
export function resolveMaterialsLocal(specs: readonly MaterialSpec[]): MaterialDef[] {
  const mk = (id: number, key: string, phys: MaterialPhysics, ramp: number[], v: MaterialSpec['visual'] | null): MaterialDef => ({
    ...phys,
    id,
    key,
    ramp,
    emissive: v?.emissive ?? 0,
    glowRamp: (v?.glowRamp ?? ['#5a1400', '#c2410c', '#fb923c', '#fde68a', '#ffffff']).map(hex),
    char: hex(v?.char ?? '#1a1410'),
    crack: hex(v?.crack ?? '#000000'),
    infect: hex(v?.infect ?? '#b3122e'),
    debrisColor: hex(v?.debris ?? v?.ramp[Math.floor(v.ramp.length / 2)] ?? '#888888'),
    ashId: 0,
  });
  const out: MaterialDef[] = [mk(0, '', EMPTY_PHYS, [], null)];
  specs.forEach((s, i) => {
    const phys: MaterialPhysics = {
      ...DEFAULT_PHYS,
      ...(s.physics ?? {}),
      resist: { ...DEFAULT_PHYS.resist, ...(s.physics?.resist ?? {}) },
    };
    for (const t of DAMAGE_TYPES) phys.resist[t] = Math.min(4, Math.max(0, phys.resist[t]));
    out.push(mk(i + 1, s.key, phys, s.visual.ramp.map(hex), s.visual));
  });
  return out;
}
