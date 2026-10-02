import { DamageFlag, clamp, clamp01, type DamageType, type OverlapResult } from '@/contracts';
import type { FighterImpl } from '../fighter';
import { Overlay } from '../fx/overlay';
import type { ActiveMove } from '../move';
import { asShape, makeFatShape, type FatShape } from '../shapes';
import { wrapAngle } from '../rig/xpbd';
import type { WitnessRig } from '../rig/witnessRig';

/**
 * The Witness's six moves (SLICE_PHASE2 S2.4) on top of its rig. The JSON moves (`witnessMoves`) carry frame data and S1's
 * root/torsion choreography; this kit adds what comes from the body itself, so DAMAGE CHANGES THE KIT:
 *
 *  - HALO SHARDS (Strike): the live halo arcs swing forward through the attack lane, one after another; each arc is a hit
 *    volume. A broken arc no longer cuts.
 *  - SWEEPING ARCHITECTURE (Crush, up/forward): the arms wind back against the turn, then sweep through it, the tips arriving
 *    last; each live arm blade (elbow → tip) is a hit volume. A severed arm no longer sweeps: reach shrinks.
 *  - STRUCTURAL SHEAR (Crush, down): the close cone from the JSON, then a delayed fracture path that shears 0.3–0.8 s later.
 *  - FRACTURE GAZE (Signature): the held beam leaves fracture marks on what it crosses; each mark shears 0.3–0.8 s later.
 *    Every opened inner eye adds a beam at its own angle.
 *  - HALO CLOSE (Guard): the arcs close in front; every broken arc weakens the shell (`guardShare`).
 *  - REVELATION (Ultimate): the inner eyes open and a lattice of gazes fans out, slowly turning; one beam per open eye + 3.
 *
 * Deterministic (tick-driven, no RNG); every scheduled fracture is sim state and is folded into the behaviour's hash.
 */

/** What the kit needs to know about the Witness's body this tick (provided by WitnessBehaviour). */
export interface WitnessKitHost {
  readonly f: FighterImpl;
  readonly wr: WitnessRig;
  facing: 1 | -1;
  /** World eye centre. */
  eyeX: number;
  eyeY: number;
  /** Halo arcs: rig body, frame-local midpoint, rest angle about the eye (facing frame), alive. */
  halo: { body: number; mx: number; my: number; angle: number; alive: boolean }[];
  /** Arms: elbow and tip anchors (rig body + frame-local point), alive (the blade's segment still holds matter). */
  arms: { elbowBody: number; ex: number; ey: number; tipBody: number; tx: number; ty: number; alive: boolean }[];
  /** Inner eyes opened by damage (0..5). */
  openEyes: number;
}

const MAX_MARKS = 24;
/** Which move a fracture mark belongs to (meter and announcer bookkeeping). */
const SLOT_SIG = 0;
const SLOT_ULT = 1;
const SLOT_CRUSH = 2;
const MARK_SLOTS = ['signature', 'ultimate', 'crush'] as const;
const FX_W = 1024;
const FX_H = 640;
const BEAM_LEN = 230;
/** Halo shards: launch tick of the first (move tick), flight time (ticks) and speed (px/tick). */
const MAX_SHARDS = 8;
const SHARD_LAUNCH = 12;
const SHARD_TICKS = 22;
const SHARD_SPEED = 9;

export class WitnessKit {
  /** Halo drive offsets (rad, facing frame) and arm heading offset for this tick. */
  readonly haloOffset: Float64Array;
  armOffset = 0;
  /** Widen the swing caps of the halo while it is used as a weapon / shield. */
  haloFree = false;
  /** Delayed fracture marks: foe-relative endpoints, the tick they shear, energy. */
  private readonly mOn = new Uint8Array(MAX_MARKS);
  private readonly mX0 = new Float64Array(MAX_MARKS);
  private readonly mY0 = new Float64Array(MAX_MARKS);
  private readonly mX1 = new Float64Array(MAX_MARKS);
  private readonly mY1 = new Float64Array(MAX_MARKS);
  private readonly mFire = new Int32Array(MAX_MARKS);
  private readonly mBorn = new Int32Array(MAX_MARKS);
  private readonly mE = new Float64Array(MAX_MARKS);
  private readonly mSlot = new Uint8Array(MAX_MARKS);
  private markCursor = 0;
  /** Shards in flight: launch point, direction, launch tick (−1 = none). */
  private readonly shX = new Float64Array(MAX_SHARDS);
  private readonly shY = new Float64Array(MAX_SHARDS);
  private readonly shUx = new Float64Array(MAX_SHARDS);
  private readonly shUy = new Float64Array(MAX_SHARDS);
  private readonly shT = new Int32Array(MAX_SHARDS).fill(-1);
  /** One hit per volume per move (bit k = volume k). */
  private hitMask = 0;
  private moveDef: ActiveMove['def'] = null;
  private moveTickSeen = 0;
  private readonly sh: FatShape = makeFatShape();
  private readonly pa = { x: 0, y: 0 };
  private readonly pb = { x: 0, y: 0 };
  private readonly ov: OverlapResult = { cells: 0, x: NaN, y: NaN, nearestX: NaN, nearestY: NaN, coverage: 0 };
  readonly fx: Overlay;

