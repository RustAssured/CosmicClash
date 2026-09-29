import { MAX_BODY_DIM } from '@/contracts';
import type { Body } from './body';
import { breakBondD, breakBondR } from './cells';

/**
 * The DUAL LATTICE: crack paths run along cell edges, i.e. between corners (cx, cy), cx ∈ [0..w], cy ∈ [0..h]. Every dual
 * edge between two live cells corresponds to exactly one bond byte:
 *   E (cx,cy)->(cx+1,cy)  is  bondD[(cy-1)*w + cx]     (cells above / below the edge)
 *   S (cx,cy)->(cx,cy+1)  is  bondR[cy*w + cx-1]       (cells left / right of the edge)
 * Directions: 0 = E (+x), 1 = S (+y), 2 = W, 3 = N.
 */
export const DX = [1, 0, -1, 0] as const;
export const DY = [0, 1, 0, -1] as const;

/**
 * Bond byte of the dual edge leaving corner (cx, cy) in direction `d`, or -1 if that edge is not interior (an adjacent
 * cell is void/outside): boundary edges carry no bond and are never part of a crack path.
 */
export function edgeBond(body: Body, cx: number, cy: number, d: number): number {
  const { w, h } = body;
  const map = body.map;
  const mat = map.material;
  let a: number;
  let b: number;
  switch (d) {
    case 0:
      if (cy < 1 || cy > h - 1 || cx > w - 1) return -1;
      a = (cy - 1) * w + cx;
      b = a + w;
      if (mat[a] === 0 || mat[b] === 0) return -1;
      return map.bondD[a]!;
    case 2:
      if (cx < 1 || cy < 1 || cy > h - 1) return -1;
      a = (cy - 1) * w + cx - 1;
      b = a + w;
      if (mat[a] === 0 || mat[b] === 0) return -1;
      return map.bondD[a]!;
    case 1:
      if (cx < 1 || cx > w - 1 || cy > h - 1) return -1;
      a = cy * w + cx - 1;
      b = a + 1;
      if (mat[a] === 0 || mat[b] === 0) return -1;
      return map.bondR[a]!;
    default:
      if (cx < 1 || cx > w - 1 || cy < 1) return -1;
      a = (cy - 1) * w + cx - 1;
      b = a + 1;
      if (mat[a] === 0 || mat[b] === 0) return -1;
      return map.bondR[a]!;
  }
}

/** The two cells an edge separates (out params via arrays to stay allocation free). Returns false if not interior. */
export function edgeCells(body: Body, cx: number, cy: number, d: number, out: Int32Array): boolean {
  const { w, h } = body;
  const mat = body.map.material;
  let a: number;
  let b: number;
  switch (d) {
    case 0:
      if (cy < 1 || cy > h - 1 || cx > w - 1) return false;
      a = (cy - 1) * w + cx;
      b = a + w;
      break;
    case 2:
      if (cx < 1 || cy < 1 || cy > h - 1) return false;
      a = (cy - 1) * w + cx - 1;
      b = a + w;
      break;
    case 1:
      if (cx < 1 || cx > w - 1 || cy > h - 1) return false;
      a = cy * w + cx - 1;
      b = a + 1;
      break;
    default:
      if (cx < 1 || cx > w - 1 || cy < 1) return false;
      a = (cy - 1) * w + cx - 1;
      b = a + 1;
      break;
  }
  if (mat[a] === 0 || mat[b] === 0) return false;
  out[0] = a;
  out[1] = b;
  return true;
}

/** Break the bond of the dual edge leaving (cx, cy) in direction d. Returns true if it was intact. */
export function breakEdge(body: Body, cx: number, cy: number, d: number): boolean {
  const w = body.w;
  switch (d) {
    case 0:
      return breakBondD(body, (cy - 1) * w + cx);
    case 2:
      return breakBondD(body, (cy - 1) * w + cx - 1);
    case 1:
      return breakBondR(body, cy * w + cx - 1);
    default:
      return breakBondR(body, (cy - 1) * w + cx - 1);
  }
}

