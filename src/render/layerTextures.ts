import {
  DataTexture,
  NearestFilter,
  RedFormat,
  RGBAFormat,
  UnsignedByteType,
  type WebGLRenderer,
} from 'three';
import type { RenderLayer } from '@/contracts';
import { planUpload, StaleRegistry, type CachedLayerState } from './layerCache';

/**
 * GPU side of the layer cache: one RGBA8 texture (and an optional R8 emissive texture) per RenderLayer id.
 *
 * - Textures wrap the layer's own typed array (no copy, no per-frame allocation).
 * - Unchanged layers (same `version`) are never re-uploaded; changed ones upload only their `dirty` rect with
 *   texSubImage2D + UNPACK_ROW_LENGTH, or everything when the rect is large.
 * - Layers not drawn for `STALE_FRAMES` frames are freed.
 */

/** Frames without use before a layer's texture is freed. */
export const STALE_FRAMES = 240;
const SWEEP_EVERY = 8;

interface Entry {
  tex: DataTexture;
  emis: DataTexture | null;
  state: CachedLayerState;
  bytes: Uint8Array;
  emisBytes: Uint8Array | null;
}

export interface LayerGpu {
  tex: DataTexture;
  emis: DataTexture | null;
}

export class LayerTextures {
  private readonly entries = new StaleRegistry<Entry>();
  private frame = 0;
  /** Frames without use before a layer's texture is freed (tests lower it). */
  staleFrames = STALE_FRAMES;
  private readonly freed: Entry[] = [];
  /** Counters for tests / stats. */
  uploads = { create: 0, full: 0, rect: 0, texels: 0 };

  constructor(private readonly renderer: WebGLRenderer) {}

  get size(): number {
    return this.entries.size;
  }

  beginFrame(): void {
    this.frame++;
  }

  acquire(layer: RenderLayer): LayerGpu {
    let e = this.entries.get(layer.id, this.frame);
    const plan = planUpload(e?.state, layer);
    if (plan.kind === 'create') {
      if (e) this.destroy(e);
      e = this.create(layer);
      this.entries.set(layer.id, e, this.frame);
      this.uploads.create++;
      this.uploads.texels += layer.w * layer.h;
      layer.dirty = null;
    } else if (e) {
      if (plan.kind === 'full') {
        e.tex.needsUpdate = true;
        if (e.emis) e.emis.needsUpdate = true;
        this.uploads.full++;
        this.uploads.texels += layer.w * layer.h;
      } else if (plan.kind === 'rect') {
        this.uploadRect(e, layer, plan.x0, plan.y0, plan.x1, plan.y1);
        this.uploads.rect++;
        this.uploads.texels += (plan.x1 - plan.x0) * (plan.y1 - plan.y0);
      }
      if (plan.kind !== 'none') {
        e.state.version = layer.version;
        // The producer accumulates a fresh dirty rect from here (same contract as MatterMap.dirty).
        layer.dirty = null;
      }
    }
    return e!;
  }

  /** Free textures of layers that were not drawn recently. Call once per frame after drawing. */
  sweep(): void {
    if (this.frame % SWEEP_EVERY !== 0) return; // walking the registry every frame is wasted work
    this.freed.length = 0;
    this.entries.sweep(this.frame, this.staleFrames, this.freed);
    for (const e of this.freed) this.destroy(e);
    this.freed.length = 0;
  }

  /** Forget everything (context lost / restored): GPU objects are gone, JS objects are dropped. */
  reset(): void {
    const all = this.entries.clear();
    for (const e of all) this.destroy(e);
  }

  dispose(): void {
    this.reset();
  }

  private create(layer: RenderLayer): Entry {
    const bytes = new Uint8Array(layer.pixels.buffer, layer.pixels.byteOffset, layer.pixels.byteLength);
    const tex = new DataTexture(bytes, layer.w, layer.h, RGBAFormat, UnsignedByteType);
    configure(tex, 4);
    let emis: DataTexture | null = null;
    let emisBytes: Uint8Array | null = null;
    if (layer.emissive) {
      emisBytes = new Uint8Array(layer.emissive.buffer, layer.emissive.byteOffset, layer.emissive.byteLength);
      emis = new DataTexture(emisBytes, layer.w, layer.h, RedFormat, UnsignedByteType);
      configure(emis, 1);
    }
    return {
      tex,
      emis,
      bytes,
      emisBytes,
      state: {
        version: layer.version,
        w: layer.w,
        h: layer.h,
        pixels: layer.pixels,
        emissive: layer.emissive,
      },
    };
  }

  private destroy(e: Entry): void {
    e.tex.dispose();
    e.emis?.dispose();
  }

  private uploadRect(e: Entry, layer: RenderLayer, x0: number, y0: number, x1: number, y1: number): void {
    const r = this.renderer;
    const gl = r.getContext() as WebGL2RenderingContext;
    const props = r.properties.get(e.tex) as { __webglTexture?: WebGLTexture } | undefined;
    if (!props?.__webglTexture) {
      // Not on the GPU yet (created this frame or context was lost): the full path uploads everything.
      e.tex.needsUpdate = true;
      if (e.emis) e.emis.needsUpdate = true;
      return;
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, layer.w);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    r.state.bindTexture(gl.TEXTURE_2D, props.__webglTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, x1 - x0, y1 - y0, gl.RGBA, gl.UNSIGNED_BYTE, e.bytes);
    if (e.emis && e.emisBytes) {
      const ep = r.properties.get(e.emis) as { __webglTexture?: WebGLTexture } | undefined;
      if (ep?.__webglTexture) {
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        r.state.bindTexture(gl.TEXTURE_2D, ep.__webglTexture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, x1 - x0, y1 - y0, gl.RED, gl.UNSIGNED_BYTE, e.emisBytes);
      } else {
        e.emis.needsUpdate = true;
      }
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }
}

function configure(t: DataTexture, align: 1 | 4): void {
  t.minFilter = NearestFilter;
  t.magFilter = NearestFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.unpackAlignment = align;
  t.needsUpdate = true;
}