  constructor(haloCount: number) {
    this.haloOffset = new Float64Array(haloCount);
    this.fx = new Overlay('witness-fx', 20, FX_W, FX_H, 'add', true);
  }

  /** A new round: no fractures pending, nothing drawn. */
  reset(): void {
    this.mOn.fill(0);
    this.shT.fill(-1);
    this.hitMask = 0;
    this.moveDef = null;
    this.moveTickSeen = 0;
    this.fx.hide();
  }

  /** Share (0..1) of the Guard shell left: the halo is the shield. */
  guardShare(h: WitnessKitHost): number {
    let alive = 0;
    for (const a of h.halo) if (a.alive) alive++;
    return 0.25 + (0.75 * alive) / Math.max(1, h.halo.length);
  }

  /** Before the rig steps: set this tick's drive offsets from the move in progress. */
  steer(h: WitnessKitHost): void {
    const f = h.f;
    const m = f.mv;
    const kind = (m.def?.extra?.['witness'] as string | undefined) ?? '';
    const aim = Math.atan2(f.aimUy, f.aimUx * h.facing); // attack direction in the facing frame
    this.haloFree = false;
    this.armOffset = 0;
    this.haloOffset.fill(0);
    // a new move (or the same move restarted: its tick falls back) clears the per-volume hit memory
    if (m.def !== this.moveDef || m.tick < this.moveTickSeen) this.hitMask = 0;
    this.moveDef = m.def;
    this.moveTickSeen = m.tick;
    if (f.guardUp) {
      // HALO CLOSE: every live arc turns toward the front, crowding into a shield
      this.haloFree = true;
      h.halo.forEach((a, k) => {
        if (a.alive) this.haloOffset[k] = clamp(wrapAngle(aim - a.angle) * 0.85, -1.6, 1.6);
      });
      return;
    }
    if (!m.def || m.feint) return;
    if (kind === 'halo') {
      // HALO SHARDS: arc k leaves 3 ticks after arc k−1 and swings through the lane to the far side
      this.haloFree = true;
      const t = m.tick;
      h.halo.forEach((a, k) => {
        if (!a.alive) return;
        const start = 4 + k * 3;
        const u = clamp01((t - start) / 18);
        const through = wrapAngle(aim - a.angle);
        // first toward the lane, then past it: the arc sweeps across the front
        this.haloOffset[k] = clamp(through * Math.min(1, u * 1.6) + (u > 0.6 ? (u - 0.6) * 0.8 * Math.sign(through) : 0), -1.8, 1.8);
      });
    } else if (kind === 'sweep') {
      // SWEEPING ARCHITECTURE: wind the arms back against the turn, then sweep them through it (the tips arrive late)
      // (the up variant sweeps up through the front — counter-clockwise in the y-down facing frame — the others down)
      const dir = m.variant !== null && m.variant === m.def.variants.up ? -1 : 1;
      if (m.phase === 'startup') this.armOffset = -0.45 * dir * clamp01(m.phaseTick / Math.max(1, m.startup * 0.7));
      else if (m.phase === 'active') this.armOffset = 0.85 * dir;
      else if (m.phase === 'recovery')
        this.armOffset = 0.85 * dir * (1 - clamp01(m.phaseTick / Math.max(1, m.recovery * 0.6)));
    }
  }

