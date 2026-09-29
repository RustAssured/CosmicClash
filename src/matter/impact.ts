import type { WorldPoint } from './body';
import { outwardNormal, type DamageCtx } from './dmg';

export interface Impact {
  /** Entry point on the outline, body-local float cell coordinates. */
  fx: number;
  fy: number;
  /** Outward surface normal (local, unit). */
  nx: number;
  ny: number;
  /** True if a real surface normal was found (false: fell back to -blow direction). */
  hasNormal: boolean;
}

const nrm: WorldPoint = { x: 0, y: 0 };
const pt: WorldPoint = { x: 0, y: 0 };

/**
 * First-contact geometry of a blow. The contact patch is the covered cells nearest to the shape's origin (the attacker
 * side); its centroid is then slid back along -direction to the outline, because the projectile/fist arrived from OUTSIDE
 * (a shape that already overlaps deep inside still bites in from the surface). The outward normal is the mean direction
 * to void around that point.
 */
export function findImpact(ctx: DamageCtx, out: Impact): boolean {
  const { core, body } = ctx;
  const w = body.w;
  const mat = body.map.material;
  const q = core.q;
  const n0 = ctx.n;
  const idx0 = core.covIdx;
  const ox = q.originX();
  const oy = q.originY();
  let dmin = Infinity;
  for (let k = 0; k < n0; k++) {
    const i = idx0[k]!;
    const x = i % w;
    body.cellWorld(x, (i - x) / w, pt);
    const d = (pt.x - ox) * (pt.x - ox) + (pt.y - oy) * (pt.y - oy);
    if (d < dmin) dmin = d;
  }
  if (dmin === Infinity) return false;
  const lim = (Math.sqrt(dmin) + 3.5) * (Math.sqrt(dmin) + 3.5);
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let k = 0; k < n0; k++) {
    const i = idx0[k]!;
    const x = i % w;
    const y = (i - x) / w;
    body.cellWorld(x, y, pt);
    const d = (pt.x - ox) * (pt.x - ox) + (pt.y - oy) * (pt.y - oy);
    if (d > lim) continue;
    sx += x + 0.5;
    sy += y + 0.5;
    sw += 1;
  }
  if (sw === 0) return false;
  let fx = sx / sw;
  let fy = sy / sw;
  let dxl = -ctx.ldx;
  let dyl = -ctx.ldy;
  const dl = Math.sqrt(dxl * dxl + dyl * dyl);
  if (dl > 1e-6) {
    dxl /= dl;
    dyl /= dl;
    let lx = fx;
    let ly = fy;
    let steps = 0;
    for (; steps < 120; steps++) {
      const nx2 = fx + dxl * (steps + 1) * 0.5;
      const ny2 = fy + dyl * (steps + 1) * 0.5;
      const ix = Math.floor(nx2);
      const iy = Math.floor(ny2);
      if (ix < 0 || iy < 0 || ix >= w || iy >= body.h || mat[iy * w + ix] === 0) break;
      lx = nx2;
      ly = ny2;
    }
    if (steps > 4) {
      fx = lx;
      fy = ly;
    }
  }
  const has = outwardNormal(body, Math.floor(fx), Math.floor(fy), 4, nrm);
  out.fx = fx;
  out.fy = fy;
  out.hasNormal = has;
  if (has) {
    out.nx = nrm.x;
    out.ny = nrm.y;
  } else {
    out.nx = -ctx.ldx;
    out.ny = -ctx.ldy;
    const l = Math.sqrt(out.nx * out.nx + out.ny * out.ny) || 1;
    out.nx /= l;
    out.ny /= l;
  }
  return true;
}
