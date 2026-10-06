/**
 * 우리's live-drawn elements (uri/docs/URI_SPEC.md §2.2; the oracle uri/reference/demos/uri-LOCKED-kinetic-pass.html,
 * `genCore`, `drawCore`, `loopPtsK`, `orbitPts`, `drawLoopK`): the hot core, the cold core, the infinity loop with its white-hot
 * crossing and the orbit ring around the hot core. Drawn on the GPU right after the chamber part (spec §4 draw order).
 *
 * This module is the pure half: the oracle's noise (h3 / n3 / fbm, ported bit for bit), the cores' surface textures (built
 * once per radius) and the loop / orbit point lists (a few hundred points a frame: geometry, not a per-pixel renderer).
 * The deformation state of the loop (`UriLoopState`) is the kinetic system's (Phase 2B); at rest it is the identity.
 */

/** The oracle's ramps for the two world-cores (uri/src/10_parts_render.js `RP.hot`, `RP.cold`). */
export const URI_CORE_RAMPS = {
  hot: ['#1a0604', '#3a0c06', '#6a1a0a', '#9a300e', '#c45018', '#e07428', '#f49a48', '#ffc480'],
  cold: ['#0c0a2a', '#1e1a5a', '#3a2e8e', '#5a4ac0', '#8a6ee0', '#c08ef0', '#f0b8f8', '#fff0ff'],
} as const;

/** The loop's deformation (the oracle's `LOOP` springs and `STRESS`), written by the kinetic system; rest = identity. */
export interface UriLoopState {
  /** Left / right lobe scale, sideways shift (px), vertical scale, brightness (the oracle's LOOP.l/r/sh/vt/br .x). */
  l: number;
  r: number;
  sh: number;
  vt: number;
  br: number;
  /** 0..1 strain of the loop (STRESS). */
  stress: number;
  /** The tuning knob TUNE.loop (1 = authored). */
  gain: number;
}
export const URI_LOOP_REST: Readonly<UriLoopState> = Object.freeze({
  l: 1,
  r: 1,
  sh: 0,
  vt: 1,
  br: 1,
  stress: 0,
  gain: 1,
});

/**
 * What a 우리 layer carries for the live pass (proposal 172 extension, set by the 우리 behaviour on its front atlas layer):
 * world positions of the core centres (with their cradle offset already applied), the oracle's clock and spin, loop integrity
 * and the loop's deformation, and which part the live elements are drawn after (the chamber's `RenderPart.z`).
 */
export interface UriLiveFx {
  hotX: number;
  hotY: number;
  coldX: number;
  coldY: number;
  /** Core radii (the rig's, rounded as the oracle does: Math.round). */
  hotR: number;
  coldR: number;
  /** Seconds (noise clock) and the cores' spin (rad: the oracle's CSPIN, +0.25 rad/s). */
  t: number;
  spin: number;
  /** Loop integrity 0..100 (the oracle's hp). */
  hp: number;
  loop: UriLoopState;
  /** Draw the live elements right after the part with this z. */
  afterZ: number;
  /**
   * The fists' spread [left, right] (TUNING.md: rest 1.14, load 1.0 … impact ≤ 0.74), written by the kinetic system, and the
   * RenderPart.z of the left / right fist parts. The fists are drawn as rubble: every chunk on its own, pushed out from the pivot
   * by (centroid − pivot)·(spread − 1)·1.9, the field lit between the pieces when compressed (the oracle's drawFist). Needs the
   * layer's chunk plane (RenderLayer.chunk).
   */
  fistSpread?: readonly [number, number];
  /**
   * The pylons' thrust (the oracle's pylon plumes), written by the kinetic system: per pylon [left, right] the exhaust point in WORLD
   * px (the pylon's bone end joints.b, carried by the part's transform), the plume direction (rad: π/2 + part angle + the
   * pylon's vectoring angle) and the thrust (the oracle's PYL.th; drawn at max(0.15, th)). Absent = no plumes.
   */
  pylons?: readonly [UriPylon, UriPylon];
  fistZ?: readonly [number, number];
}

export interface UriPylon {
  x: number;
  y: number;
  a: number;
  th: number;
}

/** The fists' spread at rest (uri/docs/TUNING.md, Fist spread). */
export const URI_FIST_SPREAD_REST = 1.14;

/* ------------------------------------------------- the oracle's noise ------------------------------------------------- */

