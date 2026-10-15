import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { DEFAULT_LIGHTING, hex, type TitanId } from '../../src/contracts';
import { renderPortrait } from '../../src/titans/portrait';
import { ROSTER } from '../../src/titans/roster';
import { samplePortrait } from '../../src/ui/portrait';
import { BAYER4, type Sprite } from '../../src/ui/pixel/canvas';
import { CHROME, GOLD, titleType, type TypeStyle } from '../../src/ui/pixel/titleType';
import { PRESS } from './common';

/**
 * The ADEUK: TITANS logo (WJ's mockup, rebuilt from the game's own sprites): every titan whole, packed tight round the title
 * (the Last One crowning it, URI rising under it), orbit lines sweeping round, rock debris, and the title in cracked gold
 * over star-filled chrome. Everything sits on a transparent layer that is cropped to its own edges, so the logo is the shape
 * of its titans; a second copy puts it on a purple nebula. The compact cut is the title and the Last One alone.
 * → press/logo/adeuk-titans-logo-full[-nebula]-x1/x2/x3.png, adeuk-titans-logo-compact[-nebula]-x1/x2/x3.png
 *   npx tsx tools/press/banner.ts
 */
/** Working canvas, larger than any cut; each cut is cropped to its content. */
const W = 1000;
const H = 640;
/** The title's centre: the orbits circle it, the rim light comes from it. */
const TX = 500;
const TY = 330;
const OUT = hex('#05030f');

const rgb = (c: number): [number, number, number] => [c & 255, (c >>> 8) & 255, (c >>> 16) & 255];
const pack = (r: number, g: number, b: number, a = 255): number =>
  ((a << 24) | (Math.round(b) << 16) | (Math.round(g) << 8) | Math.round(r)) >>> 0;
const mix = (a: number, b: number, t: number): number => {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return pack(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
};
const bayer = (x: number, y: number): number => BAYER4[(y & 3) * 4 + (x & 3)]! / 16;
let seed = 1234;
const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;

// --- noise (the nebula, the rocks' lumpy outlines) ------------------------------------------------------------------
const LAT = 64;
const lattice = Float32Array.from({ length: LAT * LAT }, () => rnd());
const vnoise = (x: number, y: number): number => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const g = (i: number, j: number): number => lattice[(((j % LAT) + LAT) % LAT) * LAT + (((i % LAT) + LAT) % LAT)]!;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = g(xi, yi) + (g(xi + 1, yi) - g(xi, yi)) * sx;
  const b = g(xi, yi + 1) + (g(xi + 1, yi + 1) - g(xi, yi + 1)) * sx;
  return a + (b - a) * sy;
};
const fbm = (x: number, y: number): number => {
  let v = 0;
  let amp = 0.5;
  let f = 1 / 90;
  for (let o = 0; o < 5; o++) {
    v += vnoise(x * f, y * f) * amp;
    amp *= 0.5;
    f *= 2.1;
  }
  return v;
};

// --- the transparent layer ------------------------------------------------------------------------------------------
class Layer {
  readonly px = new Uint32Array(W * H);
  put(x: number, y: number, c: number): void {
    if (x >= 0 && y >= 0 && x < W && y < H) this.px[y * W + x] = c;
  }
  get(x: number, y: number): number {
    return x >= 0 && y >= 0 && x < W && y < H ? this.px[y * W + x]! : 0;
  }
  blit(s: Sprite, x0: number, y0: number): void {
    for (let y = 0; y < s.h; y++)
      for (let x = 0; x < s.w; x++) {
        const c = s.pixels[y * s.w + x]!;
        if (c >>> 24) this.put(x0 + x, y0 + y, c);
      }
  }
}

const sparkle = (L: Layer, x: number, y: number, arm: number, core: number, ray: number): void => {
  for (let i = 1; i <= arm; i++) {
    const c = i === arm ? mix(ray, OUT, 0.35) : ray;
    L.put(x + i, y, c);
    L.put(x - i, y, c);
    L.put(x, y + i, c);
    L.put(x, y - i, c);
  }
  L.put(x, y, core);
};

