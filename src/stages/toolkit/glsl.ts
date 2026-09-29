/**
 * GLSL chunks shared by every scenery shader. Concatenate with the shader body; each chunk declares what it needs.
 * Scenery shaders use three's RawShaderMaterial (GLSL ES 3.00).
 */

export const SCENERY_HEAD = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
`;

/** Texture-based value noise: one fetch per octave, quintic-smoothed by the classic uv trick. */
export const NOISE_GLSL = /* glsl */ `
uniform sampler2D uNoise;   // 256x256 RGBA8 random, repeat, linear

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return texture(uNoise, (i + f + 0.5) / 256.0).r;
}
float vnoiseG(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return texture(uNoise, (i + f + 0.5) / 256.0).g;
}
const mat2 ROT = mat2(0.8, 0.6, -0.6, 0.8);
float fbm(vec2 p, int oct) {
  float s = 0.0;
  float a = 0.5;
  float n = 0.0;
  for (int i = 0; i < oct; i++) {   // uniform-bounded (not constant) so drivers do not unroll it 8x per call site
    s += a * vnoise(p);
    n += a;
    p = ROT * p * 2.03 + vec2(17.3, -9.1);
    a *= 0.5;
  }
  return s / n;
}
// Divergence-free flow for particle drift.
vec2 curl2(vec2 p) {
  float e = 0.35;
  float dx = vnoise(p + vec2(e, 0.0)) - vnoise(p - vec2(e, 0.0));
  float dy = vnoise(p + vec2(0.0, e)) - vnoise(p - vec2(0.0, e));
  return vec2(dy, -dx) / (2.0 * e);
}
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/** Fight reaction: shockwave rings push, impulses swirl. `k` scales the effect by depth (near layers react more). */
export const FORCES_GLSL = /* glsl */ `
uniform vec2 uView;         // integer view origin (world px)
uniform vec2 uRes;          // logical frame size
uniform float uTime;        // scenery clock (s)
uniform float uFlow;        // flow clock: runs faster in a hot fight
uniform float uIntensity;   // 0..1 how hot the fight is
uniform vec4 uShock[8];     // x, y (screen px), radius px, displacement px
uniform int uNShock;
uniform vec4 uImp[6];       // x, y (screen px), radius px, swirl strength
uniform vec4 uImp2[6];      // age 0..1, hue, -, -
uniform int uNImp;

vec2 warpByForces(vec2 c, float k) {
  for (int i = 0; i < uNShock; i++) {
    vec4 s = uShock[i];
    vec2 d = c - s.xy;
    float r = length(d) + 1e-3;
    float t = 6.0 + 0.12 * s.z;
    float ring = exp(-pow((r - s.z) / t, 2.0));
    c += d / r * ring * s.w * k;
  }
  for (int i = 0; i < uNImp; i++) {
    vec4 m = uImp[i];
    vec2 d = c - m.xy;
    float w = exp(-dot(d, d) / (m.z * m.z)) * m.w;
    float a = w * 2.2 * k;
    float cs = cos(a);
    float sn = sin(a);
    c = m.xy + vec2(cs * d.x - sn * d.y, sn * d.x + cs * d.y);
  }
  return c;
}

// Tint contributed by impulses that carry a hue (fire = orange), for glowing dust. Impulses with hue -1 add nothing.
vec3 impulseGlow(vec2 c) {
  vec3 g = vec3(0.0);
  for (int i = 0; i < uNImp; i++) {
    vec4 m = uImp[i];
    float hue = uImp2[i].y;
    if (hue < 0.0) continue;                      // contract: hue -1 = no tint (the impulse still swirls)
    vec2 d = c - m.xy;
    float w = exp(-dot(d, d) / (m.z * m.z * 1.6)) * abs(m.w) * (1.0 - uImp2[i].x);
    vec3 col = clamp(abs(fract(hue + vec3(0.0, 0.6667, 0.3333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
    g += col * w;
  }
  // soft-compress: a huge blast (supernova, black-hole ultimate) adds many overlapping impulses; without this the whole sky washes to one flat colour
  return g / (1.0 + 0.7 * dot(g, vec3(0.3333)));
}
`;
