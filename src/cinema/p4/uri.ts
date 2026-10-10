import { FLASH, OUTLINE, hash3, masterRamp, snap } from './palette';

/**
 * 우리's real matter for the genesis (P4): the locked rig's parts baked by WJ into two poses with per-chunk ids
 * (src/cinema/assets/uri-{a,a-id,g,g-id}.png, the same files the site's story.js uses):
 *  - a = the assembled reference pose (arms wide, fists at the bottom corners), g = the guard stance from the kinetic pass;
 *  - id maps: R = part code (1 pyL, 2 pyR, 3 pelvis, 4 uaL, 5 uaR, 6 domeL, 7 domeR, 8 chamber, 9 faL, 10 faR, 11 fistL,
 *    12 fistR, 13 moon; 200 the hot core, 201 the cold core, 255 the loop), G + (B & 127)·256 = chunk id, B ≥ 128 = emissive.
 * Measured against the game's own asset (uriPartMatter(1), the rig at rest, draw order): 92 % of the part pixels carry
 * the same part, 86 % the same chunk and 85 % the exact colour; the rest is the oracle's arm pose (the game's rest pose
 * hangs the forearms behind the fists). Colours are snapped to the master palette at bake.
 *
 * The assembly is the site's (story.js bakeUri / drawUri), ported to native buffers: each chunk waits in the wreck, is
 * hauled in, overshoots a little and welds with a flash; the windows per part are WIN below (tools/teaser/cues.json was made
 * from the same formula, so v2's clanks and v3's drum cues agree).
 */

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface UriGroup {
  key: number;
  code: number;
  /** Pixel offsets from the group's centre (x, y pairs) and their colours / glow. */
  off: Int16Array;
  col: Uint32Array;
  em: Uint8Array;
  cx: number;
  cy: number;
  seed: number;
  /** Assembly parameter at which it welds (0..1 of the genesis). */
  ta: number;
  /** Where it waits in the wreck, relative to its place (px). */
  fx: number;
  fy: number;
}

export interface UriPose {
  w: number;
  h: number;
  list: UriGroup[];
  map: Map<number, UriGroup>;
  /** The two pylon tips (bottom-most pixel of codes 1 and 2), for the thrust plumes. */
  py: [number, number, number, number];
}

export interface UriBake {
  A: UriPose;
  G: UriPose;
}

export const PART_NAMES: Record<number, string> = {
  1: 'pyL',
  2: 'pyR',
  3: 'pelvis',
  4: 'uaL',
  5: 'uaR',
  6: 'domeL',
  7: 'domeR',
  8: 'chamber',
  9: 'faL',
  10: 'faR',
  11: 'fistL',
  12: 'fistR',
  13: 'moon',
  200: 'hotCore',
  201: 'coldCore',
  255: 'loop',
};

/**
 * Assembly windows per part (share of the genesis): the cores are hauled together, the loop ignites, then chamber, hips,
 * pylons, shoulder domes, arms, the fists form, the command moon locks. story.js WIN, unchanged.
 */
export const WIN: Record<number, [number, number]> = {
  200: [0, 0.16],
  201: [0, 0.16],
  255: [0.15, 0.27],
  8: [0.2, 0.46],
  3: [0.3, 0.5],
  1: [0.36, 0.56],
  2: [0.36, 0.56],
  6: [0.44, 0.64],
  7: [0.44, 0.64],
  4: [0.54, 0.72],
  5: [0.54, 0.72],
  9: [0.6, 0.8],
  10: [0.6, 0.8],
  11: [0.68, 0.9],
  12: [0.68, 0.9],
  13: [0.86, 0.97],
};

