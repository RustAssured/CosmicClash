/**
 * GLSL ES 3.00 sources for every renderer pass. All shaders are used through three's RawShaderMaterial with
 * glslVersion GLSL3, so each one declares its own precision, ins and outs.
 *
 * Coordinate conventions (identical in every pass):
 *  - "logical pixel" coordinates `p` have their origin at the TOP-LEFT of the 640×360 frame, +y down, pixel centres at +0.5;
 *  - render targets are GL-native (row 0 = bottom), so `pxToUv` flips y once, here, and nowhere else.
 */

const HEAD = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
`;

/** Shared helpers: logical px ↔ uv, pixel-exact fetch, hashes. */
const COMMON = /* glsl */ `
uniform vec2 uRes; // logical frame size (640, 360)

vec2 pxToUv(vec2 p) { return vec2(p.x / uRes.x, 1.0 - p.y / uRes.y); }
// Pixel centre in logical px for the fragment being shaded (works for logical-res targets).
vec2 fragPx() { return vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y); }
ivec2 pxToTexel(ivec2 q) { return ivec2(q.x, int(uRes.y) - 1 - q.y); }
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

export const FULLSCREEN_VERT = /* glsl */ `${HEAD}
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/* ------------------------------------------------------------------------------------------------ *
 *  Scenery resolve: lens → supersample box filter → tone map → palette dither.   (MRT: colour, bloom)
 * ------------------------------------------------------------------------------------------------ */
export const SCENERY_DITHER_FRAG = /* glsl */ `${HEAD}${COMMON}
uniform sampler2D uScene;      // HDR scenery, linear light, alpha = occluder opacity
uniform int uTaps;             // 1 (scene at logical res) or 4 (2x supersampled)
uniform sampler3D uLut;        // (idxA, idxB, ratio) per sRGB node, NEAREST
uniform float uLutSize;
uniform sampler2D uPalSrgb;    // 64x1 RGBA8
uniform sampler2D uPalLin;     // 64x1 RGBA32F
uniform sampler2D uBayer;      // 4x4 R8 thresholds
uniform float uLevels;         // dither ratio steps (patterns): 4 = 25% / 50% / 75% classics
uniform float uExposure;
uniform float uContrast;
uniform float uDither;         // 1 = ordered dither, 0 = nearest colour
uniform vec4 uLens[4];         // x, y (logical px), horizon radius px, strength
uniform int uNumLens;
uniform float uBloomThreshold;
uniform float uBloomGain;
uniform float uFlash;

in vec2 vUv;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oEmis;

vec2 lensPx(vec2 p) {
  for (int i = 0; i < 4; i++) {
    if (i >= uNumLens) break;
    vec2 d = p - uLens[i].xy;
    float r2 = dot(d, d) + 1.0;
    float te = uLens[i].z * (0.9 + 0.9 * uLens[i].w);
    p = uLens[i].xy + d * (1.0 - te * te / r2);
  }
  return p;
}

vec4 sampleScene(vec2 p) {
  vec2 uv = pxToUv(p);
  if (uTaps == 1) return texture(uScene, uv);
  // 2x supersampled: four bilinear taps = a 4x4 tent over the logical pixel.
  vec2 o = vec2(0.5) / uRes;
  return 0.25 * (texture(uScene, uv + vec2(-o.x, -o.y)) + texture(uScene, uv + vec2(o.x, -o.y)) +
                 texture(uScene, uv + vec2(-o.x, o.y)) + texture(uScene, uv + vec2(o.x, o.y)));
}

