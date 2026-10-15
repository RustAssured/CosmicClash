import { hex, type TitanId } from '@/contracts';
import { alphaBounds, type Bounds } from '../portrait';
import { BAYER4, type PixelCanvas, type Sprite } from './canvas';
import { CHROME, GOLD, titleType, type TypeStyle } from './titleType';

/**
 * THE WORDMARK (logo D, WJ 2026-10-15): ADEUK in cracked gold over TITANS in star-filled chrome, split by a horizon line of
 * light. At its centre the Last One's eye; either side three beads made from the original roster's own pixels, shrinking
 * outward: Supernova, Nexus, Asteroid on the left, Planet, Black Hole and 우리's moon on the right. Every glow is solid
 * dithered pixels (no alpha), so the mark is crisp on any background.
 *
 * Three stacked sizes: 'large' (letters ×3: the press kit, the download), 'medium' (×2: the boot and title screens, the
 * site's hero), 'small' (×1: the attract watermark); and 'inline', one line with the eye as its colon (the site's nav). The beads need titan portraits: the game passes its portrait provider; without one (or for a titan it
 * has no portrait of) a bead is left out and the eye and the line still stand.
 * Tool: tools/press/wordmark.ts (PNGs). The old one-line logotype (logo.ts) stays for the trailer and the key art.
 */
export type WordmarkSize = 'large' | 'medium' | 'small' | 'inline';
export type WordmarkPortraits = (id: TitanId) => Sprite | null;

interface SizeSpec {
  /** Letter scale, the gap between the words, the extrusion depth (px). */
  k: number;
  gap: number;
  depth: number;
  /** The eye's radius, its halo's width, the flare's horizontal and vertical arm lengths past the eye. */
  eye: number;
  halo: number;
  armX: number;
  armY: number;
  /** Bead radii and their centres' distance from the eye, inner first. */
  beadR: readonly number[];
  beadX: readonly number[];
  /** Clear rows above and below (the glint's margin), and the line's overhang past the widest word. */
  top: number;
  overhang: number;
}
const SIZES: Record<Exclude<WordmarkSize, 'inline'>, SizeSpec> = {
  large: {
    k: 3,
    gap: 20,
    depth: 6,
    eye: 15,
    halo: 14,
    armX: 80,
    armY: 26,
    beadR: [10, 8, 6],
    beadX: [46, 80, 108],
    top: 4,
    overhang: 70,
  },
  medium: {
    k: 2,
    gap: 14,
    depth: 4,
    eye: 10,
    halo: 9,
    armX: 54,
    armY: 17,
    beadR: [7, 5, 4],
    beadX: [31, 53, 72],
    top: 3,
    overhang: 46,
  },
  small: {
    k: 1,
    gap: 8,
    depth: 2,
    eye: 5,
    halo: 5,
    armX: 28,
    armY: 9,
    beadR: [4, 3, 2],
    beadX: [16, 27, 36],
    top: 2,
    overhang: 24,
  },
};

const bayer = (x: number, y: number): number => BAYER4[(y & 3) * 4 + (x & 3)]! / 16;
/** Dithered presence: a pixel of intensity t (0..1) is drawn when t beats its Bayer threshold. */
const on = (t: number, x: number, y: number): boolean => t > bayer(x, y);
const WARM = ['#ffffff', '#fff4c0', '#ffc850', '#ff8a30', '#c04a20'].map(hex);
const COOL = ['#ffffff', '#e0f8ff', '#8fd0ff', '#4a90e8', '#2a4aa8'].map(hex);
const OUTLINE = hex('#05030f');

function styles(s: SizeSpec): { gold: TypeStyle; chrome: TypeStyle } {
  const f = s.k / 3;
  return {
    gold: {
      ...GOLD,
      extrude: GOLD.extrude.slice(0, s.depth),
      cracks: { n: Math.round(26 * f), dark: hex('#7a2a0c'), light: hex('#fff2b0') },
    },
    chrome: {
      ...CHROME,
      extrude: CHROME.extrude.slice(0, s.depth),
      cracks: { n: Math.round(14 * f), dark: hex('#1a1060'), light: hex('#e8f8ff') },
      stars: Math.round(90 * f * f),
    },
  };
}

