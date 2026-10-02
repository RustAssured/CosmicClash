/**
 * Authoring script for `src/titans/planet.json` (see supernova.ts for the workflow):
 *   npx tsx tools/titans/author/planet.ts && npx prettier --write src/titans/planet.json
 *
 * Two blocks of the JSON are owned elsewhere and are carried over from the file on disk instead of being authored here:
 *  - `balance` (written by tools/ai/autotune.ts),
 *  - the `planet.impact` move (its root motion and choreography belong to the combat owner, SLICE_PLAN §6); the fallback
 *    below is only used when the file has no such move.
 * Everything else here is the source of truth and matches the JSON exactly (energies after the global balance pass).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DamageFlag, type MaterialSpec, type MoveDef, type TitanDef } from '@/contracts';
import { AIM_ANGLE, AIM_SIGN, aims, frame, hb, key } from './kit';

const PATH = 'src/titans/planet.json';

const vis = (ramp: string[], emissive: number, crack: string, char = '#1a1012', debris?: string) => ({
  ramp,
  emissive,
  char,
  crack,
  ...(debris ? { debris } : {}),
});

const MATERIALS: MaterialSpec[] = [
  {
    key: 'atmosphere',
    base: 'gas',
    visual: vis(
      ['#16305a', '#24508c', '#3a7bc0', '#69b0e0', '#a8dcf2', '#e4f8ff'],
      40,
      '#0a1a3a',
      '#1a2a4a',
      '#69b0e0',
    ),
  },
  {
    key: 'cloud',
    base: 'cloud',
    visual: vis(
      ['#2b3c66', '#4f6494', '#8497be', '#bccbe0', '#e6eef6', '#ffffff'],
      20,
      '#2b3c66',
      '#3a4560',
      '#e6eef6',
    ),
  },
  {
    key: 'ocean',
    base: 'ocean',
    visual: vis(
      ['#08183c', '#0d2a64', '#123f8f', '#1a5cb8', '#2e86d8', '#62b8ec', '#b6e8fa'],
      0,
      '#04102a',
      '#0a1a38',
      '#2e86d8',
    ),
  },
  {
    key: 'forest',
    base: 'regolith',
    visual: vis(
      ['#14241a', '#243c22', '#3b5c2a', '#5d7e34', '#88a044', '#b4be5c', '#dcdc8a'],
      0,
      '#0c160e',
      '#1a1a10',
      '#5d7e34',
    ),
  },
  {
    key: 'desert',
    base: 'regolith',
    visual: vis(
      ['#2a1a18', '#4c3024', '#7a4c30', '#a8703c', '#cf9a52', '#e8c27a', '#f8e4b0'],
      0,
      '#1a0e0c',
      '#2a1a14',
      '#cf9a52',
    ),
  },
  {
    key: 'mountain',
    base: 'rock',
    visual: vis(
      ['#241c22', '#3d3038', '#5f4d4c', '#8a7466', '#b39c88', '#dccbb8', '#f4eee8'],
      0,
      '#120c10',
      '#1a1414',
      '#8a7466',
    ),
  },
  {
    key: 'ice',
    base: 'ice',
    visual: vis(
      ['#284a72', '#4a7fb0', '#86bde0', '#bfe4f4', '#e8f8ff', '#ffffff'],
      30,
      '#183050',
      '#284a72',
      '#bfe4f4',
    ),
  },
  {
    key: 'crust',
    base: 'rock',
    visual: vis(
      ['#1a1216', '#33242a', '#4f3a38', '#725248', '#97705a', '#bc9070'],
      0,
      '#0a0608',
      '#1a1214',
      '#725248',
    ),
  },
  {
    key: 'mantle',
    base: 'mantle',
    visual: {
      ...vis(
        ['#2a0a10', '#5a1418', '#8c2a1a', '#c0481c', '#e8741e', '#ff9a30'],
        40,
        '#ffb040',
        '#3a0c10',
        '#c0481c',
      ),
      glowRamp: ['#c0481c', '#ff9a30', '#ffe080', '#ffffff'],
    },
  },
  {
    key: 'magma',
    base: 'magma',
    visual: {
      ...vis(
        ['#7a1608', '#c03a10', '#f0701c', '#ffa838', '#ffd870', '#fff2b0'],
        170,
        '#ffe080',
        '#5a1006',
        '#f0701c',
      ),
      glowRamp: ['#f0701c', '#ffd870', '#fff2b0', '#ffffff'],
    },
  },
  {
    key: 'core',
    base: 'core',
    visual: {
      ...vis(['#ffb84a', '#ffdc78', '#fff2b0', '#ffffff'], 235, '#ffffff', '#7a3a10', '#ffdc78'),
      glowRamp: ['#ffdc78', '#fff2b0', '#ffffff', '#ffffff'],
    },
  },
];

/**
 * A living world is not armour: its shell (surface → mantle) takes a little more from a blow than the bare archetype would.
 * Calibrated for the slice (SLICE_PLAN §3 D1): at the old ×4 every cell cost ~0.18 energy, so any heavy blow saturated the
 * crater search and the whole bowl left as powder in one tick.
 */
