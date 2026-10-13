/**
 * THE CRADLE's moves (Gate 2+), written into its kit JSON (src/titans/kit/cradle/cradle.json): the six slots, their frame
 * data (the feel targets), hitboxes and movement. The jaw-organ's hitboxes (ids `jaw…`) ride on the real jaw at the end of
 * the rig chain in the game (CradleBehaviour.attachHitShape); their template positions here are where the jaw arrives, for
 * the AI's model and the threat preview.
 *
 *   npx tsx tools/titans/author/cradle.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { AimDir, MoveDef, TitanDef } from '@/contracts';
import { aims, frame, hb, key, r2 } from './kit';

const PATH = 'src/titans/kit/cradle/cradle.json';
const def = JSON.parse(readFileSync(PATH, 'utf8')) as TitanDef;

const dy = (aim: AimDir, up: number, fwd: number, down: number): number =>
  aim === 'up' ? up : aim === 'down' ? down : fwd;

/** Where the jaw-organ lands when the cord swings out along the aim (measured in the game: tools/titans/cradle-jaw.ts). */
const JAW = {
  lash: { x: { up: 112, forward: 138, down: 104 }, y: { up: -78, forward: 18, down: 112 } },
  hammer: { x: { up: 104, forward: 120, down: 92 }, y: { up: -40, forward: 66, down: 128 } },
};

const moves: MoveDef[] = [
  {
    id: 'cradle.lash',
    slot: 'strike',
    name: 'Cord Lash',
    nameKo: '탯줄 후리기',
    frame: frame(16, 12, 18, { hitstop: 7 }),
    variants: aims((aim) => ({
      hitboxes: [
        hb(
          'jaw',
          0,
          12,
          { kind: 'point', ox: JAW.lash.x[aim], oy: JAW.lash.y[aim], r: 22 },
          'KINETIC',
          430,
          { crater: 8, penetration: 10, scatter: 1 },
          0,
          { x: 300, y: dy(aim, -120, -30, 110) },
          0.35,
        ),
      ],
      movement: [key(0, -60, 0, 0.3), key(14, 160, 0, 0.15)],
    })),
    resourceCost: 0,
    meterCost: 0,
    tags: [],
    extra: { pose: { startup: { lean: -6 }, active: { lean: 5 } }, weight: 'medium' },
  },
  {
    id: 'cradle.contraction',
    slot: 'crush',
    name: 'Contraction',
    nameKo: '수축',
    frame: frame(32, 12, 46, { hitstop: 12 }),
    variants: aims((aim) => ({
      hitboxes: [
        // the disc folds forward and down over whatever is in front of it
        hb(
          'fold',
          0,
          6,
          { kind: 'point', ox: 78, oy: dy(aim, -46, -12, 30), r: 60 },
          'CRUSH',
          820,
          { crater: 16, penetration: 12, scatter: 0.8 },
          0,
          { x: 520, y: dy(aim, -160, 40, 200) },
          1,
        ),
        // and the jaw-organ hammers up from under it
        hb(
          'jaw-hammer',
          3,
          12,
          { kind: 'point', ox: JAW.hammer.x[aim], oy: JAW.hammer.y[aim], r: 26 },
          'CRUSH',
          640,
          { crater: 14, penetration: 16, scatter: 1 },
          0,
          { x: 420, y: dy(aim, -260, -180, 60) },
          0.8,
        ),
      ],
      movement: [key(0, -110, 0, 0.3), key(32, 520, dy(aim, -90, 0, 90), 0.06)],
    })),
    resourceCost: 0,
    meterCost: 0,
    tags: ['heavy'],
    extra: { pose: { startup: { lean: -10 }, active: { lean: 12 }, recovery: { lean: 4 } }, weight: 'heavy' },
  },
  {
    id: 'cradle.billow',
    slot: 'surge',
    name: 'Billow',
    nameKo: '부풂',
    frame: frame(3, 12, 11, { cancelWindow: 0 }),
    variants: aims(() => ({ hitboxes: [], movement: [key(0, 760, 0, 0.05)] })),
    resourceCost: 0,
    meterCost: 0,
    intangible: [2, 9],
    tags: ['dash'],
    extra: {},
  },
  {
    id: 'cradle.implant',
    slot: 'signature',
    name: 'Implant',
    nameKo: '착상',
    frame: frame(18, 14, 26, { hitstop: 4 }),
    variants: aims((aim) => ({
      hitboxes: [
        // vascular filaments shoot from the disc's rim and take hold
        hb(
          'filament',
          0,
          10,
          {
            kind: 'line',
            ox0: 30,
            oy0: dy(aim, -30, -10, 10),
            ox1: 196,
            oy1: dy(aim, -110, -10, 90),
            width: 18,
          },
          'KINETIC',
          170,
          { crater: 3, penetration: 4, scatter: 0.4 },
          0,
          { x: -60, y: 0 },
          0.3,
        ),
      ],
      movement: [key(0, 0, 0, 0.2)],
    })),
    resourceCost: 0,
    meterCost: 0,
    tags: ['burst'],
    extra: { pose: { startup: { lean: -4 }, active: { lean: 3 } }, weight: 'light' },
  },
  {
    id: 'cradle.falsebirth',
    slot: 'ultimate',
    name: 'False Birth',
    nameKo: '거짓 출산',
    frame: frame(70, 110, 60, { cancelWindow: 0 }),
    variants: aims((aim) => ({
      hitboxes: [
        // the spread disc's filaments lock on and the membrane closes round the foe (a hold, many small bites)
        hb(
          'grip',
          0,
          70,
          { kind: 'point', ox: 120, oy: dy(aim, -40, 0, 40), r: 70 },
          'CRUSH',
          1,
          { crater: 0.5, penetration: 0.5, scatter: 0 },
          16,
          { x: -30, y: 0 },
          0.2,
          { rehit: 7 },
        ),
        // the membrane throws open: the birth
        hb(
          'birth',
          72,
          82,
          { kind: 'point', ox: 120, oy: dy(aim, -40, 0, 40), r: 48 },
          'CRUSH',
          560,
          { crater: 16, penetration: 16, scatter: 1.4 },
          8,
          { x: 900, y: dy(aim, -200, -120, 160) },
          1,
        ),
      ],
      movement: [key(0, 0, 0, 0.05)],
    })),
    resourceCost: 0,
    meterCost: 1,
    tags: ['ultimate', 'armor'],
    extra: { pose: { startup: { lean: -6 }, active: { lean: 4 } }, weight: 'catastrophic' },
  },
  {
    id: 'cradle.enfold',
    slot: 'guard',
    name: 'Enfold',
    nameKo: '감싸기',
    frame: frame(4, 0, 6, { cancelWindow: 0 }),
    variants: aims(() => ({ hitboxes: [], movement: [] })),
    resourceCost: 0,
    meterCost: 0,
    tags: ['guard'],
    extra: {
      shell: {
        absorb: { KINETIC: 0.7, CRUSH: 0.6, FRACTURE: 0.45, THERMAL: 0.2, TIDAL: 0.3, ASSIMILATION: 0.5 },
      },
    },
  },
];

