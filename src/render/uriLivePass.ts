import {
  AddEquation,
  CustomBlending,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  GLSL3,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NearestFilter,
  OneFactor,
  OneMinusSrcAlphaFactor,
  RawShaderMaterial,
  RGBAFormat,
  SrcAlphaFactor,
  UnsignedByteType,
  Vector2,
  Vector4,
  type Scene,
} from 'three';
import { hex, pb, pg, pr } from '@/contracts';
import { unitQuad } from './gl';
import { URI_CORE_RAMPS, coreSurface, uriLoopPixels, uriPlumePixels, type UriLiveFx } from './uriLive';

/**
 * GPU half of 우리's live elements (see uriLive.ts): the loop / orbit pixels (instanced 1 px quads, back and front) and the two
 * cores (one quad each, the oracle's `drawCore` per pixel over a surface texture built once). Lives in the layer compositor's
 * scene so it slots into the part order right after the chamber; writes colour, emissive (every live pixel glows, as in the
 * oracle) and the id attachment (a 우리 titan pixel at the chamber's rank).
 */

const MAX_PX = 2048;

const POINT_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 aP;     // x, y, r, g (0..255)
in float aB;    // b
uniform vec2 uRes;
flat out vec3 vC;
void main() {
  vec2 p = aP.xy + position.xy;
  vC = vec3(aP.zw, aB) / 255.0;
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
}
`;
const POINT_FRAG = /* glsl */ `
precision highp float;
uniform vec4 uId;
flat in vec3 vC;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oEmis;
layout(location = 2) out vec4 oId;
void main() {
  oColor = vec4(vC, 1.0);
  oEmis = vec4(vC, 1.0);
  oId = vec4(uId.r, uId.g, 0.0, 1.0);
}
`;

const CORE_VERT = /* glsl */ `
precision highp float;
in vec3 position;
uniform vec2 uRes;
uniform vec4 uCore;   // cx, cy (screen px, float), R, hot (1 / 0)
void main() {
  vec2 p = uCore.xy + (position.xy * 2.0 - 1.0) * (uCore.z + 2.0);
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
}
`;
/** The oracle's drawCore, per pixel: rows v of the sphere, the spinning surface, ramp steps with the Bayer offset, the rim. */
const CORE_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform vec2 uRes;
uniform vec4 uCore;     // cx, cy, R, hot
uniform vec2 uSpinDim;  // spin (rad), dim
uniform sampler2D uSurf;   // mat (r, 1 | 2), tone (g)
uniform ivec2 uSurfSize;   // TW, TH
uniform vec3 uRamp[8];
uniform vec4 uId;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oEmis;
layout(location = 2) out vec4 oId;
const float BY[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
vec3 rampAt(float l, ivec2 P) {
  float b = (BY[(P.y & 3) * 4 + (P.x & 3)] + 0.5) / 16.0 - 0.5;
  int k = int(floor(l * 8.0 * 1.02 + b * 0.6));
  return uRamp[clamp(k, 0, 7)];
}
void main() {
  ivec2 P = ivec2(floor(gl_FragCoord.x), int(floor(uRes.y - gl_FragCoord.y)));
  float cx = uCore.x;
  float cy = uCore.y;
  float R = uCore.z;
  bool hot = uCore.w > 0.5;
  int v = P.y - int(floor(cy - R + 0.5));
  if (v < 0 || v >= int(2.0 * R)) discard;
  float ny = -(float(v) + 0.5 - R) / R;
  float rr = R * sqrt(max(0.0, 1.0 - ny * ny));
  if (float(P.x) < floor(cx - rr) || float(P.x) > ceil(cx + rr)) discard;
  float s = (float(P.x) + 0.5 - cx) / rr;
  if (s < -1.0 || s > 1.0) discard;
  float nx = (float(P.x) + 0.5 - cx) / R;
  float nz = sqrt(max(0.0, 1.0 - nx * nx - ny * ny));
  float TW = float(uSurfSize.x);
  float spin = uSpinDim.x * (hot ? 1.0 : -1.3);
  int u = int(mod(floor((asin(s) + spin) / 6.2831853 * TW), TW));
  vec4 t = texelFetch(uSurf, ivec2(u, v), 0);
  int mat = int(t.r * 255.0 + 0.5);
  float tn = t.g;
  float dim = uSpinDim.y;
  float lit = max(0.0, -nx * 0.5 + ny * 0.5 + nz * 0.7);
  vec3 c;
  if (hot) c = mat == 2 ? rampAt((0.62 + tn * 0.35) * dim, P) : rampAt((0.02 + tn * 0.5 + lit * 0.16) * dim, P);
  else c = mat == 2 ? rampAt((0.55 + tn * 0.45) * dim, P) : rampAt((0.12 + tn * 0.45 + lit * 0.25) * dim, P);
  if (pow(1.0 - nz, 2.0) > 0.55 && dim > 0.8) c = hot ? vec3(255.0, 170.0, 90.0) / 255.0 : vec3(230.0, 170.0, 255.0) / 255.0;
  oColor = vec4(c, 1.0);
  oEmis = vec4(c, 1.0);
  oId = vec4(uId.r, uId.g, 0.0, 1.0);
}
`;