// --- orbits: tilted ellipses round the title; the far half behind the titans, the near half over them ----------------
interface Orbit {
  rx: number;
  ry: number;
  tilt: number;
  c: number;
}
const orbitAt = (o: Orbit, t: number): [number, number] => {
  const ex = Math.cos(t) * o.rx;
  const ey = Math.sin(t) * o.ry;
  return [
    Math.round(TX + ex * Math.cos(o.tilt) - ey * Math.sin(o.tilt)),
    Math.round(TY + ex * Math.sin(o.tilt) + ey * Math.cos(o.tilt)),
  ];
};
const orbit = (L: Layer, o: Orbit, near: boolean): void => {
  for (let i = 0; i < 4000; i++) {
    const t = (i / 4000) * Math.PI * 2;
    if (Math.sin(t) > 0 !== near) continue;
    const [x, y] = orbitAt(o, t);
    L.put(x, y, near ? mix(o.c, hex('#ffe0a0'), 0.4) : mix(o.c, hex('#2a1040'), 0.35));
  }
  if (!near) return;
  for (const t of [0.3, 1.15, 2.2, 2.75]) {
    const [x, y] = orbitAt(o, t);
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const d = dx * dx + dy * dy;
        if (d > 5) continue;
        L.put(x + dx, y + dy, d > 2 ? hex('#3a1808') : dx + dy < 0 ? hex('#fff0b0') : hex('#e89838'));
      }
  }
};

// --- titans ---------------------------------------------------------------------------------------------------------
const RIM = hex('#ffb878');
const shown = new Set(ROSTER.filter((r) => !r.wip).map((r) => r.id));
const fit = (id: TitanId, box: number): Sprite => {
  const p = renderPortrait(id, 1, DEFAULT_LIGHTING);
  // never upscale: a titan is at most its own pixel size
  const k = Math.min(1, box / p.w, box / p.h);
  return samplePortrait(p, Math.round(p.w * k) + 2, Math.round(p.h * k) + 2, { outline: OUT, margin: 1 });
};
/** Rim light from the title: an edge pixel facing it catches a warm glow, so dark bodies read on dark space. */
const rimLit = (s: Sprite, ox: number, oy: number): Sprite => {
  const out = s.pixels.slice();
  const solid = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < s.w && y < s.h && s.pixels[y * s.w + x]! >>> 24 !== 0 && s.pixels[y * s.w + x] !== OUT;
  for (let y = 0; y < s.h; y++)
    for (let x = 0; x < s.w; x++) {
      if (!solid(x, y)) continue;
      const dx = TX - (ox + x);
      const dy = TY - (oy + y);
      const n = Math.hypot(dx, dy) || 1;
      if (solid(x + Math.round(dx / n), y + Math.round(dy / n))) continue;
      out[y * s.w + x] = mix(s.pixels[y * s.w + x]!, RIM, 0.5);
    }
  return { pixels: out, w: s.w, h: s.h };
};
/** Place a titan by its centre, offset from the title's centre, inside a box of `box` px. */
const titan = (L: Layer, id: TitanId, dx: number, dy: number, box: number): void => {
  if (!shown.has(id)) return;
  const s = fit(id, box);
  const x0 = Math.round(TX + dx - s.w / 2);
  const y0 = Math.round(TY + dy - s.h / 2);
  L.blit(rimLit(s, x0, y0), x0, y0);
};

