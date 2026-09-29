import { hex, rgba } from '@/contracts';
import { BAYER4, type PixelCanvas, type Sprite } from './canvas';
import { C, alpha } from './palette';

/**
 * The ADEUK: TITANS logotype. Letters are built from strokes (rectangles and thick diagonals) on a 15-row grid so the stroke
 * weight is identical everywhere, then every convex corner loses one pixel (a soft chamfer), and the mask is shaded like
 * pixel-art metal: a dithered celadon ramp top→bottom, lit top/left edges, shaded bottom/right edges, a dark outline and a
 * drop shadow. A slow diagonal glint sweeps across it.
 */
/** Logotype metrics (px): cap height and stroke weight. Everything else derives from these two numbers. */
const H = 23;
const S = 5;
/** Horizontal width of a diagonal stroke so its perpendicular weight matches the straight strokes. */
const SD = 6;
const W = 19;

class Mask {
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
  /** Parallelogram stroke of horizontal width s from (xTop,yTop) to (xBot,yBot). */
  diag(xTop: number, yTop: number, xBot: number, yBot: number, s = SD): void {
    for (let y = yTop; y <= yBot; y++) {
      const t = yBot === yTop ? 0 : (y - yTop) / (yBot - yTop);
      const x = Math.round(xTop + (xBot - xTop) * t);
      for (let i = 0; i < s; i++) this.set(x + i, y, 1);
    }
  }
  /** Cut a triangle of size n off a corner. */
  cut(corner: 'tl' | 'tr' | 'bl' | 'br', n: number): void {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n - j; i++) {
        const x = corner === 'tl' || corner === 'bl' ? i : this.w - 1 - i;
        const y = corner === 'tl' || corner === 'tr' ? j : H - 1 - j;
        this.set(x, y, 0);
      }
    }
  }
  /** Remove the single pixel of every convex corner (both orthogonal neighbours on one diagonal side empty). */
  soften(): void {
    const kill: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < this.w; x++) {
        if (!this.get(x, y)) continue;
        const up = this.get(x, y - 1);
        const dn = this.get(x, y + 1);
        const lf = this.get(x - 1, y);
        const rt = this.get(x + 1, y);
        if ((!up && !lf) || (!up && !rt) || (!dn && !lf) || (!dn && !rt)) kill.push(y * this.w + x);
      }
    }
    for (const i of kill) this.d[i] = 0;
  }
}

function letter(ch: string): Mask {
  const mid = Math.round((H - S) / 2);
  const c = S + 1; // chamfer size
  switch (ch) {
    case 'A': {
      const m = new Mask(W + 2);
      const ap = S + 4;
      const xl = Math.floor((m.w - ap) / 2);
      m.diag(xl, 0, 0, H - 1);
      m.diag(xl + ap - SD, 0, m.w - SD, H - 1);
      m.rect(xl, 0, xl + ap - 1, S - 1);
      m.rect(4, H - 9, m.w - 5, H - 9 + S - 1);
      return m;
    }
    case 'D': {
      const m = new Mask(W);
      m.rect(0, 0, W - 1, H - 1);
      m.hole(S, S, W - S - 1, H - S - 1);
      m.cut('tr', c + 2);
      m.cut('br', c + 2);
      return m;
    }
    case 'E': {
      const m = new Mask(W - 2);
      m.rect(0, 0, S - 1, H - 1);
      m.rect(0, 0, m.w - 1, S - 1);
      m.rect(0, mid, m.w - 4, mid + S - 1);
      m.rect(0, H - S, m.w - 1, H - 1);
      return m;
    }
    case 'U': {
      const m = new Mask(W);
      m.rect(0, 0, W - 1, H - 1);
      m.hole(S, 0, W - S - 1, H - S - 1);
      m.cut('bl', c - 1);
      m.cut('br', c - 1);
      return m;
    }
    case 'K': {
      const m = new Mask(W + 2);
      m.rect(0, 0, S - 1, H - 1);
      m.diag(m.w - SD - 1, 0, S - 2, mid + 2, SD + 1);
      m.diag(S - 2, mid + 1, m.w - SD - 1, H - 1, SD + 1);
      m.rect(S, mid - 1, S + 3, mid + S);
      return m;
    }
    case 'T': {
      const m = new Mask(W + 2);
      m.rect(0, 0, m.w - 1, S - 1);
      const sx = Math.floor((m.w - S) / 2);
      m.rect(sx, 0, sx + S - 1, H - 1);
      return m;
    }
    case 'I': {
      const m = new Mask(11);
      m.rect(0, 0, 10, S - 1);
      m.rect(0, H - S, 10, H - 1);
      m.rect(3, 0, 3 + S - 1, H - 1);
      return m;
    }
    case 'N': {
      const m = new Mask(W + 1);
      m.rect(0, 0, S - 1, H - 1);
      m.rect(m.w - S, 0, m.w - 1, H - 1);
      m.diag(1, 0, m.w - SD - 1, H - 1, SD);
      return m;
    }
    case 'S': {
      const m = new Mask(W);
      m.rect(0, 0, W - 1, S - 1);
      m.rect(0, 0, S - 1, mid + S - 1);
      m.rect(0, mid, W - 1, mid + S - 1);
      m.rect(W - S, mid, W - 1, H - 1);
      m.rect(0, H - S, W - 1, H - 1);
      m.cut('tr', c);
      m.cut('bl', c);
      return m;
    }
    case ':': {
      const m = new Mask(S);
      m.rect(0, Math.round(H * 0.2), S - 1, Math.round(H * 0.2) + S - 1);
      m.rect(0, Math.round(H * 0.68), S - 1, Math.round(H * 0.68) + S - 1);
      return m;
    }
    default:
      return new Mask(6);
  }
}

