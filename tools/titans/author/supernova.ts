/**
 * Authoring script for `src/titans/supernova.json`. The JSON is the source of truth for the game, the validator and the docs
 * generator; this script only saves writing every aim variant by hand. Regenerate with
 *   npx tsx tools/titans/author/supernova.ts && npx prettier --write src/titans/supernova.json
 * (numbers are tuned HERE, then the JSON is regenerated; do not hand-edit one without the other).
 */
import { writeFileSync } from 'node:fs';
import { DamageFlag, type MoveDef, type TitanDef } from '@/contracts';
import { AIM_SIGN, aims, frame, hb, key } from './kit';

/** One continuous star gradient (deep violet shadow → crimson → orange → gold → white → cool blue-white); every star material's ramp is a slice of it. */
const GRADIENT = [
  '#2a0a26',
  '#4f0f2c',
  '#7c1d33',
  '#a72832',
  '#d23c2a',
  '#f0621f',
  '#ff8a2e',
  '#ffae38',
  '#ffd050',
  '#ffe98a',
  '#fff8d6',
  '#ffffff',
  '#dcefff',
  '#a9d8ff',
];
const slice = (a: number, b: number): string[] => GRADIENT.slice(a, b + 1);

const MATERIALS: TitanDef['materials'] = [
  {
    key: 'core',
    base: 'core',
    physics: { density: 1.5 },
    visual: {
      ramp: slice(6, 11),
      emissive: 165,
      glowRamp: ['#ff9a30', '#ffc848', '#ffe58a', '#fff4c8'],
      char: '#7a2a1c',
      crack: '#ffffff',
      debris: '#ffe27a',
    },
  },
  {
    key: 'inner',
    base: 'plasma',
    physics: { density: 0.5 },
    visual: {
      ramp: slice(4, 10),
      emissive: 105,
      glowRamp: ['#c2302f', '#ff8f34', '#ffd45a', '#ffeeb0'],
      char: '#3a0c22',
      crack: '#fff2b0',
      debris: '#ee5a28',
    },
  },
  {
    key: 'photosphere',
    base: 'plasma',
    physics: { density: 0.34 },
    visual: {
      ramp: slice(2, 10),
      emissive: 85,
      glowRamp: ['#ea5a26', '#ffaa38', '#ffdc78', '#fff0b0'],
      char: '#4a1428',
      crack: '#ffe27a',
      debris: '#ff8a2e',
    },
  },
  {
    key: 'corona',
    base: 'corona',
    // heavy, so that burning fuel (which sheds the outermost matter first) eats the corona over the whole fuel bar instead of in two
    // moves; its resistances are raised by the same factor as its hardness so it is still as easy to strip as before
    physics: {
      density: 0.45,
      resist: { FRACTURE: 0.65, KINETIC: 0.75, CRUSH: 0.75, THERMAL: 0.4, ASSIMILATION: 1, TIDAL: 3.6 },
    },
    visual: {
      ramp: ['#1b0d3a', '#3b1a68', '#6d34a0', '#a45ccc', '#e39ae6', '#fff0fb'],
      emissive: 78,
      glowRamp: ['#a45ccc', '#e39ae6', '#fff0fb', '#ffffff'],
      char: '#2a1248',
      crack: '#f2c8ff',
      debris: '#c988e0',
    },
  },
  {
    key: 'prominence',
    base: 'plasma',
    physics: {
      density: 0.35,
      resist: { FRACTURE: 0.65, KINETIC: 0.75, CRUSH: 0.75, THERMAL: 0.38, ASSIMILATION: 1.1, TIDAL: 3.8 },
    },
    visual: {
      ramp: ['#5a1030', '#a01e34', '#e23f2c', '#ff7a30', '#ffb040', '#ffe080', '#fff6c8'],
      emissive: 135,
      glowRamp: ['#e23f2c', '#ffb040', '#ffe080', '#fff6c8'],
      char: '#40102a',
      crack: '#fff6c8',
      debris: '#ff9a3c',
    },
  },
];

const T = 'THERMAL' as const;
const UNBLOCK = DamageFlag.UNBLOCKABLE;

/**
 * Strike — Flare: a burst of heat that swells outward from the star's face. A soft radial `field` (not a cone): the thermal model
 * melts the cells nearest the shape's centre first, so a compact burst is worth three times a wide wedge of the same energy.
 */
const flare: MoveDef = {
  id: 'supernova.flare',
  slot: 'strike',
  name: 'Flare',
  nameKo: '플레어',
  frame: frame(10, 6, 18, { hitstop: 5 }),
  variants: aims((aim) => {
    const s = AIM_SIGN[aim];
    return {
      hitboxes: [
        hb(
          'flare',
          0,
          6,
          { kind: 'field', ox: 66, oy: s * 26, r: 46, falloff: 1.5 },
          T,
          380,
          { shock: 0.6, scatter: 1 },
          0,
          { x: 210, y: s * 70 - 10 },
          0.3,
          { sweepTo: { kind: 'field', ox: 104, oy: s * 40, r: 62, falloff: 1.5 } },
        ),
      ],
      movement: [key(10, -70, 0, 0.3)],
    };
  }),
  resourceCost: 0,
  meterCost: 0,
  tags: ['burst'],
  extra: { fuel: 3, pose: { startup: { lean: -3 }, active: { lean: 5 } } },
};

