import type { DamageShape } from '@/contracts';

export const K_POINT = 0;
export const K_LINE = 1;
export const K_CONE = 2;
export const K_RING = 3;
export const K_FIELD = 4;

/**
 * Allocation-free, reusable evaluator of a world-space DamageShape. `set()` derives constants once; `weight(x, y)`
 * returns 0 outside the shape and a soft 0..1 weight inside (the "shape's falloff" the damage contract mentions):
 *  - point : disc, 1 at the centre easing to ~0.45 at the rim;
 *  - line  : capsule around the segment, 1 on the axis easing to 0.5 at the edge;
 *  - cone  : range and angle falloff (hottest near the apex on the axis);
 *  - ring  : annulus, 1 on the mid radius easing to 0.7 at the edges;
 *  - field : (1 - d/r)^falloff (falloff 1 = linear).
 */
export class ShapeQ {
  kind = K_POINT;
  x = 0;
  y = 0;
  r = 0;
  r2 = 0;
  x1 = 0;
  y1 = 0;
  ux = 1;
  uy = 0;
  len = 0;
  hw = 1;
  hw2 = 1;
  range = 0;
  range2 = 0;
  cosHalf = 1;
  halfAngle = 0;
  r0 = 0;
  r1 = 0;
  r02 = 0;
  r12 = 0;
  falloff = 1;
  /** World bounding box of the shape. */
  bx0 = 0;
  by0 = 0;
  bx1 = 0;
  by1 = 0;
  /** Geometric area in cells (for coverage). */
  area = 1;

  set(s: DamageShape): this {
    switch (s.kind) {
      case 'point':
        this.kind = K_POINT;
        this.x = s.x;
        this.y = s.y;
        this.r = Math.max(0.5, s.r);
        this.r2 = this.r * this.r;
        this.bx0 = s.x - this.r;
        this.bx1 = s.x + this.r;
        this.by0 = s.y - this.r;
        this.by1 = s.y + this.r;
        this.area = Math.PI * this.r2;
        break;
      case 'line': {
        this.kind = K_LINE;
        this.x = s.x0;
        this.y = s.y0;
        this.x1 = s.x1;
        this.y1 = s.y1;
        const dx = s.x1 - s.x0;
        const dy = s.y1 - s.y0;
        const len = Math.sqrt(dx * dx + dy * dy);
        this.len = len;
        this.ux = len > 1e-9 ? dx / len : 1;
        this.uy = len > 1e-9 ? dy / len : 0;
        this.hw = Math.max(0.5, s.width * 0.5);
        this.hw2 = this.hw * this.hw;
        this.bx0 = Math.min(s.x0, s.x1) - this.hw;
        this.bx1 = Math.max(s.x0, s.x1) + this.hw;
        this.by0 = Math.min(s.y0, s.y1) - this.hw;
        this.by1 = Math.max(s.y0, s.y1) + this.hw;
        this.area = len * this.hw * 2 + Math.PI * this.hw2;
        break;
      }
      case 'cone': {
        this.kind = K_CONE;
        this.x = s.x;
        this.y = s.y;
        const l = Math.sqrt(s.dirX * s.dirX + s.dirY * s.dirY);
        this.ux = l > 1e-9 ? s.dirX / l : 1;
        this.uy = l > 1e-9 ? s.dirY / l : 0;
        this.range = Math.max(0.5, s.range);
        this.range2 = this.range * this.range;
        this.halfAngle = Math.min(Math.PI, Math.max(0.02, s.halfAngle));
        this.cosHalf = Math.cos(this.halfAngle);
        this.area = this.range2 * this.halfAngle;
        // Conservative but tight bbox: apex, arc end points and any axis extremes the arc passes through.
        let x0 = s.x;
        let x1 = s.x;
        let y0 = s.y;
        let y1 = s.y;
        const a0 = Math.atan2(this.uy, this.ux);
        const ext = (a: number): void => {
          const px = s.x + Math.cos(a) * this.range;
          const py = s.y + Math.sin(a) * this.range;
          if (px < x0) x0 = px;
          if (px > x1) x1 = px;
          if (py < y0) y0 = py;
          if (py > y1) y1 = py;
        };
        ext(a0 - this.halfAngle);
        ext(a0 + this.halfAngle);
        for (let k = 0; k < 4; k++) {
          const ak = (k * Math.PI) / 2;
          let d = (ak - a0) % (Math.PI * 2);
          if (d > Math.PI) d -= Math.PI * 2;
          else if (d < -Math.PI) d += Math.PI * 2;
          if (Math.abs(d) <= this.halfAngle) ext(ak);
        }
        this.bx0 = x0;
        this.bx1 = x1;
        this.by0 = y0;
        this.by1 = y1;
        break;
      }
      case 'ring':
        this.kind = K_RING;
        this.x = s.x;
        this.y = s.y;
        this.r0 = Math.max(0, Math.min(s.r0, s.r1));
        this.r1 = Math.max(0.5, Math.max(s.r0, s.r1));
        this.r02 = this.r0 * this.r0;
        this.r12 = this.r1 * this.r1;
        this.bx0 = s.x - this.r1;
        this.bx1 = s.x + this.r1;
        this.by0 = s.y - this.r1;
        this.by1 = s.y + this.r1;
        this.area = Math.PI * (this.r12 - this.r02);
        break;
      case 'field':
        this.kind = K_FIELD;
        this.x = s.x;
        this.y = s.y;
        this.r = Math.max(0.5, s.r);
        this.r2 = this.r * this.r;
        this.falloff = Math.max(0.2, Math.min(8, s.falloff));
        this.bx0 = s.x - this.r;
        this.bx1 = s.x + this.r;
        this.by0 = s.y - this.r;
        this.by1 = s.y + this.r;
        this.area = Math.PI * this.r2;
        break;
    }
    return this;
  }

