import { CellFlag, pb, pg, pr, type RenderLayer, type StageLighting, type TitanDef } from '@/contracts';
import type { PlanetRig } from '@/titans';
import { buildLitRamps } from '@/titans/art/canvas';
import { BAY8, BodySkin, IdleClock, IdleRng, Pool, clampN, fcos, fsin, h2, ss } from '../fx/idle';
import type { Overlay } from '../fx/overlay';
import { DMath } from '@/contracts/dmath';
import { PlanetFrames } from './planetFrames';

/** acos to ~7e-5 rad (Abramowitz-Stegun 4.4.45), sqrt only: the per-cell angles of quakes, tsunamis and craters. */
function facos(x: number): number {
  const a = x < 0 ? -x : x;
  const r = Math.sqrt(1 - a) * (1.5707288 + a * (-0.2121144 + a * (0.074261 - 0.0187293 * a)));
  return x < 0 ? Math.PI - r : r;
}

/**
 * THE PLANET'S LIVING IDLE (idle handover: specs/planet.md, prototype `planet.src.html`; WJ: "truly feels like an angry
 * planet… love the ring of rubble"). A visual layer only: the moves, the spin physics, the moons' orbits, the Brace and the
 * ring's capture are untouched. WJ (2026-10-17): a 45 s day as in game, a 1 px impact jolt drawn only, no lensed stars, the
 * moons at game speed.
 *  - The world turns: 240 painted frames (planetFrames.ts, baked in a worker), stepped exactly as painted, phased from the
 *    world's own spin (and its Brace half-turn), slowing in the pull's anticipation.
 *  - Its surface lives: plate seams as faint scars; quakes that tear the moving plate's seam open in magma and shift the
 *    plate a whole pixel or two; tsunamis with a foam front, a dark trough and spray on the coasts; craters from what fell,
 *    hot, then rimmed and healing; a tidal bulge under each moon; the moons' shadows.
 *  - The gravity pull: the world stalls, gathers itself, then yanks: a third of the rubble ring falls in, rocks are dragged
 *    in from deep space and strike, the atmosphere whitens, the aurora and the halo flare, the moons lurch.
 *  - The ring of rubble: 150 rocks round the world, lit from the upper left, half behind the globe.
 * Presentation only (S19): stepped once per sim tick from that tick's inputs (recorded in the behaviour's update), private
 * seeded streams (events and rocks apart), drawn on the skin (map space, pristine face cells only: holes, cracks and exposed
 * strata keep their own drawing), on two rubble overlays and on the fx overlay. Every colour is a step along the Planet's own
 * lit ramps (spec §5 "colours (canon)").
 */

export interface PlanetIdleInput {
  /** The world's spin (rad/s), the Brace half-turn's rate, the cloud deck's spin, the drawn facing. */
  omega: number;
  turnRate: number;
  omegaAir: number;
  facing: 1 | -1;
  /** The idle may start new events (idle / intro, no move, no Guard, Draw, half-turn, failure or comet). */
  rest: boolean;
  ko: boolean;
  /** A Brace half-turn is swapping the faces: the face is not painted. */
  swapping: boolean;
  phase: number;
  ringTight: number;
  ringGlow: number;
  coreOut: number;
  /** World position of the body; the moons' world positions, whether behind the globe, alive, radius. */
  x: number;
  y: number;
  m0x: number;
  m0y: number;
  m0back: boolean;
  m0on: boolean;
  m0r: number;
  m1x: number;
  m1y: number;
  m1back: boolean;
  m1on: boolean;
  m1r: number;
}

export interface PlanetIdleMap {
  version: number;
  w: number;
  h: number;
  material: Uint8Array;
  integrity: Uint8Array;
  flags: Uint8Array;
  pixels: Uint32Array;
}

const F = PlanetFrames.F;
const RING = 16;
const TAU = Math.PI * 2;
/** The prototype's ring: tilted by the planet's axis, flattened, 150 rocks (more as the world breaks). */
const RUB_TILT = -0.4;
const RUB_FLAT = 0.26;
const RUBBLE = 300;
const RING_LOOSE = 2.05;
const RING_TIGHT = 1.3;
const PHASE_MOTES = [44, 44, 64, 72, 84];
const FIGHT_FLAGS = CellFlag.BURNING | CellFlag.CRACKED | CellFlag.CHARRED | CellFlag.GLOWING;
/** WJ 2026-10-18: the atmosphere ring drawn this many px thick (the matter keeps its 8), with the prototype's faint glow. */
const ATMO_KEEP = 4;
const ATMO_EM = 6;
/** WJ 2026-10-17: the 1 px impact jolt (drawing only). */
export const PLANET_JOLT = true;

interface Rock {
  a: number;
  rr: number;
  sp: number;
  size: number;
  tone: number;
  /** 0 ring, 1 falling, 2 gone, 3 sliding back in. */
  state: number;
  ft: number;
  fr: number;
  back: number;
  it: number;
}
interface Quake {
  t0: number;
  plate: number;
  ex: number;
  ey: number;
  ez: number;
  dx: number;
  dy: number;
}
interface Crater {
  vx: number;
  vy: number;
  vz: number;
  t0: number;
  r: number;
  /** Its map cell on frame `cfi` (drawFace finds it once per frame; −1: off the visible face). */
  cx: number;
  cy: number;
  cfi: number;
}
interface Inc {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t0: number;
  size: number;
  px: number;
  py: number;
}
interface Puff {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  /** 0 dust, 1 hot, 2 flash. */
  kind: number;
}

export class PlanetIdle {
  /** Per map cell: the idle's colour for the skin this step (0 = leave it), and its emissive. */
  readonly faceBuf: Uint32Array;
  readonly faceEm: Uint8Array;
  /** The cloud deck's lag behind the sim's phase (the stall), rad; the aurora's idle level; the pull's yank (0..1). */
  cloudLag = 0;
  aurora = 0;
  yank = 0;
  /** Render-only jolt of the body this step (whole px, world). */
  joltX = 0;
  /** Moon lurch (0..1) per moon: the drawn orbit shrinks by 7 %. */
  readonly lurch = new Float32Array(2);
  /** The skin must be repainted (a new frame or a live event). */
  dirty = true;

