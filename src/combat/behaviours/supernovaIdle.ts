import { hex, pb, pg, pr, rgba, type RenderLayer } from '@/contracts';
import { DMath } from '@/contracts/dmath';
import type { SupernovaRig } from '@/titans';
import {
  BAY8,
  BodySkin,
  BodySpaceLayer,
  IdleClock,
  IdleRng,
  NoiseLattice,
  Pool,
  clampN,
  fcos,
  fsin,
  h2,
  ss,
  vnoise,
} from '../fx/idle';

/**
 * THE SUPERNOVA'S LIVING IDLE (idle handover: specs/supernova.md, prototype `supernova.src.html`, approved by WJ: "Yes!!
 * This is it!!"). A heartbeat (a held breath, then a swell that grows the rim by whole pixels and rings out), granules that
 * boil on their own beats with drifting lanes, a corona of pixel fire whose tips burn away and regrow, living prominences
 * that rise, braid, snap and rain, flame tongues, sparks, coronal mass ejections and flares with a Moreton wave.
 *
 * Presentation only (S19). The disc, rim and corona are drawn into a `BodySkin` presented in place of the body layer (the
 * matter map is never written); everything outside the body goes into a `BodySpaceLayer` in map space. The idle's state
 * advances one fixed 1/60 s step per sim tick (`advance`), seeded per fighter, so it is the same at any frame rate and on
 * both netplay peers. Damage stays: only live cells are drawn, cells the matter module changed (heat, char, cracks, fresh
 * edges) are shown as they are, and the rim swell never fills a crater.
 */

/** What the fight tells the idle each tick. */
export interface NovaIdleInput {
  /** Fuel 0..1. */
  fuel: number;
  /** The prototype's "Hurt" (a hit landed recently, or hitstun). */
  hurt: boolean;
  /** 1 at rest; 0 during moves, hitstun and KO (the idle eases toward it over ~8 ticks). */
  rest: number;
  /** Fades everything (the collapse startup, the KO). */
  live: number;
}

/** The live matter the idle reads (the fighter's `body.map`). */
export interface IdleMap {
  version: number;
  material: Uint8Array;
  integrity: Uint8Array;
  flags: Uint8Array;
  infection: Uint8Array;
  pixels: Uint32Array;
  emissive: Uint8Array;
}
/** CellFlag bits that mean the fight changed a cell: BURNING, CRACKED, CHARRED, ASSIMILATED, GLOWING (not SURFACE). */
const FIGHT_FLAGS = 1 | 2 | 4 | 8 | 64;
/** Per-tick inputs kept for the catch-up steps (a frame that follows two ticks steps each with its own tick's input). */
const RING = 16;

interface Beat {
  t: number;
  a: number;
}
interface Flare {
  t: number;
  x: number;
  y: number;
  a: number;
}
const RAIN = 30;
interface Prom {
  t: number;
  a: number;
  sep: number;
  h: number;
  loop: boolean;
  life: number;
  dir: number;
  seed: number;
  resident: number;
  rainS: Float32Array;
  rainBorn: Float32Array;
  rainN: number;
}
interface Tongue {
  a: number;
  age: number;
  life: number;
  sp: number;
  curl: number;
  seed: number;
  r0: number;
  hot: boolean;
}
interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  gi: number;
}
interface Eject {
  t: number;
  a: number;
}

const NA = 360;
const RB = 120;
/** Radius tables in quarter cells, up to the prototype's 118 px draw radius. */
const RQ = 4;
const RMAX = 118;
const NRT = RMAX * RQ + 2;
const VEL = 70;
const TAU = Math.PI * 2;
/** Emissive byte per unit of the prototype's glow factor. */
const EK = 255;

const shapeB = (u: number): number => {
  if (u < 0) return 0;
  if (u < 0.32) {
    const s = fsin((u / 0.32) * Math.PI * 0.5);
    return -0.45 * s * s;
  }
  const v = u - 0.32;
  return -0.45 * DMath.exp(-v * 30) + DMath.exp(-v * 2.6) * fsin(v * 7.5 + 0.05) * 1.05;
};

export class SupernovaIdle {
  readonly skin: BodySkin;
  readonly layer: BodySpaceLayer;
  /** The halo strength the prototype's bloom used (about 1 at full fuel, at rest), for the behaviour's GlowSprite. */
  halo = 0.6;

  private readonly W: number;
  private readonly H: number;
  private readonly cx: number;
  private readonly cy: number;
  private readonly R0: number;
  private readonly ids: SupernovaRig['ids'];
  private readonly rig: SupernovaRig;
  private readonly grad: Uint32Array;
  private readonly gradRgb: Float32Array;
  private readonly NG: number;
  private readonly rc: Uint32Array;
  /** Cells within the draw radius, and per cell: radius, angle, angle bin, gradient index, corona/prominence ramp index. */
  private readonly cells: Int32Array;
  private readonly rr: Float32Array;
  private readonly th: Float32Array;
  private readonly ab: Uint16Array;
  private readonly GI: Float32Array;
  private readonly LI: Float32Array;
  private readonly phase: Uint8Array;
  private readonly weight: Uint8Array;
  /** The live limb per 1° bin (smoothed), its cos/sin, and the mean gradient index per radius. */
  private readonly limb = new Float32Array(NA);
  private readonly limbS = new Float32Array(NA);
  private readonly cosA = new Float32Array(NA);
  private readonly sinA = new Float32Array(NA);
  private readonly prof = new Float32Array(RB);
  private limbVersion = -1;

  /* per-frame radius tables: the delayed beat, the light ring on the disc and in the corona */
  private readonly bT = new Float32Array(NRT);
  private readonly ringD = new Float32Array(NRT);
  private readonly ringC = new Float32Array(NRT);
  private readonly laneA = new NoiseLattice();
  private readonly laneB = new NoiseLattice();
  private readonly fireA = new NoiseLattice();
  private readonly fireB = new NoiseLattice();
  private readonly flick = new NoiseLattice();

