import { angleToStep } from '@/contracts';
import { DMath } from '@/contracts/dmath';
import { IdleRng, clampN, ss } from '../fx/idle';

/**
 * THE ASTEROID'S IDLE POSE (idle handover: specs/asteroid.md, prototype `rock.src.html`; WJ, 2026-10-17: the head turn is a
 * REAL body rotation and the darts are REAL offsets, hit where drawn; the spin plays on real momentum, idle feints add none).
 *
 * SIM STATE. The fighter asks for it once per tick (`Behaviour.bodyPose`, before this tick's hits) and draws and hit-tests
 * the body where it says, so everything here is deterministic: integer ticks, DMath, a seeded LCG, folded into `hash()`.
 *  - Head snaps: every 7–34 ticks the horn snaps toward the prey (±0.09 rad): 2 ticks of travel, 2 ticks one notch past,
 *    dead still, a lock. Within ±45° of the facing horizontal; quantised to 4 rotation steps (5.6°).
 *  - Darts: side-steps across the prey line (2–5 px, never toward it), 1 tick back, 2–3 ticks of travel, 2 ticks 1 px past,
 *    a dead stop; within ±10 px x, ±8 px y of home.
 *  - The feint (every 3.5–7.5 s, never when the foe is within reach): crouch, charge, tremble, a 15 px lunge, a ring of dust,
 *    two hops home. The spin: a full turn in 0.42 s, at the next idle moment after real momentum reaches 3.
 *  - It yields: offsets and rotation are 0 the tick a move starts; hitstun / guard / intro send the body home in 2 ticks.
 * The render side (asteroidIdle.ts) reads the pose and the event stamps (`dart*`, `hit*`, `spinEnd`) for its effects.
 */

export interface PoseCtx {
  /** Darts, feints and spins only in 'idle'; head tracking in idle / move / guard. */
  state: string;
  /** A move is running (startup … recovery): no offset, no rotation, at once. */
  inMove: boolean;
  facing: 1 | -1;
  /** World position of the body (last tick) and of the prey. */
  x: number;
  y: number;
  preyX: number;
  preyY: number;
  /** The foe's live bounds come within the lunge's reach of the horn: no auto-feint. */
  foeNear: boolean;
  /** Real momentum reached 3 since the last spin: spin at the next idle moment. */
  wantSpin: boolean;
}

const TAU = Math.PI * 2;
/** The prototype's angle unit: 72 RotSprite frames (5°). */
const FRAME = TAU / 72;
const REACH = 15;
const IDLE_CLAMP = Math.PI / 4;

const wrap = (a: number): number => {
  let d = (a + Math.PI) % TAU;
  if (d < 0) d += TAU;
  return d - Math.PI;
};

export class AsteroidPose {
  /* output */
  ox = 0;
  oy = 0;
  rot = 0;
  /** The world angle the horn points along this tick (head + spin), for the render side. */
  dir = 0;
  charge = 0;
  /** Ticks since the head locked (999 while it travels or never). */
  lockAge = 999;
  /** A full-turn spin is running (the swarm kicks). */
  spinning = false;
  /* events for the render side: the tick (pose clock) they happened, and where */
  dartAt = -1;
  dartAng = 0;
  dartN = 0;
  hitAt = -1;
  hitX = 0;
  hitY = 0;
  spinEndAt = -1;

  /* state */
  pt = 0;
  private head = 0;
  private hmOn = 0;
  private hmT0 = 0;
  private hmFrom = 0;
  private hmTo = 0;
  private hmOver = 0;
  private lockAt = -999;
  private atX = 0;
  private atY = 0;
  private mvOn = 0;
  private mvT0 = 0;
  private mvFX = 0;
  private mvFY = 0;
  private mvTX = 0;
  private mvTY = 0;
  private mvDX = 0;
  private mvDY = 0;
  private mvN = 3;
  /** 0 none, 1 feint, 2 spin. */
  private act = 0;
  private actT0 = 0;
  private actFlags = 0;
  private actA = 0;
  private actHX = 0;
  private actHY = 0;
  private actDir = 1;
  private spin = 0;
  private trem = 0;
  private nextHead = 12;
  private nextDart = 36;
  private nextFeint = 240;
  private posX = 0;
  private posY = 0;
  private tracked = false;
  private readonly rng: IdleRng;
  private readonly seed: number;

