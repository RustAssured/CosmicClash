import { DMath } from '@/contracts/dmath';
import { IdleRng, clampN, ss } from '../fx/idle';
import type { IdleVeil } from './tendrils';

/**
 * THE WITNESS'S IDLE POSE (idle handover: specs/witness.md, prototype `witness.src.html`, "an idol that swims"; WJ 2026-10-18:
 * the veil's motion is REAL but idle only, the swim is REAL and replaces the bob and sway, the tilt is the row-shear lean (D4),
 * the hem pull-in is drawn).
 *
 * SIM STATE, stepped once per tick in the behaviour's update: integer ticks, DMath, a seeded LCG, folded into `hash()`.
 *  - The idle weight `w` eases in only while calm (idle / move / intro, no move, no Guard, no KO), out in ~0.25 s.
 *  - The pulse (every 4.2–5.0 s, never during the Witness's hold): the stroke lifts the body and draws the veil together.
 *  - Taste (every 5–10 s): the two front / hem tendrils nearest the foe reach for it, the second 0.35 s later.
 *  - The Five Witnesses (every 12–18 s, first at 8 s): the body rises 4 px, the veil lifts into a crown; the render side
 *    reads its clock for the eyes, the lantern, the gems and the testimony.
 *  - Taste and the Witness start only when fully idle and the foe is out of the veil's reach; a move or a blow ends them.
 *  - The swim: a spring (ω 0.9, ζ 0.85) to a 3 × 2 px drift, kicked up on each stroke; the tilt (2.4° · sin 0.33 t, plus
 *    the drift) is a spring (ω 2.2, ζ 0.7) handed to the fighter as row-shear lean.
 */

export interface LastOnePoseCtx {
  /** Calm: idle / move / intro, no move running, no Guard. */
  calm: boolean;
  ko: boolean;
  /** The foe is out of the veil's reach (taste and the Witness may start). */
  foeFar: boolean;
}

const DT = 1 / 60;
const DEG = Math.PI / 180;
/** Ticks: the first moments and their intervals (prototype seconds × 60). */
const FIRST_PULSE = 48;
const FIRST_TASTE = 240;
const FIRST_WITNESS = 480;
const WITNESS_TICKS = 420;

export class LastOnePose {
  /* output (this tick) */
  /** Idle weight 0..1. */
  w = 0;
  /** Body offset (px, world) and row-shear lean (px at the top row, facing-relative). */
  ox = 0;
  oy = 0;
  lean = 0;
  /** Seconds since the pulse began (99 = none), the Witness's seconds (−1 = none), its hold and rise (0..1). */
  pu = 99;
  wit = -1;
  hold = 0;
  rise = 0;
  /** The tendrils tasting (−1 = none) and since when (pose tick); `tasteDue`: the behaviour picks the two this tick. */
  readonly tasteI = new Int8Array(2).fill(-1);
  readonly tasteAt = new Int32Array(2);
  tasteDue = false;

  /* state */
  pt = 0;
  private pulseAt = -9999;
  private witAt = -1;
  private nextPulse = FIRST_PULSE;
  private nextTaste = FIRST_TASTE;
  private nextWit = FIRST_WITNESS;
  private sx = 0;
  private sy = 0;
  private svx = 0;
  private svy = 0;
  private tilt = 0;
  private tv = 0;
  private readonly rng: IdleRng;
  private readonly seed: number;

  constructor(
    seed: number,
    /** The body's anchor row (px from the top): the row-shear lean that matches a tilt. */
    private readonly anchorY: number,
  ) {
    this.seed = seed;
    this.rng = new IdleRng(seed);
  }

  reset(): void {
    this.rng.reseed(this.seed);
    this.pt = 0;
    this.w = 0;
    this.pulseAt = -9999;
    this.witAt = -1;
    this.nextPulse = FIRST_PULSE;
    this.nextTaste = FIRST_TASTE;
    this.nextWit = FIRST_WITNESS;
    this.tasteI.fill(-1);
    this.tasteDue = false;
    this.sx = this.sy = this.svx = this.svy = this.tilt = this.tv = 0;
    this.ox = this.oy = this.lean = 0;
    this.pu = 99;
    this.wit = -1;
    this.hold = this.rise = 0;
  }

  /**
   * A move started or a blow landed: the Witness and the taste end, and the next moments wait at least 2 s. (The idle weight
   * still eases out over ~0.25 s: dropped at once, the veil leapt back to its hanging rest under the whips and knotted.)
   */
  interrupt(): void {
    this.witAt = -1;
    this.tasteI.fill(-1);
    this.nextTaste = Math.max(this.nextTaste, this.pt + 120);
    this.nextWit = Math.max(this.nextWit, this.pt + 120);
  }