// --- the title: cracked gold over star-filled chrome, with a dark halo so it sits on top of everything ----------------
const CRACKED_GOLD: TypeStyle = { ...GOLD, cracks: { n: 26, dark: hex('#7a2a0c'), light: hex('#fff2b0') } };
const STARRY_CHROME: TypeStyle = { ...CHROME, cracks: { n: 14, dark: hex('#1a1060'), light: hex('#e8f8ff') }, stars: 90 };
const adeuk = titleType('ADEUK', CRACKED_GOLD, 3);
const titans = titleType('TITANS', STARRY_CHROME, 3);
const title = (L: Layer): void => {
  const ay = TY - Math.round((adeuk.h + titans.h - 6) / 2);
  const placed: [Sprite, number, number][] = [
    [adeuk, TX - (adeuk.w >> 1), ay],
    [titans, TX - (titans.w >> 1), ay + adeuk.h - 6],
  ];
  const mask = new Uint8Array(W * H);
  for (const [s, x0, y0] of placed)
    for (let y = 0; y < s.h; y++)
      for (let x = 0; x < s.w; x++) if (s.pixels[y * s.w + x]! >>> 24) mask[(y0 + y) * W + x0 + x] = 1;
  // the halo darkens what is under it, or on transparency becomes a see-through shadow
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) continue;
      let near = 99;
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H && mask[yy * W + xx]) near = Math.min(near, Math.hypot(dx, dy));
        }
      if (near >= 4) continue;
      const t = near < 2.5 ? 0.75 : 0.45;
      const under = L.get(x, y);
      if (under >>> 24) L.put(x, y, mix(under, OUT, t));
      else {
        const [r, g, b] = rgb(OUT);
        L.put(x, y, pack(r, g, b, Math.round(t * 255)));
      }
    }
  for (const [s, x0, y0] of placed) L.blit(s, x0, y0);
};

// --- debris: little shaded rocks drifting round the cluster, never over the title -----------------------------------
const ROCK = ['#1a1418', '#3a3036', '#6a5a5a', '#9a8a80'].map(hex);
const debris = (L: Layer, n: number, rx: number, ry: number): void => {
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const d = 0.55 + rnd() * 0.45;
    const x = Math.round(TX + Math.cos(a) * rx * d);
    const y = Math.round(TY + Math.sin(a) * ry * d);
    if (Math.abs(x - TX) < 220 && Math.abs(y - TY) < 85) continue;
    const r = 1 + rnd() * 3.2;
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const dd = Math.hypot(dx * 1.2, dy) + (vnoise(x + dx * 0.9, y + dy * 0.9) - 0.5) * 1.6;
        if (dd > r) continue;
        const lit = (-dx - dy) / (r * 2) + 0.5;
        L.put(x + dx, y + dy, dd > r - 1 ? ROCK[0]! : lit > 0.75 ? ROCK[3]! : lit > 0.4 ? ROCK[2]! : ROCK[1]!);
      }
  }
};

// --- the cuts -------------------------------------------------------------------------------------------------------
const ORBITS: Orbit[] = [
  { rx: 300, ry: 58, tilt: -0.1, c: hex('#e8a040') },
  { rx: 240, ry: 86, tilt: 0.12, c: hex('#d88a38') },
];

function full(): Layer {
  const L = new Layer();
  for (const o of ORBITS) orbit(L, o, false);
  // back row: the Last One crowning the title, the Witness and the Asteroid tucked in at its sides, URI under the title
  titan(L, 'lastone', -150, -104, 150);
  titan(L, 'asteroid', 152, -98, 140);
  titan(L, 'colossus', 0, -126, 210);
  titan(L, 'uri', 14, 112, 220);
  // flanks: the Planet against the T, the Supernova by the Asteroid
  titan(L, 'planet', -238, -6, 140);
  titan(L, 'supernova', 262, -36, 156);
  // front row
  titan(L, 'blackhole', -222, 70, 176);
  titan(L, 'cradle', 236, 74, 160);
  titan(L, 'nexus', -122, 96, 108);
  debris(L, 60, 360, 220);
  for (const o of ORBITS) orbit(L, o, true);
  title(L);
  sparkle(L, TX - 8, TY + 26, 6, hex('#ffffff'), hex('#ffd070'));
  sparkle(L, TX - 175, TY - 36, 4, hex('#ffffff'), hex('#ffd070'));
  sparkle(L, TX + 182, TY + 40, 4, hex('#ffffff'), hex('#ffd070'));
  return L;
}

