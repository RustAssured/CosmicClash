import {
  about,
  apply,
  bodyTransforms,
  compose,
  uriPart,
  type UriPose,
  type UriSide,
  type Xf,
} from '@/titans/uri/rig';
import { DMath } from '@/contracts/dmath';

/**
 * 우리's kinetic system (Phase 2B; URI_SPEC §6, TUNING.md): a port of the locked oracle's `uri/src/20_kinetics.js`.
 *
 * "Authored motion defines the gesture; physics defines the consequence." Every degree of freedom is a link with mass,
 * stiffness, damping, an acceleration limit and joint limits, integrated semi-implicitly at 120 Hz (two substeps per 60 Hz
 * tick). A move is intent: phases with body goals, authored arm angles, fist compression and regional stiffness; the striking
 * arm is corrected toward the target by 14–28 % only. Impacts happen when the striking arms ARRIVE (joint error < 22) or
 * after a timeout (3.2× the phase); the arms keep 12 % of their speed, the energy goes into the loop, the cores, the pylons.
 * The arms' momentum reacts back into the body, mostly inside it. The loop deforms with load (data for drawing), the cores
 * jolt in their cradles, the command moon is tethered by gravity, the fists compress.
 *
 * Every number is the oracle's (TUNING.md); the seven §9 knobs are `tune`. All coordinates are the reference space
 * (403×368, origin (200, 170)); the target is the opponent in that space. Deterministic: the one random draw of the oracle
 * (the slam's sideways core jolt) comes from a seeded generator. No allocation per substep beyond small literals.
 */

const D = Math.PI / 180;
const wrap = (a: number): number => DMath.atan2(DMath.sin(a), DMath.cos(a));

/** The §9 sliders (all 1.00 in the locked demo). */
export interface UriTune {
  stiff: number;
  damp: number;
  mass: number;
  react: number;
  thrust: number;
  loop: number;
  hitstop: number;
}

export type LinkKey =
  | 'hx'
  | 'hy'
  | 'ha'
  | 'ta'
  | 'daL'
  | 'daR'
  | 'dxL'
  | 'dxR'
  | 'sL'
  | 'sR'
  | 'eL'
  | 'eR'
  | 'wL'
  | 'wR'
  | 'cL'
  | 'cR';

/** TUNING.md "Links": masses. */
export const LINK_MASS: Readonly<Record<LinkKey, number>> = {
  hx: 4.6,
  hy: 4.6,
  ha: 4.6,
  ta: 4.0,
  daL: 3.4,
  daR: 3.4,
  dxL: 3.4,
  dxR: 3.4,
  sL: 2.3,
  sR: 2.3,
  eL: 1.5,
  eR: 1.5,
  wL: 2.8,
  wR: 2.8,
  cL: 1.0,
  cR: 1.0,
};
const LINK_KEYS = Object.keys(LINK_MASS) as LinkKey[];

/** TUNING.md "Links": limits. */
export const LINK_LIMIT: Readonly<Record<LinkKey, readonly [number, number]>> = {
  hx: [-40, 40],
  hy: [-40, 40],
  ha: [-8 * D, 8 * D],
  ta: [-18 * D, 18 * D],
  daL: [-30 * D, 30 * D],
  daR: [-30 * D, 30 * D],
  dxL: [-22, 22],
  dxR: [-22, 22],
  sL: [-340 * D, 340 * D],
  sR: [-340 * D, 340 * D],
  eL: [-160 * D, 160 * D],
  eR: [-160 * D, 160 * D],
  wL: [-60 * D, 60 * D],
  wR: [-60 * D, 60 * D],
  cL: [0.8, 1.3],
  cR: [0.8, 1.3],
};

/** TUNING.md "Damping ratio ζ per region". */
export const LINK_ZETA: Readonly<Record<LinkKey, number>> = {
  hx: 0.98,
  hy: 0.98,
  ha: 0.98,
  ta: 0.96,
  daL: 0.74,
  daR: 0.74,
  dxL: 0.78,
  dxR: 0.78,
  sL: 0.8,
  sR: 0.8,
  eL: 0.78,
  eR: 0.78,
  wL: 0.7,
  wR: 0.7,
  cL: 0.52,
  cR: 0.52,
};

export const URI_KINETICS = {
  /** Link stiffness base: k = 58 · km · damageK. */
  stiffness: 58,
  /** Integration rate (Hz) and substeps per 60 Hz tick. */
  hz: 120,
  substeps: 2,
  /** A striking phase ends on arrival (joint-space error below this) or after this many times its duration. */
  arrive: 22,
  timeout: 3.2,
  /** Rest fist spread. */
  spreadRest: 1.14,
  /** Hitstop per move (s). */
  hitstop: { punch: 0.12, cross: 0.14, slam: 0.24, upper: 0.12 },
  /** Shake per move (the oracle's screen shake amplitude). */
  shake: { punch: 5, cross: 5, slam: 10, upper: 5 },
  /** Command moon: pull, damping ratio, max trail (px), facing (× torso angle), facing damping ratio. */
  moon: { pull: 34, zeta: 0.82, trail: 12, facing: 0.8, facingK: 30, facingZeta: 0.9 },
  /** Cores: spring k and damping c in their cradles. */
  core: { k: 90, c: 4 },
} as const;

export type UriMoveName = 'punch' | 'cross' | 'slam' | 'upper';

interface PhaseDef {
  n: string;
  d: number;
  hit?: boolean;
}

/** TUNING.md "Phases". */
export const URI_MOVES: Readonly<Record<UriMoveName, readonly PhaseDef[]>> = {
  punch: [
    { n: 'load', d: 0.3 },
    { n: 'drive', d: 0.2, hit: true },
    { n: 'follow', d: 0.18 },
    { n: 'taper', d: 1.5 },
  ],
  cross: [
    { n: 'coil', d: 0.38 },
    { n: 'release', d: 0.26, hit: true },
    { n: 'follow', d: 0.22 },
    { n: 'taper', d: 1.7 },
  ],
  slam: [
    { n: 'load', d: 0.2 },
    { n: 'rise', d: 0.5 },
    { n: 'apex', d: 0.26 },
    { n: 'fall', d: 0.2, hit: true },
    { n: 'follow', d: 0.28 },
    { n: 'taper', d: 2.3 },
  ],
  upper: [
    { n: 'compress', d: 0.3 },
    { n: 'launch', d: 0.22, hit: true },
    { n: 'follow', d: 0.22 },
    { n: 'taper', d: 1.5 },
  ],
};

type Triple = readonly [number, number, number];
/** TUNING.md "Authored arm angles" (degrees, shoulder/elbow/wrist), written for the RIGHT arm leading; ×−1 when the left leads. */
export const URI_AUTHORED: Readonly<
  Record<UriMoveName, Readonly<Record<string, { lead: Triple; rear: Triple }>>>
