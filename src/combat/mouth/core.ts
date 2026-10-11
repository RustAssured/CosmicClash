import type { ArenaInfo } from '@/contracts';
import {
  MOUTH_BOSS,
  MOUTH_CONST as C,
  MOUTH_LIVE,
  MOUTH_MOVES,
  MOUTH_TUNE,
  type MouthBeat,
  type MouthMoveName,
} from './tuning';

/**
 * The Mouth's crane (Phase 3B): a deterministic port of the locked prototype's motion
 * (`mouth/src/30_mouth_core_motion_damage.js`: `edgeAt`, `intent`, `step`, the damage model), driven at the game's fixed 60 Hz.
 *
 * Differences from the prototype, each from Gate 3A (D37):
 * - the perimeter is the ARENA rectangle (arena B, §1), not the 640×360 canvas;
 * - the prototype's own hit-stop, demo opponent, random fight-back and auto-restore are gone (the match owns hit-stop and
 *   rounds); its `Math.random` draws come from the fighter's seeded RNG (`rand`);
 * - the head's intent is projected out of the coils' keep-out band (§4), and a side-wall strike keeps the far safe strip (§7);
 * - coil & crush grabs (§3): `grabCheck` at the end of the reach beat; a whiff goes straight to release; an escape ends the hold;
 *   the head circles the foe's core at its own radius (+ the strand) and the neck's last third wraps it;
 * - every hit chips the current jaw-ring (§5): the four rings are the health readout, 25 % each.
 *
 * Units: px, s. Angles: radians, +y down. All state is plain numbers (hashable).
 */

export interface MouthEdge {
  /** Point on the perimeter and the blended inward normal. */
  px: number;
  py: number;
  nx: number;
  ny: number;
}

export interface MouthIntent {
  E: MouthEdge;
  /** Neck exit point (edge + 48 px inward). */
  Xx: number;
  Xy: number;
  /** Head target. */
  Hx: number;
  Hy: number;
  bend: number;
  coilAmp: number;
  label: MouthBeat;
  spin: number;
  op: number;
  cl: number;
  stiff: number;
  gp: number;
  spr: number;
  rollT: number;
  jt: number;
  gr: number;
}

export interface MouthMove {
  n: MouthMoveName;
  ph: number;
  t0: number;
  /** Height: −1 high (stick up), 0 straight, +1 low (stick down). */
  v: number;
  fromX: number;
  fromY: number;
  /** Target locked at command time (no homing). */
  tgX: number;
  tgY: number;
  /** The tell's dashed path (load beat): back, mid, strike point. */
  path: [number, number, number, number, number, number] | null;
  /** Coil & crush: the circle the head runs round the foe (x, y, r, angle, side), null outside coil / crush. */
  wrap: [number, number, number, number, number] | null;
  /** Coil & crush: grab outcome at the end of reach (null = not decided yet). */
  grabbed: boolean | null;
  /** Neck damage taken on the wrap while holding (sever units). */
  wrapDmg: number;
  /** Radius of the foe's core the wrap goes round (px). */
  foeR: number;
}

export interface MouthWound {
  /** 'neck': strand k (0..7) at arc fraction u; 'coil': coil sub-strand k at perimeter offset u (px). */
  part: 'neck' | 'coil';
  k: number;
  u: number;
  len: number;
}

export interface MouthDamage {
  hp: number;
  hpMax: number;
  /** Snapped teeth / ring claws: 't<ring>_<j>' throat claws, 'r<ring>_<j>' jaw-ring claws (stumps stay). */
  broken: string[];
  /** Per jaw-ring: arcs missing [position 0..1, half width], and whether the ring has broken. */
  ringGaps: [number, number][][];
  /** Accumulated sever units per neck strand pair (the prototype's 6 counters) and the cut fraction (1 = whole). */
  sever: number[];
  severF: number[];
  ko: { t0: number; type: 'drag' | 'sever' } | null;
  /** Hits taken (diagnostics). */
  hits: number;
}

/** What the fighter learns from one step. */
export interface MouthStepOut {
  /** A bite / crush beat began this step (the oracle's impact): the strike connects now. */
  impact: 'bite' | 'crush' | null;
  /** The coil beat is running this step (light crush ticks). */
  coiling: boolean;
  /** A move ended this step. */
  ended: boolean;
}

const NS = C.neckSamples;
const TAU = Math.PI * 2;
const ease = {
  io: (u: number): number => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2),
  out4: (u: number): number => 1 - Math.pow(1 - u, 4),
  out2: (u: number): number => 1 - (1 - u) * (1 - u),
};
const STRETCHED: readonly MouthBeat[] = ['strike', 'bite', 'hold', 'recover', 'sweep', 'release'];

const makeEdge = (): MouthEdge => ({ px: 0, py: 0, nx: 1, ny: 0 });
const makeIntent = (): MouthIntent => ({
  E: makeEdge(),
  Xx: 0,
  Xy: 0,
  Hx: 0,
  Hy: 0,
  bend: 0,
  coilAmp: 0,
  label: 'watching',
  spin: 1,
  op: 1,
  cl: 0,
  stiff: 1,
  gp: 1,
  spr: 0,
  rollT: 0,
  jt: 0.12,
  gr: 0,
});

export interface MouthOptions {
  arena: ArenaInfo;
  /** The final-boss variant (D35): more health and an enraged last ring. */
  boss?: boolean;
  /** Seeded uniform [0, 1) (the fighter's RNG fork). */
  rand: () => number;
}

export class MouthCore {
  /* ---- arena (perimeter = the arena rectangle) ---- */
  ax0 = 0;
  ay0 = 0;
  aw = 640;
  ah = 360;
  per = 2000;
  readonly boss: boolean;
  rand: () => number;

