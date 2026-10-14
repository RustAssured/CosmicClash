import type { MaterialDef } from '@/contracts';
import type { CradleRegion } from '@/titans/kit/cradle/paint';
import { XpbdRig, massFromCells, wrapAngle, type MassProps } from '../../../rig/xpbd';
import { DMath } from '@/contracts/dmath';

/**
 * THE CRADLE'S RIG (Gate 2): one XPBD body per region. The knot (the fighter's primary body, the KO core) is kinematic: it is
 * the intent and goes where the fighter goes. The disc hangs on it at the hub as a SAIL: a heavy plate on a slow, under-damped
 * angular drive whose target the behaviour sets from the Cradle's own motion (it tilts back into its travel, lags, overshoots
 * and settles). The cord is a chain of heavy links on point joints at their roots, each held to its rest bend by a slow
 * drive whose frequency falls along the chain: the root answers first, the jaw-organ last, and every link carries its own
 * momentum (WJ, Gate 1: "watch the weighty movement, it's not a string").
 *
 * The rig runs in the FACING frame (x · facing), origin = the knot's frame; rest geometry is the painted composite.
 */

export const CRADLE_RIG = Object.freeze({
  /** The sail: drive frequency (Hz) and damping ratio (under-damped: it overshoots once, slowly), swing cap (rad, ±). */
  discHz: 0.55,
  discZeta: 0.32,
  discLimit: 0.55,
  /** Cord drive frequencies root → tip (Hz) and damping ratio; per-joint bend cap (rad, ±). */
  // (a drive is tuned against its own link's inertia, but turns every link below it too: the frequencies you SEE are about a
  // third of these)
  cordHz: [2.2, 1.9, 1.7, 1.5, 1.3, 1.2] as readonly number[],
  jawHz: 1.1,
  /** The tone that holds the cord hanging under the body (absolute-angle drives, Hz at the root; less down the chain). */
  hangHz: 1.8,
  cordZeta: 0.34,
  cordLimit: 0.5,
  /** Soft stops beyond the caps. */
  limitHz: 0.9,
  limitZeta: 0.8,
  /** The cord's flesh is dense: its links weigh this much more than their cells (weight is momentum, not size). */
  cordMass: 3.2,
  /** The disc is a broad, light plate that the medium pushes (a sail): its inertia as painted. */
  discMass: 1,
  /** Drag (per second): low, so what moves keeps moving. */
  linDrag: 0.8,
  angDragDisc: 0.6,
  angDragCord: 3,
});

export interface CradleRigBuild {
  rig: XpbdRig;
  /** Rig body per region index (regions[0] = the knot). */
  bodyOf: Int16Array;
  knot: number;
  disc: number;
  /** Cord bodies root → tip, the jaw-organ last (index into `rig`); and per cord body its joint and drive. */
  cord: number[];
  cordJoint: number[];
  cordDrive: number[];
  /** Per cord body: its absolute-angle drive (off at rest) and the painted direction (rad) of the link, pivot to next pivot. */
  headDrive: number[];
  restDir: number[];
  discDrive: number;
  /** Per cord body: the bend (rad) that straightens the cord there (undoes the painted S at that joint). */
  straighten: number[];
  /** Per region: the pivot corner (integer px in its map) and its rest frame position (facing frame, knot frame origin). */
  pivot: { ax: number; ay: number; fx: number; fy: number }[];
  /** The jaw-organ's tip (frame-local px of the last cord body) and the cord's rest length (px). */
  tipX: number;
  tipY: number;
  length: number;
}

const mp = (): MassProps => ({ mass: 0, cx: 0, cy: 0, inertia: 0, cells: 0 });

/** Mass-per-cell table (material id → mass at density 128) from a resolved material table. */
export function densityTable(materials: readonly MaterialDef[]): Float64Array {
  const d = new Float64Array(256);
  for (let i = 0; i < materials.length; i++) d[i] = materials[i]!.density;
  return d;
}

/**
 * Build the rig from the painted regions. `originX/Y` is the knot frame's position in the facing frame (the fighter's root);
 * `knotCorner` the composite point that frame origin stands for (the knot map's anchor corner).
 */