/** story.js's h3 (sin hash): kept bit-for-bit so the weld order equals v2's. */
function h3(x: number, y: number, z: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

/** Where the two worlds' cores lie in the ruin, relative to 우리's centre (body-frame px): world A left, world B right. */
export const RUIN_CORE_OFFSET: Record<200 | 201, [number, number]> = { 200: [-250, 22], 201: [252, -12] };

function bakePose(im: RgbaImage, id: RgbaImage, withTiming: boolean): UriPose {
  const { width: w, height: h } = im;
  const c = im.data;
  const d = id.data;
  const acc = new Map<number, { code: number; xs: number[]; ys: number[]; cols: number[]; ems: number[] }>();
  let py: [number, number, number, number] = [0, 0, 0, 0];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (c[i + 3]! < 128) continue;
      const code = d[i]!;
      const ch = d[i + 1]! | ((d[i + 2]! & 127) << 8);
      const em = d[i + 2]! >> 7;
      const key = code * 65536 + ch;
      let g = acc.get(key);
      if (!g) acc.set(key, (g = { code, xs: [], ys: [], cols: [], ems: [] }));
      g.xs.push(x);
      g.ys.push(y);
      g.cols.push(snap((255 << 24) | (c[i + 2]! << 16) | (c[i + 1]! << 8) | c[i]!));
      g.ems.push(em ? 255 : 0);
      if (code === 1 && y > py[1]) py = [x, y, py[2], py[3]];
      if (code === 2 && y > py[3]) py = [py[0], py[1], x, y];
    }
  const list: UriGroup[] = [];
  const map = new Map<number, UriGroup>();
  for (const [key, a] of acc) {
    const n = a.xs.length;
    let sx = 0;
    let sy = 0;
    for (let k = 0; k < n; k++) {
      sx += a.xs[k]!;
      sy += a.ys[k]!;
    }
    const cx = sx / n;
    const cy = sy / n;
    const off = new Int16Array(n * 2);
    for (let k = 0; k < n; k++) {
      off[k * 2] = Math.round(a.xs[k]! - cx);
      off[k * 2 + 1] = Math.round(a.ys[k]! - cy);
    }
    const seed = h3(cx * 0.37, cy * 0.53, a.code);
    const win = WIN[a.code] ?? [0.3, 0.6];
    const ta = a.code === 255 ? win[1] : win[0] + 0.1 + seed * (win[1] - win[0] - 0.1);
    // waiting in the wreck: thrown out around the body (story.js); the cores wait where their worlds died
    const ang = seed * Math.PI * 2 + a.code;
    const r = 0.75 + h3(a.code, seed * 99, 3) * 0.9;
    let fx = Math.cos(ang) * w * r * 0.75;
    let fy = Math.sin(ang) * h * r * 0.6;
    if (a.code === 200 || a.code === 201) {
      const [ox, oy] = RUIN_CORE_OFFSET[a.code];
      fx = ox + w / 2 - cx;
      fy = oy + h / 2 - cy;
    }
    // the fists form from rubble close by, not from the far field
    if (a.code === 11 || a.code === 12) {
      fx *= 0.22;
      fy *= 0.22;
    }
    const g: UriGroup = {
      key,
      code: a.code,
      off,
      col: Uint32Array.from(a.cols),
      em: Uint8Array.from(a.ems),
      cx,
      cy,
      seed,
      ta: withTiming ? ta : 1,
      fx,
      fy,
    };
    list.push(g);
    map.set(key, g);
  }
  // a stable order (bake once, draw the same every time): back parts first like the rig's draw order
  const ORDER = [1, 2, 3, 4, 5, 6, 7, 255, 8, 200, 201, 9, 10, 11, 12, 13];
  list.sort((p, q) => ORDER.indexOf(p.code) - ORDER.indexOf(q.code) || p.key - q.key);
  return { w, h, list, map, py };
}

/** Bake both poses from the four decoded PNGs. */
export function bakeUri(a: RgbaImage, aId: RgbaImage, g: RgbaImage, gId: RgbaImage): UriBake {
  return { A: bakePose(a, aId, true), G: bakePose(g, gId, false) };
}

export interface Weld {
  /** Timeline seconds. */
  t: number;
  code: number;
  part: string;
  /** Pixels in the chunk. */
  size: number;
}
export interface DrumCue {
  /** Timeline seconds: the moment the part is whole (its last chunk welds). */
  t: number;
  code: number;
  part: string;
  /** Chunks and pixels in the part. */
  chunks: number;
  size: number;
  /** For the two fists: the clench (1 or 2). */
  clench?: number;
}