// --- the beads ------------------------------------------------------------------------------------------------------
interface Bead {
  id: TitanId;
  /** The square of the portrait wrapped onto the ball (centre, side), or a box to find it in (uri's moon). */
  crop?: { cx: number; cy: number; d: number };
  within?: Bounds;
  /** 'sphere': already a ball, only a soft limb. 'wrap': a crop given a ball's light and shadow. */
  kind: 'sphere' | 'wrap';
  /** Glows instead of being lit (the Supernova). */
  glow?: boolean;
}
/** Inner first. The crops are in each titan's pristine-portrait pixels (src/titans/portrait.ts). */
const LEFT: readonly Bead[] = [
  { id: 'supernova', crop: { cx: 90, cy: 68, d: 104 }, kind: 'sphere', glow: true },
  { id: 'nexus', crop: { cx: 78, cy: 86, d: 96 }, kind: 'wrap' },
  { id: 'asteroid', crop: { cx: 54, cy: 56, d: 54 }, kind: 'wrap' },
];
const RIGHT: readonly Bead[] = [
  { id: 'planet', kind: 'sphere' },
  { id: 'blackhole', crop: { cx: 86, cy: 76, d: 60 }, kind: 'wrap' },
  // 우리's command moon sits at the top of its portrait (the rig's 'moon' part)
  { id: 'uri', within: { x0: 174, y0: 0, x1: 204, y1: 33 }, kind: 'sphere' },
];
export const WORDMARK_BEADS: readonly TitanId[] = [...LEFT, ...RIGHT].map((b) => b.id);

/** Where on the portrait a bead's ball comes from (null if there is nothing there). */
export function beadCrop(b: Bead, s: Sprite): { cx: number; cy: number; d: number } | null {
  if (b.crop) return b.crop;
  let box: Bounds | null;
  if (b.within) {
    const w = b.within;
    const sub = new Uint32Array((w.x1 - w.x0) * (w.y1 - w.y0));
    for (let y = w.y0; y < w.y1; y++)
      for (let x = w.x0; x < w.x1; x++)
        if (x < s.w && y < s.h) sub[(y - w.y0) * (w.x1 - w.x0) + x - w.x0] = s.pixels[y * s.w + x]!;
    const b2 = alphaBounds(sub, w.x1 - w.x0, w.y1 - w.y0);
    box = b2 && { x0: b2.x0 + w.x0, y0: b2.y0 + w.y0, x1: b2.x1 + w.x0, y1: b2.y1 + w.y0 };
  } else box = alphaBounds(s.pixels, s.w, s.h);
  if (!box) return null;
  return {
    cx: (box.x0 + box.x1) / 2,
    cy: (box.y0 + box.y1) / 2,
    d: Math.max(box.x1 - box.x0, box.y1 - box.y0),
  };
}
export const WORDMARK_BEAD_SPECS = { left: LEFT, right: RIGHT };

/** A ball of radius r (inside r, a dark 1px outline at r+1) wrapping a crop of `s` by area sampling. */
function bead(b: Bead, s: Sprite, crop: { cx: number; cy: number; d: number }, r: number): Sprite {
  const D = r * 2 + 3;
  const c0 = r + 1;
  const pixels = new Uint32Array(D * D);
  const step = crop.d / (r * 2 + 1);
  for (let j = 0; j < D; j++)
    for (let i = 0; i < D; i++) {
      const dx = i - c0;
      const dy = j - c0;
      const n = Math.hypot(dx, dy) / (r + 0.5);
      if (n > 1 + 1 / r) continue;
      if (n > 1) {
        pixels[j * D + i] = OUTLINE;
        continue;
      }
      // the source box under this pixel: the mean of its opaque cells
      const sx0 = crop.cx - crop.d / 2 + (dx + r) * step;
      const sy0 = crop.cy - crop.d / 2 + (dy + r) * step;
      let R = 0;
      let G = 0;
      let B = 0;
      let k = 0;
      for (let y = Math.floor(sy0); y < Math.ceil(sy0 + step); y++)
        for (let x = Math.floor(sx0); x < Math.ceil(sx0 + step); x++) {
          if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
          const c = s.pixels[y * s.w + x]!;
          if (!(c >>> 24)) continue;
          R += c & 255;
          G += (c >>> 8) & 255;
          B += (c >>> 16) & 255;
          k++;
        }
      if (!k) {
        R = 20;
        G = 14;
        B = 30;
        k = 1;
      }
      const lit = (-dx - dy) / (2 * r) + 0.5; // 1 at the upper left
      let f: number;
      if (b.glow) f = 1.05 + 0.15 * (1 - n);
      else if (b.kind === 'sphere') f = 0.8 + 0.35 * lit;
      else f = (0.45 + 0.8 * lit) * (1 - 0.35 * n * n);
      const cl = (v: number): number => Math.max(0, Math.min(255, Math.round((v / k) * f)));
      pixels[j * D + i] = ((0xff << 24) | (cl(B) << 16) | (cl(G) << 8) | cl(R)) >>> 0;
    }
  // a catchlight on everything but the glowing one (big enough balls only)
  if (!b.glow && r >= 4) {
    const h = Math.round(r * 0.45);
    const i = c0 - h + (c0 - h) * D;
    const c = pixels[i]!;
    const up = (v: number): number => (v + 255) >> 1;
    pixels[i] = (0xff000000 | (up((c >>> 16) & 255) << 16) | (up((c >>> 8) & 255) << 8) | up(c & 255)) >>> 0;
  }
  return { pixels, w: D, h: D };
}

