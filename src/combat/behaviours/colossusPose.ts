import { IdleRng, clampN, fcos, fsin, ss } from '../fx/idle';

/**
 * THE LAST ONE'S IDLE POSE (repo id `colossus`; idle handover specs/last-one.md, prototype `colossus.src.html`: "no dangly
 * tentacles but immense weight, yet still a super dynamic feel"; "a cathedral breathing"). WJ 2026-10-19: the scythes, the
 * halo and the chandelier move on the REAL rig (idle only); the breath, shifts and drop move the REAL body and replace the
 * bob and sway; the spires' swing is drawn only; the prototype's springs are kept as approved.
 *
 * SIM STATE, stepped once per tick (the fighter's `bodyPose`, before this tick's hits) with 4 substeps (the page's 240 Hz):
 * integer ticks, DMath, a seeded LCG, folded into `hash()`. The behaviour hands the angles to the rig's drives.
 *  - The breath (9 s): a 0 / −2 px bob; held while witnessing.
 *  - The body: one heavy spring (ω 1.25, ζ 0.62) to its home, which a shift moves (toward the foe) and a drop kicks (ramped
 *    over 9 ticks, not one: the scale spec).
 *  - The scythes: the root and the blade on their own springs (the blade follows the root late); the stretch (counter-move,
 *    long lift, the blade curls, then snaps open); the witnessing lifts and sets them.
 *  - The halo arcs rock in their sectors (arc 2 against, and 1 px out of true), lock for the witnessing; the ring lags the
 *    body vertically. The chandelier swings as one pendulum.
 *  - The witnessing (every 12–18 s, first at 9 s): its clock `wit` drives the render side's light ring, seams, eye and
 *    reticle. It starts only when fully idle; a move or a blow ends it.
 */

export interface ColossusPoseCtx {
  /** Calm: idle / move / intro, no move running, no Guard. */
  calm: boolean;
  /** A move is running: the idle lets go fast (~0.15 s, the kit poses the parts); otherwise (a blow, a guard) slowly. */
  inMove: boolean;
  ko: boolean;
  /** The foe's side in the facing frame (+1 ahead, −1 behind). */
  toward: number;
}

const DT = 1 / 60;
const SUB = 4;
const H = DT / SUB;
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

export class ColossusPose {
  /* output (this tick, already weighted by the idle) */
  w = 0;
  /** Body offset (px; x in the facing frame), the halo's vertical lag (px), arc 2 out of true (0 / 1). */
  ox = 0;
  oy = 0;
  hl = 0;
  out2 = 0;
  /** Per arm: root and elbow angles (rad, the canonical frame); per arc: its rocking angle; the chandelier's swing. */
  readonly a0: Float64Array;
  readonly a1: Float64Array;
  readonly halo: Float64Array;
  shrine = 0;
  /** The breath 0..1, the witnessing's seconds (−1 none), the body's acceleration (px/s², the facing frame). */
  b = 0;
  wit = -1;
  ax = 0;
  ay = 0;
  shrineAcc = 0;
  /** Idle seconds (the render side's clock). */
  get t(): number {
    return this.pt * DT;
  }

  /* state */
  pt = 0;
  private witAt = -1;
  private nextWit = 540;
  private nextStretch = 192;
  private nextDrop = 450;
  private nextShift = 300;
  private readonly stretchAt: Int32Array;
  private dropLeft = 0;
  private bph = 0;
  private breath = 0;
  private px = 0;
  private py = 0;
  private vx = 0;
  private vy = 0;
  private tx = 0;
  private ty = 0;
  private holdX = 0;
  private holdY = 0;
  private hlv = 0;
  private hlx = 0;
  private readonly v0: Float64Array;
  private readonly v1: Float64Array;
  private readonly s0: Float64Array;
  private readonly s1: Float64Array;
  private readonly hv: Float64Array;
  private readonly hs: Float64Array;
  private sa = 0;
  private sv = 0;
  private readonly P: Float64Array;
  private readonly ph: Float64Array;
  private readonly rng: IdleRng;
  private readonly seed: number;

  constructor(
    seed: number,
    /** Per arm: −1 for the arms on the right of the body, +1 on the left (the page's `lift`); direction and length. */
    private readonly lift: readonly number[],
    private readonly dir: readonly number[],
    private readonly len: readonly number[],
    nHalo: number,
  ) {
    const n = lift.length;
    this.seed = seed;
    this.rng = new IdleRng(seed);
    this.a0 = new Float64Array(n);
    this.a1 = new Float64Array(n);
    this.s0 = new Float64Array(n);
    this.s1 = new Float64Array(n);
    this.v0 = new Float64Array(n);
    this.v1 = new Float64Array(n);
    this.P = new Float64Array(n);
    this.ph = new Float64Array(n);
    this.stretchAt = new Int32Array(n).fill(-99999);
    this.halo = new Float64Array(nHalo);
    this.hs = new Float64Array(nHalo);
    this.hv = new Float64Array(nHalo);
    this.reset();
  }

