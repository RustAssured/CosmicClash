import { clamp01 } from '@/contracts';
import type { Overlay } from '../fx/overlay';
import { SplinePen, type SplineStyle } from '../fx/spline';
import type { XpbdRig } from './xpbd';

/**
 * Runtime drawing of the Witness's soft structure on top of `SplinePen`, driven by `XpbdRig` state:
 *
 *  - tension MEMBRANES: dithered opaque triangles between three constraint endpoints. The free edge (b → c) sags when the
 *    membrane is slack and pulls straight (and its edge lights up cyan-white) when it is stretched; `tear` (0..1) opens a
 *    jagged tear from the free edge toward the root (a), and at 1 the membrane has parted into two flaps;
 *  - luminous FIBRES: thin glowing threads between two endpoints that sag with slack; torn, they hang as two halves;
 *  - ARMS: tapered, lit splines through a joint chain (the spine), with the blade drawn as a second, offset stroke on the
 *    blade side.
 *
 * Everything is world-space (logical px), deterministic, and allocation-free per call (scratch buffers are sized once).
 */

export interface MembraneStyle {
  /** Two dark celadons, ordered-dithered 50 % (opaque). */
  fill0: number;
  fill1: number;
  /** The free edge at rest, and when stretched (tension light, white-gold/cyan, never red). */
  edge: number;
  edgeHot: number;
  emissiveHot: number;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x: number, y: number): number => (BAYER4[((y & 3) << 2) | (x & 3)]! + 0.5) / 16;
/** Small deterministic hash in 0..1 (jagged tear edges). */
const hash = (a: number, b: number): number => {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};

export class WitnessSoftPen {
  readonly pen: SplinePen;
  private readonly xs = new Float32Array(16);
  private readonly ys = new Float32Array(16);
  private readonly ox = new Float32Array(16);
  private readonly oy = new Float32Array(16);

  constructor(w: number, h: number) {
    this.pen = new SplinePen(w, h);
  }

  setLight(dir: readonly number[]): void {
    this.pen.setLight(dir);
  }

  /**
   * A tension membrane between root `a` and the free edge `b → c`. `restLen` is the free edge's rest length: shorter than that
   * it sags (by up to 22 % of its length), longer it is taut and lit. Returns the number of pixels drawn.
   */
  membrane(
    ov: Overlay,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    restLen: number,
    tear: number,
    st: MembraneStyle,
  ): number {
    const len = Math.hypot(cx - bx, cy - by) || 1;
    const stretch = len / Math.max(1, restLen);
    const slack = clamp01(1 - stretch);
    const hot = clamp01((stretch - 1.05) / 0.2);
    // the free edge sags toward the root: a parabola of depth `sag` (px) inward from the chord b → c
    const sag = (0.06 + 0.22 * slack) * len;
    let nx = -(cy - by) / len;
    let ny = (cx - bx) / len;
    if (nx * (ax - bx) + ny * (ay - by) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1) return 0;
    const sgn = area > 0 ? 1 : -1;
    const x0 = Math.floor(Math.min(ax, bx, cx));
    const x1 = Math.ceil(Math.max(ax, bx, cx));
    const y0 = Math.floor(Math.min(ay, by, cy));
    const y1 = Math.ceil(Math.max(ay, by, cy));
    // tear: from the middle of the free edge toward the root, `tear` of the way, widening as it opens
    const mx = (bx + cx) / 2 + nx * sag;
    const my = (by + cy) / 2 + ny * sag;
    const tx = mx + (ax - mx) * clamp01(tear * 1.05);
    const ty = my + (ay - my) * clamp01(tear * 1.05);
    const tlen = Math.hypot(tx - mx, ty - my);
    const tw = 0.6 + 2.6 * tear;
    let n = 0;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const e0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * sgn;
        const e1 = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) * sgn;
        const e2 = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) * sgn;
        if (e0 < 0 || e1 < 0 || e2 < 0) continue;
        // distance in from the free edge, against the sag of the edge at this point
        const t = clamp01(((px - bx) * (cx - bx) + (py - by) * (cy - by)) / (len * len));
        const din = e1 / len;
        const sagHere = sag * 4 * t * (1 - t);
        if (din < sagHere) continue;
        if (tear > 0 && tlen > 0.5) {
          // distance to the tear line, jagged
          const q = clamp01(((px - mx) * (tx - mx) + (py - my) * (ty - my)) / (tlen * tlen));
          const dx = px - (mx + (tx - mx) * q);
          const dy = py - (my + (ty - my) * q);
          const jag = (hash(x, y) - 0.5) * 1.4;
          const open = tw * (1 - q * 0.6);
          if (Math.hypot(dx, dy) + jag < open && q < 0.999) continue;
          // a fully parted membrane loses a little more around the tear as the flaps curl back
          if (tear >= 1 && Math.hypot(dx, dy) < open + 1.5) continue;
        }
        let c = bayer(x, y) < 0.5 ? st.fill0 : st.fill1;
        let em = 0;
        if (din < sagHere + 1.1) {
          c = hot > 0.2 ? st.edgeHot : st.edge;
          em = Math.round(st.emissiveHot * hot);
        }
        ov.set(x, y, c, em);
        n++;
      }
    return n;
  }

  /**
   * A luminous fibre from `a` to `b` with rest length `restLen`: it sags by its slack; torn (`tear` ≥ 0.5) it hangs as two
   * halves from its ends. Returns the pixels drawn.
   */
  fibre(
    ov: Overlay,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    restLen: number,
    tear: number,
    st: SplineStyle,
  ): number {
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const N = 7;
    const xs = this.xs;
    const ys = this.ys;
    if (tear < 0.5) {
      const slack = Math.max(0, restLen - len);
      const sag = Math.min(len * 0.5, Math.sqrt(slack * len) * 0.6 + 1);
      for (let k = 0; k < N; k++) {
        const t = k / (N - 1);
        xs[k] = ax + (bx - ax) * t;
        ys[k] = ay + (by - ay) * t + sag * 4 * t * (1 - t);
      }
      return this.pen.stroke(ov, xs, ys, 0, N, N, st, 1, 1, 0.5);
    }
    // two halves, each half the rest length, hanging from its end and curling down
    let n = 0;
    const half = restLen * 0.5;
    for (const [sx, sy, dir] of [
      [ax, ay, 1],
      [bx, by, -1],
    ] as const) {
      const hx = ((bx - ax) / len) * dir;
      const hy = ((by - ay) / len) * dir;
      for (let k = 0; k < N; k++) {
        const t = k / (N - 1);
        const fall = t * t * half * 0.9;
        xs[k] = sx + hx * half * t * 0.5;
        ys[k] = sy + hy * half * t * 0.5 + fall;
      }
      n += this.pen.stroke(ov, xs, ys, 0, N, N, st, 1, 1, 0.3);
    }
    return n;
  }

  /**
   * An arm through `n` joint points (world): the spine as a tapered lit spline, and the blade as a second stroke offset to
   * `bladeSide` (+1 = left of the direction of travel) by `bladeOffset` px at its widest. Returns the pixels drawn.
   */
  arm(
    ov: Overlay,
    px: ArrayLike<number>,
    py: ArrayLike<number>,
    n: number,
    spine: SplineStyle,
    blade: SplineStyle,
    bladeSide: number,
    bladeOffset: number,
  ): number {
    const ox = this.ox;
    const oy = this.oy;
    for (let k = 0; k < n; k++) {
      const a = Math.max(0, k - 1);
      const b = Math.min(n - 1, k + 1);
      const tx = px[b]! - px[a]!;
      const ty = py[b]! - py[a]!;
      const tl = Math.hypot(tx, ty) || 1;
      const t = n > 1 ? k / (n - 1) : 0;
      const off = bladeOffset * Math.sin(Math.PI * Math.min(1, t * 1.05)) * bladeSide;
      ox[k] = px[k]! + (-ty / tl) * off;
      oy[k] = py[k]! + (tx / tl) * off;
    }
    // the blade first (behind), then the spine over it
    let m = this.pen.stroke(ov, ox, oy, 0, n, n, blade);
    m += this.pen.stroke(ov, px, py, 0, n, n, spine);
    return m;
  }
}