function normalBlend(m: RawShaderMaterial): void {
  m.blending = CustomBlending;
  m.blendEquation = AddEquation;
  m.blendSrc = SrcAlphaFactor;
  m.blendDst = OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = OneFactor;
  m.blendDstAlpha = OneMinusSrcAlphaFactor;
}

class PointSet {
  readonly geo = new InstancedBufferGeometry();
  readonly mesh: Mesh;
  readonly data = new Float32Array(MAX_PX * 5);
  private readonly aP = new InstancedBufferAttribute(new Float32Array(MAX_PX * 4), 4).setUsage(
    DynamicDrawUsage,
  );
  private readonly aB = new InstancedBufferAttribute(new Float32Array(MAX_PX), 1).setUsage(DynamicDrawUsage);
  constructor(mat: RawShaderMaterial) {
    const q = unitQuad();
    this.geo.setAttribute('position', q.getAttribute('position'));
    this.geo.setIndex(q.getIndex());
    this.geo.setAttribute('aP', this.aP);
    this.geo.setAttribute('aB', this.aB);
    this.geo.instanceCount = 0;
    this.mesh = new Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }
  upload(n: number): void {
    const P = this.aP.array as Float32Array;
    const B = this.aB.array as Float32Array;
    for (let i = 0; i < n; i++) {
      P[i * 4] = this.data[i * 5]!;
      P[i * 4 + 1] = this.data[i * 5 + 1]!;
      P[i * 4 + 2] = this.data[i * 5 + 2]!;
      P[i * 4 + 3] = this.data[i * 5 + 3]!;
      B[i] = this.data[i * 5 + 4]!;
    }
    for (const a of [this.aP, this.aB]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
    this.geo.instanceCount = n;
  }
}

interface Core {
  mesh: Mesh;
  mat: RawShaderMaterial;
  tex: DataTexture | null;
  R: number;
}

export class UriLivePass {
  private readonly pointMat: RawShaderMaterial;
  private readonly back: PointSet;
  private readonly front: PointSet;
  private readonly plume: PointSet;
  private readonly cores: Core[];
  private readonly id = new Vector4();

