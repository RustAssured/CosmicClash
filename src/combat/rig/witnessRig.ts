import type { MaterialDef } from '@/contracts';
import type { WitnessBody } from '@/titans/art/lastone';
import { XpbdRig, massFromCells, type MassProps } from './xpbd';
import type { RigAnchor } from './witnessDraw';

/**
 * Build the Witness's XPBD rig from its painted regions (`paintWitness`): one rig body per rigid region (the interior reveal
 * layers are welded into the carapace's body), mass and inertia from their live cells, joints at the region pivots, and
 * angular drives that hold every region at its rest angle relative to its parent. The drive frequencies set the ORDER OF
 * MOTION: the eye (kinematic) is the intent and leads; the carapace follows stiffly; the heavy shrine shifts the mass;
 * arms, spires and halo arcs lag and settle last.
 */

export interface WitnessRigTuning {
  carapaceHz: number;
  shrineHz: number;
  haloHz: readonly number[];
  armRootHz: number;
  armHz: number;
  zeta: number;
  armZeta: number;
  /** Relative angle limit of every arm joint (rad), ±. */
  armLimit: number;
  /** Caps (rad, ±) on how far a part may swing from the carapace (D28: a blow makes the structure sway, never scatter). */
  armAbsLimit: number;
  haloLimit: number;
  shrineLimit: number;
  /** The caps are soft stops: beyond them a damped spring of this frequency (Hz; ω ≤ 7 rad/s, D28) and damping ratio. */
  limitHz: number;
  limitZeta: number;
  /**
   * Arms also chase the HEADING (the eye's angle) directly, with frequencies falling along the chain: the root follows first,
   * the tip last. Without it a chain pinned to a fast-turning carapace whips past the heading and rings.
   */
  armHeadingHz: readonly number[];
  armHeadingZeta: number;
  /** Idle sway: amplitude (rad) and period range (s) of the slow breathing of arms and halo arcs (D28: periods of seconds). */
  swayAmp: number;
  swayPeriod: readonly [number, number];
  haloDrift: number;
}

export const WITNESS_RIG_TUNING: Readonly<WitnessRigTuning> = Object.freeze({
  // colossal scale (D28): nothing above ~1.2 Hz; the structure turns in ≈ 0.5 s, the mass and the long parts in seconds
  carapaceHz: 0.6,
  shrineHz: 0.5,
  haloHz: [0.42, 0.5, 0.33, 0.45, 0.38],
  armRootHz: 0.4,
  armHz: 0.5,
  zeta: 0.9,
  armZeta: 0.95,
  armLimit: 0.5,
  armAbsLimit: 0.6,
  haloLimit: 0.3,
  shrineLimit: 0.35,
  limitHz: 0.64,
  limitZeta: 1,
  armHeadingHz: [0.42, 0.33],
  armHeadingZeta: 0.9,
  swayAmp: 0.05,
  swayPeriod: [3.2, 5.5] as const,
  haloDrift: 0.035,
});

export interface WitnessRig {
  rig: XpbdRig;
  /** Rig body of every region (welded regions share their parent's body). */
  bodyOf: Int16Array;
  /** The eye's rig body (kinematic). */
  eye: number;
  carapace: number;
  shrine: number;
  halo: number[];
  /** Per arm: its segment bodies (root first) and its joint chain as anchors (joints, then the tip). */
  arms: { bodies: number[]; chain: RigAnchor[] }[];
  /** Drives whose target is the heading (see setWitnessHeading), and the halo arcs' drives (they drift). */
  headingDrives: number[];
  haloDrives: number[];
  /** Swing caps of the halo arcs and of every arm segment (indices into `rig.limits`); moves widen them for a while. */
  haloLimits: number[];
  armLimits: number[];
  /** Per rig body: the joint pinning it to its parent and its rest drive (−1 for the eye). */
  jointOf: Int16Array;
  driveOf: Int16Array;
  tuning: Readonly<WitnessRigTuning>;
}

