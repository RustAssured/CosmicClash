import type { Rgb } from './color';
import type { KitLayer, SceneryKit } from './kit';

/**
 * A bank of dark dust / mist along the bottom of the frame: fbm-edged, tilted, with a thin scatter-lit lip on its upper edge.
 * It is the ground the fighters stand in front of — it grounds the composition and gives god rays something to be cut by.
 */

export interface DustBankOpts {
  parallax: number;
  /** Body and lip colours (linear HDR). */
  col: Rgb;
  rim: Rgb;
  /** Screen fraction (0 top … 1 bottom) where the bank's edge sits at the frame centre, and its tilt across the frame. */
  top: number;
  slope: number;
  /** Edge roughness (fraction of screen height) and softness of the edge (fraction). */
  roughness: number;
  soft: number;
  /** Noise scale in px (x, y) and drift speed. */
  scale: readonly [number, number];
  speed: number;
  alpha: number;
  forceK: number;
  /** Strength of the lit lip and its width as a fraction of the screen height (default 0.05: a thin bright edge). */
  rimK?: number;
  lip?: number;
}

const BANK_FRAGMENT = /* glsl */ `
uniform vec3 uCol;
uniform vec3 uRim;
uniform vec4 uShape;      // top, slope, roughness, softness
uniform vec2 uScaleXY;
uniform float uSpeed;
uniform float uAlpha;
uniform float uForceK;
uniform float uRimK;
uniform float uLip;
void main() {
  vec2 sp = warpByForces(screenPx(), -uForceK);
  vec2 lp = sp + uView * uParallax;
  float t = uFlow * uSpeed;
  float n = fbm(vec2(lp.x / uScaleXY.x + t, lp.y / uScaleXY.y - t * 0.4), 4);
  vec2 s = sp / uRes;
  float edge = s.y + (n - 0.5) * uShape.z - uShape.x + uShape.y * (s.x - 0.5);
  // a crisp torn edge (uLip wide), then the dust thickens with depth over the softness distance
  float a = smoothstep(0.0, uLip * 0.6, edge) * mix(0.5, 1.0, smoothstep(0.0, uShape.w, edge)) * uAlpha;
  float lip = smoothstep(0.0, uLip * 0.3, edge) * (1.0 - smoothstep(uLip * 0.3, uLip, edge));
  float pat = smoothstep(0.2, 0.9, fbm(vec2(lp.x / 70.0 - t, lp.y / 40.0), 3));   // the light catches the edge unevenly
  vec3 col = uCol * (0.55 + 0.9 * n) + uRim * lip * (0.12 + 0.88 * pat) * uRimK;
  o = vec4(col, a);
}
`;

export function addDustBank(kit: SceneryKit, name: string, o: DustBankOpts): KitLayer {
  return kit.addFullscreen(name, BANK_FRAGMENT, 'normal', o.parallax, {
    uCol: { value: [...o.col] },
    uRim: { value: [...o.rim] },
    uShape: { value: [o.top, o.slope, o.roughness, o.soft] },
    uScaleXY: { value: [...o.scale] },
    uSpeed: { value: o.speed },
    uAlpha: { value: o.alpha },
    uForceK: { value: o.forceK },
    uRimK: { value: o.rimK ?? 1 },
    uLip: { value: o.lip ?? 0.05 },
  });
}
