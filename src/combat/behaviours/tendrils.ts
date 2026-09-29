import { clamp, clamp01, hex, lerp, lerpAngle, type BodyTransform } from '@/contracts';
import { blend, type TendrilRoot } from '@/titans';
import type { Overlay } from '../fx/overlay';

/**
 * The Last One's tendrils: 24 verlet chains rooted on shell anchors. They are NOT in the matter map — they are the eye's
 * shield and the Last One's whips. Pooled typed arrays, fixed iteration count, unconditionally stable (positions are
 * re-projected to segment length every tick), deterministic (no RNG, only the tick counter for sway).
 */

export const NODES = 12;
const ITER = 4;
const DAMP = 0.93;
/** Sag toward +y per tick². */
const SAG = 0.045;
const PIECES = 10;

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
  /** Per-tendril steering targets for scripted moves (whip tip), and blend weight 0..1. */
  readonly tx: Float32Array;
  readonly ty: Float32Array;
  readonly tw: Float32Array;
  /** Elastic extension factor per tendril (1 = natural length; whips stretch toward their target) and its target. */
  readonly ext: Float32Array;
  private readonly extT: Float32Array;
  private readonly restAng: Float32Array;
  private readonly curl: Float32Array;

  /* falling pieces (severed tips) */
  private readonly pieceOn: Uint8Array;
  private readonly pieceLen: Int8Array;
  private readonly pieceLife: Int16Array;
  private readonly pieceX: Float32Array;
  private readonly pieceY: Float32Array;
  private readonly piecePX: Float32Array;
  private readonly piecePY: Float32Array;
  private readonly pieceSeg: Float32Array;
  private pieceCursor = 0;
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
    this.tx = new Float32Array(this.n);
    this.ty = new Float32Array(this.n);
    this.tw = new Float32Array(this.n);
    this.ext = new Float32Array(this.n).fill(1);
    this.extT = new Float32Array(this.n).fill(1);
    this.restAng = new Float32Array(this.n);
    this.curl = new Float32Array(this.n);
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
      dx = dx * 0.8 + r.nx * 0.5;
      dy = dy * 0.8 + r.ny * 0.5;
      this.restAng[i] = Math.atan2(dy, dx);
      this.curl[i] = (r.kind === 'crown' ? 0.09 : 0.05) * (r.phase > 0.5 ? 1 : -1);
    }
    this.pieceOn = new Uint8Array(PIECES);
    this.pieceLen = new Int8Array(PIECES);
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

  /** Place every chain at rest (world). Call after the body is positioned (creation, new round). */
  settle(t: BodyTransform): void {
    this.updateRoots(t);
    for (let i = 0; i < this.n; i++) {
      const dir = this.localDir(t, this.restAng[i]!);
      const base = i * NODES;
      for (let k = 0; k < NODES; k++) {
        const a = dir.a + this.curl[i]! * k * t.facing;
        const l = this.seg[i]! * k;
        const j = base + k;
        this.x[j] = this.rx[i]! + Math.cos(a) * l;
        this.y[j] = this.ry[i]! + Math.sin(a) * l;
        this.px[j] = this.x[j]!;
        this.py[j] = this.y[j]!;
      }
    }
  }

  /** Root world positions from the body transform (mirror + lean aware, integer-cell centres). */
  private updateRoots(t: BodyTransform): void {
    for (let i = 0; i < this.n; i++) {
      const r = this.roots[i]!;
      const ly = Math.floor(r.y);
      const shift = Math.round((t.lean * (t.anchorY - ly)) / Math.max(1, t.anchorY));
      this.rx[i] = t.x + (r.x - t.anchorX) * t.facing + shift;
      this.ry[i] = t.y + (r.y - t.anchorY);
    }
  }

  private readonly dirTmp = { a: 0 };
  /** Rest angle in world terms (mirrors x when the body faces left). */
  private localDir(t: BodyTransform, ang: number): { a: number } {
    const dx = Math.cos(ang) * t.facing;
    const dy = Math.sin(ang);
    this.dirTmp.a = Math.atan2(dy, dx);
    return this.dirTmp;
  }

  /**
   * Advance one tick. `vbx,vby` is the body's velocity (px/s) so chains trail it; `facing` mirrors rest postures.
   */
  step(t: BodyTransform, posture: Posture, vbx: number, vby: number, tick: number): void {
    this.updateRoots(t);
    const f = t.facing;
    const spd = Math.hypot(vbx, vby);
    for (let i = 0; i < this.n; i++) {
      const cnt = this.count[i]!;
      if (cnt <= 0) continue;
      const base = i * NODES;
      const root = this.roots[i]!;
      // elastic whips: stretch toward a scripted target, relax back when it lets go
      const twi = this.tw[i]!;
      if (twi > 0.05) {
        const reach = Math.hypot(this.tx[i]! - this.rx[i]!, this.ty[i]! - this.ry[i]!);
        this.extT[i] = clamp(reach / (this.seg[i]! * (NODES - 1)), 1, 4.4);
      } else this.extT[i] = 1;
      this.ext[i] = this.ext[i]! + (this.extT[i]! - this.ext[i]!) * (twi > 0.05 ? 0.5 : 0.14);
      const seg = this.seg[i]! * this.ext[i]!;
      // pin the root
      this.x[base] = this.rx[i]!;
      this.y[base] = this.ry[i]!;
      this.px[base] = this.x[base]!;
      this.py[base] = this.y[base]!;

      // target posture angle for this tendril
      const sway = Math.sin(tick * 0.035 + root.phase * 6.283) * (0.14 + 0.2 * posture.agitation);
      let ang = this.restAng[i]!;
      if (posture.rise > 0.01) ang = lerpAngle(ang, -1.5708 + (i / (this.n - 1) - 0.5) * 1.5, posture.rise);
      const wd = this.localDirFrom(ang, f);
      const guardAng = Math.atan2(posture.eyeY - this.ry[i]!, posture.eyeX - this.rx[i]!);
      const tw = this.tw[i]!;

      for (let k = 1; k < cnt; k++) {
        const j = base + k;
        const u = k / (NODES - 1);
        // Verlet integration with damping
        const vx = (this.x[j]! - this.px[j]!) * DAMP;
        const vy = (this.y[j]! - this.py[j]!) * DAMP;
        this.px[j] = this.x[j]!;
        this.py[j] = this.y[j]!;
        let ax = 0;
        let ay = SAG * (1 + 3 * posture.limp);

        // rest-shape spring: where node k would sit if the chain hung along its rest direction (with curl + sway)
        const a = wd + (this.curl[i]! * k + sway * u) * f;
        const stiff = (0.045 * (1 - u * 0.7) + 0.006) * (1 - posture.limp) * (1 - tw * 0.95);
        const txp = this.rx[i]! + Math.cos(a) * seg * k;
        const typ = this.ry[i]! + Math.sin(a) * seg * k;
        ax += (txp - this.x[j]!) * stiff;
        ay += (typ - this.y[j]!) * stiff;

        // Guard: curl around the eye
        if (posture.guard > 0.01) {
          const th = guardAng + Math.PI + (i / this.n) * 6.283 * 0.5 + u * 1.9 * (i % 2 === 0 ? 1 : -1);
          const rad = 24 + 9 * Math.sin(i * 1.7) + u * 6;
          const gx = posture.eyeX + Math.cos(th + tick * 0.02) * rad;
          const gy = posture.eyeY + Math.sin(th + tick * 0.02) * rad * 0.9;
          const gs = 0.09 * posture.guard * (0.4 + u);
          ax += (gx - this.x[j]!) * gs;
          ay += (gy - this.y[j]!) * gs;
        }
        // Gaze focus: tips lean in toward the eye
        if (posture.focus > 0.01) {
          const fs = 0.05 * posture.focus * u * u;
          ax += (posture.eyeX - this.x[j]!) * fs;
          ay += (posture.eyeY - 10 - this.y[j]!) * fs;
        }
        // scripted whip target: the tip is driven hard to where the hitbox goes, the rest of the chain trails it (curving)
        if (tw > 0.01) {
          const wx = this.rx[i]! + (this.tx[i]! - this.rx[i]!) * u;
          const wy = this.ry[i]! + (this.ty[i]! - this.ry[i]!) * u;
          const ws = tw * (0.02 + 0.3 * u * u * u);
          ax += clamp((wx - this.x[j]!) * ws, -7, 7);
          ay += clamp((wy - this.y[j]!) * ws, -7, 7);
        }
        // drag opposite to the body's motion so chains trail it
        if (spd > 1) {
          ax -= (vbx / 60) * 0.03 * u;
          ay -= (vby / 60) * 0.03 * u;
        }
        this.x[j] = this.x[j]! + vx + ax;
        this.y[j] = this.y[j]! + vy + ay;
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
        }
      }
    }
    this.stepPieces();
  }

  private localDirFrom(ang: number, f: number): number {
    return Math.atan2(Math.sin(ang), Math.cos(ang) * f);
  }

  /** Kick every chain (hit reaction): velocity added as a Verlet displacement of the previous positions. */
  recoil(dx: number, dy: number): void {
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
    this.updateRoots(t);
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  drawing
   * ---------------------------------------------------------------------------------------------- */

  /**
   * Rasterise tendrils whose `front` flag matches into `ov`. Tapered 3→1 px, shaded per segment with a hue shift toward a
   * glowing gold tip; the light comes from the upper left.
   */
  draw(ov: Overlay, front: boolean, pal: TendrilPalette, glow: number): void {
    for (let i = 0; i < this.n; i++) {
      const isFront = this.roots[i]!.kind === 'front';
      if (isFront !== front) continue;
      const cnt = this.count[i]!;
      if (cnt < 2) continue;
      const base = i * NODES;
      this.drawChain(ov, this.x, this.y, base, cnt, pal, glow, 1, this.ext[i]!);
    }
    if (!front) {
      for (let p = 0; p < PIECES; p++) {
        if (!this.pieceOn[p]) continue;
        const life = this.pieceLife[p]!;
        this.drawChain(
          ov,
          this.pieceX,
          this.pieceY,
          p * NODES,
          this.pieceLen[p]!,
          pal,
          0,
          clamp01(life / 40),
          1,
        );
      }
    }
  }

  private drawChain(
    ov: Overlay,
    xs: Float32Array,
    ys: Float32Array,
    base: number,
    cnt: number,
    pal: TendrilPalette,
    glow: number,
    opacity: number,
    ext: number,
  ): void {
    const body = pal.body;
    const tip = pal.tip;
    const nb = body.length - 1;
    const nt = tip.length - 1;
    const thin = clamp(1 / Math.sqrt(ext), 0.62, 1);
    const dissolve = opacity < 1;
    for (let k = 0; k + 1 < cnt; k++) {
      const u0 = k / (NODES - 1);
      const u1 = (k + 1) / (NODES - 1);
      const ax = xs[base + k]!;
      const ay = ys[base + k]!;
      const bx = xs[base + k + 1]!;
      const by = ys[base + k + 1]!;
      if (dissolve && ((Math.floor(ax * 3) * 7 + Math.floor(ay * 3) * 13) & 15) / 16 > opacity) continue;
      const b0 = clamp(Math.round(1 + (1 - u0) * 1.5), 0, nb);
      let cLit = body[clamp(b0 + 2, 0, nb)]!;
      let cMid = body[clamp(b0 + 1, 0, nb)]!;
      let cDark = body[b0]!;
      const tipZone = clamp01((u0 - 0.7) / 0.3);
      let em = 0;
      if (tipZone > 0) {
        const g = Math.round(glow * 1.5);
        const t0 = clamp(Math.round(tipZone * 2) + g, 0, nt);
        const w = clamp01(tipZone * 1.1);
        cLit = blend(cLit, tip[clamp(t0 + 1, 0, nt)]!, w);
        cMid = blend(cMid, tip[t0]!, w);
        cDark = blend(cDark, tip[clamp(t0 - 1, 0, nt)]!, w);
        if (tipZone > 0.4) em = Math.round(120 * glow + 60);
      }
      ov.capsule(
        ax,
        ay,
        lerp(2.35, 0.75, u0) * thin,
        bx,
        by,
        lerp(2.35, 0.75, u1) * thin,
        cLit,
        cMid,
        cDark,
        em,
      );
    }
    // the very tip glints
    if (opacity >= 1 && cnt >= 3)
      ov.set(Math.round(xs[base + cnt - 1]!), Math.round(ys[base + cnt - 1]!), tip[nt]!, 255);
  }
}

/** Build the tendril palette from the titan's material ramps. */
export function makeTendrilPalette(shellRamp: string[], giltRamp: string[]): TendrilPalette {
  return { body: shellRamp.map(hex), tip: giltRamp.map(hex) };
}
