/**
 * A small deterministic 2-D XPBD solver for the Witness's region rig (eye cradle, carapace, shrine, halo arcs, arm segments).
 *
 * Bodies are rigid regions with mass and inertia computed from their LIVE cells (`massFromCells`), so destroying matter shifts
 * the centre of mass and lightens a limb on the next update. A body's pose is the pose of its FRAME (the region map's pivot), while
 * the dynamics run at its centre of mass; `setMass` keeps the frame where it is when the centre of mass moves.
 *
 * Constraints (solved in a fixed order, one iteration per substep, Lagrange multipliers reset per substep — the "small steps"
 * XPBD scheme, unconditionally stable for any stiffness):
 *   - point joints (pin two frame-local anchors together; rigid or springy), with a failure force scaled by joint HEALTH;
 *   - angular drives (relative angle → target; the torsion spring when the target is the rest angle), stiffness given as a natural
 *     frequency and damping ratio so tuning does not depend on the region's mass;
 *   - angle limits (inequality).
 * Kinematic bodies (the eye: intent) are moved by the caller and interpolated across the substeps.
 *
 * Pure TypeScript, no allocation per tick, fixed iteration order: identical inputs give bit-identical state (`hash`).
 */

export const RIG_SUBSTEPS = 8;
/** Constraint passes per substep (multipliers accumulate within a substep). */
export const RIG_ITERATIONS = 2;
export const TICK = 1 / 60;
const TAU = Math.PI * 2;

/** Wrap an angle into (−π, π]. */
export function wrapAngle(a: number): number {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

/** Quantise an angle to one of `steps` LUT entries (0..steps−1): what a region body is rendered and hit-tested at. */
export function angleIndex(a: number, steps: number): number {
  return (((Math.round((a / TAU) * steps) % steps) + steps) % steps) | 0;
}

export interface MassProps {
  mass: number;
  /** Centre of mass in frame-local px (cell centres at +0.5). */
  cx: number;
  cy: number;
  /** Moment of inertia about the centre of mass (mass·px²). Each cell adds its own 1/6 (a unit square). */
  inertia: number;
  cells: number;
}

/**
 * Mass properties of a region from its live cells. `pivotX/pivotY` is the frame origin in map cells (the region's pivot), so the
 * result is in frame-local px. `matDensity[m]` is the mass per cell of material m at density byte 128 (as the matter world uses).
 */
export function massFromCells(
  map: { w: number; h: number; material: Uint8Array; density: Uint8Array },
  matDensity: ArrayLike<number>,
  pivotX: number,
  pivotY: number,
  out: MassProps,
): MassProps {
  const { w, h, material, density } = map;
  let m = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let cells = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const fy = y + 0.5 - pivotY;
    for (let x = 0; x < w; x++) {
      const id = material[row + x]!;
      if (id === 0) continue;
      const mc = (matDensity[id]! * density[row + x]!) / 128;
      if (mc <= 0) continue;
      const fx = x + 0.5 - pivotX;
      m += mc;
      sx += mc * fx;
      sy += mc * fy;
      sxx += mc * (fx * fx + fy * fy + 1 / 6);
      cells++;
    }
  }
  out.mass = m;
  out.cells = cells;
  if (m <= 0) {
    out.cx = 0;
    out.cy = 0;
    out.inertia = 0;
    return out;
  }
  out.cx = sx / m;
  out.cy = sy / m;
  out.inertia = sxx - m * (out.cx * out.cx + out.cy * out.cy);
  return out;
}

export interface JointDef {
  a: number;
  /** Body index, or −1 to pin `a` to a fixed world point (bx, by). */
  b: number;
  /** Anchor in a's frame (px). */
  ax: number;
  ay: number;
  /** Anchor in b's frame (px), or the world point when b = −1. */
  bx: number;
  by: number;
  /** 0 = rigid; otherwise the spring's natural frequency (Hz) and damping ratio. */
  hz?: number;
  zeta?: number;
  /** Force (mass·px/s²) above which the joint fails at full health. Infinity = never. */
  breakForce?: number;
}

