import { clamp, clamp01, hex, lerpAngle, type BodyTransform } from '@/contracts';
import type { TendrilRoot } from '@/titans';
import type { Overlay } from '../fx/overlay';
import type { SplinePen, SplineStyle } from '../fx/spline';
import { DMath } from '@/contracts/dmath';

/**
 * The Last One's tendrils: 24 verlet chains rooted on shell anchors. They are NOT in the matter map — they are the eye's
 * shield and the Last One's whips. Pooled typed arrays, fixed iteration count, unconditionally stable (positions are
 * re-projected to segment length every tick), deterministic (no RNG, only the tick counter for sway).
 *
 * Each chain hangs along its own grown rest curve (a curl plus an S-wave, integrated node by node), and a travelling wave runs
 * down it for the idle sway. Whips follow a smoothed, lagging target along a bowed arc (a quadratic curve whose control point
 * trails the target's motion), so a strike reads as a lash that arrives tip-last, never as a straight rake. Drawn as Catmull-Rom
 * splines by `SplinePen` (tapered, lit per pixel, outlined, jointed).
 */

export const NODES = 12;
const ITER = 4;
/** Velocity kept per tick: heavy damping, so nothing jiggles (D28: planet scale, no fast wobble). */
const DAMP = 0.9;
/** Sag toward +y per tick². */
const SAG = 0.012;
const PIECES = 10;
/** How far the whip's mid-chain trails the moving target (ticks of target motion). */
const TRAIL = 3.2;
/** Longest stretch of a whip (× natural length). */
const EXT_MAX = 4.4;
/** Ticks a released whip takes to fold back to its rest curve (after its staggered delay), and the damping meanwhile. */
const RETURN_TICKS = 45;
const DAMP_RETURN = 0.8;
/** Most a whip arc may turn end to end (rad). */
const MAX_TURN = 2.4;
/** Least distance between nodes k and k − 2, in segments (0.9 ⇔ a joint bends at most ~127°), enforced softly. */
const MIN_FOLD = 0.9;
/** Share of the difference to the neighbours' velocity removed each tick (internal damping). */
const INNER_DAMP = 0.5;
/** Ticks a hit's recoil is spread over. */
const RECOIL_TICKS = 10;

/** What the posture solver should push the chains toward this tick (weights 0..1, smoothed by the caller). */
export interface Posture {
  /** Curl around the eye (Guard). */
  guard: number;
  /** Fan upward (Ultimate startup / Last Light). */
  rise: number;
  /** Pull tips toward the eye (Gaze charge). */
  focus: number;
  /** Limp (KO). */
  limp: number;
  /** Extra sway amplitude while moving. */
  agitation: number;
  /** World eye position for the guard/focus targets. */
  eyeX: number;
  eyeY: number;
}

export interface TendrilPalette {
  /** Shell ramp dark→light (packed). */
  body: number[];
  /** Glowing tip ramp dark→light. */
  tip: number[];
}

export class TendrilSystem {
  readonly n: number;
  readonly roots: TendrilRoot[];
  /** Node positions (world) and previous positions, [tendril*NODES + k]. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly px: Float32Array;
  readonly py: Float32Array;
  /** Segment length per tendril (px), live node count (0 = gone), hit points. */
  readonly seg: Float32Array;
  readonly count: Int8Array;
  readonly hp: Float32Array;
  /** World root positions this tick and last. */
  readonly rx: Float32Array;
  readonly ry: Float32Array;
  private readonly prx: Float32Array;
  private readonly pry: Float32Array;
  /** Per-tendril steering targets for scripted moves (whip tip), and blend weight 0..1. */
  readonly tx: Float32Array;
  readonly ty: Float32Array;
  readonly tw: Float32Array;
  /**
   * Preferred bend of the whip arc: a signed half-turn (rad; + bulges to the left of root → target). While the target sweeps,
   * the bend follows the sweep so the mid-chain trails it; its magnitude stays.
   */
  readonly tb: Float32Array;
  /** The bend actually used (magnitude, eased; side fixed per whip), and the return-to-rest clock (−1 = not returning). */
  private readonly bowCur: Float32Array;
  private readonly bowSign: Int8Array;
  private readonly prevTw: Float32Array;
  private readonly ret: Int16Array;
  private readonly retDelay: Int8Array;
  /** Elastic extension factor per tendril (1 = natural length; whips stretch toward their target) and its target. */
  readonly ext: Float32Array;
  private readonly extT: Float32Array;
  private readonly restAng: Float32Array;
  /** The lagging whip target (what the tip actually chases) and its motion last tick. */
  private readonly sx: Float32Array;
  private readonly sy: Float32Array;
  private readonly svx: Float32Array;
  private readonly svy: Float32Array;
  private readonly lag: Float32Array;
  private readonly wasWhip: Uint8Array;

