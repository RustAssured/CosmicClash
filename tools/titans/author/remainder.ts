/**
 * THE REMAINDER's moves, written into its kit JSON (src/titans/kit/remainder/remainder.json): the six slots, frame data
 * (the feel targets), hitboxes, movement, its resource (Mass), passive (Hoard) and failure mode (Cannibal). The behaviour
 * that makes them its own is src/combat/behaviours/kit/remainder.ts; the design is docs/titans/remainder/BRIEF.md.
 *
 * The idea: a rigid shell with violence inside. The body never swings: every attack erupts out of the vortex (a whip that
 * snaps out and recoils, an inhalation that yanks the foe in and a rim that bites, a fold into its own eye), so the shell
 * stays still and space moves.
 *
 *   npx tsx tools/titans/author/remainder.ts && npx prettier --write src/titans/kit/remainder/remainder.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DamageFlag, type AimDir, type MoveDef, type TitanDef } from '@/contracts';
import { aims, frame, hb, key } from './kit';

const PATH = 'src/titans/kit/remainder/remainder.json';
const BALANCE = { power: 0.72, durability: 0.75 };
const def = JSON.parse(readFileSync(PATH, 'utf8')) as TitanDef;

const dy = (aim: AimDir, up: number, fwd: number, down: number): number =>
  aim === 'up' ? up : aim === 'down' ? down : fwd;

/** Where the vortex's rim meets the front of the shell (px from the core, facing right): attacks erupt from here. */
const RIM = 58;

