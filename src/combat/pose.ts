import { TICK_DT, clamp, clamp01 } from '@/contracts';
import type { ActiveMove } from './move';
import { DMath } from '@/contracts/dmath';

/**
 * Whole-body pose: the choreography lean targets of a move (load → commit → recover) and the body's angular state
 * (torsion for a body that springs back, free spin for one that does not). Both are pure and deterministic.
 */

/** Per-phase lean (px of row shear at the top of the body, facing-relative) authored in a move's `extra.pose`. */
export interface PoseLeans {
  back: number;
  fwd: number;
  rec: number;
  chg: number;
}

const poseScratch: PoseLeans = { back: 0, fwd: 0, rec: 0, chg: 0 };

/** Resolve a move's authored leans, with defaults by weight class. */
export function moveLeans(m: ActiveMove): PoseLeans {
  const def = m.def;
  const o = poseScratch;
  if (!def) {
    o.back = o.fwd = o.rec = o.chg = 0;
    return o;
  }
  const pose = def.extra?.['pose'] as Record<string, { lean: number }> | undefined;
  const heavy = def.slot === 'crush' || def.slot === 'ultimate';
  o.back = pose?.['startup']?.lean ?? (heavy ? -7 : -4);
  o.fwd = pose?.['active']?.lean ?? (heavy ? 9 : 6);
  o.rec = pose?.['recovery']?.lean ?? 2;
  o.chg = pose?.['charge']?.lean ?? -6;
  return o;
}

/** Ticks before the first active tick at which the body starts to COMMIT (leans into the blow before it lands). */
export const commitLead = (startup: number): number => Math.max(2, Math.min(8, Math.round(startup * 0.28)));

/**
 * The lean target of the move in progress (facing-relative px):
 *  - load: the back lean, reached fast (ease-out over ≤ 4 ticks) — the anticipation reads at once;
 *  - commit: from `commitLead` ticks before the blow the body is already pitching forward;
 *  - active: the forward lean;
 *  - recover: the authored recovery lean, then a visible re-balance (a sway back past upright), then upright.
 */
export function poseLeanTarget(m: ActiveMove): number {
  if (!m.def) return 0;
  const L = moveLeans(m);
  switch (m.phase) {
    case 'startup': {
      if (m.feint) return 0;
      const lead = commitLead(m.startup);
      if (m.startup > lead + 2 && m.phaseTick > m.startup - lead) return L.fwd * 0.55;
      const u = clamp01(m.phaseTick / Math.max(1, Math.min(4, m.startup)));
      return L.back * (1 - (1 - u) * (1 - u));
    }
    case 'charge':
      return L.chg;
    case 'active':
      return L.fwd;
    default: {
      const u = clamp01(m.phaseTick / Math.max(1, m.recovery));
      if (m.feint) return 0;
      if (u < 0.35) return L.rec;
      if (u < 0.7) return -0.5 * Math.max(Math.abs(L.rec), Math.abs(L.fwd) * 0.3) * Math.sign(L.fwd || 1);
      return 0;
    }
  }
}

/**
 * The anticipation kick (facing-relative px added to the lean on the accept tick, so the press changes a drawn pixel at
 * once): toward the load pose, at least 1.2 px.
 */
export function anticipationKick(m: ActiveMove): number {
  const L = moveLeans(m);
  const target = m.def?.slot === 'surge' ? 0 : L.back;
  if (target === 0) return 0;
  return Math.sign(target) * Math.max(1.2, Math.abs(target) * 0.4);
}

/** Angular model of a body (from its feel): restoring frequency (0 = free spin), damping ratio, drag and the spin cap. */
export interface AngularParams {
  /** Natural frequency (rad/s) of the restoring spring toward upright; 0 = the body spins freely (a world). */
  omega: number;
  zeta: number;
  /** Time constant (s) of the spin drag that acts in addition to the spring. */
  dragTau: number;
  /** |spin| cap (rad/s) and |angle| cap (rad, only applied when the body springs back). */
  maxSpin: number;
  maxAngle: number;
}

/** Angular state: `angle` (rad, +clockwise on screen) and `spin` (rad/s). */
export class Angular {
  angle = 0;
  spin = 0;

  reset(): void {
    this.angle = 0;
    this.spin = 0;
  }

  /** Add an angular velocity change (rad/s), capped. */
  impulse(dw: number, p: AngularParams): void {
    this.spin = clamp(this.spin + dw, -p.maxSpin, p.maxSpin);
  }

  step(p: AngularParams): void {
    const dt = TICK_DT;
    if (p.omega > 0) {
      const w = p.omega;
      this.spin += (-w * w * this.angle - 2 * p.zeta * w * this.spin) * dt;
    }
    this.spin *= DMath.exp(-dt / Math.max(0.05, p.dragTau));
    if (Math.abs(this.spin) < 1e-4) this.spin = 0;
    this.angle += this.spin * dt;
    if (p.omega > 0) {
      if (this.angle > p.maxAngle) {
        this.angle = p.maxAngle;
        if (this.spin > 0) this.spin = 0;
      } else if (this.angle < -p.maxAngle) {
        this.angle = -p.maxAngle;
        if (this.spin < 0) this.spin = 0;
      }
      if (Math.abs(this.angle) < 1e-5 && this.spin === 0) this.angle = 0;
    } else {
      // a free spinner's phase wraps so it stays a small, hash-stable number
      const TAU = Math.PI * 2;
      if (this.angle > Math.PI) this.angle -= TAU;
      else if (this.angle < -Math.PI) this.angle += TAU;
    }
  }
}

/** A move's scripted angular impulses (`extra.spinKeys`: [{ at, w }], at = choreography tick, w = rad/s, facing-relative). */
export interface SpinKey {
  at: number;
  w: number;
}

export function spinKeysOf(m: ActiveMove): readonly SpinKey[] | null {
  const k = m.def?.extra?.['spinKeys'] as SpinKey[] | undefined;
  return k && k.length ? k : null;
}