  private readonly W: number;
  private readonly H: number;
  private readonly ax: number;
  private readonly ay: number;
  private readonly R0: number;
  private readonly ids: PlanetRig['ids'];
  private readonly frames: PlanetFrames;
  /* face cells */
  private readonly cells: Int32Array;
  private readonly nc: number;
  private readonly cLon: Float32Array;
  private readonly cLat: Float32Array;
  private readonly cNz: Float32Array;
  private readonly cRim: Float32Array;
  private readonly cellOf: Int32Array;
  /** Per face cell at the current frame: surface vector, plate, plate margin. */
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly plate: Uint8Array;
  private readonly margin: Float32Array;
  private vecFi = -1;
  /** The atmosphere ring's cells and their calm colour (0 = hidden: the ring is drawn thinner), the atmosphere's ladder. */
  private readonly ringI: Int32Array;
  private readonly ringC: Uint32Array;
  private readonly atmoL: number[];
  /** The body's pixels as drawn (the thin, calm atmosphere), presented in place of the body layer. */
  private readonly bodySkin: BodySkin;
  private skinVer = -1;
  private skinYank = -1;
  /* colours */
  private readonly ladder = new Map<number, { L: number[]; k: number }>();
  private readonly magma: number[];
  private readonly foam: number[];
  private readonly vacant: number;
  private readonly rockR: number[];
  private readonly dustC: number;
  /* plates */
  private readonly plates: Float32Array;
  /* the clock, inputs, streams */
  readonly clock = new IdleClock();
  private readonly ring: PlanetIdleInput[];
  private readonly ringTick = new Int32Array(RING).fill(-1);
  private readonly lastIn: PlanetIdleInput;
  private readonly ev: IdleRng;
  private readonly rk: IdleRng;
  private readonly seed: number;
  /* state */
  private shift = 0;
  private fi = 0;
  private shownFi = -1;
  private idleW = 1;
  private idleV = 0;
  private pullOn = false;
  private pullT0 = 0;
  private pullFell = false;
  private nextPull = 9;
  private nextQuake = 5;
  private readonly quakes = new Pool<Quake>(6, () => ({
    t0: 0,
    plate: 0,
    ex: 0,
    ey: 0,
    ez: 0,
    dx: 1,
    dy: 0,
  }));
  private readonly craters: Crater[] = [];
  private readonly rocks: Rock[] = [];
  private readonly inc = new Pool<Inc>(32, () => ({
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    t0: 0,
    size: 1,
    px: 0,
    py: 0,
  }));
  private readonly puffs = new Pool<Puff>(160, () => ({
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    age: 0,
    life: 1,
    kind: 0,
  }));
  private jolt = 0;
  private joltDir = 1;
  private steps = 0;

  constructor(
    def: TitanDef,
    seed: number,
    lighting: StageLighting,
    map: { w: number; h: number; material: Uint8Array },
    rig: PlanetRig,
    anchor: { x: number; y: number },
    ramps: { magma: number[]; crust: number[] },
    idleSeed: number,
  ) {
    const W = (this.W = map.w);
    const H = (this.H = map.h);
    const N = W * H;
    this.ax = anchor.x;
    this.ay = anchor.y;
    this.R0 = rig.radius;
    this.ids = rig.ids;
    this.seed = idleSeed;
    this.ev = new IdleRng(idleSeed);
    this.rk = new IdleRng((idleSeed ^ 0x2b5e) >>> 0);
    this.faceBuf = new Uint32Array(N);
    this.faceEm = new Uint8Array(N);
    const I = rig.ids;
    // face cells: on the disc, not the air
    const list: number[] = [];
    const atmo: number[] = [];
    for (let i = 0; i < N; i++) {
      const m = map.material[i]!;
      if (!m) continue;
      if (m === I.atmosphere || m === I.cloud) {
        atmo.push(i);
        continue;
      }
      if (rig.nz[i]! > 0) list.push(i);
    }
    this.cells = Int32Array.from(list);
    const nc = (this.nc = list.length);
    this.cLon = new Float32Array(nc);
    this.cLat = new Float32Array(nc);
    this.cNz = new Float32Array(nc);
    this.cRim = new Float32Array(nc);
    this.cellOf = new Int32Array(N).fill(-1);
    const cx = rig.core.x + 0.5;
    const cy = rig.core.y + 0.5;
    for (let k = 0; k < nc; k++) {
      const i = list[k]!;
      const x = i % W;
      const y = (i - x) / W;
      this.cLon[k] = (rig.lon[i]! / 65535 - 0.5) * TAU;
      this.cLat[k] = (rig.lat[i]! / 127 - 0.5) * Math.PI;
      this.cNz[k] = rig.nz[i]! / 255;
      const dx = (x + 0.5 - cx) / this.R0;
      const dy = (y + 0.5 - cy) / this.R0;
      this.cRim[k] = Math.sqrt(dx * dx + dy * dy);
      this.cellOf[i] = k;
    }
    this.vx = new Float32Array(nc);
    this.vy = new Float32Array(nc);
    this.vz = new Float32Array(nc);
    this.plate = new Uint8Array(nc);
    this.rest = new Uint32Array(nc);
    this.seamK = new Uint8Array(nc);
    this.movedK = new Uint8Array(nc);
    this.margin = new Float32Array(nc);
    this.frames = PlanetFrames.of(def.id, seed, lighting, this.cells);

    // ladders: the lit ramps the painter used, each colour's place on its own material's ramp
    const lit = buildLitRamps(def.materials, lighting, 1);
    const lum = (c: number): number => 0.3 * pr(c) + 0.59 * pg(c) + 0.11 * pb(c);
    for (const m of [I.ocean, I.forest, I.desert, I.mountain, I.ice, I.atmosphere, I.cloud]) {
      const L = (lit[m] ?? []).map((c) => (c | 0xff000000) >>> 0).sort((a, b) => lum(a) - lum(b));
      L.forEach((c, k) => {
        if (!this.ladder.has(c)) this.ladder.set(c, { L, k });
      });
    }
    this.magma = ramps.magma.map((c) => (c | 0xff000000) >>> 0);
    const ocean = (lit[I.ocean] ?? []).map((c) => (c | 0xff000000) >>> 0).sort((a, b) => lum(a) - lum(b));
    const ice = (lit[I.ice] ?? []).map((c) => (c | 0xff000000) >>> 0).sort((a, b) => lum(a) - lum(b));
    const top = (a: number[], k: number): number => a[Math.max(0, a.length - 1 - k)] ?? 0xffffffff;
    this.foam = [top(ocean, 1), top(ocean, 0), top(ice, 0)];
    this.vacant = (ramps.crust[0]! | 0xff000000) >>> 0;
    const rockRamp = [...ramps.crust].map((c) => (c | 0xff000000) >>> 0).sort((a, b) => lum(a) - lum(b));
    this.rockR = rockRamp;
    this.dustC = rockRamp[Math.floor(rockRamp.length * 0.55)] ?? this.vacant;

    // the atmosphere as the prototype draws it (WJ 2026-10-18: "thinner, not so jittery"): the inner ATMO_KEEP px of the ring
    // in solid bands lit toward the key light (the painter's Rayleigh edge without its dither and noise), the rest hidden
    const atmoL = (lit[I.atmosphere] ?? [])
      .map((c) => (c | 0xff000000) >>> 0)
      .sort((a, b) => lum(a) - lum(b));
    const kx = lighting.dir[0] * 0.8;
    const ky = lighting.dir[1];
    const kh = DMath.hypot(kx, ky) || 1;
    const ringI: number[] = [];
    const ringC: number[] = [];
    for (const i of atmo) {
      const x = i % W;
      const y = (i - x) / W;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const out = (DMath.hypot(dx, dy) - this.R0) / ATMO_KEEP;
      ringI.push(i);
      if (out > 1) {
        ringC.push(0);
        continue;
      }
      const ang = DMath.atan2(dy, dx);
      const f = clampN(((DMath.cos(ang) * kx + DMath.sin(ang) * ky) / kh) * 0.5 + 0.5, 0, 1);
      const v = (0.25 + 0.75 * f * f) * (1 - 0.55 * clampN(out, 0, 1));
      const k = clampN(
        Math.round(v * (atmoL.length - 1)) + (map.material[i] === I.cloud ? 1 : 0),
        0,
        atmoL.length - 1,
      );
      ringC.push(atmoL[k] ?? 0);
    }
    this.ringI = Int32Array.from(ringI);
    this.ringC = Uint32Array.from(ringC);
    this.atmoL = atmoL;
    this.bodySkin = new BodySkin(W, H);

    // the plates: seven seeds on the sphere (from the events stream, as the prototype)
    this.plates = new Float32Array(21);
    const mk = (): PlanetIdleInput => ({
      omega: 0,
      turnRate: 0,
      omegaAir: 0,
      facing: 1,
      rest: true,
      ko: false,
      swapping: false,
      phase: 0,
      ringTight: 0,
      ringGlow: 0,
      coreOut: 0,
      x: 0,
      y: 0,
      m0x: 0,
      m0y: 0,
      m0back: false,
      m0on: false,
      m0r: 12,
      m1x: 0,
      m1y: 0,
      m1back: false,
      m1on: false,
      m1r: 12,
    });
    this.ring = Array.from({ length: RING }, mk);
    this.lastIn = mk();
    for (let k = 0; k < RUBBLE; k++)
      this.rocks.push({ a: 0, rr: 1, sp: 0, size: 1, tone: 0, state: 0, ft: 0, fr: 0, back: 0, it: 0 });
    this.reset();
  }