  reset(): void {
    const R = this.rng;
    R.reseed(this.seed);
    for (let i = 0; i < this.lift.length; i++) {
      this.P[i] = 7 + i * 1.3 + R.next() * 2;
      this.ph[i] = R.next() * 6;
    }
    this.pt = 0;
    this.w = 0;
    this.witAt = -1;
    this.nextWit = 540;
    this.nextStretch = 192;
    this.nextDrop = 450;
    this.nextShift = 300;
    this.stretchAt.fill(-99999);
    this.dropLeft = 0;
    this.bph = this.breath = 0;
    this.px = this.py = this.vx = this.vy = this.tx = this.ty = 0;
    this.hlx = this.hlv = 0;
    this.s0.fill(0);
    this.s1.fill(0);
    this.v0.fill(0);
    this.v1.fill(0);
    this.hs.fill(0);
    this.hv.fill(0);
    this.sa = this.sv = 0;
    this.out();
  }

  /** A move started or a blow landed: the witnessing ends (it blends out with the idle weight). */
  interrupt(): void {
    this.witAt = -1;
    this.nextWit = Math.max(this.nextWit, this.pt + 120);
  }

  step(c: ColossusPoseCtx): void {
    this.pt++;
    const pt = this.pt;
    const t = pt * DT;
    const R = this.rng;
    // the idle weight: up over ~0.5 s while calm; down over ~0.15 s when a move starts, over ~0.6 s after a blow (the blow's
    // load must still reach the carapace first and the arms later: a fast let-go moved the arms at once); off on a KO
    if (c.ko) this.w = 0;
    else if (c.calm) this.w = Math.min(1, this.w + DT / 0.5);
    else this.w = Math.max(0, this.w - DT / (c.inMove ? 0.15 : 0.6));
    const free = this.w >= 1;
    // ---- the schedule ----
    if (this.witAt >= 0 && pt - this.witAt > 450) this.witAt = -1;
    if (this.witAt < 0 && pt > this.nextWit && free) {
      this.witAt = pt;
      this.holdX = this.px;
      this.holdY = this.py;
      this.nextWit = pt + 720 + Math.floor(R.next() * 360);
    }
    const W = this.witAt >= 0 ? (pt - this.witAt) * DT : -1;
    const wit = W >= 0;
    if ((!wit || W > 6) && free) {
      if (pt > this.nextStretch) {
        const i = Math.floor(R.next() * this.lift.length);
        if (pt - this.stretchAt[i]! > 360) this.stretchAt[i] = pt;
        this.nextStretch = pt + 270 + Math.floor(R.next() * 240);
      }
      if (pt > this.nextDrop) {
        this.dropLeft = 9;
        this.nextDrop = pt + 600 + Math.floor(R.next() * 420);
      }
      if (pt > this.nextShift) {
        this.tx = Math.round(R.next() * 12 - 6 + c.toward * 3);
        this.ty = Math.round(R.next() * 6 - 3);
        this.nextShift = pt + 360 + Math.floor(R.next() * 300);
      }
    }
    // ---- the breath (held while witnessing; it may only rise back slowly after) ----
    const hush = wit ? ss(0, 0.6, W) * (1 - ss(3.6, 4.4, W)) : 0;
    this.bph += (DT / 9) * (1 - hush);
    const bT = 0.5 - 0.5 * fcos(this.bph * TAU);
    this.breath = wit
      ? W < 0.6
        ? Math.max(this.breath, bT)
        : W > 3.8
          ? Math.min(this.breath, bT + (1 - ss(3.8, 5.5, W)))
          : this.breath
      : bT;
    // the drop: 22 px/s spread over 9 ticks
    if (this.dropLeft > 0) {
      this.vy += 22 / 9;
      this.dropLeft--;
    }
    const tgx = wit && W < 5.6 ? this.holdX : this.tx;
    const tgy = wit ? (W < 3.6 ? this.holdY : W < 5.6 ? this.holdY + 3 : this.ty) : this.ty;
    let ax = 0;
    let ay = 0;
    let sAcc = 0;
    for (let s = 0; s < SUB; s++) {
      const ts = t - DT + (s + 1) * H;
      const wb = wit && W < 3.6 ? 3 : 1.25;
      ax = wb * wb * (tgx - this.px) - 2 * 0.62 * wb * this.vx;
      ay = wb * wb * (tgy - this.py) - 2 * 0.62 * wb * this.vy;
      this.vx += ax * H;
      this.vy += ay * H;
      this.px += this.vx * H;
      this.py += this.vy * H;
      // the scythes: heavy, overshooting, slow to settle; the blade follows the root late, never limp
      for (let i = 0; i < this.lift.length; i++) {
        const L = this.lift[i]!;
        const base = (ts * TAU) / this.P[i]! + this.ph[i]!;
        let t0 = (2.6 * fsin(base) + 0.8 * fsin(ts * 0.37 + i)) * DEG;
        let t1 = 1.6 * fsin(base - 1.1) * DEG;
        let w0 = 1.9;
        let z0 = 0.3;
        let w1 = 3.4;
        const z1 = 0.5;
        const u = (pt - this.stretchAt[i]!) * DT;
        if (u >= 0 && u < 7) {
          if (u < 0.65) t0 += -L * 3.5 * DEG;
          else if (u < 2.7) {
            t0 += L * 16 * DEG;
            if (u > 1.3) t1 += -L * 15 * DEG;
          } else if (u < 3.0) {
            t0 += L * 16 * DEG;
            t1 += L * 10 * DEG;
            w1 = 8;
          }
        }
        if (wit) {
          if (W < 3.6) {
            t0 = L * (8 + (i >> 1)) * DEG * ss(0, 0.8, W);
            t1 = -L * 4 * DEG * ss(0, 0.8, W);
            w0 = 2.6;
            z0 = 0.8;
          } else if (W < 6) {
            t0 = -L * 5 * DEG;
            t1 = L * 2 * DEG;
            w0 = 1.1;
            z0 = 0.35;
          }
        }
        const dx = fcos(this.dir[i]!);
        const dy = fsin(this.dir[i]!);
        const f0 = (-(dx * ay - dy * ax) / this.len[i]!) * 0.55;
        const acc0 = w0 * w0 * (t0 - this.s0[i]!) - 2 * z0 * w0 * this.v0[i]! + f0;
        this.v0[i] = this.v0[i]! + acc0 * H;
        this.s0[i] = clampN(this.s0[i]! + this.v0[i]! * H, -30 * DEG, 30 * DEG);
        const acc1 = w1 * w1 * (t1 - this.s1[i]!) - 2 * z1 * w1 * this.v1[i]! - acc0 * 0.35;
        this.v1[i] = this.v1[i]! + acc1 * H;
        this.s1[i] = clampN(this.s1[i]! + this.v1[i]! * H, -26 * DEG, 26 * DEG);
      }
      // the halo rocks inside its sectors (arc 0 the sigil, arc 2 against); it lags the body like a heavy ring
      const lock = wit && W < 3.8;
      for (let k = 0; k < this.halo.length; k++) {
        let tg = (k === 2 ? 9 : 4) * DEG * fsin((ts * TAU) / (13 + k * 2.7) + k * 1.9) * (k === 2 ? -1.6 : 1);
        if (k === 0) tg = 5 * DEG * fsin((ts * TAU) / 7.5);
        if (lock) tg = 0;
        const om = lock ? 3.2 : 1.4;
        const ze = lock ? 0.9 : 0.25;
        const acc = om * om * (tg - this.hs[k]!) - 2 * ze * om * this.hv[k]! - ax * 0.0012 * (k % 2 ? 1 : -1);
        this.hv[k] = this.hv[k]! + acc * H;
        this.hs[k] = this.hs[k]! + this.hv[k]! * H;
      }
      const accH = 2.6 * 2.6 * (0 - this.hlx) - 2 * 0.28 * 2.6 * this.hlv - ay * 0.12;
      this.hlv += accH * H;
      this.hlx += this.hlv * H;
      // the chandelier: one slow pendulum
      sAcc = 1.5 * 1.5 * (0 - this.sa) - 2 * 0.12 * 1.5 * this.sv + ax * 0.006 + fsin(ts * 0.7) * 0.0006;
      this.sv += sAcc * H;
      this.sa += this.sv * H;
    }
    this.ax = ax;
    this.ay = ay;
    this.shrineAcc = sAcc;
    this.wit = W;
    this.out2 = fsin(t * 0.9) > 0.2 ? 1 : 0;
    this.out();
  }

