import { clamp, type MatterMap } from '@/contracts';
import { DMath, sq } from '@/contracts/dmath';

/**
 * The impact model (SLICE_PLAN §6, S1 task 2): a blow is a FORCE AT A POINT. Its momentum J (mass·px/s) goes into the
 * target's linear velocity (Δv = J/m, real momentum, decayed only by drag) and, through the lever arm r from the target's
 * centre of mass to the contact point, into its angular velocity (Δω = r × J / I). Where the blow lands decides what the
 * body does: a centre hit translates, an edge hit spins, a glancing hit slides and spins hard, a low hit sweeps the base and
 * tips the body over the blow.
 */
export type HitClass = 'centre' | 'edge' | 'glancing' | 'low';

export const IMPACT = {
  /** |r⊥| / R at or above which a hit is glancing / an edge hit (R = the body's outer radius). */
  glancing: 0.62,
  edge: 0.24,
  /** A contact this far below the centre of mass (× R) with a mostly horizontal blow is a low hit. */
  low: 0.38,
  /** Per class: share of the linear momentum delivered, and the torque multiplier. */
  linear: { centre: 1, edge: 0.85, glancing: 0.5, low: 0.8 } as Record<HitClass, number>,
  torque: { centre: 0.3, edge: 1, glancing: 1.35, low: 1.2 } as Record<HitClass, number>,
  /** A low hit also lifts: upward momentum as a share of |J|. */
  lowLift: 0.3,
  /** Global torque gain (rad/s per unit of r×J/I) and the cap on the resulting |Δω| (rad/s). */
  torqueGain: 0.18,
  maxDeltaW: 2.4,
} as const;

/** Mass properties of a body in map-local cells: centre of mass, radius of gyration, outer radius, live cell count. */
export interface MassProps {
  version: number;
  cells: number;
  comX: number;
  comY: number;
  /** √(Σr²/n) in px. */
  gyration: number;
  /** Outer radius estimate (px): the 95th-percentile-like extent, 1.55 × gyration (exact for a uniform disc: √2). */
  radius: number;
}

export function makeMassProps(): MassProps {
  return { version: -1, cells: 0, comX: 0, comY: 0, gyration: 1, radius: 1 };
}

/**
 * Measure (or re-use, when the map has not changed) a body's mass properties from its live cells. One pass over the map; the
 * fighter calls it only when a blow lands, so it costs ~0.05 ms per hit, never per tick.
 */
export function measureMass(map: MatterMap, out: MassProps): MassProps {
  if (out.version === map.version && out.cells > 0) return out;
  const w = map.w;
  const h = map.h;
  const mat = map.material;
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mat[row + x] === 0) continue;
      n++;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
    }
  }
  out.version = map.version;
  out.cells = n;
  if (n === 0) {
    out.comX = map.coreX;
    out.comY = map.coreY;
    out.gyration = 1;
    out.radius = 1;
    return out;
  }
  out.comX = sx / n + 0.5;
  out.comY = sy / n + 0.5;
  const varX = Math.max(0, sxx / n - sq(sx / n));
  const varY = Math.max(0, syy / n - sq(sy / n));
  out.gyration = Math.max(1, Math.sqrt(varX + varY));
  out.radius = out.gyration * 1.55;
  return out;
}

export interface ImpactResult {
  cls: HitClass;
  /** Linear momentum actually delivered (mass·px/s, world). */
  jx: number;
  jy: number;
  /** Angular velocity change (rad/s, +clockwise on screen). */
  dw: number;
  /** Signed perpendicular lever arm as a fraction of the outer radius. */
  lever: number;
}

export function makeImpactResult(): ImpactResult {
  return { cls: 'centre', jx: 0, jy: 0, dw: 0, lever: 0 };
}

/**
 * Resolve a blow of momentum (jx, jy) landing at world point (cx, cy) on a body whose centre of mass is at world (comX, comY),
 * with effective mass `mass`, gyration radius `gyr` (px) and outer radius `R` (px).
 */
export function resolveImpact(
  cx: number,
  cy: number,
  jx: number,
  jy: number,
  comX: number,
  comY: number,
  mass: number,
  gyr: number,
  R: number,
  out: ImpactResult,
): ImpactResult {
  const J = DMath.hypot(jx, jy);
  const rx = cx - comX;
  const ry = cy - comY;
  if (J < 1e-6) {
    out.cls = 'centre';
    out.jx = 0;
    out.jy = 0;
    out.dw = 0;
    out.lever = 0;
    return out;
  }
  const nx = jx / J;
  const ny = jy / J;
  // signed perpendicular arm: r × n̂ (2-D cross, +y down ⇒ positive = clockwise torque)
  const perp = rx * ny - ry * nx;
  const p = perp / Math.max(1, R);
  const below = ry / Math.max(1, R);
  let cls: HitClass;
  if (Math.abs(p) >= IMPACT.glancing) cls = 'glancing';
  else if (below >= IMPACT.low && Math.abs(ny) < 0.7) cls = 'low';
  else if (Math.abs(p) >= IMPACT.edge) cls = 'edge';
  else cls = 'centre';
  const lin = IMPACT.linear[cls];
  out.jx = jx * lin;
  out.jy = jy * lin;
  if (cls === 'low') out.jy -= J * IMPACT.lowLift;
  const inertia = Math.max(1, mass) * gyr * gyr;
  const dw = ((perp * J) / inertia) * IMPACT.torqueGain * IMPACT.torque[cls];
  out.dw = clamp(dw, -IMPACT.maxDeltaW, IMPACT.maxDeltaW);
  out.cls = cls;
  out.lever = p;
  return out;
}