  constructor(
    /** The prow's angle at rotation 0 (facing +1), from the rig. */
    private readonly prow: number,
    private readonly radius: number,
    seed: number,
  ) {
    this.seed = seed;
    this.rng = new IdleRng(seed);
  }

  reset(facing: 1 | -1): void {
    this.rng.reseed(this.seed);
    this.pt = 0;
    this.head = facing > 0 ? 0 : Math.PI;
    this.hmOn = 0;
    this.lockAt = -999;
    this.atX = this.atY = 0;
    this.mvOn = 0;
    this.act = 0;
    this.charge = 0;
    this.spin = 0;
    this.trem = 0;
    this.nextHead = 12;
    this.nextDart = 36;
    this.nextFeint = 240;
    this.posX = this.posY = 0;
    this.ox = this.oy = 0;
    this.rot = 0;
    this.dartAt = this.hitAt = this.spinEndAt = -1;
    this.tracked = false;
  }

  private rnd(): number {
    return this.rng.next();
  }

  /** The horn's allowed range at idle: ±45° about the facing horizontal. */
  private clampHead(a: number, facing: 1 | -1): number {
    const hf = facing > 0 ? 0 : Math.PI;
    return hf + clampN(wrap(a - hf), -IDLE_CLAMP, IDLE_CLAMP);
  }

  /** A snap: 2 ticks of travel toward the target, 2 ticks one notch (two past 0.3 rad) past it, then dead still. */
  private snapHead(target: number): void {
    const d = wrap(target - this.head);
    if (Math.abs(d) < FRAME / 2) return;
    this.hmOn = 1;
    this.hmT0 = this.pt;
    this.hmFrom = this.head;
    this.hmTo = this.head + d;
    this.hmOver = Math.sign(d) * FRAME * (Math.abs(d) > 0.3 ? 2 : 1);
  }

  private headNow(): number {
    if (!this.hmOn) return this.head;
    const u = this.pt - this.hmT0;
    if (u < 2) return this.hmFrom + (this.hmTo - this.hmFrom) * DMath.pow(u / 2, 0.6);
    if (u < 4) return this.hmTo + this.hmOver;
    this.head = wrap(this.hmTo);
    this.hmOn = 0;
    this.lockAt = this.pt;
    return this.head;
  }

  /** A dart: 1 tick back, `n` ticks of ease-out travel, 2 ticks a pixel past, a dead stop (and a jet from the far rim). */
  private dartTo(tx: number, ty: number, n: number): void {
    const rx = Math.round(tx);
    const ry = Math.round(ty);
    this.mvOn = 1;
    this.mvT0 = this.pt;
    this.mvFX = this.atX;
    this.mvFY = this.atY;
    this.mvTX = rx;
    this.mvTY = ry;
    this.mvDX = Math.sign(rx - this.atX);
    this.mvDY = Math.sign(ry - this.atY);
    this.mvN = n;
    this.dartAt = this.pt;
    this.dartAng = DMath.atan2(-(ry - this.atY), -(rx - this.atX));
    this.dartN = 7 + n * 2;
  }

  private posNow(): void {
    if (!this.mvOn) {
      this.posX = this.atX;
      this.posY = this.atY;
      return;
    }
    const u = this.pt - this.mvT0;
    const n = this.mvN;
    if (u < 1) {
      this.posX = this.mvFX - this.mvDX;
      this.posY = this.mvFY - this.mvDY;
    } else if (u < 1 + n) {
      const k = (u - 1) / n;
      const e = 1 - (1 - k) * (1 - k);
      this.posX = Math.round(this.mvFX + (this.mvTX - this.mvFX) * e);
      this.posY = Math.round(this.mvFY + (this.mvTY - this.mvFY) * e);
    } else if (u < 3 + n) {
      this.posX = this.mvTX + this.mvDX;
      this.posY = this.mvTY + this.mvDY;
    } else {
      this.atX = this.mvTX;
      this.atY = this.mvTY;
      this.mvOn = 0;
      this.posX = this.atX;
      this.posY = this.atY;
    }
  }