  /** The outputs, weighted by the idle (0 = today's pose). */
  private out(): void {
    const w = this.w;
    this.b = this.breath;
    this.ox = this.px * w;
    this.oy = (this.py - 1.6 * this.breath) * w;
    this.hl = this.hlx * w;
    for (let i = 0; i < this.a0.length; i++) {
      this.a0[i] = this.s0[i]! * w;
      this.a1[i] = this.s1[i]! * w;
    }
    for (let k = 0; k < this.halo.length; k++) this.halo[k] = this.hs[k]! * w;
    this.shrine = this.sa * w;
  }

  hash(h: number): number {
    const q = (x: number): number => Math.round(x * 65536) | 0;
    const v = [
      this.pt,
      this.witAt,
      this.nextWit,
      this.nextStretch,
      this.nextDrop,
      this.nextShift,
      this.dropLeft,
      this.tx,
      this.ty,
      q(this.w),
      q(this.bph),
      q(this.breath),
      q(this.px),
      q(this.py),
      q(this.vx),
      q(this.vy),
      q(this.hlx),
      q(this.hlv),
      q(this.sa),
      q(this.sv),
      this.rng.state,
    ];
    for (const x of v) h = Math.imul(h ^ x, 0x01000193) >>> 0;
    for (let i = 0; i < this.s0.length; i++) {
      h = Math.imul(h ^ q(this.s0[i]!) ^ (this.stretchAt[i]! << 3), 0x01000193) >>> 0;
      h = Math.imul(h ^ q(this.s1[i]!), 0x01000193) >>> 0;
    }
    for (let k = 0; k < this.hs.length; k++) h = Math.imul(h ^ q(this.hs[k]!), 0x01000193) >>> 0;
    return h;
  }
}
