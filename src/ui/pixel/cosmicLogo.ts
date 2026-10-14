import { hex } from '@/contracts';
import { BAYER4, PixelCanvas, type Sprite } from './canvas';
import { C, alpha, mixRgb } from './palette';
import { drawText, measureText } from './text';

/**
 * The COSMIC CLASH / 우주 대결 wordmark: the tournament's living mode. Built like the ADEUK: TITANS logotype (src/ui/pixel/
 * logo.ts): letters from strokes on an 21-row grid (stroke 5), convex corners softened, a dark outline and a drop shadow, so
 * it stays crisp at every integer scale. Unlike the logotype it is ALIVE: `t` (seconds) moves something in every direction.
 *
 * Three directions (WJ steers; `COSMIC_STYLE` is the one the game and the site use):
 *  - 'deepfield': the letters are windows into deep space: a starfield drifting through them behind a bright celadon-to-gold
 *    rim; CLASH carries a fracture and sheds pixel debris off its last letter (matter breaking, like the fights).
 *  - 'nebula': a violet-magenta nebula churning inside the letters, stars twinkling in it, a soft violet halo.
 *  - 'orbit': COSMIC in cold metal, CLASH in hot metal (the two sides of a clash), a ring orbiting the whole word with a
 *    small moon running along it, passing behind the letters and in front of them.
 */
export type CosmicStyle = 'deepfield' | 'nebula' | 'orbit';
export const COSMIC_STYLES: readonly CosmicStyle[] = ['deepfield', 'nebula', 'orbit'];
/** The direction in use (game mode select, site banner, press logo). */
export const COSMIC_STYLE: CosmicStyle = 'nebula';

/** The nebula direction's motion repeats every NEBULA_PERIOD seconds (a seamless loop for the site's sprite sheet). */
export const NEBULA_PERIOD = 8;
const W8 = (Math.PI * 2) / NEBULA_PERIOD;

const H = 21;
const S = 5;
const SD = 6;
const W = 17;
const GAP = 3;
const SPACE = 10;

class Glyph {
  readonly d: Uint8Array;
  constructor(readonly w: number) {
    this.d = new Uint8Array(w * H);
  }
  get(x: number, y: number): number {
    return x >= 0 && y >= 0 && x < this.w && y < H ? this.d[y * this.w + x]! : 0;
  }
  set(x: number, y: number, v: number): void {
    if (x >= 0 && y >= 0 && x < this.w && y < H) this.d[y * this.w + x] = v;
  }
  rect(x0: number, y0: number, x1: number, y1: number): void {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, 1);
  }
  hole(x0: number, y0: number, x1: number, y1: number): void {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, 0);
  }
  diag(xTop: number, yTop: number, xBot: number, yBot: number, s = SD): void {
    for (let y = yTop; y <= yBot; y++) {
      const t = yBot === yTop ? 0 : (y - yTop) / (yBot - yTop);
      const x = Math.round(xTop + (xBot - xTop) * t);
      for (let i = 0; i < s; i++) this.set(x + i, y, 1);
    }
  }
  cut(corner: 'tl' | 'tr' | 'bl' | 'br', n: number): void {
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n - j; i++) {
        const x = corner === 'tl' || corner === 'bl' ? i : this.w - 1 - i;
        const y = corner === 'tl' || corner === 'tr' ? j : H - 1 - j;
        this.set(x, y, 0);
      }
  }
  soften(): void {
    const kill: number[] = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < this.w; x++) {
        if (!this.get(x, y)) continue;
        const up = this.get(x, y - 1);
        const dn = this.get(x, y + 1);
        const lf = this.get(x - 1, y);
        const rt = this.get(x + 1, y);
        if ((!up && !lf) || (!up && !rt) || (!dn && !lf) || (!dn && !rt)) kill.push(y * this.w + x);
      }
    for (const i of kill) this.d[i] = 0;
  }
}

