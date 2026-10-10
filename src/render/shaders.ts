/**
 * GLSL ES 3.00 sources for every renderer pass. All shaders are used through three's RawShaderMaterial with
 * glslVersion GLSL3, so each one declares its own precision, ins and outs.
 *
 * Coordinate conventions (identical in every pass):
 *  - "logical pixel" coordinates `p` have their origin at the TOP-LEFT of the 640×360 frame, +y down, pixel centres at +0.5;
 *  - render targets are GL-native (row 0 = bottom), so `pxToUv` flips y once, here, and nowhere else.
 */

import { ROTSPRITE_GLSL } from './rotsprite';

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

/**
 * Dynamic light sources: the fighters' own lights ('body') and short local impact bursts ('impact', D5: they replace every
 * full-screen flash). Positions are screen-space logical px (top-left origin). Body lights are packed first.
 */
const LIGHTS_GLSL = /* glsl */ `
uniform vec4 uLt[4];       // x, y, falloff radius, intensity
uniform vec3 uLtCol[4];
uniform float uLtImp[4];   // 1 = impact light (never owns a sprite, never shades), 0 = body light
uniform int uNLt;
uniform int uRelight;      // 1 = relight the sprites (tier >= 1)
uniform float uLtFloor;    // body light on empty space (0.11; 0 in the cinema: on pure black it dithers into a disc of dots)
`;

/** sRGB transfer helpers (the frame targets hold sRGB-encoded palette colours). */
const SRGB_GLSL = /* glsl */ `
float srgbToLin1(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
float linToSrgb1(float c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
vec3 srgbToLin(vec3 c) { return vec3(srgbToLin1(c.r), srgbToLin1(c.g), srgbToLin1(c.b)); }
vec3 linToSrgb(vec3 c) { return vec3(linToSrgb1(c.r), linToSrgb1(c.g), linToSrgb1(c.b)); }
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

// One exit and an initialised result on every path: the D3D11 back-end (ANGLE on Windows) warned "use of potentially
// uninitialized variable (f_sampleScene)" for the early-return form of this function.
vec4 sampleScene(vec2 p) {
  vec2 uv = pxToUv(p);
  vec4 s = texture(uScene, uv);
  if (uTaps != 1) {
    // 2x supersampled: four bilinear taps = a 4x4 tent over the logical pixel.
    vec2 o = vec2(0.5) / uRes;
    s = 0.25 * (texture(uScene, uv + vec2(-o.x, -o.y)) + texture(uScene, uv + vec2(o.x, -o.y)) +
                texture(uScene, uv + vec2(-o.x, o.y)) + texture(uScene, uv + vec2(o.x, o.y)));
  }
  return s;
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
  // Impact lights (D5) brighten the gas in its OWN hue and never light empty dust (the Gate B KO turned a dark dust column
  // into a flat teal patch: blue light on near-black quantised into the palette's teal), with a capped amount.
  for (int i = 0; i < 4; i++) {
    if (i >= uNLt) break;
    vec4 L = uLt[i];
    float d = length(p - L.xy) / max(L.z, 1.0);
    float f = 1.0 / (1.0 + d * d * 3.0) * (1.0 - smoothstep(0.9, 1.7, d));
    float lm = clamp(luma(x) * 2.0, 0.0, 1.0);
    if (uLtImp[i] > 0.5) {
      // an impact lights only what is there, in its own hue: dark dust stays dark (no floor term), lit gas gets brighter
      x += x * min(L.w, 0.7) * f * 1.6 * lm;
    } else {
      x += uLtCol[i] * min(L.w, 1.1) * f * (uLtFloor + 0.4 * lm);
    }
  }
  // Hue-preserving tone map: identity below the knee (so colours authored on a palette ramp stay on it), a soft
  // shoulder above it, and very bright light bleeds toward white the way an overexposed sensor does.
  float m = max(x.r, max(x.g, x.b));
  const float knee = 0.72;
  float tm = m <= knee ? m : knee + (1.0 - knee) * (1.0 - exp(-(m - knee) / (1.0 - knee)));
  vec3 t = m > 1e-5 ? x * (tm / m) : vec3(0.0);
  t = mix(t, vec3(tm), smoothstep(1.4, 4.0, m) * 0.75);
  t = clamp((t - 0.5) * uContrast + 0.5, 0.0, 1.0);

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
uniform float uGlowFloor;    // additive glow below this contribution is dropped (0.05; the cinema raises it)
uniform vec4 uId;            // unified path: titan flag, draw rank / 255, wet, 0 (all 0 for additive layers)
uniform sampler2D uWet;      // R8 per cell (optional): materials allowed to reach the palette's top step
uniform int uHasWet;

layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oEmis;
layout(location = 2) out vec4 oId;

void main() {
  ivec2 P = ivec2(floor(gl_FragCoord.x), int(floor(uRes.y - gl_FragCoord.y)));
  ivec2 cell;
  if (uScreen == 1) {
    cell = P;
  } else {
    float ly = float(P.y) - uPlace.y + uPlace.w;
    // round-half-up of lean·(anchorY − row) / anchorY, made exact: the division may be an ulp off on some GPUs (D3D11), the
    // two products that check it are exact for pixel-sized values (layerMap.ts::sourceCell is the CPU twin)
    float num = uFL.y * (uPlace.w - ly);
    float den = max(1.0, uPlace.w);
    float shift = floor(num / den + 0.5);
    if ((shift - 0.5) * den > num) shift -= 1.0;
    else if ((shift + 0.5) * den <= num) shift += 1.0;
    float d = float(P.x) - uPlace.x - shift;
    float lx = uFL.x > 0.0 ? d + uPlace.z : uPlace.z - 1.0 - d;
    cell = ivec2(int(lx), int(ly));
    if (lx < 0.0 || ly < 0.0) discard;
  }
  if (cell.x >= int(uSize.x) || cell.y >= int(uSize.y)) discard;
  vec4 c = texelFetch(uTex, cell, 0);
  if (c.a <= 0.0) discard;
  // (uGlowFloor: 0.05 in the game; the cinema raises it, its pure black shows every dithered tail)
  // unified path, additive glow: faint residue (a few levels of a big overlay) would only become a dither checker after the
  // palette snap over whatever lies beneath; below ~5 % it adds nothing
  if (uId.a > 0.5 && max(c.r, max(c.g, c.b)) * c.a * uAlpha < uGlowFloor) discard;
  float e = uId.a > 0.5 ? 1.0 : uHasEmis == 1 ? texelFetch(uEmis, cell, 0).r : 0.0;
  float a = c.a * uAlpha;
  oColor = vec4(c.rgb, a);
  oEmis = vec4(c.rgb * e * uEmisGain, a);
  float wet = uHasWet == 1 ? texelFetch(uWet, cell, 0).r : uId.b;
  oId = vec4(uId.r, uId.g, wet * uId.r, a);
}
`;

