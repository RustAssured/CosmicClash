import type { RenderLayerLit } from './unified';

/**
 * Pure bookkeeping for the layer texture cache: decides WHAT to upload for a layer (nothing, a dirty rect, the whole
 * thing, or a fresh texture) and which cached textures went stale. The GPU side lives in `layerTextures.ts`.
 */

export type UploadPlan =
  | { kind: 'none' }
  /** No texture yet, or the layer's size / backing arrays changed: allocate and upload everything. */
  | { kind: 'create' }
  | { kind: 'full' }
  | { kind: 'rect'; x0: number; y0: number; x1: number; y1: number };

export interface CachedLayerState {
  version: number;
  w: number;
  h: number;
  pixels: Uint32Array;
  emissive: Uint8Array | undefined;
  /** Lit-part data (unified.ts): per-cell normal + form light, and the wet mask. */
  light?: Uint8Array | undefined;
  wet?: Uint8Array | undefined;
  shade?: Uint8Array | undefined;
  chunk?: Uint16Array | undefined;
}

/** When the dirty rect covers at least this fraction of the layer a single full upload is cheaper. */
export const FULL_UPLOAD_FRACTION = 0.6;

export function planUpload(
  cached: CachedLayerState | undefined,
  layer: Pick<
    RenderLayerLit,
    'version' | 'w' | 'h' | 'pixels' | 'emissive' | 'dirty' | 'light' | 'wet' | 'shade' | 'chunk'
  >,
): UploadPlan {
  if (
    !cached ||
    cached.w !== layer.w ||
    cached.h !== layer.h ||
    cached.pixels !== layer.pixels ||
    cached.emissive !== layer.emissive ||
    cached.light !== layer.light ||
    cached.wet !== layer.wet ||
    cached.shade !== layer.shade ||
    cached.chunk !== layer.chunk
  ) {
    return { kind: 'create' };
  }
  if (cached.version === layer.version) return { kind: 'none' };
  const d = layer.dirty;
  if (!d) return { kind: 'full' };
  const x0 = Math.max(0, Math.floor(d.x0));
  const y0 = Math.max(0, Math.floor(d.y0));
  const x1 = Math.min(layer.w, Math.ceil(d.x1));
  const y1 = Math.min(layer.h, Math.ceil(d.y1));
  if (x1 <= x0 || y1 <= y0) return { kind: 'full' }; // version bumped but the rect is degenerate: be safe
  if ((x1 - x0) * (y1 - y0) >= FULL_UPLOAD_FRACTION * layer.w * layer.h) return { kind: 'full' };
  return { kind: 'rect', x0, y0, x1, y1 };
}

/**
 * Cache keys: a layer's id plus the identity of its pixel buffer. Layer ids are not unique: most behaviours name their
 * overlays without the slot (`planet-fx`, `witness-fx`, …), so in a mirror match both fighters drew under one id and each
 * evicted the other's texture: two fresh 1024×640 textures every frame for the colossus (Phase 0 perf gate, 20–40 ms frames).
 * Keyed by buffer too, every layer keeps its own texture; one that reallocates its buffer gets a new key (its old texture
 * is swept as stale). No allocation per frame once a buffer has been seen.
 */
export class LayerKeys {
  private readonly keys = new WeakMap<Uint32Array, { id: string; key: string }>();
  private next = 0;

  key(layer: { id: string; pixels: Uint32Array }): string {
    const k = this.keys.get(layer.pixels);
    if (k && k.id === layer.id) return k.key;
    const fresh = { id: layer.id, key: `${layer.id}#${this.next++}` };
    this.keys.set(layer.pixels, fresh);
    return fresh.key;
  }
}

/** Frame-stamped registry: touch what you draw, sweep what you stopped drawing. */
export class StaleRegistry<T> {
  private readonly items = new Map<string, { value: T; lastUsed: number }>();

  get size(): number {
    return this.items.size;
  }

  get(id: string, frame: number): T | undefined {
    const e = this.items.get(id);
    if (!e) return undefined;
    e.lastUsed = frame;
    return e.value;
  }

  set(id: string, value: T, frame: number): void {
    this.items.set(id, { value, lastUsed: frame });
  }

  delete(id: string): T | undefined {
    const e = this.items.get(id);
    this.items.delete(id);
    return e?.value;
  }

  /** Remove every entry not touched within `maxAge` frames; returns the removed values so the caller can dispose them. */
  sweep(frame: number, maxAge: number, out: T[] = []): T[] {
    for (const [id, e] of this.items) {
      if (frame - e.lastUsed > maxAge) {
        out.push(e.value);
        this.items.delete(id);
      }
    }
    return out;
  }

  /** Drop everything (context loss), returning the values. */
  clear(out: T[] = []): T[] {
    for (const e of this.items.values()) out.push(e.value);
    this.items.clear();
    return out;
  }

  values(): IterableIterator<{ value: T; lastUsed: number }> {
    return this.items.values();
  }
}
