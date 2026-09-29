import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DoubleSide,
  GLSL3,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NearestFilter,
  NoBlending,
  OrthographicCamera,
  RawShaderMaterial,
  Scene,
  UnsignedByteType,
  WebGLRenderTarget,
  type IUniform,
  type TextureDataType,
  type WebGLRenderer,
} from 'three';
import { FORCES_GLSL, NOISE_GLSL, SCENERY_HEAD } from './glsl';

/**
 * GPU baking: render a procedural texture ONCE at stage load with a fragment shader (fbm sculpting, lighting, shadow
 * marching) instead of paying for it every frame. Bakes read/write GL-native targets; the shader body receives `vUv`
 * (0..1, y up) and can call `bakePx()` for a top-left-origin pixel position in the target.
 */

let tri: BufferGeometry | null = null;
const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

export interface BakeTarget {
  rt: WebGLRenderTarget;
  width: number;
  height: number;
}

export function makeBakeTarget(
  w: number,
  h: number,
  opts: { count?: number; type?: TextureDataType; linear?: boolean } = {},
): BakeTarget {
  const f = opts.linear ? LinearFilter : NearestFilter;
  const rt = new WebGLRenderTarget(w, h, {
    type: opts.type ?? UnsignedByteType,
    minFilter: f,
    magFilter: f,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    count: opts.count ?? 1,
  });
  return { rt, width: w, height: h };
}

export const HALF = HalfFloatType;

/** Run `fragment` (a shader body; see file comment) once into `target`. `withNoise` prepends the noise/forces chunks. */
export function runBake(
  renderer: WebGLRenderer,
  target: BakeTarget,
  fragment: string,
  uniforms: Record<string, IUniform>,
  opts: { multi?: boolean } = {},
): void {
  if (!tri) {
    tri = new BufferGeometry();
    tri.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  }
  const outputs = opts.multi
    ? 'layout(location = 0) out vec4 o0;\nlayout(location = 1) out vec4 o1;'
    : 'out vec4 o0;';
  const mat = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: `${SCENERY_HEAD}
in vec3 position;
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `${SCENERY_HEAD}${NOISE_GLSL}${FORCES_GLSL}
in vec2 vUv;
${outputs}
uniform vec2 uBakeSize;
vec2 bakePx() { return vec2(vUv.x, 1.0 - vUv.y) * uBakeSize; }
${fragment}`,
    uniforms: { uBakeSize: { value: [target.width, target.height] }, ...uniforms },
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    side: DoubleSide,
  });
  const scene = new Scene();
  const mesh = new Mesh(tri, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target.rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prev);
  mat.dispose();
}

export function disposeBakeGeometry(): void {
  tri?.dispose();
  tri = null;
}
