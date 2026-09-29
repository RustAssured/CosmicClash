import type { RenderLayer } from '@/contracts';

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
}

/** When the dirty rect covers at least this fraction of the layer a single full upload is cheaper. */
export const FULL_UPLOAD_FRACTION = 0.6;

export function planUpload(
  cached: CachedLayerState | undefined,
  layer: Pick<RenderLayer, 'version' | 'w' | 'h' | 'pixels' | 'emissive' | 'dirty'>,
): UploadPlan {
  if (
    !cached ||
    cached.w !== layer.w ||
    cached.h !== layer.h ||
    cached.pixels !== layer.pixels ||
    cached.emissive !== layer.emissive
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
