import type { DamageType, MaterialPhysics, MaterialVisual } from '@/contracts';

/**
 * PHYSICS ARCHETYPE LIBRARY. Titan JSON picks one of these via `MaterialSpec.base` and may override numbers.
 * The `resist` table (multiplier on incoming energy, per damage type) IS the rock-paper-scissors of the game; every
 * number here is documented in docs/DESTRUCTION.md. Column order everywhere: FRACTURE, ASSIMILATION, TIDAL, THERMAL,
 * CRUSH, KINETIC (the order of DAMAGE_TYPES).
 *
 * Thermal units: 1 energy heats a heatCapacity-1 cell by HEAT_PER_ENERGY (see thermal.ts). `ignition`/`vaporize` are in
 * those units, so a baseline rock cell needs ~1.9 energy to vaporise and ~0.32 energy to ignite a lattice cell.
 */

const R = (
  FRACTURE: number,
  ASSIMILATION: number,
  TIDAL: number,
  THERMAL: number,
  CRUSH: number,
  KINETIC: number,
): Record<DamageType, number> => ({ FRACTURE, ASSIMILATION, TIDAL, THERMAL, CRUSH, KINETIC });

/** Fields shared by all solids unless overridden. */
const base: MaterialPhysics = {
  density: 1,
  bond: 140,
  toughness: 0.5,
  brittleness: 0.5,
  resist: R(1, 1, 1, 1, 1, 1),
  heatCapacity: 1,
  conductivity: 0.3,
  ignition: 0,
  burnRate: 0,
  vaporize: 1900,
  heatAbsorb: 0,
  flammableGas: false,
  assimilable: 0.3,
  debris: 'chunk',
  ashTo: '',
  fluid: false,
};

const m = (o: Partial<MaterialPhysics>): MaterialPhysics => ({
  ...base,
  ...o,
  resist: o.resist ?? base.resist,
});