  /* ---- state ---- */
  t = 0;
  s = 0;
  sv = 0;
  /** Inputs, set by the fighter before `step`. */
  slideIn = 0;
  variant = 0;
  oppX = 0;
  oppY = 0;
  /** Radius of the foe's core (for the wrap), set by the fighter. */
  oppR = 40;
  move: MouthMove | null = null;
  /** Neck samples: x, y, vx, vy per sample. */
  readonly neck = new Float64Array(NS * 4);
  neckInit = false;
  hdX = 0;
  hdY = 0;
  hdVx = 0;
  hdVy = 0;
  /** Head behaviour layer (gape, spread, roll springs, jitter, grind, pulse). */
  readonly HB = { gape: 1, gv: 0, spread: 0, sv: 0, roll: 0, rv: 0, jit: 0.3, grind: 0, pulse: 0 };
  ringSpin = 0;
  ringRate = 1;
  open = 1;
  clampV = 0;
  koDrag = 0;
  readonly loose = { x: 0, y: 0, vx: 0, vy: 0, roll: 0, vr: 0 };
  readonly dmg: MouthDamage;
  readonly wounds: MouthWound[] = [];
  /** This step's intent (the prototype's step.I), and the label of the step before (the speed cap reads it). */
  readonly I: MouthIntent = makeIntent();
  prevLabel: MouthBeat = 'watching';
  /** Coil & crush: the fighter decides whether the reach caught the foe (null = always a whiff). */
  grabCheck: ((x: number, y: number, r: number) => boolean) | null = null;
  /**
   * The match's pace over the Normal pace (S11, ROUND LENGTH): the health a blow takes scales with it, as the titans' matter
   * does, so the Mouth's rounds stretch with everyone else's. 1 at Normal (the tuned numbers); the fighter sets it.
   */
  paceMul = 1;
  /** The coil spine (9 perimeter control points with depth, world px) for hurtboxes and the keep-out band. */
  readonly coilSpine = new Float64Array(9 * 2);
  private readonly edgeTmp = makeEdge();
  private readonly edgeTmp2 = makeEdge();

  constructor(o: MouthOptions) {
    this.boss = !!o.boss;
    this.rand = o.rand;
    const hpMax = C.hp * (this.boss ? MOUTH_BOSS.hpMul : 1);
    this.dmg = {
      hp: hpMax,
      hpMax,
      broken: [],
      ringGaps: [[], [], [], []],
      sever: [0, 0, 0, 0, 0, 0],
      severF: [1, 1, 1, 1, 1, 1],
      ko: null,
      hits: 0,
    };
    this.setArena(o.arena);
    this.s = this.per - this.ah * 0.5;
  }

  setArena(a: ArenaInfo): void {
    this.ax0 = a.minX;
    this.ay0 = a.minY;
    this.aw = a.maxX - a.minX;
    this.ah = a.maxY - a.minY;
    this.per = 2 * (this.aw + this.ah);
  }

  /** Health 0..1 (the prototype's hq). */
  hq(): number {
    return this.dmg.hp / this.dmg.hpMax;
  }

  /** The boss's last ring: enraged. */
  enraged(): boolean {
    return this.boss && !this.dmg.ko && this.hq() < MOUTH_BOSS.enrageBelow;
  }

  /** Perimeter point and blended normal at arc length `s` (the prototype's edgeAt over the arena rectangle). */
  edgeAt(s: number, out: MouthEdge): MouthEdge {
    const W = this.aw;
    const H = this.ah;
    const PER = this.per;
    s = ((s % PER) + PER) % PER;
    // corners (clockwise on screen from the top-left), inward normals, edge lengths
    let e = 0;
    let a = 0;
    const L = (k: number): number => (k & 1 ? H : W);
    while (s > a + L(e)) {
      a += L(e);
      e = (e + 1) % 4;
    }
    const f = (s - a) / L(e);
    const PX = [0, W, W, 0];
    const PY = [0, 0, H, H];
    const NX = [0, -1, 0, 1];
    const NY = [1, 0, -1, 0];
    const e1 = (e + 1) % 4;
    out.px = this.ax0 + PX[e]! + (PX[e1]! - PX[e]!) * f;
    out.py = this.ay0 + PY[e]! + (PY[e1]! - PY[e]!) * f;
    let nx = NX[e]!;
    let ny = NY[e]!;
    const dA = f * L(e);
    const dB = (1 - f) * L(e);
    const RC = C.cornerBlend;
    if (dB < RC) {
      const k = 0.5 * (1 - dB / RC);
      nx = nx * (1 - k) + NX[e1]! * k;
      ny = ny * (1 - k) + NY[e1]! * k;
    }
    if (dA < RC) {
      const k = 0.5 * (1 - dA / RC);
      const e3 = (e + 3) % 4;
      nx = nx * (1 - k) + NX[e3]! * k;
      ny = ny * (1 - k) + NY[e3]! * k;
    }
    const l = Math.hypot(nx, ny);
    out.nx = nx / l;
    out.ny = ny / l;
    return out;
  }

  /** Arc length of the perimeter point nearest (x, y). */
  sAt(x: number, y: number): number {
    const W = this.aw;
    const H = this.ah;
    const lx = Math.max(0, Math.min(W, x - this.ax0));
    const ly = Math.max(0, Math.min(H, y - this.ay0));
    const d = [ly, W - lx, H - ly, lx];
    let e = 0;
    for (let k = 1; k < 4; k++) if (d[k]! < d[e]!) e = k;
    if (e === 0) return lx;
    if (e === 1) return W + ly;
    if (e === 2) return W + H + (W - lx);
    return 2 * W + H + (H - ly);
  }