function glyph(ch: string): Glyph {
  const mid = (H - S) / 2; // 8: top bar 0–4, middle 8–12, bottom 16–20
  const c = S + 1;
  switch (ch) {
    case 'C': {
      const m = new Glyph(W);
      m.rect(0, 0, W - 1, H - 1);
      m.hole(S, S, W - 1, H - S - 1);
      m.cut('tl', c);
      m.cut('bl', c);
      return m;
    }
    case 'O': {
      const m = new Glyph(W);
      m.rect(0, 0, W - 1, H - 1);
      m.hole(S, S, W - S - 1, H - S - 1);
      for (const k of ['tl', 'tr', 'bl', 'br'] as const) m.cut(k, c);
      return m;
    }
    case 'S': {
      const m = new Glyph(W);
      m.rect(0, 0, W - 1, S - 1);
      m.rect(0, 0, S - 1, mid + S - 1);
      m.rect(0, mid, W - 1, mid + S - 1);
      m.rect(W - S, mid, W - 1, H - 1);
      m.rect(0, H - S, W - 1, H - 1);
      m.cut('tr', c);
      m.cut('bl', c);
      return m;
    }
    case 'M': {
      const m = new Glyph(W + 4);
      m.rect(0, 0, S - 1, H - 1);
      m.rect(m.w - S, 0, m.w - 1, H - 1);
      const cx = Math.floor((m.w - SD) / 2);
      m.diag(S - 2, 0, cx, 13);
      m.diag(m.w - SD - S + 2, 0, cx, 13);
      return m;
    }
    case 'I': {
      const m = new Glyph(S + 4);
      m.rect(0, 0, m.w - 1, S - 1);
      m.rect(0, H - S, m.w - 1, H - 1);
      m.rect(2, 0, 2 + S - 1, H - 1);
      return m;
    }
    case 'L': {
      const m = new Glyph(W - 2);
      m.rect(0, 0, S - 1, H - 1);
      m.rect(0, H - S, m.w - 1, H - 1);
      return m;
    }
    case 'A': {
      const m = new Glyph(W + 2);
      const ap = S + 3;
      const xl = Math.floor((m.w - ap) / 2);
      m.diag(xl, 0, 0, H - 1);
      m.diag(xl + ap - SD, 0, m.w - SD, H - 1);
      m.rect(xl, 0, xl + ap - 1, S - 1);
      m.rect(3, H - 9, m.w - 4, H - 9 + S - 1);
      return m;
    }
    case 'H': {
      const m = new Glyph(W);
      m.rect(0, 0, S - 1, H - 1);
      m.rect(W - S, 0, W - 1, H - 1);
      m.rect(0, mid, W - 1, mid + S - 1);
      return m;
    }
    default:
      return new Glyph(SPACE - GAP);
  }
}

/** The bare letter mask of "COSMIC CLASH" (1 = letter), and where CLASH starts (x). */
interface WordMask {
  w: number;
  h: number;
  d: Uint8Array;
  clashX: number;
}

let maskCache: WordMask | null = null;
function wordMask(): WordMask {
  if (maskCache) return maskCache;
  const text = 'COSMIC CLASH';
  const gs = Array.from(text, (ch) => {
    const g = glyph(ch);
    if (ch !== ' ') g.soften();
    return g;
  });
  const w = gs.reduce((s, g) => s + g.w, 0) + GAP * (gs.length - 1);
  const d = new Uint8Array(w * H);
  let x = 0;
  let clashX = 0;
  gs.forEach((g, i) => {
    if (i === 7) clashX = x;
    for (let y = 0; y < H; y++) for (let k = 0; k < g.w; k++) if (g.d[y * g.w + k]) d[y * w + x + k] = 1;
    x += g.w + GAP;
  });
  maskCache = { w, h: H, d, clashX };
  return maskCache;
}

/* ---------------------------------------------------------------------------------------------- */
const h32 = (n: number): number => {
  let v = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  v ^= v >>> 13;
  v = Math.imul(v, 0xc2b2ae35);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
};
const hash2 = (x: number, y: number): number => h32(Math.imul(x, 73856093) ^ Math.imul(y, 19349663));
/** Smooth value noise, 0..1. */
function noise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
/** Pick from a ramp at `v` (0..1) with ordered dither between steps. */
function rampAt(ramp: readonly number[], v: number, x: number, y: number): number {
  const f = Math.min(1, Math.max(0, v)) * (ramp.length - 1);
  const k = Math.min(ramp.length - 2, Math.floor(f));
  return (f - k) * 16 > BAYER4[(y & 3) * 4 + (x & 3)]! ? ramp[k + 1]! : ramp[k]!;
}