/** The fists clench twice: half of their chunks (by seed) weld at the first clench, the rest at the second. */
export function fistTa(g: UriGroup): number {
  const [w0, w1] = WIN[g.code]!;
  const first = g.seed < 0.5;
  return first ? w0 + (w1 - w0) * 0.45 : w1;
}
/** The command moon locks in one piece at the end of its window (it swings in on its tether as a whole). */
export const MOON_TA = WIN[13]![1];

/** The assembly parameter at which a group welds (the fists' clenches and the moon's lock override the per-chunk ta). */
export function weldTa(g: UriGroup): number {
  if (g.code === 11 || g.code === 12) return fistTa(g);
  if (g.code === 13) return MOON_TA;
  return g.ta;
}

/**
 * Every weld of the genesis in timeline seconds, and the drum cues (one per part as it completes; two per fist), for the
 * score's percussion stem and the montage's cuts. `start`/`dur`: when the genesis runs on the timeline (k 0 → 1).
 */
export function genesisCues(bake: UriBake, start: number, dur: number): { welds: Weld[]; drums: DrumCue[] } {
  const welds: Weld[] = [];
  const parts = new Map<string, DrumCue>();
  for (const g of bake.A.list) {
    if (g.code === 255) continue;
    const t = start + weldTa(g) * dur;
    const size = g.off.length / 2;
    welds.push({ t, code: g.code, part: PART_NAMES[g.code] ?? String(g.code), size });
    const clench = g.code === 11 || g.code === 12 ? (g.seed < 0.5 ? 1 : 2) : 0;
    const k = `${g.code}|${clench}`;
    const d = parts.get(k) ?? { t: 0, code: g.code, part: PART_NAMES[g.code]!, chunks: 0, size: 0 };
    d.t = Math.max(d.t, t);
    d.chunks++;
    d.size += size;
    if (clench) d.clench = clench;
    parts.set(k, d);
  }
  // the loop ignites once both hearts are in: its own cue at the end of its window
  const [, l1] = WIN[255]!;
  parts.set('255', { t: start + l1 * dur, code: 255, part: 'loop', chunks: 1, size: 0 });
  welds.sort((p, q) => p.t - q.t);
  return { welds, drums: [...parts.values()].sort((p, q) => p.t - q.t) };
}

/** How long (in k) a weld's flash lasts. */
const WELD_FLASH = 0.015;
const easeOutBack = (u: number): number => 1 + 2.2 * (u - 1) ** 3 + 1.2 * (u - 1) ** 2;
const ease = (u: number): number => u * u * (3 - 2 * u);
const clamp = (v: number, a = 0, b = 1): number => (v < a ? a : v > b ? b : v);

export interface DrawUriOpts {
  /** Assembly 0..1 (≥ 1 = whole). */
  k: number;
  /** 0..1 from the open stance to the guard. */
  morph?: number;
  /** Extra glow on the cores and the loop (the brace flare). */
  heat?: number;
  /** Scene seconds, for the drift of the waiting wreck. */
  time: number;
  /** Whole-number magnification (the launch at the camera). */
  scale?: number;
}

/**
 * Draw 우리 into a native buffer with its pose's top-left at (ox, oy) (native px). Writes colour and emissive, an outline
 * round the silhouette (the game's compose pass), and returns the welds happening now (for the shared spark VFX).
 */
