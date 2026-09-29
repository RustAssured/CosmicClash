import { makeLayer, type MatterBody, type RenderLayer } from '@/contracts';

/**
 * A RenderLayer for a body the fighter owns besides its titan (a moon): it wraps the body's `map.pixels` / `emissive`, follows the
 * body's transform (with the previous position for interpolation) and follows the same dirty-rect protocol as the titan's own
 * layer (copy the map's changed rect in, then consume it), so the renderer uploads only what changed.
 */
export class TrackedBodyLayer {
  readonly layer: RenderLayer;
  private readonly body: MatterBody;
  private px: number;
  private py: number;
  private readonly rect = { x0: 0, y0: 0, x1: 0, y1: 0 };

  constructor(id: string, z: number, body: MatterBody) {
    const map = body.map;
    const L = makeLayer(id, 'world', z, map.w, map.h);
    L.pixels = map.pixels;
    L.emissive = map.emissive;
    L.anchorX = body.transform.anchorX;
    L.anchorY = body.transform.anchorY;
    this.layer = L;
    this.body = body;
    this.px = body.transform.x;
    this.py = body.transform.y;
    L.x = L.prevX = this.px;
    L.y = L.prevY = this.py;
  }

  /** Call once per tick after the transform was set: shifts current → previous. */
  tickStart(): void {
    const t = this.body.transform;
    this.layer.prevX = this.px;
    this.layer.prevY = this.py;
    this.px = t.x;
    this.py = t.y;
  }

  /** Call from renderLayers: publish the position, version and the consumed dirty rect. */
  flush(z: number): void {
    const L = this.layer;
    const t = this.body.transform;
    const map = this.body.map;
    L.x = t.x;
    L.y = t.y;
    L.z = z;
    L.version = map.version;
    const md = map.dirty;
    if (md !== null) {
      let d = L.dirty;
      if (d === null) {
        d = this.rect;
        d.x0 = md.x0;
        d.y0 = md.y0;
        d.x1 = md.x1;
        d.y1 = md.y1;
        L.dirty = d;
      } else {
        if (md.x0 < d.x0) d.x0 = md.x0;
        if (md.y0 < d.y0) d.y0 = md.y0;
        if (md.x1 > d.x1) d.x1 = md.x1;
        if (md.y1 > d.y1) d.y1 = md.y1;
      }
      map.dirty = null;
    }
    L.pixels = map.pixels;
    L.emissive = map.emissive;
  }
}