  reset(): void {
    this.clock.reset();
    this.ev.reseed(this.seed);
    this.rk.reseed((this.seed ^ 0x2b5e) >>> 0);
    this.ringTick.fill(-1);
    for (let p = 0; p < 7; p++) {
      const lo = this.ev.next() * TAU;
      const la = DMath.asin(this.ev.next() * 2 - 1) * 0.85;
      const cl = fcos(la);
      this.plates[p * 3] = cl * fsin(lo);
      this.plates[p * 3 + 1] = fsin(la);
      this.plates[p * 3 + 2] = cl * fcos(lo);
    }
    for (const r of this.rocks) this.newRock(r);
    this.shift = 0;
    this.fi = 0;
    this.vecFi = -1;
    this.idleW = 1;
    this.idleV = 0;
    this.pullOn = false;
    this.yank = 0;
    this.nextPull = 9;
    this.nextQuake = 5;
    this.quakes.clear();
    this.craters.length = 0;
    this.inc.clear();
    this.puffs.clear();
    this.jolt = 0;
    this.steps = 0;
    this.lurch.fill(0);
    this.cloudLag = 0;
    this.dirty = true;
  }

  private newRock(r: Rock): void {
    const R = this.rk;
    r.a = R.next() * TAU;
    r.rr = 1.32 + R.next() * 0.42;
    r.sp = 0.16 + R.next() * 0.08;
    r.size = R.next() < 0.55 ? 2 : R.next() < 0.2 ? 3 : 1;
    r.tone = R.next();
    r.state = 0;
  }

  record(tick: number, inp: PlanetIdleInput): void {
    if (this.clock.last < 0) this.clock.last = tick - 1;
    const k = tick & (RING - 1);
    Object.assign(this.ring[k]!, inp);
    this.ringTick[k] = tick;
    Object.assign(this.lastIn, inp);
  }

  private inputAt(tick: number): PlanetIdleInput {
    const k = tick & (RING - 1);
    return this.ringTick[k] === tick ? this.ring[k]! : this.lastIn;
  }

  /**
   * Step to `tick`. The face is redrawn (`draw`) on even steps only, 30 times a second (a tsunami front moves ~0.4 px a step,
   * so it still advances a pixel at a time), and within a catch-up batch only at its last even step: the face shown is
   * always the state of the last even step, at any frame rate. Returns whether the face was redrawn.
   */
  advance(tick: number, draw: () => void): boolean {
    const n = this.clock.due(tick);
    const last = n - ((this.steps + n) & 1);
    let drew = false;
    for (let i = 0; i < n; i++) {
      this.step(this.inputAt(tick - n + 1 + i));
      if (i + 1 === last) {
        draw();
        drew = true;
      }
    }
    return drew;
  }

  /** The surface vector of face cell k at longitude shift phi. */
  private vecOf(k: number, phi: number, out: Float32Array): void {
    const L = this.cLon[k]! + phi;
    const la = this.cLat[k]!;
    const cl = fcos(la);
    out[0] = cl * fsin(L);
    out[1] = fsin(la);
    out[2] = cl * fcos(L);
  }
  private readonly tv = new Float32Array(3);