/** Set the bond byte of an edge directly (used to weaken partial cuts). */
export function setEdgeBond(body: Body, cx: number, cy: number, d: number, v: number): void {
  const w = body.w;
  const map = body.map;
  switch (d) {
    case 0:
      map.bondD[(cy - 1) * w + cx] = v;
      break;
    case 2:
      map.bondD[(cy - 1) * w + cx - 1] = v;
      break;
    case 1:
      map.bondR[cy * w + cx - 1] = v;
      break;
    default:
      map.bondR[(cy - 1) * w + cx - 1] = v;
      break;
  }
}

/** True if corner (cx, cy) touches both void (or outside) and live matter: a point on the body's outline. */
export function isSurfaceCorner(body: Body, cx: number, cy: number): boolean {
  const { w, h } = body;
  const mat = body.map.material;
  let live = 0;
  let voidN = 0;
  for (let k = 0; k < 4; k++) {
    const x = cx - 1 + (k & 1);
    const y = cy - 1 + (k >> 1);
    if (x < 0 || y < 0 || x >= w || y >= h || mat[y * w + x] === 0) voidN++;
    else live++;
  }
  return live > 0 && voidN > 0;
}

export interface CutOptions {
  /** Exit corner; -1 = stop at the first surface corner at least `minSep` away from the start. */
  tx: number;
  ty: number;
  minSep: number;
  /** Search radius from the start (corners further away are not expanded). */
  maxRange: number;
  /** Optional guide direction (unit) penalising lateral deviation from the line through the start. */
  guideX: number;
  guideY: number;
  guideLat: number;
  /** Cost slope: edge cost = 1 + bond * bondK. */
  bondK: number;
}

export function defaultCutOptions(): CutOptions {
  return { tx: -1, ty: -1, minSep: 6, maxRange: 40, guideX: 0, guideY: 0, guideLat: 0, bondK: 0.09 };
}

/**
 * Dijkstra over the dual lattice: the bond-weighted shortest crack path from a start corner to an exit. Scratch buffers
 * are sized once for the largest body; a generation stamp avoids clearing them.
 */
export class CutFinder {
  private readonly dist: Float32Array;
  private readonly prev: Int32Array;
  private readonly seen: Uint32Array;
  private gen = 0;
  private readonly heapK: Float32Array;
  private readonly heapV: Int32Array;
  private heapN = 0;
  /** Result path (corner indices, start first). */
  readonly path: Int32Array;
  pathLen = 0;
  private readonly tmp = new Int32Array(2);

  constructor(maxDim = MAX_BODY_DIM) {
    const corners = (maxDim + 1) * (maxDim + 1);
    this.dist = new Float32Array(corners);
    this.prev = new Int32Array(corners);
    this.seen = new Uint32Array(corners);
    this.heapK = new Float32Array(corners * 3);
    this.heapV = new Int32Array(corners * 3);
    this.path = new Int32Array(corners);
  }

