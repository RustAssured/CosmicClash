import { worldToLocal, type BodyTransform, type RenderLayer, type ViewRect } from '@/contracts';

/**
 * Screen placement of a RenderLayer and the per-pixel source-cell mapping used to draw it.
 *
 * `sourceCell` is the CPU twin of the GLSL in `shaders.ts` (`LAYER_MAP`): the fragment shader evaluates exactly these
 * operations per screen pixel. It reproduces `worldToLocal` / `leanShift` from `contracts/space.ts` for pixel CENTRES,
 * which is what makes "what you see is what is hit". Tests compare the two over dense grids and `tools/render/verify`
 * compares the real GPU output against it.
 */

/** A layer is not interpolated across a jump larger than this (px per tick): teleports / round resets must not slide. */
export const TELEPORT_PX = 96;

export interface LayerPlacement {
  /** Screen-space (logical px, origin top-left of the view) integer position of the layer anchor. */
  ax: number;
  ay: number;
  /** Integer destination rectangle [x0,x1)×[y0,y1) in logical screen px, covering the sheared/mirrored sprite. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  facing: 1 | -1;
  lean: number;
  anchorX: number;
  anchorY: number;
  w: number;
  h: number;
  /** True for screen-space layers (drawn 1:1, no anchor/lean/facing). */
  screen: boolean;
}

export const makePlacement = (): LayerPlacement => ({
  ax: 0,
  ay: 0,
  x0: 0,
  y0: 0,
  x1: 0,
  y1: 0,
  facing: 1,
  lean: 0,
  anchorX: 0,
  anchorY: 0,
  w: 0,
  h: 0,
  screen: false,
});

const lerp1 = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Interpolated, integer-snapped coordinate with the teleport guard. */
export function snapInterp(prev: number, cur: number, alpha: number): number {
  const d = cur - prev;
  const v = d > TELEPORT_PX || d < -TELEPORT_PX ? cur : lerp1(prev, cur, alpha);
  return Math.round(v);
}

export function placeLayer(
  layer: Pick<
    RenderLayer,
    'space' | 'x' | 'y' | 'prevX' | 'prevY' | 'anchorX' | 'anchorY' | 'facing' | 'lean' | 'w' | 'h'
  >,
  view: ViewRect,
  alpha: number,
  out: LayerPlacement,
): void {
  out.w = layer.w;
  out.h = layer.h;
  if (layer.space === 'screen') {
    out.screen = true;
    out.ax = 0;
    out.ay = 0;
    out.x0 = 0;
    out.y0 = 0;
    out.x1 = layer.w;
    out.y1 = layer.h;
    out.facing = 1;
    out.lean = 0;
    out.anchorX = 0;
    out.anchorY = 0;
    return;
  }
  out.screen = false;
  const ax = snapInterp(layer.prevX, layer.x, alpha) - view.x0;
  const ay = snapInterp(layer.prevY, layer.y, alpha) - view.y0;
  out.ax = ax;
  out.ay = ay;
  out.facing = layer.facing;
  out.lean = layer.lean;
  out.anchorX = layer.anchorX;
  out.anchorY = layer.anchorY;
  const xa = ax + (0 - layer.anchorX) * layer.facing;
  const xb = ax + (layer.w - layer.anchorX) * layer.facing;
  // Row shear is |lean|·|anchorY − row| / anchorY, which exceeds |lean| for rows far below a high anchor.
  const rowSpan = Math.max(Math.abs(layer.anchorY), Math.abs(layer.anchorY - (layer.h - 1)));
  const pad = Math.ceil((Math.abs(layer.lean) * rowSpan) / Math.max(1, layer.anchorY)) + 1;
  out.x0 = Math.floor(Math.min(xa, xb) - pad);
  out.x1 = Math.ceil(Math.max(xa, xb) + pad);
  out.y0 = ay - layer.anchorY;
  out.y1 = out.y0 + layer.h;
}

/**
 * Source cell for the screen pixel (px, py) (integer, view-relative). Returns false when the pixel falls outside the
 * sprite. Uses float32 arithmetic (Math.fround) for the lean division so it matches the GPU bit for bit.
 */
export function sourceCell(
  p: LayerPlacement,
  px: number,
  py: number,
  out: { x: number; y: number },
): boolean {
  if (p.screen) {
    if (px < 0 || py < 0 || px >= p.w || py >= p.h) return false;
    out.x = px;
    out.y = py;
    return true;
  }
  const ly = py - p.ay + p.anchorY;
  if (ly < 0 || ly >= p.h) return false;
  const shift = Math.floor(
    Math.fround(Math.fround(p.lean * (p.anchorY - ly)) / Math.max(1, p.anchorY)) + 0.5,
  );
  const d = px - p.ax - shift;
  const lx = p.facing > 0 ? d + p.anchorX : p.anchorX - 1 - d;
  if (lx < 0 || lx >= p.w) return false;
  out.x = lx;
  out.y = ly;
  return true;
}

const tmp = { x: 0, y: 0 };
/** The contract's own mapping (`worldToLocal` at a pixel CENTRE, floored): the ground truth tests compare against. */
export function contractCell(t: BodyTransform, wx: number, wy: number, out: { x: number; y: number }): void {
  worldToLocal(t, wx + 0.5, wy + 0.5, tmp);
  out.x = Math.floor(tmp.x);
  out.y = Math.floor(tmp.y);
}