  /** Coverage weight of the world point (wx, wy); 0 if outside. */
  weight(wx: number, wy: number): number {
    switch (this.kind) {
      case K_POINT: {
        const dx = wx - this.x;
        const dy = wy - this.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > this.r2) return 0;
        return 1 - 0.55 * (d2 / this.r2);
      }
      case K_LINE: {
        const px = wx - this.x;
        const py = wy - this.y;
        let t = px * this.ux + py * this.uy;
        if (t < 0) t = 0;
        else if (t > this.len) t = this.len;
        const cx = px - this.ux * t;
        const cy = py - this.uy * t;
        const d2 = cx * cx + cy * cy;
        if (d2 > this.hw2) return 0;
        return 1 - 0.5 * (d2 / this.hw2);
      }
      case K_CONE: {
        const vx = wx - this.x;
        const vy = wy - this.y;
        const d2 = vx * vx + vy * vy;
        if (d2 > this.range2) return 0;
        if (d2 < 1e-6) return 1;
        const d = Math.sqrt(d2);
        const cosT = (vx * this.ux + vy * this.uy) / d;
        if (cosT < this.cosHalf) return 0;
        const ang = this.cosHalf >= 0.9999 ? 1 : (cosT - this.cosHalf) / (1 - this.cosHalf);
        return (1 - 0.45 * (d / this.range)) * (0.55 + 0.45 * ang);
      }
      case K_RING: {
        const dx = wx - this.x;
        const dy = wy - this.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < this.r02 || d2 > this.r12) return 0;
        const d = Math.sqrt(d2);
        const half = (this.r1 - this.r0) * 0.5;
        if (half < 0.5) return 1;
        return 1 - 0.3 * (Math.abs(d - (this.r0 + half)) / half);
      }
      default: {
        const dx = wx - this.x;
        const dy = wy - this.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= this.r2) return 0;
        const u = 1 - Math.sqrt(d2) / this.r;
        const f = this.falloff;
        return f === 1 ? u : f === 2 ? u * u : Math.pow(u, f);
      }
    }
  }

  /** Point of the shape nearest to which "nearestX/Y" cells are reported (shape origin). */
  originX(): number {
    return this.x;
  }
  originY(): number {
    return this.y;
  }
  /** World centre used for radial ejecta etc. */
  centreX(): number {
    return this.kind === K_LINE ? (this.x + this.x1) * 0.5 : this.x;
  }
  centreY(): number {
    return this.kind === K_LINE ? (this.y + this.y1) * 0.5 : this.y;
  }
}