  /* the idle's own clock and state */
  readonly clock = new IdleClock();
  private readonly rng: IdleRng;
  private readonly seed: number;
  private w = 1;
  private beats = new Pool<Beat>(12, () => ({ t: 0, a: 0 }));
  private nextBeat = 1.2;
  private beatCount = 0;
  private ejectAt = -1;
  private flares = new Pool<Flare>(6, () => ({ t: 0, x: 0, y: 0, a: 0 }));
  private nextFlare = 4;
  private proms = new Pool<Prom>(16, () => ({
    t: 0,
    a: 0,
    sep: 0,
    h: 0,
    loop: true,
    life: 0,
    dir: 1,
    seed: 0,
    resident: -1,
    rainS: new Float32Array(RAIN),
    rainBorn: new Float32Array(RAIN),
    rainN: 0,
  }));
  private nextProm = 3.5;
  private readonly residents: { next: number; live: boolean }[];
  private tongues = new Pool<Tongue>(160, () => ({
    a: 0,
    age: 0,
    life: 1,
    sp: 0,
    curl: 0,
    seed: 0,
    r0: 0,
    hot: false,
  }));
  private sparks = new Pool<Spark>(320, () => ({ x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 1, gi: 0 }));
  private ejecta = new Pool<Eject>(4, () => ({ t: 0, a: 0 }));
  private drawnAt = -1;
  private readonly ring: NovaIdleInput[] = Array.from({ length: RING }, () => ({
    fuel: 1,
    hurt: false,
    rest: 1,
    live: 1,
  }));
  private readonly ringTick = new Int32Array(RING).fill(-1);
  private readonly lastIn: NovaIdleInput = { fuel: 1, hurt: false, rest: 1, live: 1 };