// --- the mark -------------------------------------------------------------------------------------------------------
export interface WordmarkSprite extends Sprite {
  /** Letter pixels (for the glint), same dims. */
  fill: Uint8Array;
}

function build(size: Exclude<WordmarkSize, 'inline'>, portraits: WordmarkPortraits | null): WordmarkSprite {
  const S = SIZES[size];
  const { gold, chrome } = styles(S);
  const adeuk = titleType('ADEUK', gold, S.k);
  const titans = titleType('TITANS', chrome, S.k);
  const lineLen = Math.max(adeuk.w, titans.w) + S.overhang;
  const W = lineLen + 8;
  const H = S.top + adeuk.h + S.gap + titans.h + S.top;
  const px = new Uint32Array(W * H);
  const fill = new Uint8Array(W * H);
  const cx = W >> 1;
  const ly = S.top + adeuk.h + (S.gap >> 1) - 1;
  const put = (x: number, y: number, c: number): void => {
    if (x >= 0 && y >= 0 && x < W && y < H) px[y * W + x] = c;
  };
  const blit = (s: Sprite, x0: number, y0: number, letters = false): void => {
    for (let y = 0; y < s.h; y++)
      for (let x = 0; x < s.w; x++) {
        const c = s.pixels[y * s.w + x]!;
        if (!(c >>> 24)) continue;
        put(x0 + x, y0 + y, c);
        if (letters && x0 + x >= 0 && y0 + y >= 0 && x0 + x < W && y0 + y < H)
          fill[(y0 + y) * W + x0 + x] = 1;
      }
  };
  blit(adeuk, cx - (adeuk.w >> 1), S.top, true);
  blit(titans, cx - (titans.w >> 1), S.top + adeuk.h + S.gap, true);

  // the horizon: a 1px core thickening toward the centre; warm above, cool below; dithering out at the tips
  const ramp = (r: number[], d: number): number => r[Math.min(r.length - 1, Math.floor(d * r.length))]!;
  const thick = S.k >= 2;
  for (let x = cx - (lineLen >> 1); x <= cx + (lineLen >> 1); x++) {
    const d = Math.abs(x - cx) / (lineLen / 2);
    const fade = d < 0.7 ? 1 : 1 - (d - 0.7) / 0.3;
    if (on(fade, x, ly)) put(x, ly, ramp(WARM, d * 0.8));
    if (d < 0.65 && on((0.65 - d) / 0.65 + 0.35, x, ly - 1)) put(x, ly - 1, ramp(WARM, 0.2 + d));
    if (d < 0.65 && on((0.65 - d) / 0.65 + 0.35, x, ly + 1)) put(x, ly + 1, ramp(COOL, 0.2 + d));
    if (!thick) continue;
    if (d < 0.32 && on((0.32 - d) / 0.32 + 0.1, x, ly - 2)) put(x, ly - 2, ramp(WARM, 0.45 + d));
    if (d < 0.32 && on((0.32 - d) / 0.32 + 0.1, x, ly + 2)) put(x, ly + 2, ramp(COOL, 0.45 + d));
    if (d < 0.12 && on((0.12 - d) / 0.12, x, ly - 3)) put(x, ly - 3, WARM[3]!);
    if (d < 0.12 && on((0.12 - d) / 0.12, x, ly + 3)) put(x, ly + 3, COOL[3]!);
  }

  // the eye's halo: warm above the line, cool below
  const R = S.eye;
  for (let y = ly - R - S.halo; y <= ly + R + S.halo; y++)
    for (let x = cx - R - S.halo; x <= cx + R + S.halo; x++) {
      const d = Math.hypot(x - cx, y - ly);
      if (d <= R || d > R + S.halo) continue;
      const t = (1 - (d - R) / S.halo) * 0.85;
      if (on(t, x, y)) put(x, y, y <= ly ? (t > 0.45 ? WARM[2]! : WARM[3]!) : t > 0.45 ? COOL[2]! : COOL[3]!);
    }
  // the flare: a long horizontal arm, a shorter vertical one, fading; short diagonal glints
  const arm = (dx: number, dy: number, len: number): void => {
    for (let i = R; i <= len; i++) {
      const t = 1 - (i - R) / (len - R);
      const x = cx + dx * i;
      const y = ly + dy * i;
      if (on(t + 0.15, x, y))
        put(x, y, t > 0.6 ? WARM[0]! : t > 0.3 ? WARM[1]! : dy < 0 ? WARM[2]! : COOL[2]!);
    }
  };
  arm(1, 0, R + S.armX);
  arm(-1, 0, R + S.armX);
  arm(0, -1, R + S.armY);
  arm(0, 1, R + S.armY);
  const g0 = Math.ceil(R * 0.72);
  const glen = Math.max(2, Math.round(S.k * 1.8));
  for (const [dx, dy] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const)
    for (let i = g0; i <= g0 + glen; i++)
      if (on(1 - (i - R * 0.72) / (glen + 1), cx + dx * i, ly + dy * i))
        put(cx + dx * i, ly + dy * i, dy < 0 ? WARM[1]! : COOL[1]!);

  // the roster on the string, shrinking outward
  if (portraits)
    for (const [side, list] of [
      [-1, LEFT],
      [1, RIGHT],
    ] as const)
      list.forEach((b, i) => {
        const s = portraits(b.id);
        const crop = s && beadCrop(b, s);
        if (!s || !crop) return;
        const r = S.beadR[i]!;
        const bx = cx + side * S.beadX[i]!;
        if (b.glow) {
          const gw = Math.max(2, Math.round(r / 2));
          for (let y = ly - r - gw - 1; y <= ly + r + gw + 1; y++)
            for (let x = bx - r - gw - 1; x <= bx + r + gw + 1; x++) {
              const d = Math.hypot(x - bx, y - ly);
              if (d > r + 1 && d <= r + 1 + gw && on((1 - (d - r - 1) / gw) * 0.7, x, y))
                put(x, y, d < r + 1 + gw / 2 ? WARM[2]! : WARM[3]!);
            }
        }
        const ball = bead(b, s, crop, r);
        blit(ball, bx - (ball.w >> 1), ly - (ball.h >> 1));
      });

  eye(put, cx, ly, R);
  return { pixels: px, w: W, h: H, fill };
}