void main() {
  vec2 p = fragPx();
  vec4 hdr = sampleScene(lensPx(p));
  vec3 x = max(hdr.rgb, 0.0) * uExposure;
  // Hue-preserving tone map: identity below the knee (so colours authored on a palette ramp stay on it), a soft
  // shoulder above it, and very bright light bleeds toward white the way an overexposed sensor does.
  float m = max(x.r, max(x.g, x.b));
  const float knee = 0.72;
  float tm = m <= knee ? m : knee + (1.0 - knee) * (1.0 - exp(-(m - knee) / (1.0 - knee)));
  vec3 t = m > 1e-5 ? x * (tm / m) : vec3(0.0);
  t = mix(t, vec3(tm), smoothstep(1.4, 4.0, m) * 0.75);
  t = clamp((t - 0.5) * uContrast + 0.5, 0.0, 1.0);
  t = mix(t, vec3(1.0), uFlash);

  vec3 s = pow(t, vec3(1.0 / 2.2));
  vec4 e = texture(uLut, (s * (uLutSize - 1.0) + 0.5) / uLutSize);
  int ia = int(e.r * 255.0 + 0.5);
  int ib = int(e.g * 255.0 + 0.5);
  vec3 A = texelFetch(uPalLin, ivec2(ia, 0), 0).rgb;
  vec3 B = texelFetch(uPalLin, ivec2(ib, 0), 0).rgb;
  vec3 d = B - A;
  float len2 = dot(d, d);
  float r = len2 > 1e-9 ? clamp(dot(t - A, d) / len2, 0.0, 1.0) : 0.0;
  float th = texelFetch(uBayer, ivec2(gl_FragCoord.xy) & 3, 0).r;
  r = floor(r * uLevels + 0.5) / uLevels;
  bool useB = uDither > 0.5 ? (th < r) : (r > 0.5);
  vec3 col = texelFetch(uPalSrgb, ivec2(useB ? ib : ia, 0), 0).rgb;

  float l = luma(max(hdr.rgb, 0.0) * uExposure);
  vec3 bloom = hdr.rgb * uExposure * smoothstep(uBloomThreshold, uBloomThreshold + 1.6, l) * uBloomGain;
  oColor = vec4(col, clamp(hdr.a, 0.0, 1.0));
  oEmis = vec4(clamp(bloom, 0.0, 1.0), 1.0);
}
`;

/* ------------------------------------------------------------------------------------------------ *
 *  2D layers (MRT: colour + emissive). One quad per layer; the fragment shader fetches by exact integer cell.
 *  The mapping below is the GLSL twin of layerMap.ts::sourceCell — keep them identical.
 * ------------------------------------------------------------------------------------------------ */
export const LAYER_VERT = /* glsl */ `${HEAD}
in vec3 position;
uniform vec4 uRect;   // x0, y0, x1, y1 in logical px (top-left origin)
uniform vec2 uRes;
void main() {
  vec2 p = mix(uRect.xy, uRect.zw, position.xy);
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
}
`;

export const LAYER_FRAG = /* glsl */ `${HEAD}${COMMON}
uniform sampler2D uTex;      // RGBA8, row 0 = top of the sprite
uniform sampler2D uEmis;     // R8
uniform int uHasEmis;
uniform vec2 uSize;          // sprite w, h in cells
uniform vec4 uPlace;         // ax, ay, anchorX, anchorY
uniform vec2 uFL;            // facing (+1/-1), lean
uniform int uScreen;         // 1 = screen-space layer drawn 1:1
uniform float uAlpha;
uniform float uEmisGain;

layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oEmis;