export interface DriveDef {
  /** Parent body (−1 = world frame), child body. The drive acts on angle(b) − angle(a). */
  a: number;
  b: number;
  /** Target relative angle (rad); change it every tick to animate (the drive is the muscle, its rest value the torsion spring). */
  target: number;
  hz: number;
  zeta: number;
  /**
   * Tune the frequency against the inertia about each body's FRAME origin (its pivot) instead of its centre of mass. Use it
   * when the child is pinned at its pivot (an arm segment, a halo arc orbiting the eye): it then really turns about the
   * pivot, and `hz` is what you see.
   */
  aboutPivot?: boolean;
  /** Switched off (its joint failed). */
  off?: boolean;
}

export interface LimitDef {
  a: number;
  b: number;
  min: number;
  max: number;
  /** Correct by turning about each body's pivot (see DriveDef.aboutPivot). */
  aboutPivot?: boolean;
  /** Switched off (its joint failed). */
  off?: boolean;
}

export interface BreakEvent {
  joint: number;
  force: number;
  tick: number;
}

/** The rig: structure-of-arrays bodies and constraint lists, preallocated to fixed capacities. */
export class XpbdRig {
  readonly cap: number;
  n = 0;
  tick = 0;
  /* body state: centre of mass position, angle, velocities, previous substep values */
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly a: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly w: Float64Array;
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly pa: Float64Array;
  readonly invMass: Float64Array;
  readonly invInertia: Float64Array;
  /** Centre of mass in frame-local px. */
  readonly comX: Float64Array;
  readonly comY: Float64Array;
  /** Linear and angular drag per second. */
  readonly linDrag: Float64Array;
  readonly angDrag: Float64Array;
  readonly kinematic: Uint8Array;
  /** Kinematic interpolation: frame pose at the start of the tick and the target at its end. */
  private readonly k0x: Float64Array;
  private readonly k0y: Float64Array;
  private readonly k0a: Float64Array;
  private readonly k1x: Float64Array;
  private readonly k1y: Float64Array;
  private readonly k1a: Float64Array;

  readonly joints: (Required<JointDef> & {
    health: number;
    broken: boolean;
    force: number;
    lambda: number;
  })[] = [];
  readonly drives: (DriveDef & { torque: number; lambda: number })[] = [];
  readonly limits: (LimitDef & { lambda: number })[] = [];
  /** Joint failures since the last `drainBreaks` (bounded). */
  readonly breaks: BreakEvent[] = [];

  /** Gravity in px/s² (0 in space; tests use it). */
  gx = 0;
  gy = 0;

  constructor(capacity = 32) {
    this.cap = capacity;
    const f = (): Float64Array => new Float64Array(capacity);
    this.x = f();
    this.y = f();
    this.a = f();
    this.vx = f();
    this.vy = f();
    this.w = f();
    this.px = f();
    this.py = f();
    this.pa = f();
    this.invMass = f();
    this.invInertia = f();
    this.comX = f();
    this.comY = f();
    this.linDrag = f();
    this.angDrag = f();
    this.kinematic = new Uint8Array(capacity);
    this.k0x = f();
    this.k0y = f();
    this.k0a = f();
    this.k1x = f();
    this.k1y = f();
    this.k1a = f();
  }

