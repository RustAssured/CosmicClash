/**
 * Colour helpers for the titan kit: perceptual distance (OKLab) for the roster's palette-clash check, hue maths and a
 * hue-shifted pixel-art ramp builder for new titans. Pure.
 */

/** '#rrggbb' → linear-light OKLab [L, a, b]. */
export function oklab(hexColor: string): [number, number, number] {
  const v = parseInt(hexColor.slice(1, 7), 16);
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = lin((v >> 16) & 255);
  const g = lin((v >> 8) & 255);
  const b = lin(v & 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Perceptual distance between two colours (OKLab ΔE: about 0.02 is barely visible, 0.1 clearly different). */
export function deltaE(a: string, b: string): number {
  const p = oklab(a);
  const q = oklab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** Below this distance two signature colours read as the same colour on the select screen and the HUD. */
export const CLASH_DE = 0.09;

/**
 * Do two titans' signatures (accent, accent2) read as the same? Only when BOTH colours match: two titans may share one
 * colour (the Black Hole's and the Supernova's orange) if the other tells them apart. The main accent leads (it is the
 * HUD bar, the card's frame), so the Planet's blue-and-gold is not 우리's gold-and-blue.
 */
export function signaturesClash(a: readonly [string, string], b: readonly [string, string]): boolean {
  const same = (x: string, y: string): boolean => deltaE(x, y) < CLASH_DE;
  return same(a[0], b[0]) && same(a[1], b[1]);
}

export function hexToHsl(hexColor: string): [number, number, number] {
  const v = parseInt(hexColor.slice(1, 7), 16);
  const r = ((v >> 16) & 255) / 255;
  const g = ((v >> 8) & 255) / 255;
  const b = (v & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) * 60
      : max === g
        ? ((b - r) / d + 2) * 60
        : ((r - g) / d + 4) * 60;
  return [h, s, l];
}

export function hslToHex(h: number, s: number, l: number): string {
  const hh = (((h % 360) + 360) % 360) / 360;
  const f = (n: number): number => {
    const k = (n + hh * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const to = (x: number): string =>
    Math.round(Math.max(0, Math.min(1, x)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

/** Rotate a colour's hue by `deg`, keeping its saturation and lightness. */
export const rotateHue = (hexColor: string, deg: number): string => {
  const [h, s, l] = hexToHsl(hexColor);
  return hslToHex(h + deg, s, l);
};

/** Circular hue distance in degrees (0..180). */
export const hueDistance = (a: number, b: number): number => {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
};

/**
 * A pixel-art ramp, dark → light, `n` steps around hue `h`: shadows drift cooler (toward blue/violet), highlights warmer
 * (toward yellow), saturation peaks in the mid-tones. `sat` 0..1 scales the saturation, `lo`/`hi` the lightness range.
 */
export function buildRamp(h: number, n = 7, sat = 0.6, lo = 0.08, hi = 0.86): string[] {
  const out: string[] = [];
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 0.5 : k / (n - 1);
    const shift = (t - 0.5) * 36; // −18° in the shadows, +18° in the lights
    // toward yellow (60°) for highlights, toward blue (240°) for shadows, by the shortest way round
    const toward = t > 0.5 ? 60 : 240;
    const dir = ((toward - h + 540) % 360) - 180 > 0 ? 1 : -1;
    const hue = h + dir * Math.abs(shift);
    const s = sat * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, 0.15 + t)));
    out.push(hslToHex(hue, s, lo + (hi - lo) * Math.pow(t, 0.95)));
  }
  return out;
}
