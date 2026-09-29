import type { DamageShape, ShapeTemplate } from '@/contracts';

/**
 * Damage-shape geometry shared by the fighter (hitbox instantiation, part intercepts, threat telegraphs) and the test double.
 * `FatShape` is a single mutable object that can play every `DamageShape` variant, so per-tick hit resolution reuses ONE
 * preallocated shape instead of allocating a fresh union member each tick. It is structurally a valid DamageShape of
 * whichever `kind` it currently carries (the matter world switches on `kind` and reads only that variant's fields).
 */
export interface FatShape {
  kind: DamageShape['kind'];
  x: number;
  y: number;
  r: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  dirX: number;
  dirY: number;
  range: number;
  halfAngle: number;
  r0: number;
  r1: number;
  falloff: number;
}

export function makeFatShape(): FatShape {
  return {
    kind: 'point',
    x: 0,
    y: 0,
    r: 0,
    x0: 0,
    y0: 0,
    x1: 0,
    y1: 0,
    width: 0,
    dirX: 1,
    dirY: 0,
    range: 0,
    halfAngle: 0,
    r0: 0,
    r1: 0,
    falloff: 0,
  };
}

/** View a FatShape as the contract's DamageShape union (they are the same object at runtime). */
export const asShape = (s: FatShape): DamageShape => s as unknown as DamageShape;

/** Copy any DamageShape into a FatShape. */
export function copyShape(dst: FatShape, src: DamageShape): void {
  dst.kind = src.kind;
  switch (src.kind) {
    case 'point':
      dst.x = src.x;
      dst.y = src.y;
      dst.r = src.r;
      break;
    case 'line':
      dst.x0 = src.x0;
      dst.y0 = src.y0;
      dst.x1 = src.x1;
      dst.y1 = src.y1;
      dst.width = src.width;
      break;
    case 'cone':
      dst.x = src.x;
      dst.y = src.y;
      dst.dirX = src.dirX;
      dst.dirY = src.dirY;
      dst.range = src.range;
      dst.halfAngle = src.halfAngle;
      break;
    case 'ring':
      dst.x = src.x;
      dst.y = src.y;
      dst.r0 = src.r0;
      dst.r1 = src.r1;
      break;
    case 'field':
      dst.x = src.x;
      dst.y = src.y;
      dst.r = src.r;
      dst.falloff = src.falloff;
      break;
  }
}

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** World AABB of a shape (generous by ~1px so pixel centres on the edge are included). */
export function shapeBounds(s: DamageShape, out: Bounds): Bounds {
  switch (s.kind) {
    case 'point':
    case 'field':
      out.x0 = s.x - s.r - 1;
      out.x1 = s.x + s.r + 1;
      out.y0 = s.y - s.r - 1;
      out.y1 = s.y + s.r + 1;
      break;
    case 'line': {
      const h = s.width * 0.5 + 1;
      out.x0 = Math.min(s.x0, s.x1) - h;
      out.x1 = Math.max(s.x0, s.x1) + h;
      out.y0 = Math.min(s.y0, s.y1) - h;
      out.y1 = Math.max(s.y0, s.y1) + h;
      break;
    }
    case 'cone':
      out.x0 = s.x - s.range - 1;
      out.x1 = s.x + s.range + 1;
      out.y0 = s.y - s.range - 1;
      out.y1 = s.y + s.range + 1;
      break;
    case 'ring':
      out.x0 = s.x - s.r1 - 1;
      out.x1 = s.x + s.r1 + 1;
      out.y0 = s.y - s.r1 - 1;
      out.y1 = s.y + s.r1 + 1;
      break;
  }
  return out;
}

/** Distance from (px,py) to the segment (ax,ay)-(bx,by). */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const l2 = vx * vx + vy * vy;
  let t = l2 > 1e-9 ? ((px - ax) * vx + (py - ay) * vy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + vx * t);
  const dy = py - (ay + vy * t);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Does the shape contain the point (px,py)? (Pixel-centre test.) */
export function shapeContains(s: DamageShape, px: number, py: number): boolean {
  switch (s.kind) {
    case 'point': {
      const dx = px - s.x;
      const dy = py - s.y;
      return dx * dx + dy * dy <= s.r * s.r;
    }
    case 'field': {
      const dx = px - s.x;
      const dy = py - s.y;
      return dx * dx + dy * dy <= s.r * s.r;
    }
    case 'line':
      return distToSegment(px, py, s.x0, s.y0, s.x1, s.y1) <= s.width * 0.5;
    case 'cone': {
      const dx = px - s.x;
      const dy = py - s.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > s.range * s.range) return false;
      if (d2 < 1e-6) return true;
      const dl = Math.sqrt(d2);
      return (dx * s.dirX + dy * s.dirY) / dl >= Math.cos(s.halfAngle);
    }
    case 'ring': {
      const dx = px - s.x;
      const dy = py - s.y;
      const d2 = dx * dx + dy * dy;
      return d2 >= s.r0 * s.r0 && d2 <= s.r1 * s.r1;
    }
  }
}

