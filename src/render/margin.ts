import {
  AddEquation,
  CustomBlending,
  OneMinusSrcAlphaFactor,
  SrcAlphaFactor,
  Vector4,
  type Texture,
  type TextureDataType,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { LOGICAL_H, LOGICAL_W } from '@/contracts';
import { FullscreenPass, makeRT } from './gl';
import type { ViewportLayout } from './viewport';

/**
 * The margin around the letterboxed 640×360 frame. Instead of dead black, the canvas outside the arena shows the frame's own
 * light carried outward: the finished frame is averaged down to a 32×18 grid (a slow running average, so flashes and cuts
 * do not strobe the margin), spread past the arena edge, dimmed with distance, and drawn in the game's own pixel grid with
 * ordered dither, with sparse pixel stars in the site's colours. A dark moat and a faint hairline mark the true arena edge,
 * so the margin never reads as playfield. Presentation only: the arena pixels and the game itself are untouched.
 */
const AMB_W = 32;
const AMB_H = 18;

const HEAD = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
`;

const AMBIENT_FRAG = /* glsl */ `${HEAD}
uniform sampler2D uSrc;
uniform float uK;
in vec2 vUv;
out vec4 o;
void main() {
  vec2 cell = vec2(1.0 / ${AMB_W}.0, 1.0 / ${AMB_H}.0);
  vec3 s = vec3(0.0);
  for (int j = 0; j < 4; j++)
    for (int i = 0; i < 4; i++) s += texture(uSrc, vUv + (vec2(float(i), float(j)) - 1.5) * 0.25 * cell).rgb;
  o = vec4(s / 16.0, uK);
}
`;

const MARGIN_FRAG = /* glsl */ `${HEAD}
uniform sampler2D uAmb;
uniform vec4 uRect;     // arena in canvas px, GL origin (bottom-left): x, y, w, h
uniform float uScale;   // canvas px per game pixel
uniform float uTime;
in vec2 vUv;
out vec4 o;
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
const vec3 VOID = vec3(0.027, 0.016, 0.059);   // the site's --void
const vec3 RULE = vec3(0.659, 0.741, 0.698);   // celadon #a8bdb2
void main() {
  vec2 size = vec2(${LOGICAL_W}.0, ${LOGICAL_H}.0);
  // the game-pixel cell under this canvas pixel, in logical px from the arena's bottom-left (the arena's own pixel grid)
  vec2 cell = floor((gl_FragCoord.xy - uRect.xy) / uScale);
  vec2 l = cell + 0.5;
  vec2 dv = max(max(-l, l - size), 0.0);
  float d = length(dv);                 // game pixels outside the arena (0 inside)
  if (d <= 0.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // the frame's light, clamped to the arena edge, widened the further out it reaches
  vec2 uv = clamp(l, vec2(0.0), size) / size;
  vec2 r = vec2(1.0 / ${AMB_W}.0, 1.0 / ${AMB_H}.0) * (1.2 + d / 60.0);
  vec3 a = texture(uAmb, uv).rgb * 0.2;
  a += (texture(uAmb, uv + vec2(r.x, 0.0)).rgb + texture(uAmb, uv - vec2(r.x, 0.0)).rgb
      + texture(uAmb, uv + vec2(0.0, r.y)).rgb + texture(uAmb, uv - vec2(0.0, r.y)).rgb) * 0.12;
  a += (texture(uAmb, uv + r).rgb + texture(uAmb, uv - r).rgb
      + texture(uAmb, uv + vec2(r.x, -r.y)).rgb + texture(uAmb, uv - vec2(r.x, -r.y)).rgb) * 0.08;
  float glow = 0.42 * exp(-d / 120.0);
  vec3 col = VOID + a * glow;
  // pixel stars (about one per 330 game pixels), twinkling slowly, kept out of the moat
  float h = hash(cell + 71.0);
  if (h > 0.997) {
    float k = fract(h * 977.0);
    vec3 sc = k < 0.4 ? vec3(1.0) : k < 0.6 ? vec3(1.0, 0.9, 0.76) : k < 0.75 ? vec3(0.79, 0.85, 1.0)
      : k < 0.9 ? vec3(1.0, 0.82, 0.48) : vec3(0.73, 0.66, 1.0);
    float tw = 0.3 + 0.2 * sin(uTime * (0.6 + k * 1.7) + h * 400.0);
    col += sc * tw * smoothstep(6.0, 24.0, d);
  }
  // the arena edge: one black game pixel, a faint celadon hairline, then a dark moat that opens into the glow
  float moat = mix(0.35, 1.0, smoothstep(2.0, 16.0, d));
  col *= moat;
  if (d < 1.0) col = vec3(0.0);
  else if (d < 2.0) col = mix(col, RULE, 0.16);
  // ordered dither into the game's look (4×4 Bayer, 48 levels)
  ivec2 b = ivec2(mod(cell, 4.0));
  int xy = b.x ^ b.y;
  int v = ((xy & 1) << 3) | ((b.y & 1) << 2) | (((xy >> 1) & 1) << 1) | ((b.y >> 1) & 1);
  float bayer = (float(v) + 0.5) / 16.0;
  col = floor(clamp(col, 0.0, 1.0) * 48.0 + bayer) / 48.0;
  o = vec4(col, 1.0);
}
`;

export class MarginFill {
  private readonly amb: WebGLRenderTarget;
  private readonly down: FullscreenPass;
  private readonly fill: FullscreenPass;
  private fresh = true;
  /** Per-frame weight of the running average (8-bit targets need a bigger step or the average stalls). */
  private readonly k: number;

  constructor(type: TextureDataType, halfFloat: boolean) {
    this.amb = makeRT(AMB_W, AMB_H, { type, filter: 'linear' });
    this.k = halfFloat ? 0.06 : 0.14;
    this.down = new FullscreenPass(AMBIENT_FRAG, { uSrc: { value: null }, uK: { value: 1 } });
    const m = this.down.material;
    m.blending = CustomBlending;
    m.blendEquation = AddEquation;
    m.blendSrc = SrcAlphaFactor;
    m.blendDst = OneMinusSrcAlphaFactor;
    m.transparent = true;
    this.fill = new FullscreenPass(MARGIN_FRAG, {
      uAmb: { value: this.amb.texture },
      uRect: { value: new Vector4() },
      uScale: { value: 1 },
      uTime: { value: 0 },
    });
  }

  /** True when the frame does not cover the whole canvas (there is a margin to fill). */
  static needed(L: ViewportLayout): boolean {
    return L.x > 0 || L.y > 0 || L.w < L.physW || L.h < L.physH;
  }

  /** Forget the running average (a new stage, a resize): the next update takes the frame as it is. */
  reset(): void {
    this.fresh = true;
  }

  /** Fold this frame (the post target, before UI) into the running average. Leaves the render target changed. */
  update(r: WebGLRenderer, src: Texture): void {
    const u = this.down.uniforms;
    u.uSrc!.value = src;
    u.uK!.value = this.fresh ? 1 : this.k;
    this.fresh = false;
    this.down.render(r, this.amb);
  }

  /** Paint the whole canvas viewport (call with the canvas bound and its full viewport set); the arena itself is left black. */
  draw(r: WebGLRenderer, L: ViewportLayout, timeSec: number): void {
    const u = this.fill.uniforms;
    // GL's origin is bottom-left: the arena's bottom edge sits L.y + L.h below the canvas top
    (u.uRect!.value as Vector4).set(L.x, L.physH - (L.y + L.h), L.w, L.h);
    u.uScale!.value = L.scale;
    u.uTime!.value = timeSec;
    this.fill.render(r, null);
  }

  compile(r: WebGLRenderer): Promise<void> {
    return Promise.all([this.down.compile(r), this.fill.compile(r)]).then(() => undefined);
  }

  dispose(): void {
    this.down.dispose();
    this.fill.dispose();
    this.amb.dispose();
  }
}