const SHELL_RESIST = { CRUSH: 1.4, KINETIC: 1.4, FRACTURE: 1.4, THERMAL: 1.2 };
const SOFTEN = ['forest', 'desert', 'mountain', 'ice', 'crust', 'mantle', 'ocean', 'atmosphere', 'cloud'];
const SOAK = ['ocean', 'atmosphere', 'cloud'];
/** A planet is lighter per cell than bare rock (it is mostly a thin painted shell over a hot interior): mass per cell by layer. */
const DENSITY: Record<string, number> = {
  ocean: 0.6,
  forest: 0.5,
  desert: 0.5,
  mountain: 0.6,
  ice: 0.4,
  crust: 0.6,
  mantle: 0.5,
  magma: 0.5,
  core: 0.8,
};
for (const mat of MATERIALS) {
  const physics: NonNullable<MaterialSpec['physics']> = {};
  // the air and the seas are the world's heat shield (the focused core of a THERMAL blow ignores them; this is the rest): at the
  // calibrated shell resist a stripped world loses ~17% more to the same burst (planet.test.ts), at 0.4 it lost none more
  if (SOAK.includes(mat.key)) physics.heatAbsorb = 0.6;
  if (SOFTEN.includes(mat.key)) physics.resist = { ...SHELL_RESIST };
  if (DENSITY[mat.key] !== undefined) physics.density = DENSITY[mat.key]!;
  if (Object.keys(physics).length > 0) mat.physics = physics;
}

const moonMats = (rock: string[], dust: string[], dark: string[]): MaterialSpec[] => [
  { key: 'moonrock', base: 'rock', visual: vis(rock, 0, '#0c0a0e', '#1a1616', rock[3]) },
  { key: 'moondust', base: 'regolith', visual: vis(dust, 0, '#0c0a0e', '#1a1616', dust[3]) },
  { key: 'moondark', base: 'mantle', visual: vis(dark, 0, '#08060a', '#141012', dark[3]) },
];

const C = 'CRUSH' as const;
const UNBLOCK = DamageFlag.UNBLOCKABLE;
const CONT = DamageFlag.CONTINUOUS;
/** A world does not shear: every phase of every Planet move holds the body upright (the fighter's default lean is overridden). */
const RIGID = { startup: { lean: 0 }, charge: { lean: 0 }, active: { lean: 0 }, recovery: { lean: 0 } };

