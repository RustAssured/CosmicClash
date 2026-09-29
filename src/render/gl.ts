import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DataTexture,
  DoubleSide,
  GLSL3,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NearestFilter,
  NoBlending,
  OrthographicCamera,
  RawShaderMaterial,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  WebGLRenderTarget,
  type IUniform,
  type PixelFormat,
  type TextureDataType,
  type WebGLRenderer,
} from 'three';
import { FULLSCREEN_VERT } from './shaders';

/** Small three.js helpers shared by the renderer passes. Everything here is allocation-free after construction. */

export interface RtOptions {
  type?: TextureDataType;
  filter?: 'nearest' | 'linear';
  /** Number of colour attachments (MRT). */
  count?: number;
  format?: PixelFormat;
}

export function makeRT(w: number, h: number, o: RtOptions = {}): WebGLRenderTarget {
  const f = o.filter === 'linear' ? LinearFilter : NearestFilter;
  const rt = new WebGLRenderTarget(w, h, {
    type: o.type ?? UnsignedByteType,
    format: o.format ?? RGBAFormat,
    minFilter: f,
    magFilter: f,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    count: o.count ?? 1,
  });
  return rt;
}

/** One big triangle covering the viewport: shared by every full-screen pass. */
let sharedTriangle: BufferGeometry | null = null;
export function fullscreenTriangle(): BufferGeometry {
  if (!sharedTriangle) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    sharedTriangle = g;
  }
  return sharedTriangle;
}

/** A unit quad (0..1) used by layer draws; the vertex shader maps it into the destination rectangle. */
let sharedQuad: BufferGeometry | null = null;
export function unitQuad(): BufferGeometry {
  if (!sharedQuad) {
    const g = new BufferGeometry();
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3),
    );
    g.setIndex([0, 1, 2, 2, 1, 3]);
    sharedQuad = g;
  }
  return sharedQuad;
}

/** Disposes the shared geometries (renderer.dispose). */
export function disposeSharedGeometry(): void {
  sharedTriangle?.dispose();
  sharedTriangle = null;
  sharedQuad?.dispose();
  sharedQuad = null;
}

/** Forget the shared geometries WITHOUT disposing them (their GL buffers died with a lost context). */
export function resetSharedGeometry(): void {
  sharedTriangle = null;
  sharedQuad = null;
}

const passCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

export function makeMaterial(
  fragmentShader: string,
  uniforms: Record<string, IUniform>,
  vertexShader = FULLSCREEN_VERT,
): RawShaderMaterial {
  return new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    transparent: false,
    side: DoubleSide,
  });
}

/** A full-screen pass: one triangle, one material, drawn into any target (or the canvas). */
export class FullscreenPass {
  readonly material: RawShaderMaterial;
  private readonly scene = new Scene();
  private readonly mesh: Mesh;

  constructor(fragmentShader: string, uniforms: Record<string, IUniform>) {
    this.material = makeMaterial(fragmentShader, uniforms);
    this.mesh = new Mesh(fullscreenTriangle(), this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  get uniforms(): Record<string, IUniform> {
    return this.material.uniforms;
  }

  render(renderer: WebGLRenderer, target: WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, passCamera);
  }

  dispose(): void {
    this.material.dispose();
  }
}

export const HALF_FLOAT = HalfFloatType;

/** A tiny DataTexture helper for lookup tables (nearest, no mips, no colour management). */
export function dataTexture(
  data: Uint8Array | Float32Array,
  w: number,
  h: number,
  format: PixelFormat,
  type: TextureDataType,
): DataTexture {
  const t = new DataTexture(data, w, h, format, type);
  t.minFilter = NearestFilter;
  t.magFilter = NearestFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}