/** Crush — Coronal Ejection: a vast slow fireball that travels out from the star, then blasts what it meets. */
const ejection: MoveDef = {
  id: 'supernova.ejection',
  slot: 'crush',
  name: 'Coronal Ejection',
  nameKo: '코로나 질량 방출',
  frame: frame(32, 26, 50, { hitstop: 12 }),
  variants: aims((aim) => {
    const s = AIM_SIGN[aim];
    return {
      hitboxes: [
        hb(
          'ejecta',
          0,
          26,
          { kind: 'point', ox: 56, oy: s * 26, r: 30 },
          T,
          1500,
          { shock: 1.8, scatter: 1.2 },
          0,
          { x: 520, y: -60 + s * 110 },
          1,
          { sweepTo: { kind: 'point', ox: 250, oy: s * 118, r: 38 } },
        ),
      ],
      movement: [key(0, -110, 0, 0.3), key(32, -80, 0, 0.2)],
    };
  }),
  resourceCost: 0,
  meterCost: 0,
  tags: ['projectile', 'heavy', 'blast'],
  extra: { fuel: 14, pose: { startup: { lean: -8 }, active: { lean: 6 }, recovery: { lean: 2 } } },
};

/** Surge — Solar Wind: the star sheds itself into a jet of plasma and rides it. */
const wind: MoveDef = {
  id: 'supernova.wind',
  slot: 'surge',
  name: 'Solar Wind',
  nameKo: '태양풍',
  frame: frame(2, 14, 6, { cancelWindow: 0 }),
  variants: aims(() => ({ hitboxes: [], movement: [key(0, 700, 0, 0.03)] })),
  resourceCost: 0,
  meterCost: 0,
  intangible: [1, 11],
  tags: ['dash', 'trail'],
  extra: { fuel: 2 },
};

/** Signature — Prominence: hold to charge; an arc of plasma leaps overhead and lands as a wall of fire that keeps burning. */
const prominence: MoveDef = {
  id: 'supernova.prominence',
  slot: 'signature',
  name: 'Prominence',
  nameKo: '홍염',
  frame: frame(12, 44, 26, { chargeMax: 60, hitstop: 6 }),
  variants: aims((aim) => {
    const s = AIM_SIGN[aim];
    return {
      hitboxes: [
        hb(
          'arc',
          0,
          12,
          { kind: 'point', ox: 34, oy: -58, r: 16 },
          T,
          200,
          { shock: 0.5, scatter: 1 },
          0,
          { x: 130, y: 0 },
          0.4,
          { sweepTo: { kind: 'point', ox: 188, oy: 8 + s * 62, r: 22 } },
        ),
      ],
      movement: [key(0, -30, 0, 0.2)],
    };
  }),
  resourceCost: 0,
  meterCost: 0,
  tags: ['charge', 'projectile', 'zone'],
  extra: {
    fuel: 12,
    chargePower: 0.8,
    chargeReach: [0.72, 1.45],
    /** The fire wall the arc leaves: a world-fixed vertical line of half-height `half`, hit every `every` ticks for `life` ticks. */
    wall: { half: 52, width: 26, life: 54, every: 4, energy: 30 },
    pose: { startup: { lean: -4 }, charge: { lean: -6 }, active: { lean: 3 } },
  },
};

/** Ultimate — Nova: the star collapses inward, then detonates: two thermal rings that no shell stops. */
const nova: MoveDef = {
  id: 'supernova.nova',
  slot: 'ultimate',
  name: 'Nova',
  nameKo: '노바',
  frame: frame(110, 70, 60, { hitstop: 0 }),
  variants: aims(() => ({
    hitboxes: [
      hb(
        'blast',
        4,
        40,
        { kind: 'ring', ox: 0, oy: 0, r0: 24, r1: 76 },
        T,
        3000,
        { shock: 2.4, scatter: 1.6 },
        UNBLOCK,
        { x: 300, y: -120 },
        1,
        { sweepTo: { kind: 'ring', ox: 0, oy: 0, r0: 170, r1: 230 } },
      ),
      hb(
        'wave',
        30,
        66,
        { kind: 'ring', ox: 0, oy: 0, r0: 120, r1: 170 },
        T,
        2200,
        { shock: 1.8, scatter: 1.4 },
        UNBLOCK,
        { x: 520, y: -140 },
        1,
        { sweepTo: { kind: 'ring', ox: 0, oy: 0, r0: 300, r1: 370 } },
      ),
    ],
    movement: [key(0, 0, 0, 0.05)],
  })),
  resourceCost: 0,
  meterCost: 1,
  tags: ['ultimate', 'armor', 'blast', 'collapse'],
  extra: {
    fuel: 60,
    ctl: { startup: 0.1, active: 0.05, recovery: 0.3 },
    pose: { startup: { lean: -2 }, active: { lean: 0 }, recovery: { lean: 0 } },
  },
};

