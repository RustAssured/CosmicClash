import { LOGICAL_H, LOGICAL_W } from '@/contracts';

/** Where the logical frame lands inside the physical canvas (all values in physical pixels). */
export interface ViewportLayout {
  /** Integer upscale factor (≥ 1) unless `integer` was false. */
  scale: number;
  /** Letterbox offset of the frame's top-left corner; may be negative when the canvas is smaller than the frame. */
  x: number;
  y: number;
  /** Size of the drawn frame = LOGICAL × scale. */
  w: number;
  h: number;
  physW: number;
  physH: number;
}

/**
 * Largest integer scale of the 640×360 frame that fits the canvas (never below 1), centred with a letterbox.
 * `integer = false` gives the largest exact-aspect fractional fit instead.
 */
export function computeViewport(physW: number, physH: number, integer = true): ViewportLayout {
  const fit = Math.min(physW / LOGICAL_W, physH / LOGICAL_H);
  const scale = integer ? Math.max(1, Math.floor(fit + 1e-9)) : Math.max(0.01, fit);
  const w = LOGICAL_W * scale;
  const h = LOGICAL_H * scale;
  return {
    scale,
    x: Math.floor((physW - w) / 2),
    y: Math.floor((physH - h) / 2),
    w,
    h,
    physW,
    physH,
  };
}

/** Map a point in physical canvas pixels (origin top-left) to logical frame coordinates. */
export function physicalToLogical(
  v: ViewportLayout,
  px: number,
  py: number,
  out: { x: number; y: number },
): void {
  out.x = (px - v.x) / v.scale;
  out.y = (py - v.y) / v.scale;
}
