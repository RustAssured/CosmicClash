import {
  AK,
  ANN_STRIDE,
  MAX_ANN,
  MAX_STAMPS,
  MAX_TUBES,
  MAX_WOUNDS,
  MF,
  SK,
  STAMP_STRIDE,
  TUBE_STRIDE,
  h3,
  makeMouthDrawList,
  n3,
  type MouthDrawList,
} from '@/render/mouthList';
import type { MouthCore } from './core';
import { MOUTH_CONST as C } from './tuning';

/**
 * The Mouth's look, laid out (Phase 3C): the CPU half of the locked look-dev renderer (`mouth/src/10_mouth_render_lib.js`
 * braids, strands, funnel, throat, lips, jaw-rings, claws, slime, wounds; `30_…` draw: the coil bundle, the neck, the head,
 * the tell). The prototype rasterised each primitive per pixel; here each becomes one instance of the draw list and the GPU
 * pass shades it (src/render/mouthPass.ts). Primitive order, sizes, depths and colours are the prototype's.
 *
 * Game-side additions (Gate 3A §4, D37): a fixed depth order between the three parts — coils behind, then the neck, the
 * head always in front (z offsets below); the coils and the back half of the coil-&-crush wrap are flagged for the back
 * layer (drawn behind the foe). The prototype's `Math.random` (stump spatter) is a hash of the frame.
 */

const TAU = Math.PI * 2;
/** Depth bands (Gate 3A §4): coils < neck < head; the readability marks on top of everything. */
const Z_COILS = -2000;
const Z_HEAD = 2000;
const Z_TOP = 5000;

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const lerp3 = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** The prototype's lights (y-up frame, as `flesh` uses them): key, fill, back. The sky rig turns them 180° in the screen plane. */
const LK0 = norm([0.5, -0.62, 0.6]);

/* ------------------------------------------------------------------------------------------------ *
 *  paths: flat arrays (a spine sample or a strand point: x, y, z, r, s, c, f, tx, ty, nx, ny)
 * ------------------------------------------------------------------------------------------------ */

const PS = 11;
class Path {
  d: Float64Array;
  n = 0;
  constructor(cap: number) {
    this.d = new Float64Array(cap * PS);
  }
  push(x: number, y: number, z: number, r: number, s: number, c: number, f: number): void {
    if ((this.n + 1) * PS > this.d.length) {
      const nd = new Float64Array(this.d.length * 2);
      nd.set(this.d);
      this.d = nd;
    }
    const o = this.n * PS;
    const d = this.d;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = r;
    d[o + 4] = s;
    d[o + 5] = c;
    d[o + 6] = f;
    this.n++;
  }
  /** Tangent and screen normal of each point from its neighbours (the prototype's per-path pass). */
  frames(): void {
    const d = this.d;
    for (let i = 0; i < this.n; i++) {
      const a = Math.max(0, i - 1) * PS;
      const b = Math.min(this.n - 1, i + 1) * PS;
      const tx = d[b]! - d[a]!;
      const ty = d[b + 1]! - d[a + 1]!;
      const l = Math.hypot(tx, ty) || 1;
      const o = i * PS;
      d[o + 7] = tx / l;
      d[o + 8] = ty / l;
      d[o + 9] = -ty / l;
      d[o + 10] = tx / l;
    }
  }
}

