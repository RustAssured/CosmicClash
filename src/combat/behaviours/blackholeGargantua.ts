import {
  localToWorld,
  rgba,
  worldToLocal,
  type BodyTransform,
  type MatterMap,
  type TitanDef,
} from '@/contracts';
import { DMath } from '@/contracts/dmath';
import type { BlackHoleRig } from '@/titans';
import { BAY8, IdleClock, IdleRng, clampN, fcos, fsin, h2, idleSeed, ss } from '../fx/idle';
import { Overlay } from '../fx/overlay';

/**
 * THE BLACK HOLE, living idle v3 "Gargantua" (idle handover specs/black-hole.md): an ALTERNATIVE to the desktop agent's Black
 * Hole, behind a flag (`?bh=gargantua`; `GARGANTUA.on`), never the default. WJ 2026-10-22: presentation only (the sim, the body,
 * its hit volumes and balance are unchanged; this overlay covers the body), drawn at the prototype's own pixel numbers (1:1),
 * its colours tinted 7% by the stage's light like the painted body.
 *
 * After Interstellar's Gargantua: a big perfect shadow, a thin disk almost edge-on running out to tapered tips like a wing, the
 * far side lensed into an arch over the shadow and a thin arc under it, always feeding (rocks streaking in, wisps spiralling
 * from the tips), and THE FEAST every 9–12 s: a star torn into a stream that wraps the shadow, a flood of light through the
 * disk, blades along its plane, plumes off the poles.
 *
 * S19: everything here is presentation. It steps once per sim tick (an input ring the behaviour records in `update`: the foe's
 * place and the idle weight), its random stream is consumed only in `step`, and nothing it computes reaches the sim. Damage:
 * a disk pixel maps back onto the painted disk (same phase, its radius remapped) and is not drawn where that cell is gone.
 *
 * Cost (the prototype ran ~20 ms a frame): the flow noise is sampled from polar grids per 11 s epoch (filled a slice per tick
 * ahead of need), every pixel's polar geometry is tabled (rebuilt in slices as the disk precesses), the drawing runs every
 * other tick and only inside the camera's view.
 */

/** The variant switch (presentation only: not sim state, not in the netplay handshake). */
export const GARGANTUA = { on: false };

const TAU = Math.PI * 2;
const DT = IdleClock.DT;
/** The prototype's numbers (v3): shadow radius = horizon + 7, inner edge = shadow + 3, outer edge, the lens, gravity. */
const ROUT0 = 178;
const ROUT_MAX = ROUT0 + 4;
const THE = 50;
const GM = 62000;
const OM = 1.15;
/** Per-pixel geometry table: everything within the disk or the lens's reach of the shadow. */
const ARCH_REACH = 26;
/** The noise grids: radius from 32 in 0.5 px rows, phase in 1024 columns. */
const GR0 = 31;
const GDR = 0.5;
const GNR = Math.ceil((ROUT_MAX + 4 - GR0) / GDR) + 2;
const GQ = 1024;
const GN = GNR * GQ;
/** The overlay: the disk and the blades (ROUT + 240 along the plane) and the infall (despawned past r 330). */
const OW = 820;
const OH = 440;
/** Radial lookup tables (temperature, angular speed, heart boost) at 1/4 px. */
const RT = 4;
const RTN = (ROUT_MAX + 400) * RT;

const fatan2 = (y: number, x: number): number => {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax === 0 && ay === 0) return 0;
  const a = ax > ay ? ay / ax : ax / ay;
  const s = a * a;
  let r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a;
  if (ay > ax) r = 1.57079637 - r;
  if (x < 0) r = 3.14159274 - r;
  return y < 0 ? -r : r;
};
/** A sine for the per-pixel noise: the 4096-step table read without a division (render-only; `fsin` is the shared one). */
const QS_N = 4096;
const QS_T = new Float32Array(QS_N + 1);
for (let i = 0; i <= QS_N; i++) QS_T[i] = DMath.sin((i / QS_N) * Math.PI * 2);
const QS_K = QS_N / (Math.PI * 2);
const qsin = (x: number): number => {
  const k = x * QS_K;
  const fl = Math.floor(k);
  const i = fl & (QS_N - 1);
  const a = QS_T[i]!;
  return a + (QS_T[i + 1]! - a) * (k - fl);
};
/** x^0.55 for x in [0, 1] (the arch's thickness taper), 1/1024 steps. */
const POW055 = new Float32Array(1025);
for (let i = 0; i <= 1024; i++) POW055[i] = DMath.pow(i / 1024, 0.55);
/** exp(−x) for x ≥ 0 from a table (the clumps' gaussians). */
const EXPN = new Float32Array(1025);
for (let i = 0; i <= 1024; i++) EXPN[i] = DMath.exp(-(i / 1024) * 16);
const fexpn = (x: number): number => {
  if (x >= 16) return 0;
  const u = x * 64;
  const i = u | 0;
  const a = EXPN[i]!;
  return a + (EXPN[i + 1]! - a) * (u - i);
};