export function h3(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export function n3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  const a = lerp(
    lerp(h3(xi, yi, zi), h3(xi + 1, yi, zi), u),
    lerp(h3(xi, yi + 1, zi), h3(xi + 1, yi + 1, zi), u),
    v,
  );
  const b = lerp(
    lerp(h3(xi, yi, zi + 1), h3(xi + 1, yi, zi + 1), u),
    lerp(h3(xi, yi + 1, zi + 1), h3(xi + 1, yi + 1, zi + 1), u),
    v,
  );
  return lerp(a, b, w);
}
export function fbm(x: number, y: number, z: number, o: number): number {
  let s = 0;
  let a = 0.5;
  let f = 1;
  let n = 0;
  for (let i = 0; i < o; i++) {
    s += a * n3(x * f, y * f, z * f);
    n += a;
    a *= 0.5;
    f *= 2.03;
  }
  return s / n;
}

/* ------------------------------------------------- the cores ------------------------------------------------- */

/** A core's surface (the oracle's `genCore`): TW × TH cells, RGBA8 = (material 1 | 2, tone 0..255, 0, 255). */
export function coreSurface(R: number, hot: boolean): { w: number; h: number; data: Uint8Array } {
  const TAU = Math.PI * 2;
  const TW = Math.round(TAU * R);
  const TH = R * 2;
  const data = new Uint8Array(TW * TH * 4);
  for (let v = 0; v < TH; v++)
    for (let u = 0; u < TW; u++) {
      const a = (u / TW) * TAU;
      const X = Math.cos(a) * R;
      const Z = Math.sin(a) * R;
      const n = fbm(X * 0.13 + (hot ? 0 : 9), v * 0.13, Z * 0.13, 3);
      let mat: number;
      if (hot) {
        const cr = 1 - Math.abs(2 * n3(X * 0.25, v * 0.25, Z * 0.25) - 1);
        mat = cr > 0.9 ? 2 : 1;
      } else {
        const sw = Math.sin(v * 0.6 + n * 8);
        mat = sw > 0.7 ? 2 : 1;
      }
      const o = (v * TW + u) * 4;
      data[o] = mat;
      data[o + 1] = Math.max(0, Math.min(255, n * 255));
      data[o + 3] = 255;
    }
  return { w: TW, h: TH, data };
}

/* ------------------------------------------------- the loop and the orbit ------------------------------------------------- */

/** Colours of the loop's pixels (the oracle's drawLoopK). */
const C_CROSS = [255, 255, 255];
const C_FRONT_A = [248, 244, 255];
const C_FRONT_B = [214, 196, 255];
const C_BACK = [150, 130, 220];
const C_BRIGHT = [255, 250, 255];
const C_UNDER_FRONT = [170, 140, 250];
const C_UNDER_BACK = [90, 80, 170];
const C_OVER = [200, 180, 255];

/**
 * The loop's and the orbit's pixels for one frame, in the oracle's painter order: everything BEHIND the cores into `back`, the
 * rest into `front`. Each pixel is 5 floats: screen x, y (integers, the oracle's `x|0`), r, g, b (0..255). Positions are WORLD
 * minus the view origin. Returns the pixel counts.
 */