  private plateOf(x: number, y: number, z: number): number {
    // a little warp so seams wander like real faults
    const a = fsin(x * 5.1 + y * 3.3) * 0.08;
    const b = fsin(z * 4.7 - y * 2.9) * 0.08;
    const wx = x + a;
    const wy = y + b;
    const wz = z - a * 0.5;
    let b1 = -9;
    let b2 = -9;
    let p1 = 0;
    const P = this.plates;
    for (let p = 0; p < 7; p++) {
      const d = wx * P[p * 3]! + wy * P[p * 3 + 1]! + wz * P[p * 3 + 2]!;
      if (d > b1) {
        b2 = b1;
        b1 = d;
        p1 = p;
      } else if (d > b2) b2 = d;
    }
    this.lastMargin = b1 - b2;
    return p1;
  }
  private lastMargin = 0;
  /** drawFace's per-event cos thresholds (craters; quakes: ring far, ring near, magma reach). */
  private readonly cosCr = new Float32Array(20);
  private readonly cosQ = new Float32Array(18);
  /** drawFace's cache of the face at rest for frame `restFi` (per face cell), its seam cells; the bulge bands per moon. */
  private rest!: Uint32Array;
  private seamK!: Uint8Array;
  private movedK!: Uint8Array;
  private restFi = -1;
  private readonly bulge = new Float32Array(4);
  /** drawFace's quakes as numbers (centre x, y, z, plate, age), 6 at most. */
  private readonly qd = new Float64Array(30);

