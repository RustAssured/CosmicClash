import type { RenderLayer } from '@/contracts';
import { TITAN_SKY } from '@/render/unified';

/**
 * The doomed worlds (TRAILER_V3 §0, World A and World B): the REAL Planet (its renderer, its matter, its damage; it cracks
 * exactly as in a fight) with two new palettes and a city-lights layer on the night side. A shot names it on a match slot
 * (`match.worlds: { "0": "A", "1": "B" }`); the Director passes that slot's layers through `worldLayers` every frame.
 *  - A, temperate: the Planet's oceans stay blue, its land turns ochre, its core stays a hot orange.
 *  - B, stranger: oceans teal, land violet, the core a cold violet.
 * The remap keeps every pixel's lightness and saturation and moves only its hue band, so the Planet's own shading, cracks,
 * scars and exposed mantle read the same. City lights: sparse warm points on the land of the night side (away from the one
 * titan sky light), emissive so they bloom, breathing slowly; they go out where the crust is gone (no land pixel, no light).
 */
export type WorldPalette = 'A' | 'B';

function rgb2hsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h, s, l];
}

function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** Which band a hue is in: ocean (blue), land (green … yellow-brown) or fire (core, lava, red-orange). */
const band = (h: number): 'ocean' | 'land' | 'fire' =>
  h >= 175 && h < 265 ? 'ocean' : h >= 32 && h < 175 ? 'land' : 'fire';

/** Map one packed colour into a palette (memoised per palette: the Planet uses a few hundred colours). */
const memo: Record<WorldPalette, Map<number, number>> = { A: new Map(), B: new Map() };
export function worldColor(c: number, pal: WorldPalette): number {
  const a = c >>> 24;
  if (!a) return c;
  const key = c & 0xffffff;
  const m = memo[pal];
  const hit = m.get(key);
  if (hit !== undefined) return ((a << 24) | hit) >>> 0;
  const [h, s, l] = rgb2hsl(c & 255, (c >>> 8) & 255, (c >>> 16) & 255);
  let nh = h;
  let ns = s;
  if (s >= 0.1) {
    const b = band(h);
    if (pal === 'A') {
      // temperate: ochre continents (greens and yellows pulled to one warm band), blue seas, hot core
      if (b === 'land') {
        nh = 32 + (h - 32) * 0.08;
        ns = Math.min(1, s * 0.95);
      }
    } else if (b === 'ocean') nh = 172 + (h - 175) * 0.15;
    else if (b === 'land') {
      nh = 278 + (h - 100) * 0.06;
      ns = Math.min(1, s * 1.05);
    } else nh = 262 + ((h + 30) % 360) * 0.05; // the core: a cold violet
  }
  const [r, g, bl] = hsl2rgb(((nh % 360) + 360) % 360, ns, l);
  const v = ((bl << 16) | (g << 8) | r) >>> 0;
  m.set(key, v);
  return ((a << 24) | v) >>> 0;
}

interface Twin {
  layer: RenderLayer;
  srcVersion: number;
  srcPixels: Uint32Array | null;
}
const twins = new Map<string, Twin>();
const LIGHT = { x: TITAN_SKY.dir[0], y: TITAN_SKY.dir[1] };
const hash = (x: number, y: number): number => {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/**
 * The world-palette twins of a Planet fighter's layers (re-coloured copies; the source layers are never touched). `t` is
 * the scene time (city lights breathe with it).
 */
export function worldLayers(
  src: readonly RenderLayer[],
  pal: WorldPalette,
  t: number,
  out: RenderLayer[],
  zBoost = 0,
): void {
  for (const l of src) {
    let tw = twins.get(`${pal}:${l.id}`);
    if (!tw || tw.layer.w !== l.w || tw.layer.h !== l.h) {
      tw = {
        layer: {
          ...l,
          id: `${l.id}:world${pal}`,
          pixels: new Uint32Array(l.pixels.length),
          emissive: new Uint8Array(l.pixels.length),
          version: 0,
        },
        srcVersion: -1,
        srcPixels: null,
      };
      twins.set(`${pal}:${l.id}`, tw);
    }
    const d = tw.layer;
    const prevVersion = d.version;
    // follow every placement field of the source (position, facing, parts, alpha …), keep our own pixels
    const pixels = d.pixels;
    const emissive = d.emissive!;
    Object.assign(d, l, { id: `${l.id}:world${pal}`, pixels, emissive, dirty: null });
    const s = l.pixels;
    const se = l.emissive;
    for (let i = 0; i < s.length; i++) {
      // near-invisible coverage (a few alpha steps) is dropped: on the film's black it lifts the halo pass into a box
      pixels[i] = s[i]! >>> 24 < 12 ? 0 : worldColor(s[i]!, pal);
      emissive[i] = se ? se[i]! : 0;
    }
    // city lights on the night side of the body (the fighter's body layer, titan-<slot>: a round body with land)
    if (/^titan-\d$/.test(l.id) && !l.parts) {
      const cx = l.w / 2;
      const cy = l.h / 2;
      const r = Math.min(l.w, l.h) / 2;
      for (let y = 0; y < l.h; y++)
        for (let x = 0; x < l.w; x++) {
          const i = y * l.w + x;
          const c = s[i]!;
          if (c >>> 24 !== 255) continue;
          const dx = (x - cx) / r;
          const dy = (y - cy) / r;
          // the terminator: the side away from the one sky light falls into night (stepped, so it dithers like pixel art)
          const facing = dx * LIGHT.x + dy * LIGHT.y;
          const night = Math.min(1, Math.max(0, (-facing - 0.02) / 0.45));
          if (night > 0) {
            const q = Math.round(night * 4) / 4;
            const kk = 1 - 0.62 * q;
            const p = pixels[i]!;
            const ch = (sh: number): number => Math.round(((p >>> sh) & 255) * kk) << sh;
            pixels[i] = (0xff000000 | ch(16) | ch(8) | ch(0)) >>> 0;
          }
          // city lights: the land of the night side, inside the disc
          if (dx * dx + dy * dy > 0.9 || facing > -0.12) continue;
          const [h, sat] = rgb2hsl(c & 255, (c >>> 8) & 255, (c >>> 16) & 255);
          if (sat < 0.1 || band(h) !== 'land') continue;
          const k = hash(x * 3 + (l.w << 8), y * 7);
          if (k > 0.16) continue;
          const breathe = 0.65 + 0.35 * Math.sin(t * 1.3 + k * 60);
          pixels[i] = pal === 'A' ? 0xff6fd8ff : 0xffe8f0a0; // A: sodium gold; B: a cold cyan-white
          emissive[i] = Math.round(170 + 85 * breathe);
        }
    }
    // a world drawn in front of the other fighter (a horizon the Witness rises behind)
    d.z = l.z + zBoost;
    d.version = prevVersion + 1;
    tw.srcVersion = l.version;
    tw.srcPixels = s;
    out.push(d);
  }
}
