import {
  LOGICAL_H,
  LOGICAL_W,
  makeLayer,
  rgba,
  type DamageShape,
  type DebugShape,
  type RenderLayer,
  type ViewRect,
} from '@/contracts';

/**
 * Training-mode hit/hurt-shape overlay: outlines of world-space DamageShapes rasterised into one screen-space layer (view-aligned).
 * Debug tooling — plain outlines are exactly right here.
 */
export function createDebugLayer(): RenderLayer {
  const l = makeLayer('debug-shapes', 'screen', 30, LOGICAL_W, LOGICAL_H);
  l.visible = false;
  return l;
}

const plot = (px: Uint32Array, x: number, y: number, c: number): void => {
  x = Math.round(x);
  y = Math.round(y);
  if (x >= 0 && y >= 0 && x < LOGICAL_W && y < LOGICAL_H) px[y * LOGICAL_W + x] = c;
};

function line(px: Uint32Array, x0: number, y0: number, x1: number, y1: number, c: number): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  for (let i = 0; i <= n; i++) plot(px, x0 + (dx * i) / n, y0 + (dy * i) / n, c);
}

function circle(
  px: Uint32Array,
  cx: number,
  cy: number,
  r: number,
  c: number,
  a0 = 0,
  a1 = Math.PI * 2,
): void {
  const n = Math.max(12, Math.ceil(r * 3));
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    plot(px, cx + Math.cos(a) * r, cy + Math.sin(a) * r, c);
  }
}

function drawShape(px: Uint32Array, s: DamageShape, ox: number, oy: number, c: number): void {
  switch (s.kind) {
    case 'point':
      circle(px, s.x - ox, s.y - oy, s.r, c);
      break;
    case 'line': {
      const nx = s.y1 - s.y0;
      const ny = -(s.x1 - s.x0);
      const l = Math.hypot(nx, ny) || 1;
      const hx = (nx / l) * (s.width / 2);
      const hy = (ny / l) * (s.width / 2);
      line(px, s.x0 - ox + hx, s.y0 - oy + hy, s.x1 - ox + hx, s.y1 - oy + hy, c);
      line(px, s.x0 - ox - hx, s.y0 - oy - hy, s.x1 - ox - hx, s.y1 - oy - hy, c);
      circle(px, s.x0 - ox, s.y0 - oy, s.width / 2, c);
      circle(px, s.x1 - ox, s.y1 - oy, s.width / 2, c);
      break;
    }
    case 'cone': {
      const a = Math.atan2(s.dirY, s.dirX);
      circle(px, s.x - ox, s.y - oy, s.range, c, a - s.halfAngle, a + s.halfAngle);
      line(
        px,
        s.x - ox,
        s.y - oy,
        s.x - ox + Math.cos(a - s.halfAngle) * s.range,
        s.y - oy + Math.sin(a - s.halfAngle) * s.range,
        c,
      );
      line(
        px,
        s.x - ox,
        s.y - oy,
        s.x - ox + Math.cos(a + s.halfAngle) * s.range,
        s.y - oy + Math.sin(a + s.halfAngle) * s.range,
        c,
      );
      break;
    }
    case 'ring':
      circle(px, s.x - ox, s.y - oy, s.r0, c);
      circle(px, s.x - ox, s.y - oy, s.r1, c);
      break;
    case 'field':
      circle(px, s.x - ox, s.y - oy, s.r, c);
      circle(px, s.x - ox, s.y - oy, s.r * 0.5, c);
      break;
  }
}

/** Redraw the layer for this view. `shapes` from `Fighter.debugShapes`; `bounds` draws each fighter's live AABB. */
export function drawDebugShapes(
  layer: RenderLayer,
  view: ViewRect,
  shapes: readonly DebugShape[],
  bounds: readonly [number, number, number, number][],
): void {
  const px = layer.pixels;
  px.fill(0);
  for (const s of shapes) drawShape(px, s.shape, view.x0, view.y0, s.color);
  const bc = rgba(120, 255, 160, 200);
  for (const b of bounds) {
    line(px, b[0] - view.x0, b[1] - view.y0, b[2] - view.x0, b[1] - view.y0, bc);
    line(px, b[2] - view.x0, b[1] - view.y0, b[2] - view.x0, b[3] - view.y0, bc);
    line(px, b[2] - view.x0, b[3] - view.y0, b[0] - view.x0, b[3] - view.y0, bc);
    line(px, b[0] - view.x0, b[3] - view.y0, b[0] - view.x0, b[1] - view.y0, bc);
  }
  layer.version++;
  layer.dirty = null;
  layer.visible = true;
}