/** Catmull–Rom through control points P (x, y, z triples), at t in 0..1. */
function catmull(P: Float64Array, nP: number, t: number, out: number[]): void {
  const n = nP - 1;
  const s = Math.min(n - 1e-6, Math.max(0, t * n));
  const i = Math.floor(s);
  const f = s - i;
  const i0 = Math.max(0, i - 1);
  const i3 = Math.min(n, i + 2);
  for (let k = 0; k < 3; k++) {
    const p0 = P[i0 * 3 + k]!;
    const p1 = P[i * 3 + k]!;
    const p2 = P[(i + 1) * 3 + k]!;
    const p3 = P[i3 * 3 + k]!;
    out[k] =
      0.5 *
      (2 * p1 +
        (-p0 + p2) * f +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f +
        (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
  }
}

const cm = [0, 0, 0];
const cmPrev = [0, 0, 0];
/** The prototype's sampleSpine: 600 Catmull steps, a point every `step` px of 2-D arc length. */
function sampleSpine(P: Float64Array, nP: number, step: number, out: Path): Path {
  out.n = 0;
  catmull(P, nP, 0, cmPrev);
  out.push(cmPrev[0]!, cmPrev[1]!, cmPrev[2]!, 0, 0, 0, 0);
  let s = 0;
  let lastS = 0;
  for (let i = 1; i <= 600; i++) {
    catmull(P, nP, i / 600, cm);
    s += Math.hypot(cm[0]! - cmPrev[0]!, cm[1]! - cmPrev[1]!);
    if (s - lastS >= step || i === 600) {
      out.push(cm[0]!, cm[1]!, cm[2]!, 0, s, 0, 0);
      lastS = s;
    }
    cmPrev[0] = cm[0]!;
    cmPrev[1] = cm[1]!;
    cmPrev[2] = cm[2]!;
  }
  out.frames();
  return out;
}

/** A strand path re-measured as a spine for a sub-braid (the prototype's asSpine: 2-D arc length, keeps r, t, n). */
function asSpine(src: Path, out: Path): Path {
  out.n = 0;
  let s = 0;
  const d = src.d;
  for (let i = 0; i < src.n; i++) {
    const o = i * PS;
    if (i) s += Math.hypot(d[o]! - d[o - PS]!, d[o + 1]! - d[o + 1 - PS]!);
    out.push(d[o]!, d[o + 1]!, d[o + 2]!, d[o + 3]!, s, 0, 0);
    const q = (out.n - 1) * PS;
    out.d[q + 7] = d[o + 7]!;
    out.d[q + 8] = d[o + 8]!;
    out.d[q + 9] = d[o + 9]!;
    out.d[q + 10] = d[o + 10]!;
  }
  return out;
}

interface BraidOpts {
  n: number;
  br: (f: number, r: number) => number;
  sr: (f: number, k: number, r: number) => number;
  twist: number;
  writhe: number;
  wob: number;
  sid: number;
  phase: number;
}

/** The prototype's braidPaths over an already sampled spine: N strands on circles round it (screen normal × cos, depth × sin). */
function braid(sp: Path, o: BraidOpts, t: number, out: Path[]): void {
  const total = sp.d[(sp.n - 1) * PS + 4]! || 1;
  const d = sp.d;
  for (let k = 0; k < o.n; k++) {
    const path = out[k]!;
    path.n = 0;
    const ph0 = (k / o.n) * TAU + o.phase;
    for (let i = 0; i < sp.n; i++) {
      const q = i * PS;
      const Ss = d[q + 4]!;
      const f = Ss / total;
      const BR = o.br(f, d[q + 3]!);
      const SR = o.sr(f, k, d[q + 3]!);
      const ph = ph0 + Ss * o.twist + t * o.writhe + Math.sin(Ss * 0.02 + k + t * 0.7) * 0.25;
      const wob = (n3(Ss * 0.03, k * 3.1 + o.sid, t * 0.4) - 0.5) * o.wob;
      const off = BR + wob;
      const c = Math.cos(ph);
      path.push(
        d[q]! + d[q + 9]! * c * off,
        d[q + 1]! + d[q + 10]! * c * off,
        d[q + 2]! + Math.sin(ph) * off,
        SR,
        Ss,
        c,
        f,
      );
    }
    path.frames();
  }
}

/** Hash → 0..1 for the prototype's per-frame random spatter (deterministic per frame). */
const rnd = (a: number, b: number, c: number): number => h3(a | 0, b | 0, c | 0);

export interface MouthLook {
  /** Light rig: 0 the oracle's own, 1 the one titan sky (the game). */
  sky: number;
  /** Readability marks (the tell ring, the speed echo, the predicted path). */
  tell: boolean;
}

export class MouthGeom {
  readonly list: MouthDrawList = makeMouthDrawList();
  /** The coil bundle is redrawn a few times a second or when the body slides (the prototype's cache). */
  private coilTubes = new Float32Array(3000 * TUBE_STRIDE);
  private nCoilTubes = 0;
  private coilStamps = new Float32Array(1500 * STAMP_STRIDE);
  private nCoilStamps = 0;
  private coilT = -1e9;
  private coilS = -1e9;
  private trail: { x: number; y: number; a: number }[] = [];
  private lastT = -1;
  private frame = 0;
  private LK: V3 = LK0;
  private zBias = 0;
  private flagsNow = 0;
  /** Scratch paths. */
  private readonly spine = new Path(1024);
  private readonly subSpine = new Path(512);
  private readonly mainPaths = [0, 1, 2, 3].map(() => new Path(256));
  private readonly subPaths = [0, 1, 2, 3].map(() => new Path(256));
  private readonly neckPaths = [0, 1, 2, 3, 4, 5, 6, 7].map(() => new Path(512));
  private readonly ctrl = new Float64Array(64 * 3);
  /** Neck strand total arc lengths (for wound positions). */
  private readonly neckLen = new Float64Array(8);
  /** Coil wrap state for this build. */
  private wrap: [number, number, number, number, number] | null = null;

  /** Lay the Mouth out for this frame. */
  build(core: MouthCore, look: MouthLook): MouthDrawList {
    const L = this.list;
    L.nTubes = 0;
    L.nStamps = 0;
    L.nAnn = 0;
    L.nWounds = 0;
    L.clip[7] = 0;
    L.t = core.t;
    L.sky = look.sky;
    L.version++;
    this.frame++;
    // the sky rig turns the prototype's lights 180° in the screen plane (its key comes from the lower right; the one sky's from
    // the upper left): the same rig, the shared direction (UNIFICATION §1)
    this.LK = look.sky ? [-LK0[0], -LK0[1], LK0[2]] : LK0;
    const t = core.t;
    const dtS = this.lastT < 0 ? 1 / 60 : Math.max(0, t - this.lastT);
    this.lastT = t;
    const I = core.I;
    const ko = core.dmg.ko;
    this.wrap = core.move?.wrap ?? null;
    const pay = core.pay();

    // ---- the coils: redrawn a few times a second, or when the body slides ----
    if (t - this.coilT > 3.5 / 60 || Math.abs(core.s - this.coilS) > 4 || ko || t < this.coilT) {
      this.buildCoils(core, pay, t);
      this.coilT = t;
      this.coilS = core.s;
    }
    L.tubes.set(this.coilTubes.subarray(0, this.nCoilTubes * TUBE_STRIDE), 0);
    L.nTubes = this.nCoilTubes;
    L.stamps.set(this.coilStamps.subarray(0, this.nCoilStamps * STAMP_STRIDE), 0);
    L.nStamps = this.nCoilStamps;

    // ---- the neck: the feel's samples, up to where the funnel begins; a swallowing bulge travels up it ----
    this.zBias = 0;
    this.flagsNow = 0;
    const NS = C.neckSamples;
    const nk = core.neck;
    const hx = core.hdX;
    const hy = core.hdY;
    const Rh = C.Rh;
    const bq = (NS - 4) * 4;
    let ax = hx - nk[bq]!;
    let ay = hy - nk[bq + 1]!;
    const al = Math.hypot(ax, ay) || 1;
    ax /= al;
    ay /= al;
    const a3: V3 = [ax * 0.85, ay * 0.85, 0.52];
    const HL = Rh * C.funnel;
    const sev = !!ko && ko.type === 'sever';
    const B: V3 = sev ? [hx, hy, 20] : [hx - ax * 0.85 * HL, hy - ay * 0.85 * HL, 20 - 0.52 * HL];
    const P = this.ctrl;
    let nP = 0;
    for (let i = 0; i < NS; i++) {
      const qx = nk[i * 4]!;
      const qy = nk[i * 4 + 1]!;
      if (!sev && Math.hypot(qx - hx, qy - hy) < HL * 0.92 && i > 2) break;
      let z = 40 - i * 0.8 + Math.sin(t + i * 0.5) * 4;
      // the true wrap (Gate 3A §3): round the foe the strands alternate depth, the front half over it, the back half behind
      const w = this.wrap;
      if (w && i / (NS - 1) > 0.55) z += 50 * Math.sin(Math.atan2(qy - w[1], qx - w[0]));
      P[nP * 3] = qx;
      P[nP * 3 + 1] = qy;
      P[nP * 3 + 2] = z;
      nP++;
    }
    P[nP * 3] = B[0];
    P[nP * 3 + 1] = B[1];
    P[nP * 3 + 2] = B[2];
    nP++;
    if (nP >= 4) {
      const sw = (t * 0.3) % 1.3;
      let plen = 0;
      for (let i = 1; i < nP; i++)
        plen += Math.hypot(P[i * 3]! - P[i * 3 - 3]!, P[i * 3 + 1]! - P[i * 3 - 2]!);
      const vol = Math.max(0.82, Math.min(1.22, Math.sqrt(250 / Math.max(120, plen))));
      const sp = sampleSpine(P, nP, 3, this.spine);
      braid(
        sp,
        {
          n: 8,
          br: (f) => (25 - 7 * f + Math.max(0, (f - 0.88) / 0.12) * 7) * vol,
          sr: (f, k) =>
            (14.5 - 4.5 * f) *
            vol *
            (1 + 0.2 * Math.sin(k * 1.7 + f * 9)) *
            (1 + 0.25 * Math.exp(-Math.pow((f - sw) / 0.08, 2))),
          twist: 0.034,
          writhe: 0.7,
          wob: 4,
          sid: 30,
          phase: -pay * 4,
        },
        t,
        this.neckPaths,
      );
      const SF = core.dmg.severF;
      for (let k = 0; k < 8; k++) {
        const q = this.neckPaths[k]!;
        this.neckLen[k] = q.n ? q.d[(q.n - 1) * PS + 4]! : 0;
        const cut = k < 6 ? SF[k]! : Math.min(SF[k - 6]!, SF[(k - 4) % 6]!);
        let n = q.n;
        if (cut < 1) {
          // beyond the cut the strand is gone; the stump drips
          n = 0;
          while (n < q.n && q.d[n * PS + 6]! < cut) n++;
          if (n > 0) {
            const e = (n - 1) * PS;
            const ex = q.d[e]!;
            const ey = q.d[e + 1]!;
            const ez = q.d[e + 2]!;
            const er = q.d[e + 3]!;
            for (let j = 0; j < 8; j++) {
              const X = Math.round(ex + (rnd(this.frame, k, j) - 0.5) * er * 1.6);
              const Y = Math.round(ey + (rnd(this.frame, k, j + 50) - 0.5) * er * 1.6 + j * 0.6);
              if (j % 3) this.pixel(X, Y, ez + er + 1, 220, 40, 30, true);
              else this.pixel(X, Y, ez + er + 1, 255, 120, 80, true);
            }
            const dl = Math.round(8 + 6 * Math.sin(t * 2 + k));
            for (let j = 0; j < dl; j++) {
              const Y = Math.round(ey + er + j);
              if (j === dl - 1) this.pixel(Math.round(ex), Y, ez + er, 255, 200, 190, false);
              else this.pixel(Math.round(ex), Y, ez + er, 150, 30, 40, false);
            }
          }
        }
        if (n > 1) this.drawPath(q, n, 30 + k, 0, 5, true);
      }
      // slime between the neck's strands
      for (let k = 0; k < 4; k++) {
        const A = this.neckPaths[k % 6]!;
        const Bp = this.neckPaths[(k + 2) % 6]!;
        const i = Math.floor((0.15 + k * 0.17) * A.n);
        const j = Math.min(Bp.n - 1, i + 1);
        if (i < A.n && j >= 0 && j < Bp.n) {
          const pa: V3 = [A.d[i * PS]!, A.d[i * PS + 1]!, A.d[i * PS + 2]!];
          const pb: V3 = [Bp.d[j * PS]!, Bp.d[j * PS + 1]!, Bp.d[j * PS + 2]!];
          const dd = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
          if (dd > 6 && dd < 45) this.slime(pa, pb, 4 + k, t, k * 5 + 50);
        }
      }
    }
    // the wounds, in the strands' own arc length (the sim keeps them as neck fractions / coil offsets)
    this.packWounds(core);

    // ---- the head ----
    const D = core.dmg;
    const HB = core.HB;
    const ringAlive = [0, 1, 2, 3].map((g) => core.ringHealth(g) > 0);
    this.zBias = Z_HEAD;
    if (sev && ko) {
      const Lo = core.loose;
      const k = t - ko.t0;
      this.head(
        [Lo.x, Lo.y, 20],
        norm([Math.cos(Lo.roll * 0.5) * 0.8, Math.sin(Lo.roll * 0.5) * 0.8, 0.5]),
        Rh,
        t,
        {
          neckR: 17,
          open: 1.4,
          rs: 0.75,
          spinT: core.ringSpin,
          roll: Lo.roll,
          gape: 1.5,
          spread: -0.6,
          jit: 0,
          grind: 0,
          pulse: 0,
          broken: D.broken,
          alive: ringAlive.map((h, i) => h && !(k > 1 + i * 0.6)),
          gaps: D.ringGaps,
        },
      );
    } else {
      const k = ko ? t - ko.t0 : 0;
      this.head([hx, hy, 20], a3, Rh, t, {
        neckR: C.neckR,
        open: core.open,
        rs: (1 - core.clampV * 0.24) * (ko ? Math.max(0.45, 1 - k * 0.25) : 1),
        spinT: core.ringSpin,
        roll: HB.roll,
        gape: Math.max(0.3, HB.gape),
        spread: HB.spread,
        jit: HB.jit,
        grind: HB.grind,
        pulse: HB.pulse,
        broken: D.broken,
        alive: ringAlive.map((h, i) => h && !(ko && k > 2.5 + i * 0.5)),
        gaps: D.ringGaps,
      });
    }
    this.zBias = 0;

    // ---- readability: the tell (a pulsing red ring), the speed echo, the predicted path ----
    const sp = Math.hypot(core.hdVx, core.hdVy);
    if (sp > 420) this.trail.push({ x: hx, y: hy, a: 1 });
    for (const q of this.trail) q.a -= dtS * 4;
    this.trail = this.trail.filter((q) => q.a > 0);
    if (look.tell) {
      const lab = I.label;
      if (core.move && (lab === 'load' || lab === 'reach'))
        this.ringPx(hx, hy, Rh * 1.5, 255, 90, 70, true, Z_TOP);
      for (const q of this.trail) if (q.a > 0.3) this.ringPx(q.x, q.y, Rh * 0.55, 220, 170, 170, false, -10);
      const path = core.move?.path;
      if (path && lab === 'load') this.dashes(path);
    }
    this.bounds(core);
    return L;
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  emitters
   * ------------------------------------------------------------------------------------------------ */

  private tube(
    p0: ArrayLike<number>,
    p1: ArrayLike<number>,
    r0: number,
    r1: number,
    u0: number,
    u1: number,
    sid: number,
    deep: number,
    flags: number,
  ): void {
    const L = this.list;
    if (L.nTubes >= MAX_TUBES) return;
    const o = L.nTubes++ * TUBE_STRIDE;
    const T = L.tubes;
    T[o] = p0[0]!;
    T[o + 1] = p0[1]!;
    T[o + 2] = p0[2]!;
    T[o + 3] = r0;
    T[o + 4] = p1[0]!;
    T[o + 5] = p1[1]!;
    T[o + 6] = p1[2]!;
    T[o + 7] = r1;
    T[o + 8] = u0;
    T[o + 9] = u1;
    T[o + 10] = sid;
    T[o + 11] = deep;
    T[o + 12] = flags | this.flagsNow;
    T[o + 13] = this.zBias;
    T[o + 14] = 0;
    T[o + 15] = 0;
  }

  private stamp(
    kind: number,
    x0: number,
    y0: number,
    z0: number,
    w: number,
    x1: number,
    y1: number,
    z1: number,
    a: number,
    b: number,
    c: number,
    d: number,
    r: number,
    g: number,
    bl: number,
    flags: number,
  ): void {
    const L = this.list;
    if (L.nStamps >= MAX_STAMPS) return;
    const o = L.nStamps++ * STAMP_STRIDE;
    const S = L.stamps;
    S[o] = x0;
    S[o + 1] = y0;
    S[o + 2] = z0 + this.zBias;
    S[o + 3] = w;
    S[o + 4] = x1;
    S[o + 5] = y1;
    S[o + 6] = z1 + this.zBias;
    S[o + 7] = kind;
    S[o + 8] = a;
    S[o + 9] = b;
    S[o + 10] = c;
    S[o + 11] = d;
    S[o + 12] = r;
    S[o + 13] = g;
    S[o + 14] = bl;
    S[o + 15] = flags | this.flagsNow;
  }

  /** One pixel (the prototype's `put` of a fixed colour). */
  private pixel(x: number, y: number, z: number, r: number, g: number, b: number, em: boolean): void {
    this.stamp(SK.PIXEL, x, y, z, 0, x, y, z, 0, 0, 0, 0, r, g, b, em ? MF.EMIS : 0);
  }

  /** A claw: a broad root in a wet gum, curving forward to a point. Returns the tip. */
  private claw(base: V3, dirIn: V3, fwd: V3, ln: number, w: number, gum = true): V3 {
    this.clawS(base[0], base[1], base[2], dirIn[0], dirIn[1], dirIn[2], fwd[0], fwd[1], fwd[2], ln, w, gum);
    const t = this.tipS;
    return [t[0]!, t[1]!, t[2]!];
  }

  private readonly tipS = new Float64Array(3);
  /** The claw on scalars (the jaw-rings' hundreds of claws, allocation-free); the tip lands in `tipS`. */
  private clawS(
    bx: number,
    by: number,
    bz: number,
    dx: number,
    dy: number,
    dz: number,
    fx: number,
    fy: number,
    fz: number,
    ln: number,
    w: number,
    gum: boolean,
  ): void {
    const mx = bx + dx * ln * 0.55 + fx * ln * 0.12;
    const my = by + dy * ln * 0.55 + fy * ln * 0.12;
    const mz = bz + dz * ln * 0.55 + fz * ln * 0.12;
    const tx = mx + dx * ln * 0.22 + fx * ln * 0.5;
    const ty = my + dy * ln * 0.22 + fy * ln * 0.5;
    const tz = mz + dz * ln * 0.22 + fz * ln * 0.5;
    if (gum)
      this.stamp(SK.GUM, Math.round(bx), Math.round(by), bz + 1, 2.12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    this.stamp(SK.TOOTH, bx, by, bz, w, mx, my, mz, 0, 0, 0, 0, 0, 0, 0, 0);
    this.stamp(SK.TOOTH, mx, my, mz, w * 0.62, tx, ty, tz, 0, 0, 0, 0, 0, 0, 0, 0);
    this.tipS[0] = tx;
    this.tipS[1] = ty;
    this.tipS[2] = tz;
  }

  /** Spines and barbs: bone hooks raking backward off the strands (a curve, as three straight pieces). */
  private barb(p: V3, dir: V3, ln: number, w: number): void {
    const bx = -dir[1] * 0.35;
    const by = dir[0] * 0.35;
    const at = (f: number): V3 => [
      p[0] + dir[0] * ln * f + bx * ln * f * f,
      p[1] + dir[1] * ln * f + by * ln * f * f,
      p[2] + dir[2] * ln * f + 2,
    ];
    const f = [0, 0.4, 0.7, 1];
    for (let i = 0; i < 3; i++) {
      const a = at(f[i]!);
      const b = at(f[i + 1]!);
      // a: the curve's start f, b: its end f; width tapers w·(1 − f) (≥ 0.5); the colour switches red → bone at f 0.4
      this.stamp(
        SK.BARB,
        a[0],
        a[1],
        a[2],
        w,
        b[0],
        b[1],
        b[2],
        f[i]!,
        f[i + 1]!,
        dir[0],
        dir[1],
        0,
        0,
        0,
        0,
      );
    }
  }

  /** Slime: a thread of mucus stretched between surfaces, sagging, beaded (fixed pixels). */
  private slime(p0: V3, p1: V3, sag: number, t: number, seed: number): void {
    const n = Math.max(4, Math.ceil(Math.hypot(p1[0] - p0[0], p1[1] - p0[1])));
    const thick = h3(seed, 1, 2) > 0.7 ? 2 : 1;
    for (let k = 0; k <= n; k++) {
      const f = k / n;
      const sw = Math.sin(Math.PI * f);
      const q = lerp3(p0, p1, f);
      const X = Math.round(q[0] + Math.sin(t * 1.3 + seed + f * 3) * sw * 2);
      const Y = Math.round(q[1] + sag * sw + Math.cos(t + seed) * sw * 1.5);
      const glint = (k + Math.floor(t * 6) + seed) % 11 === 0;
      if (glint) this.pixel(X, Y, q[2] + 3, 255, 236, 236, true);
      else if (f < 0.12 || f > 0.88) this.pixel(X, Y, q[2] + 3, 150, 60, 70, false);
      else this.pixel(X, Y, q[2] + 3, 214, 150, 156, false);
      if (thick > 1 && f > 0.1 && f < 0.9) this.pixel(X, Y + 1, q[2] + 3, 120, 50, 60, false);
      // beads gather where the thread sags most
      if (Math.abs(f - 0.5) < 0.04 && h3(seed, 3, 4) > 0.5)
        for (let dy = 1; dy <= 2; dy++)
          if (dy === 2) this.pixel(X, Y + dy, q[2] + 3, 255, 220, 220, false);
          else this.pixel(X, Y + dy, q[2] + 3, 190, 110, 118, false);
    }
  }

  /** A ring of single pixels (the tell, the speed echo). */
  private ringPx(
    cx: number,
    cy: number,
    r: number,
    R: number,
    G: number,
    B: number,
    em: boolean,
    z: number,
  ): void {
    const n = Math.ceil(TAU * r);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU;
      this.pixel(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), z, R, G, B, em);
    }
  }

  /** The predicted path in the wind-up (the prototype's dashed quadratic, 2 px wide at 55 %: here a checker-dithered dash). */
  private dashes(p: readonly number[]): void {
    const [ax, ay, mx, my, bx, by] = p as [number, number, number, number, number, number];
    let prevX = ax;
    let prevY = ay;
    let s = 0;
    for (let i = 1; i <= 240; i++) {
      const u = i / 240;
      const q = 1 - u;
      const x = q * q * ax + 2 * q * u * mx + u * u * bx;
      const y = q * q * ay + 2 * q * u * my + u * u * by;
      s += Math.hypot(x - prevX, y - prevY);
      prevX = x;
      prevY = y;
      if (s % 9 >= 4) continue;
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const X = Math.round(x) + dx;
          const Y = Math.round(y) + dy;
          if ((X + Y) & 1) continue;
          this.pixel(X, Y, Z_TOP, 255, 140, 110, false);
        }
    }
  }

  /** A strand path drawn as tubes (the prototype's drawPath), with barbs on the neck. */
  private drawPath(path: Path, n: number, sid: number, deep: number, barbs: number, neck: boolean): void {
    const d = path.d;
    const w = neck ? this.wrap : null;
    for (let i = 1; i < n; i++) {
      const a = (i - 1) * PS;
      const b = i * PS;
      if (d[b + 3]! < 0.4) continue;
      let fl = (i === 1 ? MF.CAP0 : 0) | (i === n - 1 ? MF.CAP1 : 0);
      // the wrap's back half goes behind the foe (Gate 3A §3)
      if (w && d[b + 6]! > 0.55 && Math.sin(Math.atan2(d[b + 1]! - w[1], d[b]! - w[0])) < 0) fl |= MF.BACK;
      this.tube(
        [d[a]!, d[a + 1]!, d[a + 2]!],
        [d[b]!, d[b + 1]!, d[b + 2]!],
        d[a + 3]!,
        d[b + 3]!,
        d[a + 4]!,
        d[b + 4]!,
        sid,
        deep,
        fl,
      );
      if (barbs && i % barbs === sid % barbs && d[b + 6]! > 0.08 && d[b + 6]! < 0.94 && d[b + 3]! > 1.6) {
        const side = Math.sign(d[b + 5]!) || 1;
        const nx = d[b + 9]!;
        const ny = d[b + 10]!;
        const tx = d[b + 7]!;
        const ty = d[b + 8]!;
        const r = d[b + 3]!;
        const dir = norm([nx * side * 0.9 - tx * 0.6, ny * side * 0.9 - ty * 0.6, 0.15]);
        const saved = this.flagsNow;
        if (fl & MF.BACK) this.flagsNow |= MF.BACK;
        this.barb(
          [d[b]! + nx * side * r, d[b + 1]! + ny * side * r, d[b + 2]!],
          dir,
          r * 0.8 + 2 + h3(i, sid, 3) * 5,
          1.2,
        );
        this.flagsNow = saved;
      }
    }
  }

  /** The coil bundle (the prototype's drawBundleF): four rope-strands each braided from four, slime between them. */
  private buildCoils(core: MouthCore, pay: number, t: number): void {
    const L = this.list;
    const saveT = L.nTubes;
    const saveS = L.nStamps;
    L.nTubes = 0;
    L.nStamps = 0;
    this.zBias = Z_COILS;
    this.flagsNow = MF.BACK;
    const OFFS = [-330, -240, -150, -70, 0, 80, 160, 250, 340];
    const depth = [-130, -40, -100, 0, -50 + pay * 20, 8, -95, -30, -130];
    const P = this.ctrl;
    const e = { px: 0, py: 0, nx: 0, ny: 0 };
    for (let i = 0; i < 9; i++) {
      core.edgeAt(core.s + OFFS[i]! * (1 - pay * 0.18), e);
      const dd = (depth[i]! - core.koDrag * 150) * (1 - pay * 0.35) + Math.sin(t * 0.32 + i * 1.3) * 12;
      P[i * 3] = e.px + e.nx * dd;
      P[i * 3 + 1] = e.py + e.ny * dd;
      P[i * 3 + 2] = 62 + Math.sin(t * 0.3 + i) * 10;
    }
    const sp = sampleSpine(P, 9, 6, this.spine);
    braid(
      sp,
      {
        n: 4,
        br: (f) => 35 + 5 * Math.sin(f * 9 + t * 0.4),
        sr: (f, k) => 27 + 5 * Math.sin(f * 7 + k * 2 + t * 0.5) + 4 * Math.sin(f * 23 + k),
        twist: 0.02,
        writhe: 0.3 + pay * 0.5,
        wob: 9,
        sid: 10,
        phase: -pay * 3,
      },
      t,
      this.mainPaths,
    );
    for (let k = 0; k < 4; k++) {
      const ss = asSpine(this.mainPaths[k]!, this.subSpine);
      braid(
        ss,
        {
          n: 4,
          br: (_f, r) => r * 0.5,
          sr: (f, j, r) => r * (0.5 + 0.1 * Math.sin(f * 17 + j * 2.1 + k)),
          twist: 0.05,
          writhe: 0.5,
          wob: 3,
          sid: 100 + k * 3,
          phase: 0,
        },
        t,
        this.subPaths,
      );
      for (let j = 0; j < 4; j++)
        this.drawPath(this.subPaths[j]!, this.subPaths[j]!.n, 100 + k * 3 + j, 0.1, 0, false);
    }
    for (let k = 0; k < 5; k++) {
      const A = this.mainPaths[k % 4]!;
      const Bp = this.mainPaths[(k + 1) % 4]!;
      const i = Math.floor((k * 0.19 + 0.12) * A.n) % A.n;
      const j = Math.min(Bp.n - 1, i + 2);
      const pa: V3 = [A.d[i * PS]!, A.d[i * PS + 1]!, A.d[i * PS + 2]! + A.d[i * PS + 3]! * 0.7];
      const pb: V3 = [Bp.d[j * PS]!, Bp.d[j * PS + 1]!, Bp.d[j * PS + 2]! + Bp.d[j * PS + 3]! * 0.7];
      if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) < 90) this.slime(pa, pb, 8 + k * 2, t, k * 13 + 3);
    }
    // keep the bundle (tubes and stamps) for the frames until the next redraw
    if (this.coilTubes.length < L.nTubes * TUBE_STRIDE)
      this.coilTubes = new Float32Array(L.nTubes * TUBE_STRIDE);
    this.coilTubes.set(L.tubes.subarray(0, L.nTubes * TUBE_STRIDE));
    this.nCoilTubes = L.nTubes;
    if (this.coilStamps.length < L.nStamps * STAMP_STRIDE)
      this.coilStamps = new Float32Array(L.nStamps * STAMP_STRIDE);
    this.coilStamps.set(L.stamps.subarray(0, L.nStamps * STAMP_STRIDE));
    this.nCoilStamps = L.nStamps;
    L.nTubes = saveT;
    L.nStamps = saveS;
    this.zBias = 0;
    this.flagsNow = 0;
  }

  /** The sim's wounds in the shader's terms: (strand id, arc length px, half length px). */
  private packWounds(core: MouthCore): void {
    const L = this.list;
    const W = L.wounds;
    let n = 0;
    for (const w of core.wounds) {
      if (n >= MAX_WOUNDS) break;
      if (w.part === 'neck') {
        const tot = this.neckLen[w.k] || 250;
        W[n * 4] = 30 + w.k;
        W[n * 4 + 1] = w.u * tot;
        W[n * 4 + 2] = w.len * 250;
      } else {
        const k = w.k & 3;
        const j = (w.k >> 2) & 3;
        W[n * 4] = 100 + k * 3 + j;
        W[n * 4 + 1] = w.u + 330;
        W[n * 4 + 2] = w.len;
      }
      W[n * 4 + 3] = 0;
      n++;
    }
    L.nWounds = n;
  }

  /** The head: a funnel of flesh opening into a throat of claws, inside an armillary of jaw-rings (the prototype's `head`). */
  private head(
    Cp: V3,
    a0: V3,
    Rh0: number,
    t: number,
    o: {
      neckR: number;
      open: number;
      rs: number;
      spinT: number;
      roll: number;
      gape: number;
      spread: number;
      jit: number;
      grind: number;
      pulse: number;
      broken: readonly string[];
      alive: readonly boolean[];
      gaps: readonly (readonly [number, number])[][];
    },
  ): void {
    const L = this.list;
    const a = norm(a0);
    let [u, w] = this.basis(a);
    const tips: V3[] = [];
    // the whole head rolls about its own axis — slowly at rest, wrenching in the wind-up
    if (o.roll) {
      const cr = Math.cos(o.roll);
      const sr = Math.sin(o.roll);
      const u2 = add(mul(u, cr), mul(w, sr));
      const w2 = sub(mul(w, cr), mul(u, sr));
      u = u2;
      w = w2;
    }
    const Rh = Rh0 * (1 + (o.pulse || 0));
    const BRK = new Set(o.broken);
    const gape = o.gape || 1;
    const spread = o.spread || 0;
    const jit = o.jit || 0;
    const grind = o.grind || 0;
    // the funnel: the neck flaring into the mouth, ribbed
    const HL = 1.9;
    const B = sub(Cp, mul(a, Rh * HL));
    const Rn = o.neckR;
    let prevP = B;
    let prevR = Rn;
    for (let k = 1; k <= 7; k++) {
      const f = k / 7;
      const ribs = 1 + 0.06 * Math.max(0, Math.sin(f * 13 - t * 1.4));
      const rk = (Rn + (Rh * 0.96 - Rn) * Math.pow(f, 1.25)) * ribs;
      const ck = lerp3(B, Cp, f * 0.97);
      this.tube(prevP, ck, prevR, rk, (k - 1) * 14, k * 14, 94 + k, -0.08, MF.WARM | (k === 1 ? MF.CAP0 : 0));
      prevP = ck;
      prevR = rk;
    }
    // the mouth opening: whatever is inside it is seen through the hollow funnel
    const det0 = u[0] * w[1] - u[1] * w[0];
    const RO = Rh * 0.74 * Math.min(1.25, gape);
    L.clip[0] = Cp[0];
    L.clip[1] = Cp[1];
    L.clip[2] = u[0];
    L.clip[3] = u[1];
    L.clip[4] = w[0];
    L.clip[5] = w[1];
    L.clip[6] = RO;
    L.clip[7] = Math.abs(det0) < 0.05 ? 2 : 1;
    // the throat: a gullet of wet rings, curved claws round each, a red glow at the bottom (clipped, drawn through the funnel)
    const zb = this.zBias;
    this.zBias = zb + Rh * 3;
    this.flagsNow |= MF.CLIP;
    const Dd = 5;
    for (let k = Dd; k >= 0; k--) {
      const ck = sub(Cp, mul(a, k * Rh * 0.22 + Rh * 0.05));
      const rk = Rh * (0.7 - k * 0.1);
      const rn = k < Dd ? Rh * (0.7 - (k + 1) * 0.1) : 0;
      this.annulus(ck, a, u, w, rn * 0.85, rk * 1.05, k === Dd ? AK.MAW : AK.THROAT, k, rn, rk, gape);
      const nt = Math.round(11 - k * 1.2);
      for (let j = 0; j < nt; j++) {
        const th = (j / nt) * TAU + k * 0.41 + Math.sin(t * 0.8 + k) * 0.05;
        const dir = add(mul(u, Math.cos(th)), mul(w, Math.sin(th)));
        const base = add(ck, mul(dir, rk * 0.98));
        const ln = rk * (0.36 + 0.2 * h3(j, k, 9)) * (o.open || 1);
        if (BRK.has(`t${k}_${j}`)) {
          this.claw(base, mul(dir, -1), a, ln * 0.25, 3.4 - k * 0.45, k < 3);
          continue;
        }
        const tp = this.claw(base, mul(dir, -1), a, ln, 3.4 - k * 0.45, k < 3);
        if (k <= 1) tips.push(tp);
      }
    }
    this.flagsNow &= ~MF.CLIP;
    this.zBias = zb;
    // lips: a thick collar of folded flesh, gums and a rim of claws
    this.annulus(
      Cp,
      a,
      u,
      w,
      Rh * 0.7 * Math.min(1.25, gape),
      Rh * (1.08 + 0.18 * Math.max(0, gape - 1)),
      AK.LIPS,
      0,
      Rh * 0.7 * Math.min(1.25, gape),
      Rh * (0.38 + 0.18 * Math.max(0, gape - 1)),
      gape,
    );
    for (let j = 0; j < 30; j++) {
      const th = (j / 30) * TAU + 0.1;
      const dir = add(mul(u, Math.cos(th)), mul(w, Math.sin(th)));
      const base = add(Cp, add(mul(dir, Rh * 0.97), mul(a, 3)));
      this.claw(base, add(mul(dir, 0.35), mul(a, 0.2)), a, Rh * (0.16 + 0.1 * h3(j, 2, 4)), 2.4);
    }
    // saliva stretched across the open throat, tooth to tooth
    this.zBias = zb + Rh * 3.2;
    this.flagsNow |= MF.CLIP;
    for (let k = 0; k < 6; k++) {
      if (!tips.length) break;
      const i0 = (k * 5 + 1) % tips.length;
      const i1 = (k * 5 + Math.floor(tips.length / 2) + k) % tips.length;
      if (tips[i0] && tips[i1]) this.slime(tips[i0]!, tips[i1]!, 6 + h3(k, 1, 1) * 10, t, k * 7 + 1);
    }
    this.flagsNow &= ~MF.CLIP;
    this.zBias = zb;
    // the armillary: jaw-rings that are not circles — wobbling, swelling, ribbed, clawed
    const RG = [
      { R: 1.12, tilt: 0.55, g0: 0, w: 0.22, spin: 0.3, off: 0.12, ell: 0.14 },
      { R: 1.3, tilt: 0.95, g0: 2.1, w: -0.16, spin: -0.24, off: -0.25, ell: -0.2 },
      { R: 1.06, tilt: 1.25, g0: 4.0, w: 0.3, spin: 0.42, off: 0.3, ell: 0.16 },
      { R: 1.22, tilt: 0.75, g0: 5.3, w: -0.12, spin: 0.2, off: -0.6, ell: 0.22 },
    ];
    const LK = this.LK;
    RG.forEach((g, gi) => {
      if (!o.alive[gi]) return;
      const ST =
        o.spinT * (grind && gi % 2 ? -1 - 2 * grind : 1) +
        jit * 0.35 * Math.sin(t * 23 + gi * 7.1) * Math.max(0, Math.sin(t * 3.1 + gi * 2.3));
      const gam = g.g0 + ST * g.w;
      const tl = g.tilt + spread * 0.35 * (gi % 2 ? 1 : -1);
      const nrm = norm(
        add(
          mul(a, Math.cos(tl)),
          add(mul(u, Math.sin(tl) * Math.cos(gam)), mul(w, Math.sin(tl) * Math.sin(gam))),
        ),
      );
      const [e1, e2] = this.basis(nrm);
      const cc = add(
        add(Cp, mul(a, Rh * (g.off + spread * 0.35 * (gi % 2 ? 0.6 : 1)))),
        add(mul(u, Math.sin(gi * 2.1) * Rh * 0.08), mul(w, Math.cos(gi * 1.7) * Rh * 0.06)),
      );
      const R0 = Rh * g.R * (o.rs || 1) * (1 + 0.16 * spread);
      const steps = Math.ceil((TAU * R0 * 1.15) / 1.5);
      const gaps = o.gaps[gi];
      for (let j = 0; j < steps; j++) {
        if (gaps && gaps.length) {
          const fr = j / steps;
          let gap = false;
          for (const q of gaps)
            if (Math.abs(((fr - q[0] + 1.5) % 1) - 0.5) < q[1]) {
              gap = true;
              break;
            }
          if (gap) continue;
        }
        const th = (j / steps) * TAU + ST * g.spin;
        const rr = R0 * (1 + g.ell * Math.cos(2 * th) + 0.07 * (n3(th * 1.4, gi * 3, t * 0.15) - 0.5) * 2);
        const ct = Math.cos(th);
        const st = Math.sin(th);
        const dx = e1[0] * ct + e2[0] * st;
        const dy = e1[1] * ct + e2[1] * st;
        const dz = e1[2] * ct + e2[2] * st;
        const px = cc[0] + dx * rr;
        const py = cc[1] + dy * rr;
        const pz = cc[2] + dz * rr;
        // swelling ribs along the band; bone lit toward the sun, flesh where it joins the claws
        const rib = 0.5 + 0.5 * Math.sin(((j / steps) * TAU * rr) / 6);
        const hw = 2.4 + 1.6 * rib + 1.2 * Math.max(0, Math.sin(th * 2 + gi));
        const lit = Math.max(0, dx * LK[0] - dy * LK[1] + dz * LK[2]) * 0.55 + 0.22 + (dz > 0 ? 0.12 : -0.08);
        this.stamp(SK.RING, Math.round(px), Math.round(py), pz, hw, 0, 0, 0, lit, rib, 0, 0, 0, 0, 0, 0);
        if (j % 4 === 0 && !BRK.has(`r${gi}_${j}`)) {
          const ln = Rh * (0.1 + 0.08 * h3(j, gi, 1));
          // inward from the band, tilted out of its plane
          let ix = -dx + nrm[0] * 0.2;
          let iy = -dy + nrm[1] * 0.2;
          let iz = -dz + nrm[2] * 0.2;
          const il = Math.hypot(ix, iy, iz) || 1;
          ix /= il;
          iy /= il;
          iz /= il;
          const o2 = -hw + 0.5;
          this.clawS(
            px + dx * o2,
            py + dy * o2,
            pz + dz * o2,
            ix,
            iy,
            iz,
            nrm[0] * 0.6,
            nrm[1] * 0.6,
            nrm[2] * 0.6,
            ln,
            2.4,
            true,
          );
        }
        if (j % 35 === 11) {
          const ln = Rh * (0.14 + 0.08 * h3(j, gi, 7));
          this.clawS(px, py, pz, dx, dy, dz, nrm[0], nrm[1], nrm[2], ln, 1.6, false);
        }
        // threads of slime from the ring back to the lips
        if (j === Math.floor(steps * (0.2 + gi * 0.27))) {
          const p: V3 = [px, py, pz];
          const lp = add(Cp, mul(norm(sub(p, Cp)), Rh * 0.95));
          this.slime(p, lp, 14 + gi * 5, t, gi * 31 + j);
        }
      }
    });
  }

  private basis(a: V3): [V3, V3] {
    let u = cross(a, [0, 0, 1]);
    if (len(u) < 0.1) u = cross(a, [0, 1, 0]);
    u = norm(u);
    const w = norm(cross(a, u));
    return [u, w];
  }

  private annulus(
    c: V3,
    a: V3,
    u: V3,
    w: V3,
    r0: number,
    r1: number,
    kind: number,
    k: number,
    rn: number,
    rk: number,
    gape: number,
  ): void {
    const L = this.list;
    if (L.nAnn >= MAX_ANN) return;
    const o = L.nAnn++ * ANN_STRIDE;
    const A = L.anns;
    A[o] = c[0];
    A[o + 1] = c[1];
    A[o + 2] = c[2] + this.zBias;
    A[o + 3] = r0;
    A[o + 4] = u[0];
    A[o + 5] = u[1];
    A[o + 6] = u[2];
    A[o + 7] = r1;
    A[o + 8] = w[0];
    A[o + 9] = w[1];
    A[o + 10] = w[2];
    A[o + 11] = kind;
    A[o + 12] = a[0];
    A[o + 13] = a[1];
    A[o + 14] = a[2];
    A[o + 15] = k;
    A[o + 16] = gape;
    A[o + 17] = rn;
    A[o + 18] = rk;
    A[o + 19] = this.flagsNow;
  }

  /** World rect the frame covers (the pass draws only there). */
  private bounds(core: MouthCore): void {
    const L = this.list;
    L.x0 = core.ax0 - 200;
    L.y0 = core.ay0 - 200;
    L.x1 = core.ax0 + core.aw + 200;
    L.y1 = core.ay0 + core.ah + 200;
  }
}
