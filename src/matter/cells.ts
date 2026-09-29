import { CellFlag } from '@/contracts';
import type { Body } from './body';

const F_SURF = CellFlag.SURFACE;
const F_CRACK = CellFlag.CRACKED;

/**
 * Low-level cell mutation. Every path that removes matter goes through `killCell`; every path that breaks a bond between
 * two live cells goes through `breakBond*`. Keeping these two centralised is what lets the bond graph, SURFACE flags and
 * the mass ledger stay consistent.
 */

/** Remove live cell `i`: clears all per-cell state and zeroes its four bonds. Returns the mass it held. */
export function killCell(body: Body, i: number): number {
  const map = body.map;
  const w = body.w;
  const m = body.cellMass(i);
  body.noteKill(i);
  map.material[i] = 0;
  map.density[i] = 0;
  map.integrity[i] = 0;
  map.temperature[i] = 0;
  map.infection[i] = 0;
  map.emissive[i] = 0;
  map.flags[i] = 0;
  map.detached[i] = 0;
  map.pixels[i] = 0;
  map.bondR[i] = 0;
  map.bondD[i] = 0;
  const x = i % w;
  const y = (i - x) / w;
  const mat = map.material;
  if (x > 0) {
    map.bondR[i - 1] = 0;
    if (mat[i - 1] !== 0) exposeCell(body, i - 1);
  }
  if (y > 0) {
    map.bondD[i - w] = 0;
    if (mat[i - w] !== 0) exposeCell(body, i - w);
  }
  if (x < w - 1 && mat[i + 1] !== 0) exposeCell(body, i + 1);
  if (y < body.h - 1 && mat[i + w] !== 0) exposeCell(body, i + w);
  // The one removal primitive also invalidates the tile/region caches, so no caller can forget to.
  body.touchPoint(x, y);
  body.removedTotal += m;
  return m;
}

/** A live cell just gained a void neighbour: mark SURFACE and count freshly revealed interior materials. */
function exposeCell(body: Body, c: number): void {
  const map = body.map;
  const f = map.flags[c]!;
  if ((f & F_SURF) === 0) {
    map.flags[c] = f | F_SURF;
    if (body.surfaceMat[map.material[c]!] === 0) body.revealCount++;
  }
}

/** Break the bond between cell `i` and its right neighbour (i + 1). Marks both cells CRACKED. Returns true if it was intact. */
export function breakBondR(body: Body, i: number): boolean {
  const map = body.map;
  if (map.bondR[i] === 0) return false;
  map.bondR[i] = 0;
  if (map.material[i] !== 0 && map.material[i + 1] !== 0) {
    map.flags[i] = map.flags[i]! | F_CRACK;
    map.flags[i + 1] = map.flags[i + 1]! | F_CRACK;
    body.noteBreak(i, i + 1);
  }
  return true;
}

/** Break the bond between cell `i` and its lower neighbour (i + w). */
export function breakBondD(body: Body, i: number): boolean {
  const map = body.map;
  if (map.bondD[i] === 0) return false;
  map.bondD[i] = 0;
  const j = i + body.w;
  if (map.material[i] !== 0 && map.material[j] !== 0) {
    map.flags[i] = map.flags[i]! | F_CRACK;
    map.flags[j] = map.flags[j]! | F_CRACK;
    body.noteBreak(i, j);
  }
  return true;
}

/**
 * Break every bond of `i` to its four neighbours (a cell blasted loose). Returns the number of bonds that were intact.
 */
export function breakAllBonds(body: Body, i: number): number {
  const map = body.map;
  const w = body.w;
  const x = i % w;
  const y = (i - x) / w;
  let n = 0;
  if (x < w - 1 && breakBondR(body, i)) n++;
  if (x > 0 && breakBondR(body, i - 1)) n++;
  if (y < body.h - 1 && breakBondD(body, i)) n++;
  if (y > 0 && breakBondD(body, i - w)) n++;
  if (n > 0) map.flags[i] = map.flags[i]! | F_CRACK;
  return n;
}

/**
 * Recompute SURFACE flags (4-neighbour void test) for an inclusive rect and its 1-cell margin. Used after matter is
 * ADDED (grow/heal/restore); removals maintain flags incrementally in `killCell`.
 */
export function refreshSurfaceRect(body: Body, x0: number, y0: number, x1: number, y1: number): void {
  const map = body.map;
  const w = body.w;
  const h = body.h;
  const mat = map.material;
  const fl = map.flags;
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > w - 1) x1 = w - 1;
  if (y1 > h - 1) y1 = h - 1;
  for (let y = Math.max(0, y0 - 1); y <= Math.min(h - 1, y1 + 1); y++) {
    for (let x = Math.max(0, x0 - 1); x <= Math.min(w - 1, x1 + 1); x++) {
      const i = y * w + x;
      if (mat[i] === 0) {
        fl[i] = 0;
        continue;
      }
      const surf =
        x === 0 ||
        y === 0 ||
        x === w - 1 ||
        y === h - 1 ||
        mat[i - 1] === 0 ||
        mat[i + 1] === 0 ||
        mat[i - w] === 0 ||
        mat[i + w] === 0;
      fl[i] = surf ? fl[i]! | F_SURF : fl[i]! & ~F_SURF;
    }
  }
}