  /** After the rig placed the regions: the move's hit volumes, the scheduled fractures, and the FX. */
  strike(h: WitnessKitHost): void {
    const f = h.f;
    const m = f.mv;
    const kind = (m.def?.extra?.['witness'] as string | undefined) ?? '';
    const live = m.def !== null && !m.feint;
    const rig = h.wr.rig;
    if (live && kind === 'halo' && (m.phase === 'active' || m.phase === 'recovery')) {
      h.halo.forEach((a, k) => {
        if (!a.alive || this.hitMask & (1 << k)) return;
        rig.worldPoint(a.body, a.mx, a.my, this.pa);
        this.toWorld(h, this.pa);
        const s = this.sh;
        s.kind = 'point';
        s.x = this.pa.x;
        s.y = this.pa.y;
        s.r = 10;
        if (this.hit(f, s, 'FRACTURE', 90, { penetration: 6, scatter: 0.9 }, 60, -10, 0.15, 6, 'strike', m.def!.id)) this.hitMask |= 1 << k;
      });
    }
    // HALO SHARDS: as each live arc swings through the lane it sheds a shard of light down the attack axis
    if (live && kind === 'halo')
      h.halo.forEach((a, k) => {
        if (!a.alive || k >= MAX_SHARDS || m.tick !== SHARD_LAUNCH + 3 * k) return;
        rig.worldPoint(a.body, a.mx, a.my, this.pa);
        this.toWorld(h, this.pa);
        this.shX[k] = this.pa.x;
        this.shY[k] = this.pa.y;
        this.shUx[k] = f.aimUx;
        this.shUy[k] = f.aimUy;
        this.shT[k] = f.tickNo;
      });
    for (let k = 0; k < MAX_SHARDS; k++) {
      if (this.shT[k]! < 0) continue;
      const age = f.tickNo - this.shT[k]!;
      if (age > SHARD_TICKS) {
        this.shT[k] = -1;
        continue;
      }
      const d = age * SHARD_SPEED;
      const x = this.shX[k]! + this.shUx[k]! * d;
      const y = this.shY[k]! + this.shUy[k]! * d;
      this.drawBeam(x - this.shUx[k]! * 16, y - this.shUy[k]! * 16, x, y, 0.9 * (1 - age / (SHARD_TICKS + 4)), 3);
      const bit = 1 << (16 + k);
      if (this.hitMask & bit) continue;
      const s = this.sh;
      s.kind = 'point';
      s.x = x;
      s.y = y;
      s.r = 8;
      if (this.hit(f, s, 'FRACTURE', 110, { penetration: 10, scatter: 0.8 }, 70, -8, 0.2, 5, 'strike', 'witness.halo')) {
        this.hitMask |= bit;
        this.shT[k] = -1;
      }
    }
    if (live && kind === 'sweep' && m.variant !== null && (m.phase === 'active' || (m.phase === 'recovery' && m.phaseTick < m.recovery * 0.6))) {
      const down = m.variant === m.def!.variants.down;
      if (!down)
        h.arms.forEach((arm, k) => {
          if (!arm.alive || this.hitMask & (1 << (8 + k))) return;
          rig.worldPoint(arm.elbowBody, arm.ex, arm.ey, this.pa);
          rig.worldPoint(arm.tipBody, arm.tx, arm.ty, this.pb);
          this.toWorld(h, this.pa);
          this.toWorld(h, this.pb);
          const s = this.sh;
          s.kind = 'line';
          s.x0 = this.pa.x;
          s.y0 = this.pa.y;
          s.x1 = this.pb.x;
          s.y1 = this.pb.y;
          s.width = 12;
          if (this.hit(f, s, 'FRACTURE', 440, { crackSeeds: 3, crackStress: 220, penetration: 12, scatter: 1.1 }, 200, -40, 0.8, 10, 'crush', m.def!.id))
            this.hitMask |= 1 << (8 + k);
        });
      else if (m.phase === 'active' && m.phaseTick === 1) {
        // STRUCTURAL SHEAR: a fracture path along the attack axis, shearing in three beats 0.33, 0.53, 0.73 s later
        const ux = f.aimUx;
        const uy = f.aimUy;
        for (let k = 0; k < 3; k++) {
          const d0 = 50 + k * 34;
          this.mark(h, h.eyeX + ux * d0, h.eyeY + uy * d0, h.eyeX + ux * (d0 + 40), h.eyeY + uy * (d0 + 40), 20 + k * 12, 260, false, SLOT_CRUSH);
        }
      }
    }
    if (live && kind === 'gaze' && m.phase === 'active') {
      // the main beam is the JSON hitbox; it MARKS what it crosses, and every opened inner eye adds a beam
      if (f.liveHitShape(0, m.phaseTick - 1, this.sh) && this.sh.kind === 'line') {
        this.drawBeam(this.sh.x0, this.sh.y0, this.sh.x1, this.sh.y1, 0.9);
        const ov = (m.phaseTick & 3) === 1 ? f.foe.probe(asShape(this.sh), this.ov) : null;
        if (ov !== null && ov.cells > 0) {
          const dx = this.sh.x1 - this.sh.x0;
          const dy = this.sh.y1 - this.sh.y0;
          const l = Math.hypot(dx, dy) || 1;
          const cx = ov.x;
          const cy = ov.y;
          const delay = 18 + ((f.tickNo * 7) % 31);
          this.mark(h, cx - (dx / l) * 22, cy - (dy / l) * 22, cx + (dx / l) * 22, cy + (dy / l) * 22, delay, 150, true, SLOT_SIG);
        }
      }
      for (let k = 0; k < h.openEyes; k++) {
        const side = k % 2 === 0 ? 1 : -1;
        const ang = Math.atan2(f.aimUy, f.aimUx) + side * 0.2 * (1 + (k >> 1));
        this.beam(h, ang, BEAM_LEN * 0.85, 36, 6, 'signature', m.def!.id, m.phaseTick);
      }
    }
    if (live && kind === 'revelation' && m.phase === 'active') {
      const n = 3 + h.openEyes;
      const base = Math.atan2(f.aimUy, f.aimUx);
      const turn = 0.35 * Math.sin(m.phaseTick * 0.045);
      for (let k = 0; k < n; k++) {
        const ang = base + turn + (n > 1 ? (k / (n - 1) - 0.5) * 1.3 : 0);
        // every beam that lands every 12 ticks also lays a fracture across the foe that shears 0.3–0.8 s later
        if (this.beam(h, ang, BEAM_LEN * 1.2, 70, 6, 'ultimate', m.def!.id, m.phaseTick + k * 3) && (m.phaseTick + k * 3) % 12 === 0) {
          const ov = f.foe.probe(asShape(this.sh), this.ov);
          if (ov.cells > 0) {
            const c = Math.cos(ang + 1.2) * 26;
            const s = Math.sin(ang + 1.2) * 26;
            this.mark(h, ov.x - c, ov.y - s, ov.x + c, ov.y + s, 18 + ((f.tickNo * 11 + k * 7) % 31), 170, true, SLOT_ULT);
          }
        }
      }
    }
    this.fireMarks(h);
  }