/** Fallback only: the live block is carried over from the JSON (combat owns its choreography). This is TIDAL RUSH (Crush). */
const impactFallback: MoveDef = {
  id: 'planet.impact',
  slot: 'crush',
  name: 'Tidal Rush',
  nameKo: '조석 돌진',
  frame: frame(34, 8, 56, { hitstop: 12 }),
  variants: aims((aim) => {
    const s = AIM_SIGN[aim];
    return {
      hitboxes: [
        hb(
          'slam',
          0,
          8,
          { kind: 'point', ox: 96, oy: s * 34, r: 44 },
          C,
          700,
          { crater: 17.6, compress: 8, shock: 1.12, scatter: 1.2 },
          0,
          { x: 760, y: s * 120 - 60 },
          1,
        ),
      ],
      movement: [key(0, -70, 20, 0.04), key(26, 560, s * 40 - 24, 0.06), key(46, -150, 16, 0.1)],
    };
  }),
  resourceCost: 0,
  meterCost: 0,
  tags: ['heavy', 'ram', 'quake'],
  extra: { pose: RIGID },
};

/**
 * ORBITAL DRIFT (Surge): a curved momentum shift. The movement key is the push; the behaviour bends the path around the foe
 * (`extra.drift.curve`, px/s² perpendicular to the push, ramped in and out) and builds spin (`extra.drift.spin`, rad/s).
 */
const shift: MoveDef = {
  id: 'planet.shift',
  slot: 'surge',
  name: 'Orbital Drift',
  nameKo: '궤도 표류',
  frame: frame(3, 16, 9, { cancelWindow: 0 }),
  variants: aims(() => ({ hitboxes: [], movement: [key(0, 430, 0, 0.04)] })),
  resourceCost: 0,
  meterCost: 0,
  intangible: [2, 16],
  tags: ['dash', 'orbit'],
  extra: { drift: { curve: 760, spin: 1.2 } },
};

/**
 * MOON SLAM (Strike): a moon is redirected into a delayed kinetic strike. On release the chosen moon whips round its orbit
 * (`windup` ticks), leaves on its tangent and curves onto the foe: up/down aim bends the path over or under, neutral comes
 * straight; it accelerates (`accel` px/tick²) up to `speed`. The `launch` hitbox is the world's own tidal shove, which is all a
 * moonless Planet has. A moon below `breakFrac` of its mass shatters on impact and its fragments carry on at the foe.
 */
const slam: MoveDef = {
  id: 'planet.moonslam',
  slot: 'strike',
  name: 'Moon Slam',
  nameKo: '달 충돌',
  frame: frame(12, 8, 22, { chargeMax: 30, hitstop: 8 }),
  variants: aims(() => ({
    hitboxes: [
      hb(
        'launch',
        0,
        6,
        { kind: 'point', ox: 76, oy: 0, r: 20 },
        C,
        84,
        { crater: 4 },
        0,
        { x: 200, y: 0 },
        0.3,
      ),
    ],
    movement: [key(0, -40, 0, 0.2)],
  })),
  resourceCost: 0,
  meterCost: 0,
  tags: ['charge', 'projectile', 'moon'],
  extra: {
    chargePower: 0.9,
    chargeReach: [0.8, 1.35],
    /** Energy (× charge power) as CRUSH with a crater; recoil is the share of the energy the moon itself takes. */
    slam: {
      speed: 9,
      accel: 0.45,
      windup: 14,
      turn: 0.1,
      curve: 0.9,
      energy: 430,
      crater: 14,
      compress: 8,
      shock: 1.2,
      recoil: 0.14,
      life: 70,
      breakFrac: 0.55,
    },
    ctl: { charge: 0.2, active: 0.25 },
    pose: RIGID,
  },
};

/**
 * COMET SHEPHERD → SLINGSHOT (Signature, hold). Holding takes a free arena comet within reach, or calls one in from the far edge
 * (a `mass` nucleus at `entrySpeed` px/s): the deepened well bends its path, it is captured into the ring at `orbit` px and spun up
 * there (from `w0` toward `w1` rad/s, +`spinUp`/s); releasing throws it where its orbit points at the foe. The blow is the matter
 * world's, sized so its energy is `energy` at an orbit speed of `vRef` px/s (∝ speed²). A comet never caught is let go as debris
 * (after `life` ticks in flight the throw is spent). The `tug` hitbox is the release's gravity tug.
 */
