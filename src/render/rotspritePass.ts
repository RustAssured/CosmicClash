import {
  DataTexture,
  DoubleSide,
  GLSL3,
  Mesh,
  NearestFilter,
  NoBlending,
  OrthographicCamera,
  RawShaderMaterial,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  Vector2,
  Vector4,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { unitQuad } from './gl';
import { ROTSPRITE_GLSL, ROT_LUT, rotBoundsEx, type RotMode, type RotPartEx } from './rotsprite';

/**
 * Rotation spike, GPU side: draws `RotPartEx`s (sub-rect sprite + pivot + quantised angle) with the clean-edge sampler of
 * `rotsprite.ts` into a target. Not wired into the compositor or the contracts yet (docs/proposals/151-S5-render-parts.md);
 * the verification page uses it to prove GPU = CPU twin and to measure the cost.
 */
const VERT = /* glsl */ `precision highp float;
in vec3 position;
uniform vec4 uRect;   // destination x0, y0, x1, y1 (logical px, top-left origin)
uniform vec2 uRes;
void main() {
  vec2 p = mix(uRect.xy, uRect.zw, position.xy);
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `precision highp float;
precision highp int;
precision highp sampler2D;
uniform vec2 uRes;
uniform ivec2 uDest;   // destination pivot corner (logical px)
${ROTSPRITE_GLSL}
out vec4 o;
void main() {
  ivec2 P = ivec2(floor(gl_FragCoord.x), int(floor(uRes.y - gl_FragCoord.y)));
  ivec2 texel;
  vec4 c = rotSampleModeGL(P - uDest, texel);
  if (c.a == 0.0) discard;
  o = c;
}
`;

interface Slot {
  mesh: Mesh;
  mat: RawShaderMaterial;
  tex: DataTexture | null;
}

export class RotSpritePass {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly slots: Slot[] = [];
  private readonly res: Vector2;

  constructor(width: number, height: number) {
    this.res = new Vector2(width, height);
  }

  private slot(i: number): Slot {
    let s = this.slots[i];
    if (!s) {
      const mat = new RawShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        glslVersion: GLSL3,
        uniforms: {
          uRect: { value: new Vector4() },
          uRes: { value: this.res },
          uDest: { value: [0, 0] },
          uPart: { value: null },
          uPartOrigin: { value: [0, 0] },
          uPartSize: { value: [0, 0] },
          uFacing: { value: 1 },
          uPivot: { value: [0, 0] },
          uRotCS: { value: [0, 0] },
          uRotMode: { value: 0 },
        },
        depthTest: false,
        depthWrite: false,
        blending: NoBlending,
        side: DoubleSide,
      });
      const mesh = new Mesh(unitQuad(), mat);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      s = { mesh, mat, tex: null };
      this.slots.push(s);
    }
    return s;
  }

  /** Upload a part's pixels (once per part; the spike's parts are static). */
  texture(part: RotPartEx): DataTexture {
    const t = new DataTexture(
      new Uint8Array(part.pixels.buffer, part.pixels.byteOffset, part.w * part.h * 4),
      part.w,
      part.h,
      RGBAFormat,
      UnsignedByteType,
    );
    t.minFilter = NearestFilter;
    t.magFilter = NearestFilter;
    t.generateMipmaps = false;
    t.flipY = false;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    return t;
  }

  /** Draw parts (each with its texture from `texture()`) at destination pivots into `target` (not cleared). */
  draw(
    renderer: WebGLRenderer,
    target: WebGLRenderTarget,
    parts: readonly { part: RotPartEx; tex: DataTexture; qx: number; qy: number; mode?: RotMode }[],
  ): void {
    for (let i = 0; i < this.slots.length; i++) this.slots[i]!.mesh.visible = false;
    parts.forEach((p, i) => {
      const s = this.slot(i);
      const b = rotBoundsEx(p.part);
      const u = s.mat.uniforms;
      (u.uRect!.value as Vector4).set(p.qx + b.x0, p.qy + b.y0, p.qx + b.x1, p.qy + b.y1);
      u.uDest!.value = [p.qx, p.qy];
      u.uPart!.value = p.tex;
      u.uPartSize!.value = [p.part.w, p.part.h];
      u.uPivot!.value = [p.part.px, p.part.py];
      u.uRotCS!.value = [ROT_LUT.cos[p.part.step]!, ROT_LUT.sin[p.part.step]!];
      u.uFacing!.value = p.part.facing === -1 ? -1 : 1;
      u.uRotMode!.value = p.mode === 'majority4' ? 1 : 0;
      s.mesh.visible = true;
      s.mesh.renderOrder = i;
    });
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    for (const s of this.slots) s.mat.dispose();
    this.slots.length = 0;
  }
}