  /** A gaze beam from the eye at world angle `ang`: strikes every `rehit` ticks, drawn every tick. */
  private beam(h: WitnessKitHost, ang: number, len: number, energy: number, rehit: number, slot: 'signature' | 'ultimate', id: string, t: number): boolean {
    const s = this.sh;
    s.kind = 'line';
    s.x0 = h.eyeX;
    s.y0 = h.eyeY;
    s.x1 = h.eyeX + Math.cos(ang) * len;
    s.y1 = h.eyeY + Math.sin(ang) * len;
    s.width = 8;
    this.drawBeam(s.x0, s.y0, s.x1, s.y1, 0.8);
    return t % rehit === 0 && this.hit(h.f, s, 'FRACTURE', energy, { penetration: 30, scatter: 0.6 }, 8, 0, 0.05, 0, slot, id, DamageFlag.PIERCE | DamageFlag.CONTINUOUS);
  }

  /**
   * Schedule a fracture line (world coordinates now) that shears `delay` ticks later: with `onFoe` it is marked ON the foe and
   * travels with it (the gaze), otherwise it stays where it was laid down (the shear path).
   */
  private mark(h: WitnessKitHost, x0: number, y0: number, x1: number, y1: number, delay: number, energy: number, onFoe: boolean, slot: number): void {
    const fv = h.f.foe.view;
    const bx = onFoe ? fv.x : 0;
    const by = onFoe ? fv.y : 0;
    const k = this.markCursor;
    this.markCursor = (k + 1) % MAX_MARKS;
    this.mOn[k] = onFoe ? 2 : 1;
    this.mSlot[k] = slot;
    this.mX0[k] = x0 - bx;
    this.mY0[k] = y0 - by;
    this.mX1[k] = x1 - bx;
    this.mY1[k] = y1 - by;
    this.mFire[k] = h.f.tickNo + delay;
    this.mBorn[k] = h.f.tickNo;
    this.mE[k] = energy;
  }