/** Does the shape touch a disc (used for parts such as tendril segments, moons and swarm fragments)? Conservative and cheap. */
export function shapeIntersectsDisc(s: DamageShape, cx: number, cy: number, r: number): boolean {
  switch (s.kind) {
    case 'point':
    case 'field': {
      const dx = cx - s.x;
      const dy = cy - s.y;
      const rr = s.r + r;
      return dx * dx + dy * dy <= rr * rr;
    }
    case 'line':
      return distToSegment(cx, cy, s.x0, s.y0, s.x1, s.y1) <= s.width * 0.5 + r;
    case 'cone': {
      const dx = cx - s.x;
      const dy = cy - s.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > s.range + r) return false;
      if (d <= r) return true;
      const cosA = (dx * s.dirX + dy * s.dirY) / d;
      const ang = Math.acos(cosA < -1 ? -1 : cosA > 1 ? 1 : cosA);
      // widen the half angle by the disc's angular size
      return ang <= s.halfAngle + Math.asin(Math.min(1, r / d));
    }
    case 'ring': {
      const dx = cx - s.x;
      const dy = cy - s.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      return d + r >= s.r0 && d - r <= s.r1;
    }
  }
}

/** Representative "origin" of a shape (where the blow lands first). */
export function shapeOrigin(s: DamageShape, out: { x: number; y: number }): void {
  switch (s.kind) {
    case 'line':
      out.x = (s.x0 + s.x1) * 0.5;
      out.y = (s.y0 + s.y1) * 0.5;
      break;
    default:
      out.x = s.x;
      out.y = s.y;
  }
}

/** Length scale a template's lengths (offsets, radii, ranges, line points) but not widths/angles/falloff. */
export interface TemplatePlacement {
  /** Attacker anchor (world). */
  x: number;
  y: number;
  facing: 1 | -1;
  /** Multiplier applied to lengths (reach scaling × charge scaling). */
  scale: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Instantiate a ShapeTemplate (attacker-relative, +x forward, +y down) in WORLD space into `out`. When `sweep` is given the
 * shape is interpolated toward it by `u` ∈ [0,1] (a sweeping blow). Both templates must share a `kind`; otherwise `sweep` is ignored.
 */
export function instantiateTemplate(
  tpl: ShapeTemplate,
  pl: TemplatePlacement,
  out: FatShape,
  sweep?: ShapeTemplate,
  u = 0,
): void {
  const f = pl.facing;
  const s = pl.scale;
  const sw = sweep && sweep.kind === tpl.kind ? sweep : undefined;
  const L = (a: number, b: number | undefined): number => (sw && b !== undefined ? lerp(a, b, u) : a);
  out.kind = tpl.kind;
  switch (tpl.kind) {
    case 'point': {
      const t2 = sw as Extract<ShapeTemplate, { kind: 'point' }> | undefined;
      out.x = pl.x + L(tpl.ox, t2?.ox) * f * s;
      out.y = pl.y + L(tpl.oy, t2?.oy) * s;
      out.r = L(tpl.r, t2?.r) * s;
      break;
    }
    case 'line': {
      const t2 = sw as Extract<ShapeTemplate, { kind: 'line' }> | undefined;
      out.x0 = pl.x + L(tpl.ox0, t2?.ox0) * f * s;
      out.y0 = pl.y + L(tpl.oy0, t2?.oy0) * s;
      out.x1 = pl.x + L(tpl.ox1, t2?.ox1) * f * s;
      out.y1 = pl.y + L(tpl.oy1, t2?.oy1) * s;
      out.width = L(tpl.width, t2?.width);
      break;
    }
    case 'cone': {
      const t2 = sw as Extract<ShapeTemplate, { kind: 'cone' }> | undefined;
      out.x = pl.x + L(tpl.ox, t2?.ox) * f * s;
      out.y = pl.y + L(tpl.oy, t2?.oy) * s;
      const ang = L(tpl.angle, t2?.angle);
      out.dirX = Math.cos(ang) * f;
      out.dirY = Math.sin(ang);
      out.range = L(tpl.range, t2?.range) * s;
      out.halfAngle = L(tpl.halfAngle, t2?.halfAngle);
      break;
    }
    case 'ring': {
      const t2 = sw as Extract<ShapeTemplate, { kind: 'ring' }> | undefined;
      out.x = pl.x + L(tpl.ox, t2?.ox) * f * s;
      out.y = pl.y + L(tpl.oy, t2?.oy) * s;
      out.r0 = L(tpl.r0, t2?.r0) * s;
      out.r1 = L(tpl.r1, t2?.r1) * s;
      break;
    }
    case 'field': {
      const t2 = sw as Extract<ShapeTemplate, { kind: 'field' }> | undefined;
      out.x = pl.x + L(tpl.ox, t2?.ox) * f * s;
      out.y = pl.y + L(tpl.oy, t2?.oy) * s;
      out.r = L(tpl.r, t2?.r) * s;
      out.falloff = L(tpl.falloff, t2?.falloff);
      break;
    }
  }
}