  /** Add a body whose FRAME sits at (fx, fy) with angle `ang`. Returns its index. */
  addBody(
    fx: number,
    fy: number,
    ang: number,
    mp: Pick<MassProps, 'mass' | 'cx' | 'cy' | 'inertia'>,
    opts: { kinematic?: boolean; linDrag?: number; angDrag?: number } = {},
  ): number {
    if (this.n >= this.cap) throw new Error('XpbdRig: capacity exceeded');
    const i = this.n++;
    const kin = opts.kinematic === true || mp.mass <= 0;
    this.kinematic[i] = kin ? 1 : 0;
    this.comX[i] = mp.cx;
    this.comY[i] = mp.cy;
    this.invMass[i] = kin ? 0 : 1 / mp.mass;
    this.invInertia[i] = kin || mp.inertia <= 0 ? 0 : 1 / mp.inertia;
    this.linDrag[i] = opts.linDrag ?? 0.6;
    this.angDrag[i] = opts.angDrag ?? 0.8;
    this.a[i] = ang;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    this.x[i] = fx + c * mp.cx - s * mp.cy;
    this.y[i] = fy + s * mp.cx + c * mp.cy;
    this.k0x[i] = this.k1x[i] = fx;
    this.k0y[i] = this.k1y[i] = fy;
    this.k0a[i] = this.k1a[i] = ang;
    return i;
  }

  addJoint(d: JointDef): number {
    this.joints.push({
      a: d.a,
      b: d.b,
      ax: d.ax,
      ay: d.ay,
      bx: d.bx,
      by: d.by,
      hz: d.hz ?? 0,
      zeta: d.zeta ?? 1,
      breakForce: d.breakForce ?? Infinity,
      health: 1,
      broken: false,
      force: 0,
      lambda: 0,
    });
    return this.joints.length - 1;
  }

  addDrive(d: DriveDef): number {
    this.drives.push({ ...d, torque: 0, lambda: 0 });
    return this.drives.length - 1;
  }

  addLimit(d: LimitDef): number {
    this.limits.push({ ...d, lambda: 0 });
    return this.limits.length - 1;
  }

  /** Joint health 0..1 (e.g. live-cell fraction around the joint): scales its stiffness and its failure force. */
  setHealth(j: number, health: number): void {
    const jt = this.joints[j]!;
    jt.health = health < 0 ? 0 : health > 1 ? 1 : health;
    if (jt.health <= 0 && !jt.broken) this.breakJoint(j, 0);
  }

  /** Sever a joint now (cells destroyed, scripted failure). */
  breakJoint(j: number, force: number): void {
    const jt = this.joints[j]!;
    if (jt.broken) return;
    jt.broken = true;
    if (this.breaks.length < 64) this.breaks.push({ joint: j, force, tick: this.tick });
  }

  /**
   * Take body i out of the structure (its region left as debris): break its joints, switch off every drive and limit acting on
   * it, and freeze it where it is (kinematic) so it no longer pulls on anything.
   */
  detach(i: number): void {
    for (let j = 0; j < this.joints.length; j++) {
      const jt = this.joints[j]!;
      if (jt.a === i || jt.b === i) this.breakJoint(j, 0);
    }
    for (const d of this.drives) if (d.a === i || d.b === i) d.off = true;
    for (const l of this.limits) if (l.a === i || l.b === i) l.off = true;
    const fx = this.frameX(i);
    const fy = this.frameY(i);
    this.kinematic[i] = 1;
    this.invMass[i] = 0;
    this.invInertia[i] = 0;
    this.vx[i] = 0;
    this.vy[i] = 0;
    this.w[i] = 0;
    this.k0x[i] = this.k1x[i] = fx;
    this.k0y[i] = this.k1y[i] = fy;
    this.k0a[i] = this.k1a[i] = this.a[i]!;
  }

  /** Update a body's mass properties (cells were destroyed); the frame stays put, the centre of mass moves. */
  setMass(i: number, mp: Pick<MassProps, 'mass' | 'cx' | 'cy' | 'inertia'>): void {
    if (this.kinematic[i]) return;
    const c = Math.cos(this.a[i]!);
    const s = Math.sin(this.a[i]!);
    const dx = mp.cx - this.comX[i]!;
    const dy = mp.cy - this.comY[i]!;
    this.x[i] = this.x[i]! + c * dx - s * dy;
    this.y[i] = this.y[i]! + s * dx + c * dy;
    this.comX[i] = mp.cx;
    this.comY[i] = mp.cy;
    this.invMass[i] = mp.mass > 0 ? 1 / mp.mass : 0;
    this.invInertia[i] = mp.inertia > 0 ? 1 / mp.inertia : 0;
  }