/* ------------------------------------------------------------------------------------------------ *
 *  Rig parts (RenderLayer.parts, proposals 151/161): one quad per part over its rotated bounds; the fragment shader runs the
 *  shared clean-edge sampler (rotsprite.ts, bit-identical to contracts/rotation via proposal 161) on the layer's atlas, and
 *  takes the emissive of the texel that won the vote. Same outputs and blending as LAYER_FRAG.
 * ------------------------------------------------------------------------------------------------ */
export const PART_FRAG = /* glsl */ `${HEAD}${COMMON}
uniform sampler2D uEmis;     // R8, same layout as the atlas
uniform int uHasEmis;
uniform ivec2 uDest;         // destination pivot corner (logical px)
uniform float uAlpha;
uniform float uEmisGain;
uniform vec4 uId;            // unified path: titan flag, draw rank / 255, wet, 0
uniform sampler2D uWet;
uniform int uHasWet;
// Lit parts (unified.ts, proposal 167): per cell normal (r, g, b) and reference form light (a), lit by the one sky.
uniform sampler2D uLight;
uniform int uHasLight;
uniform vec3 uSkyDir;        // TITAN_SKY.dir (from the surface toward the light; x right, y down, z toward the camera)
${ROTSPRITE_GLSL}
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oEmis;
layout(location = 2) out vec4 oId;
// URI_SPEC §2.3: at rest the reference's own form light dominates; the further a part rotates, the more live normal-based
// light takes over (wForm = 0.82 · max(0, cos θ)³). The painted atlas IS the rest look, so the part is scaled by
// lum(θ) / lum(0): exact at rest, relit as it turns (the palette snap steps it back onto its ramp).
float partLum(vec4 L, vec2 cs, float facing) {
  float lnx = (L.r * 255.0 - 128.0) / 120.0;
  float lny = (L.g * 255.0 - 128.0) / 120.0;
  float lnz = L.b * 255.0 / 250.0;
  float snx = (lnx * cs.x - lny * cs.y) * facing;
  float sny = lnx * cs.y + lny * cs.x;
  float dk = max(0.0, snx * uSkyDir.x + sny * uSkyDir.y + lnz * uSkyDir.z);
  float wForm = 0.82 * pow(max(0.0, cs.x), 3.0);
  return wForm * L.a * 1.3 + (1.0 - wForm) * (0.06 + 0.58 * dk);
}
// 우리's own shading (URI_SPEC §2.3; the oracle's shadeAt + drawPart outline, uri/src/10_parts_render.js), for layers that
// carry the shade plane (surf, tone, edge, material code) beside the light plane (nx, ny, nz, form): ramp steps of the warm
// umber s1 / cool lavender s2 stone picked with the screen-locked Bayer offset, the emissive inlays by their screen patterns.
uniform sampler2D uShade;
uniform int uHasShade;
uniform vec3 uS1[11];
uniform vec3 uS2[11];
uniform vec3 uCiv[3];
uniform vec3 uField[3];
uniform float uBind;   // fist compression light (the oracle's drawFist: spread < 0.9 → bind 0..1), 0 = none
const float UBY[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
vec3 uriRamp(int surf, float l, ivec2 P) {
  float b = (UBY[(P.y & 3) * 4 + (P.x & 3)] + 0.5) / 16.0 - 0.5;
  int k = clamp(int(floor(l * 11.0 * 1.02 + b * 0.6)), 0, 10);
  return surf == 2 ? uS2[k] : uS1[k];
}
// returns the colour; e = 1 for the emissive inlays
vec3 uriShade(ivec2 texel, ivec2 P, vec2 cs, out float e) {
  vec4 S = texelFetch(uShade, texel, 0);
  int mat = int(S.a * 255.0 + 0.5);
  int x = P.x;
  int y = P.y;
  e = 1.0;
  vec3 c = vec3(0.0);
  if (mat == 3) c = uCiv[(x * 7 + y * 3) % 3];
  else if (mat == 2) c = uField[(x + y) % 3 == 0 ? 2 : 1];
  else if (mat == 9) c = (x % 2 == 1 ? vec3(255.0, 190.0, 120.0) : vec3(180.0, 220.0, 255.0)) / 255.0;
  else if (mat == 7) c = ((x + y) % 4 == 0 || abs(x - y) % 4 == 0 ? vec3(255.0, 214.0, 150.0) : vec3(44.0, 20.0, 10.0)) / 255.0;
  else if (mat == 8) c = vec3(255.0, 170.0, 90.0) / 255.0;
  else {
    e = 0.0;
    vec4 L = texelFetch(uLight, texel, 0);
    float lnx = (L.r * 255.0 - 128.0) / 120.0;
    float lny = (L.g * 255.0 - 128.0) / 120.0;
    float lnz = L.b * 255.0 / 250.0;
    float snx = lnx * cs.x - lny * cs.y;
    float sny = lnx * cs.y + lny * cs.x;
    float dk = max(0.0, snx * uSkyDir.x + sny * uSkyDir.y + lnz * uSkyDir.z);
    float wForm = pow(max(0.0, cs.x), 3.0) * 0.82;
    float lum = wForm * L.a * 1.3 + (1.0 - wForm) * (0.06 + 0.58 * dk) + (S.g - 0.5) * 0.22;
    if (mat == 10) lum *= 0.3;
    c = uriRamp(int(S.r * 255.0 + 0.5), lum, P);
    float rim = pow(1.0 - lnz, 2.0) * max(0.0, snx * 0.9 - sny * 0.1);
    if (rim > 0.5 && mat == 1 && wForm > 0.4) c = floor(c * 255.0 * 0.6 + vec3(110.0, 118.0, 160.0) * 0.4 + 0.001) / 255.0;
    // every part outlined in its own darker colour (drawPart: edge distance <= 1)
    bool edgeCell = S.b * 255.0 <= 1.01;
    if (edgeCell) c = floor(c * 255.0 * vec3(0.55, 0.55, 0.6) + 0.001) / 255.0;
    // a tightly compressed fist lights the field between its pieces (drawFist)
    if (uBind > 0.0) {
      if (((x + y) & 3) == 0 || (uBind > 0.6 && ((x * 3 + y) & 7) == 0))
        c = min(vec3(1.0), c + vec3(40.0 * uBind + 10.0, 60.0 * uBind + 10.0, 90.0 * uBind + 20.0) / 255.0);
      if (edgeCell && uBind > 0.4) c = vec3(150.0, 210.0, 255.0) / 255.0;
    }
  }
  return c;
}
// 우리's fists as rubble (the oracle's drawFist): every chunk drawn on its own, pushed out from the pivot by
// (centroid − pivot)·(spread − 1)·1.9; a 4-sample majority per chunk (≥ 2 of 4 cells of THAT chunk); later chunks win.
uniform int uFist;
uniform sampler2D uChunkId;    // RG8 per atlas cell: id & 255, id >> 8
uniform sampler2D uChunkTab;   // RGBA32F, 2 texels per chunk: (centroid x, y local, id, 0), (bbox x0, y0, x1, y1 local, exclusive)
uniform int uNChunk;
uniform float uSpreadK;        // spread − 1
int chunkAt(ivec2 t) {
  vec2 v = texelFetch(uChunkId, t, 0).rg * 255.0 + 0.5;
  return int(v.x) + 256 * int(v.y);
}
bool fistSample(ivec2 P, vec2 cs, out ivec2 texel) {
  bool found = false;
  texel = ivec2(0);
  vec2 piv = vec2(uPivot);
  for (int c = 0; c < 160; c++) {
    if (c >= uNChunk) break;
    vec4 A = texelFetch(uChunkTab, ivec2(2 * c, 0), 0);
    vec4 B = texelFetch(uChunkTab, ivec2(2 * c + 1, 0), 0);
    vec2 off = (A.xy - piv) * uSpreadK * 1.9;
    vec2 d0 = vec2(P - uDest) + 0.5;
    vec2 l0 = vec2(d0.x * cs.x + d0.y * cs.y, -d0.x * cs.y + d0.y * cs.x) + piv - off;
    if (l0.x < B.x - 1.5 || l0.y < B.y - 1.5 || l0.x > B.z + 1.5 || l0.y > B.w + 1.5) continue;
    int id = int(A.z + 0.5);
    int cnt = 0;
    ivec2 bt = ivec2(0);
    for (int s = 0; s < 4; s++) {
      vec2 d = vec2(P - uDest) + vec2((s & 1) == 1 ? 0.75 : 0.25, (s & 2) == 2 ? 0.75 : 0.25);
      vec2 l = vec2(d.x * cs.x + d.y * cs.y, -d.x * cs.y + d.y * cs.x) + piv - off;
      ivec2 cell = ivec2(floor(l));
      if (cell.x < 0 || cell.y < 0 || cell.x >= uPartSize.x || cell.y >= uPartSize.y) continue;
      ivec2 t = uPartOrigin + cell;
      if (texelFetch(uPart, t, 0).a <= 0.0 || chunkAt(t) != id) continue;
      cnt++;
      bt = t;
    }
    if (cnt >= 2) {
      found = true;
      texel = bt;
    }
  }
  return found;
}
void main() {
  ivec2 P = ivec2(floor(gl_FragCoord.x), int(floor(uRes.y - gl_FragCoord.y)));
  ivec2 texel;
  vec4 c;
  if (uFist == 1) {
    if (!fistSample(P, vec2(uRotCS) / 16384.0, texel)) discard;
    c = texelFetch(uPart, texel, 0);
  } else {
    c = rotSampleModeGL(P - uDest, texel); // the part's sampler mode (proposal 174)
  }
  if (c.a <= 0.0) discard;
  float e = uId.a > 0.5 ? 1.0 : uHasEmis == 1 ? texelFetch(uEmis, texel, 0).r : 0.0;
  if (uHasShade == 1) {
    float ue;
    // the oracle draws 우리 unmirrored (spec §5): facing is always +1 for it
    c.rgb = uriShade(texel, P, vec2(uRotCS) / 16384.0, ue);
    e = ue;
  } else if (uHasLight == 1 && e <= 0.0) {
    vec4 L = texelFetch(uLight, texel, 0);
    float fc = float(uFacing);
    float rest = partLum(L, vec2(1.0, 0.0), fc);
    float now = partLum(L, vec2(uRotCS) / 16384.0, fc);
    c.rgb = clamp(c.rgb * (now / max(rest, 0.05)), 0.0, 1.0);
  }
  float a = c.a * uAlpha;
  oColor = vec4(c.rgb, a);
  oEmis = vec4(c.rgb * e * uEmisGain, a);
  float wet = uHasWet == 1 ? texelFetch(uWet, texel, 0).r : uId.b;
  oId = vec4(uId.r, uId.g, wet * uId.r, a);
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
 *  The unified titan path (shared/UNIFICATION.md, D31): edges, seams and the final palette snap.
 * ------------------------------------------------------------------------------------------------ */

/**
 * What a frame pixel is, read from the layer target's id attachment (GL texel coords): 0 nothing of ours (scenery), 1 an
 * effect / debris / non-titan layer pixel, 2 a titan body pixel, 3 the one-pixel dark outline around a titan (plus a second
 * pixel on the shadow side, right and below, away from the one sky's upper-left key).
 */
const FIGURE_GLSL = /* glsl */ `
uniform sampler2D uLayerCol;   // layer colour target (alpha = coverage)
uniform sampler2D uLayerId;    // layer id target: r titan, g draw rank, b wet (a non-titan layer drawn on top clears r)
bool titanAt(ivec2 q) {
  if (q.x < 0 || q.y < 0 || q.x >= int(uRes.x) || q.y >= int(uRes.y)) return false;
  return texelFetch(uLayerId, q, 0).r > 0.5;
}
bool coveredAt(ivec2 q) {
  if (q.x < 0 || q.y < 0 || q.x >= int(uRes.x) || q.y >= int(uRes.y)) return false;
  return texelFetch(uLayerCol, q, 0).a > 0.0;
}
int figureKind(ivec2 q) {
  int k = 0;
  if (coveredAt(q)) {
    k = titanAt(q) ? 2 : 1;
  } else if (titanAt(q + ivec2(1, 0)) || titanAt(q - ivec2(1, 0)) || titanAt(q + ivec2(0, 1)) || titanAt(q - ivec2(0, 1))) {
    k = 3;
  } else if ((titanAt(q - ivec2(2, 0)) && !coveredAt(q - ivec2(1, 0))) || (titanAt(q + ivec2(0, 2)) && !coveredAt(q + ivec2(0, 1)))) {
    // shadow side: a second outline pixel to the right of and below a silhouette (texel y is up: "below" is −y)
    k = 3;
  } else if (dot(texelFetch(uLayerCol, q, 0).rgb, vec3(1.0)) > 0.012) {
    // an additive glow layer's pixel (it adds colour, never coverage): an effect pixel
    k = 1;
  }
  return k;
}
`;

/**
 * Unified composite of the layer target over the dithered scenery (replaces LAYER_COMPOSITE_FRAG on the unified path):
 *  - a titan pixel next to a titan pixel drawn IN FRONT of it (higher draw rank) is the back part's edge: darkened, a depth seam;
 *  - an empty pixel next to a titan silhouette becomes the outline colour (one pixel; two on the shadow side).
 * Premultiplied "over", like the plain composite.
 */
export const TITAN_FINISH_FRAG = /* glsl */ `${HEAD}${COMMON}${FIGURE_GLSL}
uniform sampler2D uLayerEmis;
uniform vec3 uOutline;       // sRGB
uniform vec3 uSeam;          // multiplier on a back part's edge pixels
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oEmis;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(uLayerCol, q, 0);
  if (c.a > 0.0) {
    vec4 id = texelFetch(uLayerId, q, 0);
    // cast shadows (URI_SPEC §2.3, 우리-style layers, id.r 0.75): a part drawn ≥ 2 places in front, 3 px left and 4 px up,
    // shades this non-glowing pixel ×0.68 (×0.72 blue)
    if (id.r > 0.6 && id.r < 0.9 && dot(texelFetch(uLayerEmis, q, 0).rgb, vec3(1.0)) <= 0.0) {
      ivec2 sq = q + ivec2(-3, 4);
      if (sq.x >= 0 && sq.y < int(uRes.y)) {
        vec4 sid = texelFetch(uLayerId, sq, 0);
        if (sid.r > 0.6 && sid.r < 0.9 && sid.g > id.g + 1.5 / 255.0) c.rgb = floor(c.rgb * 255.0 * vec3(0.68, 0.68, 0.72) + 0.001) / 255.0;
      }
    }
    // depth seams (UNIFICATION §4); 우리-style layers carry their own: every part outlined in its own darker colour
    if (id.r > 0.9) {
      float r = id.g + 0.5 / 255.0;
      ivec2 n[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
      for (int i = 0; i < 4; i++) {
        ivec2 p = q + n[i];
        if (!titanAt(p)) continue;
        if (texelFetch(uLayerId, p, 0).g > r) {
          c.rgb *= uSeam;
          break;
        }
      }
    }
    oColor = c;
    oEmis = texelFetch(uLayerEmis, q, 0);
    return;
  }
  if (figureKind(q) == 3) {
    oColor = vec4(uOutline, 1.0);
    oEmis = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // additive glow (premultiplied colour with no coverage): added over the scenery, as in the plain composite
  vec4 e = texelFetch(uLayerEmis, q, 0);
  if (dot(c.rgb, vec3(1.0)) + dot(e.rgb, vec3(1.0)) <= 0.0) discard;
  oColor = c;
  oEmis = e;
}
`;

/** Separable 9-tap gaussian of an RGB texture (σ = 2 taps: `uStep` = σ / 2 in uv). The shared bloom's two blurs. */
export const BLUR_FRAG = /* glsl */ `${HEAD}
uniform sampler2D uSrc;
uniform vec2 uStep;
in vec2 vUv;
out vec4 o;
void main() {
  float w[5] = float[5](0.2270, 0.1946, 0.1216, 0.0541, 0.0162);
  vec3 s = texture(uSrc, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    s += (texture(uSrc, vUv + uStep * float(i)).rgb + texture(uSrc, vUv - uStep * float(i)).rgb) * w[i];
  }
  o = vec4(s, 1.0);
}
`;

/**
 * The final palette snap (unified path, end of POST_FRAG): every pixel is snapped with the ordered 4×4 Bayer matrix and the same
 * pair LUT the scenery uses — titan, effect and outline pixels to the MASTER palette, scenery pixels to the stage palette (already
 * pulled toward the master, master.ts). A non-glowing, non-wet titan pixel never takes a ramp's top step (highlight ceiling).
 */
const SNAP_GLSL = /* glsl */ `
uniform int uUnified;
uniform sampler3D uMasterLut;
uniform float uMasterSize;
uniform sampler2D uMasterSrgb;   // alpha = ceiling index / 255
uniform sampler2D uMasterLin;
uniform sampler3D uStageLut;
uniform float uStageSize;
uniform sampler2D uStageSrgb;
uniform sampler2D uStageLin;
uniform sampler2D uLayerEmisT;
uniform int uOutlineIdx;        // the outline's master palette index (written exactly, never dithered)
uniform vec2 uSpread;           // ordered-dither spread (0..255 sRGB units): figures, scenery (the oracles: 26, 18)
vec3 srgbToLinS(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
int snapIndex(sampler3D lut, float size, sampler2D lin, sampler2D srgb, vec3 s, float th, float spread) {
  vec3 t = srgbToLinS(s);
  vec4 e = texture(lut, (s * (size - 1.0) + 0.5) / size);
  int ia = int(e.r * 255.0 + 0.5);
  int ib = int(e.g * 255.0 + 0.5);
  vec3 A = texelFetch(lin, ivec2(ia, 0), 0).rgb;
  vec3 B = texelFetch(lin, ivec2(ib, 0), 0).rgb;
  vec3 d = B - A;
  float len2 = dot(d, d);
  float r = len2 > 1e-9 ? clamp(dot(t - A, d) / len2, 0.0, 1.0) : 0.0;
  // the oracles' ordered dither (uri/src/00_shared_helpers.js quantize): a Bayer offset of ±spread/2 (in 0..255 sRGB units)
  // on the colour before the nearest-colour pick. Projected on the pair: only colours within that margin of the midpoint
  // between two palette steps dither; painted colours already near a step stay solid.
  vec3 sa = texelFetch(srgb, ivec2(ia, 0), 0).rgb;
  float D = max(length((texelFetch(srgb, ivec2(ib, 0), 0).rgb - sa) * 255.0), 1.0);
  float rr = r + (th - 0.5) * spread * 1.7 / D;
  return (ia != ib && rr > 0.5) ? ib : ia;
}
vec3 snapPixel(vec3 s, ivec2 q, float th) {
  int kind = figureKind(q);
  vec3 res = vec3(0.0);
  if (kind == 3) {
    res = texelFetch(uMasterSrgb, ivec2(uOutlineIdx, 0), 0).rgb;
  } else if (kind == 0) {
    res = texelFetch(uStageSrgb, ivec2(snapIndex(uStageLut, uStageSize, uStageLin, uStageSrgb, s, th, uSpread.y), 0), 0).rgb;
  } else {
    int i = snapIndex(uMasterLut, uMasterSize, uMasterLin, uMasterSrgb, s, th, uSpread.x);
    if (kind == 2) {
      bool glow = luma(texelFetch(uLayerEmisT, q, 0).rgb) > 0.02 || texelFetch(uLayerId, q, 0).b > 0.5;
      if (!glow) i = int(texelFetch(uMasterSrgb, ivec2(i, 0), 0).a * 255.0 + 0.5);
    }
    res = texelFetch(uMasterSrgb, ivec2(i, 0), 0).rgb;
  }
  return res;
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
 *  Post: shockwave + local wound refraction → chromatic fringe → + bloom + god rays → vignette → grain.
 *  Light from impacts is LOCAL (impact lights); the one whole-frame lift is the D34 wash on heavy blows and KOs, scaled
 *  by the comfort setting (none in comfort mode, D5).
 *  Everything keeps to the pixel grid: samples snap to whole source pixels and bloom/vignette are dithered.
 * ------------------------------------------------------------------------------------------------ */
export const POST_FRAG = /* glsl */ `${HEAD}${COMMON}${LIGHTS_GLSL}${FIGURE_GLSL}${SNAP_GLSL}
uniform sampler2D uFrame;
uniform sampler2D uBloom;
uniform sampler2D uBloomB;     // unified path: the far (≈ 10 px) blur; uBloom is then the near (≈ 3 px) one
uniform vec2 uBloomMix;        // unified path: near, far gains (SHARED_BLOOM); (0, 0) = the classic pyramid in uBloom
uniform float uBloomFloor;    // cinema: bloom below this many steps is dropped (0 = off, the game)
uniform vec4 uWash;            // D34 screen-wide flash: colour, amount (0 = none; already scaled by the comfort setting)
uniform vec2 uWashAt;          // its centre (logical px): the wash is strongest there and covers the whole frame
uniform float uShockE[8];      // per shockwave: vertical scale of the ring (1 = round; < 1 = flattened toward the camera)
uniform sampler2D uGod;
uniform sampler2D uBayer;
uniform sampler2D uCover;    // layer colour target (alpha = coverage of the 2D layers)
uniform int uHasLayers;
uniform vec2 uGlowDamp;      // how much bloom / god rays are damped ON the pixels of a sprite (0..1)
uniform vec4 uShock[8];      // x, y (logical px), radius px, displacement px
uniform int uNumShock;
uniform vec4 uRefr[2];       // local wound refraction: x, y (logical px), radius px, strength 0..1
uniform int uNumRefr;
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
// Only BODY lights own pixels: an impact light sits on a wound, and letting it claim the sprite would re-shade the body around
// the wrong centre. Impact lights only ADD light to the faces turned toward them (no shading, no occlusion).
vec3 relightFrom(vec3 col, vec2 p, float th, int j) {
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
    // an impact light never burns a sprite white: the wound has to stay legible at the light's peak
    float I = min(L.w, uLtImp[i] > 0.5 ? 0.75 : 1.3);
    float lam = max(dot(n, normalize(vec3(dir, 0.5))), 0.0);
    float lit = floor(I * fall * lam * 4.0 + th) / 4.0;
    add += uLtCol[i] * lit;
    float body = 1.0 - step(0.5, uLtImp[i]);
    float dark = floor(I * fall * (1.0 - lam) * 3.0 + th) / 3.0;
    shade += 0.4 * dark * body;
    // mutual occlusion: near another body, the side facing it loses ambient light
    float Rbi = clamp(L.z * 0.45, 42.0, 100.0);
    float occ = smoothstep(Rbi * 2.0, Rbi * 0.8, dist) * max(dot(od, dir), 0.0) * r;
    shade += 0.2 * floor(occ * 3.0 + th) / 3.0 * body;
  }
  float keep = 1.0 - smoothstep(0.62, 0.95, luma(col));   // glowing / near-white pixels keep their own light
  vec3 res = col * (1.0 - clamp(shade, 0.0, 0.5) * keep);
  return res + add * 1.2 * keep;
}

vec3 relight(vec3 col, vec2 p, float th) {
  int j = -1;
  float dj = 1e9;
  for (int i = 0; i < 4; i++) {
    if (i >= uNLt) break;
    if (uLtImp[i] > 0.5) continue;
    float d = length(p - uLt[i].xy);
    if (d < dj) { dj = d; j = i; }
  }
  vec3 res = col;
  if (j >= 0) res = relightFrom(col, p, th, j);
  return res;
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
    d.y /= max(uShockE[i], 0.25);
    float r = length(d) + 1e-3;
    float t = 5.0 + 0.11 * s.z;
    float ring = exp(-pow((r - s.z) / t, 2.0));
    sp -= d / r * ring * s.w;
  }
  // Local wound refraction (replaces the old full-frame aberration): a thin RIPPLE of the existing image travelling out from
  // the wound — at most ~3 px of displacement on a ring, with a ~1 px chromatic split only on that ring's edge. It never
  // magnifies or tints an area (a magnifying lens read as a foreign object in the Gate B footage). As the strength decays
  // (1 → 0) the ring grows from 0.35 to 1.0 of the radius, so it reads as a wave leaving the blow.
  vec2 caL = vec2(0.0);
  for (int i = 0; i < 2; i++) {
    if (i >= uNumRefr) break;
    vec4 R = uRefr[i];
    vec2 d = p - R.xy;
    float r = length(d) + 1e-3;
    float rr = R.z * (1.0 - 0.65 * R.w);
    float width = 3.0 + 0.08 * R.z;
    float ring = exp(-pow((r - rr) / width, 2.0));
    sp -= d / r * ring * (3.0 * R.w);
    caL += d / r * ring * smoothstep(0.35, 0.8, ring) * (1.2 * R.w);
  }
  vec2 fromC = (p - uRes * 0.5) / (uRes.y * 0.5);
  float edge = dot(fromC, fromC);
  float ca = 0.35 * edge;
  vec2 dir = fromC / (length(fromC) + 1e-4);
  vec3 col;
  col.r = fetchFrame(sp + dir * ca + caL).r;
  col.g = fetchFrame(sp).g;
  col.b = fetchFrame(sp - dir * ca - caL).b;

  float th = texelFetch(uBayer, ivec2(gl_FragCoord.xy) & 3, 0).r;
  vec2 uv = pxToUv(sp);
  vec3 bloom = (uBloomMix.x + uBloomMix.y > 0.0 ? texture(uBloom, uv).rgb * uBloomMix.x + texture(uBloomB, uv).rgb * uBloomMix.y : texture(uBloom, uv).rgb) * uBloomGain;
  // cinema: light below one bloom step is dropped instead of dithered (on pure black it shows as a sparse dot field)
  if (uBloomFloor > 0.0) bloom *= step(uBloomFloor / uBloomLevels, max(bloom.r, max(bloom.g, bloom.b)));
  bloom = vec3(ditherQ(bloom.r, uBloomLevels, th), ditherQ(bloom.g, uBloomLevels, th), ditherQ(bloom.b, uBloomLevels, th));
  vec4 g = texture(uGod, uv);
  vec3 rays = (uGodColor * g.r + g.gba * uGodTint) * uGodGain;
  rays = vec3(ditherQ(rays.r, uBloomLevels, th), ditherQ(rays.g, uBloomLevels, th), ditherQ(rays.b, uBloomLevels, th));
  // Glow never washes out a sprite's own pixels (silhouettes stay crisp); it still blooms around them.
  float cov = uHasLayers == 1 ? texelFetch(uCover, pxToTexel(clamp(ivec2(floor(sp)), ivec2(0), ivec2(uRes) - 1)), 0).a : 0.0;
  // (cinema: pure black is empty space under a backdrop layer, not a body: the lights must not paint a dithered disc on it)
  if (uRelight == 1 && uNLt >= 2 && cov > 0.5 && (uLtFloor > 0.0 || luma(col) > 0.012)) col = relight(col, floor(sp) + 0.5, th);
  // unified path: the glow damping holds on titan bodies only (backdrop / effect layers take the bloom like scenery)
  if (uUnified == 1) cov = titanAt(pxToTexel(clamp(ivec2(floor(sp)), ivec2(0), ivec2(uRes) - 1))) ? 1.0 : 0.0;
  // unified path, on a titan body: only the strong part of the glow lands (near an emissive); the faint wide tail would only
  // tint the dark stone enough to dither it into a checker after the snap
  if (uUnified == 1 && cov > 0.5) bloom = max(bloom - vec3(0.08), vec3(0.0)) * 1.4;
  col = col + bloom * (1.0 - uGlowDamp.x * cov) + rays * (1.0 - uGlowDamp.y * cov);

  // the screen-wide flash (D34): the whole frame lifts toward the blow's light, most at the blow, stepped by the Bayer matrix
  if (uWash.w > 0.0) {
    float wd = length(p - uWashAt);
    float wk = uWash.w * (0.6 + 0.4 * exp(-wd / 200.0));
    col += uWash.rgb * ditherQ(wk, 16.0, th);
  }
  float vig = 1.0 - uVignette * pow(smoothstep(0.55, 1.45, length(fromC * vec2(0.85, 1.0))), 1.6);
  col *= ditherQ(vig, 12.0, th);

  if (uUnified == 1) {
    // the final palette snap: no grain (it would only sparkle through the dither), every pixel lands on a palette colour
    ivec2 sq = pxToTexel(clamp(ivec2(floor(sp)), ivec2(0), ivec2(uRes) - 1));
    o = vec4(snapPixel(clamp(col, 0.0, 1.0), sq, th), 1.0);
    return;
  }
  float n = hash13(vec3(floor(gl_FragCoord.xy), uFrameNo)) - 0.5;
  col += n * uGrain * (0.35 + luma(col));
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/* ------------------------------------------------------------------------------------------------ *
 *  Luminance governor (D5 safety net): mean relative luminance of the post frame → 1×1 state that clamps any brightening
 *  of the whole frame to `uLimit` above its 300 ms average. Three tiny passes, no CPU read-back on the frame's path.
 * ------------------------------------------------------------------------------------------------ */
/** 640×360 → 40×23 blocks: r = Σ linear relative luminance of the block's pixels, g = pixel count. */
export const LUM_DOWN_FRAG = /* glsl */ `${HEAD}${COMMON}${SRGB_GLSL}
uniform sampler2D uSrc;
out vec4 o;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy) * 16;
  ivec2 lim = ivec2(uRes);
  float s = 0.0;
  float n = 0.0;
  for (int y = 0; y < 16; y++) {
    for (int x = 0; x < 16; x++) {
      ivec2 q = b + ivec2(x, y);
      if (q.x < lim.x && q.y < lim.y) {
        vec3 c = srgbToLin(texelFetch(uSrc, q, 0).rgb);
        s += dot(c, vec3(0.2126, 0.7152, 0.0722));
        n += 1.0;
      }
    }
  }
  o = vec4(s, n, 0.0, 1.0);
}
`;

/**
 * 1×1 governor state (ping-pong): r = A, the 300 ms average of the DISPLAYED luminance; g = this frame's raw mean;
 * b = the gain the final pass applies (≤ 1: only brightening is ever held back); a = the displayed mean.
 */
export const GOVERN_FRAG = /* glsl */ `${HEAD}
uniform sampler2D uBlocks;   // 40×23 from LUM_DOWN_FRAG
uniform sampler2D uPrev;     // previous state
uniform float uDt;           // wall seconds since the previous frame
uniform float uTau;          // averaging time constant (s)
uniform float uLimit;        // largest allowed rise of the mean above its average (relative luminance, 0..1)
uniform int uReset;          // 1 = adopt this frame as the average (first frame, stage switch)
uniform int uOn;             // 0 = measure only (gain 1)
out vec4 o;
void main() {
  float S = 0.0;
  float N = 0.0;
  for (int y = 0; y < 23; y++) {
    for (int x = 0; x < 40; x++) {
      vec2 t = texelFetch(uBlocks, ivec2(x, y), 0).rg;
      S += t.r;
      N += t.g;
    }
  }
  float L = S / max(N, 1.0);
  float A = uReset == 1 ? L : texelFetch(uPrev, ivec2(0), 0).r;
  float g = uOn == 1 ? clamp((A + uLimit) / max(L, 1e-4), 0.0, 1.0) : 1.0;
  float shown = L * g;
  A += (shown - A) * (1.0 - exp(-uDt / uTau));
  o = vec4(A, L, g, shown);
}
`;

/* ------------------------------------------------------------------------------------------------ *
 *  Final: nearest-neighbour integer upscale to the canvas with micro-zoom + roll; UI composited last, un-zoomed.
 * ------------------------------------------------------------------------------------------------ */
export const FINAL_FRAG = /* glsl */ `${HEAD}${COMMON}${SRGB_GLSL}
uniform sampler2D uPost;     // LINEAR-filtered (only the sharp-bilinear path uses the filter; the rest is texelFetch)
uniform sampler2D uUi;
uniform int uHasUi;
uniform float uZoom;
uniform float uRoll;
uniform int uPush;           // 1 = sharp-bilinear resampling (the push=1 sprite-push A/B), 0 = nearest
uniform float uSharp;        // canvas px per logical px after zoom: the width of the sharp-bilinear transition
uniform sampler2D uGov;      // 1×1 governor state (b = gain)
uniform int uHasGov;
in vec2 vUv;
out vec4 o;
void main() {
  vec2 p = vec2(vUv.x * uRes.x, (1.0 - vUv.y) * uRes.y);   // fractional logical px under this canvas pixel
  vec2 q = p - uRes * 0.5;
  float cs = cos(uRoll);
  float sn = sin(uRoll);
  q = vec2(cs * q.x + sn * q.y, -sn * q.x + cs * q.y) / uZoom;
  vec2 sp = q + uRes * 0.5;
  vec3 col;
  if (uPush == 1) {
    // sharp-bilinear: flat inside each source pixel, a one-canvas-pixel linear blend at its edges (no shimmer, no uneven pixels)
    vec2 t = sp - 0.5;
    vec2 i = floor(t);
    vec2 f = clamp((t - i - 0.5) * uSharp + 0.5, 0.0, 1.0);
    vec2 s = clamp(i + 0.5 + f, vec2(0.5), uRes - 0.5);
    col = texture(uPost, pxToUv(s)).rgb;
  } else {
    ivec2 c = clamp(ivec2(floor(sp)), ivec2(0), ivec2(uRes) - 1);
    col = texelFetch(uPost, pxToTexel(c), 0).rgb;
  }
  if (uHasGov == 1) {
    float g = texelFetch(uGov, ivec2(0), 0).b;
    if (g < 0.999) col = linToSrgb(srgbToLin(col) * g);
  }
  if (uHasUi == 1) {
    ivec2 u = clamp(ivec2(floor(p)), ivec2(0), ivec2(uRes) - 1);
    vec4 ui = texelFetch(uUi, u, 0);
    col = mix(col, ui.rgb, ui.a);
  }
  o = vec4(col, 1.0);
}
`;