/**
 * Point every heading drive at the eye's current angle (call each tick with the intent). With `tick`, the long parts also
 * breathe: each arm sways by a few hundredths of a radian with its own period of 3–5.5 s, the halo arcs drift in and out of
 * phase more slowly still. Deterministic in the tick.
 */
export function setWitnessHeading(wr: WitnessRig, angle: number, tick = -1): void {
  const t = wr.tuning;
  for (let k = 0; k < wr.headingDrives.length; k++) {
    let sway = 0;
    if (tick >= 0) {
      const period = t.swayPeriod[0] + ((k * 0.618034) % 1) * (t.swayPeriod[1] - t.swayPeriod[0]);
      sway = t.swayAmp * Math.sin((2 * Math.PI * tick) / (60 * period) + k * 1.7);
    }
    wr.rig.drives[wr.headingDrives[k]!]!.target = angle + sway;
  }
  if (tick >= 0)
    for (let k = 0; k < wr.haloDrives.length; k++)
      wr.rig.drives[wr.haloDrives[k]!]!.target =
        t.haloDrift * Math.sin((2 * Math.PI * tick) / (60 * (6 + 1.3 * k)) + k * 2.1);
}

/** Combine two mass properties given in the same frame (parallel-axis theorem). */
function combine(a: MassProps, b: MassProps): MassProps {
  const m = a.mass + b.mass;
  if (m <= 0) return a;
  const cx = (a.mass * a.cx + b.mass * b.cx) / m;
  const cy = (a.mass * a.cy + b.mass * b.cy) / m;
  const ia = a.inertia + a.mass * ((a.cx - cx) ** 2 + (a.cy - cy) ** 2);
  const ib = b.inertia + b.mass * ((b.cx - cx) ** 2 + (b.cy - cy) ** 2);
  return { mass: m, cx, cy, inertia: ia + ib, cells: a.cells + b.cells };
}

