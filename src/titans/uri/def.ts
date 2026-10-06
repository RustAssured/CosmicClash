import {
  type MoveDef,
  type MoveSlot,
  type MoveVariant,
  type StageLighting,
  type TitanDef,
  type TitanId,
} from '@/contracts';
import { cloneUriMap, URI_MATERIALS, uriPartMatter, type UriPartMatter } from './maps';
import type { UriPartKey } from './rig';

/**
 * 우리 (URI) as a titan definition (Phase 2A; uri/docs/URI_SPEC.md, uri/docs/TUNING.md, D31).
 *
 * - **Id:** 'uri' (proposal 173: in `TitanId` / `TITAN_IDS`, resource 'loop').
 * - **On the roster** since Gate 2D (D31-7; `IMPLEMENTED_TITANS`, `SLICE.titans`). Built here like the Witness's def, not
 *   from a JSON file; `TITAN_DEFS.uri` builds it on first use (the browser loads the asset at boot).
 * - **Moves (D31 (2)):** Strike = lead straight punch, Crush = rear cross-body smash, Signature = uppercut, Ultimate = double
 *   slam. Surge and Guard stay unbound. The fighter's frame data is the locked phase timing (TUNING.md) up to the end of
 *   `follow`: startup = load (+ rise + apex for the slam), active = the striking phase, recovery = follow. The taper is the
 *   kinetic system's (2B): a new move may grow out of it (spec §6.3). 2D: the fighter's input buffer, and a move pressed
 *   while the last blow is still committed waits for that blow to land (UriBehaviour `pending`). Surge and Guard are
 *   declared unbound (`unboundSlots`).
 * - **Hits come from the parts:** the fists strike with their own matter (2B/2D), so the JSON hitbox lists are empty, as for
 *   the Witness's halo and sweep.
 * - **Health is the loop** (spec §7): resource 'loop' (proposal 173), 100, shown as a bar; wired in 2C.
 * - **Attributes:** provisional until the Phase 4 balance pass.
 */

export const URI_ID: TitanId = 'uri';

const T = (s: number): number => Math.round(s * 60);

const emptyVariant = (): MoveVariant => ({ hitboxes: [], movement: [] });
const variants = (): Record<'up' | 'forward' | 'down', MoveVariant> => ({
  up: emptyVariant(),
  forward: emptyVariant(),
  down: emptyVariant(),
});

/** A move from its locked phases (seconds): startup, the striking phase, follow; hitstop (s). */
function move(
  id: string,
  slot: MoveSlot,
  name: string,
  nameKo: string,
  startupS: number,
  activeS: number,
  followS: number,
  hitstopS: number,
  kinetic: string,
  tags: string[],
  blow: UriBlow,
): MoveDef {
  return {
    id,
    slot,
    name,
    nameKo,
    frame: {
      startup: T(startupS),
      active: T(activeS),
      recovery: T(followS),
      cancelWindow: 0.4,
      chargeMax: 0,
      hitstop: T(hitstopS),
    },
    variants: variants(),
    resourceCost: 0,
    meterCost: slot === 'ultimate' ? 1 : 0,
    tags,
    extra: {
      // which authored move of the kinetic system this slot plays (TUNING.md: punch, cross, upper, slam)
      uri: kinetic,
      // the fists strike with their own matter when the kinetic system's arms arrive (2D): no JSON hitboxes
      bodyHits: true,
      // the frame data is the locked oracle's phases, not the classic feel targets (the cross and the slam are shorter)
      lockedTiming: 'uri/docs/TUNING.md Phases (the locked oracle; URI_SPEC §6.4)',
      blow,
    },
  };
}

/**
 * What a landed fist does to the foe's matter (2D). PROVISIONAL, for the Phase 4 balance pass: the oracle has no opponent, so
 * these are anchored on the game's existing KINETIC blows of the same weight (Tidal Rush 500, Meteor Strike 1147) and are a
 * debug-overlay knob ('URI POWER x'). Knockback is facing-relative (x toward the foe, y down).
 */
export interface UriBlow {
  energy: number;
  knockback: readonly [number, number];
  guardPressure: number;
  params: Readonly<Record<string, number>>;
  provisional: true;
}
const BLOWS: Readonly<Record<string, UriBlow>> = {
  punch: {
    energy: 500,
    knockback: [620, -40],
    guardPressure: 1,
    params: { crater: 10, penetration: 10, scatter: 1.1 },
    provisional: true,
  },
  cross: {
    energy: 650,
    knockback: [700, -60],
    guardPressure: 1,
    params: { crater: 14, penetration: 12, scatter: 1.2 },
    provisional: true,
  },
  upper: {
    energy: 550,
    knockback: [240, -620],
    guardPressure: 0.8,
    params: { crater: 10, penetration: 10, scatter: 1.1 },
    provisional: true,
  },
  slam: {
    energy: 1100,
    knockback: [180, 520],
    guardPressure: 1,
    params: { crater: 20, penetration: 18, scatter: 1.3 },
    provisional: true,
  },
};