  /** The auto-aim: direction from X toward P, clamped to ±arc around the edge normal. */
  private clampArc(E: MouthEdge, Xx: number, Xy: number, Px: number, Py: number, out: number[]): void {
    const dx = Px - Xx;
    const dy = Py - Xy;
    let a = Math.atan2(E.nx * dy - E.ny * dx, E.nx * dx + E.ny * dy);
    a = Math.max(-C.arc, Math.min(C.arc, a));
    const c = Math.cos(a);
    const si = Math.sin(a);
    out[0] = E.nx * c - E.ny * si;
    out[1] = E.nx * si + E.ny * c;
  }

  private readonly D = [0, 0];
  private readonly Dt = [0, 0];

  /** Strike / sweep durations: ÷ strike speed × height factor (and the boss's rage). */
  private beatDur(ph: string, du: number, v: number): number {
    const rage = this.enraged() ? MOUTH_BOSS.enrage : null;
    if (ph === 'strike' || ph === 'sweep')
      return du / (MOUTH_TUNE.strike * (rage ? rage.strike : 1) * (v === 1 ? 1.3 : v === -1 ? 0.85 : 1));
    if (rage && (ph === 'recover' || ph === 'release')) return du * rage.recover;
    return du;
  }

  /** Begin a strike (the prototype's `begin`): ignored while one runs. Returns whether it began. */
  begin(n: MouthMoveName): boolean {
    if (this.move || this.dmg.ko) return false;
    this.move = {
      n,
      ph: 0,
      t0: this.t,
      v: this.variant,
      fromX: this.hdX,
      fromY: this.hdY,
      tgX: this.oppX,
      tgY: this.oppY,
      path: null,
      wrap: null,
      grabbed: null,
      wrapDmg: 0,
      foeR: this.oppR,
    };
    return true;
  }

  /** Coil & crush ends early (an escape): straight into the release beat. */
  release(): void {
    const m = this.move;
    if (!m || m.n !== 'coil') return;
    const seq = MOUTH_MOVES.coil;
    const ri = seq.length - 1;
    if (m.ph >= ri) return;
    m.ph = ri;
    m.t0 = this.t;
    m.wrap = null;
  }

  /** Beat name and progress (0..1) of the running move. */
  beat(): { name: MouthBeat; u: number; index: number } {
    const m = this.move;
    if (!m) return { name: this.dmg.ko ? 'ko' : 'watching', u: 0, index: -1 };
    const seq = MOUTH_MOVES[m.n];
    const [ph, du0] = seq[m.ph]!;
    const du = this.beatDur(ph, du0, m.v);
    return { name: ph as MouthBeat, u: Math.min(1, (this.t - m.t0) / du), index: m.ph };
  }

  /** Total seconds of the running move's beats from its start (for the view's frame data). */
  moveSeconds(n: MouthMoveName, v: number): { startup: number; active: number; recovery: number } {
    const seq = MOUTH_MOVES[n];
    let startup = 0;
    let active = 0;
    let recovery = 0;
    seq.forEach(([ph, du], i) => {
      const d = this.beatDur(ph, du, v);
      if (i === 0) startup += d;
      else if (i === seq.length - 1) recovery += d;
      else active += d;
    });
    return { startup, active, recovery };
  }

  /** The strike point of the running move (locked target clamped by reach, the arc and the safe strip). */
  private strikeReach(
    E: MouthEdge,
    Xx: number,
    Xy: number,
    tgX: number,
    tgY: number,
    v: number,
    Dt: number[],
  ): number {
    const dT = Math.hypot(tgX - Xx, tgY - Xy);
    let reach = Math.max(
      80,
      Math.min(dT, C.maxReach * MOUTH_TUNE.reach * (v === -1 ? 1.12 : v === 1 ? 0.88 : 1)),
    );
    // Gate 3A §7 (D37): from a side wall the bite's centre stays out of the view's far safe strip
    const along = Dt[0]! * E.nx + Dt[1]! * E.ny;
    if (Math.abs(E.nx) > 0.7 && along > 0.05) {
      const cap = (640 - MOUTH_LIVE.safeStrip - C.exitInset) / along;
      if (reach > cap) reach = Math.max(80, cap);
    }
    return reach;
  }

