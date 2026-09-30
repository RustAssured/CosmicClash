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

/** Dynamic light sources (the fighters' own lights). Positions are screen-space logical px (top-left origin). */
const LIGHTS_GLSL = /* glsl */ `
uniform vec4 uLt[4];       // x, y, falloff radius, intensity
uniform vec3 uLtCol[4];
uniform int uNLt;
uniform int uRelight;      // 1 = relight the sprites (tier >= 1)
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
export const SCENERY_DITHER_FRAG = /* glsl */ `${HEAD}${COMMON}${LIGHTS_GLSL}
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
// Fighter readability: everything drawn by the 2D layers casts a soft dark, slightly desaturated halo and a thin dark
// contact rim INTO the scenery beneath it (multiplied in before the palette dither, so it dithers like the rest), and a
// luminance ceiling in the vertical band where the fighters live keeps highlights from sitting right behind a body.
uniform sampler2D uHalo;       // blurred layer coverage (half res, linear)
uniform sampler2D uCover;      // layer colour target: alpha = coverage of the 2D layers (nearest)
uniform int uHasLayers;
uniform vec4 uHaloParams;      // strength, desaturation, rim darkness, rim reach (px)
uniform vec2 uHaloLift;        // x = linear luminance floor lifted behind DARK bodies (a faint backlight rim)
uniform vec4 uBand;            // screen-space top, bottom, feather (px), ceiling (linear, after exposure)
uniform float uBandRatio;      // how much of the excess above the ceiling survives (0 = hard clamp)

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

// Coverage of the 2D layers in the ring of pixels just around this one (dilation by reach px, 1 or 2).
float ringCoverage(ivec2 q, int reach) {
  float c = 0.0;
  for (int k = 1; k <= 2; k++) {
    if (k > reach) break;
    for (int j = 0; j < 8; j++) {
      float a = float(j) * 0.785398;
      ivec2 o = ivec2(int(floor(cos(a) * float(k) + 0.5)), int(floor(sin(a) * float(k) + 0.5)));
      ivec2 t = clamp(q + o, ivec2(0), ivec2(uRes) - 1);
      c = max(c, texelFetch(uCover, ivec2(t.x, int(uRes.y) - 1 - t.y), 0).a);
    }
  }
  return c;
}

