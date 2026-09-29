/**
 * Signed-distance primitives (negative inside) for sculpting silhouettes. All in pixel units.
 * Combine with `smin`/`smax` for organic joins and with domain warping (see canvas.ts `warp`) for hand-weathered outlines.
 */

export const sdCircle = (x: number, y: number, cx: number, cy: number, r: number): number =>
  Math.hypot(x - cx, y - cy) - r;

/** Cheap ellipse distance (first-order): accurate near the boundary, good enough for silhouettes. */
export function sdEllipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number): number {
  const px = (x - cx) / rx;
  const py = (y - cy) / ry;
  const k0 = Math.hypot(px, py);
  const k1 = Math.hypot(px / rx, py / ry);
  return k1 < 1e-9 ? -Math.min(rx, ry) : (k0 * (k0 - 1)) / k1;
}

/** Rotated ellipse. `rot` radians. */
export function sdEllipseRot(
  x: number,
  y: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rot: number,
): number {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const dx = x - cx;
  const dy = y - cy;
  return sdEllipse(dx * c + dy * s, -dx * s + dy * c, 0, 0, rx, ry);
}

/** Line segment capsule with per-end radius (tapered capsule / "uneven capsule"). */
export function sdTaperedCapsule(
  x: number,
  y: number,
  ax: number,
  ay: number,
  ra: number,
  bx: number,
  by: number,
  rb: number,
): number {
  const pax = x - ax;
  const pay = y - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay || 1)));
  return Math.hypot(pax - bax * h, pay - bay * h) - (ra + (rb - ra) * h);
}

export const sdSegment = (x: number, y: number, ax: number, ay: number, bx: number, by: number): number =>
  sdTaperedCapsule(x, y, ax, ay, 0, bx, by, 0);

/** Rounded box centred at (cx,cy) with half extents (hx,hy) and corner radius r. */
export function sdRoundBox(
  x: number,
  y: number,
  cx: number,
  cy: number,
  hx: number,
  hy: number,
  r: number,
): number {
  const qx = Math.abs(x - cx) - hx + r;
  const qy = Math.abs(y - cy) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance to a half-plane: negative on the side opposite to the (nx,ny) normal, offset `d` from origin. */
export const sdPlane = (x: number, y: number, nx: number, ny: number, d: number): number =>
  x * nx + y * ny - d;

/** Distance to a convex/concave polygon (points flat [x0,y0,x1,y1,…]); sign by even-odd winding. */
export function sdPolygon(x: number, y: number, pts: readonly number[]): number {
  const n = pts.length / 2;
  let d = (x - pts[0]!) * (x - pts[0]!) + (y - pts[1]!) * (y - pts[1]!);
  let s = 1;
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const ex = pts[j * 2]! - pts[i * 2]!;
    const ey = pts[j * 2 + 1]! - pts[i * 2 + 1]!;
    const wx = x - pts[i * 2]!;
    const wy = y - pts[i * 2 + 1]!;
    const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey || 1)));
    const bx = wx - ex * t;
    const by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = y >= pts[i * 2 + 1]!;
    const c2 = y < pts[j * 2 + 1]!;
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

/** Polynomial smooth minimum (union with fillet radius k). */
export function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Smooth maximum (intersection / smooth subtraction with fillet k). */
export const smax = (a: number, b: number, k: number): number => -smin(-a, -b, k);

/** Smooth subtract b from a. */
export const ssub = (a: number, b: number, k: number): number => smax(a, -b, k);

/** Rotate a point about (cx,cy). */
export function rot(
  x: number,
  y: number,
  cx: number,
  cy: number,
  a: number,
  out: { x: number; y: number },
): void {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = x - cx;
  const dy = y - cy;
  out.x = cx + dx * c - dy * s;
  out.y = cy + dx * s + dy * c;
}