void main() {
  ivec2 P = ivec2(floor(gl_FragCoord.x), int(floor(uRes.y - gl_FragCoord.y)));
  ivec2 cell;
  if (uScreen == 1) {
    cell = P;
  } else {
    float ly = float(P.y) - uPlace.y + uPlace.w;
    float shift = floor(uFL.y * (uPlace.w - ly) / max(1.0, uPlace.w) + 0.5);
    float d = float(P.x) - uPlace.x - shift;
    float lx = uFL.x > 0.0 ? d + uPlace.z : uPlace.z - 1.0 - d;
    cell = ivec2(int(lx), int(ly));
    if (lx < 0.0 || ly < 0.0) discard;
  }
  if (cell.x >= int(uSize.x) || cell.y >= int(uSize.y)) discard;
  vec4 c = texelFetch(uTex, cell, 0);
  if (c.a <= 0.0) discard;
  float e = uHasEmis == 1 ? texelFetch(uEmis, cell, 0).r : 0.0;
  float a = c.a * uAlpha;
  oColor = vec4(c.rgb, a);
  oEmis = vec4(c.rgb * e * uEmisGain, a);
}
`;

/* ------------------------------------------------------------------------------------------------ *
 *  Bloom: dual-filter pyramid (down), tent (up, accumulated additively into the level above).
 * ------------------------------------------------------------------------------------------------ */
export const BLOOM_DOWN_FRAG = /* glsl */ `${HEAD}
uniform sampler2D uSrc;
uniform vec2 uTexel;   // 1 / size of uSrc
in vec2 vUv;
out vec4 o;
void main() {
  vec2 h = uTexel;
  vec4 s = texture(uSrc, vUv) * 4.0;
  s += texture(uSrc, vUv + vec2(-h.x, -h.y));
  s += texture(uSrc, vUv + vec2(h.x, -h.y));
  s += texture(uSrc, vUv + vec2(-h.x, h.y));
  s += texture(uSrc, vUv + vec2(h.x, h.y));
  o = vec4(s.rgb / 8.0, 1.0);
}
`;

export const BLOOM_UP_FRAG = /* glsl */ `${HEAD}
uniform sampler2D uSrc;
uniform vec2 uTexel;   // 1 / size of uSrc (the smaller level)
uniform float uWeight;
in vec2 vUv;
out vec4 o;
void main() {
  vec2 h = uTexel * 0.5;
  vec3 s = texture(uSrc, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
  s += texture(uSrc, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(0.0, h.y * 2.0)).rgb;
  s += texture(uSrc, vUv + vec2(h.x, h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(h.x * 2.0, 0.0)).rgb;
  s += texture(uSrc, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(0.0, -h.y * 2.0)).rgb;
  s += texture(uSrc, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  o = vec4(s / 12.0 * uWeight, 1.0);
}
`;

/* ------------------------------------------------------------------------------------------------ *
 *  God rays: radial march toward the stage light through the frame, occluded by layer + dust alpha. Half-res.
 * ------------------------------------------------------------------------------------------------ */
export const GODRAYS_FRAG = /* glsl */ `${HEAD}${COMMON}
uniform sampler2D uFrame;   // colour + occlusion alpha (logical res)
uniform vec2 uLight;        // logical px, may lie outside the frame
uniform int uSamples;
uniform float uDensity;     // fraction of the pixel→light distance marched
uniform float uDecay;
uniform float uHaloR;       // px, analytic halo radius around the light
uniform float uGasK;        // how much bright open gas contributes as a light source
uniform float uOcc;         // opacity removed from the beam per fully occluded step (0..1)
in vec2 vUv;
out vec4 o;
void main() {
  vec2 p = vec2(vUv.x * uRes.x, (1.0 - vUv.y) * uRes.y);
  vec2 delta = (uLight - p) * uDensity / float(uSamples);
  vec2 q = p;
  float w = 1.0;
  float T = 1.0;             // transmittance of the beam between the light and the sample: occluders cast SHAFTS
  float acc = 0.0;
  vec3 tint = vec3(0.0);
  for (int i = 0; i < 64; i++) {
    if (i >= uSamples) break;
    q += delta;
    vec2 uv = pxToUv(q);
    bool inside = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
    vec4 s = inside ? texture(uFrame, uv) : vec4(0.0);
    float open = 1.0 - s.a;
    float lightD = length(q - uLight);
    float halo = exp(-lightD / uHaloR);
    float gas = smoothstep(0.32, 0.85, luma(s.rgb)) * uGasK * open;
    acc += (halo * open + gas) * T * w;
    tint += s.rgb * gas * T * w;
    T *= 1.0 - s.a * uOcc;
    w *= uDecay;
  }
  float n = float(uSamples);
  o = vec4(acc / n, tint.r / n, tint.g / n, tint.b / n);
}
`;

/* ------------------------------------------------------------------------------------------------ *
 *  Post: shockwave refraction → chromatic aberration → + bloom + god rays → vignette → grain → flash.
 *  Everything keeps to the pixel grid: samples snap to whole source pixels and bloom/vignette are dithered.
 * ------------------------------------------------------------------------------------------------ */
export const POST_FRAG = /* glsl */ `${HEAD}${COMMON}
uniform sampler2D uFrame;
uniform sampler2D uBloom;
uniform sampler2D uGod;
uniform sampler2D uBayer;
uniform vec4 uShock[8];      // x, y (logical px), radius px, displacement px
uniform int uNumShock;
uniform float uAberration;   // 0..1 extra
uniform float uFlash;
uniform float uBloomGain;
uniform float uBloomLevels;
uniform vec3 uGodColor;
uniform float uGodGain;
uniform float uVignette;
uniform float uGrain;
uniform float uFrameNo;
uniform float uGodTint;      // 0 = pure light-colour rays, 1 = rays tinted by the gas they cross

in vec2 vUv;
out vec4 o;

vec3 fetchFrame(vec2 sp) {
  ivec2 q = ivec2(floor(sp));
  q = clamp(q, ivec2(0), ivec2(uRes) - 1);
  return texelFetch(uFrame, pxToTexel(q), 0).rgb;
}

float ditherQ(float v, float levels, float th) { return floor(clamp(v, 0.0, 1.0) * levels + th) / levels; }

void main() {
  vec2 p = fragPx();
  vec2 sp = p;
  for (int i = 0; i < 8; i++) {
    if (i >= uNumShock) break;
    vec4 s = uShock[i];
    vec2 d = p - s.xy;
    float r = length(d) + 1e-3;
    float t = 5.0 + 0.11 * s.z;
    float ring = exp(-pow((r - s.z) / t, 2.0));
    sp -= d / r * ring * s.w;
  }
  vec2 fromC = (p - uRes * 0.5) / (uRes.y * 0.5);
  float edge = dot(fromC, fromC);
  float ca = (0.35 + 3.0 * uAberration) * edge;
  vec2 dir = fromC / (length(fromC) + 1e-4);
  vec3 col;
  col.r = fetchFrame(sp + dir * ca).r;
  col.g = fetchFrame(sp).g;
  col.b = fetchFrame(sp - dir * ca).b;

  float th = texelFetch(uBayer, ivec2(gl_FragCoord.xy) & 3, 0).r;
  vec2 uv = pxToUv(sp);
  vec3 bloom = texture(uBloom, uv).rgb * uBloomGain;
  bloom = vec3(ditherQ(bloom.r, uBloomLevels, th), ditherQ(bloom.g, uBloomLevels, th), ditherQ(bloom.b, uBloomLevels, th));
  vec4 g = texture(uGod, uv);
  vec3 rays = (uGodColor * g.r + g.gba * uGodTint) * uGodGain;
  rays = vec3(ditherQ(rays.r, uBloomLevels, th), ditherQ(rays.g, uBloomLevels, th), ditherQ(rays.b, uBloomLevels, th));
  col = col + bloom + rays;

  float vig = 1.0 - uVignette * pow(smoothstep(0.55, 1.45, length(fromC * vec2(0.85, 1.0))), 1.6);
  col *= ditherQ(vig, 12.0, th);

  float n = hash13(vec3(floor(gl_FragCoord.xy), uFrameNo)) - 0.5;
  col += n * uGrain * (0.35 + luma(col));
  col = mix(col, vec3(1.0), uFlash);
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/* ------------------------------------------------------------------------------------------------ *
 *  Final: nearest-neighbour integer upscale to the canvas with micro-zoom + roll; UI composited last, un-zoomed.
 * ------------------------------------------------------------------------------------------------ */
export const FINAL_FRAG = /* glsl */ `${HEAD}${COMMON}
uniform sampler2D uPost;
uniform sampler2D uUi;
uniform int uHasUi;
uniform float uZoom;
uniform float uRoll;
in vec2 vUv;
out vec4 o;
void main() {
  vec2 p = vec2(vUv.x * uRes.x, (1.0 - vUv.y) * uRes.y);   // fractional logical px under this canvas pixel
  vec2 q = p - uRes * 0.5;
  float cs = cos(uRoll);
  float sn = sin(uRoll);
  q = vec2(cs * q.x + sn * q.y, -sn * q.x + cs * q.y) / uZoom;
  vec2 sp = q + uRes * 0.5;
  ivec2 c = clamp(ivec2(floor(sp)), ivec2(0), ivec2(uRes) - 1);
  vec3 col = texelFetch(uPost, pxToTexel(c), 0).rgb;
  if (uHasUi == 1) {
    ivec2 u = clamp(ivec2(floor(p)), ivec2(0), ivec2(uRes) - 1);
    vec4 ui = texelFetch(uUi, u, 0);
    col = mix(col, ui.rgb, ui.a);
  }
  o = vec4(col, 1.0);
}
`;
