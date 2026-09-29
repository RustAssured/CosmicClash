import { hex, hsl, hslToRgb, rgba, rgbToHsl } from '@/contracts';

/**
 * UI palette. Cool blue-black inks, a warm-white text ramp (hue-shifted: shadows lean indigo, lights lean warm), the
 * celadon of the Last One as the house accent, and one warm/cool pair for the two players. Nothing here is neutral grey —
 * every step of every ramp carries a hue.
 */
export const C = {
  void: hex('#04050a'),
  ink0: hex('#070a12'),
  ink1: hex('#0b101c'),
  ink2: hex('#111828'),
  ink3: hex('#182137'),
  line0: hex('#1f2a44'),
  line1: hex('#2e3b5c'),
  line2: hex('#465476'),
  dim: hex('#5f6d8c'),
  mid: hex('#8996b3'),
  soft: hex('#b6c1d6'),
  text: hex('#e6ecf5'),
  white: hex('#f7faff'),
  celadon: hex('#a8bdb2'),
  celadonLight: hex('#d3e4da'),
  celadonDeep: hex('#5d7a70'),
  gold: hex('#ecc98a'),
  danger: hex('#e0705f'),
  dangerDeep: hex('#7a2f3a'),
  ok: hex('#86d1a8'),
  p1: hex('#f2b866'),
  p2: hex('#6cc6dc'),
} as const;

/** Alpha variants of an opaque packed colour. */
export const alpha = (c: number, a: number): number =>
  rgba(c & 255, (c >>> 8) & 255, (c >>> 16) & 255, Math.round(255 * a));

export interface AccentRamp {
  deep: number;
  dim: number;
  base: number;
  light: number;
  glow: number;
}

/**
 * Build a five-step hue-shifted ramp from a titan's accent colour: the deep end drifts toward indigo, the light end toward
 * warm white, and saturation peaks in the middle — so a plain accent gets a shaded, pixel-art feel.
 */
export function accentRamp(accentHex: string): AccentRamp {
  const c = hex(accentHex);
  const [h, s, l] = rgbToHsl(c & 255, (c >>> 8) & 255, (c >>> 16) & 255);
  const mk = (dh: number, ds: number, lv: number): number => hsl(h + dh, Math.min(1, s * ds), lv);
  return {
    deep: mk(-0.05, 0.75, Math.max(0.12, l * 0.36)),
    dim: mk(-0.025, 0.85, Math.max(0.2, l * 0.62)),
    base: c,
    light: mk(0.02, 0.8, Math.min(0.88, l + (1 - l) * 0.42)),
    glow: mk(0.035, 0.55, Math.min(0.96, l + (1 - l) * 0.75)),
  };
}

/** Mix two packed colours (sRGB, straight alpha ignored — opaque result). */
export function mixRgb(a: number, b: number, t: number): number {
  return rgba(
    (a & 255) + ((b & 255) - (a & 255)) * t,
    ((a >>> 8) & 255) + (((b >>> 8) & 255) - ((a >>> 8) & 255)) * t,
    ((a >>> 16) & 255) + (((b >>> 16) & 255) - ((a >>> 16) & 255)) * t,
  );
}

/** A deterministic desaturated version of a colour (for unavailable items). */
export function greyed(c: number, k = 0.85): number {
  const r = c & 255;
  const g = (c >>> 8) & 255;
  const b = (c >>> 16) & 255;
  const l = r * 0.3 + g * 0.55 + b * 0.15;
  const [rr, gg, bb] = [r + (l - r) * k, g + (l - g) * k, b + (l - b) * k];
  return rgba(rr * 0.55, gg * 0.55, bb * 0.6);
}

/** Convenience: HSL → packed (hue 0..1). */
export const hslc = (h: number, s: number, l: number): number => {
  const [r, g, b] = hslToRgb(h, s, l);
  return rgba(r, g, b);
};