  /** Move a kinematic body's frame to this pose by the end of the next tick (the intent: the eye locks here). */
  setKinematic(i: number, fx: number, fy: number, ang: number): void {
    this.k1x[i] = fx;
    this.k1y[i] = fy;
    this.k1a[i] = ang;
  }

  /** Instant impulse (mass·px/s) at world point (wx, wy). */
  applyImpulse(i: number, ix: number, iy: number, wx: number, wy: number): void {
    if (this.kinematic[i]) return;
    const rx = wx - this.x[i]!;
    const ry = wy - this.y[i]!;
    this.vx[i] = this.vx[i]! + ix * this.invMass[i]!;
    this.vy[i] = this.vy[i]! + iy * this.invMass[i]!;
    this.w[i] = this.w[i]! + (rx * iy - ry * ix) * this.invInertia[i]!;
  }

  /** Frame pose of body i (what the region body's transform is set from). */
  frame(i: number, out: { x: number; y: number; a: number }): void {
    const c = Math.cos(this.a[i]!);
    const s = Math.sin(this.a[i]!);
    out.x = this.x[i]! - (c * this.comX[i]! - s * this.comY[i]!);
    out.y = this.y[i]! - (s * this.comX[i]! + c * this.comY[i]!);
    out.a = this.a[i]!;
  }

  /** World position of a frame-local point of body i. */
  worldPoint(i: number, lx: number, ly: number, out: { x: number; y: number }): void {
    const c = Math.cos(this.a[i]!);
    const s = Math.sin(this.a[i]!);
    const dx = lx - this.comX[i]!;
    const dy = ly - this.comY[i]!;
    out.x = this.x[i]! + c * dx - s * dy;
    out.y = this.y[i]! + s * dx + c * dy;
  }

  /** Advance one 60 Hz tick in RIG_SUBSTEPS substeps. */
  step(): void {
    const h = TICK / RIG_SUBSTEPS;
    const n = this.n;
    for (let i = 0; i < n; i++) {
      if (!this.kinematic[i]) continue;
      this.k0x[i] = this.frameX(i);
      this.k0y[i] = this.frameY(i);
      this.k0a[i] = this.a[i]!;
    }
    // joint force reported for the tick = the largest substep force
    for (let j = 0; j < this.joints.length; j++) this.joints[j]!.force = 0;
    for (let sub = 0; sub < RIG_SUBSTEPS; sub++) {
      const f = (sub + 1) / RIG_SUBSTEPS;
      for (let i = 0; i < n; i++) {
        this.px[i] = this.x[i]!;
        this.py[i] = this.y[i]!;
        this.pa[i] = this.a[i]!;
        if (this.kinematic[i]) {
          const ang = this.k0a[i]! + wrapAngle(this.k1a[i]! - this.k0a[i]!) * f;
          const fx = this.k0x[i]! + (this.k1x[i]! - this.k0x[i]!) * f;
          const fy = this.k0y[i]! + (this.k1y[i]! - this.k0y[i]!) * f;
          const c = Math.cos(ang);
          const s = Math.sin(ang);
          this.a[i] = ang;
          this.x[i] = fx + c * this.comX[i]! - s * this.comY[i]!;
          this.y[i] = fy + s * this.comX[i]! + c * this.comY[i]!;
          continue;
        }
        this.vx[i] = this.vx[i]! + this.gx * h;
        this.vy[i] = this.vy[i]! + this.gy * h;
        this.x[i] = this.x[i]! + this.vx[i]! * h;
        this.y[i] = this.y[i]! + this.vy[i]! * h;
        this.a[i] = this.a[i]! + this.w[i]! * h;
      }
      for (let j = 0; j < this.joints.length; j++) this.joints[j]!.lambda = 0;
      for (let d = 0; d < this.drives.length; d++) this.drives[d]!.lambda = 0;
      for (let it = 0; it < RIG_ITERATIONS; it++) {
        // the soft rotational constraints first, the positional joints last: the structure ends every pass connected
        this.solveDrives(h);
        this.solveLimits();
        this.solveJoints(h);
      }
      for (let i = 0; i < n; i++) {
        this.vx[i] = (this.x[i]! - this.px[i]!) / h;
        this.vy[i] = (this.y[i]! - this.py[i]!) / h;
        this.w[i] = (this.a[i]! - this.pa[i]!) / h;
        if (this.kinematic[i]) continue;
        const kl = 1 - this.linDrag[i]! * h;
        const ka = 1 - this.angDrag[i]! * h;
        this.vx[i] = this.vx[i]! * kl;
        this.vy[i] = this.vy[i]! * kl;
        this.w[i] = this.w[i]! * ka;
      }
    }
    this.tick++;
  }

