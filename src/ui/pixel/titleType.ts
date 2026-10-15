import { hex } from '@/contracts';
import { BAYER4, type Sprite } from './canvas';
import { logotypeMask } from './logo';

/**
 * The emblem's title type: the logotype's letters (logo.ts) doubled before shading, so the geometry is chunky but every
 * outline, bevel and dither pixel stays one pixel. Each word gets its own metal: a molten-gold ramp, or an 80s chrome with
 * a sky above a hard horizon and a magenta ground reflected below it. A block extrusion falls straight down behind the face.
 */
export interface TypeStyle {
  /** Face fill top→bottom (above the horizon when there is one). */
  ramp: number[];
  /** Chrome: the horizon's height (0..1 of the cap), the ramp below it, and the two horizon lines (light over dark). */
  horizon?: { at: number; low: number[]; light: number; dark: number };
  /** Lit top edge. */
  rim: number;
  /** Extrusion colours, nearest the face first; its length is the depth in px. */
  extrude: number[];
  outline: number;
  /** Stone cracks across the face: how many, the crack colour and the lit lip beside it. */
  cracks?: { n: number; dark: number; light: number };
  /** Stars inside the face (a galaxy seen through the metal): how many. */
  stars?: number;
}

export const GOLD: TypeStyle = {
  ramp: ['#fffbe0', '#ffe680', '#ffc838', '#ff9a1c', '#e8641a', '#b8380e'].map(hex),
  rim: hex('#ffffff'),
  extrude: ['#7a1c0a', '#7a1c0a', '#5a1208', '#5a1208', '#3c0a06', '#3c0a06'].map(hex),
  outline: hex('#140404'),
};

export const CHROME: TypeStyle = {
  ramp: ['#f2fdff', '#b8ecff', '#6cc4ff', '#3a86e8', '#2050b8'].map(hex),
  horizon: {
    at: 0.54,
    low: ['#3a1868', '#7a2c9c', '#c850b8', '#f08ad0', '#ffd4ee'].map(hex),
    light: hex('#ffffff'),
    dark: hex('#160c3a'),
  },
  rim: hex('#ffffff'),
  extrude: ['#2a1a6a', '#2a1a6a', '#1e1250', '#1e1250', '#140a38', '#140a38'].map(hex),
  outline: hex('#05030f'),
};

function rampAt(ramp: number[], t: number, x: number, y: number): number {
  const f = Math.min(1, Math.max(0, t)) * (ramp.length - 1);
  const k = Math.min(ramp.length - 2, Math.floor(f));
  return (f - k) * 16 > BAYER4[(y & 3) * 4 + (x & 3)]! ? ramp[k + 1]! : ramp[k]!;
}

/** `text` in `style`, letters ×k (k=2 by default) with `gap` px between them before scaling, on transparency. */
export function titleType(text: string, style: TypeStyle, k = 2, gap = 4): Sprite {
  const m = logotypeMask(text, gap);
  const D = style.extrude.length;
  const pad = 2;
  const SW = m.w * k + pad * 2;
  const SH = m.h * k + D + pad * 2;
  const solid = new Uint8Array(SW * SH);
  for (let y = 0; y < m.h * k; y++)
    for (let x = 0; x < m.w * k; x++)
      if (m.d[Math.floor(y / k) * m.w + Math.floor(x / k)]) solid[(y + pad) * SW + x + pad] = 1;
  const at = (x: number, y: number): number =>
    x >= 0 && y >= 0 && x < SW && y < SH ? solid[y * SW + x]! : 0;
  const px = new Uint32Array(SW * SH);
  const body = new Uint8Array(SW * SH);
  // the extrusion: the face's mask pushed straight down, nearest layer wins
  for (let y = 0; y < SH; y++)
    for (let x = 0; x < SW; x++) {
      if (at(x, y)) {
        body[y * SW + x] = 1;
        continue;
      }
      for (let d = 1; d <= D; d++)
        if (at(x, y - d)) {
          px[y * SW + x] = style.extrude[d - 1]!;
          body[y * SW + x] = 1;
          break;
        }
    }
  // a 1px outline around face + extrusion
  const inBody = (x: number, y: number): number =>
    x >= 0 && y >= 0 && x < SW && y < SH ? body[y * SW + x]! : 0;
  for (let y = 0; y < SH; y++)
    for (let x = 0; x < SW; x++)
      if (!inBody(x, y) && (inBody(x - 1, y) || inBody(x + 1, y) || inBody(x, y - 1) || inBody(x, y + 1)))
        px[y * SW + x] = style.outline;
  // the face: ramp (or sky / horizon / ground), a lit rim on top, and an outline seam along the bottom so each letter
  // stays separate from its own block
  const capH = m.h * k;
  const hz = style.horizon;
  const hy = hz ? Math.round(hz.at * capH) : -1;
  for (let y = 0; y < SH; y++)
    for (let x = 0; x < SW; x++) {
      if (!at(x, y)) continue;
      const ly = y - pad;
      let c: number;
      if (!hz) c = rampAt(style.ramp, ly / (capH - 1), x, y);
      else if (ly < hy) c = rampAt(style.ramp, ly / (hy - 1), x, y);
      else if (ly === hy) c = hz.dark;
      else if (ly === hy + 1) c = hz.light;
      else c = rampAt(hz.low, (ly - hy - 2) / (capH - hy - 3), x, y);
      if (!at(x, y - 1)) c = style.rim;
      else if (!at(x, y + 1)) c = style.outline;
      else if (!at(x - 1, y) && ly !== hy) c = hz && ly > hy ? hz.low[hz.low.length - 1]! : style.ramp[0]!;
      px[y * SW + x] = c;
    }
  // the interior (face pixels at least 2px from any edge) is where cracks and stars may go
  const inner = (x: number, y: number): boolean =>
    at(x, y) === 1 && at(x - 2, y) === 1 && at(x + 2, y) === 1 && at(x, y - 2) === 1 && at(x, y + 2) === 1;
  let seed = text.length * 7919 + SW;
  const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const interior: number[] = [];
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) if (inner(x, y)) interior.push(y * SW + x);
  if (style.cracks && interior.length) {
    const { n, dark, light } = style.cracks;
    const crack = (x: number, y: number, len: number, dx: number): void => {
      for (let i = 0; i < len && inner(x, y); i++) {
        px[y * SW + x] = dark;
        if (inner(x + 1, y) && px[y * SW + x + 1] !== dark) px[y * SW + x + 1] = light;
        // wander mostly down, drifting sideways
        if (rnd() < 0.55) x += dx;
        y += rnd() < 0.8 ? 1 : 0;
        if (rnd() < 0.12) crack(x, y, len - i - 2, -dx);
      }
    };
    for (let i = 0; i < n; i++) {
      const p = interior[Math.floor(rnd() * interior.length)]!;
      crack(p % SW, Math.floor(p / SW), 5 + Math.floor(rnd() * 10), rnd() < 0.5 ? -1 : 1);
    }
  }
  if (style.stars && interior.length) {
    const white = hex('#ffffff');
    const faint = hex('#d8e8ff');
    for (let i = 0; i < style.stars; i++) {
      const p = interior[Math.floor(rnd() * interior.length)]!;
      px[p] = rnd() < 0.3 ? white : faint;
      // a few bright ones get a plus
      if (rnd() < 0.15) {
        const x = p % SW;
        const y = Math.floor(p / SW);
        for (const [ax, ay] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const)
          if (inner(x + ax, y + ay)) px[(y + ay) * SW + x + ax] = faint;
        px[p] = white;
      }
    }
  }
  return { pixels: px, w: SW, h: SH };
}
