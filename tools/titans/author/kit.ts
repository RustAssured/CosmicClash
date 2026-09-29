import {
  AIM_DIRS,
  type AimDir,
  type DamageParams,
  type DamageType,
  type FrameData,
  type HitboxDef,
  type MovementKey,
  type MoveVariant,
  type ShapeTemplate,
} from '@/contracts';

/**
 * Authoring helpers for the Phase 2 titan JSON (Supernova, Planet). A move's three aim variants differ only by where the
 * blow is directed, so they are written once and turned into `up` / `forward` / `down` here; the output is plain JSON
 * (`src/titans/<id>.json`) that `validateTitanDef` and `tools/titans/docs.ts` read like any other definition.
 */

/** Stick aim → vertical sign (+y is down). */
export const AIM_SIGN: Record<AimDir, number> = { up: -1, forward: 0, down: 1 };

/** Aim as an angle (radians, 0 = forward) for cones and rays. */
export const AIM_ANGLE: Record<AimDir, number> = { up: -0.72, forward: 0, down: 0.72 };

export const frame = (
  startup: number,
  active: number,
  recovery: number,
  o: Partial<FrameData> = {},
): FrameData => ({ startup, active, recovery, cancelWindow: 0.4, chargeMax: 0, hitstop: 0, ...o });

export interface HbOpts {
  sweepTo?: ShapeTemplate;
  rehit?: number;
  reachScale?: number;
}

/** A hitbox: `[from, to)` ticks of the active phase, a shape, the damage it deals and how it shoves. */
export function hb(
  id: string,
  from: number,
  to: number,
  shape: ShapeTemplate,
  type: DamageType,
  energy: number,
  params: DamageParams,
  flags: number,
  knock: { x: number; y: number },
  guardPressure: number,
  o: HbOpts = {},
): HitboxDef {
  const out: HitboxDef = {
    id,
    from,
    to,
    shape,
    damage: { type, energy, duration: 1, flags, params },
    knockback: knock,
    guardPressure,
  };
  if (o.sweepTo) out.sweepTo = o.sweepTo;
  if (o.rehit) out.rehit = o.rehit;
  if (o.reachScale !== undefined) out.reachScale = o.reachScale;
  return out;
}

/** Build the three aim variants of a move from one callback. */
export function aims(
  f: (aim: AimDir) => { hitboxes: HitboxDef[]; movement?: MovementKey[]; frame?: Partial<FrameData> },
): Record<AimDir, MoveVariant> {
  const out = {} as Record<AimDir, MoveVariant>;
  for (const aim of AIM_DIRS) {
    const v = f(aim);
    const variant: MoveVariant = { hitboxes: v.hitboxes, movement: v.movement ?? [] };
    if (v.frame) variant.frame = v.frame;
    out[aim] = variant;
  }
  return out;
}

export const key = (at: number, ix: number, iy = 0, damp?: number): MovementKey =>
  damp === undefined ? { at, ix, iy } : { at, ix, iy, damp };

/** Round to 2 decimals so generated JSON stays tidy. */
export const r2 = (v: number): number => Math.round(v * 100) / 100;
