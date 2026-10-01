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
  /**
   * Arms also chase the HEADING (the eye's angle) directly, with frequencies falling along the chain: the root follows first,
   * the tip last. Without it a chain pinned to a fast-turning carapace whips past the heading and rings.
   */
  armHeadingHz: readonly number[];
  armHeadingZeta: number;
}

export const WITNESS_RIG_TUNING: Readonly<WitnessRigTuning> = Object.freeze({
  carapaceHz: 4.5,
  shrineHz: 1.9,
  haloHz: [1.4, 1.7, 1.1, 1.5],
  armRootHz: 2,
  armHz: 1.8,
  zeta: 0.85,
  armZeta: 1.4,
  armLimit: 0.75,
  armHeadingHz: [1.9, 1.6, 1.35, 1.2],
  armHeadingZeta: 1,
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
  /** Drives whose target is the heading (see setWitnessHeading). */
  headingDrives: number[];
}

/** Point every heading drive at the eye's current angle (call each tick with the intent). */
export function setWitnessHeading(wr: WitnessRig, angle: number): void {
  for (const d of wr.headingDrives) wr.rig.drives[d]!.target = angle;
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
      angDrag: r.kind === 'arm' ? 6 : r.kind === 'halo' ? 2.5 : 1.4,
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
  for (let i = 0; i < n; i++) {
    const r = w.regions[i]!;
    if (owner[i] !== i || r.parent < 0) continue;
    const p = w.regions[r.parent]!;
    const a = bodyOf[i]!;
    const b = bodyOf[r.parent]!;
    rig.addJoint({ a, b, ax: 0, ay: 0, bx: r.pivotX - p.pivotX, by: r.pivotY - p.pivotY });
    let hz: number;
    let zeta = t.zeta;
    if (r.kind === 'carapace') hz = t.carapaceHz;
    else if (r.kind === 'shrine') hz = t.shrineHz;
    else if (r.kind === 'halo') hz = t.haloHz[haloK++ % t.haloHz.length]!;
    else {
      hz = r.segment === 0 ? t.armRootHz : t.armHz;
      zeta = t.armZeta;
      rig.addLimit({ a: b, b: a, min: -t.armLimit, max: t.armLimit });
    }
    rig.addDrive({ a: b, b: a, target: 0, hz, zeta, aboutPivot: true });
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
  return { rig, bodyOf, eye, carapace, shrine, halo, arms, headingDrives };
}