const comet: MoveDef = {
  id: 'planet.comet',
  slot: 'signature',
  name: 'Comet Shepherd',
  nameKo: '혜성 목자',
  frame: frame(8, 10, 24, { chargeMax: 150 }),
  variants: aims(() => ({
    hitboxes: [
      hb(
        'tug',
        0,
        8,
        { kind: 'field', ox: 70, oy: 0, r: 60, falloff: 1.5 },
        C,
        40,
        { compress: 2, crater: 3 },
        0,
        { x: -160, y: 0 },
        0.2,
      ),
    ],
    movement: [],
  })),
  resourceCost: 0,
  meterCost: 0,
  tags: ['charge', 'projectile', 'comet'],
  extra: {
    comet: {
      spawnDist: 330,
      spawnRise: 150,
      entrySpeed: 260,
      orbit: 150,
      w0: 1.4,
      w1: 5.2,
      spinUp: 2.2,
      vRef: 620,
      energy: 720,
      life: 110,
      mass: 13.5,
    },
    ctl: { charge: 0.35 },
    pose: RIGID,
  },
};

/**
 * The Crush-held phase moves: they are not on a button of their own (`followUpOnly`); holding Crush through the first ticks of
 * Tidal Rush turns it into the move the world's damage phase allows (src/combat/behaviours/planet.ts `holdCrush`):
 * phases 1–2 CRUST BREAKER, phase 3 MAGMA VENT, phase 4 CORE PULSE (if the meter is full; else Magma Vent).
 */
const crustbreaker: MoveDef = {
  id: 'planet.crustbreaker',
  slot: 'crush',
  name: 'Crust Breaker',
  nameKo: '지각 파괴',
  frame: frame(26, 14, 52, { hitstop: 10 }),
  variants: aims(() => ({
    hitboxes: [
      hb(
        'tectonic',
        0,
        14,
        { kind: 'ring', ox: 0, oy: 0, r0: 50, r1: 78 },
        C,
        560,
        { crater: 12, compress: 7, shock: 2, scatter: 1.4 },
        0,
        { x: 520, y: -60 },
        0.9,
        { sweepTo: { kind: 'ring', ox: 0, oy: 0, r0: 140, r1: 176 } },
      ),
    ],
    movement: [key(0, -30, 0, 0.1)],
  })),
  resourceCost: 0,
  meterCost: 0,
  tags: ['heavy', 'quake', 'phase'],
  extra: { followUpOnly: true, pose: RIGID },
};

const magmavent: MoveDef = {
  id: 'planet.magmavent',
  slot: 'crush',
  name: 'Magma Vent',
  nameKo: '마그마 분출',
  frame: frame(24, 30, 40),
  variants: aims((aim) => ({
    hitboxes: [
      hb(
        'vent',
        0,
        30,
        { kind: 'cone', ox: 40, oy: 0, angle: AIM_ANGLE[aim], range: 210, halfAngle: 0.26 },
        'THERMAL',
        46,
        { shock: 0.6 },
        CONT,
        { x: 140, y: 0 },
        0.5,
        { rehit: 3 },
      ),
    ],
    movement: [key(0, -60, 0, 0.08)],
  })),
  resourceCost: 0,
  meterCost: 0,
  tags: ['heavy', 'thermal', 'phase'],
  extra: { followUpOnly: true, pose: RIGID, vent: { shed: 0.004 } },
};

const corepulse: MoveDef = {
  id: 'planet.corepulse',
  slot: 'crush',
  name: 'Core Pulse',
  nameKo: '핵 맥동',
  frame: frame(36, 24, 56, { hitstop: 13 }),
  variants: aims(() => ({
    hitboxes: [
      hb(
        'pulse',
        0,
        24,
        { kind: 'ring', ox: 0, oy: 0, r0: 40, r1: 80 },
        C,
        1500,
        { crater: 22, compress: 10, shock: 2.4, scatter: 2 },
        UNBLOCK,
        { x: 680, y: -120 },
        1,
        { sweepTo: { kind: 'ring', ox: 0, oy: 0, r0: 200, r1: 236 } },
      ),
    ],
    movement: [key(0, 0, 0, 0.05)],
  })),
  resourceCost: 0,
  meterCost: 1,
  tags: ['heavy', 'quake', 'phase', 'armor'],
  extra: { followUpOnly: true, pose: RIGID, pulse: { shed: 0.03 } },
};