function compact(): Layer {
  const L = new Layer();
  titan(L, 'colossus', 0, -126, 240);
  title(L);
  sparkle(L, TX - 8, TY + 26, 6, hex('#ffffff'), hex('#ffd070'));
  return L;
}

// --- out --------------------------------------------------------------------------------------------------------------
const PURPLE = ['#05040e', '#0e0a22', '#1c1040', '#33165c', '#52207a', '#7a2c96', '#b048b0', '#e07ad0'].map(hex);
const BLUE = ['#05040e', '#0a0c24', '#121c48', '#1c3070', '#2c4c9c', '#4a72c8', '#7aa6e8', '#bcd8ff'].map(hex);
/** The nebula for a w×h rectangle whose title centre is at (cx, cy): purple in the middle, blue at the left, stars. */
function nebula(w: number, h: number, cx: number, cy: number): Uint32Array {
  const out = new Uint32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const n = fbm(x, y);
      const dc = Math.hypot((x - cx) / (w * 0.45), (y - cy + h * 0.2) / (h * 0.75));
      const v = Math.max(0, Math.min(0.999, (n - 0.32) * 1.9 + (0.55 - dc) * 0.7));
      const blue = Math.max(0, Math.min(1, (w * 0.32 - x) / (w * 0.28) + (0.45 - n) * 0.8));
      const ramp = bayer(x + 2, y + 1) < blue ? BLUE : PURPLE;
      const f = v * (ramp.length - 1);
      const k = Math.floor(f);
      out[y * w + x] = f - k > bayer(x, y) ? ramp[Math.min(ramp.length - 1, k + 1)]! : ramp[k]!;
    }
  for (let i = 0; i < (w * h) / 400; i++) {
    const r = rnd();
    out[Math.floor(rnd() * h) * w + Math.floor(rnd() * w)] =
      r < 0.25 ? hex('#ffffff') : r < 0.6 ? hex('#c8d4ff') : hex('#f0b8e8');
  }
  return out;
}

function write(name: string, L: Layer, margin: number): void {
  let x0 = W;
  let y0 = H;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (L.px[y * W + x]! >>> 24) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  if (x0 === 0 || y0 === 0 || x1 === W - 1 || y1 === H - 1) throw new Error(`${name}: content touches the working canvas`);
  x0 -= margin;
  y0 -= margin;
  const cw = x1 - x0 + 1 + margin;
  const ch = y1 - y0 + 1 + margin;
  const bg = nebula(cw, ch, TX - x0, TY - y0);
  for (const plate of [false, true])
    for (const k of [1, 2, 3]) {
      const png = new PNG({ width: cw * k, height: ch * k });
      for (let y = 0; y < ch * k; y++)
        for (let x = 0; x < cw * k; x++) {
          const sx = Math.floor(x / k);
          const sy = Math.floor(y / k);
          const c = L.get(x0 + sx, y0 + sy);
          const a = (c >>> 24) / 255;
          let r: number;
          let g: number;
          let b: number;
          let al = c >>> 24;
          if (plate) {
            const [br, bgr, bb] = rgb(bg[sy * cw + sx]!);
            const [cr, cg, cb] = rgb(c);
            r = cr * a + br * (1 - a);
            g = cg * a + bgr * (1 - a);
            b = cb * a + bb * (1 - a);
            al = 255;
          } else [r, g, b] = rgb(c);
          const o = (y * cw * k + x) * 4;
          png.data[o] = Math.round(r);
          png.data[o + 1] = Math.round(g);
          png.data[o + 2] = Math.round(b);
          png.data[o + 3] = al;
        }
      const path = `${PRESS}/logo/adeuk-titans-logo-${name}${plate ? '-nebula' : ''}-x${k}.png`;
      writeFileSync(path, PNG.sync.write(png));
      console.log(`${path}: ${cw * k}×${ch * k}`);
    }
}

mkdirSync(`${PRESS}/logo`, { recursive: true });
write('full', full(), 0);
write('compact', compact(), 0);