  constructor(scene: Scene, res: Vector2) {
    this.pointMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: { uRes: { value: res }, uId: { value: this.id } },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      side: DoubleSide,
    });
    normalBlend(this.pointMat);
    this.back = new PointSet(this.pointMat);
    this.front = new PointSet(this.pointMat);
    this.plume = new PointSet(this.pointMat);
    this.cores = [true, false].map((hot) => {
      const ramp = new Float32Array(8 * 3);
      (hot ? URI_CORE_RAMPS.hot : URI_CORE_RAMPS.cold).forEach((h, i) => {
        const c = hex(h);
        ramp[i * 3] = pr(c) / 255;
        ramp[i * 3 + 1] = pg(c) / 255;
        ramp[i * 3 + 2] = pb(c) / 255;
      });
      const mat = new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: CORE_VERT,
        fragmentShader: CORE_FRAG,
        uniforms: {
          uRes: { value: res },
          uCore: { value: new Vector4(0, 0, 1, hot ? 1 : 0) },
          uSpinDim: { value: new Vector2(0, 1) },
          uSurf: { value: null },
          uSurfSize: { value: [1, 1] },
          uRamp: { value: ramp },
          uId: { value: this.id },
        },
        depthTest: false,
        depthWrite: false,
        transparent: true,
        side: DoubleSide,
      });
      normalBlend(mat);
      const mesh = new Mesh(unitQuad(), mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      return { mesh, mat, tex: null, R: -1 };
    });
    scene.add(this.back.mesh, this.cores[1]!.mesh, this.cores[0]!.mesh, this.front.mesh, this.plume.mesh);
  }

  hide(): void {
    this.back.mesh.visible = this.front.mesh.visible = this.plume.mesh.visible = false;
    for (const c of this.cores) c.mesh.visible = false;
  }

  /**
   * Stage this frame's live elements from `fx` (world coordinates, view origin vx / vy) at render orders order+1 … order+4, with
   * the id of a 우리 titan pixel at draw rank `rank`. Returns the next free render order.
   */
  stage(fx: UriLiveFx, vx: number, vy: number, order: number, rank: number): number {
    const n = uriLoopPixels(fx, vx, vy, this.back.data, this.front.data);
    this.back.upload(n.back);
    this.front.upload(n.front);
    this.id.set(0.75, Math.min(255, rank) / 255, 0, 0);
    this.back.mesh.visible = n.back > 0;
    this.back.mesh.renderOrder = ++order;
    // the cold core, then the hot one (the oracle's order)
    const spec: [number, number, number][] = [
      [fx.hotX - vx, fx.hotY - vy, fx.hotR],
      [fx.coldX - vx, fx.coldY - vy, fx.coldR],
    ];
    for (const k of [1, 0]) {
      const c = this.cores[k]!;
      const [x, y, R] = spec[k]!;
      if (c.R !== R) {
        c.tex?.dispose();
        const s = coreSurface(R, k === 0);
        const t = new DataTexture(s.data, s.w, s.h, RGBAFormat, UnsignedByteType);
        t.minFilter = NearestFilter;
        t.magFilter = NearestFilter;
        t.generateMipmaps = false;
        t.needsUpdate = true;
        c.tex = t;
        c.R = R;
        c.mat.uniforms.uSurf!.value = t;
        c.mat.uniforms.uSurfSize!.value = [s.w, s.h];
      }
      (c.mat.uniforms.uCore!.value as Vector4).set(x, y, R, k === 0 ? 1 : 0);
      (c.mat.uniforms.uSpinDim!.value as Vector2).set(
        fx.spin,
        fx.broken ? 0.35 + 0.25 * Math.sin(fx.t * 6) : 1,
      );
      c.mesh.visible = true;
      c.mesh.renderOrder = ++order;
    }
    this.front.mesh.visible = n.front > 0;
    this.front.mesh.renderOrder = ++order;
    return order;
  }

  /** The pylon plumes, on top of the whole body (after its last part). Returns the next free render order. */
  stagePlumes(fx: UriLiveFx, vx: number, vy: number, order: number, rank: number): number {
    const n = uriPlumePixels(fx, vx, vy, this.plume.data);
    this.plume.upload(n);
    this.id.set(0.75, Math.min(255, rank) / 255, 0, 0);
    this.plume.mesh.visible = n > 0;
    this.plume.mesh.renderOrder = ++order;
    return order;
  }

  dispose(): void {
    this.pointMat.dispose();
    this.plume.geo.dispose();
    this.back.geo.dispose();
    this.front.geo.dispose();
    for (const c of this.cores) {
      c.mat.dispose();
      c.tex?.dispose();
    }
  }
}