export function uriLoopPixels(
  fx: UriLiveFx,
  vx: number,
  vy: number,
  back: Float32Array,
  front: Float32Array,
): { back: number; front: number } {
  const L = fx.loop;
  const dmg = 1 - fx.hp / 100;
  const TAU = Math.PI * 2;
  let nb = 0;
  let nf = 0;
  const cap = (a: Float32Array): number => Math.floor(a.length / 5);
  const put = (front_: boolean, x: number, y: number, c: number[]): void => {
    const sx = Math.trunc(x - vx);
    const sy = Math.trunc(y - vy);
    if (front_) {
      if (nf >= cap(front)) return;
      front.set([sx, sy, c[0]!, c[1]!, c[2]!], nf++ * 5);
    } else {
      if (nb >= cap(back)) return;
      back.set([sx, sy, c[0]!, c[1]!, c[2]!], nb++ * 5);
    }
  };
  // loopPtsK (cold core → hot core)
  const A = [fx.coldX, fx.coldY];
  const B = [fx.hotX, fx.hotY];
  const mx = (A[0]! + B[0]!) / 2 + L.sh * 0.6;
  const my = (A[1]! + B[1]!) / 2;
  const dx = B[0]! - A[0]!;
  const dy = B[1]! - A[1]!;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  const loop: [number, number, number, number][] = [];
  for (let k = 0; k < 520; k++) {
    const s = (k / 520) * TAU;
    const den = 1 + Math.sin(s) ** 2;
    const lobe = Math.cos(s) > 0 ? 1 + (L.r - 1) * L.gain : 1 + (L.l - 1) * L.gain;
    const lx = ((d * Math.cos(s)) / den) * 1.3 * lobe;
    let ly = ((d * Math.sin(s) * Math.cos(s)) / den) * 1.35 * lobe * (1 + (L.vt - 1) * L.gain);
    ly += (1 + 7 * dmg + L.stress * 3) * (n3(k * 0.06, fx.t * 1.6, 3) - 0.5);
    loop.push([mx + lx * ux - ly * uy, my + lx * uy + ly * ux, Math.sin(s) * (Math.cos(s) > 0 ? 1 : -1), s]);
  }
  // orbitPts around the hot core
  const orbit: [number, number, number, number][] = [];
  {
    const R = fx.hotR * 1.6;
    const r = -0.36;
    for (let k = 0; k < 300; k++) {
      const s = (k / 300) * TAU;
      const x = Math.cos(s) * R;
      const y = Math.sin(s) * R * 0.34;
      orbit.push([
        fx.hotX + x * Math.cos(r) - y * Math.sin(r),
        fx.hotY + x * Math.sin(r) + y * Math.cos(r) + (1 + 6 * dmg) * (n3(k * 0.1, fx.t * 2, 5) - 0.5),
        Math.sin(s),
        s + 1.6,
      ]);
    }
  }
  const draw = (pts: [number, number, number, number][], isFront: boolean): void => {
    const br = L.br;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k]!;
      if (p[2] > 0 !== isFront) continue;
      if (dmg > 0.4 && n3(k * 0.2, fx.t * 6, 9) < (dmg - 0.4) * 1.2) continue;
      const cross = Math.abs(Math.sin(p[3])) < 0.1;
      let c = cross ? C_CROSS : isFront ? (k % 7 < 3 ? C_FRONT_A : C_FRONT_B) : C_BACK;
      if (br > 1.15 && isFront) c = C_BRIGHT;
      put(isFront, p[0], p[1], c);
      if (fx.hp > 40 || br > 1.2) put(isFront, p[0], p[1] + 1, isFront ? C_UNDER_FRONT : C_UNDER_BACK);
      if (br > 1.3 && isFront) put(isFront, p[0], p[1] - 1, C_OVER);
    }
  };
  // the oracle's order: loop back, orbit back, (cores), loop front, orbit front
  draw(loop, false);
  draw(orbit, false);
  draw(loop, true);
  draw(orbit, true);
  return { back: nb, front: nf };
}

/**
 * The pylon plumes (the oracle's frame(): "pylon thrust: each one independently, visibly solving momentum"): per pylon
 * 60 + 80·min(2, th) pixels along the thrust direction, a noisy width shrinking toward the tip, white-blue near the nozzle,
 * fading to deep blue. Same 5-float pixel format as uriLoopPixels; drawn on top of the whole body. Returns the pixel count.
 */
export function uriPlumePixels(fx: UriLiveFx, vx: number, vy: number, out: Float32Array): number {
  if (!fx.pylons) return 0;
  const cap = Math.floor(out.length / 5);
  let n = 0;
  fx.pylons.forEach((p, side) => {
    const sc = side === 0 ? 'L'.charCodeAt(0) : 'R'.charCodeAt(0);
    const th = Math.max(0.15, p.th);
    const len = 16 + 30 * th;
    const cnt = 60 + 80 * Math.min(2, th);
    for (let k = 0; k < cnt; k++) {
      const f = k / cnt;
      const Ln = f * len * (1 + 0.07 * Math.sin(fx.t * 9 + k * 0.7));
      const w = (1 - f) * (3 + 2 * th);
      const X = p.x + Math.cos(p.a) * Ln + (h3(k, Math.floor(fx.t * 14), sc) - 0.5) * w * Math.sin(p.a);
      const Y = p.y + Math.sin(p.a) * Ln;
      const c = f < 0.25 ? [230, 250, 255] : f < 0.6 ? [120, 170, 240] : [40, 70, 150];
      if (n >= cap) return;
      out.set([Math.trunc(X - vx), Math.trunc(Y - vy), c[0]!, c[1]!, c[2]!], n++ * 5);
    }
  });
  return n;
}