/** The desperate final nova at zero fuel: never chosen from a button (followUpOnly), started by the behaviour. */
const collapse: MoveDef = {
  id: 'supernova.collapse',
  slot: 'signature',
  name: 'Final Collapse',
  nameKo: '마지막 붕괴',
  frame: frame(96, 70, 100, { hitstop: 0 }),
  variants: aims(() => ({
    hitboxes: [
      hb(
        'final',
        4,
        66,
        { kind: 'ring', ox: 0, oy: 0, r0: 24, r1: 76 },
        T,
        3300,
        { shock: 3, scatter: 2 },
        UNBLOCK,
        { x: 700, y: -170 },
        1,
        { sweepTo: { kind: 'ring', ox: 0, oy: 0, r0: 280, r1: 350 } },
      ),
    ],
    movement: [key(0, 0, 0, 0.05)],
  })),
  resourceCost: 0,
  meterCost: 1,
  tags: ['ultimate', 'armor', 'blast', 'collapse'],
  extra: {
    followUpOnly: true,
    fuel: 0,
    ctl: { startup: 0.05, active: 0.02, recovery: 0.2 },
    pose: { startup: { lean: -2 }, active: { lean: 0 }, recovery: { lean: 0 } },
  },
};

const guard: MoveDef = {
  id: 'supernova.guard',
  slot: 'guard',
  name: 'Plasma Shell',
  nameKo: '플라스마 껍질',
  frame: frame(3, 0, 5, { cancelWindow: 0 }),
  variants: aims(() => ({ hitboxes: [], movement: [] })),
  resourceCost: 0,
  meterCost: 0,
  tags: ['guard'],
  extra: {
    shell: {
      absorb: { FRACTURE: 0.55, KINETIC: 0.5, CRUSH: 0.35, THERMAL: 0.7, TIDAL: 0.05, ASSIMILATION: 0.4 },
    },
  },
};

export const supernova: TitanDef = {
  id: 'supernova',
  name: 'Supernova',
  nameKo: '초신성',
  epithet: 'De Stervende Ster',
  attributes: { mass: 7, cohesion: 3, heat: 10, gravity: 6, reach: 6, tempo: 5 },
  resource: { id: 'fuel', name: 'Core Fuel', nameKo: '핵연료', max: 100, start: 100, display: 'bar' },
  destruction: 'THERMAL',
  passive: {
    name: 'Radiance',
    text: 'The star heats whatever comes near: a faint thermal field, stronger with fuel, warms the enemy cells around it. Blows of heat and force it absorbs are turned back into fuel.',
  },
  failureMode: {
    name: 'Stripped Layers',
    text: 'Heavy damage blows the outer plasma off in sheets and exposes the white-hot core, which then takes far more damage. Fuel burns the star smaller; at zero fuel it collapses into one last nova and fights on as a dim remnant.',
  },
  materials: MATERIALS,
  art: {
    w: 208,
    h: 208,
    coreX: 104,
    coreY: 104,
    coreRadius: 13,
    params: {
      centre: [104, 104],
      radius: 56,
      inner: 37,
      coreR: 19,
      grain: 5.2,
      innerGrain: 11,
      spots: 3,
      gradient: GRADIENT,
      /** [angle, length px, half-width in radians] of the coronal streamers: the equatorial pair and two polar plumes. */
      streamers: [
        [0, 36, 0.36],
        [Math.PI, 33, 0.36],
        [-1.57, 20, 0.22],
        [1.6, 22, 0.23],
      ],
      /** Prominences in the diagonal quadrants: two braided loops and two plumes that hook over (angles in rad, sizes in px). */
      prominences: [
        { kind: 'loop', a0: -1.12, a1: -0.7, h: 30, t: 5 },
        { kind: 'plume', a0: 0.62, a1: 1.02, h: 30, t: 5.4 },
        { kind: 'loop', a0: 2.3, a1: 2.72, h: 26, t: 4.6 },
        { kind: 'plume', a0: -2.4, a1: -2.02, h: 27, t: 5 },
      ],
    },
  },
  moves: [flare, ejection, wind, prominence, nova, collapse, guard],
  ai: {
    style:
      'Bursts, then cools: spends fuel in a flurry of flares and ejections, backs off to recover, and detonates a Nova when the foe is stuck or cornered.',
    weights: {
      aggression: 0.7,
      patience: 0.2,
      zoning: 0.5,
      retreat: 0.55,
      trap: 0.1,
      punish: 0.6,
      gaze: 0.3,
      fuelCare: 0.8,
    },
  },
  ui: { accent: '#ff9a3c', accent2: '#fff0b0', tagline: 'Burn bright. Burn out.' },
};

writeFileSync('src/titans/supernova.json', JSON.stringify(supernova, null, 2) + '\n');
console.log('wrote src/titans/supernova.json');
