import {
  type MoveDef,
  type MoveSlot,
  type MoveVariant,
  type ResourceId,
  type StageLighting,
  type TitanDef,
  type TitanId,
} from '@/contracts';
import { cloneUriMap, URI_MATERIALS, uriPartMatter, type UriPartMatter } from './maps';
import type { UriPartKey } from './rig';

/**
 * 우리 (URI) as a titan definition (Phase 2A; uri/docs/URI_SPEC.md, uri/docs/TUNING.md, D31).
 *
 * - **Id:** 'uri' (proposal 173 adds it to `TitanId` / `TITAN_IDS`; until then it is cast in this one place).
 * - **Not in the roster yet:** D31 (7), it joins after its final gate. Built here like the Witness's def, not from a JSON file.
 * - **Moves (D31 (2)):** Strike = lead straight punch, Crush = rear cross-body smash, Signature = uppercut, Ultimate = double
 *   slam. Surge and Guard stay unbound. The fighter's frame data is the locked phase timing (TUNING.md) up to the end of
 *   `follow`: startup = load (+ rise + apex for the slam), active = the striking phase, recovery = follow. The taper is the
 *   kinetic system's (2B): a new move may grow out of it (spec §6.3). Cancel windows and buffering are 2D (S1).
 * - **Hits come from the parts:** the fists strike with their own matter (2B/2D), so the JSON hitbox lists are empty, as for
 *   the Witness's halo and sweep.
 * - **Health is the loop** (spec §7): resource 'loop' (proposal 173), 100, shown as a bar; wired in 2C.
 * - **Attributes:** provisional until the Phase 4 balance pass.
 */

export const URI_ID = 'uri' as TitanId;

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
    // which authored move of the kinetic system this slot plays (TUNING.md: punch, cross, upper, slam)
    extra: { uri: kinetic },
  };
}

const MOVES: readonly MoveDef[] = [
  move('uri.punch', 'strike', 'Straight Punch', '스트레이트', 0.3, 0.2, 0.18, 0.12, 'punch', ['lead']),
  move('uri.cross', 'crush', 'Cross-Body Smash', '크로스 스매시', 0.38, 0.26, 0.22, 0.14, 'cross', ['rear']),
  move('uri.upper', 'signature', 'Uppercut', '어퍼컷', 0.3, 0.22, 0.22, 0.12, 'upper', ['lead']),
  move('uri.slam', 'ultimate', 'Double Slam', '더블 슬램', 0.2 + 0.5 + 0.26, 0.2, 0.28, 0.24, 'slam', [
    'ultimate',
    'armor',
  ]),
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
      id: 'loop' as ResourceId,
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
