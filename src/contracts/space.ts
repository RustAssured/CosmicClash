import type { BodyTransform } from './matter';

/**
 * Body-local ↔ world mapping. THE ONLY place flip/lean maths lives — matter, combat, and the renderer
 * must all call these (or reproduce them exactly) so hit-tests match what the player sees.
 *
 * A body's matter map is authored FACING RIGHT (+x). `facing = -1` mirrors it around its anchor.
 * `lean` is a cosmetic integer-row shear (bodies lean into motion): row ly is shifted horizontally by
 * `leanShift(t, ly)` world pixels, zero at the anchor row, positive lean = top leans toward +x world.
 * (No rotation: rotation of pixel art aliases; row shear is pixel-perfect.)
 */
export const leanShift = (leanPx: number, ly: number, anchorY: number): number =>
  Math.round((leanPx * (anchorY - ly)) / Math.max(1, anchorY));

/** Local cell coords (float, cell centres at +0.5 not assumed: cell (i,j) occupies [i,i+1)×[j,j+1)) → world. */
export function localToWorld(t: BodyTransform, lx: number, ly: number, out: { x: number; y: number }): void {
  const dx = (lx - t.anchorX) * t.facing;
  out.x = t.x + dx + leanShift(t.lean, ly, t.anchorY);
  out.y = t.y + (ly - t.anchorY);
}

/** World → local cell coords (float). Inverse of localToWorld (exact for integer lean shifts). */
export function worldToLocal(t: BodyTransform, wx: number, wy: number, out: { x: number; y: number }): void {
  const ly = wy - t.y + t.anchorY;
  const dx = wx - t.x - leanShift(t.lean, Math.floor(ly), t.anchorY);
  out.x = dx * t.facing + t.anchorX;
  out.y = ly;
}

/** World-space direction vector → local-space direction vector (mirror only; lean does not rotate). */
export const dirToLocalX = (t: BodyTransform, dx: number): number => dx * t.facing;
export const dirToWorldX = (t: BodyTransform, dx: number): number => dx * t.facing;

/** World AABB of the FULL map rectangle (not just live cells). */
export function mapWorldAABB(
  t: BodyTransform,
  w: number,
  h: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const xa = t.x + (0 - t.anchorX) * t.facing;
  const xb = t.x + (w - t.anchorX) * t.facing;
  const pad = Math.abs(t.lean);
  return {
    x0: Math.min(xa, xb) - pad,
    x1: Math.max(xa, xb) + pad,
    y0: t.y - t.anchorY,
    y1: t.y - t.anchorY + h,
  };
}
