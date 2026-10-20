import { IdleRng, clampN, fsin, ss } from '../../../fx/idle';

/**
 * THE CRADLE'S IDLE POSE (idle handover specs/cradle.md; WJ: "every pulse takes years… This is it!"; 2026-10-19: the cord's
 * sway, its aim while coiling and its pull in the quickening are REAL, idle only; the quickening only with the foe within
 * 240 px). SIM STATE, stepped once per tick in `steer()`: integer ticks, the table sine (deterministic), a seeded LCG,
 * folded into the behaviour's hash.
 *  - The idle weight eases in over ~0.5 s at rest and out over ~0.15 s.
 *  - The quickening (7 s; first at 9 s, then every 14–19 s): its clock `wit` drives the render side's sail, sacs,
 *    embryo, filaments and web; here it pulls the cord taut toward the foe (2.2–3.5 s) after aiming it (1.0–3.8 s).
 *  - The coil (4.5 s; every 8–14 s, first at 5 s): the jaw-organ aims at the foe; the render side's tasting follows.
 *  - The cord's rest sway: 3.5° over 9.5 s travelling down the links, plus 1.5° at 0.41 rad/s, hushed during the quickening.
 */

export interface CradlePoseCtx {
  calm: boolean;
  ko: boolean;
  /** The foe is within 240 px (the filaments must read). */
  near: boolean;
}

const DT = 1 / 60;
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
/** The prototype's aim weight per link, root → jaw. */
const WT = [0.04, 0.07, 0.1, 0.16, 0.2, 0.24, 0.19];

export class CradlePose {
  w = 0;
  pt = 0;
  /** The quickening's seconds (−1 none), the hush (0..1), the coil's start tick (−1 none). */
  wit = -1;
  hush = 0;
  coilAt = -1;
  private witAt = -1;
  private nextWit = 540;
  private nextCoil = 300;
  private readonly rng: IdleRng;
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = seed;
    this.rng = new IdleRng(seed);
  }

  reset(): void {
    this.rng.reseed(this.seed);
    this.w = 0;
    this.pt = 0;
    this.wit = -1;
    this.hush = 0;
    this.coilAt = -1;
    this.witAt = -1;
    this.nextWit = 540;
    this.nextCoil = 300;
  }

  /** A move started or a blow landed: the quickening and the coil end; the next ones wait at least 2 s. */
  interrupt(): void {
    this.witAt = -1;
    this.coilAt = -1;
    this.nextWit = Math.max(this.nextWit, this.pt + 120);
    this.nextCoil = Math.max(this.nextCoil, this.pt + 120);
  }

  step(c: CradlePoseCtx): void {
    const pt = ++this.pt;
    const R = this.rng;
    if (c.ko) this.w = 0;
    else this.w = c.calm ? Math.min(1, this.w + DT / 0.5) : Math.max(0, this.w - DT / 0.15);
    const free = this.w >= 1 && !c.ko;
    if (this.witAt >= 0 && pt - this.witAt > 420) this.witAt = -1;
    if (this.witAt < 0 && pt > this.nextWit && free && c.near) {
      this.witAt = pt;
      this.coilAt = -1;
      this.nextWit = pt + 840 + Math.floor(R.next() * 300);
    }
    const W = this.witAt >= 0 ? (pt - this.witAt) * DT : -1;
    this.wit = W;
    this.hush = W >= 0 ? ss(0, 0.6, W) * (1 - ss(3.5, 4.5, W)) : 0;
    if ((W < 0 || W > 6.5) && free && pt > this.nextCoil) {
      this.coilAt = pt;
      this.nextCoil = pt + 480 + Math.floor(R.next() * 360);
    }
    if (this.coilAt >= 0 && pt - this.coilAt > 270) this.coilAt = -1;
  }

  /** The coil or the quickening aims the cord at the foe now. */
  get aiming(): boolean {
    return this.coilAt >= 0 || (this.wit > 1.0 && this.wit < 3.8);
  }
  /** The quickening's grab: the cord pulled taut. */
  get grab(): boolean {
    return this.wit > 2.2 && this.wit < 3.5;
  }

  /**
   * Link k's idle bend (rad, relative to its parent): the rest sway plus the aim's share of `err` (the jaw's heading error
   * toward the foe, rad), the prototype's.
   */
  bend(k: number, err: number): number {
    const t = this.pt * DT;
    let tg =
      (3.5 * DEG * fsin((t * TAU) / 9.5 - k * 0.65) + 1.5 * DEG * fsin(t * 0.41 + k)) * (1 - this.hush * 0.7);
    if (this.aiming)
      tg += clampN(err, -1.4, 1.4) * (WT[Math.min(k, WT.length - 1)] ?? 0.19) * (this.grab ? 2.2 : 1.6);
    if (this.grab) tg = clampN(tg, -26 * DEG, 26 * DEG);
    return tg;
  }

  hash(h: number): number {
    const v = [
      this.pt,
      this.witAt,
      this.nextWit,
      this.nextCoil,
      this.coilAt,
      Math.round(this.w * 4096),
      this.rng.state,
    ];
    for (const x of v) h = Math.imul(h ^ (x | 0), 0x01000193) >>> 0;
    return h;
  }
}
