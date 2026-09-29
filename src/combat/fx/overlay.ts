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
  /** Bounding box of pixels drawn this frame / last frame (layer-local, half-open) — clears and uploads touch only these. */
  private bx0 = 0;
  private by0 = 0;
  private bx1 = 0;
  private by1 = 0;
  private pbx0 = 0;
  private pby0 = 0;
  private pbx1 = 0;
  private pby1 = 0;
  private readonly dirtyRect = { x0: 0, y0: 0, x1: 0, y1: 0 };

  constructor(
    id: string,
    z: number,
    w: number,
    h: number,
    blend: 'normal' | 'add' = 'normal',
    emissive = false,
  ) {
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
    // clear only what was drawn last frame (layer-local coordinates are stable)
    this.clearBox(this.bx0, this.by0, this.bx1, this.by1);
    this.pbx0 = this.bx0;
    this.pby0 = this.by0;
    this.pbx1 = this.bx1;
    this.pby1 = this.by1;
    this.bx0 = this.w;
    this.by0 = this.h;
    this.bx1 = 0;
    this.by1 = 0;
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

  private clearBox(x0: number, y0: number, x1: number, y1: number): void {
    if (x1 <= x0 || y1 <= y0) return;
    const e = this.layer.emissive;
    for (let y = y0; y < y1; y++) {
      const a = y * this.w + x0;
      const b = y * this.w + x1;
      this.px.fill(0, a, b);
      if (e) e.fill(0, a, b);
    }
  }

  private mark(x: number, y: number): void {
    if (x < this.bx0) this.bx0 = x;
    if (y < this.by0) this.by0 = y;
    if (x + 1 > this.bx1) this.bx1 = x + 1;
    if (y + 1 > this.by1) this.by1 = y + 1;
  }

  /** Finish the frame: bump the version if anything was drawn, hide the layer if not. `dirty` covers old ∪ new drawing. */
  end(): void {
    const L = this.layer;
    L.visible = this.drawn;
    L.version++;
    const had = this.pbx1 > this.pbx0;
    const has = this.bx1 > this.bx0;
    if (had || has) {
      const x0 = Math.min(had ? this.pbx0 : this.w, has ? this.bx0 : this.w);
      const y0 = Math.min(had ? this.pby0 : this.h, has ? this.by0 : this.h);
      const x1 = Math.max(had ? this.pbx1 : 0, has ? this.bx1 : 0);
      const y1 = Math.max(had ? this.pby1 : 0, has ? this.by1 : 0);
      // the renderer nulls `dirty` once uploaded; until then keep accumulating so no changed pixel is ever dropped
      const d = L.dirty;
      if (d === null) {
        const own = this.dirtyRect;
        own.x0 = x0;
        own.y0 = y0;
        own.x1 = x1;
        own.y1 = y1;
        L.dirty = own;
      } else {
        if (x0 < d.x0) d.x0 = x0;
        if (y0 < d.y0) d.y0 = y0;
        if (x1 > d.x1) d.x1 = x1;
        if (y1 > d.y1) d.y1 = y1;
      }
    }
  }

  hide(): void {
    if (this.layer.visible || this.bx1 > this.bx0) {
      this.clearBox(this.bx0, this.by0, this.bx1, this.by1);
      this.layer.visible = false;
      this.layer.version++;
      this.layer.dirty = null;
      this.bx0 = this.w;
      this.by0 = this.h;
      this.bx1 = 0;
      this.by1 = 0;
      this.pbx0 = 0;
      this.pby0 = 0;
      this.pbx1 = 0;
      this.pby1 = 0;
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
    this.mark(x, y);
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
    this.mark(x, y);
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
   * Tapered capsule from (ax,ay) radius ra to (bx,by) radius rb, shaded with three precomputed colours: `cLit` on the side
   * facing the up-left light, `cMid`, `cDark` on the far side. Closure-free and sqrt-free per pixel (this runs for every
   * tendril segment every tick).
   */
  capsule(
    ax: number,
    ay: number,
    ra: number,
    bx: number,
    by: number,
    rb: number,
    cLit: number,
    cMid: number,
    cDark: number,
    emissive = 0,
  ): void {
    const vx = bx - ax;
    const vy = by - ay;
    const l2 = vx * vx + vy * vy || 1;
    const rmax = ra > rb ? ra : rb;
    const x0 = Math.floor((ax < bx ? ax : bx) - rmax - 1);
    const x1 = Math.ceil((ax > bx ? ax : bx) + rmax + 1);
    const y0 = Math.floor((ay < by ? ay : by) - rmax - 1);
    const y1 = Math.ceil((ay > by ? ay : by) + rmax + 1);
    const W = this.w;
    const H = this.h;
    const em = this.layer.emissive;
    for (let y = y0; y <= y1; y++) {
      const ly = y - this.oy;
      if (ly < 0 || ly >= H) continue;
      for (let x = x0; x <= x1; x++) {
        const lx = x - this.ox;
        if (lx < 0 || lx >= W) continue;
        const px = x + 0.5 - ax;
        const py = y + 0.5 - ay;
        let t = (px * vx + py * vy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = px - vx * t;
        const dy = py - vy * t;
        const r = ra + (rb - ra) * t;
        const d2 = dx * dx + dy * dy;
        if (d2 > r * r) continue;
        // light from the upper left: positive means this pixel sits on the lit flank
        const sd = -(dx + dy) * 0.7071;
        const i = ly * W + lx;
        this.px[i] = sd > 0.3 * r ? cLit : sd < -0.4 * r ? cDark : cMid;
        if (em !== undefined && emissive > 0) em[i] = emissive;
        if (lx < this.bx0) this.bx0 = lx;
        if (ly < this.by0) this.by0 = ly;
        if (lx + 1 > this.bx1) this.bx1 = lx + 1;
        if (ly + 1 > this.by1) this.by1 = ly + 1;
      }
    }
    this.drawn = true;
  }
}