  /** Where the head means to be and the neck's authored shape for this instant (the prototype's `intent`). */
  private intent(out: MouthStepOut): MouthIntent {
    const I = this.I;
    const E = this.edgeAt(this.s, I.E);
    const Xx = E.px + E.nx * C.exitInset;
    const Xy = E.py + E.ny * C.exitInset;
    I.Xx = Xx;
    I.Xy = Xy;
    const t = this.t;
    const D = this.D;
    this.clampArc(E, Xx, Xy, this.oppX, this.oppY, D);
    const dOpp = Math.hypot(this.oppX - Xx, this.oppY - Xy);
    const idleL = Math.min(C.idleReachMax, dOpp * C.idleReachK);
    let Hx = Xx + D[0]! * idleL + Math.sin(t * 0.8) * 8;
    let Hy = Xy + D[1]! * idleL + Math.cos(t * 0.7) * 8;
    let bend = Math.sin(t * 0.9) * 0.35 + 0.25;
    let coilAmp = 0;
    let label: MouthBeat = 'watching';
    let spin = 1;
    let op = 1;
    let cl = 0;
    let stiff = 1;
    const dmg = this.dmg;
    if (this.move && !dmg.ko) {
      const m = this.move;
      const seq = MOUTH_MOVES[m.n];
      let [ph, du0] = seq[m.ph]!;
      let du = this.beatDur(ph, du0, m.v);
      let u = (t - m.t0) / du;
      while (u >= 1) {
        m.ph++;
        m.t0 += du;
        if (m.ph >= seq.length) {
          this.move = null;
          out.ended = true;
          break;
        }
        [ph, du0] = seq[m.ph]!;
        // coil & crush (§3): the grab is decided as the reach beat ends; a whiff goes straight to release
        if (m.n === 'coil' && ph === 'coil') {
          const r = MOUTH_LIVE.grabR;
          m.grabbed = this.grabCheck ? this.grabCheck(m.tgX, m.tgY, r) : false;
          if (!m.grabbed) {
            m.ph = seq.length - 1;
            [ph, du0] = seq[m.ph]!;
          }
        }
        du = this.beatDur(ph, du0, m.v);
        u = (t - m.t0) / du;
        if (ph === 'bite' || ph === 'crush') out.impact = ph;
      }
      if (this.move) {
        const tgX = m.tgX;
        const tgY = m.tgY;
        const Dt = this.Dt;
        this.clampArc(E, Xx, Xy, tgX, tgY, Dt);
        const v = m.v;
        const reach = this.strikeReach(E, Xx, Xy, tgX, tgY, v, Dt);
        const spX = Xx + Dt[0]! * reach;
        const spY = Xy + Dt[1]! * reach;
        const ppx = -Dt[1]!;
        const ppy = Dt[0]!;
        label = ph as MouthBeat;
        if (m.n === 'bite') {
          // coil back into the body, low and to the side — the tell; then out along an arc: high goes over, low comes under
          const off = v * -60 + 40;
          const backX = Xx + Dt[0]! * 90 + ppx * off;
          const backY = Xy + Dt[1]! * 90 + ppy * off;
          const midX = (backX + spX) / 2 + ppx * v * -200;
          const midY = (backY + spY) / 2 + ppy * v * -200;
          if (ph === 'load') {
            const e = ease.io(u);
            m.path = [backX, backY, midX, midY, spX, spY];
            Hx = Hx + (backX - Hx) * e;
            Hy = Hy + (backY - Hy) * e;
            coilAmp = 26 * e;
            bend = 0.9 * e * (v || 1);
            spin = 1 + 3 * e;
            op = 1 + 0.4 * e;
            stiff = 1.4;
          }
          if (ph === 'strike') {
            const e = ease.out4(u);
            m.path = [backX, backY, midX, midY, spX, spY];
            const q = 1 - e;
            Hx = q * q * backX + 2 * q * e * midX + e * e * spX;
            Hy = q * q * backY + 2 * q * e * midY + e * e * spY;
            bend = -0.3 * v;
            spin = 4;
            op = 1.5;
            stiff = 2.2;
          }
          if (ph === 'bite' || ph === 'hold') {
            Hx = spX;
            Hy = spY;
            spin = 0.3;
            op = 0.5;
            cl = 1;
            stiff = 2.2;
            bend = 0;
          }
          if (ph === 'recover') {
            const e = ease.io(u);
            Hx = spX + (Hx - spX) * e;
            Hy = spY + (Hy - spY) * e;
            spin = 1;
            op = 0.8;
            stiff = 0.8;
          }
        }
        if (m.n === 'sweep') {
          const side = v === 0 ? 1 : v;
          const R_ = Math.min(reach, 420);
          const base = Math.atan2(Dt[1]!, Dt[0]!);
          const a0 = base - 1.1 * side;
          const a1 = base + 1.1 * side;
          if (ph === 'load') {
            const e = ease.io(u);
            const P0x = Xx + Math.cos(a0) * 150;
            const P0y = Xy + Math.sin(a0) * 150;
            Hx = Hx + (P0x - Hx) * e;
            Hy = Hy + (P0y - Hy) * e;
            coilAmp = 18 * e;
            bend = 0.8 * side * e;
            spin = 1 + 3 * e;
            op = 1.3;
            stiff = 1.3;
          }
          if (ph === 'sweep') {
            const e = ease.io(u);
            const a = a0 + (a1 - a0) * e;
            const r = 150 + (R_ - 150) * Math.sin(Math.min(1, e * 1.3) * Math.PI * 0.5);
            Hx = Xx + Math.cos(a) * r;
            Hy = Xy + Math.sin(a) * r;
            spin = 4;
            op = 1.5;
            stiff = 2;
            bend = -0.5 * side;
          }
          if (ph === 'bite') {
            Hx = Xx + Math.cos(a1) * R_;
            Hy = Xy + Math.sin(a1) * R_;
            cl = 1;
            op = 0.5;
            spin = 0.3;
            stiff = 2;
          }
          if (ph === 'recover') {
            const e = ease.io(u);
            const P1x = Xx + Math.cos(a1) * R_;
            const P1y = Xy + Math.sin(a1) * R_;
            Hx = P1x + (Hx - P1x) * e;
            Hy = P1y + (Hy - P1y) * e;
            stiff = 0.8;
          }
        }
        if (m.n === 'coil') {
          const side = v === 0 ? 1 : v;
          if (ph === 'reach') {
            const e = ease.out2(u);
            const pastX = tgX + Dt[0]! * 70 + ppx * side * 50;
            const pastY = tgY + Dt[1]! * 70 + ppy * side * 50;
            Hx = m.fromX + (pastX - m.fromX) * e;
            Hy = m.fromY + (pastY - m.fromY) * e;
            stiff = 1.8;
            spin = 2;
            bend = 0.6 * side;
          }
          if (ph === 'coil' || ph === 'crush') {
            // the head circles the foe: 75 → 40 px in the prototype; round a big titan's core it runs at the core's radius + the strand
            const wr = Math.max(40, m.foeR + MOUTH_LIVE.wrapPad);
            const r = ph === 'coil' ? wr + 35 * (1 - u) : wr;
            const ang =
              Math.atan2(Dt[1]!, Dt[0]!) + side * (Math.PI * 0.4 + (ph === 'coil' ? u : 1) * Math.PI * 1.7);
            Hx = tgX + Math.cos(ang) * r;
            Hy = tgY + Math.sin(ang) * r;
            stiff = 1.6;
            spin = ph === 'crush' ? 0.3 : 2;
            cl = ph === 'crush' ? 1 : 0;
            op = ph === 'crush' ? 0.5 : 1.1;
            if (!m.wrap) m.wrap = [0, 0, 0, 0, 0];
            m.wrap[0] = tgX;
            m.wrap[1] = tgY;
            m.wrap[2] = r;
            m.wrap[3] = ang;
            m.wrap[4] = side;
            if (ph === 'coil') out.coiling = true;
          }
          if (ph === 'release') {
            const e = ease.io(u);
            Hx = this.hdX + (Hx - this.hdX) * e * 0.2;
            Hy = this.hdY + (Hy - this.hdY) * e * 0.2;
            stiff = 0.7;
            m.wrap = null;
          }
        }
      }
    }
    // the end: convulse, go slack, and be dragged back over the edge — or, severed, let the head drift away
    if (dmg.ko) {
      const k = t - dmg.ko.t0;
      this.move = null;
      spin = k < 0.9 ? 6 : Math.max(0, 1 - k);
      if (dmg.ko.type === 'drag') {
        if (k < C.koConvulse) {
          Hx = this.hdX + Math.sin(k * 40) * 6;
          Hy = this.hdY + Math.cos(k * 33) * 6;
          stiff = 2;
        } else if (k < C.koSlack) {
          Hx = Xx + E.nx * 120;
          Hy = Xy + E.ny * 120 + 60;
          stiff = 0.35;
        } else {
          const f = Math.min(1, (k - C.koSlack) / (C.koDragEnd - C.koSlack));
          Hx = Xx - E.nx * 260 * f;
          Hy = Xy - E.ny * 260 * f + 40 * (1 - f);
          stiff = 0.6;
          this.koDrag = f;
        }
      } else {
        const f = Math.min(1, k / 1.6);
        Hx = Xx + E.nx * (140 - 120 * f);
        Hy = Xy + E.ny * (140 - 120 * f);
        stiff = 1.2;
        this.koDrag = Math.max(0, (k - 2.5) / 3);
      }
      I.Hx = Hx;
      I.Hy = Hy;
      I.bend = 0.2;
      I.coilAmp = k < 0.9 ? 30 : 0;
      I.label = 'ko';
      I.spin = spin;
      I.op = k < 0.9 ? 1.6 : 1.3;
      I.cl = 0;
      I.stiff = stiff;
      I.gp = k < 0.9 ? 1.2 + Math.sin(k * 30) * 0.5 : 1.5;
      I.spr = k < 0.9 ? 0.8 : -1;
      I.rollT = k < 0.9 ? Math.sin(k * 20) * 2 : 0;
      I.jt = k < 0.9 ? 3 : 0;
      I.gr = 0;
      return I;
    }
    // the head stays in the arena
    const hi = C.headInset;
    Hx = Math.max(this.ax0 + hi, Math.min(this.ax0 + this.aw - hi, Hx));
    Hy = Math.max(this.ay0 + hi, Math.min(this.ay0 + this.ah - hi, Hy));
    // Gate 3A §4 (D37): the head never crowds its own coils — projected out of the keep-out band round the coil spine
    if (label !== 'coil' && label !== 'crush') {
      const p = this.keepOut(Hx, Hy);
      Hx = Math.max(this.ax0 + hi, Math.min(this.ax0 + this.aw - hi, p[0]!));
      Hy = Math.max(this.ay0 + hi, Math.min(this.ay0 + this.ah - hi, p[1]!));
    }
    // how the head behaves in each beat: breathing and twitching at rest, an iris of rings opening in the wind-up, snapping
    // shut and grinding in the bite
    let gp = 1 + 0.14 * Math.sin(t * 0.9) * Math.sin(t * 0.31 + 1) + (Math.sin(t * 4.1) > 0.985 ? 0.12 : 0);
    let spr = 0.08 * Math.sin(t * 0.5);
    let rollT = Math.sin(t * 0.32) * 0.25;
    let jt = 0.12;
    let gr = 0;
    if (label === 'load' || label === 'reach') {
      gp = 1.5;
      spr = 1.05;
      rollT = 1.1;
      jt = 0.6;
    }
    if (label === 'strike' || label === 'sweep') {
      gp = 1.55;
      spr = -0.3;
      rollT = 2.0;
      jt = 0.3;
    }
    if (label === 'bite' || label === 'hold' || label === 'crush') {
      gp = 0.42;
      spr = -0.4;
      rollT = 2.4;
      jt = 1.0;
      gr = 1;
    }
    if (label === 'coil') {
      gp = 1.25;
      spr = 0.35;
      rollT = 1.8;
      jt = 0.5;
    }
    if (label === 'recover' || label === 'release') {
      gp = 0.95;
      spr = 0.15;
      rollT = 0.6;
      jt = 0.35;
    }
    I.Hx = Hx;
    I.Hy = Hy;
    I.bend = bend;
    I.coilAmp = coilAmp;
    I.label = label;
    I.spin = spin;
    I.op = op;
    I.cl = cl;
    I.stiff = stiff;
    I.gp = gp;
    I.spr = spr;
    I.rollT = rollT;
    I.jt = jt;
    I.gr = gr;
    return I;
  }