const OUTLINE = hex('#05060f');
const RIM = [hex('#fff4d6'), hex('#ecc98a'), hex('#a8bdb2'), hex('#5d7a70'), hex('#2c4451')];
const SPACE_RAMP = [hex('#0c1236'), hex('#1a2158'), hex('#2c2a78'), hex('#4a2f8a')];
const NEBULA = [
  hex('#1c0a3c'),
  hex('#3d1670'),
  hex('#6a26a0'),
  hex('#a93cb8'),
  hex('#e2649e'),
  hex('#ffb0c8'),
  hex('#fff2f6'),
];
/** The celadon veins in the nebula: the logotype's master celadon ramp (the Last One's #a8bdb2 family). */
const VEIN = [hex('#f4fbf7'), hex('#d6e8de'), hex('#a8bdb2'), hex('#7c9c94')];
const COLD = [hex('#f2fbff'), hex('#bfe6ff'), hex('#82b4ff'), hex('#5a6fe0'), hex('#3a3896'), hex('#1e1a4e')];
const HOT = [hex('#fff6d8'), hex('#ffd27a'), hex('#ff9a3c'), hex('#e0503a'), hex('#9a2340'), hex('#4a1030')];

export interface CosmicWordmark extends Sprite {
  /** Where the letters start inside the sprite (the padding around them holds the outline, halo, ring and debris). */
  ox: number;
  oy: number;
}

/** Padding per style: [x, y]. */
const PAD: Record<CosmicStyle, [number, number]> = { deepfield: [4, 4], nebula: [4, 4], orbit: [10, 9] };
/** The deepfield debris runs off the right end: extra room there. */
const TAIL: Record<CosmicStyle, number> = { deepfield: 16, nebula: 0, orbit: 0 };

/** Sprite size of a style's wordmark at scale 1 (constant over time, so layouts can reserve it). */
export function cosmicWordmarkSize(style: CosmicStyle = COSMIC_STYLE): { w: number; h: number } {
  const m = wordMask();
  const [px, py] = PAD[style];
  return { w: m.w + px * 2 + 2 + TAIL[style], h: m.h + py * 2 + 2 };
}

/**
 * The wordmark at time `t` (seconds) as a sprite: transparent around it, the letters' top-left at (ox, oy). Deterministic in
 * (style, t); a fresh sprite per call (cheap: ~10k pixels).
 */