/** A point fixed in a rig body's FRAME (px): a joint, a membrane corner, a fibre end. */
export interface RigAnchor {
  body: number;
  x: number;
  y: number;
}

const pa = { x: 0, y: 0 };
const pb = { x: 0, y: 0 };
const pc = { x: 0, y: 0 };

/** Draw a membrane whose three corners ride on rig bodies (corner a = root; b → c = the free edge). */
export function drawRigMembrane(
  sp: WitnessSoftPen,
  ov: Overlay,
  rig: XpbdRig,
  a: RigAnchor,
  b: RigAnchor,
  c: RigAnchor,
  restLen: number,
  tear: number,
  st: MembraneStyle,
): number {
  rig.worldPoint(a.body, a.x, a.y, pa);
  rig.worldPoint(b.body, b.x, b.y, pb);
  rig.worldPoint(c.body, c.x, c.y, pc);
  return sp.membrane(ov, pa.x, pa.y, pb.x, pb.y, pc.x, pc.y, restLen, tear, st);
}

/** Draw a fibre between two rig anchors. */
export function drawRigFibre(
  sp: WitnessSoftPen,
  ov: Overlay,
  rig: XpbdRig,
  a: RigAnchor,
  b: RigAnchor,
  restLen: number,
  tear: number,
  st: SplineStyle,
): number {
  rig.worldPoint(a.body, a.x, a.y, pa);
  rig.worldPoint(b.body, b.x, b.y, pb);
  return sp.fibre(ov, pa.x, pa.y, pb.x, pb.y, restLen, tear, st);
}

const armX = new Float32Array(16);
const armY = new Float32Array(16);

/** Draw an arm through a chain of rig anchors (its joints, then the tip). */
export function drawRigArm(
  sp: WitnessSoftPen,
  ov: Overlay,
  rig: XpbdRig,
  chain: readonly RigAnchor[],
  spine: SplineStyle,
  blade: SplineStyle,
  bladeSide: number,
  bladeOffset: number,
): number {
  const n = Math.min(16, chain.length);
  for (let k = 0; k < n; k++) {
    const q = chain[k]!;
    rig.worldPoint(q.body, q.x, q.y, pa);
    armX[k] = pa.x;
    armY[k] = pa.y;
  }
  return sp.arm(ov, armX, armY, n, spine, blade, bladeSide, bladeOffset);
}
