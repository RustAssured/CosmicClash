import { clamp, type OrbitState } from '@/contracts';

/**
 * Planar orbital footwork (SLICE_PLAN §4.3/§6, `footwork: 'orbit'`). Pure helpers shared by the fighter, the AI and the tools.
 *
 * The physics runs in a SCALED plane S = (x, y·EY): orbits that are circles in S are ellipses on screen, flattened so two
 * 150–200 px bodies circling each other still fit the 640×360 view. In S every direction is equal: the stick asks for thrust,
 * which is split into a tangential part (around the foe, full strength) and a radial part (toward/away, weaker), plus a
 * gentle mutual gravity, so bodies curve, close, widen, cross and slingshot instead of walking on rails. Momentum is
 * conserved with drag: what a blow or a collision puts into the velocity stays there until drag or thrust takes it out.
 */
export const ORBIT = {
  /** Vertical stretch of the scaled plane: a circular orbit in S is EY times wider than tall on screen. */
  ey: 1.6,
  /** Thrust gains along the tangent (around the foe) and the radius (toward / away). */
  tangential: 1,
  radial: 0.55,
  /** Thrust acceleration as a multiple of the titan's top speed per second (≈ 70 % of top speed in 0.3 s: D28 scale). */
  thrustPerTop: 2.5,
  /** Above top speed, the velocity component ALONG the thrust relaxes back to top speed with this time constant (s). */
  capTau: 0.2,
  /** Drag time constant (s) while thrusting (space is nearly frictionless; this is the long glide). */
  dragTau: 3,
  /**
   * Mutual gravity toward the foe (px/s²): G × (foeMass/5) × (foeGravity/5) × (200 / max(r, rMin))², capped. A mass-5,
   * gravity-5 foe pulls with 70 px/s² at 200 px; the Planet (8, 7) pulls the Witness at the cap.
   */
  gravityG: 25,
  gravityRMin: 140,
  gravityMax: 60,
  /**
   * Orbit assist: while the stick pushes along the tangent, this share of the centripetal acceleration v_t²/r is supplied,
   * so holding a direction around the foe CIRCLES it (a slow outward spiral) instead of flying off on a tangent; radial
   * input then closes or widens the orbit and letting go coasts on momentum.
   */
  assist: 0.85,
  /** Radial tether in S: graded bleed of outward speed from `tetherSoft`, hard cap at `tetherMax`. */
  tetherSoft: 330,
  tetherMax: 430,
  /** Classification thresholds (S-space px/s). */
  radialBand: 40,
  orbitSpeed: 50,
  collisionTime: 0.6,
  collisionSpeed: 110,
  slingSpeedMul: 1.12,
  slingTicks: 40,
} as const;

/** Depth-offset prototype (`zdepth`): depth range, collision gate, the scale hint the renderer may apply, and the return spring. */
export const ZDEPTH = {
  /** |z| never exceeds this many px. +z = toward the viewer. */
  max: 36,
  /** Bodies further apart in depth than this neither collide nor hit each other. */
  collide: 18,
  /** Scale hint at |z| = max (±12 %, SLICE_PLAN §5). */
  scale: 0.12,
  /** Speed (px/s) a Surge gives along z, and the spring that always pulls back to the plane (1/s², 1/s). */
  surgeSpeed: 260,
  k: 16,
  c: 6.5,
} as const;

/** Draw-scale hint for a depth offset: 1 at the plane, 1 ± 0.12 at the depth limits (+z toward the viewer = bigger). */
export const zScale = (z: number): number => 1 + ZDEPTH.scale * clamp(z / ZDEPTH.max, -1, 1);

/** Parallax hint for a depth offset: how much a body at depth `z` shifts with the camera relative to the plane (0 at z = 0). */
export const zParallax = (z: number): number => 0.25 * clamp(z / ZDEPTH.max, -1, 1);

/** Scratch frame of the relative geometry, in the scaled plane. */
export interface OrbitFrame {
  /** Elliptical (scaled) distance to the foe. */
  r: number;
  /** Unit radial (toward the foe) and tangent (90° clockwise from it), in S. */
  nx: number;
  ny: number;
  tx: number;
  ty: number;
  /** Velocity relative to the foe in S, split along n (negative = closing) and t. */
  vr: number;
  vt: number;
  /** Absolute speed in S. */
  speed: number;
}

export function makeOrbitFrame(): OrbitFrame {
  return { r: 0, nx: 1, ny: 0, tx: 0, ty: 1, vr: 0, vt: 0, speed: 0 };
}

/**
 * Fill `out` with the geometry of a body at (x, y) moving at (vx, vy) relative to a foe at (fx, fy) moving at (fvx, fvy).
 * All inputs are screen space; the frame is in S.
 */
export function orbitFrame(
  x: number,
  y: number,
  vx: number,
  vy: number,
  fx: number,
  fy: number,
  fvx: number,
  fvy: number,
  out: OrbitFrame,
): OrbitFrame {
  const EY = ORBIT.ey;
  const dx = fx - x;
  const dy = (fy - y) * EY;
  const r = Math.hypot(dx, dy);
  out.r = r;
  if (r > 1e-6) {
    out.nx = dx / r;
    out.ny = dy / r;
  } else {
    out.nx = 1;
    out.ny = 0;
  }
  out.tx = -out.ny;
  out.ty = out.nx;
  // own velocity relative to the foe's, in S: radial (toward the foe positive), so closing = negative vr
  const rvx = vx - fvx;
  const rvy = (vy - fvy) * EY;
  out.vr = -(rvx * out.nx + rvy * out.ny);
  out.vt = rvx * out.tx + rvy * out.ty;
  out.speed = Math.hypot(vx, vy * EY);
  return out;
}

/** Per-fighter memory the classifier needs (perigee detection for slingshots). */
export interface OrbitMemory {
  prevVr: number;
  sling: number;
}

/**
 * The readable orbital state of a body (SLICE_PLAN §5): `collision` (closing fast enough to meet within ~0.6 s), `slingshot`
 * (just swung past its closest approach faster than it can coast), `closing` / `widening` (radial speed dominates), `orbit`
 * (circling), `neutral` (drifting). `contactR` is the scaled distance at which the two bodies touch.
 */
export function classifyOrbit(f: OrbitFrame, top: number, contactR: number, mem: OrbitMemory): OrbitState {
  const O = ORBIT;
  // closest approach just passed (radial speed turned from closing to opening) at more than coasting speed: a slingshot
  const passedPerigee = mem.prevVr < -10 && f.vr >= -10;
  if (passedPerigee && f.speed > top * O.slingSpeedMul && f.r < contactR * 1.9) mem.sling = O.slingTicks;
  mem.prevVr = f.vr;
  if (mem.sling > 0) {
    mem.sling--;
    if (f.vr > O.radialBand) return 'slingshot';
  }
  const closing = -f.vr;
  if (closing > O.collisionSpeed && (f.r - contactR) / closing < O.collisionTime) return 'collision';
  if (f.vr < -O.radialBand) return 'closing';
  if (f.vr > O.radialBand) return 'widening';
  if (Math.abs(f.vt) > O.orbitSpeed) return 'orbit';
  return 'neutral';
}