  /** One tick. Returns the pose in `ox`, `oy` (whole px, world) and `rot` (a rotation step). */
  step(c: PoseCtx): void {
    this.pt++;
    const pt = this.pt;
    const idle = c.state === 'idle';
    const track = idle || c.state === 'move' || c.state === 'guard';
    const preyAng = DMath.atan2(c.preyY - c.y, c.preyX - c.x);

    // ---- yielding: a move takes the body back at once; anything else not idle sends it home in two ticks ----
    if (c.inMove) {
      this.act = 0;
      this.charge = 0;
      this.spin = 0;
      this.trem = 0;
      this.mvOn = 0;
      this.atX = this.atY = 0;
      this.hmOn = 0;
    } else if (!idle && (this.act || this.charge || this.atX || this.atY || this.mvOn)) {
      this.act = 0;
      this.charge = 0;
      this.spin = 0;
      this.trem = 0;
      if (this.atX || this.atY || this.mvOn) {
        this.posNow();
        this.atX = this.posX;
        this.atY = this.posY;
        if (this.atX || this.atY) this.dartTo(0, 0, 2);
      }
    }
    if (!track) {
      // the head looks ahead again for when tracking resumes
      this.head = c.facing > 0 ? 0 : Math.PI;
      this.hmOn = 0;
    } else if (!this.tracked) this.head = this.clampHead(this.head, c.facing);
    this.tracked = track;

    // ---- the action: the feint, the spin ----
    let busy = false;
    this.trem = 0;
    if (idle && this.act === 0 && c.wantSpin) this.startSpin();
    if (idle && this.act === 1) {
      busy = true;
      const u = (pt - this.actT0) / 60;
      const F = this.actFlags;
      if (!(F & 1)) {
        this.actFlags |= 1;
        this.actA = this.clampHead(preyAng, c.facing);
        this.snapHead(this.actA);
        this.actHX = this.atX;
        this.actHY = this.atY;
      }
      const a = this.actA;
      const bx = -DMath.cos(a);
      const by = -DMath.sin(a);
      // crouch: back off in single pixels, the veins charge, the swarm winds tight
      if (u < 0.5) {
        const k = Math.floor(ss(0, 0.5, u) * 4);
        this.atX = this.actHX + Math.round(bx * k);
        this.atY = this.actHY + Math.round(by * k);
        this.charge = ss(0, 0.5, u);
      }
      if (u >= 0.42 && u < 0.62) this.trem = 1;
      if (u >= 0.62 && !(this.actFlags & 2)) {
        this.actFlags |= 2;
        this.charge = 1;
        this.dartTo(this.actHX + DMath.cos(a) * REACH, this.actHY + DMath.sin(a) * REACH, 2);
      }
      if (u >= 0.62 + 4 / 60 && !(this.actFlags & 4)) {
        this.actFlags |= 4;
        this.charge = 0;
        this.hitAt = pt;
        this.hitX = c.x + DMath.cos(a) * this.radius * 1.15;
        this.hitY = c.y + DMath.sin(a) * this.radius * 1.15;
      }
      // home in two quick hops
      if (u >= 1.0 && !(this.actFlags & 8)) {
        this.actFlags |= 8;
        this.posNow();
        this.dartTo((this.atX + this.actHX) / 2, (this.atY + this.actHY) / 2, 3);
      }
      if (u >= 1.18 && !(this.actFlags & 16)) {
        this.actFlags |= 16;
        this.posNow();
        this.dartTo(this.actHX, this.actHY, 3);
      }
      if (u > 1.5) this.act = 0;
    } else if (idle && this.act === 2) {
      busy = true;
      const u = (pt - this.actT0) / 60;
      if (u < 0.42) {
        this.hmOn = 0;
        this.spin = this.actDir * ss(0, 0.42, u) * TAU;
      } else {
        this.spin = 0;
        if (!(this.actFlags & 32)) {
          this.actFlags |= 32;
          this.spinEndAt = pt;
        }
      }
      if (u > 0.7) this.act = 0;
    }

    // ---- idle: head snaps, darts, feints on its own ----
    if (track && !busy) {
      if (pt > this.nextHead) {
        this.snapHead(this.clampHead(preyAng + (this.rnd() - 0.5) * 0.18, c.facing));
        this.nextHead = pt + Math.round((0.12 + this.rnd() * 0.45) * 60);
      }
    }
    if (idle && !busy) {
      if (pt > this.nextDart && !this.mvOn) {
        // side-steps across the line to the prey, never toward it: a raptor circling
        const side = this.rnd() < 0.5 ? -1 : 1;
        const ax = -DMath.sin(preyAng);
        const ay = DMath.cos(preyAng);
        const off = side * (2 + Math.floor(this.rnd() * 4));
        const fwd = Math.round((this.rnd() - 0.5) * 3);
        const tx = clampN(this.atX + ax * off + DMath.cos(preyAng) * fwd, -10, 10);
        const ty = clampN(this.atY + ay * off + DMath.sin(preyAng) * fwd, -8, 8);
        this.dartTo(tx, ty, 2 + Math.floor(this.rnd() * 2));
        this.nextDart = pt + Math.round((0.3 + this.rnd() * 0.65) * 60);
      }
      if (pt > this.nextFeint) {
        if (!c.foeNear) this.startFeint();
        this.nextFeint = pt + Math.round((3.5 + this.rnd() * 4) * 60);
      }
    }

    // ---- the pose ----
    this.posNow();
    const head = this.headNow();
    this.ox = this.posX + (this.trem && pt & 1 ? 1 : 0);
    this.oy = this.posY;
    if (!track || c.inMove) {
      this.rot = 0;
      this.dir = c.facing > 0 ? this.prow : Math.PI - this.prow;
      this.lockAge = 999;
      this.spinning = false;
      return;
    }
    const h = head + this.spin;
    this.dir = h;
    // the horn points along h: facing +1 rotates the prow from `prow`, facing −1 from its mirror (π − prow)
    const base = c.facing > 0 ? this.prow : Math.PI - this.prow;
    let s = angleToStep(h - base);
    s = (Math.round(s / 4) * 4) & 255;
    this.rot = s;
    this.lockAge = this.hmOn ? 999 : pt - this.lockAt;
    this.spinning = this.act === 2 && this.spin !== 0;
  }

  private startFeint(): void {
    if (this.act && this.pt - this.actT0 < 96) return;
    this.act = 1;
    this.actT0 = this.pt;
    this.actFlags = 0;
  }

  private startSpin(): void {
    this.act = 2;
    this.actT0 = this.pt;
    this.actFlags = 0;
    this.actDir = this.rnd() < 0.5 ? 1 : -1;
  }

  /** The spin was asked for and started this tick (the behaviour clears its request). */
  get spinStarted(): boolean {
    return this.act === 2 && this.actT0 === this.pt;
  }

  /** Fold the pose state into a determinism hash. */
  hash(h: number): number {
    const v = [
      this.pt,
      this.atX,
      this.atY,
      this.mvOn,
      this.mvT0,
      this.mvTX,
      this.mvTY,
      this.act,
      this.actT0,
      this.actFlags,
      this.hmOn,
      this.hmT0,
      Math.round(this.head * 4096),
      Math.round(this.hmTo * 4096),
      this.nextHead,
      this.nextDart,
      this.nextFeint,
      this.rot,
      this.ox,
      this.oy,
      this.rng.state,
    ];
    for (const x of v) h = Math.imul(h ^ (x | 0), 0x01000193) >>> 0;
    return h;
  }
}