  private readonly koTmp = [0, 0];
  /** Push (x, y) out of the band of `keepOut` px round the coil spine, along the spine's inward normal (2 passes). */
  keepOut(x: number, y: number): number[] {
    const o = this.koTmp;
    const band = MOUTH_LIVE.keepOut;
    const sp = this.coilSpine;
    for (let pass = 0; pass < 2; pass++) {
      let best = 1e9;
      let bx = 0;
      let by = 0;
      for (let i = 0; i < 8; i++) {
        const x0 = sp[i * 2]!;
        const y0 = sp[i * 2 + 1]!;
        const x1 = sp[i * 2 + 2]!;
        const y1 = sp[i * 2 + 3]!;
        const dx = x1 - x0;
        const dy = y1 - y0;
        const l2 = dx * dx + dy * dy || 1;
        const u = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2));
        const qx = x0 + dx * u;
        const qy = y0 + dy * u;
        const d = Math.hypot(x - qx, y - qy);
        if (d < best) {
          best = d;
          bx = qx;
          by = qy;
        }
      }
      if (best >= band) break;
      // out along the blended inward normal at the nearest perimeter point (a corner pushes along its blend)
      const E = this.edgeAt(this.sAt(bx, by), this.edgeTmp2);
      const ex = x - bx;
      const ey = y - by;
      const along = ex * E.nx + ey * E.ny;
      const need = band - Math.max(-band, along);
      x += E.nx * need;
      y += E.ny * need;
    }
    o[0] = x;
    o[1] = y;
    return o;
  }

  /** The coil spine for this tick (the prototype's coil control points P: offsets −330…+340 px round the anchor, depths). */
  private refreshCoilSpine(): void {
    const OFFS = [-330, -240, -150, -70, 0, 80, 160, 250, 340];
    const t = this.t;
    const pay = this.pay();
    const depth = [-130, -40, -100, 0, -50 + pay * 20, 8, -95, -30, -130];
    const sp = this.coilSpine;
    for (let i = 0; i < 9; i++) {
      const e = this.edgeAt(this.s + OFFS[i]! * (1 - pay * 0.18), this.edgeTmp);
      const dd = (depth[i]! - this.koDrag * 150) * (1 - pay * 0.35) + Math.sin(t * 0.32 + i * 1.3) * 12;
      sp[i * 2] = e.px + e.nx * dd;
      sp[i * 2 + 1] = e.py + e.ny * dd;
    }
  }

  /** How far the neck has paid out (0..1): the coils tighten as it does (the prototype's `pay`). */
  pay(): number {
    const I = this.I;
    return Math.min(1, Math.max(0, (Math.hypot(this.hdX - I.Xx, this.hdY - I.Xy) - 200) / 300));
  }

  /** Place the crane at rest at arc length `s` (round start): head at its idle intent, neck laid along it. */
  place(s: number): void {
    this.s = ((s % this.per) + this.per) % this.per;
    this.sv = 0;
    this.move = null;
    const out: MouthStepOut = { impact: null, coiling: false, ended: false };
    this.refreshCoilSpine();
    const I = this.intent(out);
    this.hdX = I.Hx;
    this.hdY = I.Hy;
    this.hdVx = 0;
    this.hdVy = 0;
    this.neckInit = false;
    this.koDrag = 0;
  }

  /** One fixed step (the prototype's `step(dt)`, minus its demo opponent and its own hit-stop). */
  step(dt: number, out: MouthStepOut): void {
    out.impact = null;
    out.coiling = false;
    out.ended = false;
    this.t += dt;
    const hq = this.hq();
    const rage = this.enraged() ? MOUTH_BOSS.enrage : null;
    // sliding: heavy — it takes a moment to get going and a moment to stop; corners are slower
    const E0 = this.edgeAt(this.s, this.edgeTmp);
    const corner = Math.abs(Math.abs(E0.nx) - Math.abs(E0.ny)) < 0.9 ? C.cornerSlide : 1;
    const want =
      this.slideIn *
      MOUTH_TUNE.slide *
      (rage ? rage.slide : 1) *
      (0.55 + 0.45 * hq) *
      corner *
      (this.move || this.dmg.ko ? C.strikeSlide : 1);
    this.sv += (want - this.sv) * Math.min(1, dt * C.slideEase);
    this.s = (((this.s + this.sv * dt) % this.per) + this.per) % this.per;
    this.refreshCoilSpine();
    const I = this.intent(out);
    // the head follows its intent with weight: fast when striking, slow and heavy otherwise
    const track = MOUTH_TUNE.track * (rage ? rage.track : 1);
    const k =
      (this.move || this.dmg.ko ? 28 * I.stiff : 7 * track * (0.5 + 0.5 * hq)) /
      (MOUTH_TUNE.lag * (1 + 0.8 * (1 - hq)));
    const c = 2 * 0.9 * Math.sqrt(k);
    this.hdVx += (k * (I.Hx - this.hdX) - c * this.hdVx) * dt;
    this.hdVy += (k * (I.Hy - this.hdY) - c * this.hdVy) * dt;
    {
      const vm = Math.hypot(this.hdVx, this.hdVy);
      const cap =
        this.move && (this.prevLabel === 'strike' || this.prevLabel === 'sweep') ? C.capStrike : C.capRest;
      if (vm > cap) {
        this.hdVx *= cap / vm;
        this.hdVy *= cap / vm;
      }
    }
    this.hdX += this.hdVx * dt;
    this.hdY += this.hdVy * dt;
    // the gape snaps (an underdamped spring); the iris and the roll are heavy; the pulse quickens with tension
    const HB = this.HB;
    HB.gv += (210 * (I.gp - HB.gape) - 2 * 0.46 * Math.sqrt(210) * HB.gv) * dt;
    HB.gape += HB.gv * dt;
    HB.sv += (90 * (I.spr - HB.spread) - 2 * 0.55 * Math.sqrt(90) * HB.sv) * dt;
    HB.spread += HB.sv * dt;
    HB.rv += (22 * (I.rollT - HB.roll) - 2 * 0.8 * Math.sqrt(22) * HB.rv) * dt;
    HB.roll += HB.rv * dt;
    HB.jit += (I.jt + (1 - hq) * 1.2 - HB.jit) * Math.min(1, dt * 6);
    HB.grind += (I.gr - HB.grind) * Math.min(1, dt * (I.gr > HB.grind ? 20 : 3));
    HB.pulse = 0.018 * Math.sin(this.t * (2.2 + HB.jit * 3)) * (0.6 + HB.jit * 0.4);
    this.ringSpin += dt * this.ringRate;
    this.ringRate += (I.spin - this.ringRate) * Math.min(1, dt * 6);
    this.open += (I.op - this.open) * Math.min(1, dt * 10);
    this.clampV += (I.cl - this.clampV) * Math.min(1, dt * (I.cl > this.clampV ? 18 : 5));
    this.stepNeck(dt, I);
    if (this.dmg.ko && this.dmg.ko.type === 'sever') {
      const L = this.loose;
      L.x += L.vx * dt;
      L.y += L.vy * dt;
      L.vy += 6 * dt;
      L.roll += L.vr * dt;
    }
    this.prevLabel = I.label;
  }

  /** The neck: an authored cubic from the exit to the head, wind-up waves, the wrap, and heavy lag per sample. */
  private stepNeck(dt: number, I: MouthIntent): void {
    const E = I.E;
    const Xx = I.Xx;
    const Xy = I.Xy;
    const hx = this.hdX;
    const hy = this.hdY;
    const L = Math.hypot(hx - Xx, hy - Xy) || 1;
    const dx = (hx - Xx) / L;
    const dy = (hy - Xy) / L;
    const px = -dy;
    const py = dx;
    const c1x = Xx + E.nx * L * 0.42 + px * I.bend * L * 0.35;
    const c1y = Xy + E.ny * L * 0.42 + py * I.bend * L * 0.35;
    const c2x = hx - dx * L * 0.35 - px * I.bend * L * 0.2;
    const c2y = hy - dy * L * 0.35 - py * I.bend * L * 0.2;
    const t = this.t;
    const nk = this.neck;
    const wrap = this.move?.wrap ?? null;
    const moving = this.move !== null;
    for (let i = 0; i < NS; i++) {
      const f = i / (NS - 1);
      const q = 1 - f;
      let tx = q * q * q * Xx + 3 * q * q * f * c1x + 3 * q * f * f * c2x + f * f * f * hx;
      let ty = q * q * q * Xy + 3 * q * q * f * c1y + 3 * q * f * f * c2y + f * f * f * hy;
      // bunching in the wind-up: the neck folds into tight waves
      const wv =
        Math.sin(f * Math.PI * 3 - t * 2) * I.coilAmp * Math.sin(f * Math.PI) +
        Math.sin(f * 7 - t * 1.7) * 5 * Math.sin(f * Math.PI);
      tx += px * wv;
      ty += py * wv;
      // wrapping: the last third of the neck follows the circle round the opponent (Gate 3A §3: a 1.7 π sweep)
      if (wrap && f > 0.55) {
        const [wx, wy, r, ang, side] = wrap;
        const a = ang - side * (1 - (f - 0.55) / 0.45) * Math.PI * 1.7;
        const k2 = Math.min(1, (f - 0.55) / 0.2);
        tx = tx + (wx + Math.cos(a) * r - tx) * k2;
        ty = ty + (wy + Math.sin(a) * r - ty) * k2;
      }
      const o = i * 4;
      if (!this.neckInit) {
        nk[o] = tx;
        nk[o + 1] = ty;
        nk[o + 2] = 0;
        nk[o + 3] = 0;
      }
      const ks =
        (i < 2 ? 400 : 150 * (1 - 0.72 * Math.sin(f * Math.PI)) * (moving ? 1.5 : 1)) / MOUTH_TUNE.lag;
      const cs = 2 * 0.95 * Math.sqrt(ks);
      nk[o + 2] = nk[o + 2]! + (ks * (tx - nk[o]!) - cs * nk[o + 2]!) * dt;
      nk[o + 3] = nk[o + 3]! + (ks * (ty - nk[o + 1]!) - cs * nk[o + 3]!) * dt;
      nk[o] = nk[o]! + nk[o + 2]! * dt;
      nk[o + 1] = nk[o + 1]! + nk[o + 3]! * dt;
    }
    this.neckInit = true;
    const last = (NS - 1) * 4;
    nk[last] = hx;
    nk[last + 1] = hy;
    nk[0] = Xx;
    nk[1] = Xy;
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  damage (the prototype's hitAt, with the part already resolved by the hurt capsules)
   * ------------------------------------------------------------------------------------------------ */

  /** Is the neck stretched now (the punish window: strike / bite / hold / recover / sweep / release)? */
  stretched(): boolean {
    return STRETCHED.includes(this.I.label);
  }

  /**
   * A blow of `power` lands on `part` at (x, y). `neckF` is the arc fraction along the neck (neck hits), `coilU` the perimeter
   * offset from the anchor (coil hits). Returns the health lost. Every hit chips the current jaw-ring (Gate 3A §5).
   */
  hit(part: 'head' | 'neck' | 'coil', power: number, neckF: number, coilU: number): number {
    const D = this.dmg;
    if (D.ko) return 0;
    const R = this.rand;
    const stretched = this.stretched();
    let dmg = 0;
    if (part === 'head') {
      // snap a few teeth (they stay broken as stumps)
      for (let k = 0; k < 3 + power * 2; k++) {
        const r = R();
        const key =
          r < 0.5
            ? `t${Math.floor(R() * 5)}_${Math.floor(R() * 11)}`
            : `r${Math.floor(R() * 4)}_${6 * Math.floor(R() * 40)}`;
        if (!D.broken.includes(key)) D.broken.push(key);
      }
      dmg = 4 * power;
    } else if (part === 'neck') {
      const k = Math.floor(R() * 6);
      const units = power * (stretched ? 1.6 : 1);
      D.sever[k] = D.sever[k]! + units;
      this.addWound({ part: 'neck', k, u: neckF, len: (7 + power * 3) / 250 });
      if (D.sever[k]! >= C.severAt && D.severF[k]! >= 1) D.severF[k] = Math.max(0.15, neckF);
      if (this.move?.wrap && neckF > 0.55) this.move.wrapDmg += units;
      dmg = 5 * power * (stretched ? 1.6 : 1);
    } else {
      this.addWound({ part: 'coil', k: Math.floor(R() * 16), u: coilU, len: 9 + power * 4 });
      dmg = 2 * power;
    }
    dmg *= MOUTH_LIVE.damageMul * this.paceMul;
    // the HUD reads health as four jaw-rings of 25 % each: the ring of the current quarter takes the chip
    const before = D.hp;
    D.hp = Math.max(0, D.hp - dmg);
    this.chipRing(before, D.hp, power);
    D.hits++;
    if (D.hp <= 0) this.knockout();
    return before - D.hp;
  }

  private addWound(w: MouthWound): void {
    this.wounds.push(w);
    if (this.wounds.length > 60) this.wounds.shift();
  }

  /** Index of the jaw-ring carrying health fraction `h` (0..1): ring 0 is the first quarter to go. */
  static ringOf(h: number): number {
    return Math.min(3, Math.max(0, Math.floor((1 - h) * 4 - 1e-9)));
  }

  /** Health left in jaw-ring g (0..1) at the current health. */
  ringHealth(g: number): number {
    const h = this.hq();
    return Math.max(0, Math.min(1, h * 4 - (3 - g)));
  }

  private chipRing(before: number, after: number, power: number): void {
    const D = this.dmg;
    const g = MouthCore.ringOf(before / D.hpMax);
    const gaps = D.ringGaps[g]!;
    gaps.push([this.rand(), 0.03 + 0.03 * Math.min(2, power)]);
    if (gaps.length > 24) gaps.shift();
    void after;
  }

  /** The end: dragged back over the edge, or — three or more strands cut — the head comes loose. */
  knockout(): void {
    const D = this.dmg;
    if (D.ko) return;
    const severed = D.severF.filter((f) => f < 1).length;
    D.ko = { t0: this.t, type: severed >= C.severKo ? 'sever' : 'drag' };
    this.move = null;
    if (D.ko.type === 'sever') {
      const L = this.loose;
      L.x = this.hdX;
      L.y = this.hdY;
      L.vx = this.hdVx * 0.3 + (this.rand() - 0.5) * 40;
      L.vy = this.hdVy * 0.3 + 20;
      L.roll = 0;
      L.vr = (this.rand() - 0.5) * 2;
    }
  }

  /** Between rounds: heal `fraction` of the missing health; cuts and broken teeth stay as scars, rings regrow with health. */
  heal(fraction: number): void {
    const D = this.dmg;
    D.hp = Math.min(D.hpMax, D.hp + (D.hpMax - D.hp) * fraction);
    D.ko = null;
    for (let k = 0; k < 6; k++) {
      D.sever[k] = D.sever[k]! * (1 - fraction);
      if (D.sever[k]! < C.severAt) D.severF[k] = 1;
    }
    // a ring whose quarter is whole again closes its chips
    for (let g = 0; g < 4; g++) if (this.ringHealth(g) >= 1) D.ringGaps[g]!.length = 0;
    this.wounds.splice(0, Math.floor(this.wounds.length * fraction));
    this.koDrag = 0;
  }

  /** Hand the head a shove (a blow's knockback): the spring absorbs it. */
  kick(vx: number, vy: number): void {
    this.hdVx += vx;
    this.hdVy += vy;
  }

  /** Stable hash of the sim state (determinism tests). */
  hash(h: number): number {
    const mix = (x: number): void => {
      h = Math.imul(h ^ (Math.round(x * 64) | 0), 0x9e3779b1) >>> 0;
    };
    mix(this.t);
    mix(this.s);
    mix(this.sv);
    mix(this.hdX);
    mix(this.hdY);
    mix(this.hdVx);
    mix(this.hdVy);
    mix(this.dmg.hp);
    mix(this.move ? this.move.ph + 1 : 0);
    for (let i = 0; i < NS * 4; i += 4) {
      mix(this.neck[i]!);
      mix(this.neck[i + 1]!);
    }
    mix(this.HB.gape);
    mix(this.ringSpin);
    return h;
  }
}

/** Helpers for presentation and tests. */
export const MOUTH_TAU = TAU;