export function buildWitnessRig(
  w: WitnessBody,
  materials: readonly MaterialDef[],
  originX: number,
  originY: number,
  t: Readonly<WitnessRigTuning> = WITNESS_RIG_TUNING,
): WitnessRig {
  const dens = new Float64Array(256);
  for (let i = 0; i < materials.length; i++) dens[i] = materials[i]!.density;
  const n = w.regions.length;
  // mass properties per region in its own frame (frame origin = pivot)
  const props: MassProps[] = w.regions.map((r) =>
    massFromCells(r.map, dens, r.pivotX - r.ox, r.pivotY - r.oy, {
      mass: 0,
      cx: 0,
      cy: 0,
      inertia: 0,
      cells: 0,
    }),
  );
  // weld interior layers into their parent (same pivot)
  const owner = new Int16Array(n);
  for (let i = 0; i < n; i++) owner[i] = w.regions[i]!.weld ? w.regions[i]!.parent : i;
  for (let i = 0; i < n; i++) if (owner[i] !== i) props[owner[i]!] = combine(props[owner[i]!]!, props[i]!);
  const rig = new XpbdRig(n + 1);
  const bodyOf = new Int16Array(n).fill(-1);
  let eye = -1;
  let carapace = -1;
  let shrine = -1;
  const halo: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = w.regions[i]!;
    if (owner[i] !== i) continue;
    const kinematic = r.parent < 0;
    // light parts get some angular drag so they settle without ringing; the eye is driven
    const b = rig.addBody(originX + r.pivotX, originY + r.pivotY, 0, props[i]!, {
      kinematic,
      linDrag: 1.2,
      angDrag: r.kind === 'arm' ? 4 : r.kind === 'halo' ? 2 : 1.3,
    });
    bodyOf[i] = b;
    if (kinematic) eye = b;
    if (r.kind === 'carapace') carapace = b;
    if (r.kind === 'shrine') shrine = b;
    if (r.kind === 'halo') halo.push(b);
  }
  for (let i = 0; i < n; i++) if (owner[i] !== i) bodyOf[i] = bodyOf[owner[i]!]!;
  // joints at the pivots and the angular drives
  let haloK = 0;
  const headingDrives: number[] = [];
  const haloDrives: number[] = [];
  const haloLimits: number[] = [];
  const armLimits: number[] = [];
  const jointOf = new Int16Array(n + 1).fill(-1);
  const driveOf = new Int16Array(n + 1).fill(-1);
  for (let i = 0; i < n; i++) {
    const r = w.regions[i]!;
    if (owner[i] !== i || r.parent < 0) continue;
    const p = w.regions[r.parent]!;
    const a = bodyOf[i]!;
    const b = bodyOf[r.parent]!;
    jointOf[a] = rig.addJoint({ a, b, ax: 0, ay: 0, bx: r.pivotX - p.pivotX, by: r.pivotY - p.pivotY });
    let hz: number;
    let zeta = t.zeta;
    if (r.kind === 'carapace') hz = t.carapaceHz;
    else if (r.kind === 'shrine') {
      hz = t.shrineHz;
      rig.addLimit({
        a: carapace,
        b: a,
        min: -t.shrineLimit,
        max: t.shrineLimit,
        aboutPivot: true,
        hz: t.limitHz,
        zeta: t.limitZeta,
      });
    } else if (r.kind === 'halo') {
      hz = t.haloHz[haloK++ % t.haloHz.length]!;
      haloLimits.push(
        rig.addLimit({
          a: carapace,
          b: a,
          min: -t.haloLimit,
          max: t.haloLimit,
          aboutPivot: true,
          hz: t.limitHz,
          zeta: t.limitZeta,
        }),
      );
    } else {
      hz = r.segment === 0 ? t.armRootHz : t.armHz;
      zeta = t.armZeta;
      rig.addLimit({
        a: b,
        b: a,
        min: -t.armLimit,
        max: t.armLimit,
        aboutPivot: true,
        hz: t.limitHz,
        zeta: t.limitZeta,
      });
      armLimits.push(
        rig.addLimit({
          a: carapace,
          b: a,
          min: -t.armAbsLimit,
          max: t.armAbsLimit,
          aboutPivot: true,
          hz: t.limitHz,
          zeta: t.limitZeta,
        }),
      );
    }
    // halo arcs orbit the eye but are DRIVEN by the carapace: the ring follows the structure, a beat behind it (D28 load wave)
    const di = rig.addDrive({
      a: r.kind === 'halo' ? carapace : b,
      b: a,
      target: 0,
      hz,
      zeta,
      aboutPivot: true,
    });
    driveOf[a] = di;
    if (r.kind === 'halo') haloDrives.push(di);
    if (r.kind === 'arm') {
      const hh = t.armHeadingHz[Math.min(r.segment, t.armHeadingHz.length - 1)]!;
      if (hh > 0)
        headingDrives.push(
          rig.addDrive({ a: -1, b: a, target: 0, hz: hh, zeta: t.armHeadingZeta, aboutPivot: true }),
        );
    }
  }
  // arm chains: joints are the segment pivots (in each segment's frame: 0,0), the tip in the last segment's frame
  const arms = w.arms.map((arm) => {
    const bodies = arm.regions.map((ri) => bodyOf[ri]!);
    const chain: RigAnchor[] = arm.regions.map((ri) => ({ body: bodyOf[ri]!, x: 0, y: 0 }));
    const last = w.regions[arm.regions[arm.regions.length - 1]!]!;
    const tip = arm.points[arm.points.length - 1]!;
    chain.push({
      body: bodyOf[arm.regions[arm.regions.length - 1]!]!,
      x: tip.x - last.pivotX,
      y: tip.y - last.pivotY,
    });
    return { bodies, chain };
  });
  return {
    rig,
    bodyOf,
    eye,
    carapace,
    shrine,
    halo,
    arms,
    headingDrives,
    haloDrives,
    haloLimits,
    armLimits,
    jointOf,
    driveOf,
    tuning: t,
  };
}