  /* falling pieces (severed tips) */
  private readonly pieceOn: Uint8Array;
  private readonly pieceLen: Int8Array;
  private readonly pieceFrom: Int8Array;
  private readonly pieceLife: Int16Array;
  private readonly pieceX: Float32Array;
  private readonly pieceY: Float32Array;
  private readonly piecePX: Float32Array;
  private readonly piecePY: Float32Array;
  private readonly pieceSeg: Float32Array;
  private pieceCursor = 0;
  /** Pending recoil (px) and the ticks left to deliver it. */
  private recX = 0;
  private recY = 0;
  private recT = 0;
  /** Low-passed body velocity (px/s). */
  private vfx = 0;
  private vfy = 0;
  private readonly hpMax = 100;

  constructor(roots: TendrilRoot[]) {
    this.n = roots.length;
    this.roots = roots;
    const m = this.n * NODES;
    this.x = new Float32Array(m);
    this.y = new Float32Array(m);
    this.px = new Float32Array(m);
    this.py = new Float32Array(m);
    this.seg = new Float32Array(this.n);
    this.count = new Int8Array(this.n);
    this.hp = new Float32Array(this.n);
    this.rx = new Float32Array(this.n);
    this.ry = new Float32Array(this.n);
    this.prx = new Float32Array(this.n);
    this.pry = new Float32Array(this.n);
    this.tx = new Float32Array(this.n);
    this.ty = new Float32Array(this.n);
    this.tw = new Float32Array(this.n);
    this.tb = new Float32Array(this.n);
    this.bowCur = new Float32Array(this.n);
    this.bowSign = new Int8Array(this.n).fill(1);
    this.prevTw = new Float32Array(this.n);
    this.ret = new Int16Array(this.n).fill(-1);
    // staggered return: neighbours fold back on different ticks (0..8)
    this.retDelay = new Int8Array(this.n);
    for (let i = 0; i < this.n; i++) this.retDelay[i] = (i * 7) % 9;
    this.ext = new Float32Array(this.n).fill(1);
    this.extT = new Float32Array(this.n).fill(1);
    this.restAng = new Float32Array(this.n);
    this.sx = new Float32Array(this.n);
    this.sy = new Float32Array(this.n);
    this.svx = new Float32Array(this.n);
    this.svy = new Float32Array(this.n);
    this.lag = new Float32Array(this.n);
    this.wasWhip = new Uint8Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const r = roots[i]!;
      this.seg[i] = r.len / (NODES - 1);
      this.count[i] = NODES;
      this.hp[i] = this.hpMax;
      // rest direction (body-local, +x forward): hang down and trail back; the root normal bends it outward
      let dx: number;
      let dy: number;
      switch (r.kind) {
        case 'hem':
          dx = -0.12;
          dy = 1;
          break;
        case 'back':
          dx = -0.55;
          dy = 0.95;
          break;
        case 'crown':
          dx = -0.75;
          dy = -0.55;
          break;
        default:
          dx = 0.6;
          dy = 0.85;
      }
      // the hem fans out like a skirt (outward normal weighted up) instead of hanging as parallel legs
      const fan = r.kind === 'hem' ? 1.1 : 0.5;
      dx = dx * 0.8 + r.nx * fan;
      dy = dy * 0.8 + r.ny * 0.5;
      // the curl bends the chain over its length: start it rotated back by half the curl so the whole curve keeps the fan
      this.restAng[i] = DMath.atan2(dy, dx) - r.curl * 0.45;
      // staggered lag: neighbours never arrive together (golden-ratio spread of rates)
      this.lag[i] = 0.05 + 0.04 * ((i * 0.618034) % 1);
    }
    this.pieceOn = new Uint8Array(PIECES);
    this.pieceLen = new Int8Array(PIECES);
    this.pieceFrom = new Int8Array(PIECES);
    this.pieceLife = new Int16Array(PIECES);
    this.pieceX = new Float32Array(PIECES * NODES);
    this.pieceY = new Float32Array(PIECES * NODES);
    this.piecePX = new Float32Array(PIECES * NODES);
    this.piecePY = new Float32Array(PIECES * NODES);
    this.pieceSeg = new Float32Array(PIECES);
  }

  /** Remaining tendril length as a fraction of pristine (0..1): a tendril cut in half counts for half. */
  lengthFrac(): number {
    let c = 0;
    for (let i = 0; i < this.n; i++) c += this.count[i]! >= 4 ? this.count[i]! : 0;
    return c / (this.n * NODES);
  }

  /** Tendrils left, in whole tendrils (partial ones add up): what the HUD pips and the eye's exposure read. */
  aliveCount(): number {
    return Math.round(this.lengthFrac() * this.n);
  }

  /** Heading of segment k (world, rad) on tendril i's rest curve, before posture: grown curl + S-wave + travelling sway. */
  private restHeading(i: number, k: number, base: number, f: number, sway: number, tick: number): number {
    const r = this.roots[i]!;
    const u = k / (NODES - 1);
    const s = DMath.sin(u * 4.4 + r.wavePh);
    // a slow wave travelling down the length: period ≈ 4.2 s
    const travel = DMath.sin(tick * 0.025 + r.phase * 6.283 - u * 2.6) * sway * (0.35 + u);
    return base + (r.curl * u + r.wave * s + travel) * f;
  }

  /** Place every chain at rest (world). Call after the body is positioned (creation, new round). */
  settle(t: BodyTransform): void {
    this.updateRoots(t);
    for (let i = 0; i < this.n; i++) {
      const base = i * NODES;
      const a0 = this.localDirFrom(this.restAng[i]!, t.facing);
      let x = this.rx[i]!;
      let y = this.ry[i]!;
      for (let k = 0; k < NODES; k++) {
        if (k > 0) {
          const a = this.restHeading(i, k, a0, t.facing, 0, 0);
          x += DMath.cos(a) * this.seg[i]!;
          y += DMath.sin(a) * this.seg[i]!;
        }
        const j = base + k;
        this.x[j] = x;
        this.y[j] = y;
        this.px[j] = x;
        this.py[j] = y;
      }
      this.sx[i] = x;
      this.sy[i] = y;
      this.svx[i] = 0;
      this.svy[i] = 0;
      this.wasWhip[i] = 0;
      this.tw[i] = 0;
      this.ret[i] = -1;
      this.bowCur[i] = 0;
    }
  }

  /**
   * Root world positions from the body transform (mirror + lean aware). With `smooth`, the continuous (pre-rounding) root and
   * lean are used instead of the whole-pixel transform: the chains then hang from a root that glides, instead of being
   * yanked by a pixel each time the sprite steps (that saw-tooth read as a fast jiggle of every tip, D28).
   */
  private updateRoots(t: BodyTransform, smooth: { x: number; y: number; lean: number } | null = null): void {
    for (let i = 0; i < this.n; i++) {
      const r = this.roots[i]!;
      this.prx[i] = this.rx[i]!;
      this.pry[i] = this.ry[i]!;
      const ly = Math.floor(r.y);
      if (smooth) {
        const shift = (smooth.lean * (t.anchorY - ly)) / Math.max(1, t.anchorY);
        this.rx[i] = smooth.x + (r.x - t.anchorX) * t.facing + shift;
        this.ry[i] = smooth.y + (r.y - t.anchorY);
      } else {
        const shift = Math.round((t.lean * (t.anchorY - ly)) / Math.max(1, t.anchorY));
        this.rx[i] = t.x + (r.x - t.anchorX) * t.facing + shift;
        this.ry[i] = t.y + (r.y - t.anchorY);
      }
    }
  }

  /**
   * Advance one tick. `vbx,vby` is the body's velocity (px/s) so chains trail it; `facing` mirrors rest postures. `smooth`
   * (optional) is the body's continuous root and world lean (see `updateRoots`).
   */
  step(
    t: BodyTransform,
    posture: Posture,
    vbx: number,
    vby: number,
    tick: number,
    smooth: { x: number; y: number; lean: number } | null = null,
  ): void {
    this.updateRoots(t, smooth);
    this.stepRecoil();
    // the body velocity the chains trail, low-passed (τ ≈ 0.2 s): a stepping velocity would shake every tip each tick
    this.vfx += (vbx - this.vfx) * 0.08;
    this.vfy += (vby - this.vfy) * 0.08;
    vbx = this.vfx;
    vby = this.vfy;
    const f = t.facing;
    const spd = DMath.hypot(vbx, vby);
    const swayAmp = 0.14 + 0.2 * posture.agitation;
    for (let i = 0; i < this.n; i++) {
      const cnt = this.count[i]!;
      if (cnt <= 0) continue;
      const base = i * NODES;
      const rxi = this.rx[i]!;
      const ryi = this.ry[i]!;
      // rest posture: base direction (rising fans them upward), then the grown curve integrated node by node
      let ang = this.restAng[i]!;
      if (posture.rise > 0.01) ang = lerpAngle(ang, -1.5708 + (i / (this.n - 1) - 0.5) * 1.5, posture.rise);
      const wd = this.localDirFrom(ang, f);
      const guardAng = DMath.atan2(posture.eyeY - ryi, posture.eyeX - rxi);

      // whip state: scripted (the behaviour asserts tw), returning (folding back to the rest curve after a whip, staggered and
      // damped), or free
      const raw = this.tw[i]!;
      // a whip the behaviour has let go of (its weight decaying) starts folding back at once, not when it has gone limp
      const decaying = raw < this.prevTw[i]! - 1e-4;
      this.prevTw[i] = raw;
      const asserted = raw > 0.05 && !(decaying && raw < 0.45 && (this.wasWhip[i] || this.ret[i]! >= 0));
      let tw = raw;
      let tgx = this.tx[i]!;
      let tgy = this.ty[i]!;
      let returning = false;
      if (asserted) this.ret[i] = -1;
      else if (this.wasWhip[i] || this.ret[i]! >= 0) {
        const r = this.ret[i]! < 0 ? 0 : this.ret[i]!;
        const delay = this.retDelay[i]!;
        const w = r < delay ? 1 : 1 - (r - delay) / RETURN_TICKS;
        if (w > 0) {
          this.ret[i] = r + 1;
          returning = true;
          tw = 0.75 * w;
          // aim at the tip of its own rest curve: the whip folds back along its arc instead of dropping into a heap
          let qx = rxi;
          let qy = ryi;
          for (let k = 1; k < NODES; k++) {
            const a = this.restHeading(i, k, wd, f, swayAmp, tick);
            qx += DMath.cos(a) * this.seg[i]!;
            qy += DMath.sin(a) * this.seg[i]!;
          }
          tgx = qx;
          tgy = qy;
        } else {
          this.ret[i] = -1;
          tw = 0;
        }
      }
      const whip = tw > 0.05;
      // the target the tip chases lags behind the scripted one; it starts from where the tip is when a whip begins
      if (whip && !this.wasWhip[i] && !returning) {
        this.sx[i] = this.x[base + cnt - 1]!;
        this.sy[i] = this.y[base + cnt - 1]!;
        this.svx[i] = 0;
        this.svy[i] = 0;
        this.bowCur[i] = Math.abs(this.tb[i]!);
        this.bowSign[i] = this.tb[i]! < 0 ? -1 : 1;
      }
      this.wasWhip[i] = whip && !returning ? 1 : 0;
      // the arc: root → lagging target, bent by a signed half-turn φ (uniform curvature: no straight run anywhere)
      let arcX = 0;
      let arcY = 0;
      let arcL = 0;
      let arcB = 0;
      let arcK = 0;
      if (whip) {
        const lag = returning ? this.lag[i]! * 0.55 : this.lag[i]!;
        // the target swings AROUND the root (polar interpolation), never through it: a scythe sweep that keeps the whip long,
        // instead of a chord that collapses the chain into a hairpin
        const ca = DMath.atan2(this.sy[i]! - ryi, this.sx[i]! - rxi);
        const cr = DMath.hypot(this.sx[i]! - rxi, this.sy[i]! - ryi);
        const ta = DMath.atan2(tgy - ryi, tgx - rxi);
        const tr = DMath.hypot(tgx - rxi, tgy - ryi);
        const na = lerpAngle(ca, ta, lag);
        const nr = Math.max(this.seg[i]! * (NODES - 1) * 0.6, cr + (tr - cr) * lag);
        const nx = rxi + DMath.cos(na) * nr;
        const ny = ryi + DMath.sin(na) * nr;
        // the sweep relative to the root (a lunging body carries its whips; only the swing makes the mid-chain trail)
        this.svx[i] = nx - this.sx[i]! - (rxi - this.prx[i]!);
        this.svy[i] = ny - this.sy[i]! - (ryi - this.pry[i]!);
        this.sx[i] = nx;
        this.sy[i] = ny;
        let ex = nx - rxi;
        let ey = ny - ryi;
        let c = DMath.hypot(ex, ey) || 1;
        // the bend keeps the side it was given when the whip began (a flip would pass through a straight rod); its magnitude
        // eases toward the requested one, and long whips turn more, so curvature never drops below ~1 rad per 100 px
        const mag = returning ? this.bowCur[i]! : Math.abs(this.tb[i]!);
        this.bowCur[i] = this.bowCur[i]! + (mag - this.bowCur[i]!) * 0.3;
        const phi = this.bowSign[i]! * Math.max(this.bowCur[i]!, Math.min(1.1, 0.35 + c * 0.005));
        let L = Math.abs(phi) > 1e-3 ? (c * phi) / DMath.sin(phi) : c;
        // a tendril cannot stretch past EXT_MAX: reach a shorter arc instead of pulling the chain into a straight rod
        const maxL = this.seg[i]! * (NODES - 1) * EXT_MAX;
        if (L > maxL) {
          const k = maxL / L;
          ex *= k;
          ey *= k;
          c *= k;
          L = maxL;
        }
        arcL = L;
        arcB = DMath.atan2(ey, ex) + phi;
        arcK = 2 * phi;
        arcX = ex;
        arcY = ey;
        this.extT[i] = clamp(L / (this.seg[i]! * (NODES - 1)), 1, EXT_MAX);
      } else this.extT[i] = 1;
      this.ext[i] = this.ext[i]! + (this.extT[i]! - this.ext[i]!) * (whip ? (returning ? 0.2 : 0.35) : 0.12);
      const seg = this.seg[i]! * this.ext[i]!;
      const damp = returning ? DAMP_RETURN : DAMP;
      // the chain follows the SAME curvature for the length it actually has: shorter than the arc (still stretching out) it
      // is a partial arc that is still bending, never a taut chord; longer (still retracting) it continues the curve past the
      // target instead of buckling into a zigzag
      if (whip && Math.abs(arcK) >= 1e-4) {
        const have = seg * (cnt - 1);
        arcK *= have / arcL;
        arcL = have;
        // never more than ~140° of turn: a longer chain opens the curve instead of rolling into a spiral (a knot)
        if (arcK > MAX_TURN) arcK = MAX_TURN;
        else if (arcK < -MAX_TURN) arcK = -MAX_TURN;
      }
      // pin the root
      this.x[base] = rxi;
      this.y[base] = ryi;
      this.px[base] = rxi;
      this.py[base] = ryi;
      let restX = rxi;
      let restY = ryi;

      for (let k = 1; k < cnt; k++) {
        const j = base + k;
        const u = k / (NODES - 1);
        const a = this.restHeading(i, k, wd, f, swayAmp, tick);
        restX += DMath.cos(a) * seg;
        restY += DMath.sin(a) * seg;
        // Verlet integration with damping
        const vx = (this.x[j]! - this.px[j]!) * damp;
        const vy = (this.y[j]! - this.py[j]!) * damp;
        this.px[j] = this.x[j]!;
        this.py[j] = this.y[j]!;
        let ax = 0;
        let ay = SAG * (1 + 3 * posture.limp);

        // rest-shape spring toward the grown curve
        // hanging-part spring (scale spec: ω ≤ 4 rad/s; was ≈ 13 rad/s): k = 0.0057 per tick² ⇒ ω ≈ 4.5 at the root, ≈ 3 at the tip
        const stiff = (0.0045 * (1 - u * 0.5) + 0.0012) * (1 - posture.limp) * (1 - tw * 0.95);
        ax += (restX - this.x[j]!) * stiff;
        ay += (restY - this.y[j]!) * stiff;

        // Guard: curl around the eye
        if (posture.guard > 0.01) {
          const th = guardAng + Math.PI + (i / this.n) * 6.283 * 0.5 + u * 1.9 * (i % 2 === 0 ? 1 : -1);
          const rad = 24 + 9 * DMath.sin(i * 1.7) + u * 6;
          const gx = posture.eyeX + DMath.cos(th + tick * 0.02) * rad;
          const gy = posture.eyeY + DMath.sin(th + tick * 0.02) * rad * 0.9;
          const gs = 0.0045 * posture.guard * (0.4 + u);
          ax += (gx - this.x[j]!) * gs;
          ay += (gy - this.y[j]!) * gs;
        }
        // Gaze focus: tips lean in toward the eye
        if (posture.focus > 0.01) {
          const fs = 0.004 * posture.focus * u * u;
          ax += (posture.eyeX - this.x[j]!) * fs;
          ay += (posture.eyeY - 10 - this.y[j]!) * fs;
        }
        // drag opposite to the body's motion so chains trail it
        if (spd > 1) {
          ax -= (vbx / 60) * 0.03 * u;
          ay -= (vby / 60) * 0.03 * u;
        }
        this.x[j] = this.x[j]! + vx + ax;
        this.y[j] = this.y[j]! + vy + ay;
        // whip: each node is PROJECTED toward its point on the arc (uniform curvature: no straight run), the mid-chain
        // trailing the sweep; the tip snaps in last because its target lags. Projection (not force) keeps the shape while the
        // body lunges; 60 % of the correction is taken out of the velocity so it does not overshoot into a knot.
        if (whip) {
          let wx: number;
          let wy: number;
          const ua = k / (cnt - 1);
          if (Math.abs(arcK) < 1e-4) {
            wx = rxi + arcX * ua;
            wy = ryi + arcY * ua;
          } else {
            const r = arcL / arcK;
            wx = rxi + r * (DMath.sin(arcB) - DMath.sin(arcB - arcK * ua));
            wy = ryi + r * (DMath.cos(arcB - arcK * ua) - DMath.cos(arcB));
          }
          // the mid-chain trails the sweep a little (bounded: a fast sweep must not fold the whip into a V)
          const sv = DMath.hypot(this.svx[i]!, this.svy[i]!);
          if (sv > 1e-3) {
            const tr = (Math.min(sv * TRAIL, arcL * 0.08) * 4 * ua * (1 - ua)) / sv;
            wx -= this.svx[i]! * tr;
            wy -= this.svy[i]! * tr;
          }
          // the root leads (strongest pull near the root), the tip follows its own lagging target
          const kp = tw * (returning ? 0.25 - 0.06 * u : 0.85 - 0.15 * u);
          const dx = (wx - this.x[j]!) * kp;
          const dy = (wy - this.y[j]!) * kp;
          this.x[j] = this.x[j]! + dx;
          this.y[j] = this.y[j]! + dy;
          this.px[j] = this.px[j]! + dx * 0.85;
          this.py[j] = this.py[j]! + dy * 0.85;
        }
      }
      // distance constraints (root fixed)
      for (let it = 0; it < ITER; it++) {
        for (let k = 1; k < cnt; k++) {
          const a = base + k - 1;
          const b = base + k;
          const dx = this.x[b]! - this.x[a]!;
          const dy = this.y[b]! - this.y[a]!;
          const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
          const diff = (d - seg) / d;
          if (k === 1) {
            this.x[b] = this.x[b]! - dx * diff;
            this.y[b] = this.y[b]! - dy * diff;
          } else {
            this.x[a] = this.x[a]! + dx * diff * 0.5;
            this.y[a] = this.y[a]! + dy * diff * 0.5;
            this.x[b] = this.x[b]! - dx * diff * 0.5;
            this.y[b] = this.y[b]! - dy * diff * 0.5;
          }
          // bending limit: node k may not fold back onto node k − 2 (no hairpins, so a chain cannot tie itself in a knot)
          if (k >= 2) {
            const p = base + k - 2;
            const fx = this.x[b]! - this.x[p]!;
            const fy = this.y[b]! - this.y[p]!;
            const fd = Math.sqrt(fx * fx + fy * fy) || 1e-6;
            const minD = seg * MIN_FOLD;
            if (fd < minD) {
              // soft (a quarter of the way per pass): a hard limit chattered at the frame rate (D28)
              const push = ((minD - fd) / fd) * 0.125;
              if (k === 2) {
                this.x[b] = this.x[b]! + fx * push * 2;
                this.y[b] = this.y[b]! + fy * push * 2;
              } else {
                this.x[p] = this.x[p]! - fx * push;
                this.y[p] = this.y[p]! - fy * push;
                this.x[b] = this.x[b]! + fx * push;
                this.y[b] = this.y[b]! + fy * push;
              }
            }
          }
        }
      }
      // internal damping: each node's velocity is pulled toward its neighbours' (a Laplacian smoothing of the velocity
      // field). It kills the node-to-node (high-frequency) modes and leaves the long, slow swing of the whole chain (D28).
      for (let k = 1; k < cnt; k++) {
        const j = base + k;
        const pv = j - 1;
        const nx = k + 1 < cnt ? j + 1 : j;
        const vx = this.x[j]! - this.px[j]!;
        const vy = this.y[j]! - this.py[j]!;
        const ax = (this.x[pv]! - this.px[pv]! + (this.x[nx]! - this.px[nx]!)) * 0.5;
        const ay = (this.y[pv]! - this.py[pv]! + (this.y[nx]! - this.py[nx]!)) * 0.5;
        this.px[j] = this.px[j]! - (ax - vx) * INNER_DAMP;
        this.py[j] = this.py[j]! - (ay - vy) * INNER_DAMP;
      }
    }
    this.stepPieces();
  }

  private localDirFrom(ang: number, f: number): number {
    return DMath.atan2(DMath.sin(ang), DMath.cos(ang) * f);
  }

  /** Kick every chain (hit reaction): velocity added as a Verlet displacement of the previous positions. */
  recoil(dx: number, dy: number): void {
    // ramped over RECOIL_TICKS (scale spec: no one-tick impulse on a planet-scale part); a new blow adds to what is left
    this.recX += dx;
    this.recY += dy;
    this.recT = RECOIL_TICKS;
  }

  /** Apply this tick's share of the pending recoil (a smoothstep ramp). */
  private stepRecoil(): void {
    if (this.recT <= 0) return;
    const t = this.recT;
    // share of the remaining kick delivered now: the derivative of a smoothstep over the remaining ticks, normalised
    const share = t <= 1 ? 1 : (6 * (1 / t) * (1 - 1 / t)) / 1.5 + 1 / (t * t);
    const dx = this.recX * Math.min(1, share);
    const dy = this.recY * Math.min(1, share);
    this.recX -= dx;
    this.recY -= dy;
    this.recT--;
    for (let i = 0; i < this.n; i++) {
      const cnt = this.count[i]!;
      const base = i * NODES;
      for (let k = 1; k < cnt; k++) {
        const u = k / (NODES - 1);
        this.px[base + k] = this.px[base + k]! - dx * u;
        this.py[base + k] = this.py[base + k]! - dy * u;
      }
    }
  }

  /** Damage a tendril at its node `k`. Returns true if it was cut (and how many nodes were lost via `lost`). */
  damage(i: number, k: number, amount: number, out: { lost: number; x: number; y: number }): boolean {
    if (this.count[i]! <= 0) return false;
    this.hp[i] = this.hp[i]! - amount;
    if (this.hp[i]! > 0) return false;
    const cnt = this.count[i]!;
    const cut = clamp(k, 1, cnt - 1);
    out.x = this.x[i * NODES + cut]!;
    out.y = this.y[i * NODES + cut]!;
    this.spawnPiece(i, cut, cnt);
    out.lost = cnt - cut;
    this.count[i] = cut < 4 ? 0 : cut;
    this.hp[i] = this.hpMax * 0.6;
    return true;
  }

  private spawnPiece(i: number, from: number, to: number): void {
    const p = this.pieceCursor;
    this.pieceCursor = (p + 1) % PIECES;
    const len = to - from;
    this.pieceOn[p] = 1;
    this.pieceLen[p] = len;
    this.pieceFrom[p] = from;
    this.pieceLife[p] = 70;
    this.pieceSeg[p] = this.seg[i]!;
    for (let k = 0; k < len; k++) {
      const s = i * NODES + from + k;
      this.pieceX[p * NODES + k] = this.x[s]!;
      this.pieceY[p * NODES + k] = this.y[s]!;
      this.piecePX[p * NODES + k] = this.px[s]!;
      this.piecePY[p * NODES + k] = this.py[s]!;
    }
  }

  private stepPieces(): void {
    for (let p = 0; p < PIECES; p++) {
      if (!this.pieceOn[p]) continue;
      this.pieceLife[p]!--;
      if (this.pieceLife[p]! <= 0) {
        this.pieceOn[p] = 0;
        continue;
      }
      const len = this.pieceLen[p]!;
      const seg = this.pieceSeg[p]!;
      const b = p * NODES;
      for (let k = 0; k < len; k++) {
        const vx = (this.pieceX[b + k]! - this.piecePX[b + k]!) * 0.985;
        const vy = (this.pieceY[b + k]! - this.piecePY[b + k]!) * 0.985;
        this.piecePX[b + k] = this.pieceX[b + k]!;
        this.piecePY[b + k] = this.pieceY[b + k]!;
        this.pieceX[b + k] = this.pieceX[b + k]! + vx;
        this.pieceY[b + k] = this.pieceY[b + k]! + vy + 0.16;
      }
      for (let it = 0; it < 3; it++)
        for (let k = 1; k < len; k++) {
          const dx = this.pieceX[b + k]! - this.pieceX[b + k - 1]!;
          const dy = this.pieceY[b + k]! - this.pieceY[b + k - 1]!;
          const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
          const diff = ((d - seg) / d) * 0.5;
          this.pieceX[b + k - 1] = this.pieceX[b + k - 1]! + dx * diff;
          this.pieceY[b + k - 1] = this.pieceY[b + k - 1]! + dy * diff;
          this.pieceX[b + k] = this.pieceX[b + k]! - dx * diff;
          this.pieceY[b + k] = this.pieceY[b + k]! - dy * diff;
        }
    }
  }

  /** Regrow one node on the most-damaged tendril. Returns true if a tendril came back to life (count crossed 4). */
  regrowStep(): boolean {
    let best = -1;
    let bestCount = NODES;
    for (let i = 0; i < this.n; i++) {
      const c = this.count[i]!;
      if (c < NODES && c < bestCount) {
        best = i;
        bestCount = c;
      }
    }
    if (best < 0) return false;
    const was = this.count[best]!;
    if (was === 0) {
      // regrow from the root: start a short stub along the rest direction
      const base = best * NODES;
      for (let k = 0; k < NODES; k++) {
        this.x[base + k] = this.rx[best]!;
        this.y[base + k] = this.ry[best]!;
        this.px[base + k] = this.x[base + k]!;
        this.py[base + k] = this.y[base + k]!;
      }
      this.count[best] = 4;
      this.hp[best] = this.hpMax * 0.6;
      return true;
    }
    const base = best * NODES;
    const c = was;
    this.x[base + c] = this.x[base + c - 1]!;
    this.y[base + c] = this.y[base + c - 1]!;
    this.px[base + c] = this.x[base + c]!;
    this.py[base + c] = this.y[base + c]!;
    this.count[best] = c + 1;
    if (c + 1 >= NODES) this.hp[best] = this.hpMax;
    return false;
  }

  /** Bring every tendril back (new round): heal fraction 0..1 of the missing length. */
  heal(fraction: number, t: BodyTransform): void {
    for (let i = 0; i < this.n; i++) {
      const c = this.count[i]!;
      const target = Math.round(c + (NODES - c) * fraction);
      if (target > c) {
        const base = i * NODES;
        for (let k = Math.max(1, c); k < target; k++) {
          const src = base + Math.max(0, k - 1);
          this.x[base + k] = this.x[src]!;
          this.y[base + k] = this.y[src]!;
          this.px[base + k] = this.x[src]!;
          this.py[base + k] = this.y[src]!;
        }
        this.count[i] = target < 4 ? 0 : target;
        this.hp[i] = this.hpMax;
      }
    }
    this.pieceOn.fill(0);
    this.ret.fill(-1);
    this.wasWhip.fill(0);
    this.updateRoots(t);
  }

  /** Lagging whip target of tendril i (what its tip is chasing this tick). Tests and FX read it. */
  whipTarget(i: number, out: { x: number; y: number }): void {
    out.x = this.sx[i]!;
    out.y = this.sy[i]!;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  drawing
   * ---------------------------------------------------------------------------------------------- */

  /**
   * Rasterise tendrils whose `front` flag matches into `ov` as lit, tapered, jointed splines (see `SplinePen`). Severed pieces
   * fall behind the body, dissolving.
   */
  draw(ov: Overlay, pen: SplinePen, front: boolean, style: SplineStyle, glow: number): void {
    for (let i = 0; i < this.n; i++) {
      const isFront = this.roots[i]!.kind === 'front';
      if (isFront !== front) continue;
      const cnt = this.count[i]!;
      if (cnt < 2) continue;
      // stretched whips thin out (volume is conserved, roughly)
      const thin = clamp(1 / Math.sqrt(this.ext[i]!), 0.62, 1);
      pen.stroke(ov, this.x, this.y, i * NODES, cnt, NODES, style, thin, 1, glow);
    }
    if (!front) {
      for (let p = 0; p < PIECES; p++) {
        if (!this.pieceOn[p]) continue;
        const life = this.pieceLife[p]!;
        pen.stroke(
          ov,
          this.pieceX,
          this.pieceY,
          p * NODES,
          this.pieceLen[p]!,
          NODES,
          style,
          1,
          clamp01(life / 40),
          0,
          this.pieceFrom[p]!,
        );
      }
    }
  }
}

/** Build the tendril palette from the titan's material ramps. */
export function makeTendrilPalette(shellRamp: string[], giltRamp: string[]): TendrilPalette {
  return { body: shellRamp.map(hex), tip: giltRamp.map(hex) };
}

/**
 * The tendril stroke style: a jade-celadon tube 5 px thick at the root, tapering late to a 1-px gilt tip that glows, with a
 * bead joint every third node, a darker root and a selective outline (the darkest shell step on the shadow side).
 */
export function makeTendrilStyle(pal: TendrilPalette): SplineStyle {
  const b = pal.body;
  return {
    r0: 2.6,
    r1: 0.6,
    taperPow: 1.35,
    ramp: b.slice(1, 7),
    rootShade: -0.22,
    contrast: 0.95,
    tipRamp: pal.tip.slice(1),
    tipFrom: 0.7,
    tipEmissive: 180,
    jointEvery: 3,
    jointBulge: 0.38,
    outlineDark: b[0]!,
    outlineLit: b[2]!,
  };
}