/** The Last One's eye: gold rim, sclera shaded to the lower right, teal iris, black pupil, one catchlight. */
function eye(put: (x: number, y: number, c: number) => void, cx: number, cy: number, R: number): void {
  const RIM_D = hex('#2a1806');
  const RIM = ['#ffe08a', '#e0a840', '#a06a1c'].map(hex);
  const SCLERA = ['#f4f0dc', '#d8d0b8', '#a89c84'].map(hex);
  const IRIS = ['#9ae8d8', '#4ab8a8', '#1e7a7a', '#0e4a50'].map(hex);
  const IR = R * 0.56;
  const PR = R * 0.24;
  const rimW = R >= 8 ? 2.6 : 1.6;
  for (let y = cy - R; y <= cy + R; y++)
    for (let x = cx - R; x <= cx + R; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (d > R + 0.4) continue;
      const lit = (-dx - dy) / (R * 2) + 0.5; // 1 at the upper left
      let c: number;
      if (d > R - 0.6) c = RIM_D;
      else if (d > R - rimW) c = lit > 0.6 ? RIM[0]! : lit > 0.35 ? RIM[1]! : RIM[2]!;
      else if (d > IR + 0.8)
        c = on(lit, x, y) ? SCLERA[0]! : d > R - 4 && lit < 0.4 ? SCLERA[2]! : SCLERA[1]!;
      else if (d > IR) c = IRIS[3]!;
      else if (d > PR) c = IRIS[Math.min(3, Math.floor(((IR - d) / (IR - PR)) * 2 + (1 - lit) * 1.6))]!;
      else c = OUTLINE;
      put(x, y, c);
    }
  const cl = Math.max(1, Math.round(R * 0.22));
  put(cx - cl, cy - cl, hex('#ffffff'));
  if (R >= 8) {
    put(cx - cl + 1, cy - cl, hex('#ffffff'));
    put(cx - cl, cy - cl + 1, hex('#d8fff6'));
  }
}

