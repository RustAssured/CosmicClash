import { pa, rgba } from '@/contracts';

/** Anything with packed RGBA pixels (a titan sprite, a portrait, another canvas). */
export interface Sprite {
  pixels: Uint32Array;
  w: number;
  h: number;
}

/** 4×4 Bayer matrix, values 0..15: ordered-dither threshold. */
export const BAYER4: readonly number[] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

export interface BlitOptions {
  flipX?: boolean;
  /** 0..1 multiplier on source alpha. */
  alpha?: number;
  /** Integer upscale (nearest). */
  scale?: number;
  /** Replace every opaque pixel's RGB with this colour (silhouette), keeping alpha. */
  silhouette?: number;
  /** Desaturate and darken by this 0..1 amount (greyed-out "not available"). */
  grey?: number;
  /** Add this to RGB (glint / hover sheen), 0..255. */
  lift?: number;
}

/**
 * The pixel toolkit every screen draws with. One canvas = one Uint32Array of packed RGBA (see contracts/color.ts), with a
 * clip rect. All drawing is integer-only; nothing anti-aliases. Blending is source-over so the UI layer keeps alpha 0 where
 * the scenery should show through.
 */
export class PixelCanvas {
  readonly w: number;
  readonly h: number;
  readonly pixels: Uint32Array;
  private cx0 = 0;
  private cy0 = 0;
  private cx1: number;
  private cy1: number;
  private readonly clipStack: number[] = [];

  constructor(w: number, h: number, pixels?: Uint32Array) {
    this.w = w;
    this.h = h;
    this.pixels = pixels ?? new Uint32Array(w * h);
    this.cx1 = w;
    this.cy1 = h;
  }

  clear(c = 0): void {
    this.pixels.fill(c);
  }

  /* ---- clip ---- */
  pushClip(x: number, y: number, w: number, h: number): void {
    this.clipStack.push(this.cx0, this.cy0, this.cx1, this.cy1);
    this.cx0 = Math.max(this.cx0, x);
    this.cy0 = Math.max(this.cy0, y);
    this.cx1 = Math.min(this.cx1, x + w);
    this.cy1 = Math.min(this.cy1, y + h);
  }
  popClip(): void {
    if (this.clipStack.length >= 4) {
      this.cy1 = this.clipStack.pop()!;
      this.cx1 = this.clipStack.pop()!;
      this.cy0 = this.clipStack.pop()!;
      this.cx0 = this.clipStack.pop()!;
    }
  }

  /* ---- pixels ---- */
  get(x: number, y: number): number {
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.pixels[y * this.w + x]! : 0;
  }

  /** Overwrite one pixel (clipped). */
  put(x: number, y: number, c: number): void {
    if (x < this.cx0 || y < this.cy0 || x >= this.cx1 || y >= this.cy1) return;
    this.pixels[y * this.w + x] = c;
  }

  /** Source-over blend one pixel (clipped). Opaque sources overwrite, transparent ones do nothing. */
  px(x: number, y: number, c: number): void {
    if (x < this.cx0 || y < this.cy0 || x >= this.cx1 || y >= this.cy1) return;
    const a = c >>> 24;
    if (a === 0) return;
    const i = y * this.w + x;
    if (a === 255) {
      this.pixels[i] = c;
      return;
    }
    this.pixels[i] = over(c, this.pixels[i]!);
  }

  rect(x: number, y: number, w: number, h: number, c: number): void {
    const x0 = Math.max(x, this.cx0);
    const y0 = Math.max(y, this.cy0);
    const x1 = Math.min(x + w, this.cx1);
    const y1 = Math.min(y + h, this.cy1);
    if (x1 <= x0 || y1 <= y0) return;
    const a = c >>> 24;
    if (a === 0) return;
    for (let yy = y0; yy < y1; yy++) {
      const row = yy * this.w;
      if (a === 255) this.pixels.fill(c, row + x0, row + x1);
      else for (let xx = x0; xx < x1; xx++) this.pixels[row + xx] = over(c, this.pixels[row + xx]!);
    }
  }

  hline(x: number, y: number, w: number, c: number): void {
    this.rect(x, y, w, 1, c);
  }
  vline(x: number, y: number, h: number, c: number): void {
    this.rect(x, y, 1, h, c);
  }

  /** 1px outline just inside the box. */
  frame(x: number, y: number, w: number, h: number, c: number): void {
    if (w < 1 || h < 1) return;
    this.hline(x, y, w, c);
    if (h > 1) this.hline(x, y + h - 1, w, c);
    if (h > 2) {
      this.vline(x, y + 1, h - 2, c);
      if (w > 1) this.vline(x + w - 1, y + 1, h - 2, c);
    }
  }

  /** Bracket corners only (hairline "viewfinder" frame). */
  corners(x: number, y: number, w: number, h: number, c: number, len = 4): void {
    for (const [cx, cy, sx, sy] of [
      [x, y, 1, 1],
      [x + w - 1, y, -1, 1],
      [x, y + h - 1, 1, -1],
      [x + w - 1, y + h - 1, -1, -1],
    ] as const) {
      for (let i = 0; i < len; i++) {
        this.px(cx + i * sx, cy, c);
        this.px(cx, cy + i * sy, c);
      }
    }
  }