const MOVES: readonly MoveDef[] = [
  move(
    'uri.punch',
    'strike',
    'Straight Punch',
    '스트레이트',
    0.3,
    0.2,
    0.18,
    0.12,
    'punch',
    ['lead'],
    BLOWS.punch!,
  ),
  move(
    'uri.cross',
    'crush',
    'Cross-Body Smash',
    '크로스 스매시',
    0.38,
    0.26,
    0.22,
    0.14,
    'cross',
    ['rear'],
    BLOWS.cross!,
  ),
  move(
    'uri.upper',
    'signature',
    'Uppercut',
    '어퍼컷',
    0.3,
    0.22,
    0.22,
    0.12,
    'upper',
    ['lead'],
    BLOWS.upper!,
  ),
  move(
    'uri.slam',
    'ultimate',
    'Double Slam',
    '더블 슬램',
    0.2 + 0.5 + 0.26,
    0.2,
    0.28,
    0.24,
    'slam',
    ['ultimate', 'armor'],
    BLOWS.slam!,
  ),
];

let DEF: TitanDef | null = null;

/** The primary body is the pelvis: the rig's root (hips), the frame the fighter moves. */
export const URI_PRIMARY: UriPartKey = 'pelvis';

export function uriDef(): TitanDef {
  if (DEF) return DEF;
  const pelvis = uriPartMatter().find((p) => p.key === URI_PRIMARY)!.map;
  DEF = {
    id: URI_ID,
    name: '우리',
    nameKo: '우리',
    epithet: 'The Refusal',
    attributes: { mass: 9, cohesion: 7, heat: 6, gravity: 5, reach: 7, tempo: 3 },
    resource: {
      id: 'loop',
      name: 'Loop',
      nameKo: '고리',
      max: 100,
      start: 100,
      display: 'bar',
    },
    destruction: 'KINETIC',
    passive: {
      name: 'Suppressed Momentum',
      text: 'Most of every blow it throws is held inside the body: the loop strains, the cores jolt, the pylons fire.',
    },
    failureMode: {
      name: 'Break Apart',
      text: 'The loop is its health. When it snaps, everything it held flies apart around the two dead worlds.',
    },
    materials: URI_MATERIALS.map((m) => ({ ...m })),
    art: {
      w: pelvis.w,
      h: pelvis.h,
      coreX: pelvis.coreX,
      coreY: pelvis.coreY,
      coreRadius: pelvis.coreRadius,
      // the primary (pelvis) is drawn and hit with 우리's own rotation rule, like its regions (proposal 174; S1's hook, 57afe0a)
      params: { uri: true, sampler: 'majority4' },
    },
    moves: MOVES.map((m) => structuredClone(m)),
    ai: {
      weights: { aggression: 0.5, patience: 0.6 },
      style: 'A fortress-boxer: heavy commitment, long tapers.',
    },
    ui: { accent: '#ffb060', accent2: '#6a92f8', tagline: 'It refuses to fall apart.' },
    // D31-2: the pack defines no movement verb and no defence for 우리; none is invented
    unboundSlots: ['surge', 'guard'],
  };
  return DEF;
}

export const isUriDef = (def: TitanDef): boolean => (def.art.params as { uri?: unknown }).uri === true;

/** The rig a 우리 fighter is generated with: every part's matter (the pelvis is the fighter's primary body). */
export interface UriTitanRig {
  kind: 'uri';
  parts: readonly UriPartMatter[];
  /** Material ids by key (index + 1 of URI_MATERIALS). */
  ids: Record<string, number>;
}

/** "Paint" 우리: the asset is loaded as is (nothing is repainted); the pelvis map is the primary, the rest ride the rig. */
export function paintUriTitan(
  _def: TitanDef,
  _seed: number,
  _lighting: StageLighting,
): { map: ReturnType<typeof cloneUriMap>; rig: UriTitanRig } {
  const parts = uriPartMatter();
  const pelvis = parts.find((p) => p.key === URI_PRIMARY)!;
  const ids: Record<string, number> = {};
  URI_MATERIALS.forEach((m, i) => (ids[m.key] = i + 1));
  return { map: cloneUriMap(pelvis.map), rig: { kind: 'uri', parts, ids } };
}