/** The prototype's periodic value noise (period `py` along y). */
function pvn(x: number, y: number, py: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const Y0 = ((yi % py) + py) % py;
  const Y1 = (Y0 + 1) % py;
  const a = h2(xi, Y0);
  const b = h2(xi + 1, Y0);
  const c = h2(xi, Y1);
  const d = h2(xi + 1, Y1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** One epoch's flow noise on the polar grid: A = the lanes' warp, B = the two value-noise octaves (pnoise without the lanes). */
class NoiseGrid {
  readonly A = new Float32Array(GN);
  readonly B = new Float32Array(GN);
  seed = NaN;
  filled = 0;
  start(seed: number): void {
    this.seed = seed;
    this.filled = 0;
  }
  get ready(): boolean {
    return this.filled >= GN;
  }
  fill(budget: number): void {
    const s = this.seed;
    const end = Math.min(GN, this.filled + budget);
    for (let k = this.filled; k < end; k++) {
      const row = (k / GQ) | 0;
      const q = (k - row * GQ) / GQ;
      const r = GR0 + row * GDR;
      this.A[k] = pvn(r * 0.3 + s, q * 5, 5);
      this.B[k] = 0.38 * pvn(r * 0.5 + s, q * 7, 7) + 0.27 * pvn(r * 1.7 + s * 3, q * 18, 18);
    }
    this.filled = end;
  }
}

interface Rock {
  x: number;
  y: number;
  vx: number;
  vy: number;
  heat: number;
  big: boolean;
  c: number;
}
interface Wisp {
  r: number;
  ph: number;
  age: number;
  life: number;
  k: number;
}
interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  bound: boolean;
  star: boolean;
}
interface Clump {
  r: number;
  ph: number;
  k: number;
  age: number;
  life: number;
  echoed: boolean;
}

/** A fixed-capacity pool (live items at the front; `kill(i)` swaps the last live one in). */
class Pool<T> {
  readonly items: T[];
  n = 0;
  constructor(cap: number, make: () => T) {
    this.items = Array.from({ length: cap }, make);
  }
  add(): T | null {
    return this.n < this.items.length ? this.items[this.n++]! : null;
  }
  kill(i: number): void {
    const last = this.items[--this.n]!;
    this.items[this.n] = this.items[i]!;
    this.items[i] = last;
  }
  clear(): void {
    this.n = 0;
  }
}

/** What the behaviour records each sim tick for the idle (the foe's place in the hole's frame, the idle weight). */
interface Input {
  fx: number;
  fy: number;
  w: number;
}

export class GargantuaIdle {
  readonly fx: Overlay;
  private readonly clock = new IdleClock();
  private readonly rng: IdleRng;
  private readonly seed: number;
  /** Ladders, packed RGBA: the disk's light ladder (9, by luminance), the photon ring, the jet, the shadow. */
  private readonly DL: number[];
  private readonly RING: number[];
  private readonly JET: number[];
  private readonly BLACK: number;
  private readonly HOT: number[];
  private readonly MID: number[];
  private readonly DIM: number[];
  private readonly ROCK: number[];
  private readonly RS: number;
  private readonly RIN: number;
  /** Radial tables. */
  private readonly tempT = new Float32Array(RTN);
  private readonly omT = new Float32Array(RTN);
  private readonly heartT = new Float32Array(RTN);
  /** Flow noise: per stream the current and the next epoch, and the static fibril noise. */
  private readonly grids: NoiseGrid[][] = [
    [new NoiseGrid(), new NoiseGrid()],
    [new NoiseGrid(), new NoiseGrid()],
  ];
  private readonly epoch = [-1, -1];
  private readonly fib = new Float32Array(GN);
  /** The geometry table (built for one tilt / squash, rebuilt in slices as the disk precesses). */
  private readonly geo = {
    n: 0,
    i: new Int16Array(0),
    j: new Int16Array(0),
    rho: new Float32Array(0),
    rd: new Float32Array(0),
    ph: new Float32Array(0),
    u: new Float32Array(0),
    v: new Float32Array(0),
    al: new Float32Array(0),
    thk: new Float32Array(0),
    /** The painted disk cell under this pixel's disk sample (the damage mask), −1 = none (beyond r 100 or off the map). */
    cell: new Int32Array(0),
  };
  private readonly next = { ...this.geo, tilt: 0, sq: 0, y: 0, building: false };
  private geoTilt = NaN;
  /** State (the prototype's). */
  private T = 0;
  private TILT = -0.42;
  private SQ = 0.13;
  private FLOOD = 0;
  private floodT = -9;
  private ACC = 0;
  private ROUT = ROUT0;
  private SHAKE = 0;
  private nextFlare = 1;
  private nextFeast = 4.5;
  private nextRock = 1;
  private nextClump = 1.5;
  private feast: {
    t0: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    torn: boolean;
    tearT: number;
    m: number;
    shed0: number;
    wave: boolean;
    wave2: boolean;
  } | null = null;
  private readonly clumps = new Pool<Clump>(48, () => ({
    r: 0,
    ph: 0,
    k: 0,
    age: 0,
    life: 1,
    echoed: false,
  }));
  private readonly rocks = new Pool<Rock>(96, () => ({
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    heat: 0,
    big: false,
    c: 0,
  }));
  private readonly wisps = new Pool<Wisp>(1400, () => ({ r: 0, ph: 0, age: 0, life: 1, k: 0 }));
  private readonly sparks = new Pool<Spark>(2400, () => ({
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    age: 0,
    life: 1,
    bound: false,
    star: false,
  }));
  private readonly echoes = new Pool<{ t0: number; a: number; k: number }>(16, () => ({ t0: 0, a: 0, k: 0 }));
  /** The idle weight (yields to moves, hits and KO) and the input ring. */
  private w = 0;
  private readonly ring: Input[] = Array.from({ length: 16 }, () => ({ fx: 999, fy: 0, w: 0 }));
  private readonly ringTick = new Int32Array(16).fill(-1);
  private lastIn: Input = { fx: 999, fy: 0, w: 0 };
  private drawnTick = -1;
  /** The painted disk the damage mask reads (the body's own geometry), and its live fraction (for the light past r 100). */
  private readonly rig: BlackHoleRig;
  private liveFrac = 1;
  private liveVer = -1;
  private readonly diskCells: Int32Array;
  private readonly wasDisk: Uint8Array;
  private readonly mapW: number;
  private readonly mapH: number;
  /** Per-frame clump scratch. */
  private readonly cR = new Float32Array(64);
  private readonly cPh = new Float32Array(64);
  private readonly cW = new Float32Array(64);
  private readonly cA = new Float32Array(64);
  private readonly cS = new Float32Array(64);
  /** Per integer radius, which clumps (bits 0–31 / 32–63) reach it this frame. */
  private readonly cLo = new Int32Array(ROUT_MAX + 64);
  private readonly cHi = new Int32Array(ROUT_MAX + 64);
  private nC = 0;
  private tau1 = 0;
  private tau2 = 0;
  private w1 = 0;
  private w2 = 0;
  private wInv = 1;
  /** This frame's noise grids (stream 1, stream 2). */
  private gA1 = new Float32Array(0);
  private gB1 = new Float32Array(0);
  private gA2 = new Float32Array(0);
  private gB2 = new Float32Array(0);
  private readonly xy = { x: 0, y: 0 };
  private readonly rowShift = new Int32Array(OH * 2);

  constructor(
    def: TitanDef,
    rig: BlackHoleRig,
    map: MatterMap,
    tint: string,
    fighterSeed: number,
    slot: number,
  ) {
    this.rig = rig;
    this.seed = idleSeed(fighterSeed ^ 90210, slot);
    this.rng = new IdleRng(this.seed);
    const hex = (s: string): [number, number, number] => [
      parseInt(s.slice(1, 3), 16),
      parseInt(s.slice(3, 5), 16),
      parseInt(s.slice(5, 7), 16),
    ];
    const tc = hex(tint);
    // the painter's own stage tint: 7% of the light's colour on the glowing gas (never on the shadow)
    const tinted = (c: [number, number, number]): [number, number, number] => [
      Math.round(c[0] + (tc[0] - c[0]) * 0.07),
      Math.round(c[1] + (tc[1] - c[1]) * 0.07),
      Math.round(c[2] + (tc[2] - c[2]) * 0.07),
    ];
    const ramp = (k: string): [number, number, number][] =>
      def.materials.find((m) => m.key === k)!.visual.ramp.map((h) => tinted(hex(h)));
    const pack = (c: [number, number, number]): number => rgba(c[0], c[1], c[2], 255);
    const hot = ramp('diskhot');
    const mid = ramp('diskmid');
    const dim = ramp('diskdim');
    const photon = ramp('photon');
    const lum = (c: [number, number, number]): number => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
    this.DL = [dim[3]!, mid[2]!, mid[3]!, hot[2]!, mid[4]!, hot[3]!, photon[2]!, hot[4]!, photon[3]!]
      .sort((a, b) => lum(a) - lum(b))
      .map(pack);
    this.RING = photon.map(pack);
    this.JET = ramp('jet').map(pack);
    const hz = def.materials.find((m) => m.key === 'horizon')!.visual.ramp.map(hex);
    this.BLACK = pack(hz[0]!);
    this.HOT = hot.map(pack);
    this.MID = mid.map(pack);
    this.DIM = dim.map(pack);
    // the rocks: its own disk-dim and horizon steps (the prototype's greys are not in the palette)
    this.ROCK = [pack(hz[2] ?? hz[0]!), pack(dim[1]!), pack(dim[2]!)];
    this.RS = rig.horizon + 7;
    this.RIN = this.RS + 3;
    for (let k = 0; k < RTN; k++) {
      const r = Math.max(1, k / RT);
      this.tempT[k] = DMath.pow(this.RIN / r, 0.7);
      this.omT[k] = OM * DMath.pow(this.RIN / r, 1.5);
      this.heartT[k] = 1 + 0.9 * ss(150, this.RIN, r);
    }
    for (let k = 0; k < GN; k++) {
      const row = (k / GQ) | 0;
      this.fib[k] = pvn((GR0 + row * GDR) * 0.25 + 9, ((k - row * GQ) / GQ) * 9, 9);
    }
    const list: number[] = [];
    for (let i = 0; i < map.w * map.h; i++) {
      const m = map.material[i]!;
      const ids = rig.ids;
      if (m === ids.diskhot || m === ids.diskmid || m === ids.diskdim) list.push(i);
    }
    this.diskCells = Int32Array.from(list);
    this.mapW = map.w;
    this.mapH = map.h;
    this.wasDisk = new Uint8Array(map.w * map.h);
    for (const i of list) this.wasDisk[i] = 1;
    this.fx = new Overlay('blackhole-gargantua', 0.6, OW, OH, 'normal', true);
    // light, not a solid: no dark outline round every dithered disk pixel and streak (the prototype has none)
    this.fx.layer.outline = false;
    this.reset();
  }

  /** A new round: the prototype's start (five clumps, the first Feast at 4.5 s). */
  reset(): void {
    this.rng.reseed(this.seed);
    this.clock.reset();
    this.T = 0;
    this.FLOOD = 0;
    this.floodT = -9;
    this.ACC = 0;
    this.ROUT = ROUT0;
    this.SHAKE = 0;
    this.nextFlare = 1;
    this.nextFeast = 4.5;
    this.nextRock = 1;
    this.nextClump = 1.5;
    this.feast = null;
    this.clumps.clear();
    this.rocks.clear();
    this.wisps.clear();
    this.sparks.clear();
    this.echoes.clear();
    this.w = 0;
    this.ringTick.fill(-1);
    this.drawnTick = -1;
    for (let k = 0; k < 5; k++)
      this.addClump(this.RIN + 4 + this.rng.next() * 40, this.rng.next() * TAU, 0.5 + this.rng.next() * 0.5);
  }

  /** Each sim tick (the behaviour's `update`): the foe's place relative to the hole (body cells) and the idle weight. */
  record(tick: number, t: BodyTransform, foeX: number, foeY: number, calm: boolean, ko: boolean): void {
    worldToLocal(t, foeX, foeY, this.xy);
    const s = tick & 15;
    const e = this.ring[s]!;
    e.fx = this.xy.x - this.rig.core.x;
    e.fy = this.xy.y - this.rig.core.y;
    e.w = ko ? -1 : calm ? 1 : 0;
    this.ringTick[s] = tick;
  }
  private inputAt(tick: number): Input {
    const s = tick & 15;
    if (this.ringTick[s] === tick) this.lastIn = this.ring[s]!;
    return this.lastIn;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  the simulation (the prototype's update(), one fixed 1/60 s step per sim tick)
   * ---------------------------------------------------------------------------------------------- */

  private omega(r: number): number {
    const k = (r * RT) | 0;
    return this.omT[k < 0 ? 0 : k >= RTN ? RTN - 1 : k]!;
  }

  private addClump(r: number, ph: number, k: number): void {
    const c = this.clumps.add();
    if (!c) return;
    c.r = r;
    c.ph = ph;
    c.k = k;
    c.age = 0;
    c.life = 6 + this.rng.next() * 5;
    c.echoed = false;
  }

  private spawnRock(from: Input | null): void {
    const R = this.rng;
    const o = this.rocks.add();
    if (!o) return;
    o.heat = 0;
    o.big = false;
    o.c = this.ROCK[(R.next() * 3) | 0]!;
    if (from) {
      const a = R.next() * TAU;
      o.x = from.fx + fcos(a) * 7;
      o.y = from.fy + fsin(a) * 7;
      o.vx = -from.fx * 0.06 + (R.next() - 0.5) * 6;
      o.vy = -from.fy * 0.06 - 14 - R.next() * 8;
      return;
    }
    if (R.next() < 0.62) {
      const sg = R.next() < 0.5 ? -1 : 1;
      const uu = sg * (this.ROUT + 30 + R.next() * 120);
      const vv = (R.next() - 0.5) * 30;
      const c = fcos(this.TILT);
      const s = fsin(this.TILT);
      o.x = uu * c - vv * s;
      o.y = uu * s + vv * c;
      const r = Math.sqrt(o.x * o.x + o.y * o.y);
      const v = Math.sqrt(GM / r) * (0.45 + R.next() * 0.3);
      o.vx = -sg * c * 22 + sg * s * v;
      o.vy = -sg * s * 22 - sg * c * v * 0.4;
      o.big = R.next() < 0.15;
      return;
    }
    const a = R.next() * TAU;
    const r = 220;
    o.x = fcos(a) * r;
    o.y = fsin(a) * r * 0.7;
    const v = Math.sqrt(GM / r) * (0.55 + R.next() * 0.3);
    o.vx = -fsin(a) * v - fcos(a) * 8;
    o.vy = fcos(a) * v * 0.7 - fsin(a) * 8;
  }

  private startFeast(): void {
    if (this.feast && this.T - this.feast.t0 < 9) return;
    const r0 = 230;
    const rp = 30;
    const a = -0.55 + (this.rng.next() - 0.5) * 0.5;
    const v0 = Math.sqrt((2 * GM) / r0) * 0.995;
    const vt = (rp * Math.sqrt((2 * GM) / rp)) / r0;
    const vr = -Math.sqrt(Math.max(0, v0 * v0 - vt * vt));
    const ex = fcos(a);
    const ey = fsin(a);
    this.feast = {
      t0: this.T,
      x: ex * r0,
      y: ey * r0,
      vx: ex * vr - ey * vt,
      vy: ey * vr + ex * vt,
      torn: false,
      tearT: 0,
      m: -1,
      shed0: 0,
      wave: false,
      wave2: false,
    };
  }

  /** Gravity, drag and the step of one falling body (positions relative to the hole); returns its distance. */
  private fall(o: { x: number; y: number; vx: number; vy: number }, drag: number): number {
    const r2 = Math.max(o.x * o.x + o.y * o.y, 120);
    const r = Math.sqrt(r2);
    o.vx += ((-GM * o.x) / (r2 * r)) * DT;
    o.vy += ((-GM * o.y) / (r2 * r)) * DT;
    o.vx *= 1 - drag * DT;
    o.vy *= 1 - drag * DT;
    o.x += o.vx * DT;
    o.y += o.vy * DT;
    return r;
  }

  private step(inp: Input): void {
    const R = this.rng;
    const dt = DT;
    // the idle weight: in over ~10 ticks, out over ~10 on a move or a hit, over 60 at KO
    const target = inp.w > 0 ? 1 : 0;
    this.w += (target - this.w) * (inp.w < 0 ? 1 / 60 : 0.1);
    const w = this.w;
    this.T += dt;
    const t = this.T;
    if (t > this.nextFeast && !this.feast) {
      if (w > 0.9) this.startFeast();
      this.nextFeast = t + 9 + R.next() * 3;
    }
    if (t > this.nextRock) {
      if (R.next() < w) this.spawnRock(null);
      this.nextRock = t + 0.1 + R.next() * 0.22;
    }
    const nw = Math.round(dt * 140 * w + R.next());
    for (let k = 0; k < nw; k++) {
      const q = this.wisps.add();
      if (!q) break;
      q.r = this.ROUT - 30 + R.next() * 110;
      q.ph = R.next() * TAU;
      q.age = 0;
      q.life = 3 + R.next() * 4;
      q.k = R.next();
    }
    for (let i = this.wisps.n - 1; i >= 0; i--) {
      const q = this.wisps.items[i]!;
      q.age += dt;
      q.ph -= this.omega(q.r) * dt * 1.3;
      q.r -= dt * (5 + 900 / q.r);
      if (q.age > q.life || q.r < this.RIN + 4) this.wisps.kill(i);
    }
    this.SHAKE = Math.max(0, this.SHAKE - dt * 5);
    if (t > this.nextClump) {
      this.addClump(this.RIN + 3 + R.next() * 60, R.next() * TAU, 0.5 + R.next() * 0.6);
      this.nextClump = t + 1.2 + R.next() * 1.5;
    }
    if (t > this.nextFlare) {
      this.addClump(this.RIN + 1 + R.next() * 10, R.next() * TAU, 1.9);
      this.nextFlare = t + 1.4 + R.next() * 1.4;
    }
    // precession: the disk wobbles on its tilt over 40 s
    this.TILT = -0.42 + 0.03 * fsin((t * TAU) / 40);
    this.SQ = 0.13 + 0.02 * fsin((t * TAU) / 40 + 1.3);
    // clumps orbit, shear and die; a ring echo when one passes behind the hole
    for (let i = this.clumps.n - 1; i >= 0; i--) {
      const c = this.clumps.items[i]!;
      c.age += dt;
      c.ph -= this.omega(c.r) * dt;
      c.r -= dt * 0.6;
      if (c.age > c.life || c.r < this.RIN) {
        this.clumps.kill(i);
        continue;
      }
      const far = ((c.ph % TAU) + TAU) % TAU;
      const d = Math.abs(far - (TAU * 3) / 4);
      if (!c.echoed && d < 0.15 && c.k > 0.45) {
        c.echoed = true;
        const e = this.echoes.add();
        if (e) {
          e.t0 = t;
          e.a = -Math.PI / 2 + this.TILT;
          e.k = c.k;
        }
      }
      if (d > 0.6) c.echoed = false;
    }
    for (let i = this.echoes.n - 1; i >= 0; i--) if (t - this.echoes.items[i]!.t0 >= 0.9) this.echoes.kill(i);
    // infall: rocks under gravity with a little drag; a spark burst and a clump where they reach the disk
    for (let i = this.rocks.n - 1; i >= 0; i--) {
      const o = this.rocks.items[i]!;
      const r = this.fall(o, 0.22);
      o.heat = clampN(1 - (r - 30) / 90, 0, 1);
      if (r < this.RIN + 2) {
        for (let k = 0; k < 10; k++) {
          const s = this.sparks.add();
          if (!s) break;
          s.x = o.x;
          s.y = o.y;
          s.vx = (R.next() - 0.5) * 50;
          s.vy = (R.next() - 0.5) * 30;
          s.age = 0;
          s.life = 0.3 + R.next() * 0.3;
          s.bound = false;
          s.star = false;
        }
        this.addClump(this.RIN + 2 + R.next() * 6, fatan2(o.y / this.SQ, o.x), o.big ? 1.6 : 0.9);
        if (o.big) this.SHAKE = Math.max(this.SHAKE, 1.2);
        this.rocks.kill(i);
      } else if (r > 330) this.rocks.kill(i);
    }
    for (let i = this.sparks.n - 1; i >= 0; i--) {
      const s = this.sparks.items[i]!;
      s.age += dt;
      if (s.star) {
        const r = this.fall(s, s.bound ? 0.35 : 0);
        if (s.bound && r < this.RIN + 1) {
          this.FLOOD = Math.min(1.8, this.FLOOD + 0.01);
          if (this.floodT < (this.feast ? this.feast.tearT : 0)) this.floodT = t;
          this.sparks.kill(i);
          continue;
        }
      } else {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.vx *= 1 - dt * 3;
        s.vy *= 1 - dt * 3;
      }
      if (s.age > s.life) this.sparks.kill(i);
    }
    // THE FEAST: a star on a near-parabolic orbit, torn as it passes (a stream along its orbit, the inside falling back)
    const F = this.feast;
    if (F) {
      if (!F.torn) {
        this.fall(F, 0);
        const r = this.fall(F, 0);
        if (r < 100 && F.m < 0) {
          F.m = 1;
          F.shed0 = t;
          F.tearT = t;
        }
        if (F.m >= 0) {
          const n = Math.round(dt * 560 * (0.3 + F.m) + R.next());
          if (F.m > 0.9) this.SHAKE = Math.max(this.SHAKE, 2.5);
          for (let k = 0; k < n; k++) {
            const s = this.sparks.add();
            const bound = R.next() < 0.55;
            const f = bound ? 0.62 + R.next() * 0.33 : 1.05 + R.next() * 0.45;
            const jx = (R.next() - 0.5) * 3;
            const jy = (R.next() - 0.5) * 3;
            const jvx = (R.next() - 0.5) * 4;
            const jvy = (R.next() - 0.5) * 4;
            const life = bound ? 8 : 6 + R.next() * 3;
            if (!s) continue;
            s.x = F.x + jx;
            s.y = F.y + jy;
            s.vx = F.vx * f + jvx;
            s.vy = F.vy * f + jvy;
            s.bound = bound;
            s.age = 0;
            s.life = life;
            s.star = true;
          }
          F.m = Math.max(0, F.m - dt * 0.36);
          if (F.m <= 0.02 || (r > 190 && t - F.shed0 > 1)) F.torn = true;
        }
      } else {
        const u = t - F.tearT;
        if (u > 1.4 && !F.wave) {
          F.wave = true;
          this.SHAKE = 3.5;
        }
        if (u > 2.0 && !F.wave2) {
          F.wave2 = true;
          this.SHAKE = Math.max(this.SHAKE, 2.5);
        }
        if (u > 9) {
          this.feast = null;
          this.ACC = Math.min(0.3, this.ACC + 0.06);
          this.ROUT = Math.min(ROUT0 + 4, this.ROUT + 1);
        }
      }
    }
    this.FLOOD = Math.max(
      0,
      this.FLOOD - dt * (this.feast && this.feast.torn && t - this.feast.tearT < 3 ? 0.03 : 0.22),
    );
    // the opponent: its edges stream in when it is close
    const od = Math.sqrt(inp.fx * inp.fx + inp.fy * inp.fy);
    if (R.next() < dt * clampN((200 - od) / 14, 0, 14) * w) this.spawnRock(inp);
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  the disk's light
   * ---------------------------------------------------------------------------------------------- */

  /** Keep each noise stream's grid for this epoch ready, and fill the next epoch's ahead of need (a slice per tick). */
  private prepareNoise(): void {
    for (let s = 0; s < 2; s++) {
      const tt = this.T + (s ? 5.5 : 0);
      const ep = Math.floor(tt / 11);
      const G = this.grids[s]!;
      const seedOf = (e: number): number => e * 7.1 + (s ? 3.3 : 0);
      if (this.epoch[s] !== ep) {
        // the next epoch's grid becomes the current one (finished now if it was not)
        if (G[1]!.seed === seedOf(ep)) {
          G[1]!.fill(GN);
          const tmp = G[0]!;
          G[0] = G[1]!;
          G[1] = tmp;
        } else {
          G[0]!.start(seedOf(ep));
          G[0]!.fill(GN);
        }
        G[1]!.start(seedOf(ep + 1));
        this.epoch[s] = ep;
      }
      if (!G[1]!.ready) G[1]!.fill(1200);
    }
  }

  /** The prototype's diskI: Keplerian flow noise in two crossfaded 11 s epochs, fibrils, clumps, Doppler, heart, flood. */
  private diskI(r: number, ph: number, u: number): number {
    if (r < this.RIN || r > this.ROUT) return -1;
    const rk = (r * RT) | 0;
    const temp = this.tempT[rk]!;
    const om = this.omT[rk]!;
    // the grid row (shared by both streams and the fibrils)
    let f = (r - GR0) / GDR;
    if (f > GNR - 2) f = GNR - 2;
    const row = f | 0;
    const fr = f - row;
    const rb = row * GQ;
    let q1 = (ph + om * this.tau1) / TAU;
    q1 -= Math.floor(q1);
    const c1 = (q1 * GQ) & (GQ - 1);
    let n = 0;
    {
      const k0 = rb + c1;
      const A1 = this.gA1;
      const B1 = this.gB1;
      const a = A1[k0]! + (A1[k0 + GQ]! - A1[k0]!) * fr;
      const b = B1[k0]! + (B1[k0 + GQ]! - B1[k0]!) * fr;
      n += (b + 0.35 * (0.5 + 0.5 * qsin(r * 1.9 + 2.2 * a))) * this.w1;
    }
    {
      let q2 = (ph + om * this.tau2) / TAU;
      q2 -= Math.floor(q2);
      const k0 = rb + ((q2 * GQ) & (GQ - 1));
      const A2 = this.gA2;
      const B2 = this.gB2;
      const a = A2[k0]! + (A2[k0 + GQ]! - A2[k0]!) * fr;
      const b = B2[k0]! + (B2[k0 + GQ]! - B2[k0]!) * fr;
      n += (b + 0.35 * (0.5 + 0.5 * qsin(r * 1.9 + 2.2 * a))) * this.w2;
    }
    n *= this.wInv;
    let I = temp * (0.62 + 1.25 * n * n);
    {
      // the dark laminar streaks (fibrils), on the static grid at the same radius rows
      const k0 = rb + c1;
      const F = this.fib;
      const vn = F[k0]! + (F[k0 + GQ]! - F[k0]!) * fr;
      const fb = qsin(r * 3.7 + 6 * vn);
      if (fb > 0.86) I *= 0.42;
      else if (fb > 0.7) I *= 0.75;
    }
    // only the clumps whose reach covers this radius (bucketed per integer radius each frame)
    const ri = r | 0;
    let mask = this.cLo[ri]! | 0;
    let mhi = this.cHi[ri]! | 0;
    while (mask !== 0 || mhi !== 0) {
      let c: number;
      if (mask !== 0) {
        const b = mask & -mask;
        c = 31 - Math.clz32(b);
        mask ^= b;
      } else {
        const b = mhi & -mhi;
        c = 32 + 31 - Math.clz32(b);
        mhi ^= b;
      }
      const dr = (r - this.cR[c]!) / this.cS[c]!;
      if (dr * dr > 4) continue;
      let dp = (ph - this.cPh[c]! + Math.PI) % TAU;
      if (dp < 0) dp += TAU;
      dp -= Math.PI;
      const wd = this.cW[c]!;
      I += fexpn(dr * dr + (dp * dp) / (wd * wd)) * this.cA[c]!;
    }
    I *= (1 - (0.24 * u) / r) * this.heartT[rk]! * (1 + this.ACC);
    if (this.FLOOD > 0) {
      const front = this.RIN + (this.T - this.floodT) * 85;
      if (r < front) I += this.FLOOD * 0.85 * temp * (1 + 0.5 * n);
      if (Math.abs(r - front) < 2.5) I += this.FLOOD * 1.5;
    }
    // the outer edge thins out into nothing
    if (r > this.ROUT - 80) I *= ss(this.ROUT, this.ROUT - 80, r);
    return I;
  }

  /**
   * The damage mask: the painted disk cell a disk sample at (r, ph) stands for (same phase, the radius remapped from
   * RIN..100 onto the painted diskIn..diskOut), or −1 where there is none to check (beyond r 100, off the map, or a cell
   * that was never gas: the painting's own gaps are not damage).
   */
  private maskCell(r: number, ph: number): number {
    if (r > 100) return -1;
    const rg = this.rig;
    const rp = rg.diskIn + ((r - this.RIN) * (rg.diskOut - rg.diskIn)) / (100 - this.RIN);
    const uu = rp * fcos(ph);
    const vv = rp * fsin(ph) * rg.squash;
    const ct = fcos(rg.tilt);
    const st = fsin(rg.tilt);
    const x = Math.floor(rg.core.x + uu * ct - vv * st);
    const y = Math.floor(rg.core.y + uu * st + vv * ct);
    if (x < 0 || y < 0 || x >= this.mapW || y >= this.mapH) return -1;
    const c = y * this.mapW + x;
    return this.wasDisk[c] ? c : -1;
  }

  private diskCol(I: number, x: number, y: number): number {
    const L = this.DL.length;
    const k = Math.floor(I * L * 0.6 + BAY8[((y & 7) << 3) | (x & 7)]! * 0.65 - 0.3);
    return this.DL[k < 0 ? 0 : k >= L ? L - 1 : k]!;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  geometry: every pixel's polar coordinates, for one tilt / squash
   * ---------------------------------------------------------------------------------------------- */

  /** Build (a slice of) the geometry table for the current tilt; swap it in when complete. */
  private buildGeo(rows: number): void {
    const N = this.next;
    if (!N.building) {
      N.building = true;
      N.tilt = this.TILT;
      N.sq = this.SQ;
      N.y = 0;
      N.n = 0;
      const cap = 60000;
      if (N.i.length < cap) {
        N.i = new Int16Array(cap);
        N.j = new Int16Array(cap);
        N.rho = new Float32Array(cap);
        N.rd = new Float32Array(cap);
        N.ph = new Float32Array(cap);
        N.u = new Float32Array(cap);
        N.v = new Float32Array(cap);
        N.al = new Float32Array(cap);
        N.thk = new Float32Array(cap);
        N.cell = new Int32Array(cap);
      }
    }
    const ct = fcos(-N.tilt);
    const st = fsin(-N.tilt);
    const RX = ROUT_MAX + 3;
    const RY = Math.ceil(ROUT_MAX * Math.abs(fsin(N.tilt)) + ROUT_MAX * (N.sq + 0.03) + 6);
    // the shadow (swollen by up to 2 in a flood), the arch (≤ 21 + 1.4 beyond it) and the photon ring all lie inside this
    const reach = this.RS + 2 + ARCH_REACH;
    for (let k = 0; k < rows && N.y <= 2 * RY; k++, N.y++) {
      const j = N.y - RY;
      const dy = j + 0.5;
      for (let i = -RX; i <= RX; i++) {
        const dx = i + 0.5;
        const u = dx * ct - dy * st;
        const v = dx * st + dy * ct;
        const rho = Math.sqrt(u * u + v * v);
        const rd = Math.sqrt(u * u + (v / N.sq) * (v / N.sq));
        if (rd > ROUT_MAX + 2 && rho > reach) continue;
        const n = N.n++;
        N.i[n] = i;
        N.j[n] = j;
        N.rho[n] = rho;
        N.rd[n] = rd;
        N.ph[n] = fatan2(v / N.sq, u);
        N.u[n] = u;
        N.v[n] = v;
        const al = fatan2(v, u);
        N.al[n] = al;
        N.thk[n] = 0.32 + 0.68 * POW055[Math.round(Math.abs(fsin(al)) * 1024)]!;
        N.cell[n] = this.maskCell(rd, N.ph[n]!);
      }
    }
    if (N.y > 2 * RY) {
      // swap the finished table in
      const G = this.geo;
      for (const key of ['i', 'j', 'rho', 'rd', 'ph', 'u', 'v', 'al', 'thk', 'cell'] as const) {
        const a = G[key];
        (G as Record<string, unknown>)[key] = N[key];
        (N as Record<string, unknown>)[key] = a;
      }
      G.n = N.n;
      this.geoTilt = N.tilt;
      N.building = false;
    }
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  per frame
   * ---------------------------------------------------------------------------------------------- */

  /**
   * Step to the current sim tick (the recorded inputs), keep the noise and the geometry ahead, and redraw every other tick.
   * Returns the overlay layer to push (hidden while nothing is drawn).
   */
  advance(
    tick: number,
    t: BodyTransform,
    map: MatterMap,
    view: { x0: number; y0: number; w: number; h: number },
  ): void {
    const n = this.clock.due(tick);
    for (let k = n - 1; k >= 0; k--) {
      this.step(this.inputAt(tick - k));
      this.prepareNoise();
      if (this.next.building || Math.abs(this.TILT - this.geoTilt) > 0.004) this.buildGeo(8);
    }
    if (Number.isNaN(this.geoTilt)) {
      // the first frame: this epoch's noise and the whole geometry table at once (the next epochs fill a slice per tick)
      this.prepareNoise();
      this.buildGeo(100000);
    }
    const moved = this.fx.limitToView(view);
    // every other tick (the picture of tick T is a function of T alone); a frame rate that only ever lands on odd ticks
    // still redraws once two ticks have passed
    if (tick === this.drawnTick) return;
    if (!moved && (tick & 1) === 1 && this.drawnTick >= 0 && tick - this.drawnTick < 2) return;
    this.drawnTick = tick;
    this.draw(tick, t, map);
  }

  private draw(tick: number, t: BodyTransform, map: MatterMap): void {
    const fx = this.fx;
    // the shake: whole pixels, a hash of the tick (never the idle's stream)
    const sx = Math.round((h2(tick, 1) - 0.5) * 2 * this.SHAKE);
    const sy = Math.round((h2(tick, 2) - 0.5) * 2 * this.SHAKE);
    const cx = this.rig.core.x;
    const cy = this.rig.core.y;
    fx.begin(t.x, t.y);
    // body-local cell (core + i, core + j) → world, mirrored with facing, sheared with lean (per row)
    const facing = t.facing;
    const base = t.x - t.anchorX * facing + sx;
    const rowOf = (j: number): number => {
      const ly = cy + j;
      localToWorld(t, 0.5, ly + 0.5, this.xy);
      return this.xy.x - (t.x + (0.5 - t.anchorX) * facing);
    };
    const RY = OH;
    for (let j = -RY; j < RY; j++) this.rowShift[j + RY] = Math.floor(rowOf(j));
    const wy0 = Math.floor(t.y + 0.5 - t.anchorY) + cy + sy;
    // straight into the overlay's buffers (clipped to its drawable rect), one bounding box for the frame
    const PX = fx.pixels;
    const EM = fx.emissiveBuf!;
    const OWd = fx.w;
    const ox = fx.ox;
    const oy = fx.oy;
    const X0 = fx.cx0;
    const X1 = fx.cx1;
    const Y0 = fx.cy0;
    const Y1 = fx.cy1;
    let bx0 = X1;
    let by0 = Y1;
    let bx1 = X0;
    let by1 = Y0;
    const xb = facing > 0 ? Math.floor(base + cx + 0.5) : Math.floor(base - cx - 0.5);
    const plot = (i: number, j: number, c: number, em: number): void => {
      if (j < -RY || j >= RY) return;
      const X = xb + i * facing + this.rowShift[j + RY]!;
      const Y = wy0 + j;
      if (X < X0 || X >= X1 || Y < Y0 || Y >= Y1) return;
      const k = (Y - oy) * OWd + (X - ox);
      PX[k] = c;
      if (em > 0) EM[k] = em;
      if (X < bx0) bx0 = X;
      if (X > bx1) bx1 = X;
      if (Y < by0) by0 = Y;
      if (Y > by1) by1 = Y;
    };
    const plotF = (x: number, y: number, c: number, em: number): void =>
      plot(Math.floor(x), Math.floor(y), c, em);
    // the prototype's glow (colour × a, box-blurred ×1.6) → the game's bloom
    const emOf = (a: number): number => Math.min(255, Math.round(a * 320));
    // this frame's noise weights and clumps
    const T = this.T;
    const Pp = 11;
    this.tau1 = T % Pp;
    this.tau2 = (T + Pp / 2) % Pp;
    this.w1 = 1 - Math.abs((2 * this.tau1) / Pp - 1);
    this.w2 = 1 - Math.abs((2 * this.tau2) / Pp - 1);
    this.wInv = 1 / (this.w1 + this.w2 + 1e-6);
    this.gA1 = this.grids[0]![0]!.A;
    this.gB1 = this.grids[0]![0]!.B;
    this.gA2 = this.grids[1]![0]!.A;
    this.gB2 = this.grids[1]![0]!.B;
    this.nC = 0;
    this.cLo.fill(0);
    this.cHi.fill(0);
    for (let k = 0; k < this.clumps.n && this.nC < 64; k++) {
      const c = this.clumps.items[k]!;
      const i = this.nC++;
      const S = 2.2 + c.age * 0.25;
      this.cR[i] = c.r;
      this.cPh[i] = c.ph;
      this.cS[i] = S;
      this.cW[i] = 0.18 + c.age * Math.abs(this.omega(c.r) - this.omega(c.r + 3)) * 1.8;
      this.cA[i] = c.k * 0.9 * (1 - c.age / c.life);
      // its reach |r − c.r| ≤ 2·S, over whole radii
      const r0 = Math.max(0, Math.floor(c.r - 2 * S));
      const r1 = Math.min(this.cLo.length - 1, Math.ceil(c.r + 2 * S));
      const bit = 1 << (i & 31);
      const A = i < 32 ? this.cLo : this.cHi;
      for (let r = r0; r <= r1; r++) A[r] = A[r]! | bit;
    }
    // the damage mask: the painted disk's live fraction (for the light beyond its reach)
    if (map.version !== this.liveVer) {
      this.liveVer = map.version;
      let live = 0;
      for (let k = 0; k < this.diskCells.length; k++) if (map.material[this.diskCells[k]!] !== 0) live++;
      this.liveFrac = this.diskCells.length ? live / this.diskCells.length : 1;
    }
    const RIN = this.RIN;
    const ROUT = this.ROUT;
    const BRIGHT = 100;
    /** A disk sample at (r, ph): false where the painted disk's cell under it is gone. */
    // (only a cell that was gas when painted and is gone now is a hole: the painting's own gaps are not damage)
    const mat = map.material;
    const aliveCell = (c: number): boolean => c < 0 || mat[c] !== 0;
    const alive = (r: number, ph: number): boolean => aliveCell(this.maskCell(r, ph));
    const outer = (r: number): number => (r > BRIGHT ? this.liveFrac : 1);
    const blaze = this.FLOOD;
    const w = this.w;
    // plumes behind, rocks behind
    this.drawPlumes(-1, plotF);
    this.drawRocks(false, plotF, emOf);
    // the hole: far disk, lensed arch, shadow, photon ring; the near disk after, over the shadow
    const G = this.geo;
    const RSx = this.RS + (blaze > 0.6 ? 1 : 0) + (blaze > 1.3 ? 1 : 0);
    for (let k = 0; k < G.n; k++) {
      const rho = G.rho[k]!;
      const rd = G.rd[k]!;
      const v = G.v[k]!;
      if (rd > ROUT + 2 && rho > RSx + ARCH_REACH) continue;
      const i = G.i[k]!;
      const j = G.j[k]!;
      const x = cx + i;
      const y = cy + j;
      const ph = G.ph[k]!;
      const u = G.u[k]!;
      if (v < 0 && rho > RSx && rd <= ROUT) {
        const I = this.diskI(rd, ph, u) * outer(rd);
        if (I > 0.06 && aliveCell(G.cell[k]!)) plot(i, j, this.diskCol(I * 0.8, x, y), 0);
      }
      const top = v < 0;
      const thick = (top ? 21 : 12) * G.thk[k]!;
      const e = rho - (RSx + 1.4);
      if (e >= 0 && e < thick) {
        const ef = e / Math.max(1, thick);
        const rr = RIN + ef * Math.sqrt(ef) * (ROUT - RIN) * (top ? 0.55 : 0.4);
        const al = G.al[k]!;
        const pp = top ? al : -al;
        const I = this.diskI(rr, pp, u) * (1.25 - (0.35 * e) / thick) * outer(rr);
        if (I > 0.06 && alive(rr, pp)) {
          const c = this.diskCol(I * (top ? 1.2 : 1.05), x, y);
          plot(i, j, c, I > 0.95 ? emOf(0.09 + blaze * 0.08) : 0);
        }
      }
      if (rho <= RSx) {
        plot(i, j, this.BLACK, 0);
        continue;
      }
      const pr = rho - RSx;
      if (pr < 3.2) {
        let I = pr < 1.1 ? 1.05 : pr > 2.2 && pr < 3.0 ? 0.35 : 0;
        if (I > 0) {
          const a = fatan2(j + 0.5, i + 0.5);
          I += 0.12 * fsin(a * 5 + T * 3.1) + blaze * 0.6;
          for (let q = 0; q < this.echoes.n; q++) {
            const ec = this.echoes.items[q]!;
            const run = (T - ec.t0) * 7.5;
            const d1 = Math.abs(((((a - ec.a - run) % TAU) + TAU + Math.PI) % TAU) - Math.PI);
            const d2 = Math.abs(((((a - ec.a + run) % TAU) + TAU + Math.PI) % TAU) - Math.PI);
            const d = Math.min(d1, d2);
            if (d < 0.35) I += ec.k * (1 - d / 0.35) * (1 - (T - ec.t0) / 0.9) * 1.4;
          }
          const ci = Math.floor(I * 3.2 + BAY8[((y & 7) << 3) | (x & 7)]! * 0.6);
          plot(i, j, this.RING[ci < 0 ? 0 : ci > 3 ? 3 : ci]!, I > 0.9 ? emOf(0.18 + blaze * 0.2) : 0);
        }
      }
    }
    for (let k = 0; k < G.n; k++) {
      const v = G.v[k]!;
      const rd = G.rd[k]!;
      if (v < 0 || rd > ROUT) continue;
      const ph = G.ph[k]!;
      const I = this.diskI(rd, ph, G.u[k]!) * outer(rd);
      if (I > 0.06 && aliveCell(G.cell[k]!)) {
        const i = G.i[k]!;
        const j = G.j[k]!;
        plot(i, j, this.diskCol(I, cx + i, cy + j), I > 1.0 ? emOf(0.06 + blaze * 0.1) : 0);
      }
    }
    this.drawWisps(plotF);
    this.drawPlumes(1, plotF);
    this.drawBlades(plotF, emOf, w);
    this.drawRocks(true, plotF, emOf);
    this.drawSparks(plotF, emOf);
    this.drawFeastStar(plotF, emOf);
    if (bx1 >= bx0) fx.markRect(bx0 - ox, by0 - oy, bx1 + 1 - ox, by1 + 1 - oy);
    fx.end();
  }

  private drawPlumes(side: number, plot: (x: number, y: number, c: number, em: number) => void): void {
    const FL = this.FLOOD * Math.max(this.w, this.feast ? 0.5 : 0);
    const amp = Math.min(1.2, FL);
    if (amp < 0.05) return;
    const Lp = 16 + 46 * FL;
    const ax = this.TILT - Math.PI / 2;
    const dx = fcos(ax) * side;
    const dy = fsin(ax) * side;
    const nx = -dy;
    const ny = dx;
    const J = this.JET;
    for (let j = 0; j < 9; j++) {
      const a = (j - 4) / 4;
      for (let s = 0; s < Lp; s += 0.7) {
        const u = s / Lp;
        const spread = a * (5 + s * 0.55 * u + 3 * u);
        const x = dx * (this.RS + 1 + s) + nx * spread;
        const y = dy * (this.RS + 1 + s) + ny * spread;
        const flow = 0.5 + 0.5 * fsin(s * 0.45 - this.T * 9 + j);
        const I = amp * (1 - u) * (0.45 + 0.55 * flow) * (1 - Math.abs(a) * 0.4);
        const X = Math.round(x);
        const Y = Math.round(y);
        if (I < 0.1 || BAY8[((Y & 7) << 3) | (X & 7)]! > I * 1.1) continue;
        const ci = clampN(Math.floor(I * J.length * 0.9 + 0.5), 0, J.length - 1);
        plot(X, Y, J[ci]!, I > 0.5 ? 56 : 0);
      }
    }
  }

  private drawBlades(
    plot: (x: number, y: number, c: number, em: number) => void,
    emOf: (a: number) => number,
    w: number,
  ): void {
    const FL = this.FLOOD * Math.max(w, this.feast ? 0.5 : 0);
    if (FL <= 0.02) return;
    const ct = fcos(this.TILT);
    const st = fsin(this.TILT);
    for (const sg of [-1, 1]) {
      for (let u = this.ROUT - 60; u < this.ROUT + 240; u += 0.5) {
        const f = (u - (this.ROUT - 60)) / 300;
        const I = FL * (1.3 - f * 1.1);
        if (I <= 0.05) break;
        const ph = fsin(u * 0.4 - this.T * 30 * sg);
        for (let o = 0; o < 4; o++) {
          const off = o === 0 ? 0 : o === 1 ? -1 : o === 2 ? 1 : ph > 0.6 ? 2 : 99;
          if (off === 99 || (off !== 0 && I < 0.7)) continue;
          const X = Math.round(sg * u * ct);
          const Y = Math.round(sg * u * st + off);
          if (BAY8[((Y & 7) << 3) | (X & 7)]! > I) continue;
          plot(X, Y, this.RING[clampN(Math.floor(I * 3), 0, 3)]!, emOf(0.15 * I));
        }
      }
    }
  }

  private drawWisps(plot: (x: number, y: number, c: number, em: number) => void): void {
    const c = fcos(this.TILT);
    const s = fsin(this.TILT);
    const RS = this.RS;
    for (let n = 0; n < this.wisps.n; n++) {
      const q = this.wisps.items[n]!;
      const f = Math.min(1, q.age / 0.6) * (1 - q.age / q.life);
      if (f <= 0.05) continue;
      const L2 = 6 + q.k * 12;
      const hot = clampN((this.ROUT + 40 - q.r) / 120, 0, 1);
      const col =
        hot > 0.6 ? this.HOT[2]! : hot > 0.3 ? this.MID[3]! : q.k > 0.5 ? this.MID[2]! : this.DIM[3]!;
      for (let k = 0; k < L2; k++) {
        const ph = q.ph + k * (0.7 / q.r);
        const u = q.r * fcos(ph);
        const v = q.r * fsin(ph) * this.SQ;
        if (v < 0 && u * u + v * v < (RS + 24) * (RS + 24)) continue;
        const X = Math.round(u * c - v * s);
        const Y = Math.round(u * s + v * c);
        const fade = f * (1 - k / L2);
        if (BAY8[((Y & 7) << 3) | (X & 7)]! > fade * 0.9) continue;
        plot(X, Y, col, 0);
      }
    }
  }

  private drawRocks(
    front: boolean,
    plot: (x: number, y: number, c: number, em: number) => void,
    emOf: (a: number) => number,
  ): void {
    const DL = this.DL;
    for (let n = 0; n < this.rocks.n; n++) {
      const o = this.rocks.items[n]!;
      if (o.y >= 0 !== front) continue;
      const r = Math.sqrt(o.x * o.x + o.y * o.y);
      const sp = Math.sqrt(o.vx * o.vx + o.vy * o.vy) || 1;
      const len = Math.min(52, (9000 / (r * r)) * 10 + 2) * (o.big ? 1.4 : 1);
      const ux = o.vx / sp;
      const uy = o.vy / sp;
      for (let k = 0; k <= len; k++) {
        const X = Math.round(o.x - ux * k);
        const Y = Math.round(o.y - uy * k);
        const f = k / (len + 1);
        if (k > 1 && BAY8[((Y & 7) << 3) | (X & 7)]! < f) continue;
        const c =
          o.heat > 0.55
            ? DL[clampN(Math.floor((o.heat - 0.4) * DL.length * (1 - f)), 0, DL.length - 1)]!
            : o.c;
        plot(X, Y, c, o.heat > 0.7 ? emOf(0.1) : 0);
      }
      if (len < 3) {
        const X = Math.round(o.x);
        const Y = Math.round(o.y);
        plot(X + 1, Y, o.c, 0);
        plot(X, Y + 1, o.c, 0);
        plot(X + 1, Y + 1, o.c, 0);
      }
    }
  }

  private drawSparks(
    plot: (x: number, y: number, c: number, em: number) => void,
    emOf: (a: number) => number,
  ): void {
    const RING = this.RING;
    const RS = this.RS;
    for (let n = 0; n < this.sparks.n; n++) {
      const s = this.sparks.items[n]!;
      const k = s.age / s.life;
      const X = Math.round(s.x);
      const Y = Math.round(s.y);
      if (BAY8[((Y & 7) << 3) | (X & 7)]! < k * 0.9) continue;
      if (s.star) {
        const sp = Math.sqrt(s.vx * s.vx + s.vy * s.vy) || 1;
        const tl = Math.min(4, sp / 40);
        for (let q = 1; q <= tl; q++)
          plot(
            Math.round(s.x - (s.vx / sp) * q),
            Math.round(s.y - (s.vy / sp) * q),
            q > 2 ? this.HOT[2]! : this.HOT[3]!,
            0,
          );
      }
      const c = s.star
        ? k < 0.3
          ? RING[3]!
          : k < 0.6
            ? RING[2]!
            : this.HOT[3]!
        : k < 0.4
          ? RING[3]!
          : this.HOT[3]!;
      plot(X, Y, c, emOf(s.star ? 0.12 : 0.2));
      if (s.star) {
        // its secondary lensed image: the stream wraps round the shadow
        const b = Math.sqrt(s.x * s.x + s.y * s.y) || 0.01;
        const root = Math.sqrt(b * b + 4 * THE * THE);
        const tm = (b - root) / 2;
        const uu = b / THE;
        const mag = Math.max(0, (uu * uu + 2) / (2 * uu * Math.sqrt(uu * uu + 4)) - 0.5);
        const ix = (s.x / b) * tm;
        const iy = (s.y / b) * tm;
        if (mag > 0.05 && Math.abs(tm) > RS + 1.5) {
          const X2 = Math.round(ix);
          const Y2 = Math.round(iy);
          if (BAY8[((Y2 & 7) << 3) | (X2 & 7)]! < 0.35 + mag) plot(X2, Y2, this.HOT[3]!, emOf(0.08));
        }
      }
    }
  }

  private drawFeastStar(
    plot: (x: number, y: number, c: number, em: number) => void,
    emOf: (a: number) => number,
  ): void {
    const F = this.feast;
    if (!F || F.torn) return;
    const mm = F.m < 0 ? 1 : F.m;
    if (mm < 0.15) return;
    const X = Math.round(F.x);
    const Y = Math.round(F.y);
    const r = Math.sqrt(F.x * F.x + F.y * F.y);
    const stretch = clampN((140 - r) / 30, 0, 3);
    const sp = Math.sqrt(F.vx * F.vx + F.vy * F.vy) || 1;
    const ux = F.vx / sp;
    const uy = F.vy / sp;
    const S = Math.round(stretch * 3);
    for (let k = -S; k <= S; k++)
      for (let oy = -3; oy <= 3; oy++)
        for (let ox = -3; ox <= 3; ox++) {
          if (ox * ox + oy * oy > (9 - Math.abs(k) * 0.3) * mm) continue;
          const c = ox * ox + oy * oy < 2 ? this.RING[3]! : this.RING[2]!;
          plot(X + ox + Math.round(ux * k), Y + oy + Math.round(uy * k), c, emOf(0.35));
        }
  }

  /** The Feast's state (tests, tools): −9 none, −1 falling, else seconds since the tear. */
  get feastState(): number {
    const F = this.feast;
    return F ? (F.torn ? this.T - F.tearT : -1) : -9;
  }
  get time(): number {
    return this.T;
  }
  get weight(): number {
    return this.w;
  }
}
