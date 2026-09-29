import { LINK, linkIndex, rasterLink } from '@/titans';
import type { Overlay } from './overlay';

/**
 * Draws forged chains into an `Overlay`: links placed along a sagging span or along a free polyline (a whip), alternating face-on
 * rings and edge-on bars, hand-shaded by the same `rasterLink` the Nexus painter uses so live chains match the painted ones.
 * One pen per behaviour: the pixel sink is a bound field, so drawing allocates nothing.
 */
export class ChainPen {
  private ov!: Overlay;
  private readonly ramp: number[];
  private tone = 0;
  private readonly sink: (px: number, py: number, light: number) => void;

  constructor(ramp: number[]) {
    this.ramp = ramp;
    this.sink = (px, py, light): void => {
      this.ov.set(px, py, this.ramp[linkIndex(light, this.tone, this.ramp.length)]!);
    };
  }

  /** Draw one link. `k` picks ring or bar and a little tone variation so neighbours differ. */
  link(ov: Overlay, x: number, y: number, tx: number, ty: number, k: number, bias = 0): void {
    this.ov = ov;
    this.tone = (k % 2 === 0 ? 0.25 : -0.25) + bias;
    rasterLink(x, y, tx, ty, k % 2 === 0, this.sink);
  }

  /**
   * A chain from (x0,y0) to (x1,y1) hanging in a shallow parabola of depth `sag` px (perpendicular to the span), with a travelling
   * wave of amplitude `wave` px. `reveal` (0..1) draws only that fraction of the span from the start: a chain being paid out.
   * Returns the position of the last link drawn through `out` (the tip), so a hook can be attached.
   */
  span(
    ov: Overlay,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    sag: number,
    wave: number,
    phase: number,
    reveal: number,
    out?: { x: number; y: number },
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 4 || reveal <= 0) return;
    const nx = -dy / len;
    const ny = dx / len;
    const n = Math.max(2, Math.round(len / LINK.pitch));
    const last = Math.min(n, Math.ceil(n * Math.min(1, reveal)));
    for (let k = 0; k < last; k++) {
      const t = (k + 0.5) / n;
      const off = sag * 4 * t * (1 - t) + wave * Math.sin(t * 9 + phase) * Math.sin(t * Math.PI);
      const px = x0 + dx * t + nx * off;
      const py = y0 + dy * t + ny * off;
      // tangent by a small forward difference of the same curve
      const t2 = t + 0.02;
      const off2 = sag * 4 * t2 * (1 - t2) + wave * Math.sin(t2 * 9 + phase) * Math.sin(t2 * Math.PI);
      const qx = x0 + dx * t2 + nx * off2 - px;
      const qy = y0 + dy * t2 + ny * off2 - py;
      const ql = Math.hypot(qx, qy) || 1;
      this.link(ov, px, py, qx / ql, qy / ql, k);
      if (out && k === last - 1) {
        out.x = px;
        out.y = py;
      }
    }
  }

  /** Links along a free polyline of `n` points (flat xs/ys), one link per point pair midpoint: a loose whip or a hanging end. */
  polyline(ov: Overlay, xs: Float32Array, ys: Float32Array, n: number): void {
    for (let k = 0; k + 1 < n; k++) {
      const dx = xs[k + 1]! - xs[k]!;
      const dy = ys[k + 1]! - ys[k]!;
      const l = Math.hypot(dx, dy) || 1;
      this.link(ov, (xs[k]! + xs[k + 1]!) / 2, (ys[k]! + ys[k + 1]!) / 2, dx / l, dy / l, k);
    }
  }
}