  private fireMarks(h: WitnessKitHost): void {
    const f = h.f;
    const fv = f.foe.view;
    for (let k = 0; k < MAX_MARKS; k++) {
      if (!this.mOn[k]) continue;
      const bx = this.mOn[k] === 2 ? fv.x : 0;
      const by = this.mOn[k] === 2 ? fv.y : 0;
      const x0 = bx + this.mX0[k]!;
      const y0 = by + this.mY0[k]!;
      const x1 = bx + this.mX1[k]!;
      const y1 = by + this.mY1[k]!;
      const life = this.mFire[k]! - this.mBorn[k]!;
      const u = clamp01((f.tickNo - this.mBorn[k]!) / Math.max(1, life));
      // the telegraph: a hairline that brightens until it shears
      this.drawBeam(x0, y0, x1, y1, 0.15 + 0.55 * u * u, 1.2);
      if (f.tickNo < this.mFire[k]!) continue;
      this.mOn[k] = 0;
      const s = this.sh;
      s.kind = 'line';
      s.x0 = x0;
      s.y0 = y0;
      s.x1 = x1;
      s.y1 = y1;
      s.width = 4;
      this.hit(f, s, 'FRACTURE', this.mE[k]!, { crackSeeds: 4, crackStress: 260, penetration: 30, scatter: 1 }, 40, 0, 0.2, 6, MARK_SLOTS[this.mSlot[k]!]!, 'witness.fracture', DamageFlag.PIERCE | DamageFlag.SEED_CRACK);
      this.drawBeam(x0, y0, x1, y1, 1.2, 3);
    }
  }

  private hit(
    f: FighterImpl,
    s: FatShape,
    type: DamageType,
    energy: number,
    params: Record<string, number>,
    kbx: number,
    kby: number,
    guardPressure: number,
    hitstop: number,
    slot: 'strike' | 'crush' | 'signature' | 'ultimate',
    id: string,
    flags = 0,
  ): boolean {
    return f.strike(s, { type, energy, duration: 1, flags, params }, kbx, kby, guardPressure, hitstop, slot, id);
  }


  /** Rig points are in the facing frame: mirror x into the world. */
  private toWorld(h: WitnessKitHost, p: { x: number; y: number }): void {
    p.x *= h.facing;
  }

  /** Cyan-white additive beam (core + halo), per pixel from the distance to the axis. */
  drawBeam(x0: number, y0: number, x1: number, y1: number, gain: number, width = 4): void {
    const fx = this.fx;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const reach = width * 1.8;
    const bx0 = Math.max(fx.ox, Math.floor(Math.min(x0, x1) - reach));
    const bx1 = Math.min(fx.ox + fx.w - 1, Math.ceil(Math.max(x0, x1) + reach));
    const by0 = Math.max(fx.oy, Math.floor(Math.min(y0, y1) - reach));
    const by1 = Math.min(fx.oy + fx.h - 1, Math.ceil(Math.max(y0, y1) + reach));
    for (let y = by0; y <= by1; y++)
      for (let x = bx0; x <= bx1; x++) {
        const px = x + 0.5 - x0;
        const py = y + 0.5 - y0;
        const along = px * ux + py * uy;
        if (along < 0 || along > len) continue;
        const perp = Math.abs(py * ux - px * uy);
        if (perp > reach) continue;
        const q = perp / reach;
        const k = (1 - q) * (1 - q) * gain;
        const core = perp < width * 0.35 ? 1 : 0;
        fx.add(x, y, (120 + 135 * core) * k, (220 + 35 * core) * k, 230 * k);
      }
  }

  /** Fold the scheduled fractures into a hash. */
  hash(h0: number): number {
    let h = Math.imul(h0 ^ this.hitMask, 0x01000193);
    for (let k = 0; k < MAX_SHARDS; k++) {
      if (this.shT[k]! < 0) continue;
      h = Math.imul(h ^ this.shT[k]!, 0x01000193);
      h = Math.imul(h ^ Math.round(this.shX[k]! * 16 + this.shUy[k]! * 4096), 0x01000193);
    }
    for (let k = 0; k < MAX_MARKS; k++) {
      if (!this.mOn[k]) continue;
      h = Math.imul(h ^ (this.mFire[k]! * 3 + this.mOn[k]!), 0x01000193);
      h = Math.imul(h ^ Math.round(this.mX0[k]! * 16), 0x01000193);
      h = Math.imul(h ^ Math.round(this.mY0[k]! * 16), 0x01000193);
    }
    return h >>> 0;
  }
}