  /** Surface vectors, plates and margins of every face cell at the frame shown (only when the frame changes). */
  private vectors(fi = this.fi): void {
    if (this.vecFi === fi) return;
    this.vecFi = fi;
    const phi = (fi / F) * TAU;
    const v = this.tv;
    for (let k = 0; k < this.nc; k++) {
      this.vecOf(k, phi, v);
      this.vx[k] = v[0]!;
      this.vy[k] = v[1]!;
      this.vz[k] = v[2]!;
      this.plate[k] = this.plateOf(v[0]!, v[1]!, v[2]!);
      this.margin[k] = this.lastMargin;
    }
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  one fixed step
   * ---------------------------------------------------------------------------------------------- */

  private step(inp: PlanetIdleInput): void {
    const dt = IdleClock.DT;
    const C = this.clock;
    C.t += dt;
    const t = C.t;
    const R0 = this.R0;
    // the idle's weight: a critically damped ease (ω 4, the scale spec), 0 at once on a KO
    const target = inp.rest && !inp.ko ? 1 : 0;
    if (inp.ko) {
      this.idleW = 0;
      this.idleV = 0;
    } else {
      const w = 4;
      this.idleV += (w * w * (target - this.idleW) - 2 * w * this.idleV) * dt;
      this.idleW = clampN(this.idleW + this.idleV * dt, 0, 1);
    }
    const free = this.idleW > 0.9;

    // ---- the gravity pull: anticipation (all stalls), the yank, the rubble falls ----
    if (free && t > this.nextPull) {
      if (!this.pullOn || t - this.pullT0 >= 3.4) {
        this.pullOn = true;
        this.pullT0 = t;
        this.pullFell = false;
      }
      this.nextPull = t + 10 + this.ev.next() * 5;
    }
    let stall = 0;
    let yank = 0;
    if (this.pullOn) {
      const u = t - this.pullT0;
      stall = u < 0.9 ? ss(0, 0.9, u) : u < 1.15 ? 1 - ss(0.9, 1.15, u) : 0;
      yank = u > 0.9 && u < 1.6 ? fsin(((u - 0.9) / 0.7) * Math.PI) : 0;
      if (!this.pullFell && u > 0.9) {
        this.pullFell = true;
        // ring debris falls in; more is dragged from deep space; the moons lurch
        for (const r of this.rocks)
          if (r.state === 0 && this.rk.next() < 0.35) {
            r.state = 1;
            r.ft = t;
            r.fr = r.rr;
          }
        for (let k = 0; k < 26; k++) {
          const q = this.inc.alloc();
          if (!q) break;
          const a = this.rk.next() * TAU;
          q.x = fcos(a) * 210;
          q.y = fsin(a) * 150;
          q.vx = 0;
          q.vy = 0;
          q.t0 = t + this.rk.next() * 0.6;
          q.size = this.rk.next() < 0.45 ? 2 : 1;
          q.px = q.x;
          q.py = q.y;
        }
        this.lurch[0] = 1;
        this.lurch[1] = 1;
      }
      if (u > 3.4) this.pullOn = false;
    }
    this.yank = yank;
    if (free && t > this.nextQuake) {
      this.quake(-1);
      this.nextQuake = t + 6 + this.ev.next() * 6;
    }

    // ---- the world turns: the painted frames, phased from its own spin (map space: the drawn facing's sense) ----
    const rf = inp.facing;
    const rate = (inp.omega + inp.turnRate) * rf;
    this.shift -= rate * dt * (1 - 0.85 * stall);
    this.cloudLag += 0.9 * stall * (inp.omegaAir + inp.turnRate) * rf * dt;
    const fi = ((Math.round((this.shift / TAU) * F) % F) + F) % F;
    if (fi !== this.fi) {
      this.fi = fi;
      this.dirty = true;
    }
    this.frames.aim(fi, -Math.sign(rate) || -1);

    // ---- the ring, the rocks that fell and come back ----
    for (const r of this.rocks) {
      if (r.state === 0) r.a += dt * r.sp * (1 - stall);
      else if (r.state === 1) {
        r.a += dt * 1.4;
        if ((t - r.ft) / 0.75 >= 1) {
          this.impact(r.size, inp);
          r.state = 2;
          r.back = t + 4 + this.rk.next() * 6;
        }
      } else if (r.state === 2) {
        if (t > r.back) {
          this.newRock(r);
          r.state = 3;
          r.it = t;
        }
      } else if (r.state === 3) {
        r.a += dt * r.sp * 2;
        if ((t - r.it) / 3 >= 1) r.state = 0;
      }
    }
    // ---- rocks dragged in from deep space ----
    for (let i = this.inc.n - 1; i >= 0; i--) {
      const q = this.inc.items[i]!;
      if (t < q.t0) continue;
      const dx = -q.x;
      const dy = -q.y;
      const r = Math.sqrt(dx * dx + dy * dy) || 1;
      const g = 52000 / (r * r + 400);
      q.vx += (dx / r) * g * dt + (-dy / r) * 6 * dt;
      q.vy += (dy / r) * g * dt + (dx / r) * 6 * dt;
      q.px = q.x;
      q.py = q.y;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      if (r < R0 - 2) {
        const size = q.size;
        this.inc.kill(i);
        this.impact(size, inp);
      }
    }
    for (let i = this.puffs.n - 1; i >= 0; i--) {
      const p = this.puffs.items[i]!;
      p.age += dt;
      if (p.age > p.life) {
        this.puffs.kill(i);
        continue;
      }
      if (p.kind === 2) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 6 * dt;
    }
    for (let i = this.quakes.n - 1; i >= 0; i--) if (t - this.quakes.items[i]!.t0 > 7) this.quakes.kill(i);
    // dust thrown up along a moving plate's seam
    for (let q = 0; q < this.quakes.n; q++) {
      const qk = this.quakes.items[q]!;
      const u = t - qk.t0;
      if (u <= 0.35 || u >= 2.4 || this.ev.next() >= 0.66) continue;
      this.vectors();
      const k = Math.floor(this.ev.next() * this.nc);
      if (this.plate[k] !== qk.plate || this.margin[k]! > 0.05) continue;
      const p = this.puffs.alloc();
      if (!p) continue;
      const i = this.cells[k]!;
      const mx = i % this.W;
      p.x = (mx + 0.5 - this.ax) * inp.facing;
      p.y = (i - mx) / this.W + 0.5 - this.ay;
      p.vx = (this.ev.next() - 0.5) * 4;
      p.vy = -2 - this.ev.next() * 4;
      p.age = 0;
      p.life = 1 + this.ev.next();
      p.kind = 0;
    }
    while (this.craters.length && t - this.craters[0]!.t0 > 14) this.craters.shift();
    for (let m = 0; m < 2; m++) this.lurch[m] = Math.max(0, this.lurch[m]! - dt * 1.6);
    this.jolt = Math.max(0, this.jolt - dt);
    this.joltX = PLANET_JOLT && this.jolt > 0.12 ? this.joltDir : 0;
    // the aurora breathes, and flares on the pull
    this.aurora = (0.55 + 0.45 * fsin(t * 0.7) + 0.8 * yank) * this.idleW;
    // live events repaint every tick
    this.steps++;
  }

  private quake(k0: number): void {
    const Q = this.quakes.alloc();
    if (!Q) return;
    this.vectors();
    let k = k0;
    if (k < 0) {
      // a seam point on the visible face
      for (let tries = 0; tries < 400; tries++) {
        const c = Math.floor(this.ev.next() * this.nc);
        if (this.cRim[c]! > 0.85) continue;
        if (this.margin[c]! < 0.03) {
          k = c;
          break;
        }
      }
      if (k < 0) k = Math.floor(this.ev.next() * this.nc);
    }
    Q.t0 = this.clock.t;
    Q.ex = this.vx[k]!;
    Q.ey = this.vy[k]!;
    Q.ez = this.vz[k]!;
    Q.plate = this.plate[k]!;
    const ang = this.ev.next() * TAU;
    Q.dx = Math.round(fcos(ang)) || 1;
    Q.dy = Math.round(fsin(ang));
  }

  private liveQuakes(): number {
    let n = 0;
    for (let q = 0; q < this.quakes.n; q++) if (this.clock.t - this.quakes.items[q]!.t0 < 4.2) n++;
    return n;
  }

  /** A rock struck the world: a crater where it lands (on the visible face), a jolt, debris and a flash, sometimes a quake. */
  private impact(size: number, inp: PlanetIdleInput): void {
    const k = Math.floor(this.rk.next() * this.nc);
    if (this.cRim[k]! > 0.9) return;
    this.vectors();
    const t = this.clock.t;
    this.craters.push({
      vx: this.vx[k]!,
      vy: this.vy[k]!,
      vz: this.vz[k]!,
      t0: t,
      r: 1.5 + this.rk.next() * 2.2 + (size > 1 ? 1 : 0),
      cx: 0,
      cy: 0,
      cfi: -1,
    });
    if (this.craters.length > 18) this.craters.shift();
    const i = this.cells[k]!;
    const mx = i % this.W;
    const my = (i - mx) / this.W;
    const wx = (mx + 0.5 - this.ax) * inp.facing;
    const wy = my + 0.5 - this.ay;
    if (this.jolt <= 0) {
      this.jolt = 0.22;
      this.joltDir = Math.sign(wx) || 1;
    }
    for (let q = 0; q < 8; q++) {
      const p = this.puffs.alloc();
      if (!p) break;
      const a = this.rk.next() * TAU;
      const s = 3 + this.rk.next() * 6;
      p.x = wx;
      p.y = wy;
      p.vx = fcos(a) * s;
      p.vy = fsin(a) * s - 2;
      p.age = 0;
      p.life = 0.5 + this.rk.next() * 0.6;
      p.kind = q < 2 ? 1 : 0;
    }
    const fl = this.puffs.alloc();
    if (fl) {
      fl.x = wx;
      fl.y = wy;
      fl.age = 0;
      fl.life = 0.25;
      fl.kind = 2;
    }
    // a strike sometimes sets off a quake, three at most at once (a pull lands ~80 rocks: more read as noise)
    if (this.ev.next() < 0.18 && this.liveQuakes() < 3) this.quake(k);
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  colours: steps along the cell's own ladder
   * ---------------------------------------------------------------------------------------------- */

  private stepC(c: number, k: number): number {
    const e = this.ladder.get(c >>> 0);
    if (!e) return c;
    return e.L[clampN(e.k + k, 0, e.L.length - 1)]!;
  }

  private magmaAt(v: number, x: number, y: number): number {
    const M = this.magma;
    return M[clampN(Math.floor(v * (M.length - 1) + BAY8[((y & 7) << 3) | (x & 7)]!), 0, M.length - 1)]!;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  drawing: the face (into faceBuf, for the behaviour's skin), the rubble, the fx
   * ---------------------------------------------------------------------------------------------- */

  /**
   * The face this step into `faceBuf` / `faceEm` (0 = leave the cell to the skin's own drawing): the frame, the living
   * surface, the shifted plate, the moons' shadows, the atmosphere's whitening. Pristine cells only (`expo` = the behaviour's
   * exposed strata).
   */
  drawFace(map: PlanetIdleMap, expo: Uint8Array): void {
    this.dirty = false;
    const buf = this.faceBuf;
    const em = this.faceEm;
    buf.fill(0);
    em.fill(0);
    const inp = this.inputAt(this.clock.last);
    if (inp.swapping) return;
    const frames = this.frames;
    // the frame shown: this one if baked, else the last shown (the face holds), else none (the body's painted face)
    let fi = this.fi;
    if (!frames.have[fi]) fi = this.shownFi >= 0 && frames.have[this.shownFi] ? this.shownFi : -1;
    if (fi < 0) return;
    this.shownFi = fi;
    this.vectors(fi);
    const t = this.clock.t;
    const W = this.W;
    const nc = this.nc;
    const mat = map.material;
    const integ = map.integrity;
    const flags = map.flags;
    const I = this.ids;
    const base = fi * nc;
    const col = frames.col;
    const cls = frames.cls;
    const w = this.idleW;
    const R0 = this.R0;
    const pristine = (i: number): boolean =>
      mat[i] !== 0 && expo[i] === 0 && (flags[i]! & FIGHT_FLAGS) === 0 && integ[i] === 255;
    // cos thresholds per event, so a cell takes the angle (facos) only inside an event's band: a crater's disc; a quake's
    // tsunami front ring (front −0.08 … +0.03 rad) and, on its own plate's seams, the magma cap (reach)
    const cr = this.craters;
    const Q = this.quakes;
    const cCr = this.cosCr;
    for (let q = 0; q < cr.length; q++) cCr[q] = fcos(Math.min(Math.PI, cr[q]!.r / R0));
    const cFar = this.cosQ;
    // the face at rest for this frame (the frame's colours with the plates' faint scars), built once per frame shown
    const rest = this.rest;
    const seamK = this.seamK;
    if (this.restFi !== fi) {
      this.restFi = fi;
      for (let k = 0; k < nc; k++) {
        const seam = this.margin[k]! < 0.018 + (1 - this.cNz[k]!) * 0.01;
        seamK[k] = seam ? 1 : 0;
        const c = col[base + k]!;
        rest[k] = seam && cls[base + k] !== I.ice ? this.stepC(c, -1) : c;
      }
    }
    // the tidal bulge's crest: a band of the face's x (sx, radii, drawn facing) per moon; lo > hi = none
    const bulge = this.bulge;
    for (let m = 0; m < 2; m++) {
      bulge[m * 2] = 1;
      bulge[m * 2 + 1] = -1;
      if (!(m === 0 ? inp.m0on : inp.m1on)) continue;
      const mx = ((m === 0 ? inp.m0x : inp.m1x) - inp.x) / 120;
      const mz = (m === 0 ? inp.m0back : inp.m1back) ? -0.6 : 0.6;
      const a = mx / (Math.sqrt(mx * mx + mz * mz) || 1);
      if (Math.abs(a) < 1e-6) continue;
      const target = 0.62 * Math.sign(mx || 1) * Math.abs(a);
      const s0 = (target - 0.03) / a;
      const s1 = (target + 0.03) / a;
      bulge[m * 2] = Math.min(s0, s1);
      bulge[m * 2 + 1] = Math.max(s0, s1);
    }
    const anyBulge = bulge[0]! <= bulge[1]! || bulge[2]! <= bulge[3]!;
    const ocean = I.ocean;
    const movedK = this.movedK;
    // the per-cell loop reads locals only (typed arrays and the quakes' numbers): it visits every face cell every tick
    const cells = this.cells;
    const VX = this.vx;
    const VY = this.vy;
    const VZ = this.vz;
    const PL = this.plate;
    const RIM = this.cRim;
    // only quakes still drawing anything: the tsunami is gone by front 1 (3.85 s), the seam's magma by 4.2 s
    let nq = 0;
    const qd = this.qd;
    for (let j = 0; j < Q.n; j++) {
      const qk = Q.items[j]!;
      const u = t - qk.t0;
      if (u >= 4.2) continue;
      const q = nq++;
      const front = u * 0.26;
      cFar[q * 3] = fcos(Math.min(Math.PI, front + 0.03));
      cFar[q * 3 + 1] = fcos(Math.max(0, front - 0.08));
      cFar[q * 3 + 2] = fcos(Math.min(0.75, u * 0.9));
      qd[q * 5] = qk.ex;
      qd[q * 5 + 1] = qk.ey;
      qd[q * 5 + 2] = qk.ez;
      qd[q * 5 + 3] = qk.plate;
      qd[q * 5 + 4] = u;
    }
    for (let k = 0; k < nc; k++) {
      const i = cells[k]!;
      if (mat[i] === 0 || expo[i] !== 0 || (flags[i]! & FIGHT_FLAGS) !== 0 || integ[i] !== 255) continue;
      let c = rest[k]!;
      const cl = cls[base + k]!;
      movedK[k] = 0;
      // the quiet face: no quake and no bulge can reach this cell
      if (nq === 0 && !(anyBulge && cl === ocean)) {
        buf[i] = c;
        continue;
      }
      const x = i % W;
      const y = (i - x) / W;
      const bay = BAY8[((y & 7) << 3) | (x & 7)]!;
      const show = bay < w || w >= 0.999;
      const vx = VX[k]!;
      const vy = VY[k]!;
      const vz = VZ[k]!;
      const p = PL[k]!;
      const seam = seamK[k] === 1;
      let e = 0;
      let moved = false;
      let hot = false;
      for (let q = 0; q < nq; q++) {
        const o = q * 5;
        const u = qd[o + 4]!;
        const mine = p === qd[o + 3];
        // the window the shifted plate is redrawn in (below): outside it, nothing is vacated
        if (mine && u > 0.35 && u < 2.4 && RIM[k]! < 0.95) moved = true;
        const dot = vx * qd[o]! + vy * qd[o + 1]! + vz * qd[o + 2]!;
        const magma = mine && seam && show && u > 0.15 && u < 4.2;
        const inRing = dot >= cFar[q * 3]! && dot <= cFar[q * 3 + 1]!;
        if (!inRing && !(magma && dot > cFar[q * 3 + 2]!)) continue;
        const d = facos(clampN(dot, -1, 1));
        {
          const reach = Math.min(0.75, u * 0.9);
          if (magma && d < reach) {
            const heat = (1 - ss(1.2, 4.2, u)) * (1 - d / 0.8);
            c = this.magmaAt(0.25 + 0.7 * heat + 0.08 * fsin(t * 9 + k), x, y);
            if (heat > 0.4) e = Math.max(e, Math.min(255, 255 * 0.4 * heat));
            hot = true;
          }
        }
        const front = u * 0.26;
        if (!show) continue;
        if (cl === I.ocean && u < 7) {
          // the tsunami: a foam front, a dark trough behind
          const f = d - front;
          const amp = 1 - ss(0.25, 1, front);
          if (amp > 0.02) {
            if (f > -0.03 && f < 0.01 && bay < amp)
              c = this.foam[clampN(Math.floor((1 - Math.abs(f + 0.01) / 0.02) * 3 * amp + bay - 0.5), 0, 2)]!;
            else if (f < -0.03 && f > -0.08 && bay < amp) c = this.stepC(c, -1);
          }
        } else if (cl !== I.ice && cl !== I.ocean && u < 7 && front < 0.9 && Math.abs(d - front) < 0.03) {
          // the coast: where the front meets land, spray
          const kr = this.cellOf[i + 1] ?? -1;
          const kl = this.cellOf[i - 1] ?? -1;
          if ((kr >= 0 && cls[base + kr] === I.ocean) || (kl >= 0 && cls[base + kl] === I.ocean)) {
            c = this.foam[2]!;
            e = Math.max(e, 50);
          }
        }
      }
      if (moved && !hot) {
        // the plate has moved off: the gap it leaves (an overlay cannot remove the body's pixels: the darkest crust)
        buf[i] = this.vacant;
        movedK[k] = 1;
        continue;
      }
      // the tidal bulge: a crest of light on the oceans under each moon
      if (anyBulge && cl === ocean) {
        const sx = ((x + 0.5 - this.ax) / R0) * inp.facing;
        for (let m = 0; m < 2; m++)
          if (sx > bulge[m * 2]! && sx < bulge[m * 2 + 1]! && h2(k, fi) < 0.5 + this.lurch[m]! * 0.5)
            c = this.stepC(c, 1);
      }
      buf[i] = c;
      em[i] = e;
    }
    // craters from what fell: hot, then a dark rim and a tinted floor, healing into new crust. Each is a small disc: its centre
    // cell is found once per frame shown, and only its box is visited
    for (let q = 0; q < cr.length; q++) {
      const C = cr[q]!;
      if (C.cfi !== fi) {
        C.cfi = fi;
        let best = cCr[q]!;
        let bk = -1;
        for (let k = 0; k < nc; k++) {
          const dot = this.vx[k]! * C.vx + this.vy[k]! * C.vy + this.vz[k]! * C.vz;
          if (dot > best) {
            best = dot;
            bk = k;
          }
        }
        if (bk < 0) C.cx = -1;
        else {
          const i = this.cells[bk]!;
          C.cx = i % W;
          C.cy = (i - C.cx) / W;
        }
      }
      if (C.cx < 0) continue;
      const age = t - C.t0;
      const heal = ss(2, 14, age);
      const h = 1 - ss(0, 2.5, age);
      const rr = Math.ceil(C.r / Math.max(0.2, this.cNz[this.cellOf[C.cy * W + C.cx]!] ?? 1)) + 1;
      for (let y = C.cy - rr; y <= C.cy + rr; y++)
        for (let x = C.cx - rr; x <= C.cx + rr; x++) {
          if (x < 0 || y < 0 || x >= W || y >= this.H) continue;
          const i = y * W + x;
          const k = this.cellOf[i]!;
          if (k < 0 || buf[i] === 0 || movedK[k] === 1) continue;
          if (!(BAY8[((y & 7) << 3) | (x & 7)]! < w || w >= 0.999)) continue;
          const dot = this.vx[k]! * C.vx + this.vy[k]! * C.vy + this.vz[k]! * C.vz;
          if (dot <= cCr[q]!) continue;
          const d = facos(clampN(dot, -1, 1)) * R0;
          if (d >= C.r) continue;
          if (h > 0.05) {
            buf[i] = this.magmaAt(h * 0.9, x, y);
            if (h > 0.3) em[i] = Math.max(em[i]!, Math.min(255, 255 * 0.3 * h));
          } else if (d > C.r - 1.2) buf[i] = this.stepC(buf[i]!, -Math.round(2 * (1 - heal)));
          else buf[i] = this.stepC(buf[i]!, -Math.round(1 - heal));
        }
    }
    // the plate that moved: drawn again a whole pixel or two over, with a snap and a settle
    for (let q = 0; q < Q.n; q++) {
      const qk = Q.items[q]!;
      const u = t - qk.t0;
      if (u <= 0.35 || u >= 2.4) continue;
      const amt = u < 0.42 ? 2 : 1;
      // map space: the drawn facing mirrors x
      const ddx = qk.dx * amt * inp.facing;
      const ddy = qk.dy * amt;
      for (let k = 0; k < nc; k++) {
        if (this.plate[k] !== qk.plate || this.cRim[k]! > 0.97) continue;
        const i = this.cells[k]!;
        if (!pristine(i)) continue;
        const j = i + ddy * W + ddx;
        if (j < 0 || j >= buf.length || this.cellOf[j]! < 0 || !pristine(j)) continue;
        buf[j] = col[base + k]!;
      }
    }
    // the moons' shadows on the face (the light comes from the upper left)
    for (let m = 0; m < 2; m++) {
      const on = m === 0 ? inp.m0on : inp.m1on;
      const back = m === 0 ? inp.m0back : inp.m1back;
      if (!on || back) continue;
      const sxw = (m === 0 ? inp.m0x : inp.m1x) + 10 - inp.x;
      const syw = (m === 0 ? inp.m0y : inp.m1y) + 10 - inp.y;
      const rr = (m === 0 ? inp.m0r : inp.m1r) * 0.75;
      const smx = this.ax + sxw * inp.facing;
      const smy = this.ay + syw;
      for (let y = Math.floor(smy - rr); y <= smy + rr; y++)
        for (let x = Math.floor(smx - rr); x <= smx + rr; x++) {
          if (x < 0 || y < 0 || x >= W || y >= this.H) continue;
          const i = y * W + x;
          if (this.cellOf[i]! < 0 || !pristine(i)) continue;
          const ex = x + 0.5 - smx;
          const ey = y + 0.5 - smy;
          const d = Math.sqrt(ex * ex + ey * ey) / rr;
          if (d > 1 || BAY8[((y & 7) << 3) | (x & 7)]! < (d - 0.6) * 2.5) continue;
          const c = buf[i] || map.pixels[i]!;
          buf[i] = this.stepC(c, -2);
        }
    }
  }

  /**
   * Present the body as drawn in place of the body layer: the live map (damage, heat and all) with the atmosphere ring
   * redrawn thin and calm, whitening on the pull's yank. Rebuilt only when the map or the yank's step changes. Cells the
   * fight has changed keep their own drawing; air the fight has stripped stays gone.
   */
  presentBody(map: PlanetIdleMap & { emissive: Uint8Array }, body: RenderLayer): void {
    const yq = this.yank > 0.02 ? 1 + Math.round(this.yank * 4) : 0;
    const changed = map.version !== this.skinVer || yq !== this.skinYank;
    if (changed) {
      this.skinVer = map.version;
      this.skinYank = yq;
      const S = this.bodySkin;
      S.copyFrom(map.pixels, map.emissive);
      const px = S.px;
      const em = S.emis;
      const L = this.atmoL;
      const top = L.length - 1;
      // the pull whitens the whole ring a step or two at once (the prototype lerps it toward white: no dither)
      const lift = this.yank > 0.6 ? 2 : this.yank > 0.2 ? 1 : 0;
      for (let n = 0; n < this.ringI.length; n++) {
        const i = this.ringI[n]!;
        if (map.material[i] === 0) continue;
        const c = this.ringC[n]!;
        if (c === 0) {
          px[i] = 0;
          em[i] = 0;
          continue;
        }
        if (map.integrity[i] !== 255 || (map.flags[i]! & FIGHT_FLAGS) !== 0) continue;
        px[i] = lift > 0 ? (L[Math.min(top, L.indexOf(c) + lift)] ?? c) : c;
        em[i] = ATMO_EM + Math.round(30 * this.yank);
      }
    }
    this.bodySkin.present(body, changed);
  }

  /** The ring of rubble (back half behind the globe, front half over it), the rocks dragged in, the dust, the flashes. */
  drawRubble(back: Overlay, front: Overlay): void {
    const inp = this.inputAt(this.clock.last);
    const t = this.clock.t;
    const R0 = this.R0;
    const rf = inp.facing;
    const c = fcos(RUB_TILT);
    const s = fsin(RUB_TILT);
    const n = Math.min(RUBBLE, Math.round((150 * (PHASE_MOTES[inp.phase] ?? 44)) / 44));
    const vis = 1 - inp.coreOut;
    const tight = inp.ringTight;
    const L = this.rockR;
    const glowUp = inp.ringGlow > 0.3 ? 1 : 0;
    for (let k = 0; k < n; k++) {
      const r = this.rocks[k]!;
      if (r.state === 2) continue;
      if (vis < 1 && ((k * 7) % 16) / 16 > vis) continue;
      let rr = r.rr;
      if (r.state === 1) {
        const u = (t - r.ft) / 0.75;
        rr = r.fr - (r.fr - 0.9) * u * u;
      } else if (r.state === 3) {
        const u = (t - r.it) / 3;
        rr = r.rr + (3.2 - r.rr) * (1 - ss(0, 1, u));
      }
      // the game's Draw and commitment pull it in (the ring's semantics), on the prototype's geometry
      rr += ((RING_TIGHT * rr) / RING_LOOSE - rr) * tight;
      const ex = fcos(r.a) * R0 * rr;
      const ey = fsin(r.a) * R0 * rr * RUB_FLAT;
      const x = Math.round(inp.x + (ex * c - ey * s) * rf);
      const y = Math.round(inp.y + ex * s + ey * c);
      const ov = fsin(r.a) < 0 ? back : front;
      // lit from the upper left like everything else: a bright corner, a dark one
      // the upper half of the crust ramp (WJ 2026-10-18: "properly visible" against the stages)
      const mid = clampN(L.length - 3 + Math.round(r.tone * 1.5) + glowUp, 0, L.length - 1);
      const hi = L[clampN(mid + 1, 0, L.length - 1)]!;
      const md = L[mid]!;
      const lo = L[clampN(mid - 2, 0, L.length - 1)]!;
      if (r.size === 1) ov.set(x, y, md);
      else
        for (let yy = 0; yy < r.size; yy++)
          for (let xx = 0; xx < r.size; xx++) {
            if (r.size === 3 && (xx + yy === 0 || xx + yy === 4)) continue;
            ov.set(
              x + xx,
              y + yy,
              xx + yy === 0 || (r.size === 3 && xx + yy === 1) ? hi : xx + yy >= r.size ? lo : md,
            );
          }
    }
    // rocks dragged in from deep space: a cooling streak behind each (never over the face)
    const M = this.magma;
    for (let i = 0; i < this.inc.n; i++) {
      const q = this.inc.items[i]!;
      if (t < q.t0) continue;
      for (let k = 0; k < 6; k++) {
        const lx = q.x - (q.x - q.px) * k * 0.7;
        const ly = q.y - (q.y - q.py) * k * 0.7;
        if (lx * lx + ly * ly < R0 * R0) continue;
        const x = Math.round(inp.x + lx * rf);
        const y = Math.round(inp.y + ly);
        const cc = M[clampN(M.length - 1 - k, 0, M.length - 1)]!;
        front.set(x, y, cc, k === 0 ? 200 : 0);
        if (q.size > 1 && k < 2) {
          front.set(x + 1, y, cc);
          front.set(x, y + 1, cc);
        }
      }
    }
    // debris puffs, the impact flashes
    for (let i = 0; i < this.puffs.n; i++) {
      const p = this.puffs.items[i]!;
      const x = Math.round(inp.x + p.x);
      const y = Math.round(inp.y + p.y);
      if (p.kind === 2) {
        const k = 1 - p.age / p.life;
        for (let yy = -1; yy <= 1; yy++)
          for (let xx = -1; xx <= 1; xx++)
            if (xx * xx + yy * yy <= 2 * k + 0.2)
              front.set(x + xx, y + yy, M[M.length - 1]!, Math.round(200 * k));
        continue;
      }
      if (BAY8[((y & 7) << 3) | (x & 7)]! < p.age / p.life) continue;
      front.set(x, y, p.kind === 1 ? M[M.length - 2]! : this.dustC, p.kind === 1 ? 120 : 0);
    }
  }
}