> = {
  punch: {
    load: { lead: [22, 30, 8], rear: [-8, -6, 0] },
    drive: { lead: [-50, -60, -10], rear: [10, 8, 0] },
    follow: { lead: [-55, -63, -12], rear: [10, 8, 0] },
  },
  cross: {
    coil: { lead: [-6, -4, 0], rear: [42, 34, 0] },
    release: { lead: [8, 6, 0], rear: [-100, 36, -10] },
    follow: { lead: [10, 6, 0], rear: [-106, 40, -12] },
  },
  slam: {
    load: { lead: [-8, -6, 0], rear: [8, 6, 0] },
    rise: { lead: [-112, -102, -18], rear: [112, 102, 18] },
    apex: { lead: [-122, -112, -20], rear: [122, 112, 20] },
    fall: { lead: [30, 18, 0], rear: [-30, -18, 0] },
    follow: { lead: [33, 20, 0], rear: [-33, -20, 0] },
  },
  upper: {
    compress: { lead: [26, 44, 10], rear: [0, 0, 0] },
    launch: { lead: [-150, -20, -10], rear: [10, 6, 0] },
    follow: { lead: [-155, -24, -12], rear: [10, 6, 0] },
  },
};

/** Where the oracle measures the target vector from: its screen (320, 174) = reference (200, 158). */
export const URI_CM0: readonly [number, number] = [200, 158];

interface Link {
  x: number;
  v: number;
  tgt: number;
  km: number;
  zeta: number;
  ext: number;
  m: number;
}

interface Spring {
  x: number;
  v: number;
}

interface Goals {
  hx: number;
  hy: number;
  ha: number;
  ta: number;
  daL: number;
  daR: number;
  dxL: number;
  dxR: number;
  cL: number;
  cR: number;
  wristL: [number, number] | null;
  wristR: [number, number] | null;
  authL: Triple | null;
  authR: Triple | null;
  ikw: number;
  km: Partial<Record<LinkKey, number>>;
  phase: string | null;
}

interface CurMove {
  name: UriMoveName;
  t0: number;
  dir: 1 | -1;
  lead: UriSide;
  rear: UriSide;
  ph: number;
  phT: number;
  hitDone: boolean;
  impact: boolean;
  arrive: number;
}

/** What drawing and diagnostics read (data for S5's loop, cores, pylons, moon, fists). */
export interface UriKineticView {
  /** Current move, phase and its age (s); null at rest. */
  move: UriMoveName | null;
  phase: string | null;
  lead: UriSide | null;
  rear: UriSide | null;
  /** Loop deformation: lobe stretch L/R (1 = rest), crossing shear (px), vertical breathing (1 = rest), brightness (1 = rest). */
  loop: { l: number; r: number; sh: number; vt: number; br: number };
  /** 0..1 loop stress. */
  stress: number;
  /** Arm angular momentum this substep (the oracle's TORQ). */
  torque: number;
  /** Core jolt in their cradles (px; the cold core moves −0.7 / −0.6 of it). */
  core: { x: number; y: number };
  /** Pylon thrust (0..) and vectoring angle (rad), per side. */
  pylon: { L: { th: number; ang: number }; R: { th: number; ang: number } };
  /** The command moon's place (reference coordinates) and facing angle; null until it has a place. */
  moon: { x: number; y: number; a: number } | null;
  /** Fist spread per side (1.14 rest, ≤ 0.74 at impact). */
  spread: { L: number; R: number };
  /** The living idle (idle handover, specs/uri.md): on, the Refusal's age (s, −1 none), its coming-apart and flash (0..1). */
  idle?: { on: boolean; refT: number; loose: number; flash: number };
}

/**
 * THE LIVING IDLE, "The Refusal: still here" (idle handover specs/uri.md; WJ 2026-10-20: the prototype's timing, a Refusal
 * on its own every 13–17 s at rest, the first 8 s into a round, its slam as loud as the prototype's). 우리 barely holds
 * itself together: a heavyweight's 2.6 s weight shift with the guard on the opponent's side, a fist clenching now and then,
 * and the Refusal, everything coming loose for 2 s and slammed back together by the field. Off by default (the oracle-parity
 * harness); the behaviour turns it on.
 */
export const URI_IDLE = {
  /** The weight shift's period (s). */
  period: 2.6,
  /** The first Refusal (s of kinetic time) and the interval after each (base + random span). */
  firstRefusal: 8,
  refusalEvery: 13,
  refusalSpan: 4,
  /** The first clench (s) and the interval after each (base + random span). */
  firstClench: 2.2,
  clenchEvery: 2.6,
  clenchSpan: 3,
} as const;

const sst = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The Refusal's coming-apart (0..1) at age R (s): loosening over 1.6 s, held, snapped back by 2.32 s. */
export function uriLoose(R: number): number {
  if (R < 0) return 0;
  return R < 1.6 ? sst(0, 1.6, R) : R < 2.1 ? 1 : R < 2.32 ? 1 - sst(2.1, 2.32, R) : 0;
}
/** The slam's blue flash (1 → 0 over R 2.1–2.5). */
export function uriFlash(R: number): number {
  return R >= 2.1 && R < 2.5 ? 1 - (R - 2.1) / 0.4 : 0;
}

export interface UriImpact {
  move: UriMoveName;
  dir: 1 | -1;
  lead: UriSide;
  rear: UriSide;
  hitstop: number;
  shake: number;
}