export function cosmicWordmark(style: CosmicStyle = COSMIC_STYLE, t = 0): CosmicWordmark {
  const m = wordMask();
  const [padX, padY] = PAD[style];
  const { w: SW, h: SH } = cosmicWordmarkSize(style);
  const ox = padX;
  const oy = padY;
  const cv = new PixelCanvas(SW, SH);
  const px = cv.pixels;
  const solid = (x: number, y: number): number => {
    const lx = x - ox;
    const ly = y - oy;
    return lx >= 0 && ly >= 0 && lx < m.w && ly < m.h ? m.d[ly * m.w + lx]! : 0;
  };
  const near = (x: number, y: number, r: number): boolean => {
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (solid(x + i, y + j)) return true;
    return false;
  };

  // the orbit's back half goes behind everything
  if (style === 'orbit') ring(cv, m, ox, oy, t, 'back');
  // halo (nebula), drop shadow, outline
  for (let y = 0; y < SH; y++)
    for (let x = 0; x < SW; x++) {
      if (solid(x, y)) continue;
      if (style === 'nebula' && near(x, y, 2)) {
        const pulse = 0.5 + 0.5 * Math.sin(2 * W8 * t + x * 0.05);
        if (BAYER4[(y & 3) * 4 + (x & 3)]! < 6 + pulse * 4) px[y * SW + x] = alpha(hex('#5a1f8a'), 0.55);
      }
      if (solid(x - 2, y - 2)) px[y * SW + x] = alpha(C.void, 0.6);
      if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) px[y * SW + x] = OUTLINE;
    }

  // the letters
  for (let y = 0; y < SH; y++)
    for (let x = 0; x < SW; x++) {
      if (!solid(x, y)) continue;
      const lx = x - ox;
      const ly = y - oy;
      const top = !solid(x, y - 1);
      const left = !solid(x - 1, y);
      const bot = !solid(x, y + 1);
      const right = !solid(x + 1, y);
      let c: number;
      if (style === 'deepfield') {
        if (top) c = RIM[0]!;
        else if (left) c = RIM[1]!;
        else if (bot) c = RIM[4]!;
        else if (right) c = RIM[3]!;
        else {
          // space through the window: a drifting starfield over a faint wisp
          c = rampAt(SPACE_RAMP, (ly / (H - 1)) * 0.55 + noise(lx * 0.08 + t * 0.12, ly * 0.2) * 0.5, x, y);
          const sx = lx + Math.floor(t * 7);
          const s = hash2(sx, ly);
          if (s < 0.06) {
            const tw = 0.5 + 0.5 * Math.sin(t * 3 + h32(sx * 31 + ly) * 40);
            c = s < 0.015 ? C.white : tw > 0.55 ? hex('#cfe0ff') : hex('#6a78b8');
          }
        }
      } else if (style === 'nebula') {
        if (top) c = NEBULA[6]!;
        else if (bot) c = NEBULA[0]!;
        else {
          // the nebula churns round a slow circle: periodic in NEBULA_PERIOD, so the site's sprite sheet loops seamlessly
          const n = noise(lx * 0.07 + 3 * Math.sin(W8 * t), ly * 0.16 + 1.5 * Math.cos(W8 * t));
          let v = (1 - ly / (H - 1)) * 0.5 + n * 0.55;
          if (left) v += 0.2;
          if (right) v -= 0.15;
          c = rampAt(NEBULA, v, x, y);
          // celadon veins (WJ): thin threads along a contour of a second noise field, only where a coarse mask lets them
          // through, drifting round their own slow circle; a light runs along them. All periodic in NEBULA_PERIOD.
          const vn = noise(lx * 0.08 + 2.2 * Math.cos(W8 * t), ly * 0.14 + 1.2 * Math.sin(W8 * t) + 7.3);
          const gate = noise(lx * 0.03 - 1.5 * Math.sin(W8 * t) + 11, ly * 0.05 + 3);
          const d = Math.abs(vn - 0.5);
          if (gate > 0.42 && d < 0.04) {
            const run = Math.sin(lx * 0.23 - 2 * W8 * t);
            c = run > 0.8 ? VEIN[0]! : d < 0.018 ? VEIN[1]! : VEIN[2]!;
          } else if (gate > 0.48 && d < 0.07 && BAYER4[(y & 3) * 4 + (x & 3)]! < 5) c = VEIN[3]!;
          const s = hash2(lx, ly);
          if (s < 0.03) {
            const tw = Math.sin(3 * W8 * t + h32(lx * 17 + ly) * 50);
            if (tw > 0.2) c = tw > 0.75 ? C.white : NEBULA[5]!;
          }
        }
      } else {
        const ramp = lx >= m.clashX ? HOT : COLD;
        if (top) c = ramp[0]!;
        else if (left) c = ramp[1]!;
        else if (bot) c = ramp[5]!;
        else if (right) c = ramp[4]!;
        else if (!solid(x, y - 2)) c = ramp[1]!;
        else if (!solid(x, y + 2)) c = ramp[4]!;
        else c = rampAt(ramp, 0.15 + (ly / (H - 1)) * 0.7, x, y);
        // the logotype's glint, once every 6 s
        const ph = (t % 6) / 1.8;
        if (ph < 1) {
          const d = lx + ly - (ph * (m.w + H + 24) - 12);
          if (d > -2 && d < 2) c = mixRgb(c, C.white, 0.55);
        }
      }
      px[y * SW + x] = c;
    }

  if (style === 'deepfield') fracture(cv, m, ox, oy, t);
  if (style === 'orbit') ring(cv, m, ox, oy, t, 'front');
  return { pixels: px, w: SW, h: SH, ox, oy };
}

/** Deepfield: a crack through CLASH and debris drifting off its end, looping every 4 s. */
function fracture(cv: PixelCanvas, m: WordMask, ox: number, oy: number, t: number): void {
  const x0 = ox + m.clashX + 8;
  const x1 = ox + m.w - 6;
  const crack = alpha(OUTLINE, 1);
  // a jagged diagonal: steps down one row every few px
  for (let x = x0; x <= x1; x++) {
    const k = (x - x0) / (x1 - x0);
    const y = oy + 3 + Math.round(k * (H - 7)) + (hash2(x, 7) < 0.3 ? 1 : 0);
    const lx = x - ox;
    const ly = y - oy;
    if (m.d[ly * m.w + lx]) cv.put(x, y, crack);
    if (m.d[(ly - 1) * m.w + lx] && hash2(x, 3) < 0.5) cv.put(x, y - 1, RIM[0]!);
  }
  // debris: chunks leave the H's right side and drift out, fading
  const startX = ox + m.w;
  for (let i = 0; i < 9; i++) {
    const life = (t / 4 + h32(i * 13 + 5)) % 1;
    const vy = (h32(i * 7 + 1) - 0.5) * 10;
    const x = Math.round(startX + 1 + life * (12 + h32(i) * 4));
    const y = Math.round(oy + 3 + h32(i * 3 + 2) * (H - 6) + vy * life);
    const col = life < 0.35 ? RIM[1]! : life < 0.7 ? RIM[2]! : RIM[3]!;
    const size = h32(i * 11) < 0.35 && life < 0.6 ? 2 : 1;
    if (life > 0.92) continue;
    cv.rect(x, y, size, size, col);
  }
}

