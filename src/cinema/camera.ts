import type { CameraKey } from './timeline';
import { NATIVE_H, NATIVE_W } from './types';

/**
 * CineCamera (TRAILER_V3 §2.1): where the shot looks and how close, and the one place native pixels become output pixels.
 *
 * Zoom never resamples. At an output scale S (×3 = 1080p, ×6 = 2160p) every native pixel is drawn as a whole b×b block,
 * b = round(S·zoom) (at least 1): at rest on a whole zoom that is exactly ×(S·zoom); during a zoom the block grows one
 * output pixel at a time (the "next integer up, cropped" rule at the output's resolution), and the crop origin is snapped
 * so blocks always start on the output grid. The overlay (letterbox, cards) is native art drawn ×S on top, never zoomed.
 */
export interface CameraSample {
  /** World view centre, or null = follow the game camera. */
  x: number | null;
  y: number | null;
  zoom: number;
  focus: [number, number];
  shake: boolean | null;
  matter: boolean;
  /** Tracked fighter slot (held from the key), or null. */
  track: 0 | 1 | null;
  /** Quarter turns (held from the key, never interpolated). */
  dutch: number;
}

const smooth = (u: number): number => u * u * (3 - 2 * u);

/** The camera track at shot second `t`: positions eased, zoom interpolated in log space (exponential zooms). */
export function sampleCamera(keys: readonly CameraKey[] | undefined, t: number): CameraSample {
  const out: CameraSample = {
    x: null,
    y: null,
    zoom: 1,
    focus: [NATIVE_W / 2, NATIVE_H / 2],
    shake: null,
    matter: false,
    dutch: 0,
    track: null,
  };
  if (!keys || !keys.length) return out;
  let a = keys[0]!;
  let b = a;
  if (t >= keys[keys.length - 1]!.t) a = b = keys[keys.length - 1]!;
  else
    for (let i = 0; i + 1 < keys.length; i++)
      if (t >= keys[i]!.t && t < keys[i + 1]!.t) {
        a = keys[i]!;
        b = keys[i + 1]!;
      }
  const u = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
  const e = smooth(u);
  const lin = (p: number | undefined, q: number | undefined): number | null =>
    p === undefined ? (q ?? null) : q === undefined ? p : p + (q - p) * e;
  out.x = lin(a.x, b.x);
  out.y = lin(a.y, b.y);
  const za = a.zoom ?? 1;
  const zb = b.zoom ?? za;
  // exponential: equal ratios per equal time (an 18-frame snap pull-back reads as one motion), linear in u, not eased
  out.zoom = za * Math.pow(zb / za, u);
  const fa = a.focus ?? out.focus;
  const fb = b.focus ?? fa;
  out.focus = [fa[0] + (fb[0] - fa[0]) * e, fa[1] + (fb[1] - fa[1]) * e];
  out.shake = a.shake ?? null;
  out.matter = a.matter ?? false;
  out.dutch = a.dutch ?? 0;
  out.track = a.track ?? null;
  // a tracked shot's focus is an offset from the fighter (default none)
  if (out.track !== null) {
    const ta = a.focus ?? [0, 0];
    const tb = b.focus ?? ta;
    out.focus = [ta[0] + (tb[0] - ta[0]) * e, ta[1] + (tb[1] - ta[1]) * e];
  }
  return out;
}

/** Output block size (output px per native pixel) for a zoom at output scale `s`. */
export const blockSize = (zoom: number, s: number): number => Math.max(1, Math.round(s * zoom));

const lum = (scene: Uint32Array, x: number, y: number): number => {
  if (x < 0 || y < 0 || x >= NATIVE_W || y >= NATIVE_H) return 0;
  const c = scene[y * NATIVE_W + x]!;
  return (0.2126 * (c & 255) + 0.7152 * ((c >>> 8) & 255) + 0.0722 * ((c >>> 16) & 255)) / 255;
};
const LX = -0.55;
const LY = -0.62;

/**
 * MATTER CAM (TRAILER_V3 §2.1): one native pixel drawn as a lit cell of matter, b×b output pixels. Its colour is the
 * pixel's own; its relief comes from the brightness of its neighbours (a height field: a crack is a trench, a lit crust
 * plate a ridge), lit by the one titan sky (upper left), with a bevel (lit top-left rim, shaded bottom-right rim) and a
 * dark grout line between cells, so every pixel reads as a separate piece. Whole output pixels only.
 */
export function matterCell(
  scene: Uint32Array,
  nx: number,
  ny: number,
  c: number,
  cx: number,
  cy: number,
  b: number,
  relief?: Float32Array,
): number {
  // surface normal (−gx, −gy, 1) against the light: relief shading of the whole cell (memoised per native pixel)
  const ri = ny * NATIVE_W + nx;
  let k = relief ? relief[ri]! : NaN;
  if (Number.isNaN(k)) {
    const gx = lum(scene, nx + 1, ny) - lum(scene, nx - 1, ny);
    const gy = lum(scene, nx, ny + 1) - lum(scene, nx, ny - 1);
    k = Math.max(0.55, Math.min(1.35, 1 - 0.9 * (gx * LX + gy * LY)));
    if (relief) relief[ri] = k;
  }
  const e = Math.max(1, Math.round(b / 12));
  const grout = b >= 16 ? 1 : 0;
  if (cx >= b - grout || cy >= b - grout) k *= 0.42;
  else if (cx < e || cy < e) k *= 1.22;
  else if (cx >= b - grout - e || cy >= b - grout - e) k *= 0.7;
  const ch = (sh: number): number => Math.min(255, Math.round(((c >>> sh) & 255) * k)) << sh;
  return (0xff000000 | ch(16) | ch(8) | ch(0)) >>> 0;
}