  /** Bresenham line. */
  line(x0: number, y0: number, x1: number, y1: number, c: number): void {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      this.px(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x0 += sx;
      }
      if (e2 < dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  /**
   * Ordered-dither fill: `level` 0..16 is the coverage of colour `c` in a 4×4 Bayer pattern (8 = the classic checker-ish
   * half tone). This is how the UI does translucency without leaving the pixel-art palette.
   */
  dither(x: number, y: number, w: number, h: number, c: number, level: number): void {
    if (level <= 0) return;
    for (let yy = Math.max(y, this.cy0); yy < Math.min(y + h, this.cy1); yy++) {
      for (let xx = Math.max(x, this.cx0); xx < Math.min(x + w, this.cx1); xx++) {
        if (BAYER4[(yy & 3) * 4 + (xx & 3)]! < level) this.px(xx, yy, c);
      }
    }
  }

  /**
   * Vertical gradient through a colour ramp with ordered dithering between adjacent steps — a limited-palette gradient,
   * not a smooth blend. `t0..t1` (0..1) selects which slice of the ramp the box spans.
   */
  gradientV(x: number, y: number, w: number, h: number, ramp: readonly number[], t0 = 0, t1 = 1): void {
    if (ramp.length === 0) return;
    for (let yy = 0; yy < h; yy++) {
      const t = h <= 1 ? t0 : t0 + ((t1 - t0) * yy) / (h - 1);
      const f = Math.min(ramp.length - 1, Math.max(0, t * (ramp.length - 1)));
      const k = Math.min(ramp.length - 2, Math.floor(f));
      const frac = ramp.length === 1 ? 0 : f - k;
      const lo = ramp[Math.max(0, k)]!;
      const hi = ramp[Math.min(ramp.length - 1, k + 1)]!;
      for (let xx = 0; xx < w; xx++) {
        const th = BAYER4[((y + yy) & 3) * 4 + ((x + xx) & 3)]!;
        this.px(x + xx, y + yy, frac * 16 > th ? hi : lo);
      }
    }
  }

  /** Copy a sprite (source-over), with optional flip/scale/alpha/silhouette/grey. */
  blit(s: Sprite, x: number, y: number, o: BlitOptions = {}): void {
    const sc = o.scale ?? 1;
    const am = o.alpha ?? 1;
    const flip = !!o.flipX;
    for (let sy = 0; sy < s.h; sy++) {
      for (let sx = 0; sx < s.w; sx++) {
        let c = s.pixels[sy * s.w + (flip ? s.w - 1 - sx : sx)]!;
        let a = c >>> 24;
        if (a === 0) continue;
        if (o.silhouette !== undefined) c = ((c & 0xff000000) | (o.silhouette & 0x00ffffff)) >>> 0;
        if (o.grey) c = greyOut(c, o.grey);
        if (o.lift) c = lift(c, o.lift);
        if (am < 1) {
          a = Math.round(a * am);
          if (a === 0) continue;
          c = ((a << 24) | (c & 0x00ffffff)) >>> 0;
        }
        if (sc === 1) this.px(x + sx, y + sy, c);
        else this.rect(x + sx * sc, y + sy * sc, sc, sc, c);
      }
    }
  }

  /** Publish to a RenderLayer-style consumer: nothing to do, pixels are shared; provided for symmetry/tests. */
  toSprite(): Sprite {
    return { pixels: this.pixels, w: this.w, h: this.h };
  }
}

/** Source-over of packed RGBA `s` on `d`. */
export function over(s: number, d: number): number {
  const sa = s >>> 24;
  if (sa === 255) return s;
  if (sa === 0) return d;
  const da = d >>> 24;
  if (da === 0) return s;
  const a = sa / 255;
  const dw = (da / 255) * (1 - a);
  const oa = a + dw;
  const r = ((s & 255) * a + (d & 255) * dw) / oa;
  const g = (((s >>> 8) & 255) * a + ((d >>> 8) & 255) * dw) / oa;
  const b = (((s >>> 16) & 255) * a + ((d >>> 16) & 255) * dw) / oa;
  return rgba(r + 0.5, g + 0.5, b + 0.5, oa * 255 + 0.5);
}

/** Multiply alpha of a packed colour. */
export const withAlpha = (c: number, a: number): number =>
  rgba(c & 255, (c >>> 8) & 255, (c >>> 16) & 255, Math.round(pa(c) * a));

/** Set the alpha byte of a packed colour to an absolute value. */
export const setAlpha = (c: number, a: number): number => (((a & 255) << 24) | (c & 0x00ffffff)) >>> 0;

function greyOut(c: number, k: number): number {
  const r = c & 255;
  const g = (c >>> 8) & 255;
  const b = (c >>> 16) & 255;
  const l = r * 0.3 + g * 0.55 + b * 0.15;
  const dim = 1 - 0.55 * k;
  return rgba(
    (r + (l - r) * k) * dim,
    (g + (l - g) * k) * dim,
    (b + (l - b) * k) * dim,
    c >>> 24,
  );
}

function lift(c: number, add: number): number {
  return rgba(
    Math.min(255, (c & 255) + add),
    Math.min(255, ((c >>> 8) & 255) + add),
    Math.min(255, ((c >>> 16) & 255) + add),
    c >>> 24,
  );
}