export function drawUri(
  buf: { w: number; h: number; pixels: Uint32Array; emissive: Uint8Array },
  bake: UriBake,
  ox: number,
  oy: number,
  o: DrawUriOpts,
): { x: number; y: number; size: number; age: number; code: number; seed: number }[] {
  const { A, G } = bake;
  const { w: W, h: H, pixels: px, emissive: em } = buf;
  const s = Math.max(1, Math.round(o.scale ?? 1));
  const k = o.k;
  const m = ease(clamp(o.morph ?? 0));
  const heat = o.heat ?? 0;
  const occ = new Uint8Array(W * H);
  let bx0 = W;
  let by0 = H;
  let bx1 = -1;
  let by1 = -1;
  const FL = 0.13;
  const hits: { x: number; y: number; size: number; age: number; code: number; seed: number }[] = [];
  const field = masterRamp('uri.field');
  const plot = (x: number, y: number, c: number, e: number, flash: number): void => {
    x = Math.round(x);
    y = Math.round(y);
    for (let yy = 0; yy < s; yy++)
      for (let xx = 0; xx < s; xx++) {
        const X = x + xx;
        const Y = y + yy;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const i = Y * W + X;
        // the weld flash: the shared star-flash ramp, stepped (white → pale yellow → orange), cooling over its life
        px[i] = flash > 0.66 ? FLASH[5]! : flash > 0.33 ? FLASH[4]! : flash > 0.05 ? FLASH[3]! : c;
        em[i] = flash > 0.05 ? 170 : e;
        occ[i] = 1;
        if (X < bx0) bx0 = X;
        if (X > bx1) bx1 = X;
        if (Y < by0) by0 = Y;
        if (Y > by1) by1 = Y;
      }
  };
  const P = (v: number): number => v * s; // pose px → native px (the launch magnifies about the body's centre)
  const cxB = A.w / 2;
  const cyB = A.h / 2;
  const at = (gx: number, gy: number): [number, number] => [ox + cxB + P(gx - cxB), oy + cyB + P(gy - cyB)];

  for (const g of A.list) {
    const ta = weldTa(g);
    let u = 1;
    let flash = 0;
    if (k < 1) {
      // fists gather slowly (a clench), everything else is hauled and overshoots
      const fl = g.code === 11 || g.code === 12 ? 0.07 : g.code === 13 ? 0.2 : FL;
      u = clamp((k - (ta - fl)) / fl);
      // a weld flares for about 0.2 s of a 14 s genesis (k 0.015), white for its first frames, then cools
      flash = k >= ta ? Math.max(0, 1 - (k - ta) / WELD_FLASH) : 0;
      if (k >= ta && k - ta < 0.05 && g.code !== 255)
        hits.push({ ...pos(g), size: g.off.length / 2, age: k - ta, code: g.code, seed: g.key });
    }
    let dx = 0;
    let dy = 0;
    if (u < 1 && g.code !== 13) {
      const e = g.code === 11 || g.code === 12 ? ease(u) : easeOutBack(u);
      const drift = (1 - u) * 6;
      dx = g.fx * (1 - e) + Math.sin(o.time * 0.6 + g.seed * 20) * drift;
      dy = g.fy * (1 - e) + Math.cos(o.time * 0.78 + g.seed * 17) * drift;
    }
    if (g.code === 13 && u < 1) {
      // the command moon swings in on its gravity tether: a pendulum about a pivot above its seat, locking at the bottom
      // (it is not in the wreck: it arrives from out of frame when its window opens)
      if (u <= 0) continue;
      const L = 120;
      const th = (1 - easeOutBack(u)) * -2.4;
      const pivX = g.cx;
      const pivY = g.cy - L;
      dx = Math.sin(th) * L;
      dy = pivY + Math.cos(th) * L - g.cy;
      // the tether: a dotted line of field light from the pivot to the moon
      const [qx, qy] = at(pivX, pivY);
      const [mx, my] = at(g.cx + dx, g.cy + dy);
      const n = Math.ceil(Math.hypot(mx - qx, my - qy));
      for (let j = 0; j <= n; j += 2) {
        const X = Math.round(qx + ((mx - qx) * j) / n);
        const Y = Math.round(qy + ((my - qy) * j) / n);
        if (X >= 0 && Y >= 0 && X < W && Y < H) {
          px[Y * W + X] = field[Math.min(field.length - 1, 1 + (j & 2 ? 1 : 0))]!;
          em[Y * W + X] = 200;
        }
      }
    }
    if (g.code === 255) {
      // the loop ignites around its circuit once both hearts are in place
      const rev = clamp((k - 0.15) / 0.12);
      if (rev <= 0 && k < 1) continue;
      if (m > 0.5) continue; // the guard pose has its own loop
      const boost = heat * 0.5 + (k < 1 ? (1 - rev) * 0.6 : 0);
      for (let q = 0; q < g.col.length; q++) {
        const ox2 = g.off[q * 2]!;
        const oy2 = g.off[q * 2 + 1]!;
        if (k < 1 && (Math.atan2(oy2, ox2) / Math.PI + 1) / 2 > rev) continue;
        const [x, y] = at(g.cx + ox2, g.cy + oy2);
        plot(x, y, g.col[q]!, 255, boost > 0.7 ? 0.4 : 0);
      }
      continue;
    }
    // the stance change: pieces travel from the open stance to the guard; halfway they swap to the guard's own pixels
    let src = g;
    let mx = 0;
    let my = 0;
    if (m > 0) {
      const tw = G.map.get(g.key);
      if (tw) {
        if (m < 0.5) {
          mx = (tw.cx - g.cx) * m;
          my = (tw.cy - g.cy) * m;
        } else {
          src = tw;
          mx = (g.cx - tw.cx) * (1 - m);
          my = (g.cy - tw.cy) * (1 - m);
        }
      } else if (m >= 0.5) continue;
    }
    const hot = g.code === 200 || g.code === 201 ? heat : 0;
    for (let q = 0; q < src.col.length; q++) {
      const [x, y] = at(src.cx + src.off[q * 2]! + dx + mx, src.cy + src.off[q * 2 + 1]! + dy + my);
      plot(
        x,
        y,
        src.col[q]!,
        hot > 0 ? Math.max(src.em[q]!, (hot * 255) | 0) : src.em[q]!,
        Math.max(flash, hot > 0.8 ? 0.1 : 0),
      );
    }
  }
  if (m >= 0.5)
    for (const g of G.list) {
      if (A.map.has(g.key) && g.code !== 255) continue;
      for (let q = 0; q < g.col.length; q++) {
        const [x, y] = at(g.cx + g.off[q * 2]!, g.cy + g.off[q * 2 + 1]!);
        plot(x, y, g.col[q]!, g.code === 255 ? 255 : g.em[q]!, g.code === 255 && heat > 0.7 ? 0.4 : 0);
      }
    }
  // one dark outline pixel round the silhouette (UNIFICATION §4), within the body's own frame
  if (bx1 >= 0) {
    const fx0 = Math.max(1, bx0 - 1, Math.floor(ox + cxB - cxB * s - 4));
    const fx1 = Math.min(W - 2, bx1 + 1, Math.ceil(ox + cxB + cxB * s + 4));
    const fy0 = Math.max(1, by0 - 1, Math.floor(oy + cyB - cyB * s - 4));
    const fy1 = Math.min(H - 2, by1 + 1, Math.ceil(oy + cyB + cyB * s + 4));
    for (let y = fy0; y <= fy1; y++)
      for (let x = fx0; x <= fx1; x++) {
        const i = y * W + x;
        if (occ[i]) continue;
        if (occ[i - 1] || occ[i + 1] || occ[i - W] || occ[i + W]) {
          px[i] = OUTLINE;
          em[i] = 0;
        }
      }
  }
  return hits;

  function pos(g: UriGroup): { x: number; y: number } {
    const [x, y] = at(g.cx, g.cy);
    return { x, y };
  }
}

/** Pylon thrust plumes (field blue-white, emissive) under the two pylon tips; amount 0..1. */
export function drawThrust(
  buf: { w: number; h: number; pixels: Uint32Array; emissive: Uint8Array },
  bake: UriBake,
  ox: number,
  oy: number,
  amount: number,
  time: number,
): void {
  if (amount <= 0) return;
  const field = masterRamp('uri.field');
  const { w: W, h: H, pixels, emissive } = buf;
  const A = bake.A;
  const tips: [number, number][] = [
    [A.py[0], A.py[1]],
    [A.py[2], A.py[3]],
  ];
  const len = 30 * amount;
  for (const [x0, y0] of tips)
    for (let j = 0; j < len; j++) {
      const wob = Math.sin(j * 1.7 + time * 30) * (j / 12);
      const x = Math.round(ox + x0 + wob);
      const y = Math.round(oy + y0 + 2 + j);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      // hot near the nozzle, fading through the dither down the plume
      if (hash3(j, x, Math.floor(time * 30)) > 1 - j / len) continue;
      const i = y * W + x;
      pixels[i] = field[j < 6 ? field.length - 1 : j < 16 ? 1 : 0]!;
      emissive[i] = 255;
    }
}