const cataclysm: MoveDef = {
  id: 'planet.cataclysm',
  slot: 'ultimate',
  name: 'Cataclysm',
  nameKo: '대격변',
  frame: frame(90, 100, 50),
  variants: aims(() => ({
    hitboxes: [
      hb(
        'gravity',
        0,
        50,
        { kind: 'field', ox: 150, oy: 0, r: 100, falloff: 1.5 },
        C,
        14,
        { compress: 3.2, crater: 4.8 },
        CONT,
        { x: -70, y: 0 },
        0.2,
        { rehit: 2 },
      ),
      hb(
        'quake',
        52,
        62,
        { kind: 'point', ox: 140, oy: 0, r: 64 },
        C,
        1400,
        { crater: 25.6, compress: 11.2, shock: 1.76, scatter: 1.6 },
        UNBLOCK,
        { x: 500, y: -160 },
        1,
      ),
    ],
    movement: [key(0, 0, 0, 0.05)],
  })),
  resourceCost: 0,
  meterCost: 1,
  tags: ['ultimate', 'armor', 'quake', 'moon'],
  extra: {
    /** After the quake each surviving moon is flung at the foe in turn: ticks after the quake between launches. */
    barrage: { from: 66, gap: 10, speed: 11, energy: 520, crater: 14, compress: 7, shock: 1 },
    ctl: { startup: 0.1, active: 0.05, recovery: 0.3 },
    pose: RIGID,
  },
};

/**
 * ROTATIONAL BRACE (Guard): the shell absorbs as the old atmosphere shield did; raising it turns the more intact face toward the
 * foe, and the guard's strength follows the integrity of the face that takes the blows (behaviour `guardMultiplier`).
 */
const guard: MoveDef = {
  id: 'planet.guard',
  slot: 'guard',
  name: 'Rotational Brace',
  nameKo: '회전 방어',
  frame: frame(3, 0, 5, { cancelWindow: 0 }),
  variants: aims(() => ({ hitboxes: [], movement: [] })),
  resourceCost: 0,
  meterCost: 0,
  tags: ['guard'],
  extra: {
    shell: {
      absorb: { THERMAL: 0.8, KINETIC: 0.55, CRUSH: 0.35, FRACTURE: 0.5, TIDAL: 0.15, ASSIMILATION: 0.4 },
    },
  },
};

/** Blocks owned by other tools/specialists, read back from the file on disk. */
const onDisk = existsSync(PATH)
  ? (JSON.parse(readFileSync(PATH, 'utf8')) as { moves?: MoveDef[]; balance?: unknown })
  : {};
const impact = onDisk.moves?.find((m) => m.id === 'planet.impact') ?? impactFallback;