/** Which of a matter cell's four looks an output pixel at (cx, cy) inside it shows: 0 grout, 1 lit rim, 2 shaded rim, 3 face. */
function matterLook(cx: number, cy: number, b: number): number {
  const e = Math.max(1, Math.round(b / 12));
  const grout = b >= 16 ? 1 : 0;
  if (cx >= b - grout || cy >= b - grout) return 0;
  if (cx < e || cy < e) return 1;
  if (cx >= b - grout - e || cy >= b - grout - e) return 2;
  return 3;
}
/** A representative in-cell position for each look (fed to matterCell, which decides the look from it). */
const LOOK_AT: [(b: number) => number, (b: number) => number][] = [
  [(b) => b - 1, (b) => b - 1],
  [() => 0, (b) => Math.floor(b / 2)],
  [(b) => b - 1 - (b >= 16 ? 1 : 0), (b) => Math.floor(b / 2)],
  [(b) => Math.floor(b / 2), (b) => Math.floor(b / 2)],
];

/**
 * Compose one output frame (RGB, 3 bytes per px) at scale `s`: the native scene zoomed around `focus` in whole blocks, the
 * native overlay ×s on top (alpha-blended per native pixel; bars and cards are opaque), black outside the picture.
 */
export function composeFrame(
  scene: Uint32Array,
  overlay: Uint32Array | null,
  zoom: number,
  focus: readonly [number, number],
  s: number,
  out?: Uint8Array,
  matter = false,
  quarterTurns = 0,
): Uint8Array {
  const W = NATIVE_W * s;
  const H = NATIVE_H * s;
  const o = out ?? new Uint8Array(W * H * 3);
  const b = blockSize(zoom, s);
  // the focus snapped to the block grid, so every native pixel spans exactly b output pixels
  const fx = Math.round(focus[0] * b) / b;
  const fy = Math.round(focus[1] * b) / b;
  // dutch angle in whole quarter turns only (a 90° turn moves pixels, it never resamples them)
  const k = ((Math.round(quarterTurns) % 4) + 4) % 4;
  const cells = matter && b >= 8;
  const relief = cells ? new Float32Array(NATIVE_W * NATIVE_H).fill(NaN) : undefined;
  // the mapping is separable (whole quarter turns): per output column and row, the native coordinate it reads and its place
  // inside the cell (screen orientation), computed once per frame
  const colN = new Int32Array(W);
  const colL = new Int32Array(W);
  const rowN = new Int32Array(H);
  const rowL = new Int32Array(H);
  const axis = (
    pos: number,
    half: number,
    f: number,
    sign: number,
    outN: Int32Array,
    outL: Int32Array,
    i: number,
  ): void => {
    const g = f + (sign * (pos - half)) / b;
    const n = Math.floor(g + 1e-9);
    outN[i] = n;
    const frac = g - n;
    outL[i] = Math.min(b - 1, Math.max(0, Math.floor((sign > 0 ? frac : 1 - frac) * b + 1e-6)));
  };
  // k 0: x→nx, y→ny; 1: x→−ny, y→nx; 2: x→−nx, y→−ny; 3: x→ny, y→−nx
  for (let x = 0; x < W; x++)
    axis(x, W / 2, k === 0 || k === 2 ? fx : fy, k === 0 || k === 3 ? 1 : -1, colN, colL, x);
  for (let y = 0; y < H; y++)
    axis(y, H / 2, k === 0 || k === 2 ? fy : fx, k === 0 || k === 1 ? 1 : -1, rowN, rowL, y);
  const cellMemo = cells ? new Map<number, number>() : null;
  for (let y = 0; y < H; y++) {
    const oyN = Math.floor(y / s);
    const rn = rowN[y]!;
    const cy = rowL[y]!;
    for (let x = 0; x < W; x++) {
      const cn = colN[x]!;
      const nx = k === 0 || k === 2 ? cn : rn;
      const ny = k === 0 || k === 2 ? rn : cn;
      let c = nx >= 0 && ny >= 0 && nx < NATIVE_W && ny < NATIVE_H ? scene[ny * NATIVE_W + nx]! : 0xff000000;
      if (cells && c !== 0xff000000) {
        const cx = colL[x]!;
        // four looks per cell (grout, lit rim, shaded rim, face): memoised per cell and look
        const look = matterLook(cx, cy, b);
        const key = (ny * NATIVE_W + nx) * 4 + look;
        let m = cellMemo!.get(key);
        if (m === undefined) {
          m = matterCell(scene, nx, ny, c, LOOK_AT[look]![0](b), LOOK_AT[look]![1](b), b, relief);
          cellMemo!.set(key, m);
        }
        c = m;
      }
      if (overlay) {
        const v = overlay[oyN * NATIVE_W + Math.floor(x / s)]!;
        const a = v >>> 24;
        if (a === 255) c = v;
        else if (a) {
          const k = a / 255;
          const mix = (sh: number): number =>
            Math.round(((v >>> sh) & 255) * k + ((c >>> sh) & 255) * (1 - k)) << sh;
          c = (0xff000000 | mix(16) | mix(8) | mix(0)) >>> 0;
        }
      }
      const i = (y * W + x) * 3;
      o[i] = c & 255;
      o[i + 1] = (c >>> 8) & 255;
      o[i + 2] = (c >>> 16) & 255;
    }
  }
  return o;
}