  private push(k: number, v: number): void {
    if (this.heapN >= this.heapK.length) return;
    let i = this.heapN++;
    const hk = this.heapK;
    const hv = this.heapV;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p]! < k || (hk[p] === k && hv[p]! <= v)) break;
      hk[i] = hk[p]!;
      hv[i] = hv[p]!;
      i = p;
    }
    hk[i] = k;
    hv[i] = v;
  }

  private popInto(): number {
    const hk = this.heapK;
    const hv = this.heapV;
    const top = hv[0]!;
    this.topKey = hk[0]!;
    const n = --this.heapN;
    if (n > 0) {
      const k = hk[n]!;
      const v = hv[n]!;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && (hk[c + 1]! < hk[c]! || (hk[c + 1] === hk[c] && hv[c + 1]! < hv[c]!))) c++;
        if (hk[c]! > k || (hk[c] === k && hv[c]! >= v)) break;
        hk[i] = hk[c]!;
        hv[i] = hv[c]!;
        i = c;
      }
      hk[i] = k;
      hv[i] = v;
    }
    return top;
  }
  private topKey = 0;

  /**
   * Find a crack path from corner (sx, sy). On success returns true with `path[0..pathLen)` filled (corner indices
   * `cy * (w+1) + cx`). Only interior edges are walked.
   */
  find(body: Body, sx: number, sy: number, o: CutOptions): boolean {
    const w1 = body.w + 1;
    this.gen++;
    if (this.gen > 0xfffffff0) {
      this.seen.fill(0);
      this.gen = 1;
    }
    const gen = this.gen;
    const start = sy * w1 + sx;
    this.heapN = 0;
    this.seen[start] = gen;
    this.dist[start] = 0;
    this.prev[start] = -1;
    this.push(0, start);
    const maxR2 = o.maxRange * o.maxRange;
    const minSep2 = o.minSep * o.minSep;
    const hasGuide = o.guideLat > 0;

    let found = -1;
    let iters = 0;
    while (this.heapN > 0) {
      const u = this.popInto();
      const k = this.topKey;
      if (k > this.dist[u]! + 1e-4) continue;
      if (++iters > 60000) break;
      const ux = u % w1;
      const uy = (u - ux) / w1;
      if (u !== start) {
        if (o.tx >= 0) {
          if (ux === o.tx && uy === o.ty) {
            found = u;
            break;
          }
        } else {
          const ddx = ux - sx;
          const ddy = uy - sy;
          if (ddx * ddx + ddy * ddy >= minSep2 && isSurfaceCorner(body, ux, uy)) {
            found = u;
            break;
          }
        }
      }
      for (let d = 0; d < 4; d++) {
        const bond = edgeBond(body, ux, uy, d);
        if (bond < 0) continue;
        const vx = ux + DX[d]!;
        const vy = uy + DY[d]!;
        const ex = vx - sx;
        const ey = vy - sy;
        if (ex * ex + ey * ey > maxR2) continue;
        let c = bond === 0 ? 0.3 : 1 + bond * o.bondK;
        if (hasGuide) {
          const dev = Math.abs(ex * o.guideY - ey * o.guideX);
          if (dev > 2.5) c += o.guideLat * (dev - 2.5);
        }
        const v = vy * w1 + vx;
        const nd = k + c;
        if (this.seen[v] !== gen || nd < this.dist[v]!) {
          this.seen[v] = gen;
          this.dist[v] = nd;
          this.prev[v] = u;
          this.push(nd, v);
        }
      }
    }
    if (found < 0) {
      this.pathLen = 0;
      return false;
    }
    // Reconstruct (end -> start), then reverse in place.
    let n = 0;
    for (let v = found; v >= 0; v = this.prev[v]!) this.path[n++] = v;
    for (let i = 0, j = n - 1; i < j; i++, j--) {
      const t = this.path[i]!;
      this.path[i] = this.path[j]!;
      this.path[j] = t;
    }
    this.pathLen = n;
    return true;
  }

  /**
   * The best surface corner for a crack starting at surface cell (x, y): a corner of the cell that touches the outline and
   * has at least one interior edge, preferring the corner furthest along (inX, inY) (into the body). -1 if none.
   */
  startCorner(body: Body, x: number, y: number, inX: number, inY: number): number {
    const w1 = body.w + 1;
    let best = -1;
    let bs = -Infinity;
    for (let k = 0; k < 4; k++) {
      const cx = x + (k & 1);
      const cy = y + (k >> 1);
      if (!isSurfaceCorner(body, cx, cy)) continue;
      let ok = false;
      for (let d = 0; d < 4; d++)
        if (edgeBond(body, cx, cy, d) >= 0) {
          ok = true;
          break;
        }
      if (!ok) continue;
      const s = (cx - (x + 0.5)) * inX + (cy - (y + 0.5)) * inY;
      if (s > bs) {
        bs = s;
        best = cy * w1 + cx;
      }
    }
    return best;
  }

  /** The cells on either side of path edge `k` (path[k] -> path[k+1]); false if not interior. */
  edgeCellsAt(body: Body, k: number, out: Int32Array): boolean {
    const w1 = body.w + 1;
    const u = this.path[k]!;
    const v = this.path[k + 1]!;
    const ux = u % w1;
    const uy = (u - ux) / w1;
    const vx = v % w1;
    const d = vx > ux ? 0 : vx < ux ? 2 : v > u ? 1 : 3;
    return edgeCells(body, ux, uy, d, out);
  }

  get scratch(): Int32Array {
    return this.tmp;
  }
}