export const MATERIAL_ARCHETYPES: Record<string, MaterialPhysics> = {
  /* ---------------------------------- rocks & metals ---------------------------------- */
  /** Bulk crust rock: brittle-ish, chunky debris. */
  rock: m({
    density: 1,
    bond: 150,
    toughness: 0.55,
    brittleness: 0.65,
    resist: R(1, 0.9, 1, 0.7, 1, 1),
    vaporize: 1900,
  }),
  /** Loose surface dust: low bond, low toughness -> KINETIC/CRUSH erode it to dust, wide soft craters. */
  regolith: m({
    density: 0.8,
    bond: 70,
    toughness: 0.2,
    brittleness: 0.2,
    resist: R(0.8, 1.1, 1.2, 0.8, 1.25, 1.3),
    conductivity: 0.25,
    vaporize: 1700,
    assimilable: 0.4,
    debris: 'dust',
  }),
  mantle: m({
    density: 1.25,
    bond: 135,
    toughness: 0.5,
    brittleness: 0.45,
    resist: R(0.85, 0.9, 1, 0.6, 0.9, 0.9),
    heatCapacity: 1.3,
    conductivity: 0.4,
    vaporize: 2200,
  }),
  /** Iron-nickel: dense, tough, ductile. Resists FRACTURE and KINETIC, conducts heat fast, craters deep and clean. */
  ironNickel: m({
    density: 2.4,
    bond: 205,
    toughness: 0.85,
    brittleness: 0.3,
    resist: R(0.55, 0.6, 0.9, 0.65, 0.85, 0.7),
    heatCapacity: 0.8,
    conductivity: 0.6,
    vaporize: 2600,
    assimilable: 0.25,
    debris: 'chunk',
  }),
  /** Water ice: brittle, low density, boils away under THERMAL. */
  ice: m({
    density: 0.6,
    bond: 90,
    toughness: 0.3,
    brittleness: 0.85,
    resist: R(1.3, 1, 1.2, 2.4, 1.1, 1),
    heatCapacity: 1.4,
    conductivity: 0.2,
    vaporize: 450,
    heatAbsorb: 0.12,
    assimilable: 0.35,
    debris: 'shard',
  }),
  /** Faceted crystal: very brittle, FRACTURE shears it into big clean shards. */
  crystal: m({
    density: 1.3,
    bond: 120,
    toughness: 0.35,
    brittleness: 0.95,
    resist: R(1.5, 0.8, 1, 0.9, 1.2, 1.2),
    conductivity: 0.3,
    vaporize: 1800,
    assimilable: 0.2,
    debris: 'shard',
  }),
  glass: m({
    density: 1.1,
    bond: 70,
    toughness: 0.25,
    brittleness: 0.98,
    resist: R(1.6, 0.7, 1, 0.8, 1.3, 1.3),
    conductivity: 0.25,
    vaporize: 1500,
    assimilable: 0.15,
    debris: 'shard',
  }),
  /** The Last One's glazed celadon body: glass-like, shears cleanly along its bonds. */
  celadon: m({
    density: 1.15,
    bond: 95,
    toughness: 0.4,
    brittleness: 0.9,
    resist: R(1.35, 1.1, 1, 0.8, 1.1, 1.2),
    conductivity: 0.3,
    vaporize: 1700,
    assimilable: 0.3,
    debris: 'shard',
  }),
  /** Soft, fragile, glowing: takes heavy damage from everything (failure mode: exposed eye). */
  eye: m({
    density: 0.9,
    bond: 60,
    toughness: 0.2,
    brittleness: 0.5,
    resist: R(1.6, 1.2, 1.2, 1.3, 1.3, 1.5),
    vaporize: 1300,
    assimilable: 0.5,
    debris: 'dust',
  }),
  /** Flexible, high tensile bond, low brittleness. */
  tendril: m({
    density: 0.7,
    bond: 205,
    toughness: 0.6,
    brittleness: 0.1,
    resist: R(0.7, 1, 1.4, 1.2, 0.6, 0.8),
    heatCapacity: 0.9,
    vaporize: 1500,
    assimilable: 0.5,
    debris: 'dust',
  }),

  /* ---------------------------------- the Nexus family ---------------------------------- */
  /** Crimson lattice: light, brittle-ish, burns (ignition/burnRate), assimilates readily. */
  lattice: m({
    density: 0.7,
    bond: 105,
    toughness: 0.4,
    brittleness: 0.6,
    resist: R(1.1, 0.2, 1.2, 1.7, 1.1, 1.25),
    heatCapacity: 0.9,
    conductivity: 0.35,
    ignition: 320,
    burnRate: 5,
    vaporize: 1500,
    assimilable: 1,
    debris: 'chunk',
    ashTo: 'ash',
  }),
  /** Hardened chain: tough, resists FRACTURE hard, slow to burn. */
  chain: m({
    density: 1.6,
    bond: 235,
    toughness: 0.85,
    brittleness: 0.2,
    resist: R(0.6, 0.5, 1, 0.9, 0.8, 0.8),
    heatCapacity: 0.8,
    conductivity: 0.5,
    vaporize: 2300,
    assimilable: 0.6,
    debris: 'shard',
  }),
  /** Crystalline graph node/hub: dense and brittle; KINETIC shrapnel embedded here fractures it outward. */
  node: m({
    density: 1.5,
    bond: 185,
    toughness: 0.6,
    brittleness: 0.7,
    resist: R(1.2, 0.4, 0.9, 1, 1.1, 1.4),
    vaporize: 2000,
    assimilable: 0.5,
    debris: 'shard',
  }),

  /* ---------------------------------- plasma, gas, fluids ---------------------------------- */
  /** Stellar plasma: featherweight, resists solid attacks (nothing to break), immune-ish to heat, stripped by TIDAL. */
  plasma: m({
    density: 0.15,
    bond: 28,
    toughness: 0.05,
    brittleness: 0.05,
    resist: R(0.35, 0.6, 2, 0.2, 0.4, 0.4),
    heatCapacity: 0.3,
    conductivity: 0.6,
    vaporize: 0,
    assimilable: 0.6,
    debris: 'gas',
    fluid: true,
  }),
  corona: m({
    density: 0.08,
    bond: 15,
    toughness: 0.02,
    brittleness: 0.02,
    resist: R(0.25, 0.5, 2.4, 0.15, 0.3, 0.3),
    heatCapacity: 0.25,
    conductivity: 0.7,
    vaporize: 0,
    assimilable: 0.4,
    debris: 'gas',
    fluid: true,
  }),
  /** Thin atmosphere: absorbs heat (shields what is below it), drifts away when unsupported. */
  gas: m({
    density: 0.05,
    bond: 12,
    toughness: 0.02,
    brittleness: 0.05,
    resist: R(0.2, 0.5, 2.2, 0.5, 0.3, 0.2),
    heatCapacity: 0.2,
    conductivity: 0.5,
    vaporize: 0,
    heatAbsorb: 0.55,
    assimilable: 0.3,
    debris: 'gas',
    fluid: true,
  }),
  cloud: m({
    density: 0.1,
    bond: 18,
    toughness: 0.05,
    brittleness: 0.05,
    resist: R(0.3, 0.6, 2, 0.5, 0.4, 0.25),
    heatCapacity: 0.5,
    conductivity: 0.4,
    vaporize: 0,
    heatAbsorb: 0.5,
    assimilable: 0.3,
    debris: 'gas',
    fluid: true,
  }),
  /** Flammable gas: ignites at low temperature and flash-burns (fireballs; feeds tidal streams). */
  fuelGas: m({
    density: 0.05,
    bond: 10,
    toughness: 0.02,
    brittleness: 0.05,
    resist: R(0.2, 0.5, 2.2, 2.4, 0.3, 0.2),
    heatCapacity: 0.1,
    conductivity: 0.6,
    ignition: 140,
    burnRate: 38,
    vaporize: 0,
    heatAbsorb: 0,
    flammableGas: true,
    assimilable: 0.3,
    debris: 'gas',
    fluid: true,
  }),
  diskGas: m({
    density: 0.12,
    bond: 18,
    toughness: 0.02,
    brittleness: 0.05,
    resist: R(0.3, 0.5, 0.25, 0.35, 0.4, 0.35),
    heatCapacity: 0.5,
    conductivity: 0.5,
    vaporize: 0,
    assimilable: 0.3,
    debris: 'gas',
    fluid: true,
  }),
  jet: m({
    density: 0.05,
    bond: 10,
    toughness: 0.02,
    brittleness: 0.02,
    resist: R(0.2, 0.4, 0.3, 0.3, 0.3, 0.2),
    heatCapacity: 0.4,
    conductivity: 0.6,
    vaporize: 0,
    assimilable: 0.2,
    debris: 'gas',
    fluid: true,
  }),
  /** Ocean: soaks heat (heatAbsorb), boils away, pours off as liquid when unsupported. */
  ocean: m({
    density: 0.95,
    bond: 20,
    toughness: 0.05,
    brittleness: 0.05,
    resist: R(0.5, 0.7, 1.6, 0.45, 0.6, 0.4),
    heatCapacity: 3,
    conductivity: 0.3,
    vaporize: 700,
    heatAbsorb: 0.55,
    assimilable: 0.3,
    debris: 'liquid',
    fluid: true,
  }),
  magma: m({
    density: 1.3,
    bond: 55,
    toughness: 0.15,
    brittleness: 0.2,
    resist: R(0.6, 0.8, 1, 0.25, 0.7, 0.8),
    heatCapacity: 1.6,
    conductivity: 0.5,
    vaporize: 3000,
    assimilable: 0.4,
    debris: 'liquid',
  }),
  /** Dense hot core (planet core, star core). */
  core: m({
    density: 2,
    bond: 200,
    toughness: 0.8,
    brittleness: 0.4,
    resist: R(0.7, 0.6, 0.8, 0.3, 0.6, 0.8),
    heatCapacity: 1.5,
    conductivity: 0.6,
    vaporize: 3500,
    assimilable: 0.3,
    debris: 'ember',
  }),
  /** The Black Hole's true-black horizon: cannot be hurt, never removed. */
  horizon: m({
    density: 3,
    bond: 255,
    toughness: 1,
    brittleness: 0,
    resist: R(0, 0, 0, 0, 0, 0),
    heatCapacity: 100,
    conductivity: 0,
    vaporize: 0,
    assimilable: 0,
    debris: 'none',
  }),

  /* ---------------------------------- burnt remains ---------------------------------- */
  ash: m({
    density: 0.3,
    bond: 30,
    toughness: 0.05,
    brittleness: 0.4,
    resist: R(1.2, 1.2, 1.5, 0.3, 1.3, 1.4),
    heatCapacity: 0.8,
    conductivity: 0.15,
    vaporize: 2000,
    assimilable: 0.1,
    debris: 'dust',
  }),
  char: m({
    density: 0.5,
    bond: 55,
    toughness: 0.1,
    brittleness: 0.5,
    resist: R(1.1, 1, 1.3, 0.6, 1.2, 1.2),
    heatCapacity: 0.9,
    conductivity: 0.2,
    vaporize: 1900,
    assimilable: 0.2,
    debris: 'ember',
  }),
};

/** Default look for archetypes the matter module appends automatically (ash / char). Hex ramps dark -> light. */
export const DEFAULT_VISUALS: Record<string, MaterialVisual> = {
  ash: {
    ramp: ['#161418', '#26222a', '#3b353f', '#59505a', '#7d727b'],
    emissive: 0,
    char: '#161418',
    crack: '#0b0a0c',
    debris: '#4b4450',
  },
  char: {
    ramp: ['#0a0708', '#150e0f', '#241716', '#38221d', '#4d2f27'],
    emissive: 0,
    char: '#0a0708',
    crack: '#050303',
    debris: '#2a1a17',
  },
};

/** Generic ember glow ramp, cool -> white-hot: dark red, red, orange, amber, pale yellow, white. */
export const DEFAULT_GLOW_RAMP: readonly string[] = [
  '#3a0a05',
  '#a01c08',
  '#e2560c',
  '#ffb52e',
  '#fff2b0',
  '#ffffff',
];
export const DEFAULT_INFECT = '#c8102e';