/** Orbit: a tilted ellipse round the word, its back half behind the letters, front half and moon in front. */
function ring(cv: PixelCanvas, m: WordMask, ox: number, oy: number, t: number, half: 'back' | 'front'): void {
  const cx = ox + m.w / 2;
  const cy = oy + H / 2;
  const rx = m.w / 2 + 7;
  const ry = 7;
  const tilt = -0.055;
  const N = 900;
  const at = (a: number): [number, number] => {
    const ex = rx * Math.cos(a);
    const ey = ry * Math.sin(a);
    return [
      Math.round(cx + ex * Math.cos(tilt) - ey * Math.sin(tilt)),
      Math.round(cy + ex * Math.sin(tilt) + ey * Math.cos(tilt)),
    ];
  };
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const front = Math.sin(a) > 0;
    if ((half === 'front') !== front) continue;
    const [x, y] = at(a);
    cv.put(x, y, front ? hex('#ffe2a8') : alpha(hex('#7f8cff'), 0.7));
  }
  if (half !== 'front') return;
  // the moon and its trail (period 5 s), drawn only while it is in front
  const a0 = (t / 5) * Math.PI * 2;
  for (let k = 6; k >= 0; k--) {
    const a = a0 - k * 0.05;
    if (Math.sin(a) <= 0) continue;
    const [x, y] = at(a);
    if (k === 0) {
      cv.rect(x - 1, y - 1, 3, 3, C.white);
      cv.put(x - 1, y - 1, 0);
      cv.put(x + 1, y + 1, hex('#ff9a3c'));
    } else cv.put(x, y, alpha(hex('#ffd27a'), 1 - k / 7));
  }
}

/** Draw the wordmark centred on `cx`, its sprite's top at `y`, at integer `scale`. Returns its drawn size. */
export function drawCosmicWordmark(
  cv: PixelCanvas,
  cx: number,
  y: number,
  t: number,
  opts: { scale?: number; style?: CosmicStyle } = {},
): { w: number; h: number; x: number } {
  const s = cosmicWordmark(opts.style ?? COSMIC_STYLE, t);
  const sc = opts.scale ?? 1;
  // centre on the letters, not the sprite (the deepfield debris tail is on the right only)
  const letters = wordMask().w;
  const x = Math.round(cx - (s.ox + letters / 2) * sc);
  cv.blit(s, x, y, { scale: sc });
  return { w: s.w * sc, h: s.h * sc, x };
}

/** The live badge's text: "9 TITANS · GROWING". */
export const cosmicBadgeText = (count: number): string => `${count} TITANS · GROWING`;

/**
 * The small live badge under the wordmark: a pulsing dot (like a live broadcast) and "N TITANS · GROWING", in a dark pill.
 * `align` places it on `x`. Returns its width.
 */
export function drawCosmicBadge(
  cv: PixelCanvas,
  x: number,
  y: number,
  count: number,
  t: number,
  align: 'left' | 'center' | 'right' = 'center',
): number {
  const text = cosmicBadgeText(count);
  const tw = measureText(text, { font: 'micro', tracking: 1 });
  const w = tw + 18;
  const x0 = align === 'center' ? Math.round(x - w / 2) : align === 'right' ? x - w : x;
  cv.rect(x0, y, w, 11, alpha(C.ink0, 0.9));
  cv.frame(x0, y, w, 11, hex('#3a2c6a'));
  const on = 0.55 + 0.45 * Math.sin(t * 4);
  cv.rect(x0 + 4, y + 4, 3, 3, alpha(hex('#ff5a8a'), on));
  cv.put(x0 + 5, y + 3, alpha(hex('#ff5a8a'), on * 0.6));
  cv.put(x0 + 5, y + 7, alpha(hex('#ff5a8a'), on * 0.6));
  drawText(cv, text, x0 + 11, y + 3, { color: C.soft, font: 'micro', tracking: 1 });
  return w;
}