/**
 * The one-line lockup for tight spots (the site's nav bar): ADEUK, the eye where the old logotype had its colon, TITANS,
 * at letter scale ×1, with a short flare through the eye. No beads.
 */
function buildInline(): WordmarkSprite {
  const S = SIZES.small;
  const { gold, chrome } = styles(S);
  const adeuk = titleType('ADEUK', gold, 1);
  const titans = titleType('TITANS', chrome, 1);
  const R = 6;
  const gap = R * 2 + 10;
  const W = adeuk.w + gap + titans.w;
  const H = Math.max(adeuk.h, titans.h) + 2;
  const px = new Uint32Array(W * H);
  const fill = new Uint8Array(W * H);
  const put = (x: number, y: number, c: number): void => {
    if (x >= 0 && y >= 0 && x < W && y < H) px[y * W + x] = c;
  };
  for (const [s, x0] of [
    [adeuk, 0],
    [titans, adeuk.w + gap],
  ] as const)
    for (let y = 0; y < s.h; y++)
      for (let x = 0; x < s.w; x++) {
        const c = s.pixels[y * s.w + x]!;
        if (!(c >>> 24)) continue;
        put(x0 + x, y + 1, c);
        fill[(y + 1) * W + x0 + x] = 1;
      }
  // the eye sits on the letters' optical middle (the cap, not the extrusion)
  const cx = adeuk.w + (gap >> 1);
  const cy = 1 + Math.round((adeuk.h - S.depth) / 2);
  for (let i = R + 1; i <= R + 5; i++) {
    const t = 1 - (i - R - 1) / 5;
    for (const dx of [-1, 1])
      if (on(t + 0.2, cx + dx * i, cy)) put(cx + dx * i, cy, t > 0.5 ? WARM[1]! : WARM[2]!);
  }
  for (let y = cy - R - 3; y <= cy + R + 3; y++)
    for (let x = cx - R - 3; x <= cx + R + 3; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > R && d <= R + 3 && on((1 - (d - R) / 3) * 0.6, x, y)) put(x, y, y <= cy ? WARM[2]! : COOL[2]!);
    }
  eye(put, cx, cy, R);
  return { pixels: px, w: W, h: H, fill };
}

const cache = new Map<string, WordmarkSprite>();
/** The wordmark at `size` (built once per size; with beads when `portraits` is given). */
export function wordmarkSprite(
  size: WordmarkSize,
  portraits: WordmarkPortraits | null = null,
): WordmarkSprite {
  const key = size === 'inline' ? size : `${size}:${portraits ? 1 : 0}`;
  let s = cache.get(key);
  if (!s) cache.set(key, (s = size === 'inline' ? buildInline() : build(size, portraits)));
  return s;
}

/** Drop the built marks (the app regenerated its portraits). */
export function clearWordmark(): void {
  cache.clear();
}

/**
 * Draw the wordmark centred on `cx` with its top at `y`. `t` (seconds) drives a diagonal glint that crosses the letters
 * once every ~7 s. Returns the sprite size.
 */
export function drawWordmark(
  cv: PixelCanvas,
  cx: number,
  y: number,
  t: number,
  opts: { size?: WordmarkSize; portraits?: WordmarkPortraits | null; glint?: boolean } = {},
): { w: number; h: number } {
  const s = wordmarkSprite(opts.size ?? 'medium', opts.portraits ?? null);
  const x0 = Math.round(cx - s.w / 2);
  const phase = (t % 7) / 2.2; // the sweep takes 2.2 s, then rests
  const pos = opts.glint !== false && phase < 1 ? phase * (s.w + s.h + 24) - 12 : -100;
  for (let j = 0; j < s.h; j++)
    for (let i = 0; i < s.w; i++) {
      let c = s.pixels[j * s.w + i]!;
      if (!(c >>> 24)) continue;
      if (s.fill[j * s.w + i] && pos > -50) {
        const d = i + j - pos;
        if (d > -3 && d < 3) {
          const add = 70 - Math.abs(d) * 18;
          const ch = (v: number): number => Math.min(255, v + add);
          c =
            ((c & 0xff000000) | (ch((c >>> 16) & 255) << 16) | (ch((c >>> 8) & 255) << 8) | ch(c & 255)) >>>
            0;
        }
      }
      cv.px(x0 + i, y + j, c);
    }
  return { w: s.w, h: s.h };
}