  step(c: LastOnePoseCtx): void {
    this.pt++;
    const pt = this.pt;
    const t = pt * DT;
    // the idle weight: ~0.1 a tick toward calm, 0 at once on a KO
    if (c.ko) this.w = 0;
    else this.w = clampN(this.w + ((c.calm ? 1 : 0) - this.w) * 0.1, 0, 1);
    const free = this.w > 0.99 && !c.ko;
    // ---- the Five Witnesses ----
    if (this.witAt >= 0 && pt - this.witAt > WITNESS_TICKS) this.witAt = -1;
    if (this.witAt < 0 && pt > this.nextWit && free && c.foeFar) {
      this.witAt = pt;
      this.tasteI.fill(-1);
      this.nextWit = pt + 720 + Math.floor(this.rng.next() * 360);
    }
    const W = this.witAt >= 0 ? (pt - this.witAt) * DT : -1;
    this.wit = W;
    this.hold = W >= 0 ? ss(0, 0.5, W) * (1 - ss(4, 5.2, W)) : 0;
    this.rise = W >= 0 ? ss(0.4, 1.7, W) * (1 - ss(3.9, 6.0, W)) : 0;
    // ---- taste (not during the Witness) ----
    this.tasteDue = false;
    if (this.witAt < 0 && pt > this.nextTaste && free && c.foeFar) {
      this.tasteDue = true;
      this.nextTaste = pt + 300 + Math.floor(this.rng.next() * 300);
    }
    for (let k = 0; k < 2; k++) if (this.tasteI[k]! >= 0 && pt - this.tasteAt[k]! > 204) this.tasteI[k] = -1;
    if (!c.calm || !c.foeFar) this.tasteI.fill(-1);
    // ---- the pulse (never while the Witness holds it) ----
    if (pt > this.nextPulse && this.hold <= 0 && free) {
      this.pulseAt = pt;
      this.svy -= 15 * this.w;
      this.nextPulse = pt + 252 + Math.floor(this.rng.next() * 48);
    }
    this.pu = Math.min(99, (pt - this.pulseAt) * DT);
    // ---- the swim: a drift the body follows on a soft spring, lifting on the stroke, rising for the Witness ----
    const w = this.w;
    const tx = 3 * DMath.sin(t * 0.21) * w;
    const ty = (2 * DMath.sin(t * 0.17) - 4 * this.rise) * w;
    const om = 0.9;
    const z = 0.85;
    this.svx += (om * om * (tx - this.sx) - 2 * z * om * this.svx) * DT;
    this.svy += (om * om * (ty - this.sy) - 2 * z * om * this.svy) * DT;
    this.sx += this.svx * DT;
    this.sy += this.svy * DT;
    // ---- the tilt (a spring), handed on as row shear: the top row moves by tilt × anchor height ----
    const tt = (2.4 * DEG * DMath.sin(t * 0.33) + this.svx * 0.003) * (1 - this.hold) * w;
    this.tv += (2.2 * 2.2 * (tt - this.tilt) - 2 * 0.7 * 2.2 * this.tv) * DT;
    this.tilt += this.tv * DT;
    this.ox = this.sx;
    this.oy = this.sy;
    this.lean = this.tilt * this.anchorY;
  }

  /** The behaviour picked the tasting tendrils (−1 = none): the second starts 0.35 s after the first. */
  startTaste(a: number, b: number): void {
    this.tasteI[0] = a;
    this.tasteI[1] = b;
    this.tasteAt[0] = this.pt;
    this.tasteAt[1] = this.pt + 21;
  }

  /** How far tendril slot k is tasting (0..1): ramp 0.6 s, hold to 2.4 s, release to 3.2 s. */
  tasteOf(k: number): number {
    if (this.tasteI[k]! < 0) return 0;
    const u = (this.pt - this.tasteAt[k]!) * DT;
    return u < 0 ? 0 : u < 0.6 ? ss(0, 0.6, u) : u < 2.4 ? 1 : 1 - ss(2.4, 3.2, u);
  }

  /** Fill the tendrils' idle veil for this tick. */
  veil(out: IdleVeil, foeX: number, foeY: number, vx: number, vy: number): void {
    out.w = this.w;
    out.t = this.pt * DT;
    out.pu = this.pu;
    out.hold = this.hold;
    out.rise = this.rise;
    out.foeX = foeX;
    out.foeY = foeY;
    out.vx = vx;
    out.vy = vy;
    out.taste.fill(0);
    for (let k = 0; k < 2; k++) {
      const i = this.tasteI[k]!;
      if (i >= 0 && i < out.taste.length) out.taste[i] = Math.max(out.taste[i]!, this.tasteOf(k));
    }
  }

  hash(h: number): number {
    const v = [
      this.pt,
      this.pulseAt,
      this.witAt,
      this.nextPulse,
      this.nextTaste,
      this.nextWit,
      this.tasteI[0]!,
      this.tasteI[1]!,
      this.tasteAt[0]!,
      this.tasteAt[1]!,
      Math.round(this.w * 4096),
      Math.round(this.sx * 4096),
      Math.round(this.sy * 4096),
      Math.round(this.svx * 4096),
      Math.round(this.svy * 4096),
      Math.round(this.tilt * 65536),
      Math.round(this.tv * 65536),
      this.rng.state,
    ];
    for (const x of v) h = Math.imul(h ^ (x | 0), 0x01000193) >>> 0;
    return h;
  }
}