  constructor(
    map: { w: number; h: number; version: number; material: Uint8Array; baseColor: Uint32Array },
    rig: SupernovaRig,
    gradient: readonly string[],
    granules: { phase: Uint8Array; weight: Uint8Array },
    seed: number,
    slot: number,
  ) {
    const W = (this.W = map.w);
    const H = (this.H = map.h);
    const N = W * H;
    this.rig = rig;
    this.ids = rig.ids;
    this.cx = rig.core.x;
    this.cy = rig.core.y;
    this.R0 = rig.radius;
    this.seed = seed;
    this.rng = new IdleRng(seed);
    this.phase = granules.phase;
    this.weight = granules.weight;
    this.skin = new BodySkin(W, H);
    // z 10.5: over the body and the fight-plane debris, and outside the titan band (z < 10) so the unified look does not
    // outline the fire: the prototype's flames, sparks and prominences have no outline
    this.layer = new BodySpaceLayer(`supernova-idle-${slot}`, 10.5, 400, 400, this.cx, this.cy);
    this.residents = rig.prominences.map((_, k) => ({ next: -1 - k * 1.7, live: false }));

    // the star's own gradient (`art.params.gradient`), every disc colour → a position on it
    this.NG = gradient.length;
    this.grad = new Uint32Array(this.NG);
    this.gradRgb = new Float32Array(this.NG * 3);
    for (let k = 0; k < this.NG; k++) {
      const c = hex(gradient[k]!);
      this.grad[k] = c;
      this.gradRgb[k * 3] = pr(c);
      this.gradRgb[k * 3 + 1] = pg(c);
      this.gradRgb[k * 3 + 2] = pb(c);
    }
    this.rr = new Float32Array(N);
    this.th = new Float32Array(N);
    this.ab = new Uint16Array(N);
    this.GI = new Float32Array(N);
    this.LI = new Float32Array(N);
    const list: number[] = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const dx = x + 0.5 - this.cx;
        const dy = y + 0.5 - this.cy;
        const r = DMath.hypot(dx, dy);
        const a = DMath.atan2(dy, dx);
        this.rr[i] = r;
        this.th[i] = a;
        this.ab[i] = ((Math.floor((a / TAU) * NA) % NA) + NA) % NA;
        if (r <= RMAX) list.push(i);
      }
    this.cells = Int32Array.from(list);
    for (let a = 0; a < NA; a++) {
      const ang = ((a + 0.5) / NA) * TAU;
      this.cosA[a] = fcos(ang);
      this.sinA[a] = fsin(ang);
    }
    const mat = map.material;
    const base = map.baseColor;
    for (let i = 0; i < N; i++) if (this.isDisc(mat[i]!)) this.GI[i] = this.gradPos(base[i]!);
    // the corona's own ramp (unique colours by luminance, 16 quantiles, then two white-hot steps); prominences likewise
    this.rc = this.rampOf(map, this.ids.corona);
    const rp = this.rampOf(map, this.ids.prominence);
    const lumOf = (c: number): number => 0.3 * pr(c) + 0.59 * pg(c) + 0.11 * pb(c);
    const lumC = Array.from(this.rc, lumOf);
    const lumP = Array.from(rp, lumOf);
    for (let i = 0; i < N; i++) {
      const m = mat[i]!;
      if (m !== this.ids.corona && m !== this.ids.prominence) continue;
      const L = m === this.ids.corona ? lumC : lumP;
      const l = lumOf(base[i]!);
      let k = 0;
      while (k < 15 && L[k + 1]! <= l) k++;
      const span = L[k + 1]! - L[k]! || 1;
      this.LI[i] = Math.min(16.9, k + Math.max(0, Math.min(1, (l - L[k]!) / span)));
    }
    this.updateLimb(map, true);
  }

  private isDisc(m: number): boolean {
    const d = this.ids;
    return m === d.core || m === d.inner || m === d.photosphere;
  }

  private gradPos(c: number): number {
    const r = pr(c);
    const g = pg(c);
    const b = pb(c);
    const G = this.gradRgb;
    let best = 1e9;
    let pos = 0;
    for (let k = 0; k < this.NG - 1; k++) {
      const a0 = G[k * 3]!;
      const a1 = G[k * 3 + 1]!;
      const a2 = G[k * 3 + 2]!;
      const ux = G[k * 3 + 3]! - a0;
      const uy = G[k * 3 + 4]! - a1;
      const uz = G[k * 3 + 5]! - a2;
      const L2 = ux * ux + uy * uy + uz * uz || 1;
      let u = ((r - a0) * ux + (g - a1) * uy + (b - a2) * uz) / L2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const dx = r - a0 - ux * u;
      const dy = g - a1 - uy * u;
      const dz = b - a2 - uz * u;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) {
        best = d;
        pos = k + u;
      }
    }
    return pos;
  }

  private rampOf(map: { material: Uint8Array; baseColor: Uint32Array }, m: number): Uint32Array {
    const cs: number[] = [];
    // the prototype sorts every cell's colour (duplicates weight the quantiles), as here
    for (let i = 0; i < map.material.length; i++)
      if (map.material[i] === m) cs.push((map.baseColor[i]! | 0xff000000) >>> 0);
    const lum = (c: number): number => 0.3 * pr(c) + 0.59 * pg(c) + 0.11 * pb(c);
    cs.sort((a, b) => lum(a) - lum(b));
    const out = new Uint32Array(18);
    for (let k = 0; k < 16; k++)
      out[k] = cs.length
        ? cs[Math.min(cs.length - 1, Math.floor(((k + 0.5) / 16) * cs.length))]!
        : rgba(0, 0, 0);
    const top = out[15]!;
    out[16] = rgba(Math.min(255, pr(top) + 40), Math.min(255, pg(top) + 40), Math.min(255, pb(top) + 30));
    out[17] = rgba(255, 250, 240);
    return out;
  }

  /** The live limb (outermost live disc cell per 1°, smoothed over 7°) and the radial gradient profile. */
  private updateLimb(map: { version: number; material: Uint8Array }, force = false): void {
    // whenever the matter changed (O(disc), ≈ 0.1 ms): a function of the map alone, the same at any frame rate
    if (!force && map.version === this.limbVersion) return;
    this.limbVersion = map.version;
    const limb = this.limb;
    limb.fill(0);
    const prof = this.prof;
    prof.fill(0);
    const profN = new Float32Array(RB);
    const mat = map.material;
    const cells = this.cells;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k]!;
      if (!this.isDisc(mat[i]!)) continue;
      const r = this.rr[i]!;
      const rb = Math.min(RB - 1, Math.floor(r));
      prof[rb] += this.GI[i]!;
      profN[rb]++;
      const a = this.ab[i]!;
      if (r > limb[a]!) limb[a] = r;
    }
    for (let r = 0; r < RB; r++)
      prof[r] = profN[r] ? prof[r]! / profN[r]! : r > 0 ? prof[r - 1]! : this.NG - 2;
    for (let a = 0; a < NA; a++) if (!limb[a]) limb[a] = this.R0;
    for (let a = 0; a < NA; a++) {
      let s = 0;
      for (let k = -3; k <= 3; k++) s += limb[(a + k + NA) % NA]!;
      this.limbS[a] = s / 7;
    }
  }

  private limbOf(a: number): number {
    return this.limbS[((Math.floor((a / TAU) * NA) % NA) + NA) % NA]!;
  }

  /** A new round: the idle starts over (pre-aged residents, so the star is never bare). */
  reset(): void {
    this.clock.reset();
    this.rng.reseed(this.seed);
    this.w = 1;
    this.beats.clear();
    this.nextBeat = 1.2;
    this.beatCount = 0;
    this.ejectAt = -1;
    this.flares.clear();
    this.nextFlare = 4;
    this.proms.clear();
    this.nextProm = 3.5;
    for (let k = 0; k < this.residents.length; k++) {
      this.residents[k]!.next = -1 - k * 1.7;
      this.residents[k]!.live = false;
    }
    this.tongues.clear();
    this.sparks.clear();
    this.ejecta.clear();
    this.layer.clear();
    this.drawnAt = -1;
    this.ringTick.fill(-1);
  }

  /** The fight's state this sim tick (called from the behaviour's `update`; render-side data the sim never reads). */
  record(tick: number, inp: NovaIdleInput): void {
    // the idle's clock starts with the round's first sim tick, not the first drawn frame (so it is the same at any rate)
    if (this.clock.last < 0) this.clock.last = tick - 1;
    const k = tick & (RING - 1);
    const r = this.ring[k]!;
    r.fuel = inp.fuel;
    r.hurt = inp.hurt;
    r.rest = inp.rest;
    r.live = inp.live;
    this.ringTick[k] = tick;
    const l = this.lastIn;
    l.fuel = inp.fuel;
    l.hurt = inp.hurt;
    l.rest = inp.rest;
    l.live = inp.live;
  }

  private inputAt(tick: number): NovaIdleInput {
    const k = tick & (RING - 1);
    return this.ringTick[k] === tick ? this.ring[k]! : this.lastIn;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  the choreography: one fixed step per sim tick
   * ---------------------------------------------------------------------------------------------- */

  /** Catch up with the sim tick (fixed 1/60 s steps). Returns whether anything advanced. */
  advance(tick: number): boolean {
    const n = this.clock.due(tick);
    for (let i = 0; i < n; i++) this.step(this.inputAt(tick - n + 1 + i));
    return n > 0;
  }

  private rnd(): number {
    return this.rng.next();
  }

  private beat(t: number, dbl: boolean, k: number): void {
    const b = this.beats.alloc();
    if (b) {
      b.t = t;
      b.a = (0.85 + this.rnd() * 0.3) * (dbl ? 0.6 : 1) * (1 + (1 - k) * 0.6);
    }
    this.beatCount++;
    if (this.beatCount % 3 === 0 && !dbl) this.ejectAt = t + 0.35;
  }

  private B(t: number): number {
    let s = 0;
    const P = this.beats;
    for (let i = 0; i < P.n; i++) {
      const b = P.items[i]!;
      s += shapeB(t - b.t) * b.a;
    }
    return s;
  }

  private step(inp: NovaIdleInput): void {
    const dt = IdleClock.DT;
    const C = this.clock;
    C.t += dt;
    const t = C.t;
    const k = inp.fuel;
    const hurt = inp.hurt ? 1 : 0;
    // the idle yields to the fight: rest eases in and out over ~8 ticks
    const target = inp.rest * inp.live;
    this.w += clampN(target - this.w, -0.125, 0.125);
    const w = this.w;
    const on = w >= 0.5;

    // the heartbeat keeps time whatever happens (its swell is scaled by the rest weight when drawn)
    while (t >= this.nextBeat) {
      const period = (2.1 + 1.9 * k) * (inp.hurt ? 0.6 : 1);
      this.beat(this.nextBeat, false, k);
      if (this.rnd() < (1 - k) * 0.55) this.beat(this.nextBeat + 0.38 + this.rnd() * 0.1, true, k);
      this.nextBeat +=
        period * (1 + (this.rnd() - 0.5) * 0.9 * (1 - k)) * (this.rnd() < (1 - k) * 0.2 ? 1.8 : 1);
    }
    for (let i = this.beats.n - 1; i >= 0; i--) if (t - this.beats.items[i]!.t > 4) this.beats.kill(i);

    if (t > this.nextFlare) {
      if (on) this.flare(t);
      this.nextFlare = t + (5 + this.rnd() * 6) * (inp.hurt ? 0.55 : 1) * (0.6 + 0.4 * k);
    }
    if (on)
      for (let q = 0; q < this.residents.length; q++) {
        const R = this.residents[q]!;
        if (!R.live && t > R.next) this.spawnResident(q, R.next < 0 ? t - 1.2 - q * 1.3 : t);
      }
    if (t > this.nextProm) {
      if (on) this.spawnProm(t, false, NaN);
      this.nextProm = t + 3 + this.rnd() * 4;
    }
    if (this.ejectAt > 0 && t > this.ejectAt) {
      if (on) this.eject(t);
      this.ejectAt = -1;
    }
    // ambient tongues (a Poisson rate) and the burst that answers each beat ~1.18 s later
    let nt = dt * (9 + 8 * hurt) * w;
    while (nt > 0) {
      if (this.rnd() < nt) this.tongue(this.rnd() * TAU, false);
      nt -= 1;
    }
    for (let i = 0; i < this.beats.n; i++) {
      const u = t - this.beats.items[i]!.t - 0.32 - 60 / 70;
      if (u > 0 && u < dt + 1e-6) {
        const burst = Math.round(14 * w);
        for (let q = 0; q < burst; q++) this.tongue(this.rnd() * TAU, true);
      }
    }
    if (this.rnd() < dt * (6 + 10 * (1 - k) + 10 * hurt) * w) {
      const a = this.rnd() * TAU;
      const L = this.limbOf(a);
      this.spark(
        fcos(a) * L,
        fsin(a) * L,
        a + (this.rnd() - 0.5) * 0.6,
        12 + this.rnd() * 30,
        10 + this.rnd() * 2,
      );
    }

    // ageing and retirement (the prototype did these while drawing; here they are part of the fixed step)
    for (let i = this.proms.n - 1; i >= 0; i--) {
      const P = this.proms.items[i]!;
      const u = t - P.t;
      if (u > P.life + 2.6) {
        if (P.resident >= 0) {
          const R = this.residents[P.resident]!;
          R.live = false;
          R.next = t + 0.4 + this.rnd() * 1.4;
        }
        this.proms.kill(i);
        continue;
      }
      // coronal rain: after the snap, drops gather on the strands (every 9th sample, 8 % a step, up to 30)
      if (P.loop && u > P.life) {
        const grow = ss(0, 1.1, u);
        const snapK = ss(P.life, P.life + 0.5, u);
        for (let q = 0; q <= 90; q += 9) {
          const sp = q / 90;
          if (Math.abs(sp - 0.5) > grow * 0.5) continue;
          if (Math.abs(sp - 0.5) < 0.04 + snapK * 0.12) continue;
          if (P.rainN < RAIN && this.rnd() < 0.08) {
            P.rainS[P.rainN] = sp;
            P.rainBorn[P.rainN] = u;
            P.rainN++;
          }
        }
      }
    }
    for (let i = this.ejecta.n - 1; i >= 0; i--) if (t - this.ejecta.items[i]!.t > 2.6) this.ejecta.kill(i);
    for (let i = this.flares.n - 1; i >= 0; i--) if (t - this.flares.items[i]!.t >= 3.5) this.flares.kill(i);
    for (let i = this.tongues.n - 1; i >= 0; i--) {
      const F = this.tongues.items[i]!;
      F.age += dt;
      if (F.age > F.life) this.tongues.kill(i);
    }
    for (let i = this.sparks.n - 1; i >= 0; i--) {
      const p = this.sparks.items[i]!;
      p.age += dt;
      if (p.age > p.life) {
        this.sparks.kill(i);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - dt * 0.6;
      p.vy *= 1 - dt * 0.6;
    }
  }

  private flare(t: number): void {
    const a = this.rnd() * TAU;
    const rr = 0.55 + this.rnd() * 0.35;
    const L = this.limbOf(a);
    const f = this.flares.alloc();
    if (f) {
      f.t = t;
      f.x = fcos(a) * L * rr;
      f.y = fsin(a) * L * rr;
      f.a = a;
    }
    for (let q = 0; q < 40; q++)
      this.spark(
        fcos(a) * L * 0.98,
        fsin(a) * L * 0.98,
        a + (this.rnd() - 0.5) * 1.3,
        25 + this.rnd() * 55,
        12.6,
      );
    if (this.rnd() < 0.6) this.spawnProm(t, true, a);
  }

  private spawnProm(t: number, force: boolean, angle: number): void {
    if (!force && this.proms.n >= 6) return;
    const P = this.proms.alloc();
    if (!P) return;
    P.t = t;
    P.a = Number.isNaN(angle) ? this.rnd() * TAU : angle;
    P.sep = 0.2 + this.rnd() * 0.22;
    P.h = 26 + this.rnd() * 20;
    P.loop = this.rnd() < 0.62;
    P.life = 4 + this.rnd() * 3;
    P.dir = this.rnd() < 0.5 ? -1 : 1;
    P.seed = this.rnd() * 100;
    P.resident = -1;
    P.rainN = 0;
  }

  private spawnResident(q: number, born: number): void {
    const P = this.proms.alloc();
    if (!P) return;
    const R = this.rig.prominences[q]!;
    P.t = born;
    P.a = (R.a0 + R.a1) / 2 + (this.rnd() - 0.5) * 0.12;
    P.sep = (Math.abs(R.a1 - R.a0) / 2) * (0.85 + this.rnd() * 0.4);
    P.h = R.h * (0.9 + this.rnd() * 0.35);
    P.loop = R.kind === 'loop';
    P.life = 5 + this.rnd() * 3.5;
    P.dir = R.a1 > R.a0 ? 1 : -1;
    P.seed = this.rnd() * 100;
    P.resident = q;
    P.rainN = 0;
    this.residents[q]!.live = true;
  }

  private tongue(a: number, hot: boolean): void {
    const st = this.rig.streamers;
    if (this.rnd() < 0.55 && st.length) {
      const S = st[Math.floor(this.rnd() * st.length)]!;
      a = S.a + (this.rnd() - 0.5) * S.hw * 2.2;
    }
    const F = this.tongues.alloc();
    if (!F) return;
    F.a = a;
    F.age = 0;
    F.life = 1.0 + this.rnd() * 1.2;
    F.sp = 14 + this.rnd() * 20;
    F.curl = (this.rnd() - 0.5) * 2.0;
    F.seed = this.rnd() * 50;
    F.r0 = 2.2 + this.rnd() * 1.8 + (hot ? 1 : 0);
    F.hot = hot;
  }

  private spark(x: number, y: number, a: number, sp: number, gi: number): void {
    const p = this.sparks.alloc();
    if (!p) return;
    p.x = x;
    p.y = y;
    p.vx = fcos(a) * sp;
    p.vy = fsin(a) * sp;
    p.age = 0;
    p.life = 0.8 + this.rnd() * 1.4;
    p.gi = gi;
  }

  private eject(t: number): void {
    const st = this.rig.streamers;
    if (!st.length) return;
    const S = st[Math.floor(this.rnd() * st.length)]!;
    const E = this.ejecta.alloc();
    if (!E) return;
    E.t = t;
    E.a = S.a + (this.rnd() - 0.5) * 0.3;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  drawing (once per advanced tick; the skin is presented every frame)
   * ---------------------------------------------------------------------------------------------- */

  private gradIdx(gi: number, x: number, y: number): number {
    let k = Math.floor(gi + BAY8[((y & 7) << 3) | (x & 7)]! - 0.5);
    if (k < 0) k = 0;
    else if (k >= this.NG) k = this.NG - 1;
    return k;
  }

  /**
   * Draw the idle for the current step into the skin and the layer, then present the skin as the body. `body` is the
   * fighter's body layer for this frame. Redraws only when the idle advanced; otherwise re-presents the last skin.
   */
  render(body: RenderLayer, map: IdleMap): void {
    const inp = this.inputAt(this.clock.last);
    if (this.drawnAt !== this.clock.last) {
      this.drawnAt = this.clock.last;
      this.updateLimb(map);
      this.drawSkin(map, inp);
      this.layer.begin(body);
      this.drawLayer(inp, map.material);
      this.layer.end();
      this.skin.present(body, true);
    } else {
      this.layer.follow(body);
      this.skin.present(body, false);
    }
  }

  private drawSkin(map: IdleMap, inp: NovaIdleInput): void {
    const t = this.clock.t;
    const k = inp.fuel;
    const hurt = inp.hurt ? 1 : 0;
    const wl = this.w;
    const fm = Math.max(0.5, wl) * inp.live;
    const cool = (1 - k) * 3.2;
    const R0 = this.R0;
    const W = this.W;
    const skin = this.skin;
    skin.copyFrom(map.pixels, map.emissive);
    const px = skin.px;
    const em = skin.emis;
    const mat = map.material;
    const ids = this.ids;

    // radius tables for this step: the beat as it arrives at radius r (r / VEL late), and the light rings
    const beats = this.beats;
    for (let q = 0; q < NRT; q++) {
      const r = q / RQ;
      this.bT[q] = this.B(t - r / VEL) * wl;
      let rd = 0;
      let rc = 0;
      for (let i = 0; i < beats.n; i++) {
        const bt = beats.items[i]!;
        const u = t - bt.t - 0.32;
        if (u > 0 && u < 1.6) {
          const z = (r - u * 62) / 2.6;
          rd += 2.4 * bt.a * DMath.exp(-(z * z)) * (1 - u / 1.6);
        }
        if (u > 0.5 && u < 2.4) {
          const z = (r - u * 62) / 4;
          rc += 3 * bt.a * DMath.exp(-(z * z)) * (1 - u / 2.4);
        }
      }
      this.ringD[q] = rd * wl;
      this.ringC[q] = rc * wl;
    }
    this.halo = (0.55 + 0.45 * Math.max(-0.5, this.B(t) * wl)) * (0.45 + 0.55 * k) + hurt * 0.15;

    // noise lattices for this step (the same values as `vnoise`, hashed once per lattice point)
    this.laneA.prepare(t * 0.35, -t * 0.22, W / 4.2 + t * 0.35, this.H / 4.2 - t * 0.22);
    this.laneB.prepare(-t * 0.18, 7, W / 9 - t * 0.18, this.H / 9 + 7);
    this.fireA.prepare(40 - Math.PI * 11, -0.13 - t * 1.5, 40 + Math.PI * 11, RMAX * 0.13 - t * 1.5);
    this.fireB.prepare(9 - Math.PI * 19, -0.22 - t * 2.4, 9 + Math.PI * 19, RMAX * 0.22 - t * 2.4);
    const flicker = hurt && vnoise(t * 0.7, 3) > 0.55;
    if (flicker) this.flick.prepare(t * 6, 0, W / 3 + t * 6, this.H / 3);

    const cells = this.cells;
    const limbS = this.limbS;
    const flares = this.flares;
    // a cell the fight has changed (bruised, burning, cracked, charred, assimilated, glowing hot) is shown as the matter
    // module draws it; the idle recolours only pristine matter
    const integ = map.integrity;
    const flags = map.flags;
    const infect = map.infection;
    const changed = (i: number): boolean =>
      integ[i]! < 255 || (flags[i]! & FIGHT_FLAGS) !== 0 || infect[i]! !== 0;
    for (let n = 0; n < cells.length; n++) {
      const i = cells[n]!;
      const m = mat[i]!;
      const r = this.rr[i]!;
      const a = this.ab[i]!;
      const lim = limbS[a]!;
      const q = (r * RQ) | 0;
      const b = this.bT[q]!;
      const x = i % W;
      const y = (i - x) / W;
      const bay = BAY8[((y & 7) << 3) | (x & 7)]!;
      // the heartbeat moves the EDGE in whole pixels: up to 3 px of hot rim on the swell, a pixel lost on the held breath
      let swellPx = b * 2.8;
      swellPx = swellPx < -1.5 ? -1.5 : swellPx > 3.2 ? 3.2 : swellPx;
      if (swellPx > 0 && r > lim + 0.5 && r <= lim + 0.5 + swellPx) {
        // a void cell is filled only where the limb below it is live (a crater stays a hole)
        if (m === 0 && !this.limbLive(mat, a, lim)) continue;
        const depth = (r - lim - 0.5) / swellPx;
        const gi = 11.6 - depth * 3.2 - cool + b * 0.6;
        px[i] = this.grad[this.gradIdx(gi, x, y)]!;
        em[i] = 0.3 * EK;
        continue;
      }
      if (m === 0) continue;
      const disc = m === ids.core || m === ids.inner || m === ids.photosphere;
      if (disc) {
        if (r > lim + 0.5 + Math.min(0, swellPx)) {
          // beyond the limb this step (the held breath pulls the edge in): not drawn
          px[i] = 0;
          em[i] = 0;
          continue;
        }
        // damage, heat and char drawn by the matter module stay as they are
        if (changed(i)) continue;
        let gi = this.GI[i]!;
        gi += b * (b > 0 ? 1.7 : 2.4);
        gi += this.ringD[q]!;
        const wt = this.weight[i]!;
        if (wt > 0) {
          const ww = wt / 255;
          const ph = this.phase[i]!;
          const phr = (ph / 255) * 6.283;
          gi +=
            ww *
            (fsin(phr * 3 + t * (1.4 + (ph & 7) * 0.12)) * 0.75 + fsin(phr * 7 - t * 2.3) * 0.35) *
            (1 + hurt * 0.6) *
            fm;
          const lane =
            this.laneA.sample(x / 4.2 + t * 0.35, y / 4.2 - t * 0.22) * 0.6 +
            this.laneB.sample(x / 9 - t * 0.18, y / 9 + 7) * 0.4;
          if (lane < 0.42) gi -= (0.42 - lane) * 3.2 * (r / R0) * fm;
        }
        if (flares.n) {
          const lx = x + 0.5 - this.cx;
          const ly = y + 0.5 - this.cy;
          for (let fi = 0; fi < flares.n; fi++) {
            const f = flares.items[fi]!;
            const u = t - f.t;
            const ex = lx - f.x;
            const ey = ly - f.y;
            const d = Math.sqrt(ex * ex + ey * ey);
            if (d < 12) {
              const z = d / 3.5;
              gi += 5 * DMath.exp(-u * 2.2) * DMath.exp(-(z * z));
            }
            if (u < 2.5) {
              const z = (d - u * 34) / 2.2;
              if (z > -4 && z < 4) gi += 1.6 * DMath.exp(-(z * z)) * (1 - u / 2.5);
            }
          }
        }
        if (flicker) gi += (this.flick.sample(x / 3 + t * 6, y / 3) - 0.6) * 2.4;
        gi -= cool * (0.5 + 0.5 * (r / R0));
        px[i] = this.grad[this.gradIdx(gi, x, y)]!;
        em[i] = gi > 9.5 ? Math.min(255, (gi - 9.5) * 0.18 * EK) : 0;
        continue;
      }
      if (m !== ids.corona && m !== ids.prominence) continue;
      const out = r - lim;
      if (out < -1) {
        px[i] = 0;
        em[i] = 0;
        continue;
      }
      if (m === ids.prominence) {
        // the living prominences take over from the painted ones; their feet become rim
        if (out < 2.5) {
          px[i] = this.grad[this.gradIdx(this.prof[Math.min(RB - 1, Math.floor(r))]! + 1.2 - cool, x, y)]!;
          em[i] = 0;
        } else {
          px[i] = 0;
          em[i] = 0;
        }
        continue;
      }
      if (changed(i)) continue;
      // fire, pixel-art style: a noise field rising outward decides which pixels burn this step
      const th = this.th[i]!;
      const nz =
        (this.fireA.sample(th * 11 + 40, out * 0.13 - t * 1.5) * 0.78 +
          this.fireB.sample(th * 19 + 9, out * 0.22 - t * 2.4) * 0.22 -
          0.5) *
        fm;
      const LIi = this.LI[i]!;
      // tips burn away and regrow; on the swell the flames reach further
      if (out > 2 && LIi - out * 0.07 * (1.15 - 0.45 * (b > 0 ? b : 0)) + nz * 7 < 1.6) {
        px[i] = 0;
        em[i] = 0;
        continue;
      }
      const li = LIi + nz * 5.2 + b * 2.4 - cool * 1.4 + this.ringC[q]!;
      let kk = Math.floor(li + bay - 0.5);
      kk = kk < 0 ? 0 : kk > 17 ? 17 : kk;
      if (kk <= 0 && li < 0.3) {
        px[i] = 0;
        em[i] = 0;
        continue;
      }
      px[i] = this.rc[kk]!;
      em[i] = kk > 12 ? 0.14 * EK : 0;
    }

    // flare flashes bloom hard (glow only, on the disc)
    for (let fi = 0; fi < flares.n; fi++) {
      const f = flares.items[fi]!;
      const u = t - f.t;
      if (u >= 0.6) continue;
      const fx = Math.round(this.cx + f.x);
      const fy = Math.round(this.cy + f.y);
      const e = 230 * (1 - u / 0.6);
      for (let q = 0; q < 18; q++) {
        const gx = fx + Math.round(fcos(q) * q * 0.4);
        const gy = fy + Math.round(fsin(q) * q * 0.4);
        if (gx < 0 || gy < 0 || gx >= W || gy >= this.H) continue;
        const j = gy * W + gx;
        if (px[j] === 0) continue;
        em[j] = Math.min(255, em[j]! + e);
      }
    }
  }

  /** Is the live limb under angle bin `a` disc matter (the cell one in from the smoothed limb)? */
  private limbLive(mat: Uint8Array, a: number, lim: number): boolean {
    const x = Math.floor(this.cx + this.cosA[a]! * (lim - 1));
    const y = Math.floor(this.cy + this.sinA[a]! * (lim - 1));
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return false;
    return this.isDisc(mat[y * this.W + x]!);
  }

  /** A shaded dot (the prototype's `disc`), in map coordinates; glow where it is hot. */
  private dot(cx: number, cy: number, rad: number, gi: number, glow: boolean): void {
    const R = Math.max(0.5, rad);
    const r2 = R * R;
    const L = this.layer;
    for (let y = Math.floor(cy - R); y <= cy + R; y++)
      for (let x = Math.floor(cx - R); x <= cx + R; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const g = gi + (1 - d2 / r2) * (glow ? 0.8 : 0.6);
        L.putPal(x, y, this.grad, this.gradIdx(g, x, y), glow && gi > 10 ? 0.15 * EK : 0);
      }
  }

  private drawLayer(inp: NovaIdleInput, mat: Uint8Array): void {
    const t = this.clock.t;
    const k = inp.fuel;
    const cool = (1 - k) * 3.2;
    const L = this.layer;
    const CX = this.cx;
    const CY = this.cy;
    const wl = this.w;
    const live = inp.live;
    if (live <= 0.02) return;

    // ---- prominences: rise, braid, sway, snap, rain ----
    const sizeNow = 1 + 0.038 * this.B(t - 60 / 70) * wl;
    for (let pi = 0; pi < this.proms.n; pi++) {
      const P = this.proms.items[pi]!;
      const u = t - P.t;
      const grow = ss(0, 1.1, u);
      const snapT = P.life;
      const snapping = P.loop && u > snapT;
      const a0 = P.a - P.sep + fsin(u * 0.6 + P.seed) * 0.03;
      const a1 = P.a + P.sep + fsin(u * 0.5 + P.seed * 2) * 0.03;
      const l0 = this.limbOf(a0) * sizeNow * 0.94;
      const l1 = this.limbOf(a1) * sizeNow * 0.94;
      const f0x = fcos(a0) * l0;
      const f0y = fsin(a0) * l0;
      const f1x = fcos(a1) * l1;
      const f1y = fsin(a1) * l1;
      // a footpoint on dead matter (a crater, a stripped limb) has nothing to stand on
      if (!this.footLive(mat, f0x, f0y) || !this.footLive(mat, f1x, f1y)) continue;
      const fade = (1 - ss(P.life + 1.2, P.life + 2.6, u)) * live;
      const H = P.h * (0.35 + 0.65 * grow) * (0.85 + 0.15 * fsin(u * 1.3 + P.seed)) * (0.7 + 0.3 * k);
      const kk = H * 1.35;
      const lean = P.loop ? 0 : 0.55 * P.dir;
      const c0x = f0x + fcos(a0 + lean) * kk;
      const c0y = f0y + fsin(a0 + lean) * kk;
      const m1 = P.loop ? 1 : 0.55;
      const c1x = f1x + fcos(a1 + lean * 0.5) * kk * m1;
      const c1y = f1y + fsin(a1 + lean * 0.5) * kk * m1;
      // footpoints brighten before anything rises (anticipation)
      if (u < 1.6) {
        const fl = (1 - ss(0.8, 1.6, u)) * ss(0, 0.3, u);
        if (fl > 0.05) {
          this.dot(CX + f0x, CY + f0y, 1 + fl * 1.2, 9 + fl * 2 - cool, false);
          this.dot(CX + f1x, CY + f1y, 1 + fl * 1.2, 9 + fl * 2 - cool, false);
        }
      }
      const N = 90;
      const snapK = snapping ? ss(snapT, snapT + 0.5, u) : 0;
      const loose = !P.loop && u > P.life ? ss(P.life, P.life + 2.4, u) : 0;
      for (let q = 0; q <= N; q++) {
        const sp = q / N;
        if (P.loop) {
          if (Math.abs(sp - 0.5) > grow * 0.5) continue;
          if (snapping && Math.abs(sp - 0.5) < 0.04 + snapK * 0.12) continue;
        } else {
          if (sp > grow) continue;
          if (sp < loose * 0.85) continue;
          if (loose > 0 && h2(q, Math.floor(u * 12)) < loose * 0.5) continue;
        }
        const v = 1 - sp;
        let px = v * v * v * f0x + 3 * v * v * sp * c0x + 3 * v * sp * sp * c1x + sp * sp * sp * f1x;
        let py = v * v * v * f0y + 3 * v * v * sp * c0y + 3 * v * sp * sp * c1y + sp * sp * sp * f1y;
        // after the snap, the free ends sag back toward the star
        if (snapK > 0) {
          const drop = snapK * DMath.pow(1 - Math.abs(sp - 0.5) * 2, 1.5) * 0.55;
          px *= 1 - drop * 0.4;
          py *= 1 - drop * 0.4;
        }
        if (!P.loop && u > P.life) {
          const dd = (u - P.life) * 16;
          px += fcos(P.a) * dd;
          py += fsin(P.a) * dd;
        }
        const tx = 3 * v * v * (c0x - f0x) + 6 * v * sp * (c1x - c0x) + 3 * sp * sp * (f1x - c1x);
        const ty = 3 * v * v * (c0y - f0y) + 6 * v * sp * (c1y - c0y) + 3 * sp * sp * (f1y - c1y);
        const tl = Math.sqrt(tx * tx + ty * ty) || 1;
        const nx = -ty / tl;
        const ny = tx / tl;
        const thick = (1.1 + 1.7 * fsin(Math.PI * sp)) * (P.loop ? 1 : 1 - sp * 0.55) * fade;
        const fl = fsin(sp * 16 - u * 5.5 + P.seed) * 0.5 + 0.5;
        const gi = (7.6 + fl * fl * 3.0 - cool) * (0.85 + 0.15 * fade);
        for (let side = -1; side <= 1; side += 2) {
          const br = fsin(sp * 22 + u * 3.2 * side + P.seed) * (1.1 + thick * 0.4);
          this.dot(
            CX + px + nx * br * side * 0.8,
            CY + py + ny * br * side * 0.8,
            thick * 0.75,
            gi - (side > 0 ? 0.8 : 0),
            true,
          );
        }
      }
      for (let d = 0; d < P.rainN; d++) {
        const age = u - P.rainBorn[d]!;
        const s0 = P.rainS[d]!;
        const s2 = s0 < 0.5 ? Math.max(0, s0 - age * 0.32) : Math.min(1, s0 + age * 0.32);
        if (s2 <= 0.01 || s2 >= 0.99) continue;
        const v = 1 - s2;
        let px = v * v * v * f0x + 3 * v * v * s2 * c0x + 3 * v * s2 * s2 * c1x + s2 * s2 * s2 * f1x;
        let py = v * v * v * f0y + 3 * v * v * s2 * c0y + 3 * v * s2 * s2 * c1y + s2 * s2 * s2 * f1y;
        const drop = snapK * DMath.pow(1 - Math.abs(s2 - 0.5) * 2, 1.5) * 0.55;
        px *= 1 - drop * 0.4;
        py *= 1 - drop * 0.4;
        const gx = Math.round(CX + px);
        const gy = Math.round(CY + py);
        L.putPal(gx, gy, this.grad, this.gradIdx(10.5 - age * 1.2 - cool, gx, gy), 0.45 * EK);
      }
    }

    // ---- ejecta: a bubble of plasma leaving along a streamer ----
    for (let ei = 0; ei < this.ejecta.n; ei++) {
      const E = this.ejecta.items[ei]!;
      const u = t - E.t;
      const L0 = this.limbOf(E.a);
      const d = L0 + 3 + u * 34;
      const rad = 3 + u * 9;
      const fade = DMath.pow(1 - u / 2.6, 1.3) * live;
      const ca = fcos(E.a);
      const sa = fsin(E.a);
      const bx = CX + ca * d;
      const by = CY + sa * d;
      for (let q = L0; q < d - rad * 1.2; q += 0.7) {
        const wv = fsin(q * 0.5 - u * 6) * 0.8;
        const x = Math.round(CX + ca * q - sa * wv);
        const y = Math.round(CY + sa * q + ca * wv);
        const li = (11 - (q - L0) * 0.12) * fade;
        const bay = BAY8[((y & 7) << 3) | (x & 7)]!;
        if (li + bay * 3 < 5) continue;
        L.putPal(x, y, this.rc, clampN(Math.floor(li + bay - 0.5), 0, 17));
      }
      for (let y = Math.floor(by - rad * 1.6 - 2); y <= by + rad * 1.6 + 2; y++)
        for (let x = Math.floor(bx - rad * 1.6 - 2); x <= bx + rad * 1.6 + 2; x++) {
          const ox = x + 0.5 - bx;
          const oy = y + 0.5 - by;
          const lx = ox * ca + oy * sa;
          const ly = -ox * sa + oy * ca;
          const qd = Math.sqrt((lx * lx) / 1.8225 + ly * ly);
          const zs = (qd - rad) / 1.1;
          const zc = qd / (rad * 0.5);
          const shell = DMath.exp(-(zs * zs)) * (lx > -rad * 0.4 ? 1 : 0.35);
          const core = DMath.exp(-(zc * zc)) * 0.45;
          const li = (shell * 15 + core * 9) * fade;
          const bay = BAY8[((y & 7) << 3) | (x & 7)]!;
          if (li + bay * 3 < 4) continue;
          L.putPal(x, y, this.rc, clampN(Math.floor(li + bay - 0.5), 0, 17), 0.2 * fade * EK);
        }
    }

    // ---- flame tongues ----
    for (let ti = 0; ti < this.tongues.n; ti++) {
      const F = this.tongues.items[ti]!;
      const u = F.age / F.life;
      const base = this.limbOf(F.a);
      const pts = 14;
      const tear = u > 0.62 ? (u - 0.62) / 0.38 : 0;
      for (let q = 0; q < pts; q++) {
        const f = q / (pts - 1);
        if (tear > 0 && f > 0.55 && f < 0.7) continue; // the gap where it tore
        const len = F.sp * F.life * Math.min(1, u * 1.6) * (0.25 + 0.75 * f);
        const off = f > 0.7 && tear > 0 ? tear * F.sp * 0.6 : 0;
        const ang = F.a + F.curl * f * f * (0.15 + u * 0.35) + fsin(F.seed + F.age * 5 + f * 3) * 0.04 * f;
        const d = base + len + off;
        const x = CX + fcos(ang) * d;
        const y = CY + fsin(ang) * d;
        const rad = F.r0 * (1 - f * 0.65) * (1 - u * 0.55);
        const heat = (1 - u) * (1 - f * 0.5);
        // burns out from the outside in: dithered, never smeared
        const alive = (1 - ss(0.78, 1, u) * (0.5 + f * 0.5)) * live;
        const R2 = Math.max(0.5, rad);
        const r2 = R2 * R2;
        for (let yy = Math.floor(y - R2); yy <= y + R2; yy++)
          for (let xx = Math.floor(x - R2); xx <= x + R2; xx++) {
            const ex = xx + 0.5 - x;
            const ey = yy + 0.5 - y;
            const dd2 = ex * ex + ey * ey;
            if (dd2 > r2) continue;
            const bay = BAY8[((yy & 7) << 3) | (xx & 7)]!;
            if (bay > alive) continue;
            if (F.hot && f < 0.45 && heat > 0.45) {
              L.putPal(xx, yy, this.grad, this.gradIdx(8.5 + heat * 3 - cool, xx, yy), 0.2 * EK);
            } else {
              const li = 5 + heat * 11 + (1 - dd2 / r2) * 2 - cool * 1.4;
              L.putPal(xx, yy, this.rc, clampN(Math.floor(li + bay - 0.5), 0, 17), li > 12 ? 0.12 * EK : 0);
            }
          }
      }
    }

    // ---- sparks: hot specks that cool down the gradient as they leave ----
    for (let si = 0; si < this.sparks.n; si++) {
      const p = this.sparks.items[si]!;
      const gi = p.gi - (p.age / p.life) * 6 - cool;
      const x = Math.round(CX + p.x);
      const y = Math.round(CY + p.y);
      L.putPal(x, y, this.grad, this.gradIdx(gi, x, y), gi > 8 ? 0.45 * EK * live : 0);
      if (p.age < 0.25)
        L.putPal(
          Math.round(x - p.vx * 0.02),
          Math.round(y - p.vy * 0.02),
          this.grad,
          this.gradIdx(gi - 1.5, x, y),
        );
    }
  }

  /** A prominence footpoint (star-local) stands on live matter. */
  private footLive(mat: Uint8Array, lx: number, ly: number): boolean {
    const x = Math.floor(this.cx + lx);
    const y = Math.floor(this.cy + ly);
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return false;
    return mat[y * this.W + x] !== 0;
  }
}