const RAMP = [hex('#f4fbf7'), hex('#d6e8de'), hex('#a8bdb2'), hex('#7c9c94'), hex('#4a6b73'), hex('#2c4451')];
const OUTLINE = hex('#08110e');
const EDGE_LIGHT = hex('#ffffff');

export interface LogoSprite extends Sprite {
  /** Which pixels are letter fill (for the glint), same dims. */
  fill: Uint8Array;
}

let cached: LogoSprite | null = null;

/** Build (once) the logotype sprite for "ADEUK: TITANS" including outline and drop shadow. */
export function logoSprite(): LogoSprite {
  if (cached) return cached;
  const text = 'ADEUK: TITANS';
  const masks: (Mask | null)[] = [];
  const gap = 4;
  let width = 0;
  for (const ch of text) {
    if (ch === ' ') {
      masks.push(null);
      width += 14;
      continue;
    }
    const m = letter(ch);
    m.soften();
    masks.push(m);
    width += m.w + gap;
  }
  width -= gap;
  const pad = 5;
  const SW = width + pad * 2 + 2;
  const SH = H + pad * 2 + 2;
  const px = new Uint32Array(SW * SH);
  const fill = new Uint8Array(SW * SH);
  const solid = new Uint8Array(SW * SH);
  let cx = pad;
  for (const m of masks) {
    if (!m) {
      cx += 14;
      continue;
    }
    for (let y = 0; y < H; y++)
      for (let x = 0; x < m.w; x++) if (m.d[y * m.w + x]) solid[(y + pad) * SW + cx + x] = 1;
    cx += m.w + gap;
  }
  const at = (x: number, y: number): number =>
    x >= 0 && y >= 0 && x < SW && y < SH ? solid[y * SW + x]! : 0;
  // drop shadow (2,2), then a 1px outline
  for (let y = 0; y < SH; y++)
    for (let x = 0; x < SW; x++) if (at(x - 2, y - 2)) px[y * SW + x] = alpha(C.void, 0.55);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      if (at(x, y)) continue;
      if (at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1)) px[y * SW + x] = OUTLINE;
    }
  }
  // fill: dithered ramp top→bottom, then bevel — a lit edge with a softer band under it, a shaded edge with a band above it
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      if (!at(x, y)) continue;
      const t = (y - pad) / (H - 1);
      const f = Math.min(1, Math.max(0, t)) * (RAMP.length - 1);
      const k = Math.min(RAMP.length - 2, Math.floor(f));
      const frac = f - k;
      let c = frac * 16 > BAYER4[(y & 3) * 4 + (x & 3)]! ? RAMP[k + 1]! : RAMP[k]!;
      if (!at(x, y - 1)) c = RAMP[0]!;
      else if (!at(x - 1, y)) c = RAMP[1]!;
      else if (!at(x, y + 1)) c = RAMP[5]!;
      else if (!at(x + 1, y)) c = RAMP[4]!;
      else if (!at(x, y - 2)) c = RAMP[1]!;
      else if (!at(x, y + 2)) c = RAMP[4]!;
      px[y * SW + x] = c;
      fill[y * SW + x] = 1;
    }
  }
  cached = { pixels: px, w: SW, h: SH, fill };
  return cached;
}

/**
 * Draw the logotype centred on `cx` with its top at `y`. `t` (seconds) drives a diagonal glint that crosses the letters once
 * every ~7 s. Returns the sprite size.
 */
export function drawLogo(
  cv: PixelCanvas,
  cx: number,
  y: number,
  t: number,
  opts: { scale?: number; glint?: boolean } = {},
): { w: number; h: number } {
  const s = logoSprite();
  const sc = opts.scale ?? 1;
  const x0 = Math.round(cx - (s.w * sc) / 2);
  const period = 7;
  const phase = (t % period) / 2.2; // sweep takes 2.2 s, then rests
  const pos = opts.glint !== false && phase < 1 ? phase * (s.w + s.h + 24) - 12 : -100;
  for (let j = 0; j < s.h; j++) {
    for (let i = 0; i < s.w; i++) {
      let c = s.pixels[j * s.w + i]!;
      if (c === 0) continue;
      if (s.fill[j * s.w + i] && pos > -50) {
        const d = i + j - pos;
        if (d > -3 && d < 3)
          c = rgba(
            Math.min(255, (c & 255) + 70 - Math.abs(d) * 18),
            Math.min(255, ((c >>> 8) & 255) + 70 - Math.abs(d) * 18),
            Math.min(255, ((c >>> 16) & 255) + 60 - Math.abs(d) * 16),
            c >>> 24,
          );
      }
      if (sc === 1) cv.px(x0 + i, y + j, c);
      else cv.rect(x0 + i * sc, y + j * sc, sc, sc, c);
    }
  }
  return { w: s.w * sc, h: s.h * sc };
}

export { EDGE_LIGHT };
