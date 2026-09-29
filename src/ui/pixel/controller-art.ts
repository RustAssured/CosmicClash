import { hex, hueShiftRamp } from '@/contracts';
import { Pad, padButtonLabel, type GlyphFamily, type ProfileKind } from '@/input';
import { PixelCanvas, BAYER4, type Sprite } from './canvas';
import { C, alpha, mixRgb } from './palette';
import { drawText } from './text';

/* ------------------------------------------------------------------------------------------------ *
 *  Discs and rings (instrument drawing: stick gates, buttons)
 * ------------------------------------------------------------------------------------------------ */
export function disc(cv: PixelCanvas, cx: number, cy: number, r: number, color: number): void {
  for (let y = -r; y <= r; y++) {
    const w = Math.floor(Math.sqrt(r * r + r * 0.8 - y * y));
    cv.hline(cx - w, cy + y, w * 2 + 1, color);
  }
}

export function ringLine(
  cv: PixelCanvas,
  cx: number,
  cy: number,
  r: number,
  color: number,
  dashed = false,
): void {
  let x = r;
  let y = 0;
  let err = 1 - r;
  let n = 0;
  const plot = (px: number, py: number): void => {
    if (dashed && ((n >> 1) & 1) === 1) return;
    cv.px(px, py, color);
  };
  while (x >= y) {
    for (const [dx, dy] of [
      [x, y],
      [y, x],
      [-y, x],
      [-x, y],
      [-x, -y],
      [-y, -x],
      [y, -x],
      [x, -y],
    ] as const)
      plot(cx + dx, cy + dy);
    y++;
    n++;
    if (err < 0) err += 2 * y + 1;
    else {
      x--;
      err += 2 * (y - x) + 1;
    }
  }
}

/* ------------------------------------------------------------------------------------------------ *
 *  The Pro Controller, sculpted from a smooth-union distance field and lit from the upper left
 * ------------------------------------------------------------------------------------------------ */
export const PRO_W = 232;
export const PRO_H = 140;

/** Anchor points (sprite-local) of every control on the drawing. */
export const PRO_PARTS = {
  ls: { x: 62, y: 60 },
  rs: { x: 144, y: 96 },
  dpad: { x: 88, y: 96 },
  face: { x: 170, y: 60 },
  minus: { x: 101, y: 50 },
  plus: { x: 131, y: 50 },
  capture: { x: 103, y: 68 },
  home: { x: 129, y: 68 },
} as const;

