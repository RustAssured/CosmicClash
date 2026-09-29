import { makeLayer, pa, pb, pg, pr, rgba, type RenderLayer } from '@/contracts';

/**
 * A small software-rasterised world-space overlay (tendrils, beams, glows, pebbles…). The layer is a fixed-size sprite whose
 * anchor cell sits at an integer world position chosen each tick (`begin`), so world coordinates map to layer cells by a
 * plain integer offset and the renderer can interpolate the layer position between ticks. All buffers are preallocated.
 */
export class Overlay {
  readonly layer: RenderLayer;
  readonly w: number;
  readonly h: number;
  private readonly px: Uint32Array;
  /** World coordinate of layer cell (0,0). */
  ox = 0;
  oy = 0;
  private drawn = false;
  private lastX = 0;
  private lastY = 0;
  private started = false;

  constructor(id: string, z: number, w: number, h: number, blend: 'normal' | 'add' = 'normal', emissive = false) {
    this.layer = makeLayer(id, 'world', z, w, h);
    this.layer.blend = blend;
    this.layer.anchorX = w >> 1;
    this.layer.anchorY = h >> 1;
    this.layer.visible = false;
    if (emissive) this.layer.emissive = new Uint8Array(w * h);
    this.w = w;
    this.h = h;
    this.px = this.layer.pixels;
  }

  /** Start drawing a new frame centred on world (ax, ay). Clears the sprite. */
  begin(ax: number, ay: number): void {
    const cx = Math.round(ax);
    const cy = Math.round(ay);
    this.ox = cx - (this.w >> 1);
    this.oy = cy - (this.h >> 1);
    this.px.fill(0);
    this.layer.emissive?.fill(0);
    this.drawn = false;
    const L = this.layer;
    L.prevX = this.started ? this.lastX : cx;
    L.prevY = this.started ? this.lastY : cy;
    L.x = cx;
    L.y = cy;
    this.lastX = cx;
    this.lastY = cy;
    this.started = true;
  }

  /** Finish the frame: bump the version if anything was drawn, hide the layer if not. */
  end(): void {
    const L = this.layer;
    L.visible = this.drawn;
    L.version++;
    L.dirty = null;
  }

  hide(): void {
    if (this.layer.visible) {
      this.layer.visible = false;
      this.layer.version++;
    }
    this.started = false;
  }

  /** Set a world-space pixel (opaque overwrite). */
  set(wx: number, wy: number, c: number, emissive = 0): void {
    const x = wx - this.ox;
    const y = wy - this.oy;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    this.px[i] = c;
    if (emissive > 0 && this.layer.emissive) this.layer.emissive[i] = emissive;
    this.drawn = true;
  }

  get(wx: number, wy: number): number {
    const x = wx - this.ox;
    const y = wy - this.oy;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.px[y * this.w + x]!;
  }

  /** Additive light: adds `r,g,b` (clamped) to whatever is there. Pixels stay opaque so 'add' layers work with either alpha model. */
  add(wx: number, wy: number, r: number, g: number, b: number): void {
    const x = wx - this.ox;
    const y = wy - this.oy;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    const c = this.px[i]!;
    const has = pa(c) !== 0;
    const nr = Math.min(255, (has ? pr(c) : 0) + r);
    const ng = Math.min(255, (has ? pg(c) : 0) + g);
    const nb = Math.min(255, (has ? pb(c) : 0) + b);
    this.px[i] = rgba(nr, ng, nb, 255);
    this.drawn = true;
  }

  /** Filled disc, opaque. */
  disc(cx: number, cy: number, r: number, c: number, emissive = 0): void {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) this.set(x, y, c, emissive);
      }
  }

  /** Soft additive glow disc with quadratic falloff. */
  glow(cx: number, cy: number, r: number, cr: number, cg: number, cb: number, strength = 1): void {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const k = (1 - d2 / r2) ** 2 * strength;
        this.add(x, y, cr * k, cg * k, cb * k);
      }
  }

  /**
   * Tapered capsule from (ax,ay) radius ra to (bx,by) radius rb. `shade(t, side)` returns the packed colour for the
   * pixel at parameter t along the segment and `side` ∈ [-1,1] across it (−1 = toward the light).
   */
  taper(
    ax: number,
    ay: number,
    ra: number,
    bx: number,
    by: number,
    rb: number,
    shade: (t: number, side: number) => number,
    emissive = 0,
  ): void {
    const vx = bx - ax;
    const vy = by - ay;
    const l2 = vx * vx + vy * vy || 1;
    const rmax = Math.max(ra, rb);
    for (let y = Math.floor(Math.min(ay, by) - rmax - 1); y <= Math.ceil(Math.max(ay, by) + rmax + 1); y++) {
      for (let x = Math.floor(Math.min(ax, bx) - rmax - 1); x <= Math.ceil(Math.max(ax, bx) + rmax + 1); x++) {
        const px = x + 0.5 - ax;
        const py = y + 0.5 - ay;
        let t = (px * vx + py * vy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = px - vx * t;
        const dy = py - vy * t;
        const d = Math.sqrt(dx * dx + dy * dy);
        const r = ra + (rb - ra) * t;
        if (d > r) continue;
        // which side of the axis (perp component sign) relative to the up-left light
        const side = r > 0.01 ? ((dx * -0.7071 + dy * -0.7071) / r) * -1 : 0;
        this.set(x, y, shade(t, side), emissive);
      }
    }
  }
}