  private frameX(i: number): number {
    return this.x[i]! - (Math.cos(this.a[i]!) * this.comX[i]! - Math.sin(this.a[i]!) * this.comY[i]!);
  }
  private frameY(i: number): number {
    return this.y[i]! - (Math.sin(this.a[i]!) * this.comX[i]! + Math.cos(this.a[i]!) * this.comY[i]!);
  }

  private solveJoints(h: number): void {
    const h2 = h * h;
    for (let j = 0; j < this.joints.length; j++) {
      const jt = this.joints[j]!;
      if (jt.broken) continue;
      const a = jt.a;
      const b = jt.b;
      // world anchors and lever arms (from the centres of mass)
      const ca = Math.cos(this.a[a]!);
      const sa = Math.sin(this.a[a]!);
      const rax = ca * (jt.ax - this.comX[a]!) - sa * (jt.ay - this.comY[a]!);
      const ray = sa * (jt.ax - this.comX[a]!) + ca * (jt.ay - this.comY[a]!);
      const pax = this.x[a]! + rax;
      const pay = this.y[a]! + ray;
      let pbx: number;
      let pby: number;
      let rbx = 0;
      let rby = 0;
      if (b >= 0) {
        const cb = Math.cos(this.a[b]!);
        const sb = Math.sin(this.a[b]!);
        rbx = cb * (jt.bx - this.comX[b]!) - sb * (jt.by - this.comY[b]!);
        rby = sb * (jt.bx - this.comX[b]!) + cb * (jt.by - this.comY[b]!);
        pbx = this.x[b]! + rbx;
        pby = this.y[b]! + rby;
      } else {
        pbx = jt.bx;
        pby = jt.by;
      }
      let dx = pax - pbx;
      let dy = pay - pby;
      const C = Math.sqrt(dx * dx + dy * dy);
      if (C < 1e-9) continue;
      dx /= C;
      dy /= C;
      const imA = this.invMass[a]!;
      const iiA = this.invInertia[a]!;
      const crA = rax * dy - ray * dx;
      let wsum = imA + iiA * crA * crA;
      let imB = 0;
      let iiB = 0;
      let crB = 0;
      if (b >= 0) {
        imB = this.invMass[b]!;
        iiB = this.invInertia[b]!;
        crB = rbx * dy - rby * dx;
        wsum += imB + iiB * crB * crB;
      }
      if (wsum <= 0) continue;
      // compliance from a natural frequency (mass-independent tuning); health softens the joint
      let alpha = 0;
      let gamma = 0;
      if (jt.hz > 0) {
        const om = TAU * jt.hz * Math.max(0.05, jt.health);
        const k = (om * om) / wsum; // stiffness for the effective mass 1/wsum
        alpha = 1 / (k * h2);
        const cdamp = (2 * jt.zeta * om) / wsum;
        gamma = (alpha * cdamp * h2) / h;
      }
      // relative motion along the constraint gradient this substep (for damping)
      let rel = 0;
      if (gamma > 0) {
        const vax = this.x[a]! - this.px[a]! - (this.a[a]! - this.pa[a]!) * ray;
        const vay = this.y[a]! - this.py[a]! + (this.a[a]! - this.pa[a]!) * rax;
        let vbx = 0;
        let vby = 0;
        if (b >= 0) {
          vbx = this.x[b]! - this.px[b]! - (this.a[b]! - this.pa[b]!) * rby;
          vby = this.y[b]! - this.py[b]! + (this.a[b]! - this.pa[b]!) * rbx;
        }
        rel = (vax - vbx) * dx + (vay - vby) * dy;
      }
      const dl = (-C - alpha * jt.lambda - gamma * rel) / ((1 + gamma) * wsum + alpha);
      jt.lambda += dl;
      const force = Math.abs(jt.lambda) / h2;
      if (force > jt.force) jt.force = force;
      if (force > jt.breakForce * jt.health) {
        this.breakJoint(j, force);
        continue;
      }
      const ix = dl * dx;
      const iy = dl * dy;
      this.x[a] = this.x[a]! + ix * imA;
      this.y[a] = this.y[a]! + iy * imA;
      this.a[a] = this.a[a]! + iiA * (rax * iy - ray * ix);
      if (b >= 0) {
        this.x[b] = this.x[b]! - ix * imB;
        this.y[b] = this.y[b]! - iy * imB;
        this.a[b] = this.a[b]! - iiB * (rbx * iy - rby * ix);
      }
    }
  }