void main() {
  vec2 p = fragPx();
  vec4 hdr = sampleScene(lensPx(p));
  vec3 x = max(hdr.rgb, 0.0) * uExposure;

  if (uHasLayers == 1) {
    float own = texelFetch(uCover, ivec2(int(p.x), int(uRes.y) - 1 - int(p.y)), 0).a;
    vec2 hb = texture(uHalo, pxToUv(p)).rg;
    float h = smoothstep(0.0, 0.75, hb.x);
    // How bright is the body casting this halo? (blurred colour luminance / blurred coverage)
    float Ls = hb.y / max(hb.x, 0.02);
    // Oppose the sprite's value: a pale body gets a darkened, desaturated surround; a dark body gets a faintly LIFTED surround
    // (reads as a rim of backlight) so it never sinks into a dark nebula; mid-tones get a little of the former.
    float wDark = 0.3 + 0.7 * smoothstep(0.3, 0.7, Ls);
    float wLift = 1.0 - smoothstep(0.12, 0.4, Ls);
    float rim = ringCoverage(ivec2(int(p.x), int(p.y)), int(uHaloParams.w + 0.5)) * (1.0 - own);
    float lum0 = luma(x);
    x = mix(x, vec3(lum0), uHaloParams.y * h * wDark);
    x *= (1.0 - uHaloParams.x * h * wDark);
    vec3 tint = (x + 0.03) / max(luma(x) + 0.03, 0.03);
    x = max(x, tint * uHaloLift.x * h * wLift);
    x *= 1.0 - uHaloParams.z * rim * (1.0 - 0.6 * wLift);
  }
  // The fight band: highlights above the ceiling are compressed where the fighters live (feathered top and bottom).
  {
    float band = smoothstep(uBand.x - uBand.z, uBand.x, p.y) * (1.0 - smoothstep(uBand.y, uBand.y + uBand.z, p.y));
    float L = luma(x);
    float Lc = L > uBand.w ? uBand.w + (L - uBand.w) * uBandRatio : L;
    x *= mix(1.0, Lc / max(L, 1e-4), band);
  }
  // Light from the bodies themselves: nebula and dust near a light take on its colour, more where the scenery has substance (so
  // it reads as LIT gas, not an overlay), and a faint base so even empty space is touched. Applied after the fight-band
  // compression so a fighter's own glow is not squashed by it.
  for (int i = 0; i < 4; i++) {
    if (i >= uNLt) break;
    vec4 L = uLt[i];
    float d = length(p - L.xy) / max(L.z, 1.0);
    float f = 1.0 / (1.0 + d * d * 3.0) * (1.0 - smoothstep(0.9, 1.7, d));
    float lm = clamp(luma(x) * 2.0, 0.0, 1.0);
    x += uLtCol[i] * min(L.w, 1.1) * f * (0.11 + 0.4 * lm);
  }
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

  float l = luma(x);
  vec3 bloom = x * smoothstep(uBloomThreshold, uBloomThreshold + 1.6, l) * uBloomGain;
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
 *  Layer coverage → soft halo: separable 9-tap gaussian at half resolution on the alpha of the 2D layer target.
 * ------------------------------------------------------------------------------------------------ */
export const HALO_BLUR_FRAG = /* glsl */ `${HEAD}
uniform sampler2D uSrc;
uniform vec2 uStep;   // uv step between taps
uniform int uFromLayers; // 1: read the layer target (coverage, luminance), 0: read the previous blur pass
in vec2 vUv;
out vec4 o;
// x = coverage, y = coverage-weighted luminance of the sprite colour (premultiplied colour carries the weight already)
vec2 fetch(vec2 uv) {
  vec4 t = texture(uSrc, uv);
  return uFromLayers == 1 ? vec2(t.a, dot(t.rgb, vec3(0.2126, 0.7152, 0.0722))) : t.rg;
}
void main() {
  float w[5] = float[5](0.2270, 0.1946, 0.1216, 0.0541, 0.0162);
  vec2 s = fetch(vUv) * w[0];
  for (int i = 1; i < 5; i++) {
    s += (fetch(vUv + uStep * float(i)) + fetch(vUv - uStep * float(i))) * w[i];
  }
  o = vec4(s, 0.0, 1.0);
}
`;

/** Lays the 2D layer target over the dithered scenery. Premultiplied "over" (the layer target already holds premultiplied colour). */
export const LAYER_COMPOSITE_FRAG = /* glsl */ `${HEAD}${COMMON}
uniform sampler2D uColor;
uniform sampler2D uEmis;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oEmis;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  oColor = texelFetch(uColor, q, 0);
  oEmis = texelFetch(uEmis, q, 0);
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
  // Per-sample constants are expressed for a reference of 44 taps so every quality tier integrates the same beam
  // (fewer taps = coarser steps, not a brighter or more opaque scene).
  float k = 44.0 / float(uSamples);
  float decay = pow(uDecay, k);
  float occ = 1.0 - pow(1.0 - uOcc, k);
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
    acc += (halo * open + gas) * T * w * k;
    tint += s.rgb * gas * T * w * k;
    T *= 1.0 - s.a * occ;
    w *= decay;
  }
  float n = 44.0;
  o = vec4(acc / n, tint.r / n, tint.g / n, tint.b / n);
}
`;

/* ------------------------------------------------------------------------------------------------ *
 *  Post: shockwave refraction → chromatic aberration → + bloom + god rays → vignette → grain → flash.
 *  Everything keeps to the pixel grid: samples snap to whole source pixels and bloom/vignette are dithered.
 * ------------------------------------------------------------------------------------------------ */
export const POST_FRAG = /* glsl */ `${HEAD}${COMMON}${LIGHTS_GLSL}
uniform sampler2D uFrame;
uniform sampler2D uBloom;
uniform sampler2D uGod;
uniform sampler2D uBayer;
uniform sampler2D uCover;    // layer colour target (alpha = coverage of the 2D layers)
uniform int uHasLayers;
uniform vec2 uGlowDamp;      // how much bloom / god rays are damped ON the pixels of a sprite (0..1)
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

// Relight a sprite pixel by the OTHER bodies' lights. The pixel belongs to the nearest light (bodies carry their lights at their
// centre, so this is a Voronoi split that also catches debris); its normal is a sphere seen from the front, tilted by the offset from
// that body's centre; the side facing a light gets stepped (Bayer-dithered) warm light, the far side steps into shadow, and two
// bodies close together shade each other. Emissive / already-bright pixels are left alone. Everything is quantised: no muddy gradients.
vec3 relight(vec3 col, vec2 p, float th) {
  int j = 0;
  float dj = 1e9;
  for (int i = 0; i < 4; i++) {
    if (i >= uNLt) break;
    float d = length(p - uLt[i].xy);
    if (d < dj) { dj = d; j = i; }
  }
  vec2 cj = uLt[j].xy;
  float Rb = clamp(uLt[j].z * 0.45, 42.0, 100.0);
  vec2 o2 = (p - cj) / Rb;
  float rl = length(o2);
  vec2 od = o2 / max(rl, 1e-3);
  float r = min(rl, 1.0);
  vec3 n = normalize(vec3(od * r, sqrt(max(1.0 - r * r, 0.05))));
  vec3 add = vec3(0.0);
  float shade = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= uNLt) break;
    if (i == j) continue;
    vec4 L = uLt[i];
    vec2 toL = L.xy - p;
    float dist = length(toL);
    vec2 dir = toL / max(dist, 1e-3);
    float fall = 1.0 / (1.0 + pow(dist / (L.z * 0.9), 2.0));
    fall *= 1.0 - smoothstep(1.0, 2.0, dist / L.z);
    float I = min(L.w, 1.3);
    float lam = max(dot(n, normalize(vec3(dir, 0.5))), 0.0);
    float lit = floor(I * fall * lam * 4.0 + th) / 4.0;
    float dark = floor(I * fall * (1.0 - lam) * 3.0 + th) / 3.0;
    add += uLtCol[i] * lit;
    shade += 0.4 * dark;
    // mutual occlusion: near another body, the side facing it loses ambient light
    float Rbi = clamp(L.z * 0.45, 42.0, 100.0);
    float occ = smoothstep(Rbi * 2.0, Rbi * 0.8, dist) * max(dot(od, dir), 0.0) * r;
    shade += 0.2 * floor(occ * 3.0 + th) / 3.0;
  }
  float keep = 1.0 - smoothstep(0.62, 0.95, luma(col));   // glowing / near-white pixels keep their own light
  col *= 1.0 - clamp(shade, 0.0, 0.5) * keep;
  return col + add * 1.2 * keep;
}

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
  // Glow never washes out a sprite's own pixels (silhouettes stay crisp); it still blooms around them.
  float cov = uHasLayers == 1 ? texelFetch(uCover, pxToTexel(clamp(ivec2(floor(sp)), ivec2(0), ivec2(uRes) - 1)), 0).a : 0.0;
  if (uRelight == 1 && uNLt >= 2 && cov > 0.5) col = relight(col, floor(sp) + 0.5, th);
  col = col + bloom * (1.0 - uGlowDamp.x * cov) + rays * (1.0 - uGlowDamp.y * cov);

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