const moves: MoveDef[] = [
  {
    // a whip of vortex matter cracks out of the eye, tears pixels off the foe and drags them back in
    id: 'remainder.snap',
    slot: 'strike',
    name: 'Snap',
    nameKo: '낚아채기',
    frame: frame(9, 4, 26, { hitstop: 6 }),
    variants: aims((aim) => ({
      hitboxes: [
        hb(
          'lash',
          0,
          4,
          { kind: 'line', ox0: RIM, oy0: 0, ox1: 166, oy1: dy(aim, -96, -4, 88), width: 14 },
          'TIDAL',
          1400,
          { pull: 1.3 },
          0,
          { x: -110, y: dy(aim, 40, 0, -40) },
          0.15,
        ),
        // the tip grabs: a wider bite of the foe torn loose and dragged back along the whip
        hb(
          'grab',
          1,
          4,
          { kind: 'field', ox: 156, oy: dy(aim, -88, -4, 80), r: 34, falloff: 0.5 },
          'TIDAL',
          3800,
          { pull: 1.5 },
          0,
          { x: -80, y: 0 },
          0.15,
        ),
        hb(
          'crack',
          1,
          4,
          { kind: 'point', ox: 162, oy: dy(aim, -92, -4, 84), r: 18 },
          'KINETIC',
          320,
          { crater: 7, penetration: 8 },
          0,
          { x: -60, y: 0 },
          0.15,
        ),
      ],
    })),
    resourceCost: 0,
    meterCost: 0,
    tags: [],
    // meterGain: its TIDAL energies are large (TIDAL tears little per unit); unscaled, one grab filled half the meter
    extra: {
      noCredit: true,
      weight: 'light',
      meterGain: 0.15,
      pose: { startup: { lean: 0 }, active: { lean: 0 } },
    },
  },
  {
    // the vortex spins up and darkens (the tell), inhales the foe in a violent yank, and the rim bites shut on it
    id: 'remainder.inhale',
    slot: 'crush',
    name: 'Inhale',
    nameKo: '들이킴',
    frame: frame(28, 12, 50, { hitstop: 12 }),
    variants: aims((aim) => ({
      hitboxes: [
        hb(
          'inhale',
          0,
          8,
          { kind: 'field', ox: 130, oy: dy(aim, -36, 0, 36), r: 120, falloff: 0.4 },
          'TIDAL',
          5200,
          { pull: 1.8 },
          0,
          { x: -460, y: dy(aim, 60, 0, -60) },
          0.45,
        ),
        hb(
          'bite',
          7,
          12,
          { kind: 'point', ox: RIM + 32, oy: dy(aim, -44, 0, 44), r: 46 },
          'CRUSH',
          900,
          { crater: 14, penetration: 10, scatter: 0.6 },
          0,
          { x: 300, y: dy(aim, -120, -20, 140) },
          0.9,
        ),
      ],
    })),
    resourceCost: 0,
    meterCost: 0,
    tags: ['heavy'],
    extra: {
      noCredit: true,
      weight: 'heavy',
      meterGain: 0.2,
      pose: { startup: { lean: 0 }, active: { lean: 0 } },
      // the yank: the foe's velocity is pulled toward the eye while the intake runs (behaviour), debris with it
      inhale: { radius: 280, pullFoe: 1100, strength: 2600, ticks: 8 },
    },
  },
  {
    // it drains into its own eye and unfolds out of a tear in space elsewhere: untouchable while folded
    id: 'remainder.fold',
    slot: 'surge',
    name: 'Fold',
    nameKo: '접힘',
    frame: frame(4, 14, 16, { cancelWindow: 0 }),
    variants: aims(() => ({ hitboxes: [], movement: [key(0, 1100, 0, 0.002)] })),
    resourceCost: 0,
    meterCost: 0,
    intangible: [2, 16],
    tags: ['dash'],
    extra: { fold: true },
  },
  {
    // hold: the vortex crushes stolen mass into a slug; forward / up fires it as real matter, down grinds it into plates
    id: 'remainder.compaction',
    slot: 'signature',
    name: 'Compaction',
    nameKo: '압축',
    frame: frame(14, 6, 26, { chargeMax: 60, hitstop: 4 }),
    variants: aims((aim) => ({
      hitboxes:
        aim === 'down'
          ? [
              // the plates grind out over the shell and shove whatever is close away
              hb(
                'grind',
                0,
                6,
                { kind: 'ring', ox: 0, oy: 0, r0: 64, r1: 112 },
                'KINETIC',
                180,
                { crater: 4 },
                0,
                { x: 320, y: -40 },
                0.3,
              ),
            ]
          : [
              // the slug leaves the eye with a blast (the slug itself is a launched chunk of matter: the behaviour)
              hb(
                'muzzle',
                0,
                4,
                { kind: 'point', ox: RIM + 40, oy: dy(aim, -46, 0, 0), r: 22 },
                'KINETIC',
                160,
                { crater: 4 },
                0,
                { x: 160, y: dy(aim, -60, 0, 0) },
                0.2,
              ),
            ],
    })),
    resourceCost: 1,
    meterCost: 0,
    tags: ['charge', 'projectile'],
    extra: {
      noCredit: true,
      weight: 'medium',
      chargePower: 0.6,
      pose: { startup: { lean: 0 }, active: { lean: 0 } },
      compaction: { speed: 560, size: [9, 15], pips: [1, 3], plateCells: 34, slugMass: 9 },
      // the AI's model of the slug (the muzzle blast is all the JSON describes): ~10 px a tick for about 40 ticks
      aiReach: {
        forward: {
          x0: 60,
          y0: -32,
          x1: 470,
          y1: 32,
          from: 0,
          to: 40,
          energy: 900,
          projectile: true,
          replace: true,
        },
        up: {
          x0: 40,
          y0: -330,
          x1: 340,
          y1: -10,
          from: 0,
          to: 40,
          energy: 900,
          projectile: true,
          replace: true,
        },
      },
    },
  },
  {
    // it lets go: the wound tears open across the body, drags the foe and the debris in, shreds what reaches the eye, then
    // snaps shut with a shockwave. While it is open its core is exposed (the behaviour doubles what reaches it).
    id: 'remainder.loosening',
    slot: 'ultimate',
    name: 'Loosening',
    nameKo: '풀림',
    frame: frame(40, 150, 50),
    variants: aims(() => ({
      hitboxes: [
        hb(
          'tear',
          0,
          140,
          { kind: 'field', ox: 40, oy: 0, r: 240, falloff: 0.35 },
          'TIDAL',
          12,
          { pull: 2 },
          DamageFlag.CONTINUOUS,
          { x: -50, y: 0 },
          0.1,
          { rehit: 3 },
        ),
        hb(
          'maw',
          0,
          140,
          { kind: 'field', ox: 0, oy: 0, r: 76, falloff: 0.6 },
          'TIDAL',
          22,
          { pull: 2.4 },
          DamageFlag.CONTINUOUS,
          { x: -20, y: 0 },
          0.2,
          { rehit: 5 },
        ),
        hb(
          'snap',
          140,
          150,
          { kind: 'ring', ox: 0, oy: 0, r0: 30, r1: 250 },
          'KINETIC',
          1500,
          { crater: 10, penetration: 8 },
          0,
          { x: 950, y: -120 },
          1,
        ),
      ],
    })),
    resourceCost: 0,
    meterCost: 1,
    tags: ['ultimate'],
    extra: {
      noCredit: true,
      weight: 'heavy',
      pose: { startup: { lean: 0 }, active: { lean: 0 } },
      ctl: { startup: 0.1, active: 0.15, recovery: 0.3 },
      // the ultimate does not refill its own meter
      meterGain: 0,
      well: { radius: [200, 300], strength: [1800, 3400], consume: 34, pullFoe: 360 },
      exposedCore: 1,
    },
  },
  {
    // the wound forces itself shut: the eye closes, the vortex stalls, the bone plates grind together
    id: 'remainder.holdshut',
    slot: 'guard',
    name: 'Hold Shut',
    nameKo: '닫힘',
    frame: frame(3, 0, 5, { cancelWindow: 0 }),
    variants: aims(() => ({ hitboxes: [] })),
    resourceCost: 0,
    meterCost: 0,
    tags: ['guard'],
    extra: {
      shell: {
        absorb: { KINETIC: 0.75, CRUSH: 0.7, FRACTURE: 0.55, THERMAL: 0.4, TIDAL: 0.3, ASSIMILATION: 0.25 },
      },
    },
  },
];