  /** 1 / (inertia about the frame origin) = 1 / (I_com + m·|com|²); 0 for kinematic bodies and the world (−1). */
  private pivotInvInertia(i: number): number {
    if (i < 0 || this.kinematic[i] || this.invInertia[i] === 0) return 0;
    const m = this.invMass[i]! > 0 ? 1 / this.invMass[i]! : 0;
    const I = 1 / this.invInertia[i]! + m * (this.comX[i]! ** 2 + this.comY[i]! ** 2);
    return 1 / I;
  }

  /** Rotate body i by `da` about its frame origin (the centre of mass swings round the pivot). */
  private turnAboutFrame(i: number, da: number): void {
    if (da === 0 || this.kinematic[i]) return;
    const a0 = this.a[i]!;
    const cx = this.comX[i]!;
    const cy = this.comY[i]!;
    const c0 = Math.cos(a0);
    const s0 = Math.sin(a0);
    const c1 = Math.cos(a0 + da);
    const s1 = Math.sin(a0 + da);
    this.x[i] = this.x[i]! + (c1 * cx - s1 * cy) - (c0 * cx - s0 * cy);
    this.y[i] = this.y[i]! + (s1 * cx + c1 * cy) - (s0 * cx + c0 * cy);
    this.a[i] = a0 + da;
  }

