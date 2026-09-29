import type { StickCalibration } from './types';

/**
 * Radial deadzone with rescale. Inside `dz` the stick reads exactly 0; outside, the magnitude is rescaled so that the
 * edge of the deadzone maps to 0 and full deflection to 1 (no jump when leaving the deadzone). The output magnitude
 * never exceeds 1, and the DIRECTION is preserved (unlike per-axis deadzones, which snap diagonals to the axes).
 */
export function radialDeadzone(x: number, y: number, dz: number, out: { x: number; y: number }): void {
  const mag = Math.hypot(x, y);
  if (!(mag > dz) || mag === 0) {
    out.x = 0;
    out.y = 0;
    return;
  }
  const scaled = Math.min(1, (mag - dz) / (1 - dz));
  const k = scaled / mag;
  out.x = x * k;
  out.y = y * k;
}

export const newCalibration = (): StickCalibration => ({ cx: 0, cy: 0, minX: 1, maxX: 1, minY: 1, maxY: 1 });

/**
 * Apply a stored calibration: subtract the measured centre, scale each half-axis by its measured travel so a stick that
 * only reaches 0.82 still hits 1.0, then clamp the vector to the unit disc (octagonal gates otherwise give |v| up to √2).
 */
export function applyCalibration(
  x: number,
  y: number,
  cal: StickCalibration | null,
  out: { x: number; y: number },
): void {
  if (!cal) {
    out.x = x;
    out.y = y;
  } else {
    const dx = x - cal.cx;
    const dy = y - cal.cy;
    out.x = dx >= 0 ? dx / Math.max(0.2, cal.maxX) : dx / Math.max(0.2, cal.minX);
    out.y = dy >= 0 ? dy / Math.max(0.2, cal.maxY) : dy / Math.max(0.2, cal.minY);
  }
  const m = Math.hypot(out.x, out.y);
  if (m > 1) {
    out.x /= m;
    out.y /= m;
  }
}

/** Calibration + deadzone in one call: what the game sees. */
export function processStick(
  x: number,
  y: number,
  cal: StickCalibration | null,
  dz: number,
  out: { x: number; y: number },
): void {
  applyCalibration(x, y, cal, out);
  radialDeadzone(out.x, out.y, dz, out);
}

/**
 * Two-phase calibration capture. Phase 1 averages `centreSamples` rest readings (the physical centre is rarely
 * exactly 0 — drift is the #1 complaint on worn Pro Controllers). Phase 2 records the extreme travel on each half axis
 * while the player rolls the stick around its gate.
 */
export class StickCapture {
  phase: 'centre' | 'range' | 'done' = 'centre';
  private n = 0;
  private sx = 0;
  private sy = 0;
  private cx = 0;
  private cy = 0;
  private minX = 0;
  private maxX = 0;
  private minY = 0;
  private maxY = 0;
  /** Samples averaged for the centre. */
  readonly centreSamples: number;
  /** Ticks of range travel wanted before `done` is allowed. */
  private rangeSamples = 0;
  private readonly rangeNeeded: number;
  private rested = false;

  constructor(centreSamples = 30, rangeNeeded = 90) {
    this.centreSamples = centreSamples;
    this.rangeNeeded = rangeNeeded;
  }

  /** Feed a raw stick reading. Returns the phase progress 0..1. */
  feed(x: number, y: number): number {
    if (this.phase === 'centre') {
      // Refuse to average while the stick is clearly being held off-centre.
      if (Math.hypot(x, y) > 0.5) {
        this.n = 0;
        this.sx = 0;
        this.sy = 0;
        return 0;
      }
      this.n++;
      this.sx += x;
      this.sy += y;
      if (this.n >= this.centreSamples) {
        this.cx = this.sx / this.n;
        this.cy = this.sy / this.n;
        this.phase = 'range';
      }
      return this.n / this.centreSamples;
    }
    if (this.phase === 'range') {
      const dx = x - this.cx;
      const dy = y - this.cy;
      if (dx < this.minX) this.minX = dx;
      if (dx > this.maxX) this.maxX = dx;
      if (dy < this.minY) this.minY = dy;
      if (dy > this.maxY) this.maxY = dy;
      const m = Math.hypot(dx, dy);
      // Count only samples where the stick is near its gate, so idling doesn't complete the wizard.
      if (m > 0.6) this.rangeSamples++;
      if (m < 0.2) this.rested = true;
      const covered = [this.minX < -0.5, this.maxX > 0.5, this.minY < -0.5, this.maxY > 0.5].filter(
        Boolean,
      ).length;
      const prog = Math.min(1, (this.rangeSamples / this.rangeNeeded) * 0.5 + (covered / 4) * 0.5);
      if (this.rangeSamples >= this.rangeNeeded && covered === 4 && this.rested) this.phase = 'done';
      return prog;
    }
    return 1;
  }

  /** Current best calibration (valid once `phase !== 'centre'`). */
  result(): StickCalibration {
    return {
      cx: this.cx,
      cy: this.cy,
      minX: Math.max(0.3, -this.minX),
      maxX: Math.max(0.3, this.maxX),
      minY: Math.max(0.3, -this.minY),
      maxY: Math.max(0.3, this.maxY),
    };
  }

  /** Force completion (user pressed confirm). */
  finish(): StickCalibration {
    this.phase = 'done';
    return this.result();
  }
}

/** Estimate the quarter-turn rotation from a raw "push the stick AWAY from you (up)" reading. */
export function rotationFromUp(x: number, y: number): number | null {
  if (Math.hypot(x, y) < 0.6) return null;
  // Want rotate(raw) ≈ (0, −1). Try each quarter-turn and take the one that lands best on up.
  let best = 0;
  let bestDot = -2;
  for (let q = 0; q < 4; q++) {
    let rx: number;
    let ry: number;
    switch (q) {
      case 1:
        rx = -y;
        ry = x;
        break;
      case 2:
        rx = -x;
        ry = -y;
        break;
      case 3:
        rx = y;
        ry = -x;
        break;
      default:
        rx = x;
        ry = y;
    }
    const dot = -ry / Math.hypot(rx, ry);
    if (dot > bestDot) {
      bestDot = dot;
      best = q;
    }
  }
  return best;
}