/** Mulberry32: the seeded generator for the oracle's one random draw. */
function mulberry(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class UriKinetics {
  readonly tune: UriTune = { stiff: 1, damp: 1, mass: 1, react: 1, thrust: 1, loop: 1, hitstop: 1 };
  readonly L = {} as Record<LinkKey, Link>;
  /** Simulation time (s); it does not advance during hitstop. */
  t = 0;
  hitstop = 0;
  /** The opponent, in reference coordinates. */
  target: [number, number] = [-2, 134];
  /** Health 0..100 (the loop; 2C) and a part-integrity lookup (0..1; 2C). */
  hp = 100;
  integrity: (part: 'uaL' | 'faL' | 'uaR' | 'faR' | 'domeL' | 'domeR' | 'pyL' | 'pyR' | 'chamber') => number =
    () => 1;
  /** A part has gone (2C): it no longer thrusts. */
  gone: (part: 'pyL' | 'pyR') => boolean = () => false;
  private cur: CurMove | null = null;
  private readonly loopS = {
    l: { x: 1, v: 0 },
    r: { x: 1, v: 0 },
    sh: { x: 0, v: 0 },
    vt: { x: 1, v: 0 },
    br: { x: 1, v: 0 },
  };
  private readonly coreS = { x: 0, v: 0, y: 0, vy: 0 };
  private readonly moonS = { x: 0, y: 0, vx: 0, vy: 0, a: 0, va: 0, init: false };
  private readonly pyl = { L: { th: 0.5, ang: 0 }, R: { th: 0.5, ang: 0 } };
  private prevFist: { L: [number, number] | null; R: [number, number] | null } = { L: null, R: null };
  private readonly fistVel = { L: [0, 0] as [number, number], R: [0, 0] as [number, number] };
  private torque = 0;
  private stress = 0;
  private rand: () => number;
  private readonly pose: UriPose;
  /** The impact of the last step, for the behaviour (hits, hitstop, fx); cleared when read. */
  private pendingImpact: UriImpact | null = null;
  private readonly tmp = { x: 0, y: 0 };
  /** The living idle (URI_IDLE): on in the game, off in the oracle-parity harness; its own seeded stream. */
  idleOn = false;
  private irand: () => number;
  private readonly idle = {
    /** The current Refusal's start (s; −1 none), the next one's earliest time, its slam done. */
    ref0: -1,
    nextRef: URI_IDLE.firstRefusal as number,
    slamDone: false,
    /** Each fist's last clench start (s) and the next clench's earliest time. */
    clenchL: -9,
    clenchR: -9,
    nextClench: URI_IDLE.firstClench as number,
    /** The weight shift's phase sine (the prototype's IDLE.w) and the Refusal's coming-apart / flash. */
    w: 0,
    loose: 0,
    flash: 0,
    /** The slam fired this step (for the behaviour's ring, flash and shake), once. */
    slam: false,
  };

  constructor(seed: number) {
    this.rand = mulberry(seed ^ 0x55524931);
    this.irand = mulberry(seed ^ 0x49444c45);
    this.pose = {
      hx: 0,
      hy: 0,
      ha: 0,
      ta: 0,
      daL: 0,
      daR: 0,
      dxL: 0,
      dxR: 0,
      sL: 0,
      sR: 0,
      eL: 0,
      eR: 0,
      wL: 0,
      wR: 0,
      pyL: 0,
      pyR: 0,
    };
    this.resetLinks();
  }

  resetLinks(): void {
    for (const k of LINK_KEYS) {
      const c = k[0] === 'c';
      this.L[k] = { x: c ? 1.1 : 0, v: 0, tgt: c ? 1.1 : 0, km: 1, zeta: 0.5, ext: 0, m: LINK_MASS[k] };
    }
  }

  /** Full reset (a new round): links, the loop, the cores, the moon, the move. */
  reset(seed: number): void {
    this.resetLinks();
    this.cur = null;
    this.t = 0;
    this.hitstop = 0;
    this.hp = 100;
    for (const s of Object.values(this.loopS)) s.v = 0;
    this.loopS.l.x = this.loopS.r.x = this.loopS.vt.x = this.loopS.br.x = 1;
    this.loopS.sh.x = 0;
    Object.assign(this.coreS, { x: 0, v: 0, y: 0, vy: 0 });
    this.moonS.init = false;
    this.pyl.L.th = this.pyl.R.th = 0.5;
    this.pyl.L.ang = this.pyl.R.ang = 0;
    this.prevFist = { L: null, R: null };
    this.fistVel.L = [0, 0];
    this.fistVel.R = [0, 0];
    this.rand = mulberry(seed ^ 0x55524931);
    this.pendingImpact = null;
    this.irand = mulberry(seed ^ 0x49444c45);
    Object.assign(this.idle, {
      ref0: -1,
      nextRef: URI_IDLE.firstRefusal,
      slamDone: false,
      clenchL: -9,
      clenchR: -9,
      nextClench: URI_IDLE.firstClench,
      w: 0,
      loose: 0,
      flash: 0,
      slam: false,
    });
  }

  /** Seconds since the current Refusal began (−1 if none). */
  get refT(): number {
    return this.idle.ref0 >= 0 ? this.t - this.idle.ref0 : -1;
  }

  /** The Refusal's slam fired since the last call (the behaviour's ring, flash and shake), once. */
  takeRefusalSlam(): boolean {
    const s = this.idle.slam;
    this.idle.slam = false;
    return s;
  }

  /**
   * The idle's clocks, once per substep before the physics (the prototype's `idleTick`): a move ends the Refusal; at rest a
   * Refusal and the clenches start on their own; the Refusal's coming-apart, flash and slam impulse.
   */
  private idleTick(t: number): void {
    const I = this.idle;
    if (!this.idleOn) {
      I.ref0 = -1;
      I.loose = 0;
      I.flash = 0;
      return;
    }
    if (this.cur) I.ref0 = -1;
    else {
      if (I.ref0 < 0 && t > I.nextRef) {
        I.ref0 = t;
        I.slamDone = false;
        I.nextRef = t + URI_IDLE.refusalEvery + this.irand() * URI_IDLE.refusalSpan;
      }
      if (t > I.nextClench && I.ref0 < 0) {
        if (this.irand() < 0.5) I.clenchL = t;
        else I.clenchR = t;
        I.nextClench = t + URI_IDLE.clenchEvery + this.irand() * URI_IDLE.clenchSpan;
      }
    }
    const R = this.refT;
    I.loose = uriLoose(R);
    I.flash = uriFlash(R);
    if (R >= 2.1 && !I.slamDone) {
      // the field slams everything back together
      I.slamDone = true;
      I.slam = true;
      this.loopS.br.v += 5;
      this.loopS.l.v -= 2;
      this.loopS.r.v -= 2;
      this.coreS.vy -= 30;
      this.L.hy.v -= 18;
    }
    if (R > 5.6) I.ref0 = -1;
  }

  /**
   * The idle's goals at rest (the prototype's `idleGoals`): the weight shifting side to side with the root dipping on each
   * side and the arks rolling with it, the guard (the arm on the opponent's side a little forward, never mirrored), the
   * clench, and the Refusal's loosening, slam and guard.
   */
  private idleGoals(t: number, G: Goals): void {
    const I = this.idle;
    const d = this.targetVec().x >= 0 ? 1 : -1;
    const ps = (t * 2 * Math.PI) / URI_IDLE.period;
    const w = DMath.sin(ps);
    I.w = w;
    const R = this.refT;
    const lo = R >= 0 && R < 2.1 ? sst(0, 1.6, R) : 0;
    const guard = R >= 2.1 && R < 5.2 ? 1 - sst(4.3, 5.2, R) : 0;
    const k = (1 - lo) * (1 - guard * 0.7);
    G.hx = (4 * w + 3 * d) * k + guard * 6 * d;
    G.hy = -1.6 * DMath.cos(2 * ps) * k + lo * 5 - guard * 2;
    G.ha = 1.2 * D * w * k;
    G.ta = (2.5 * w * k + 2 * d + guard * 3 * d) * D - lo * 3 * D * d;
    G.daR = (3.5 * w + 1.5) * D * k + lo * 6 * D;
    G.daL = (3.5 * w - 1.5) * D * k - lo * 6 * D;
    G.dxR = 1.5 * w * k + lo * 4;
    G.dxL = 1.5 * w * k - lo * 4;
    const b1 = DMath.sin(ps * 2 + 0.6);
    const b2 = DMath.sin(ps * 2 + 1.6);
    const lead: Triple = [
      (-10 - guard * 16 + 2.5 * b1 * k + lo * 16) * d * D,
      (-12 - guard * 18 + 3 * b1 * k + lo * 14) * d * D,
      (-4 + lo * 10) * d * D,
    ];
    const rear: Triple = [
      (6 + guard * 5 + 2 * b2 * k - lo * 10) * d * D,
      (4 + guard * 7 + 2.5 * b2 * k - lo * 8) * d * D,
      0,
    ];
    if (d > 0) {
      G.authR = lead;
      G.authL = rear;
    } else {
      G.authL = lead;
      G.authR = rear;
    }
    const clench = (c0: number): number => {
      const u = t - c0;
      return u < 0.3 ? 1.14 - 0.28 * sst(0, 0.3, u) : u < 1.1 ? 0.86 : u < 2.4 ? 0.86 + 0.28 * sst(1.1, 2.4, u) : 1.14;
    };
    G.cL = clench(I.clenchL);
    G.cR = clench(I.clenchR);
    if (lo > 0) G.cL = G.cR = 1.14 + 0.15 * lo;
    if (R >= 2.1 && R < 3.5) {
      G.cL = G.cR = 0.76;
      G.km = { cL: 3, cR: 3, hx: 1.3, hy: 1.3, ta: 1.2 };
    }
    G.ikw = 0;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  intent
   * ---------------------------------------------------------------------------------------------- */

  /** The target vector from the oracle's centre-of-mass point (x right, y down; `ang` with y up). */
  targetVec(): { x: number; y: number; dist: number; ang: number } {
    const dx = this.target[0] - URI_CM0[0];
    const dy = this.target[1] - URI_CM0[1];
    return { x: dx, y: dy, dist: DMath.hypot(dx, dy), ang: DMath.atan2(-dy, dx) };
  }

  /** The best move for the target (spec §6.4): elevation > 40° → uppercut, < −38° → slam, else punch / cross alternating. */
  pickMove(): UriMoveName {
    const tv = this.targetVec();
    const el = DMath.atan2(-tv.y, Math.abs(tv.x)) / D;
    if (el > 40) return 'upper';
    if (el < -38) return 'slam';
    // (the oracle remembers the last move only while a move is still running)
    return this.cur && this.cur.name === 'punch' ? 'cross' : 'punch';
  }

  /**
   * Start a move. The arm on the opponent's side leads, the other is the rear arm: the body's real sides, never mirrored
   * (spec §5). The links keep their state: a move begun during a taper grows out of the current motion (spec §6.3).
   */
  begin(name: UriMoveName): void {
    // a move cancels the Refusal at once (the links are springs: nothing jumps)
    this.idle.ref0 = -1;
    this.idle.loose = 0;
    this.idle.flash = 0;
    const tv = this.targetVec();
    const dir: 1 | -1 = tv.x >= 0 ? 1 : -1;
    this.cur = {
      name,
      t0: this.t,
      dir,
      lead: dir > 0 ? 'R' : 'L',
      rear: dir > 0 ? 'L' : 'R',
      ph: 0,
      phT: this.t,
      hitDone: false,
      impact: false,
      arrive: NaN,
    };
  }

  get busy(): boolean {
    return this.cur !== null;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  one 60 Hz tick
   * ---------------------------------------------------------------------------------------------- */

  /** Advance one tick of `dt` seconds (1/60 in the game): hitstop holds the body; else two 120 Hz substeps. */
  step(dt: number): void {
    if (this.hitstop > 0) {
      this.hitstop -= dt;
      return;
    }
    this.t += dt;
    const n = Math.max(1, Math.round(dt * URI_KINETICS.hz));
    const h = dt / n;
    for (let k = 0; k < n; k++) {
      this.idleTick(this.t);
      this.physics(this.t, h);
      this.trackFists(h);
    }
  }

  /** The impact of the last step (null if none), once. */
  takeImpact(): UriImpact | null {
    const i = this.pendingImpact;
    this.pendingImpact = null;
    return i;
  }

  /** The pose the rig places the parts with (links → pose; pylon vectoring per side). */
  currentPose(): UriPose {
    const P = this.pose;
    const L = this.L;
    P.hx = L.hx.x;
    P.hy = L.hy.x;
    P.ha = L.ha.x;
    P.ta = L.ta.x;
    P.daL = L.daL.x;
    P.daR = L.daR.x;
    P.dxL = L.dxL.x;
    P.dxR = L.dxR.x;
    P.sL = L.sL.x;
    P.sR = L.sR.x;
    P.eL = L.eL.x;
    P.eR = L.eR.x;
    P.wL = L.wL.x;
    P.wR = L.wR.x;
    // the oracle draws a pylon at the hips' angle + half its vectoring + a slow wobble
    P.pyL = this.pyl.L.ang * 0.5 + DMath.sin(this.t * 0.9) * 0.02;
    P.pyR = this.pyl.R.ang * 0.5 + DMath.sin(this.t * 0.9 + 1) * 0.02;
    return P;
  }

  view(out: UriKineticView): UriKineticView {
    const c = this.cur;
    out.move = c ? c.name : null;
    out.phase = c ? (URI_MOVES[c.name][c.ph]?.n ?? null) : null;
    out.lead = c ? c.lead : null;
    out.rear = c ? c.rear : null;
    out.loop.l = this.loopS.l.x;
    out.loop.r = this.loopS.r.x;
    out.loop.sh = this.loopS.sh.x;
    out.loop.vt = this.loopS.vt.x;
    out.loop.br = this.loopS.br.x;
    out.stress = this.stress;
    out.torque = this.torque;
    out.core.x = this.coreS.x;
    out.core.y = this.coreS.y;
    out.pylon.L.th = this.pyl.L.th;
    out.pylon.L.ang = this.pyl.L.ang;
    out.pylon.R.th = this.pyl.R.th;
    out.pylon.R.ang = this.pyl.R.ang;
    out.moon = this.moonS.init
      ? { x: this.moonS.x, y: this.moonS.y + DMath.sin(this.t * 0.8) * 1.2, a: this.moonS.a }
      : null;
    out.spread.L = this.L.cL.x;
    out.spread.R = this.L.cR.x;
    const iv = (out.idle ??= { on: false, refT: -1, loose: 0, flash: 0 });
    iv.on = this.idleOn;
    iv.refT = this.refT;
    iv.loose = this.idle.loose;
    iv.flash = this.idle.flash;
    return out;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  the oracle's physics, line for line
   * ---------------------------------------------------------------------------------------------- */

  private stepLinks(dt: number, dmg: Partial<Record<LinkKey, { k: number; c: number }>>): void {
    const T = this.tune;
    for (const k of LINK_KEYS) {
      const l = this.L[k];
      const m = l.m * T.mass;
      const d = dmg[k];
      const kk = URI_KINETICS.stiffness * T.stiff * l.km * (d ? d.k : 1);
      const c = 2 * l.zeta * Math.sqrt(kk * m) * T.damp * (d ? d.c : 1);
      let a = (kk * (l.tgt - l.x) - c * l.v + l.ext) / m;
      const amax =
        (k[0] === 'h' && k !== 'ha'
          ? 2600
          : k.startsWith('dx')
            ? 2200
            : k[0] === 'c'
              ? 40
              : 58 * Math.sqrt(l.km)) / m;
      a = Math.max(-amax, Math.min(amax, a));
      l.v += a * dt;
      l.x += l.v * dt;
      const lm = LINK_LIMIT[k];
      if (l.x < lm[0]) {
        l.x = lm[0];
        l.v *= -0.2;
      }
      if (l.x > lm[1]) {
        l.x = lm[1];
        l.v *= -0.2;
      }
      l.ext = 0;
    }
  }

  /** The pose the transforms see now (links only; the pylons do not move the body). */
  private linkPose(): UriPose {
    return this.currentPose();
  }

  /** Constrained IK (the oracle's `solveArm`): shoulder and elbow angles for the wrist to reach `w`, elbow swung outward. */
  private solveArm(s: UriSide, wx: number, wy: number, Td: Xf, limitReach = 0.97): { s: number; e: number } {
    const ua = uriPart(s === 'L' ? 'uaL' : 'uaR');
    const fa = uriPart(s === 'L' ? 'faL' : 'faR');
    const S0 = ua.ja!;
    const E0 = ua.jb!;
    const W0 = fa.jb!;
    const L1 = DMath.hypot(E0[0] - S0[0], E0[1] - S0[1]);
    const L2 = DMath.hypot(W0[0] - E0[0], W0[1] - E0[1]);
    const a10 = DMath.atan2(E0[1] - S0[1], E0[0] - S0[0]);
    const a20 = DMath.atan2(W0[1] - E0[1], W0[0] - E0[0]);
    apply(Td, S0[0], S0[1], this.tmp);
    const Sx = this.tmp.x;
    const Sy = this.tmp.y;
    const dx = wx - Sx;
    const dy = wy - Sy;
    const d = DMath.hypot(dx, dy) || 1;
    const dmax = (L1 + L2) * limitReach;
    const dmin = Math.abs(L1 - L2) + 4;
    const dc = Math.max(dmin, Math.min(dmax, d));
    const ph = DMath.atan2(dy, dx);
    const cb = Math.max(-1, Math.min(1, (L1 * L1 + dc * dc - L2 * L2) / (2 * L1 * dc)));
    const be = DMath.acos(cb);
    let best: { t1: number; t2: number; out: number } | null = null;
    for (const sg of [1, -1]) {
      const t1 = ph + sg * be;
      const Ex = Sx + DMath.cos(t1) * L1;
      const Ey = Sy + DMath.sin(t1) * L1;
      const t2 = DMath.atan2(Sy + DMath.sin(ph) * dc - Ey, Sx + DMath.cos(ph) * dc - Ex);
      const out = (s === 'L' ? -1 : 1) * (Ex - 200) + 0.3 * (Ey - Sy);
      if (!best || out > best.out) best = { t1, t2, out };
    }
    return { s: wrap(best!.t1 - a10 - Td.a), e: wrap(best!.t2 - best!.t1 - (a20 - a10)) };
  }

  private armLen(s: UriSide): number {
    const ua = uriPart(s === 'L' ? 'uaL' : 'uaR');
    const fa = uriPart(s === 'L' ? 'faL' : 'faR');
    return (
      DMath.hypot(ua.jb![0] - ua.ja![0], ua.jb![1] - ua.ja![1]) +
      DMath.hypot(fa.jb![0] - fa.ja![0], fa.jb![1] - fa.ja![1])
    );
  }

  /** The shoulder joint in the current pose. */
  private shoulder(s: UriSide, Td: Xf): [number, number] {
    const ua = uriPart(s === 'L' ? 'uaL' : 'uaR');
    apply(Td, ua.ja![0], ua.ja![1], this.tmp);
    return [this.tmp.x, this.tmp.y];
  }

  private goals(t: number, Td: Record<UriSide, Xf>): Goals {
    const G: Goals = {
      hx: 0,
      hy: 0,
      ha: 0,
      ta: 0,
      daL: 0,
      daR: 0,
      dxL: 0,
      dxR: 0,
      cL: URI_KINETICS.spreadRest,
      cR: URI_KINETICS.spreadRest,
      wristL: null,
      wristR: null,
      authL: null,
      authR: null,
      ikw: 0.15,
      km: {},
      phase: null,
    };
    const cur = this.cur;
    if (!cur) {
      if (this.idleOn) this.idleGoals(t, G);
      return G;
    }
    const M = URI_MOVES[cur.name];
    let ph = M[cur.ph]!;
    // (no tolerance on purpose: like the oracle, a phase ends on the first tick whose float time has passed its duration)
    let u = (t - cur.phT) / ph.d;
    // a striking phase ends when the fist has actually arrived (or the body gives up waiting), not when a clock says so
    while (u >= 1) {
      if (ph.hit && !cur.hitDone) {
        if (!((!Number.isNaN(cur.arrive) && cur.arrive < URI_KINETICS.arrive) || u >= URI_KINETICS.timeout))
          break;
        cur.hitDone = true;
        cur.impact = true;
      }
      cur.ph++;
      cur.phT = t;
      if (cur.ph >= M.length) {
        this.cur = null;
        if (this.idleOn) this.idleGoals(t, G);
        return G;
      }
      ph = M[cur.ph]!;
      u = 0;
    }
    const d = cur.dir;
    const ld = cur.lead;
    const rr = cur.rear;
    const n = ph.n;
    G.phase = n;
    const A = URI_AUTHORED[cur.name][n];
    if (A) {
      const lead = A.lead.map((v) => v * d * D) as unknown as Triple;
      const rear = A.rear.map((v) => v * d * D) as unknown as Triple;
      if (ld === 'L') {
        G.authL = lead;
        G.authR = rear;
      } else {
        G.authR = lead;
        G.authL = rear;
      }
    }
    const setWrist = (s: UriSide, x: number, y: number): void => {
      if (s === 'L') G.wristL = [x, y];
      else G.wristR = [x, y];
    };
    const setDa = (s: UriSide, v: number): void => {
      if (s === 'L') G.daL = v;
      else G.daR = v;
    };
    const setDx = (s: UriSide, v: number): void => {
      if (s === 'L') G.dxL = v;
      else G.dxR = v;
    };
    const setC = (s: UriSide, v: number): void => {
      if (s === 'L') G.cL = v;
      else G.cR = v;
    };
    const reachDir = (S: [number, number], cone: number, axis: number): [number, number] => {
      let a = DMath.atan2(this.target[1] - S[1], this.target[0] - S[0]);
      const da = wrap(a - axis);
      a = axis + Math.max(-cone, Math.min(cone, da));
      return [DMath.cos(a), DMath.sin(a)];
    };
    // aiming correction grows only for steep targets
    const tv = this.targetVec();
    const el = Math.abs(DMath.atan2(-tv.y, Math.abs(tv.x))) / D;
    G.ikw = 0.14 + 0.14 * Math.min(1, Math.max(0, (el - 20) / 45));
    const taper = (): void => {
      // layered settling: the fist resolves first, then the arm, then the shoulder ark, then the torso and root
      G.km = {
        wL: 1.1,
        wR: 1.1,
        cL: 0.55,
        cR: 0.55,
        sL: 0.62,
        sR: 0.62,
        eL: 0.66,
        eR: 0.66,
        daL: 0.42,
        daR: 0.42,
      };
      Object.assign(G.km, { dxL: 0.42, dxR: 0.42, ta: 0.3, ha: 0.3, hx: 0.28, hy: 0.28 });
    };
    if (cur.name === 'punch') {
      const S = this.shoulder(ld, Td[ld]);
      const Ln = this.armLen(ld);
      const rd = reachDir(S, 30 * D, d > 0 ? 0 : Math.PI);
      if (n === 'load') {
        Object.assign(G, { hx: -6 * d, hy: 2, ha: -2 * D * d, ta: -5 * D * d });
        setDa(ld, -7 * D * d);
        setDx(ld, -3 * d);
        setDa(rr, 3 * D * d);
        setC(ld, 1.0);
      }
      if (n === 'drive' || n === 'follow') {
        Object.assign(G, { hx: (n === 'drive' ? 11 : 12) * d, ha: 3 * D * d, ta: 7 * D * d });
        setDa(ld, 12 * D * d);
        setDx(ld, 8 * d);
        setDa(rr, -4 * D * d);
        setWrist(ld, S[0] + rd[0] * Ln, S[1] + rd[1] * Ln);
        setC(ld, 0.8);
      }
      if (n === 'taper') taper();
    }
    if (cur.name === 'cross') {
      const Ln = this.armLen(rr);
      if (n === 'coil') {
        Object.assign(G, { hx: -7 * d, hy: 1, ha: -3 * D * d, ta: -10 * D * d });
        setDa(rr, -11 * D * d);
        setDx(rr, -6 * d);
        setDa(ld, 4 * D * d);
        setC(rr, 1.0);
      }
      if (n === 'release' || n === 'follow') {
        Object.assign(G, { hx: 11 * d, ha: 4 * D * d, ta: 13 * D * d });
        setDa(rr, 15 * D * d);
        setDx(rr, 12 * d);
        setDa(ld, -6 * D * d);
        setDx(ld, -4 * d);
        const a = DMath.atan2(this.target[1] - 150, this.target[0] - 200);
        setWrist(rr, 200 + DMath.cos(a) * Ln * 0.62, 150 + DMath.sin(a) * Ln * 0.62 + 10);
        setC(rr, 0.8);
      }
      if (n === 'taper') taper();
    }
    if (cur.name === 'slam') {
      // 우리 falls through its own attack
      if (n === 'load') {
        G.hy = 6;
        G.cL = G.cR = 1.06;
      }
      if (n === 'rise') {
        G.hy = -20;
        G.daL = -14 * D;
        G.daR = 14 * D;
        G.dxL = -4;
        G.dxR = 4;
        G.cL = G.cR = 0.98;
        G.km = { sL: 0.75, sR: 0.75, eL: 0.7, eR: 0.7 };
      }
      if (n === 'apex') {
        // a held moment of impossible poise: still, not floppy
        G.hy = -23 + DMath.sin(t * 37) * 0.4;
        G.daL = -16 * D;
        G.daR = 16 * D;
        G.cL = G.cR = 0.92;
        G.km = { hy: 1.1 };
      }
      if (n === 'fall' || n === 'follow') {
        const below = Math.min(1, Math.max(-1, (this.target[0] - 200) / 180));
        G.hy = n === 'fall' ? 16 : 18;
        G.hx = below * 7;
        G.ta = below * 4 * D;
        G.daL = 7 * D;
        G.daR = -7 * D;
        G.dxL = 3;
        G.dxR = -3;
        G.wristL = [200 - 26 + below * 30, 262];
        G.wristR = [200 + 26 + below * 30, 262];
        G.cL = G.cR = 0.78;
        if (n === 'fall') G.km = { hy: 1.7, hx: 1.3, sL: 2.6, sR: 2.6, eL: 2.2, eR: 2.2 };
      }
      if (n === 'taper') {
        taper();
        for (const k of Object.keys(G.km) as LinkKey[]) G.km[k] = G.km[k]! * 0.85;
      }
    }
    if (cur.name === 'upper') {
      const S = this.shoulder(ld, Td[ld]);
      const Ln = this.armLen(ld);
      const rd = reachDir(S, 36 * D, -Math.PI / 2);
      if (n === 'compress') {
        Object.assign(G, { hy: 9, hx: -2 * d, ta: -4 * D * d });
        setDa(ld, 6 * D * d);
        setDx(ld, -2 * d);
        setC(ld, 0.98);
      }
      if (n === 'launch' || n === 'follow') {
        Object.assign(G, { hy: n === 'launch' ? -14 : -16, hx: 4 * d, ta: 5 * D * d });
        setDa(ld, -16 * D * d);
        setDx(ld, 5 * d);
        setDx(rr, 3 * d);
        setDa(rr, 4 * D * d);
        setWrist(ld, S[0] + rd[0] * Ln, S[1] + rd[1] * Ln);
        setC(ld, 0.8);
        if (n === 'launch') G.km = { hy: 1.4, [`s${ld}`]: 1.2 } as Partial<Record<LinkKey, number>>;
      }
      if (n === 'taper') taper();
    }
    return G;
  }

  private springTo(o: Spring, tg: number, k: number, c: number, dt: number): void {
    o.v += (k * (tg - o.x) - c * o.v) * dt;
    o.x += o.v * dt;
  }

  private phaseName(): string | null {
    const c = this.cur;
    return c ? (URI_MOVES[c.name][c.ph]?.n ?? null) : null;
  }

  private physics(t: number, dt: number): void {
    if (dt <= 0) return;
    const L = this.L;
    const TU = this.tune;
    const B = bodyTransforms(this.linkPose());
    const Td: Record<UriSide, Xf> = { L: B.domeL, R: B.domeR };
    const G = this.goals(t, Td);
    // goals → link targets; arms that act get theirs from the IK; arms that don't stay home
    L.hx.tgt = G.hx;
    L.hy.tgt = G.hy;
    L.ha.tgt = G.ha;
    L.ta.tgt = G.ta;
    L.daL.tgt = G.daL;
    L.daR.tgt = G.daR;
    L.dxL.tgt = G.dxL;
    L.dxR.tgt = G.dxR;
    L.cL.tgt = G.cL;
    L.cR.tgt = G.cR;
    for (const s of ['L', 'R'] as const) {
      const a = (s === 'L' ? G.authL : G.authR) ?? ([0, 0, 0] as const);
      let ts = a[0];
      let te = a[1];
      const w = s === 'L' ? G.wristL : G.wristR;
      if (w) {
        const r = this.solveArm(s, w[0], w[1], Td[s]);
        ts = a[0] + G.ikw * wrap(r.s - a[0]);
        te = a[1] + G.ikw * wrap(r.e - a[1]);
      }
      const ls = s === 'L' ? L.sL : L.sR;
      const le = s === 'L' ? L.eL : L.eR;
      const lw = s === 'L' ? L.wL : L.wR;
      ls.tgt = ls.x + wrap(ts - ls.x);
      le.tgt = le.x + wrap(te - le.x);
      lw.tgt = a[2];
    }
    // damping character by region: root and torso near-critical, arks slightly under, arms restrained, fists the most kinetic
    for (const k of LINK_KEYS) {
      L[k].km = G.km[k] ?? 1;
      L[k].zeta = LINK_ZETA[k];
    }
    // damage changes how the structure carries load: less stiffness and damping where it is broken
    const dm: Partial<Record<LinkKey, { k: number; c: number }>> = {};
    const integ = this.integrity;
    const ai = { L: Math.min(integ('uaL'), integ('faL')), R: Math.min(integ('uaR'), integ('faR')) };
    for (const s of ['L', 'R'] as const) {
      const q = ai[s];
      const arm = { k: 0.7 + 0.3 * q, c: 0.55 + 0.45 * q };
      dm[`s${s}`] = dm[`e${s}`] = dm[`w${s}`] = arm;
      const dq = integ(s === 'L' ? 'domeL' : 'domeR');
      dm[`da${s}`] = dm[`dx${s}`] = { k: 1, c: 0.5 + 0.5 * dq };
    }
    const pyEff = {
      L: this.gone('pyL') ? 0 : integ('pyL'),
      R: this.gone('pyR') ? 0 : integ('pyR'),
    };
    // counter-torque: the arms' angular momentum pushes the rest of the war-body the other way
    let Larm = 0;
    const r1 = 60;
    const r2 = 55;
    const r3 = 30;
    for (const s of ['L', 'R'] as const) {
      const ls = s === 'L' ? L.sL : L.sR;
      const le = s === 'L' ? L.eL : L.eR;
      const lw = s === 'L' ? L.wL : L.wR;
      Larm += ls.m * ls.v * r1 + le.m * le.v * r2 * 0.7 + lw.m * lw.v * r3 * 0.4;
    }
    this.torque = Larm;
    // counter-torque is mostly suppressed inside the structure; only a little of it is allowed to move the body
    L.ta.ext += -Larm * 0.05 * TU.react;
    L.ha.ext += -Larm * 0.015 * TU.react;
    this.coreS.v += -Larm * 0.0009 * TU.react * dt * 60;
    const other = Larm > 0 ? L.daL : L.daR;
    other.ext += -Larm * 0.012 * TU.react;
    for (const s of ['L', 'R'] as const) {
      const fv = this.fistVel[s];
      const odx = s === 'L' ? L.dxR : L.dxL;
      L.hx.ext += -fv[0] * 0.3 * TU.react;
      odx.ext += -fv[0] * 0.1 * TU.react;
      L.hy.ext += -fv[1] * 0.12 * TU.react;
    }
    // the pylons solve what is left: they damp drift and spin, as far as each one still can
    const corrX = -(L.hx.v * 0.04 + L.ta.v * 1.6);
    const corrY = -(L.hy.v * 0.05);
    const comp = TU.thrust;
    const effAvg = (pyEff.L + pyEff.R) * 0.5;
    L.ta.ext += -L.ta.v * 6 * comp * effAvg;
    L.hx.ext += -L.hx.v * 2.2 * comp * effAvg;
    L.hy.ext += -L.hy.v * 2 * comp * effAvg;
    const phn = this.phaseName();
    const curName = this.cur ? this.cur.name : null;
    for (const s of ['L', 'R'] as const) {
      const side = s === 'L' ? -1 : 1;
      const p = this.pyl[s];
      const commit =
        phn && ['drive', 'release', 'launch', 'fall', 'follow'].includes(phn)
          ? 0.55
          : phn && ['load', 'coil', 'compress'].includes(phn)
            ? 0.3
            : phn === 'taper'
              ? 0.25
              : 0;
      const want =
        0.45 +
        commit +
        Math.min(1.2, Math.abs(Larm) * 0.004) * (Larm * side < 0 ? 1.3 : 0.7) +
        Math.max(0, corrY * 0.9) +
        Math.max(0, corrX * side * 1.1) +
        Math.abs(L.ta.v) * 0.4 +
        (curName === 'slam' && (phn === 'rise' || phn === 'apex') ? 1.2 : 0) +
        (curName === 'upper' && phn === 'launch' ? 1.1 : 0) +
        // the idle: the loaded side's pylon burns harder; both flare for the Refusal's slam
        (!this.cur && this.idleOn
          ? Math.max(0, this.idle.w * side) * 0.55 +
            (this.refT > 1.7 && this.refT < 3.6 ? 1.7 : 0) -
            this.idle.loose * 0.35
          : 0);
      p.th += (want * pyEff[s] * TU.thrust - p.th) * Math.min(1, dt * 5);
      p.ang += (-corrX * side * 0.25 - p.ang) * Math.min(1, dt * 6);
    }
    this.stepLinks(dt, dm);
    // how far are the striking arms from their (authored + corrected) pose? the blow lands when they get there
    if (this.cur) {
      let worst = 0;
      let any = false;
      for (const s of ['L', 'R'] as const) {
        if (!(s === 'L' ? G.wristL : G.wristR)) continue;
        any = true;
        const ls = s === 'L' ? L.sL : L.sR;
        const le = s === 'L' ? L.eL : L.eR;
        worst = Math.max(worst, (Math.abs(ls.tgt - ls.x) + Math.abs(le.tgt - le.x) * 0.8) * 60);
      }
      this.cur.arrive = any ? worst : 0;
    }
    // the loop is the inertial nervous system: lobes stretch on the side carrying load, the crossing shears with the spin
    const LP = this.loopS;
    const loadR = Math.max(0, Larm) * 0.004;
    const loadL = Math.max(0, -Larm) * 0.004;
    const dmgLoop = 1 - integ('chamber') * 0.7 - (this.hp / 100) * 0.3 + 0.3;
    const phn2 = this.phaseName();
    const slamRise = this.cur?.name === 'slam' && (phn2 === 'rise' || phn2 === 'apex');
    const loading = phn2 === 'load' || phn2 === 'coil' || phn2 === 'compress';
    const tapering = phn2 === 'taper' || !this.cur;
    const lk = tapering ? 20 : 40;
    const lc = tapering ? 3.2 : 6;
    // the idle: the lobe on the loaded side stretches; both thin as the Refusal loosens
    const idleLobe = !this.cur && this.idleOn ? this.idle.w * 0.07 : 0;
    const idleThin = !this.cur && this.idleOn ? this.idle.loose * 0.12 : 0;
    this.springTo(
      LP.r,
      slamRise
        ? 0.82
        : loading
          ? 0.93
          : 1 + Math.min(0.3, loadR) - Math.min(0.14, loadL * 0.5) + idleLobe - idleThin,
      lk,
      lc * (1 / dmgLoop),
      dt,
    );
    this.springTo(
      LP.l,
      slamRise
        ? 0.82
        : loading
          ? 0.93
          : 1 + Math.min(0.3, loadL) - Math.min(0.14, loadR * 0.5) - idleLobe - idleThin,
      lk,
      lc * (1 / dmgLoop),
      dt,
    );
    this.springTo(
      LP.sh,
      Math.max(-12, Math.min(12, L.ta.v * 7 + Larm * 0.012)),
      tapering ? 18 : 30,
      tapering ? 2.6 : 4,
      dt,
    );
    this.springTo(
      LP.vt,
      1 + Math.max(-0.25, Math.min(0.35, -L.hy.v * 0.014)),
      tapering ? 18 : 30,
      tapering ? 2.6 : 4,
      dt,
    );
    const rT = this.refT;
    this.springTo(
      LP.br,
      1 + Math.min(0.6, Math.abs(Larm) * 0.003) + (rT > 1.6 && rT < 3.2 ? 0.75 : 0) - this.idle.loose * 0.15,
      20,
      6,
      dt,
    );
    this.stress = Math.min(
      1,
      Math.abs(LP.l.x - 1) + Math.abs(LP.r.x - 1) + Math.abs(LP.sh.x) / 20 + Math.abs(LP.vt.x - 1),
    );
    // the command moon: pulled along by the body's gravity, not carried. heavy, so it lags and swings a little, then settles
    {
      const MN = URI_KINETICS.moon;
      const moon = uriPart('moon');
      apply(B.torso, moon.pgX, moon.pgY, this.tmp);
      const ax = this.tmp.x;
      const ay = this.tmp.y;
      const M = this.moonS;
      if (!M.init) {
        M.x = ax;
        M.y = ay;
        M.init = true;
      }
      const dx = ax - M.x;
      const dy = ay - M.y;
      const dist = DMath.hypot(dx, dy);
      // the further it trails, the harder the pull: a tether, not a spring toy
      const pull = MN.pull * (1 + Math.min(1.5, dist / 14));
      M.vx += (pull * dx - 2 * MN.zeta * Math.sqrt(MN.pull) * M.vx) * dt;
      M.vy += (pull * dy - 2 * MN.zeta * Math.sqrt(MN.pull) * M.vy) * dt;
      M.x += M.vx * dt;
      M.y += M.vy * dt;
      const ex = M.x - ax;
      const ey = M.y - ay;
      const ed = DMath.hypot(ex, ey);
      if (ed > MN.trail) {
        M.x = ax + (ex / ed) * MN.trail;
        M.y = ay + (ey / ed) * MN.trail;
      }
      // it keeps facing the way the body faces, a beat late: a head, not a ball (with the idle on, also toward the
      // opponent, during moves too: the approved build tests IDLE.on, not the move)
      const look = this.idleOn ? Math.max(-0.22, Math.min(0.22, (this.target[0] - URI_CM0[0]) / 500)) : 0;
      M.va +=
        (MN.facingK * (B.torso.a * MN.facing + M.vx * 0.004 + look - M.a) -
          2 * MN.facingZeta * Math.sqrt(MN.facingK) * M.va) *
        dt;
      M.a += M.va * dt;
    }
    // the cores shake in their cradles but never leave them
    const C = this.coreS;
    const CK = URI_KINETICS.core;
    C.v += (-CK.k * C.x - CK.c * C.v) * dt;
    C.x += C.v * dt;
    C.vy += (-CK.k * C.y - CK.c * C.vy) * dt;
    C.y += C.vy * dt;
    // impact
    if (this.cur && this.cur.impact) {
      const cur = this.cur;
      cur.impact = false;
      const nm = cur.name;
      // the blow stops on contact: striking arms lose their speed into the target; fists hit maximum compression
      const acting: UriSide[] = nm === 'slam' ? ['L', 'R'] : nm === 'cross' ? [cur.rear] : [cur.lead];
      for (const a of acting) {
        for (const j of ['s', 'e', 'w'] as const) L[`${j}${a}` as LinkKey].v *= 0.12;
        const c = L[`c${a}` as LinkKey];
        c.x = Math.min(c.x, 0.74);
        c.v = 0;
      }
      const hs = URI_KINETICS.hitstop[nm] * TU.hitstop;
      this.hitstop = hs;
      const d = cur.dir;
      if (nm === 'punch') {
        L.hx.v -= d * 16;
        LP[d > 0 ? 'r' : 'l'].v += 2.2;
        LP.sh.v += d * 14;
        C.v += d * 22;
      }
      if (nm === 'cross') {
        L.ta.v += d * 0.35;
        LP.sh.v += d * 30;
        C.v += d * 28;
      }
      if (nm === 'slam') {
        L.hy.v -= 28;
        LP.l.v += 3.4;
        LP.r.v += 3.4;
        LP.br.v += 4;
        C.vy += 70;
        C.v += (this.rand() - 0.5) * 26;
      }
      if (nm === 'upper') {
        L.hy.v -= 14;
        LP.vt.v += 3;
        C.vy -= 40;
      }
      LP.br.v += 2.5;
      this.pendingImpact = {
        move: nm,
        dir: d,
        lead: cur.lead,
        rear: cur.rear,
        hitstop: hs,
        shake: URI_KINETICS.shake[nm],
      };
    }
  }

  /** The fists' velocities (for the reaction terms), from the pose after the step (the oracle's `physicsOnly`). */
  private trackFists(h: number): void {
    const B = bodyTransforms(this.linkPose());
    for (const s of ['L', 'R'] as const) {
      const ua = uriPart(s === 'L' ? 'uaL' : 'uaR');
      const fa = uriPart(s === 'L' ? 'faL' : 'faR');
      const fi = uriPart(s === 'L' ? 'fistL' : 'fistR');
      const dome = s === 'L' ? B.domeL : B.domeR;
      const Tsh = compose(dome, about(ua.ja![0], ua.ja![1], s === 'L' ? this.L.sL.x : this.L.sR.x));
      const Tel = compose(Tsh, about(ua.jb![0], ua.jb![1], s === 'L' ? this.L.eL.x : this.L.eR.x));
      const Twr = compose(Tel, about(fa.jb![0], fa.jb![1], s === 'L' ? this.L.wL.x : this.L.wR.x));
      apply(Twr, fi.pgX, fi.pgY, this.tmp);
      const prev = this.prevFist[s];
      if (prev) this.fistVel[s] = [(this.tmp.x - prev[0]) / h, (this.tmp.y - prev[1]) / h];
      this.prevFist[s] = [this.tmp.x, this.tmp.y];
    }
  }

  /** Fold the whole kinetic state into a hash (determinism). */
  hash(h0: number): number {
    let h = h0 | 0;
    const buf = new Float64Array(1);
    const u = new Uint32Array(buf.buffer);
    const mix = (v: number): void => {
      buf[0] = v;
      h = Math.imul(h ^ u[0]!, 0x01000193);
      h = Math.imul(h ^ u[1]!, 0x01000193);
    };
    for (const k of LINK_KEYS) {
      mix(this.L[k].x);
      mix(this.L[k].v);
    }
    mix(this.t);
    mix(this.hitstop);
    mix(this.cur ? URI_MOVE_IDS[this.cur.name] * 100 + this.cur.ph : -1);
    for (const s of Object.values(this.loopS)) {
      mix(s.x);
      mix(s.v);
    }
    mix(this.coreS.x);
    mix(this.coreS.y);
    mix(this.moonS.x);
    mix(this.moonS.y);
    mix(this.moonS.a);
    mix(this.pyl.L.th);
    mix(this.pyl.R.th);
    mix(this.hp);
    const I = this.idle;
    mix(this.idleOn ? 1 : 0);
    mix(I.ref0);
    mix(I.nextRef);
    mix(I.clenchL);
    mix(I.clenchR);
    mix(I.nextClench);
    mix((I.slamDone ? 1 : 0) + (I.slam ? 2 : 0));
    return h >>> 0;
  }
}

const URI_MOVE_IDS: Record<UriMoveName, number> = { punch: 1, cross: 2, slam: 3, upper: 4 };