  private solveDrives(h: number): void {
    const h2 = h * h;
    for (let d = 0; d < this.drives.length; d++) {
      const dr = this.drives[d]!;
      if (dr.off === true) {
        dr.torque = 0;
        continue;
      }
      const a = dr.a;
      const b = dr.b;
      // about the pivot: the correction turns each body about its frame origin (so the pin there is not disturbed), against
      // the inertia about that point; otherwise about the centre of mass
      const piv = dr.aboutPivot === true;
      const iiA = a >= 0 ? (piv ? this.pivotInvInertia(a) : this.invInertia[a]!) : 0;
      const iiB = piv ? this.pivotInvInertia(b) : this.invInertia[b]!;
      const wsum = iiA + iiB;
      if (wsum <= 0) {
        dr.torque = 0;
        continue;
      }
      const angA = a >= 0 ? this.a[a]! : 0;
      const C = wrapAngle(this.a[b]! - angA - dr.target);
      const om = TAU * dr.hz;
      const k = (om * om) / wsum;
      const alpha = 1 / (k * h2);
      const cdamp = (2 * dr.zeta * om) / wsum;
      const gamma = (alpha * cdamp * h2) / h;
      const rel = this.a[b]! - this.pa[b]! - (a >= 0 ? this.a[a]! - this.pa[a]! : 0);
      const dl = (-C - alpha * dr.lambda - gamma * rel) / ((1 + gamma) * wsum + alpha);
      dr.lambda += dl;
      dr.torque = dr.lambda / h2;
      if (piv) {
        this.turnAboutFrame(b, iiB * dl);
        if (a >= 0) this.turnAboutFrame(a, -iiA * dl);
      } else {
        this.a[b] = this.a[b]! + iiB * dl;
        if (a >= 0) this.a[a] = this.a[a]! - iiA * dl;
      }
    }
  }

  private solveLimits(): void {
    for (let l = 0; l < this.limits.length; l++) {
      const lm = this.limits[l]!;
      if (lm.off === true) continue;
      const a = lm.a;
      const b = lm.b;
      const piv = lm.aboutPivot === true;
      const iiA = a >= 0 ? (piv ? this.pivotInvInertia(a) : this.invInertia[a]!) : 0;
      const iiB = piv ? this.pivotInvInertia(b) : this.invInertia[b]!;
      const wsum = iiA + iiB;
      if (wsum <= 0) continue;
      const rel = wrapAngle(this.a[b]! - (a >= 0 ? this.a[a]! : 0));
      let C = 0;
      if (rel < lm.min) C = rel - lm.min;
      else if (rel > lm.max) C = rel - lm.max;
      else {
        lm.lambda = 0;
        continue;
      }
      const dl = -C / wsum;
      lm.lambda = dl;
      if (piv) {
        this.turnAboutFrame(b, iiB * dl);
        if (a >= 0) this.turnAboutFrame(a, -iiA * dl);
      } else {
        this.a[b] = this.a[b]! + iiB * dl;
        if (a >= 0) this.a[a] = this.a[a]! - iiA * dl;
      }
    }
  }

  /** Remove and return the joint failures since the last call. */
  drainBreaks(into: BreakEvent[]): void {
    for (const e of this.breaks) into.push(e);
    this.breaks.length = 0;
  }

  /** Stable 32-bit hash of the whole state (determinism tests; the fighter folds it into the match hash). */
  hash(): number {
    let hh = 0x811c9dc5 | 0;
    const buf = new Float64Array(1);
    const u = new Uint32Array(buf.buffer);
    const mixF = (v: number): void => {
      buf[0] = v;
      hh = Math.imul(hh ^ u[0]!, 0x01000193);
      hh = Math.imul(hh ^ u[1]!, 0x01000193);
    };
    mixF(this.tick);
    for (let i = 0; i < this.n; i++) {
      mixF(this.x[i]!);
      mixF(this.y[i]!);
      mixF(this.a[i]!);
      mixF(this.vx[i]!);
      mixF(this.vy[i]!);
      mixF(this.w[i]!);
      mixF(this.invMass[i]!);
      mixF(this.comX[i]!);
      mixF(this.comY[i]!);
    }
    for (const j of this.joints) {
      mixF(j.broken ? 1 : 0);
      mixF(j.health);
    }
    for (const d of this.drives) {
      mixF(d.target);
      mixF(d.hz);
      mixF(d.off === true ? 1 : 0);
    }
    for (const l of this.limits) {
      mixF(l.min);
      mixF(l.max);
      mixF(l.off === true ? 1 : 0);
    }
    for (let i = 0; i < this.n; i++) mixF(this.kinematic[i]!);
    return hh >>> 0;
  }
}