const smin = (a: number, b: number, k: number): number => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
function sdRoundBox(
  px: number,
  py: number,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  r: number,
): number {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const sdCircle = (px: number, py: number, cx: number, cy: number, r: number): number =>
  Math.hypot(px - cx, py - cy) - r;

function bodySdf(x: number, y: number): number {
  const box = sdRoundBox(x, y, 116, 62, 84, 30, 24);
  const gl = sdCircle(x, y, 56, 98, 34);
  const gr = sdCircle(x, y, 176, 98, 34);
  return smin(smin(box, gl, 20), gr, 20);
}

const BODY_RAMP = hueShiftRamp(0.63, 0.34, 9, { lMin: 0.06, lMax: 0.5, shadowHue: 0.66, lightHue: 0.58 });
const OUTLINE = hex('#04060b');

let proBase: Sprite | null = null;

/** Static body, built once: shaded silhouette, grip texture dither, stick wells, button wells, LED strip. */
export function proBaseSprite(): Sprite {
  if (proBase) return proBase;
  const px = new Uint32Array(PRO_W * PRO_H);
  const sd = new Float32Array(PRO_W * PRO_H);
  for (let y = 0; y < PRO_H; y++)
    for (let x = 0; x < PRO_W; x++) sd[y * PRO_W + x] = bodySdf(x + 0.5, y + 0.5);
  const S = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= PRO_W || y >= PRO_H ? 1 : sd[y * PRO_W + x]!;
  for (let y = 0; y < PRO_H; y++) {
    for (let x = 0; x < PRO_W; x++) {
      const d = S(x, y);
      if (d > 0) {
        if (d < 1.2) px[y * PRO_W + x] = OUTLINE;
        continue;
      }
      // normal from the field gradient, lit from the upper left
      const nx = S(x + 1, y) - S(x - 1, y);
      const ny = S(x, y + 1) - S(x, y - 1);
      const nl = Math.hypot(nx, ny) || 1;
      const lambert = (-nx / nl) * 0.62 + (-ny / nl) * 0.78;
      const depth = Math.min(1, -d / 9); // toward the middle of the shell → flatter, darker
      const rim = Math.max(0, lambert) * Math.pow(1 - depth, 1.6);
      // face gradient: slightly lighter toward the top, darker toward the grips
      const face = 0.3 + 0.16 * (1 - y / PRO_H);
      const t = Math.min(1, face + rim * 1.05 - Math.max(0, -lambert) * 0.16 * (1 - depth));
      const f = t * (BODY_RAMP.length - 1);
      const k = Math.min(BODY_RAMP.length - 2, Math.floor(f));
      const frac = f - k;
      px[y * PRO_W + x] = frac * 16 > BAYER4[(y & 3) * 4 + (x & 3)]! ? BODY_RAMP[k + 1]! : BODY_RAMP[k]!;
    }
  }
  const base: Sprite = { pixels: px, w: PRO_W, h: PRO_H };
  const cv = new PixelCanvas(PRO_W, PRO_H, px);
  const well = hex('#05070d');
  const wellRim = hex('#2a3652');
  for (const p of [PRO_PARTS.ls, PRO_PARTS.rs]) {
    disc(cv, p.x, p.y, 15, wellRim);
    disc(cv, p.x, p.y, 14, well);
  }
  // D-pad plate
  disc(cv, PRO_PARTS.dpad.x, PRO_PARTS.dpad.y, 15, wellRim);
  disc(cv, PRO_PARTS.dpad.x, PRO_PARTS.dpad.y, 14, hex('#090c15'));
  // face-button wells
  for (const [dx, dy] of [
    [0, -13],
    [0, 13],
    [-13, 0],
    [13, 0],
  ] as const)
    disc(cv, PRO_PARTS.face.x + dx, PRO_PARTS.face.y + dy, 8, well);
  // grip texture: a sparse dither on the outer lobes
  for (let y = 84; y < 132; y++) {
    for (let x = 0; x < PRO_W; x++) {
      const d = S(x, y);
      if (d < -3 && d > -14 && ((x + y) & 3) === 0 && (x < 74 || x > 158))
        cv.px(x, y, alpha(hex('#000000'), 0.28));
    }
  }
  proBase = base;
  return base;
}

export interface PadLive {
  /** Canonical buttons 0..1 (see input `Pad`). */
  b: ArrayLike<number>;
  /** Sticks in −1..1 (+y down). */
  lx: number;
  ly: number;
  rx: number;
  ry: number;
}

const BTN_OFF = hex('#1a2238');
const BTN_OFF_RIM = hex('#39476b');

function smallBtn(cv: PixelCanvas, cx: number, cy: number, r: number, v: number, accent: number): void {
  const on = v > 0.5;
  disc(cv, cx, cy, r, on ? mixRgb(accent, C.white, 0.35) : BTN_OFF_RIM);
  disc(cv, cx, cy, r - 1, on ? accent : BTN_OFF);
  if (on) {
    cv.px(cx - 1, cy - 2, C.white);
    cv.px(cx - 2, cy - 1, C.white);
  } else cv.px(cx - Math.floor(r / 2), cy - Math.floor(r / 2) - 1, hex('#556391'));
}

function smallRect(
  cv: PixelCanvas,
  x: number,
  y: number,
  w: number,
  h: number,
  v: number,
  accent: number,
): void {
  const on = v > 0.5;
  cv.rect(x, y, w, h, on ? accent : BTN_OFF);
  cv.frame(x, y, w, h, on ? mixRgb(accent, C.white, 0.4) : BTN_OFF_RIM);
}

/**
 * Draw the controller with live state. `family` decides the face-button letters (positions are always the Pro layout: the
 * bottom button is 'B' on a Nintendo pad and 'A' on an Xbox pad). `ox, oy` is the sprite's top-left on the canvas.
 */
export function drawPro(
  cv: PixelCanvas,
  ox: number,
  oy: number,
  live: PadLive,
  accent: number,
  family: GlyphFamily,
): void {
  cv.blit(proBaseSprite(), ox, oy);
  const P = PRO_PARTS;
  const B = live.b;
  const fam = family === 'keyboard' || family === 'generic' ? 'xbox' : family;

  // shoulders: ZL/ZR as deep triggers with an analog fill, L/R as bumpers
  const trig = (x: number, y: number, w: number, h: number, v: number, left: boolean): void => {
    const px = ox + x;
    const py = oy + y;
    const rim = v > 0.5 ? mixRgb(accent, C.white, 0.4) : BTN_OFF_RIM;
    // body with the outer top corner cut (a curved trigger, in pixels)
    cv.rect(px, py + 1, w, h - 1, BTN_OFF);
    cv.rect(left ? px + 2 : px, py, w - 2, 1, BTN_OFF);
    const fh = Math.round((h - 2) * Math.min(1, v));
    if (fh > 0) cv.rect(px + 1, py + h - 1 - fh, w - 2, fh, accent);
    cv.hline(left ? px + 2 : px, py, w - 2, rim);
    cv.hline(px, py + h - 1, w, rim);
    cv.vline(px, py + 1, h - 2, rim);
    cv.vline(px + w - 1, py + 1, h - 2, rim);
    cv.px(left ? px + 1 : px + w - 2, py + 1, rim);
    cv.px(left ? px : px + w - 1, py + 1, alpha(C.void, 0));
  };
  trig(30, 4, 52, 15, B[Pad.L2] ?? 0, true);
  trig(PRO_W - 30 - 52, 4, 52, 15, B[Pad.R2] ?? 0, false);
  smallRect(cv, ox + 38, oy + 22, 64, 8, B[Pad.L1] ?? 0, accent);
  smallRect(cv, ox + PRO_W - 38 - 64, oy + 22, 64, 8, B[Pad.R1] ?? 0, accent);
  drawText(cv, padButtonLabel(fam, Pad.L2), ox + 56, oy + 8, {
    color: (B[Pad.L2] ?? 0) > 0.5 ? C.void : C.mid,
    font: 'micro',
    align: 'center',
  });
  drawText(cv, padButtonLabel(fam, Pad.R2), ox + PRO_W - 56, oy + 8, {
    color: (B[Pad.R2] ?? 0) > 0.5 ? C.void : C.mid,
    font: 'micro',
    align: 'center',
  });
  drawText(cv, padButtonLabel(fam, Pad.L1), ox + 70, oy + 24, {
    color: (B[Pad.L1] ?? 0) > 0.5 ? C.void : C.mid,
    font: 'micro',
    align: 'center',
  });
  drawText(cv, padButtonLabel(fam, Pad.R1), ox + PRO_W - 70, oy + 24, {
    color: (B[Pad.R1] ?? 0) > 0.5 ? C.void : C.mid,
    font: 'micro',
    align: 'center',
  });

  // sticks: the cap moves within its well
  for (const [p, sx, sy, pressed] of [
    [P.ls, live.lx, live.ly, B[Pad.L3] ?? 0],
    [P.rs, live.rx, live.ry, B[Pad.R3] ?? 0],
  ] as const) {
    const cx = ox + p.x + Math.round(sx * 6);
    const cy = oy + p.y + Math.round(sy * 6);
    disc(cv, cx, cy + 1, 10, hex('#02030a'));
    disc(cv, cx, cy, 10, pressed > 0.5 ? mixRgb(accent, C.white, 0.3) : hex('#2b3757'));
    disc(cv, cx, cy, 8, pressed > 0.5 ? accent : hex('#1c2540'));
    ringLine(cv, cx, cy, 5, pressed > 0.5 ? C.white : hex('#3b4a70'));
    cv.px(cx - 4, cy - 5, hex('#6a7aa5'));
    cv.px(cx - 5, cy - 4, hex('#6a7aa5'));
  }

  // D-pad
  const d = P.dpad;
  const dcol = (v: number): number => ((v ?? 0) > 0.5 ? accent : BTN_OFF);
  const arm = (dx: number, dy: number, v: number): void => {
    const w = dx === 0 ? 8 : 9;
    const h = dy === 0 ? 8 : 9;
    const x = ox + d.x + dx * 8 - (dx === 0 ? 4 : dx > 0 ? 0 : 9);
    const y = oy + d.y + dy * 8 - (dy === 0 ? 4 : dy > 0 ? 0 : 9);
    cv.rect(x, y, w, h, dcol(v));
    cv.frame(x, y, w, h, (v ?? 0) > 0.5 ? mixRgb(accent, C.white, 0.4) : BTN_OFF_RIM);
  };
  cv.rect(ox + d.x - 4, oy + d.y - 4, 8, 8, BTN_OFF);
  arm(0, -1, B[Pad.UP]!);
  arm(0, 1, B[Pad.DOWN]!);
  arm(-1, 0, B[Pad.LEFT]!);
  arm(1, 0, B[Pad.RIGHT]!);

  // face buttons at their physical positions, lettered per family
  const f = P.face;
  const faces: [number, number, number][] = [
    [0, -13, Pad.NORTH],
    [0, 13, Pad.SOUTH],
    [-13, 0, Pad.WEST],
    [13, 0, Pad.EAST],
  ];
  for (const [dx, dy, pb] of faces) {
    const v = B[pb] ?? 0;
    smallBtn(cv, ox + f.x + dx, oy + f.y + dy, 7, v, accent);
    drawText(cv, padButtonLabel(fam, pb), ox + f.x + dx, oy + f.y + dy - 2, {
      color: v > 0.5 ? C.void : C.soft,
      font: 'micro',
      align: 'center',
    });
  }

  // centre cluster
  smallRect(cv, ox + P.minus.x - 4, oy + P.minus.y - 2, 8, 4, B[Pad.SELECT] ?? 0, accent);
  smallRect(cv, ox + P.plus.x - 4, oy + P.plus.y - 2, 8, 4, B[Pad.START] ?? 0, accent);
  cv.px(ox + P.plus.x, oy + P.plus.y - 4, (B[Pad.START] ?? 0) > 0.5 ? accent : BTN_OFF_RIM);
  smallRect(cv, ox + P.capture.x - 3, oy + P.capture.y - 3, 6, 6, B[Pad.CAPTURE] ?? 0, accent);
  smallBtn(cv, ox + P.home.x, oy + P.home.y, 4, B[Pad.HOME] ?? 0, accent);
}

/* ------------------------------------------------------------------------------------------------ *
 *  Miniature device icons (assignment cards, device tabs)
 * ------------------------------------------------------------------------------------------------ */
const JOYCON = [
  '..####..',
  '.######.',
  '.#....#.',
  '.#.##.#.',
  '.#....#.',
  '.######.',
  '.######.',
  '.######.',
  '.##..##.',
  '.#.##.#.',
  '.##..##.',
  '.######.',
  '.######.',
  '.######.',
  '..####..',
];

let padIconCache: Sprite | null = null;

/** 32×18 mini gamepad built from the same smooth-union field as the big drawing. */
function miniPad(): Sprite {
  if (padIconCache) return padIconCache;
  const w = 32;
  const h = 18;
  const px = new Uint32Array(w * h);
  const sd = (x: number, y: number): number =>
    smin(
      smin(sdRoundBox(x, y, 16, 7.5, 13, 5.5, 4.5), sdCircle(x, y, 8, 11.5, 6.4), 4),
      sdCircle(x, y, 24, 11.5, 6.4),
      4,
    );
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) px[y * w + x] = sd(x + 0.5, y + 0.5) < 0 ? 0xffffffff : 0;
  padIconCache = { pixels: px, w, h };
  return padIconCache;
}

