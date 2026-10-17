import {
  DataTexture,
  NearestFilter,
  RedFormat,
  RGFormat,
  RGBAFormat,
  UnsignedByteType,
  type WebGLRenderer,
} from 'three';
import type { RenderLayer } from '@/contracts';
import type { RenderLayerLit } from './unified';
import { LayerKeys, planUpload, StaleRegistry, type CachedLayerState } from './layerCache';
import { PROF } from './passProfiler';

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
  id?: string;
  tex: DataTexture;
  emis: DataTexture | null;
  state: CachedLayerState;
  bytes: Uint8Array;
  emisBytes: Uint8Array | null;
  light: DataTexture | null;
  lightBytes: Uint8Array | null;
  wet: DataTexture | null;
  wetBytes: Uint8Array | null;
  shade: DataTexture | null;
  chunk: DataTexture | null;
}

export interface LayerGpu {
  tex: DataTexture;
  emis: DataTexture | null;
  /** Lit parts (unified.ts): RGBA normal + form light per cell, and the R8 wet mask. */
  light: DataTexture | null;
  wet: DataTexture | null;
  /** 우리's shading plane (unified.ts): RGBA (surf, tone, edge, material code) per cell. */
  shade: DataTexture | null;
  /** 우리's chunk ids: RG8 = (id & 255, id >> 8) per cell. */
  chunk: DataTexture | null;
}

export class LayerTextures {
  private readonly entries = new StaleRegistry<Entry>();
  /** Ids are not unique across fighters (layerCache.ts `LayerKeys`): entries are keyed by id + pixel buffer. */
  private readonly keys = new LayerKeys();
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