def.moves = moves;
def.epithet = 'The Organ Before';
def.destruction = 'CRUSH';
def.resource = {
  id: 'fragments',
  name: 'Cord',
  nameKo: '탯줄',
  max: 7,
  start: 7,
  display: 'pips',
} as TitanDef['resource'];
def.passive = {
  name: 'Gestation',
  text: 'Whatever it touches starts developing: its blows grow capillary webs, cartilage ridges and swollen organ-masses into the foe’s own matter, and that tissue is soft.',
};
def.failureMode = {
  name: 'Differentiation failure',
  text: 'As it is hurt its tissues forget what they are: membrane calcifies, sacs grow where the spokes were, a cut cord grows back as bone. It does not weaken; it stops knowing what creature it is.',
};
def.attributes = { mass: 7, cohesion: 5, heat: 4, gravity: 3, reach: 7, tempo: 4 };
def.ai = {
  style:
    'Keeps the foe at the length of its cord: lashes and hammers with the jaw-organ, implants from range, enfolds when pressed.',
  weights: { aggression: 0.5, patience: 0.5, zoning: 0.55, retreat: 0.35, trap: 0.25, punish: 0.6, gaze: 0 },
};
const withFeel = def as TitanDef & { feel: Record<string, unknown> };
withFeel.feel = { ...withFeel.feel, bob: { amp: 1.1, period: 4.4 }, sway: { amp: 0.8, period: 5.6 } };
writeFileSync(PATH, JSON.stringify(def, null, 2) + '\n');
console.log(`${PATH}: ${moves.length} moves (${moves.map((m) => m.id).join(', ')})`);
void r2;