def.moves = moves;
def.epithet = 'The Wound That Fears';
def.destruction = 'TIDAL';
def.resource = { id: 'accreted', name: 'Mass', nameKo: '질량', max: 5, start: 2, display: 'pips' };
def.passive = {
  name: 'Hoard',
  text: 'What it tears off the foe, and the blows it swallows while holding shut, are packed into Mass: the pips Compaction spends.',
};
def.failureMode = {
  name: 'Cannibal',
  text: 'Below about a third of its mass it eats its own shell to keep the core alive: the bone crumbles inward, the core hardens, it Snaps faster and spins frantic, but it has no plates left to Hold Shut with.',
};
def.attributes = { mass: 7, cohesion: 6, heat: 6, gravity: 9, reach: 7, tempo: 4 };
// its strength knobs (docs/TITAN_GUIDE.md §3), set from the balance sweep (`npm run titan:check -- remainder`)
(def as TitanDef & { balance: { power: number; durability: number } }).balance = BALANCE;
def.ai = {
  style:
    'A patient mid-range controller: holds the foe off with Snaps, punishes an approach with Inhale, Folds away from pressure, and spends its Mass on slugs at range.',
  weights: { aggression: 0.45, patience: 0.6, zoning: 0.65, retreat: 0.3, trap: 0.3, punish: 0.75, gaze: 0 },
};
// rigid: the shell barely bobs or recoils, but it shudders; heavy to turn
const withFeel = def as TitanDef & { feel: Record<string, unknown> };
withFeel.feel = {
  ...withFeel.feel,
  bob: { amp: 0.4, period: 6.5 },
  sway: { amp: 0.3, period: 7.5 },
  accelMul: 1.45,
  recoil: 0.35,
  shudder: 1.5,
  thud: 1.3,
};
writeFileSync(PATH, JSON.stringify(def, null, 2) + '\n');
console.log(`${PATH}: ${moves.length} moves (${moves.map((m) => m.id).join(', ')})`);