/** Draw a small icon for a device kind; returns its size. */
export function drawDeviceIcon(
  cv: PixelCanvas,
  x: number,
  y: number,
  kind: ProfileKind,
  color: number,
): { w: number; h: number } {
  const dim = mixRgb(color, C.void, 0.62);
  const dark = mixRgb(color, C.void, 0.85);
  if (kind === 'keyboard') {
    cv.rect(x + 1, y + 1, 26, 13, dim);
    cv.frame(x, y, 28, 15, color);
    for (let r = 0; r < 3; r++)
      for (let k = 0; k < (r === 2 ? 0 : 8); k++) cv.rect(x + 3 + k * 3, y + 3 + r * 3, 2, 2, color);
    cv.rect(x + 6, y + 9, 15, 2, color);
    cv.rect(x + 3, y + 9, 2, 2, color);
    cv.rect(x + 23, y + 9, 2, 2, color);
    return { w: 28, h: 15 };
  }
  if (kind === 'joycon-l' || kind === 'joycon-r') {
    for (let j = 0; j < JOYCON.length; j++)
      for (let i = 0; i < JOYCON[j]!.length; i++) {
        if (JOYCON[j]![i] === '#') cv.px(x + i + 2, y + j, j > 1 && j < 5 ? dim : color);
      }
    return { w: 12, h: 15 };
  }
  const s = miniPad();
  for (let j = 0; j < s.h; j++) {
    for (let i = 0; i < s.w; i++) {
      if (!(s.pixels[j * s.w + i]! >>> 24)) continue;
      const edge =
        !(s.pixels[j * s.w + Math.max(0, i - 1)]! >>> 24) ||
        !(s.pixels[j * s.w + Math.min(s.w - 1, i + 1)]! >>> 24) ||
        !(s.pixels[Math.max(0, j - 1) * s.w + i]! >>> 24) ||
        !(s.pixels[Math.min(s.h - 1, j + 1) * s.w + i]! >>> 24);
      cv.px(x + i, y + j, edge ? color : dim);
    }
  }
  // details: sticks, d-pad, buttons
  cv.rect(x + 7, y + 4, 3, 3, dark);
  cv.rect(x + 20, y + 10, 3, 3, dark);
  cv.hline(x + 10, y + 9, 3, dark);
  cv.vline(x + 11, y + 8, 3, dark);
  for (const [dx, dy] of [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ] as const)
    cv.px(x + 24 + dx * 2, y + 6 + dy * 2, color);
  return { w: s.w, h: s.h };
}

const iconCache = new Map<string, Sprite>();

/** A device icon as a sprite (drawn once at 1× into its own canvas) so screens can blit it at any integer scale. */
export function deviceIconSprite(kind: ProfileKind, color: number): Sprite {
  const key = `${kind}:${color}`;
  let s = iconCache.get(key);
  if (!s) {
    const cv = new PixelCanvas(36, 22);
    const size = drawDeviceIcon(cv, 1, 1, kind, color);
    void size;
    s = cv.toSprite();
    iconCache.set(key, s);
  }
  return s;
}
