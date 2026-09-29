import { makeLayer, type RenderLayer } from '@/contracts';

/**
 * A layer that lines up cell-for-cell with a titan's matter map: same size, and it copies the body layer's placement
 * (position, anchor, mirror, lean, hit-stop jitter) every frame, so writing `pixels[y * w + x]` paints exactly the map cell
 * (x, y) — however the body is flipped or sheared. Used for effects that live ON the body: granulation churn, pulsing cores,
 * glowing cracks, drifting clouds. The producer redraws it whenever it likes (`commit` bumps the version); the renderer
 * uploads the whole layer, so redraw at most every couple of ticks.
 */
export class BodyOverlay {
  readonly layer: RenderLayer;
  readonly w: number;
  readonly h: number;
  readonly px: Uint32Array;
  readonly emis: Uint8Array | null;
  private drawn = false;

  constructor(id: string, z: number, w: number, h: number, blend: 'normal' | 'add' = 'add', emissive = true) {
    this.layer = makeLayer(id, 'world', z, w, h);
    this.layer.blend = blend;
    this.layer.visible = false;
    this.px = this.layer.pixels;
    this.w = w;
    this.h = h;
    if (emissive) {
      this.emis = new Uint8Array(w * h);
      this.layer.emissive = this.emis;
    } else this.emis = null;
  }

  /** Copy the placement of the fighter's body layer (call from `renderLayers`, after the body layer was set up). */
  follow(body: RenderLayer): void {
    const L = this.layer;
    L.x = body.x;
    L.y = body.y;
    L.prevX = body.prevX;
    L.prevY = body.prevY;
    L.facing = body.facing;
    L.lean = body.lean;
    L.anchorX = body.anchorX;
    L.anchorY = body.anchorY;
  }

  /** Wipe the pixels (call before redrawing). */
  clear(): void {
    this.px.fill(0);
    if (this.emis) this.emis.fill(0);
    this.drawn = false;
  }

  /** Mark that something was drawn this pass (so an empty overlay hides itself). */
  mark(): void {
    this.drawn = true;
  }

  /** Publish the redraw: bump the version, hand the whole layer to the renderer. */
  commit(): void {
    const L = this.layer;
    L.visible = this.drawn;
    L.version++;
    L.dirty = null;
  }

  hide(): void {
    if (this.layer.visible) {
      this.clear();
      this.layer.visible = false;
      this.layer.version++;
      this.layer.dirty = null;
    }
  }
}
