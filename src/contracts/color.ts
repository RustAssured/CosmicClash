/**
 * Packed pixel colour: little-endian RGBA in a Uint32 (byte order R,G,B,A in memory), i.e.
 * value = (a << 24) | (b << 16) | (g << 8) | r. Every pixel buffer in the game uses this layout so it can be
 * uploaded to WebGL as RGBA8 and written to ImageData through a Uint32Array view without swizzling.
 * A fully transparent pixel is exactly 0.
 */
export const rgba = (r: number, g: number, b: number, a = 255): number =>
  (((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
export const pr = (c: number): number => c & 255;
export const pg = (c: number): number => (c >>> 8) & 255;
export const pb = (c: number): number => (c >>> 16) & 255;
export const pa = (c: number): number => (c >>> 24) & 255;

/** '#rrggbb' or '#rgb' → packed opaque colour. */
export function hex(s: string): number {
  let h = s.startsWith('#') ? s.slice(1) : s;
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  const n = parseInt(h, 16);
  return rgba((n >> 16) & 255, (n >> 8) & 255, n & 255, 255);
}
export function toHex(c: number): string {
  return '#' + [pr(c), pg(c), pb(c)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Linear blend of two packed colours in sRGB byte space (alpha blended too). */
export function mix(c0: number, c1: number, t: number): number {
  const u = 1 - t;
  return rgba(
    Math.round(pr(c0) * u + pr(c1) * t),
    Math.round(pg(c0) * u + pg(c1) * t),
    Math.round(pb(c0) * u + pb(c1) * t),
    Math.round(pa(c0) * u + pa(c1) * t),
  );
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 1) + 1) % 1;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number): number => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}

export const hsl = (h: number, s: number, l: number, a = 255): number => {
  const [r, g, b] = hslToRgb(h, s, l);
  return rgba(r, g, b, a);
};

/**
 * Hue-shifted ramp (the pixel-art way): darker steps drift toward `shadowHue`, lighter steps toward `lightHue`,
 * saturation peaks in the midtones. Returns `steps` packed colours from darkest to lightest.
 * Hues are 0..1. This is the canonical way to build any colour ramp in the game.
 */
export function hueShiftRamp(
  baseHue: number,
  baseSat: number,
  steps: number,
  opts: { lMin?: number; lMax?: number; shadowHue?: number; lightHue?: number } = {},
): number[] {
  const lMin = opts.lMin ?? 0.1;
  const lMax = opts.lMax ?? 0.92;
  const shadowHue = opts.shadowHue ?? baseHue - 0.06;
  const lightHue = opts.lightHue ?? baseHue + 0.05;
  const out: number[] = [];
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0.5 : i / (steps - 1);
    const l = lMin + (lMax - lMin) * t;
    const h =
      t < 0.5
        ? baseHue + (shadowHue - baseHue) * (1 - t * 2)
        : baseHue + (lightHue - baseHue) * ((t - 0.5) * 2);
    const s = baseSat * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.05)));
    out.push(hsl(h, Math.min(1, s), l));
  }
  return out;
}