export const planet: TitanDef = {
  id: 'planet',
  name: 'Planet',
  nameKo: '행성',
  epithet: 'De Wereld',
  attributes: { mass: 8, cohesion: 7, heat: 6, gravity: 7, reach: 6, tempo: 3 },
  resource: { id: 'moons', name: 'Moons', nameKo: '달', max: 2, start: 2, display: 'pips' },
  destruction: 'CRUSH',
  passive: {
    name: 'Gravity Well',
    text: 'A gravity well gathers debris into a slow ring. Hold Gravity (R1) for Tidal Draw: the well deepens and drawn debris is packed back onto the world as crust.',
  },
  failureMode: {
    name: 'Broken World',
    text: 'Intact, fractured crust, exposed mantle (Magma Vent), core crisis (Core Pulse): hits harder, braces worse. At the end the air vents, moons drift off, the crust slabs away, the core goes out last.',
  },
  materials: MATERIALS,
  art: {
    w: 208,
    h: 208,
    coreX: 104,
    coreY: 104,
    coreRadius: 13,
    params: {
      radius: 54,
      atmo: 8,
      surface: 5.5,
      crust: 11,
      magmaR: 27,
      coreR: 13,
      tilt: -0.4,
      sea: 0.06,
      moons: [
        {
          r: 15,
          a: 120,
          b: 32,
          tilt: -0.12,
          period: 430,
          phase: 0.6,
          crater: 8,
          lumpy: 0.2,
          materials: moonMats(
            ['#1c1a24', '#38343f', '#5a5560', '#84808a', '#b0aab0', '#dcd6d4', '#f4f0ec'],
            ['#2a2428', '#4a4046', '#74666a', '#a08e8c', '#c8b8ae', '#e6d8cc'],
            ['#0e0c14', '#1c1a26', '#2c2a38', '#403e50', '#5c5a6c'],
          ),
        },
        {
          r: 11,
          a: 100,
          b: 26,
          tilt: 0.22,
          period: 300,
          phase: 3.7,
          crater: 5,
          lumpy: 0.7,
          materials: moonMats(
            ['#2a1410', '#54281c', '#84402a', '#b0603a', '#d4844c', '#eeac72', '#fbd6a4'],
            ['#3a1c14', '#683424', '#9a5636', '#c47a4c', '#e2a06c', '#f6c894'],
            ['#1c0c0a', '#341812', '#4c261c', '#683828', '#8a4c34'],
          ),
        },
      ],
      /** The comet nucleus the Comet Shepherd calls in (src/titans/art/comet.ts). */
      comet: {
        r: 11,
        elong: 1.7,
        pits: 5,
        lobes: 0.4,
        materials: [
          {
            key: 'cometice',
            base: 'ice',
            visual: vis(
              ['#2a4c74', '#4c84b4', '#8cc4e4', '#c4ecf8', '#f0fcff'],
              40,
              '#183050',
              '#1a2a3a',
              '#8cc4e4',
            ),
          },
          {
            key: 'cometdust',
            base: 'regolith',
            visual: vis(
              ['#141216', '#26222a', '#3c363e', '#565058', '#746c72', '#948a8c'],
              0,
              '#0a0a0c',
              '#100e10',
              '#565058',
            ),
          },
          {
            key: 'cometrock',
            base: 'rock',
            visual: vis(
              ['#1a1820', '#2e2a34', '#46404a', '#625a62', '#827880'],
              0,
              '#0a080c',
              '#121014',
              '#46404a',
            ),
          },
        ],
      },
    },
  },
  moves: [slam, impact, shift, comet, cataclysm, guard, crustbreaker, magmavent, corepulse],
  ai: {
    style:
      'Fortress: sits back behind its moons, punishes with Impact and Moon Slam, and uses its weight to hold the space.',
    weights: {
      aggression: 0.3,
      patience: 0.8,
      zoning: 0.75,
      retreat: 0.35,
      trap: 0.3,
      punish: 0.85,
      gaze: 0.6,
      reserve: 1,
    },
  },
  ui: { accent: '#58a6d8', accent2: '#e0b06a', tagline: 'All things fall toward me.' },
};

/**
 * A world neither shears nor recoils like a creature: no row-shear lean of any kind and no lean kick when hit; its angular state
 * spins freely (no restoring spring) with no drag of its own, because the behaviour owns the spin (its day rate, commitment spin-up
 * and overshoot) and only folds in the impulse the impact model adds (src/combat/behaviours/planet.ts `stepSpin`).
 */
const feel = { recoil: 0, shear: 0, angular: { omega: 0, dragTau: 1000, maxSpin: 6 } };

const out = {
  ...planet,
  feel,
  ...(onDisk.balance !== undefined ? { balance: onDisk.balance } : {}),
};
writeFileSync(PATH, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${PATH}`);