  acquire(layer: RenderLayer & Partial<RenderLayerLit>): LayerGpu {
    const key = this.keys.key(layer);
    let e = this.entries.get(key, this.frame);
    const plan = planUpload(e?.state, layer);
    if (plan.kind === 'create') {
      if (e) this.destroy(e);
      e = this.create(layer);
      e.id = layer.id;
      this.entries.set(key, e, this.frame);
      this.uploads.create++;
      this.uploads.texels += layer.w * layer.h;
      PROF.count('create');
      PROF.count('createTexels', layer.w * layer.h);
      PROF.count(`create:${layer.id}:${layer.w}x${layer.h}`);
      layer.dirty = null;
    } else if (e) {
      if (plan.kind === 'full') {
        e.tex.needsUpdate = true;
        if (e.emis) e.emis.needsUpdate = true;
        if (e.light) e.light.needsUpdate = true;
        if (e.wet) e.wet.needsUpdate = true;
        if (e.shade) e.shade.needsUpdate = true;
        if (e.chunk) e.chunk.needsUpdate = true;
        this.uploads.full++;
        this.uploads.texels += layer.w * layer.h;
        PROF.count('full');
        PROF.count('fullTexels', layer.w * layer.h);
        PROF.count(`full:${layer.id}:${layer.w}x${layer.h}`);
      } else if (plan.kind === 'rect') {
        this.uploadRect(e, layer, plan.x0, plan.y0, plan.x1, plan.y1);
        this.uploads.rect++;
        PROF.count('rect');
        PROF.count('rectTexels', (plan.x1 - plan.x0) * (plan.y1 - plan.y0));
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

  /**
   * Verification (`?layercheck=1`, tools/perf/uploadcheck.ts): read back every colour / emissive texture used this frame and
   * compare it with the layer's own pixels, so partial uploads (dirty rectangles, skipped unchanged layers) are proven exact.
   * Returns the number of textures checked and a line per mismatch. Slow (a read-back each): never in normal play.
   */
  debugVerify(): { checked: number; bad: string[] } {
    const r = this.renderer;
    const gl = r.getContext() as WebGL2RenderingContext;
    const fb = gl.createFramebuffer();
    const bad: string[] = [];
    let checked = 0;
    r.state.bindFramebuffer(gl.FRAMEBUFFER, fb);
    for (const { value: e, lastUsed } of this.entries.values()) {
      if (lastUsed !== this.frame) continue;
      const { w, h } = e.state;
      const buf = new Uint8Array(w * h * 4);
      const pairs: [DataTexture | null, Uint8Array | null, 4 | 1][] = [
        [e.tex, e.bytes, 4],
        [e.emis, e.emisBytes, 1],
      ];
      for (const [tex, want, ch] of pairs) {
        if (!tex || !want) continue;
        const t = (r.properties.get(tex) as { __webglTexture?: WebGLTexture }).__webglTexture;
        if (!t) continue;
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        checked++;
        let n = 0;
        let first = -1;
        for (let i = 0; i < w * h; i++) {
          const same =
            ch === 4
              ? buf[i * 4] === want[i * 4] &&
                buf[i * 4 + 1] === want[i * 4 + 1] &&
                buf[i * 4 + 2] === want[i * 4 + 2] &&
                buf[i * 4 + 3] === want[i * 4 + 3]
              : buf[i * 4] === want[i];
          if (!same) {
            if (first < 0) first = i;
            n++;
          }
        }
        if (n)
          bad.push(
            `${e.id}${ch === 1 ? ' (emissive)' : ''}: ${n} texels differ, first at (${first % w}, ${(first / w) | 0})`,
          );
      }
    }
    r.state.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    r.setRenderTarget(null);
    return { checked, bad };
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

  private create(layer: RenderLayer & Partial<RenderLayerLit>): Entry {
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
    let light: DataTexture | null = null;
    let lightBytes: Uint8Array | null = null;
    if (layer.light) {
      lightBytes = layer.light;
      light = new DataTexture(lightBytes, layer.w, layer.h, RGBAFormat, UnsignedByteType);
      configure(light, 4);
    }
    let wet: DataTexture | null = null;
    let wetBytes: Uint8Array | null = null;
    if (layer.wet) {
      wetBytes = layer.wet;
      wet = new DataTexture(wetBytes, layer.w, layer.h, RedFormat, UnsignedByteType);
      configure(wet, 1);
    }
    let shade: DataTexture | null = null;
    if (layer.shade) {
      shade = new DataTexture(layer.shade, layer.w, layer.h, RGBAFormat, UnsignedByteType);
      configure(shade, 4);
    }
    let chunk: DataTexture | null = null;
    if (layer.chunk) {
      const b = new Uint8Array(layer.chunk.buffer, layer.chunk.byteOffset, layer.chunk.byteLength);
      chunk = new DataTexture(b, layer.w, layer.h, RGFormat, UnsignedByteType);
      configure(chunk, 2);
    }
    return {
      tex,
      emis,
      bytes,
      emisBytes,
      light,
      lightBytes,
      wet,
      wetBytes,
      shade,
      chunk,
      state: {
        version: layer.version,
        w: layer.w,
        h: layer.h,
        pixels: layer.pixels,
        emissive: layer.emissive,
        light: layer.light,
        wet: layer.wet,
        shade: layer.shade,
        chunk: layer.chunk,
      },
    };
  }

  private destroy(e: Entry): void {
    e.tex.dispose();
    e.emis?.dispose();
    e.light?.dispose();
    e.wet?.dispose();
    e.shade?.dispose();
    e.chunk?.dispose();
  }

  private uploadRect(e: Entry, layer: RenderLayer, x0: number, y0: number, x1: number, y1: number): void {
    // lit / wet data change with the pixels (a torn chunk): small, uploaded whole
    if (e.light) e.light.needsUpdate = true;
    if (e.wet) e.wet.needsUpdate = true;
    if (e.shade) e.shade.needsUpdate = true;
    if (e.chunk) e.chunk.needsUpdate = true;
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

function configure(t: DataTexture, align: 1 | 2 | 4): void {
  t.minFilter = NearestFilter;
  t.magFilter = NearestFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.unpackAlignment = align;
  t.needsUpdate = true;
}
