import type { MoveDef, MoveSlot, MoveVariant, TitanDef, TitanId } from '@/contracts';
import { URI_MATERIALS } from '../uri/maps';

/**
 * The Mouth (아귀) as a titan definition (Phase 3, mouth/docs/MOUTH_SPEC.md, D35 / D37).
 *
 * - **Id:** 'mouth'. It is a final boss (D35): NOT in `IMPLEMENTED_TITANS` (the roster every menu, test and tournament walks)
 *   and not in `TITAN_DEFS`; `getTitanDef('mouth')` builds it, and the menus offer it only when `isMouthUnlocked()`
 *   (src/titans/mouth/unlock.ts).
 * - **Not matter:** the Mouth is analytic (Gate 3A): `MouthFighter` (src/combat/mouth/fighter.ts) plays it, with capsule
 *   hurtboxes and the prototype's damage model. The def's `art` is a stub the fighter never paints.
 * - **Moves (Gate 3A §6, D37):** Bite = Strike, Sweep = Crush, Coil & crush = Signature. Surge, Guard and Ultimate are
 *   unbound (D31-2: nothing in the pack maps to them). Slide = stick X (oracle literal: along the perimeter), height = stick Y
 *   held at the strike. The frame data below is the locked beats (MOUTH_TUNING.md) at straight height, for the view and
 *   Training; the fighter runs the beats themselves.
 * - **Health:** 100 (the four jaw-rings, 25 % each: Gate 3A §5). The boss variant (`mouthBossDef`) doubles it and enrages
 *   the last ring (src/combat/mouth/tuning.ts MOUTH_BOSS).
 * - **Attributes:** provisional (no design-bible row): heavy, long reach, slow.
 */

export const MOUTH_ID: TitanId = 'mouth';

const T = (s: number): number => Math.round(s * 60);
const STRIKE = 1.18;
const emptyVariant = (): MoveVariant => ({ hitboxes: [], movement: [] });

function move(
  id: string,
  slot: MoveSlot,
  name: string,
  nameKo: string,
  startup: number,
  active: number,
  recovery: number,
  beat: 'bite' | 'sweep' | 'coil',
  tags: string[],
): MoveDef {
  return {
    id,
    slot,
    name,
    nameKo,
    frame: {
      startup: T(startup),
      active: T(active),
      recovery: T(recovery),
      cancelWindow: 0,
      chargeMax: 0,
      hitstop: 7,
    },
    variants: { up: emptyVariant(), forward: emptyVariant(), down: emptyVariant() },
    resourceCost: 0,
    meterCost: 0,
    tags,
    extra: {
      // which authored move of the crane this slot plays (MOUTH_TUNING.md: bite, sweep, coil & crush)
      mouth: beat,
      bodyHits: true,
      lockedTiming: 'mouth/docs/MOUTH_TUNING.md Moves (the locked oracle)',
    },
  };
}

const MOVES: readonly MoveDef[] = [
  // bite: load .42 · strike .18 (÷ 1.18) · bite .16 · hold .12 · recover .70
  move('mouth.bite', 'strike', 'Bite', '물기', 0.42, 0.18 / STRIKE + 0.16 + 0.12, 0.7, 'bite', [
    'crush',
    'heavy',
  ]),
  // sweep: load .38 · sweep .50 (÷ 1.18) · bite .14 · recover .75
  move('mouth.sweep', 'crush', 'Sweep', '휩쓸기', 0.38, 0.5 / STRIKE + 0.14, 0.75, 'sweep', [
    'crush',
    'heavy',
  ]),
  // coil & crush: reach .36 · coil .70 · crush .40 · release .80
  move('mouth.coil', 'signature', 'Coil & Crush', '휘감아 조이기', 0.36, 0.7 + 0.4, 0.8, 'coil', [
    'grab',
    'enclose',
  ]),
];

const DEFS = new Map<string, TitanDef>();

function build(boss: boolean): TitanDef {
  const key = boss ? 'boss' : 'normal';
  const hit = DEFS.get(key);
  if (hit) return hit;
  const def: TitanDef = {
    id: MOUTH_ID,
    name: 'The Mouth',
    nameKo: '아귀',
    epithet: boss ? 'The Hunger at the Edge' : 'The Hunger',
    attributes: { mass: 10, cohesion: 6, heat: 6, gravity: 3, reach: 10, tempo: 4 },
    resource: { id: 'jaws', name: 'Jaw-rings', nameKo: '턱고리', max: 4, start: 4, display: 'pips' },
    destruction: 'CRUSH',
    passive: {
      name: 'Encroachment',
      text: 'It never walks. It slides a colossal body along the edge of the arena and launches its head.',
    },
    failureMode: {
      name: 'Dragged Back',
      text: 'When the last jaw-ring breaks the coils drag it back over the edge; with three strands cut, the head comes loose.',
    },
    // the fighter's stand-in body only (never painted, never hit): the Mouth is analytic
    materials: [{ ...URI_MATERIALS[0]!, key: 'flesh' }],
    art: { w: 4, h: 4, coreX: 2, coreY: 2, coreRadius: 1, params: { mouth: true, boss } },
    moves: MOVES.map((m) => structuredClone(m)),
    ai: {
      weights: { aggression: 0.6, patience: 0.5 },
      style: 'A crane at the edge: tracks, coils back, strikes along a drawn path, and never follows.',
    },
    ui: { accent: '#d45e50', accent2: '#efcdb2', tagline: 'Only the feeding end of it fits on the screen.' },
    unboundSlots: ['surge', 'guard', 'ultimate'],
  };
  DEFS.set(key, def);
  return def;
}

/** The Mouth as a fightable titan (Training, vs AI once unlocked). */
export const mouthDef = (): TitanDef => build(false);
/** The final boss of the tournament ladder (D35): double health, an enraged last ring. */
export const mouthBossDef = (): TitanDef => build(true);

export const isMouthDef = (def: TitanDef): boolean =>
  (def.art?.params as { mouth?: unknown } | undefined)?.mouth === true;
export const isMouthBossDef = (def: TitanDef): boolean =>
  isMouthDef(def) && (def.art.params as { boss?: unknown }).boss === true;