export function buildCradleRig(
  regions: readonly CradleRegion[],
  maps: readonly { w: number; h: number; material: Uint8Array; density: Uint8Array }[],
  materials: readonly MaterialDef[],
  originX: number,
  originY: number,
  knotCorner: { x: number; y: number },
  jawTip: { x: number; y: number },
): CradleRigBuild {
  const T = CRADLE_RIG;
  const dens = densityTable(materials);
  const n = regions.length;
  // room for regrown links (each sever and regrowth appends bodies; detached ones stay as frozen husks)
  const rig = new XpbdRig(n + 64);
  const bodyOf = new Int16Array(n).fill(-1);
  const pivot = regions.map((r) => {
    const ax = Math.round(r.pivotX - r.ox);
    const ay = Math.round(r.pivotY - r.oy);
    return { ax, ay, fx: r.ox + ax - knotCorner.x, fy: r.oy + ay - knotCorner.y };
  });
  // the bends that straighten the painted S: the turn between consecutive links' directions (pivot to next pivot)
  const cordRegions = regions
    .map((r, i) => ({ r, i }))
    .filter((q) => q.r.kind === 'cord' || q.r.kind === 'jaw');
  const dirs: number[] = [];
  let length = 0;
  for (let k = 0; k < cordRegions.length; k++) {
    const a = pivot[cordRegions[k]!.i]!;
    const nb =
      k + 1 < cordRegions.length
        ? pivot[cordRegions[k + 1]!.i]!
        : { fx: jawTip.x - knotCorner.x, fy: jawTip.y - knotCorner.y };
    dirs.push(DMath.atan2(nb.fy - a.fy, nb.fx - a.fx));
    length += DMath.hypot(nb.fx - a.fx, nb.fy - a.fy);
  }
  // the first link's bend is measured from straight down (the knot holds the cord hanging)
  const straighten = dirs.map((d, k) => wrapAngle((k === 0 ? Math.PI / 2 : dirs[k - 1]!) - d));
  // the knot: kinematic at the root
  const k0 = pivot[0]!;
  const knot = rig.addBody(originX + k0.fx, originY + k0.fy, 0, mp(), { kinematic: true });
  bodyOf[0] = knot;
  let disc = -1;
  let discDrive = -1;
  const cord: number[] = [];
  const cordJoint: number[] = [];
  const cordDrive: number[] = [];
  const headDrive: number[] = [];
  let prev = knot;
  let prevI = 0;
  for (let i = 1; i < n; i++) {
    const r = regions[i]!;
    const pv = pivot[i]!;
    const m = massFromCells(maps[i]!, dens, pv.ax, pv.ay, mp());
    const heavy = r.kind === 'disc' ? T.discMass : T.cordMass;
    m.mass *= heavy;
    m.inertia *= heavy;
    const b = rig.addBody(originX + pv.fx, originY + pv.fy, 0, m, {
      linDrag: T.linDrag,
      angDrag: r.kind === 'disc' ? T.angDragDisc : T.angDragCord,
    });
    bodyOf[i] = b;
    if (r.kind === 'disc') {
      disc = b;
      rig.addJoint({ a: b, b: knot, ax: 0, ay: 0, bx: pv.fx - k0.fx, by: pv.fy - k0.fy });
      discDrive = rig.addDrive({ a: knot, b, target: 0, hz: T.discHz, zeta: T.discZeta, aboutPivot: true });
      rig.addLimit({
        a: knot,
        b,
        min: -T.discLimit,
        max: T.discLimit,
        aboutPivot: true,
        hz: T.limitHz,
        zeta: T.limitZeta,
      });
      continue;
    }
    // a cord link (or the jaw-organ): pinned at its root to the previous link (the first one to the knot)
    const pp = pivot[prevI]!;
    const k = cord.length;
    cordJoint.push(rig.addJoint({ a: b, b: prev, ax: 0, ay: 0, bx: pv.fx - pp.fx, by: pv.fy - pp.fy }));
    const hz = r.kind === 'jaw' ? T.jawHz : T.cordHz[Math.min(k, T.cordHz.length - 1)]!;
    cordDrive.push(rig.addDrive({ a: prev, b, target: 0, hz, zeta: T.cordZeta, aboutPivot: true }));
    // the muscle that throws it: an absolute-angle drive per link, off at rest (moves aim each link directly, so the
    // root's drive never has to haul the whole chain round on its own)
    headDrive.push(rig.addDrive({ a: -1, b, target: 0, hz: 1, zeta: 0.55, aboutPivot: true, off: true }));
    // each joint may bend as far as straightening the painted S needs (and a little past it), and back as far again: the
    // root swings from hanging to any aim
    const sk = straighten[k] ?? 0;
    rig.addLimit({
      a: prev,
      b,
      min: k === 0 ? -2.5 : Math.min(0, sk) - T.cordLimit,
      max: k === 0 ? 1.1 : Math.max(0, sk) + T.cordLimit,
      aboutPivot: true,
      hz: T.limitHz,
      zeta: T.limitZeta,
    });
    // and no link ever turns past itself in the world (a cord thrown hard must not wind round its root)
    rig.addLimit({ a: -1, b, min: -2.6, max: 1.6, aboutPivot: true, hz: 3, zeta: 1 });
    cord.push(b);
    prev = b;
    prevI = i;
  }
  const last = cordRegions[cordRegions.length - 1]!;
  const lp = pivot[last.i]!;
  return {
    rig,
    bodyOf,
    knot,
    disc,
    cord,
    cordJoint,
    cordDrive,
    headDrive,
    restDir: dirs,
    discDrive,
    straighten,
    pivot,
    tipX: jawTip.x - knotCorner.x - lp.fx,
    tipY: jawTip.y - knotCorner.y - lp.fy,
    length,
  };
}
