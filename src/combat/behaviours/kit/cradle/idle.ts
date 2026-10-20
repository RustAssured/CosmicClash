import { hex, pb, pg, pr, type MatterMap, type RenderLayer } from '@/contracts';
import { DMath } from '@/contracts/dmath';
import type { CradleRig } from '@/titans/kit/cradle/paint';
import { cradleFrames, type CradleFrame, type CradleFrames } from '@/titans/kit/cradle/frames';
import { BAY8, BodySkin, IdleClock, IdleRng, Pool, clampN, fcos, fsin, h2, ss } from '../../../fx/idle';
import type { Overlay } from '../../../fx/overlay';
import framesMeta from '@/titans/kit/cradle/cradle_frames.json';

/** The frames' boxes (metadata only), for sizing the sail's atlas slot before the pixel data has arrived. */
const FRAME_BOXES = (framesMeta as unknown as { frames: { ox: number; oy: number; w: number; h: number }[] })
  .frames;

/**
 * THE CRADLE'S LIVING IDLE, render side (idle handover specs/cradle.md, prototype `cradle.src.html`; WJ: "every pulse takes
 * years… This is it!"). The cord's motion and the quickening's clock are sim state (pose.ts); everything here only draws,
 * stepped once per sim tick from that tick's recorded inputs.
 *  - THE SAIL is the approved painted frames (frames.ts; never a warp): a 26 s precession through 32 tilts, and the claw
 *    (the ribs curl in like a hand) through 15 grips per tilt, on a spring. Over the frame: the contraction's darkness
 *    running hub → rim and the lit let-go, vessel pulses running out, the sacs' level fluid line sloshing, their masses and
 *    kicks, the lumen flicker, the quickening's flood and release ring. Recoloured for the stage's light.
 *  - The knot (a skin over the primary body): the embryo cleaving 1 → 2 → 4 → 8 → 16 and collapsing, muscle bands.
 *  - The cord's atlas slots: a bolus swallowed down it, muscle bands, the jaw-organ's plates parting to taste.
 *  - The quickening's filaments reaching for the foe, beads travelling back, the web over it (on the fx overlay).
 * Damage: a frame cell maps to its rest-disc cell; a destroyed cell draws nothing, a changed one (char, cracks, wrong
 * growth) draws the live pixel.
 */

export interface CradleIdleInput {
  t: number;
  w: number;
  wit: number;
  hush: number;
  coilAt: number;
  hit: boolean;
  ko: boolean;
  /** The knot's world position (the sail lags its acceleration; the sacs slosh with it). */
  x: number;
  y: number;
  facing: 1 | -1;
  foeX: number;
  foeY: number;
}

const RING = 16;
const DT = IdleClock.DT;
const TAU = Math.PI * 2;
const FIGHT_FLAGS = 1 | 2 | 4 | 8 | 64;
const EM = 255;
const lum3 = (r: number, g: number, b: number): number => 0.3 * r + 0.59 * g + 0.11 * b;
const lumC = (c: number): number => lum3(pr(c), pg(c), pb(c));

/** atan2 to ~1e-3 rad (render only: the vessels' phase). */
function fatan2(y: number, x: number): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax + ay === 0) return 0;
  const a = Math.min(ax, ay) / Math.max(ax, ay);
  const s = a * a;
  let r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a;
  if (ay > ax) r = Math.PI / 2 - r;
  if (x < 0) r = Math.PI - r;
  return y < 0 ? -r : r;
}

interface SacSt {
  slope: number;
  sv: number;
  kick: number;
  kx: number;
  ky: number;
  mass: boolean;
  mx: number;
  flick: number;
}
interface FrameSacs {
  sac: Int16Array;
  /** Per component: bbox, centroid, the R.sacs entry it is (its state), its rank round the hub. */
  x0: number[];
  y0: number[];
  x1: number[];
  y1: number[];
  cx: number[];
  cy: number[];
  key: number[];
  rank: number[];
}

export class CradleIdle {
  private readonly R: CradleRig;
  private readonly id: CradleRig['ids'];
  /* palette: the frames' 94 entries plus the materials' JSON ramps; per entry its material and stage colour; ladders */
  private palM: number[] = [0];
  private stage: Uint32Array = new Uint32Array(1);
  private lad: number[][] = [];
  private rank: Int16Array = new Int16Array(1);
  private rampIdx: Record<string, number[]> = {};
  private F: CradleFrames | null = null;
  /* the disc slot (composite px of its (0, 0), its size) */
  slotOx = 0;
  slotOy = 0;
  slotW = 0;
  slotH = 0;
  private readonly sacCache = new Map<number, FrameSacs>();
  private readonly sacSt: SacSt[] = [];
  /* the knot */
  private readonly coreCells: Int32Array;
  private readonly ccx: number;
  private readonly ccy: number;
  private readonly CR: number;
  private readonly levels: [number, number][][];
  private readonly skin: BodySkin;
  private skinVer = -1;
  /* state */
  readonly clock = new IdleClock();
  private readonly ringIn: CradleIdleInput[];
  private readonly ringTick = new Int32Array(RING).fill(-1);
  private readonly lastIn: CradleIdleInput;
  private readonly rng: IdleRng;
  private readonly seed: number;
  private steps = 0;
  private T = 0;
  private phi = 0;
  private spread = 0;
  private sv = 0;
  private conT0 = -20;
  private conDepth = 0.42;
  private conN = 0;
  private nextCon = 72;
  private nextFeed = 150;
  private nextKick = 180;
  private lagX = 0;
  private lagY = 0;
  private lagVx = 0;
  private lagVy = 0;
  private px = NaN;
  private py = NaN;
  private vx = 0;
  private vy = 0;
  private ax = 0;
  private ay = 0;
  private embP = 0;
  private embCollapse = -9;
  private witStart = -1;
  private readonly bolus = new Pool<{ t0: number }>(4, () => ({ t0: 0 }));
  private fil: { a: number; ph: number; side: number; twigs: { u: number; a: number; l: number }[] }[] = [];
  private web: [number, number, number][] = [];
  private dirty = true;
  private fiShown = 0;

  constructor(
    R: CradleRig,
    materials: readonly { key: string; visual: { ramp: string[] } }[],
    knot: MatterMap,
    seed: number,
  ) {
    this.R = R;
    this.id = R.ids;
    this.seed = seed;
    this.rng = new IdleRng(seed);
    this.skin = new BodySkin(knot.w, knot.h);
    // the embryonic core inside the knot (the knot region's own map frame)
    const k0 = R.regions[0]!;
    const cells: number[] = [];
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < knot.material.length; i++)
      if (knot.material[i] === this.id.core) {
        cells.push(i);
        sx += (i % knot.w) + 0.5;
        sy += Math.floor(i / knot.w) + 0.5;
      }
    this.coreCells = Int32Array.from(cells);
    this.ccx = cells.length ? sx / cells.length : k0.pivotX - k0.ox;
    this.ccy = cells.length ? sy / cells.length : k0.pivotY - k0.oy;
    let cr = 0;
    for (const i of cells)
      cr = Math.max(cr, DMath.hypot((i % knot.w) + 0.5 - this.ccx, Math.floor(i / knot.w) + 0.5 - this.ccy));
    this.CR = Math.max(1, cr);
    this.levels = [0, 1, 2, 3, 4].map((L) => {
      const n = 1 << L;
      const P: [number, number][] = [];
      for (let k = 0; k < n; k++) {
        const r = n === 1 ? 0 : Math.sqrt((k + 0.5) / n) * this.CR * 0.52;
        const a = k * 2.39996 + 0.6;
        P.push([DMath.cos(a) * r, DMath.sin(a) * r * 0.9]);
      }
      return P;
    });
    // per R.sacs entry its persistent traits (h2 of its index, as the prototype keyed them by angle)
    R.sacs.forEach((_, k) => {
      this.sacSt.push({
        slope: 0,
        sv: 0,
        kick: -9,
        kx: 0,
        ky: 0,
        mass: h2(k, 7) > 0.35,
        mx: (h2(k, 3) - 0.5) * 0.4,
        flick: h2(k, 11),
      });
    });
    this.matDefs = materials;
    // the slot: the rest disc and every frame's box
    const disc = R.regions.find((r) => r.kind === 'disc')!;
    this.slotOx = disc.ox;
    this.slotOy = disc.oy;
    let x1 = disc.ox + disc.map.w;
    let y1 = disc.oy + disc.map.h;
    // (the frames' boxes come with their metadata: known before the pixel data arrives in the browser)
    for (const f of FRAME_BOXES) {
      this.slotOx = Math.min(this.slotOx, f.ox);
      this.slotOy = Math.min(this.slotOy, f.oy);
      x1 = Math.max(x1, f.ox + f.w);
      y1 = Math.max(y1, f.oy + f.h);
    }
    this.slotW = x1 - this.slotOx;
    this.slotH = y1 - this.slotOy;
    const mk = (): CradleIdleInput => ({
      t: 0,
      w: 0,
      wit: -1,
      hush: 0,
      coilAt: -1,
      hit: false,
      ko: false,
      x: 0,
      y: 0,
      facing: 1,
      foeX: 0,
      foeY: 0,
    });
    this.ringIn = Array.from({ length: RING }, mk);
    this.lastIn = mk();
  }
  private readonly matDefs: readonly { key: string; visual: { ramp: string[] } }[];

  /**
   * The palette, its ladders (every entry of a material by luminance: `stepI` walks entries, not ramp steps, spec §2.2) and
   * each entry's colour under this stage's light: by majority vote of the stage-lit live disc against the default-lit rest
   * disc; an entry never seen there takes the same luminance rank in its material's stage colours.
   */
  private build(F: CradleFrames, disc: MatterMap): void {
    this.F = F;
    const pr0: number[] = [0];
    const pg0: number[] = [0];
    const pb0: number[] = [0];
    const pm0: number[] = [0];
    for (const p of F.pal) {
      pr0.push(p[0]);
      pg0.push(p[1]);
      pb0.push(p[2]);
      pm0.push(p[3]);
    }
    // the materials' JSON ramps join the palette (the prototype's `palAdd`)
    this.rampIdx = {};
    this.matDefs.forEach((m, i) => {
      const mid = i + 1;
      this.rampIdx[m.key] = m.visual.ramp.map((h) => {
        const c = hex(h);
        const r = c & 255;
        const g = (c >>> 8) & 255;
        const b = (c >>> 16) & 255;
        for (let k = 1; k < pr0.length; k++)
          if (pm0[k] === mid && pr0[k] === r && pg0[k] === g && pb0[k] === b) return k;
        pr0.push(r);
        pg0.push(g);
        pb0.push(b);
        pm0.push(mid);
        return pr0.length - 1;
      });
    });
    this.palM = pm0;
    const n = pr0.length;
    this.rank = new Int16Array(n);
    this.lad = [];
    for (let k = 1; k < n; k++) (this.lad[pm0[k]!] ??= []).push(k);
    for (const L of this.lad) {
      if (!L) continue;
      L.sort((a, b) => lum3(pr0[a]!, pg0[a]!, pb0[a]!) - lum3(pr0[b]!, pg0[b]!, pb0[b]!));
      L.forEach((p, r) => (this.rank[p] = r));
    }
    // the stage's colours
    const votes = new Map<number, Map<number, number>>();
    const rest = F.rest;
    for (let i = 0; i < rest.idx.length; i++) {
      const p = rest.idx[i]!;
      if (!p || !disc.material[i]) continue;
      const c = (disc.baseColor[i]! | 0xff000000) >>> 0;
      const v = votes.get(p) ?? new Map<number, number>();
      v.set(c, (v.get(c) ?? 0) + 1);
      votes.set(p, v);
    }
    this.stage = new Uint32Array(n);
    const seen: number[][] = [];
    for (const [p, v] of votes) {
      let best = 0;
      let bc = 0;
      for (const [c, k] of v)
        if (k > best) {
          best = k;
          bc = c;
        }
      this.stage[p] = bc;
      (seen[pm0[p]!] ??= []).push(bc);
    }
    for (const s of seen) if (s) s.sort((a, b) => lumC(a) - lumC(b));
    for (let p = 1; p < n; p++) {
      if (this.stage[p]) continue;
      const m = pm0[p]!;
      const L = this.lad[m]!;
      const S = seen[m] ?? this.R.ramps[m] ?? [];
      const u = L.length > 1 ? this.rank[p]! / (L.length - 1) : 0.5;
      this.stage[p] = S.length
        ? (S[clampN(Math.round(u * (S.length - 1)), 0, S.length - 1)]! | 0xff000000) >>> 0
        : ((pb0[p]! << 16) | (pg0[p]! << 8) | pr0[p]! | 0xff000000) >>> 0;
    }
  }
  private stepI(p: number, k: number): number {
    const L = this.lad[this.palM[p]!];
    if (!L) return p;
    return L[clampN(this.rank[p]! + k, 0, L.length - 1)]!;
  }
  private ladI(m: number, u: number): number {
    const L = this.lad[m];
    if (!L || !L.length) return 0;
    return L[clampN(Math.round(u * (L.length - 1)), 0, L.length - 1)]!;
  }
  private rampI(key: string, k: number): number {
    const r = this.rampIdx[key];
    return r ? r[clampN(k, 0, r.length - 1)]! : 0;
  }

  reset(): void {
    this.clock.reset();
    this.rng.reseed(this.seed);
    this.ringTick.fill(-1);
    this.steps = 0;
    this.T = 0;
    this.phi = 0;
    this.spread = 0;
    this.sv = 0;
    this.conT0 = -20;
    this.conDepth = 0.42;
    this.conN = 0;
    this.nextCon = 72;
    this.nextFeed = 150;
    this.nextKick = 180;
    this.lagX = this.lagY = this.lagVx = this.lagVy = 0;
    this.px = this.py = NaN;
    this.vx = this.vy = this.ax = this.ay = 0;
    this.embP = 0;
    this.embCollapse = -9;
    this.witStart = -1;
    this.bolus.clear();
    for (const s of this.sacSt) {
      s.slope = s.sv = 0;
      s.kick = -9;
    }
    this.skinVer = -1;
    this.dirty = true;
  }

  record(tick: number, inp: CradleIdleInput): void {
    if (this.clock.last < 0) this.clock.last = tick - 1;
    const k = tick & (RING - 1);
    Object.assign(this.ringIn[k]!, inp);
    this.ringTick[k] = tick;
    Object.assign(this.lastIn, inp);
  }
  private inputAt(tick: number): CradleIdleInput {
    const k = tick & (RING - 1);
    return this.ringTick[k] === tick ? this.ringIn[k]! : this.lastIn;
  }
  advance(tick: number): boolean {
    const n = this.clock.due(tick);
    for (let i = 0; i < n; i++) this.step(this.inputAt(tick - n + 1 + i));
    if (n > 0) this.dirty = true;
    return n > 0;
  }
  get active(): boolean {
    return this.lastIn.w > 0.01;
  }
  /** The quickening's filaments are showing (the behaviour lends them its fx overlay). */
  get reaching(): boolean {
    const W = this.lastIn.wit;
    return W > 1.0 && W < 4.2 && this.lastIn.w > 0.5;
  }

  private step(inp: CradleIdleInput): void {
    const st = ++this.steps;
    const R = this.rng;
    this.T = inp.t;
    const t = inp.t;
    const W = inp.wit;
    const wit = W >= 0;
    const hush = inp.hush;
    const calm = inp.w > 0.9 && !inp.ko && !inp.hit;
    // the knot's motion (the sail lags it, the sacs slosh)
    if (Number.isNaN(this.px)) {
      this.px = inp.x;
      this.py = inp.y;
    }
    const nvx = (inp.x - this.px) / DT;
    const nvy = (inp.y - this.py) / DT;
    this.ax += ((nvx - this.vx) / DT - this.ax) * 0.2;
    this.ay += ((nvy - this.vy) / DT - this.ay) * 0.2;
    this.vx = nvx;
    this.vy = nvy;
    this.px = inp.x;
    this.py = inp.y;
    const ax = clampN(this.ax, -400, 400) * inp.facing;
    const ay = clampN(this.ay, -400, 400);
    // ---- the quickening's own draws (filament phases, the web) at its start ----
    if (wit && this.witStart < 0) {
      this.witStart = st;
      this.fil = [-0.55, -0.05, 0.45].map((a, k) => ({
        a,
        ph: R.next() * 9,
        side: k - 1,
        twigs: [0.55, 0.72, 0.86].map((u) => ({ u, a: (R.next() - 0.5) * 1.6, l: 3 + R.next() * 4 })),
      }));
      this.web = this.makeWeb();
    }
    if (!wit) this.witStart = -1;
    // ---- moments: the claw pulse (never in a hush), feeds, kicks ----
    if (st > this.nextCon && hush <= 0 && calm) {
      this.conT0 = t;
      this.conN++;
      this.conDepth = this.conN % 3 === 0 ? 0.8 : 0.42;
      this.nextCon = st + 450 + Math.floor(R.next() * 90);
    }
    if ((!wit || W > 6.5) && calm) {
      if (st > this.nextFeed) {
        const b = this.bolus.alloc();
        if (b) b.t0 = t;
        this.nextFeed = st + 240 + Math.floor(R.next() * 180);
      }
      if (st > this.nextKick) {
        const ms = this.sacSt.filter((s) => s.mass);
        if (ms.length) {
          const s = ms[Math.floor(R.next() * ms.length)]!;
          s.kick = t;
          s.kx = R.next() < 0.5 ? -1 : 1;
          s.ky = R.next() < 0.5 ? -1 : 0;
        }
        this.nextKick = st + 90 + Math.floor(R.next() * 150);
      }
    }
    for (let i = this.bolus.n - 1; i >= 0; i--) if (t - this.bolus.items[i]!.t0 > 6) this.bolus.kill(i);
    // ---- the sail: the precession (held in the hush), the claw's spread on its spring, the lag ----
    this.phi += DT * (TAU / 26) * (1 - hush) * (inp.ko ? 0 : 1);
    const cu = t - this.conT0;
    let tg = (cu < 2.4 ? ss(0.1, 2.4, cu) : cu < 3.0 ? 1 : 1 - ss(3.0, 6.0, cu)) * this.conDepth;
    let sw = 1.7;
    let sz = 0.8;
    if (wit) {
      if (W < 2.2) tg = -0.24 * ss(0, 1.2, W);
      else if (W < 3.5) {
        tg = 1;
        sw = 2.6;
        sz = 0.7;
      } else if (W < 3.9) {
        tg = -0.24;
        sw = 4.2;
        sz = 0.25;
      } else {
        tg = 0;
        sw = 1.4;
        sz = 0.45;
      }
    }
    // a move takes the claw away, a guard or a KO holds it open; under attack at half
    tg *= inp.w * (inp.hit ? 0.5 : 1);
    const sa = sw * sw * (tg - this.spread) - 2 * sz * sw * this.sv;
    this.sv += sa * DT;
    this.spread += this.sv * DT;
    if (this.spread < -0.24) {
      this.spread = -0.24;
      this.sv = Math.max(0, this.sv);
    }
    if (this.spread > 1) {
      this.spread = 1;
      this.sv = Math.min(0, this.sv);
    }
    const lgx = 2.2 * 2.2 * -this.lagX - 2 * 0.3 * 2.2 * this.lagVx - ax * 0.35;
    const lgy = 2.2 * 2.2 * -this.lagY - 2 * 0.3 * 2.2 * this.lagVy - ay * 0.35;
    this.lagVx += lgx * DT;
    this.lagVy += lgy * DT;
    this.lagX = clampN(this.lagX + this.lagVx * DT, -2, 2);
    this.lagY = clampN(this.lagY + this.lagVy * DT, -2, 2);
    // ---- the embryo: cleaves on its own clock, fast for the quickening, then collapses ----
    if (inp.ko) {
      if (this.embCollapse < 0 || this.embP > 0.5) this.embCollapse = Math.max(this.embCollapse, t - 1);
    } else if (wit && W > 0.8 && W < 4.2) this.embP = Math.min(4, this.embP + DT * 2.6);
    else if (wit && W >= 4.2 && this.embCollapse < t - W) this.embCollapse = t;
    else if (!wit) {
      this.embP += DT * 0.32 * inp.w;
      if (this.embP >= 4.4 && this.embCollapse < t - 1.2) this.embCollapse = t;
    }
    if (this.embCollapse > 0 && t - this.embCollapse > 1.0 && this.embP > 0.5) this.embP = 0;
    // ---- the sacs: a level fluid line that sloshes as the sail tilts and the body moves ----
    const tiltRate = fcos(this.phi) * 0.5 + this.sv * 2;
    for (const s of this.sacSt) {
      const a = 9 * (-(ax * 0.01) - tiltRate * 0.08 - s.slope) - 2 * 0.25 * 3 * s.sv;
      s.sv += a * DT;
      s.slope = clampN(s.slope + s.sv * DT, -0.35, 0.35);
    }
  }

  private makeWeb(): [number, number, number][] {
    const R = this.rng;
    const pts: [number, number, number][] = [];
    const rad = 8;
    for (let sd = -1; sd <= 1; sd++) {
      let k = 0;
      const stack: [number, number, number, number][] = [[-5 - Math.abs(sd), sd * 6, -sd * 0.6, 0]];
      while (stack.length && k < 140) {
        const top = stack.pop()!;
        let [x, y, a] = top;
        const d = top[3];
        const n = 6 + R.next() * 5;
        for (let s = 0; s < n; s++) {
          x += fcos(a);
          y += fsin(a);
          a += (R.next() - 0.5) * 0.9;
          if (x * x + y * y > rad * rad) break;
          pts.push([Math.round(x), Math.round(y), d + s]);
          k++;
          if (R.next() < 0.18 && d < 18) stack.push([x, y, a + (R.next() < 0.5 ? 0.9 : -0.9), d + s]);
        }
      }
    }
    return pts;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  the sail
   * ---------------------------------------------------------------------------------------------- */

  /** The frame for the precession and the claw now (the prototype's selection). */
  private frameNow(F: CradleFrames): number {
    const c = this.spread;
    const nl = F.nLoop;
    const tau = (this.phi / TAU) * nl;
    if (Math.abs(c) < 0.04) return ((Math.round(tau) % nl) + nl) % nl;
    const half = nl / 2;
    const ti = ((Math.round(tau / 2) % half) + half) % half;
    let best = 0;
    let bd = 9;
    F.claw.forEach((v, k) => {
      const d = Math.abs(v - c);
      if (d < bd) {
        bd = d;
        best = k;
      }
    });
    return nl + ti * F.claw.length + best;
  }

  /** The sacs of a frame (8-connected sac / lumen components), each matched to its R.sacs entry: a small LRU. */
  private sacsOf(fi: number, f: CradleFrame, idx: Uint16Array): FrameSacs {
    const got = this.sacCache.get(fi);
    if (got) return got;
    const n = f.w * f.h;
    const sac = new Int16Array(n).fill(-1);
    const out: FrameSacs = { sac, x0: [], y0: [], x1: [], y1: [], cx: [], cy: [], key: [], rank: [] };
    const isS = (i: number): boolean => {
      const p = idx[f.off + i]!;
      return p !== 0 && (this.palM[p] === this.id.sac || this.palM[p] === this.id.lumen);
    };
    const hub = this.R.hub;
    for (let i = 0; i < n; i++) {
      if (sac[i]! >= 0 || !isS(i)) continue;
      const id = out.cx.length;
      const q = [i];
      sac[i] = id;
      let x0 = 1e9;
      let y0 = 1e9;
      let x1 = -1;
      let y1 = -1;
      let sx = 0;
      let sy = 0;
      let cnt = 0;
      while (q.length) {
        const j = q.pop()!;
        const x = j % f.w;
        const y = (j - x) / f.w;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
        sx += x;
        sy += y;
        cnt++;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const X = x + dx;
            const Y = y + dy;
            if (X < 0 || Y < 0 || X >= f.w || Y >= f.h) continue;
            const k = Y * f.w + X;
            if (sac[k]! < 0 && isS(k)) {
              sac[k] = id;
              q.push(k);
            }
          }
      }
      const cx = sx / cnt;
      const cy = sy / cnt;
      out.x0.push(x0);
      out.y0.push(y0);
      out.x1.push(x1);
      out.y1.push(y1);
      out.cx.push(cx);
      out.cy.push(cy);
      // the same sac in every tilt: the nearest painted sac by angle round the hub (spec §6: not the rounded angle)
      const a = DMath.atan2(cy + f.oy - hub.y, cx + f.ox - hub.x);
      let bk = 0;
      let bd = 9;
      this.R.sacs.forEach((s, k) => {
        let d = Math.abs(a - DMath.atan2(s.y - hub.y, s.x - hub.x));
        if (d > Math.PI) d = TAU - d;
        if (d < bd) {
          bd = d;
          bk = k;
        }
      });
      out.key.push(bk);
    }
    const order = out.cx.map((_, k) => k);
    const ang = order.map((k) => DMath.atan2(out.cy[k]! + f.oy - hub.y, out.cx[k]! + f.ox - hub.x));
    order.sort((a, b) => ang[a]! - ang[b]!);
    out.rank = new Array<number>(order.length);
    order.forEach((k, r) => (out.rank[k] = r));
    if (this.sacCache.size >= 6) this.sacCache.delete(this.sacCache.keys().next().value as number);
    this.sacCache.set(fi, out);
    return out;
  }

  /**
   * Draw the sail into its atlas slot (`sx, sy`, row stride `stride`): the frame for now, through the stage's palette, with
   * the idle's light over it; destroyed cells empty, changed cells the live pixel. Returns false while the frames are not in
   * (the caller then copies the rest disc).
   */
  drawSail(
    disc: MatterMap,
    px: Uint32Array,
    em: Uint8Array,
    stride: number,
    sx: number,
    sy: number,
  ): boolean {
    const F = this.F ?? cradleFrames();
    if (!F) return false;
    if (!this.F) this.build(F, disc);
    const inp = this.lastIn;
    const id = this.id;
    const t = this.T;
    const W = inp.wit;
    const wit = W >= 0;
    const w = inp.w;
    // clear the slot
    for (let y = 0; y < this.slotH; y++) {
      const a = (sy + y) * stride + sx;
      px.fill(0, a, a + this.slotW);
      em.fill(0, a, a + this.slotW);
    }
    const fi = this.frameNow(F);
    this.fiShown = fi;
    const f = F.frames[fi]!;
    const idx = F.idx;
    const D = this.R.disc;
    const dcx = D.cx;
    const dcy = D.cy;
    // the frame's projection (claw ignored, as the prototype's `info`) and the rest projection, for rho / ang and the
    // rest-disc source cell of every frame cell
    const c = fcos(-f.roll);
    const s = fsin(-f.roll);
    const rc = fcos(D.roll);
    const rs = fsin(D.roll);
    const rest = F.rest;
    const lx = Math.round(this.lagX * w);
    const ly = Math.round(this.lagY * w);
    const front = (t - this.conT0) / 2.4;
    const hard = wit ? ss(2.2, 2.6, W) * (1 - ss(3.4, 3.6, W)) : 0;
    const ring = wit && W > 3.5 ? (W - 3.5) / 0.9 : -1;
    const flood = wit ? ss(0.6, 1.4, W) * (1 - ss(4.2, 5.4, W)) : 0;
    const S = this.sacsOf(fi, f, idx);
    const fx0 = f.ox - this.slotOx + lx;
    const fy0 = f.oy - this.slotOy + ly;
    const mat = disc.material;
    const integ = disc.integrity;
    const flags = disc.flags;
    for (let i = 0; i < f.w * f.h; i++) {
      let p = idx[f.off + i]!;
      if (!p) continue;
      const x = i % f.w;
      const y = (i - x) / f.w;
      const X = fx0 + x;
      const Y = fy0 + y;
      if (X < 0 || Y < 0 || X >= this.slotW || Y >= this.slotH) continue;
      const qx = f.ox + x + 0.5 - dcx;
      const qy = f.oy + y + 0.5 - dcy;
      const a = qx * c - qy * s;
      const b = qx * s + qy * c;
      const u = a / f.rx;
      const v = b / f.ry;
      // the rest-disc cell under it: destroyed → nothing; changed by the fight → its live pixel
      const ra = u * D.rx;
      const rb = v * D.ry;
      const RX = Math.floor(dcx + ra * rc - rb * rs - rest.ox);
      const RY = Math.floor(dcy + ra * rs + rb * rc - rest.oy);
      const j = (sy + Y) * stride + sx + X;
      if (RX >= 0 && RY >= 0 && RX < disc.w && RY < disc.h) {
        const k = RY * disc.w + RX;
        if (mat[k] === 0 || integ[k] === 0) continue;
        if (integ[k] !== 255 || (flags[k]! & FIGHT_FLAGS) !== 0) {
          px[j] = disc.pixels[k]!;
          em[j] = disc.emissive[k]!;
          continue;
        }
      }
      const m = this.palM[p]!;
      let g = 0;
      if (w > 0.01) {
        const rho = Math.sqrt(u * u + v * v);
        const bay = BAY8[((Y & 7) << 3) | (X & 7)]!;
        // the contraction: darkness runs hub → rim, then the panels ease out lit; the grab's hard darkness
        if (m === id.membrane || m === id.muscle || m === id.vessel) {
          const d = front - rho;
          if (d > -0.04 && d < 0.05) p = this.stepI(p, -2);
          else if (d >= 0.05 && d < 0.3 && bay > (d - 0.05) / 0.25) p = this.stepI(p, -1);
          else if (d >= 0.45 && d < 0.8 && bay > 0.4 + (d - 0.45) * 1.6) p = this.stepI(p, 1);
          if (hard > 0 && bay < hard * 0.7) p = this.stepI(p, -1);
        }
        // the vessels: pulses running out toward the rim
        if (m === id.vessel) {
          const ph = rho * 5.5 - t * 0.9 + fatan2(v, u) * 0.3;
          const fr = ph - Math.floor(ph);
          if (fr < 0.1 || flood > bay) {
            p = this.stepI(p, 2);
            g = Math.max(g, 0.06);
          } else if (fr < 0.22) p = this.stepI(p, 1);
        }
        // the sacs
        const sk = S.sac[i]!;
        if (sk >= 0) {
          const st = this.sacSt[S.key[sk]!]!;
          const hh = S.y1[sk]! - S.y0[sk]! + 1;
          const line = S.y0[sk]! + hh * 0.42 + st.slope * (x - S.cx[sk]!);
          let k = y > line + 0.5 ? 1 : y > line - 0.5 ? 2 : -1;
          if (m === id.lumen) {
            const fl = fsin(t * 7.3 + st.flick * 40) * fsin(t * 1.9 + st.flick * 9);
            k = fl > 0.55 ? 2 : fl > 0.1 ? 0 : -2;
            if (k > 0) g = Math.max(g, 0.25);
          }
          p = this.stepI(p, k);
          if (st.mass && hh > 6 && m === id.sac) {
            const ku = t - st.kick;
            const kx = ku < 0.18 ? st.kx * 2 : ku < 0.4 ? st.kx : 0;
            const ky = ku < 0.18 ? st.ky : 0;
            const sw = S.x1[sk]! - S.x0[sk]!;
            const mcx = S.cx[sk]! + st.mx * sw + kx + fsin(t * 0.3 + st.flick * 9);
            const mcy = S.cy[sk]! + hh * 0.12 + ky;
            const ex = (x - mcx) / Math.max(1.6, sw * 0.22);
            const ey = (y - mcy) / Math.max(1.4, hh * 0.24);
            const dm = Math.sqrt(ex * ex + ey * ey);
            if (dm < 1) p = dm < 0.65 ? this.ladI(id.core, 0.2) : this.ladI(id.muscle, 0.35);
            else if (ku < 0.9) {
              const dd = Math.sqrt((x - mcx) * (x - mcx) + (y - mcy) * (y - mcy));
              if (Math.abs(dd - ku * 9) < 0.7) p = this.stepI(p, 1);
            }
          }
          const rank = S.rank[sk]!;
          if (wit && W > 0.6 + rank * 0.07 && W < 4.6 - rank * 0.03) {
            p = this.stepI(p, 2);
            g = Math.max(g, 0.14);
          }
        }
        // the release: a ring of light from the hub out to the rim
        if (ring >= 0 && ring < 1.2 && Math.abs(rho - ring) < 0.06) {
          p = this.stepI(p, 2);
          g = Math.max(g, 0.25);
        }
      }
      px[j] = this.stage[p]!;
      em[j] = Math.round(g * EM);
    }
    return true;
  }

  /** The sail's frame shown last (the filaments' roots sit on its rim). */
  get frame(): CradleFrame | null {
    const F = this.F;
    return F ? F.frames[this.fiShown]! : null;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  the cord's slots, the knot, the filaments
   * ---------------------------------------------------------------------------------------------- */

  /**
   * Recolour cord link k's atlas cells (already holding the live map) for the bolus, the muscle bands and, on the jaw, the
   * tasting. `along`/`perp`: per map cell, its place along the link (0 at its root joint, 1 at the next) and across it (px).
   */
  shadeCord(
    k: number,
    jaw: boolean,
    m: MatterMap,
    along: Float32Array,
    perp: Float32Array,
    px: Uint32Array,
    stride: number,
    sx: number,
    sy: number,
  ): void {
    const inp = this.lastIn;
    if (inp.w < 0.01 || !this.F) return;
    const id = this.id;
    const t = this.T;
    const W = inp.wit;
    const tu = inp.coilAt >= 0 ? t - (inp.coilAt / 60 + 1.6) : -9;
    const gw = tu >= 0.15 && tu < 1.3 ? 1 : 0;
    const g2 = W > 2.2 && W < 3.6 ? 2 : gw;
    const core1 = this.stage[this.rampI('core', 1)]!;
    for (let i = 0; i < m.material.length; i++) {
      const mm = m.material[i]!;
      if (!mm || m.integrity[i] !== 255 || (m.flags[i]! & FIGHT_FLAGS) !== 0) continue;
      const x = i % m.w;
      const y = (i - x) / m.w;
      const j = (sy + y) * stride + sx + x;
      const sAlong = k + along[i]!;
      let step = 0;
      for (let q = 0; q < this.bolus.n; q++) {
        const sb = (t - this.bolus.items[q]!.t0) * 1.5 - 0.5;
        if (Math.abs(sAlong - sb) < 0.32) step = 1;
      }
      if (jaw && g2 && along[i]! > 0.5) {
        const pp = perp[i]!;
        if (Math.abs(pp) < g2 - 0.3) {
          px[j] = core1;
          continue;
        }
        // the plates part: each side samples the map g rows away (the prototype's quirk, kept)
        const jj = i + (pp > 0 ? -1 : 1) * m.w * g2;
        if (jj >= 0 && jj < m.material.length && m.material[jj]) px[j] = m.pixels[jj]!;
      }
      if (mm === id.muscle || mm === id.membrane) {
        const ph = sAlong * 1.3 - t * 0.7;
        if (ph - Math.floor(ph) < 0.08) step += 1;
      }
      if (step) px[j] = this.liveStep(px[j]!, mm, step);
    }
  }

  /** A live (lit) colour stepped along its material's stage ladder by luminance. */
  private liveStep(c: number, m: number, k: number): number {
    const L = this.lad[m];
    if (!L || !L.length) return c;
    const v = lumC(c);
    let lo = 0;
    let hi = L.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lumC(this.stage[L[mid]!]!) < v) lo = mid + 1;
      else hi = mid;
    }
    return this.stage[L[clampN(lo + k, 0, L.length - 1)]!]!;
  }

  /** The knot (the primary body) as a skin: the embryo cleaving, the muscle bands. */
  presentKnot(map: MatterMap, body: RenderLayer): void {
    if (!this.F) return;
    const changed = this.dirty || map.version !== this.skinVer;
    if (changed) {
      this.dirty = false;
      this.skinVer = map.version;
      this.shadeKnot(map);
    }
    this.skin.present(body, changed);
  }

  private shadeKnot(map: MatterMap): void {
    const S = this.skin;
    S.copyFrom(map.pixels, map.emissive);
    const inp = this.lastIn;
    if (inp.w < 0.01 && this.embCollapse < 0) return;
    const px = S.px;
    const em = S.emis;
    const id = this.id;
    const t = this.T;
    const W = inp.wit;
    const quick = W > 0.8 && W < 4.4;
    const n = Math.floor(this.embP);
    const q = this.embP - n;
    const col = this.embCollapse > 0 ? clampN((t - this.embCollapse) / 1.0, 0, 1) : 0;
    const L0 = Math.min(4, n);
    const L1 = Math.min(4, n + 1);
    const P0 = this.levels[L0]!;
    const P1 = this.levels[L1]!;
    const kq = ss(0.15, 0.85, q);
    const bx: number[] = [];
    const by: number[] = [];
    for (let j = 0; j < P1.length; j++) {
      const par = P0[Math.min(P0.length - 1, j >> (L1 - L0))]!;
      const ch = P1[j]!;
      bx.push(L1 === L0 ? ch[0] : par[0] + (ch[0] - par[0]) * kq);
      by.push(L1 === L0 ? ch[1] : par[1] + (ch[1] - par[1]) * kq);
    }
    const rb = ((this.CR * 0.66) / Math.sqrt(DMath.pow(2, L0 + (L1 > L0 ? kq : 0)))) * 1.12;
    const beat = 0.5 + 0.5 * fsin(t * 1.1);
    const crr = this.CR - (beat > 0.75 ? 1 : 0);
    const C = (k: number): number => this.stage[this.rampI('core', k)]!;
    for (const i of this.coreCells) {
      if (map.material[i] !== id.core || map.integrity[i] !== 255 || (map.flags[i]! & FIGHT_FLAGS) !== 0)
        continue;
      const x = i % map.w;
      const y = (i - x) / map.w;
      const qx = x + 0.5 - this.ccx;
      const qy = y + 0.5 - this.ccy;
      let best = 9;
      for (let k = 0; k < bx.length; k++) {
        const dx = qx - bx[k]!;
        const dy = qy - by[k]!;
        best = Math.min(best, Math.sqrt(dx * dx + dy * dy) / rb);
      }
      if (col > 0 && BAY8[((y & 7) << 3) | (x & 7)]! < col) best = 9;
      if (Math.sqrt(qx * qx + qy * qy) > crr) px[i] = C(0);
      else if (best < 0.5) {
        px[i] = C(quick ? 5 : 4);
        em[i] = Math.max(em[i]!, Math.round(0.1 * EM));
      } else if (best < 0.82) px[i] = C(3);
      else if (best < 1.02) px[i] = C(2);
      else px[i] = C(1);
    }
    // the knot's muscle bands
    const k0 = this.R.regions[0]!;
    for (let i = 0; i < map.material.length; i++) {
      if (map.material[i] !== id.muscle || map.integrity[i] !== 255) continue;
      const y = Math.floor(i / map.w);
      const ph = (y + k0.oy) * 0.12 - t * 0.7;
      if (ph - Math.floor(ph) < 0.07) px[i] = this.liveStep(px[i]!, id.muscle, 1);
    }
  }

  /**
   * The quickening's filaments from the sail's rim to the foe, beads travelling back, tearing; the web over the foe.
   * `hubX, hubY`: the disc hub (world); `foeDark, foeLit`: the foe's own darkest and lightest lit colours.
   */
  drawFilaments(
    fx: Overlay,
    hubX: number,
    hubY: number,
    facing: number,
    foeDark: number,
    foeLit: number,
  ): void {
    const inp = this.lastIn;
    const W = inp.wit;
    const f = this.frame;
    if (W < 0 || !f || !this.fil.length) return;
    const grow = ss(1.0, 2.0, W);
    const tear = W > 3.5 ? (W - 3.5) / 0.6 : 0;
    const hardT = ss(2.2, 2.6, W) * (1 - ss(3.4, 3.6, W));
    const C = (key: string, k: number): number => this.stage[this.rampI(key, k)]!;
    if (grow > 0 && tear <= 1.2) {
      const c = fcos(f.roll);
      const s = fsin(f.roll);
      const ox = inp.foeX;
      const oy = inp.foeY;
      for (const fl of this.fil) {
        const u = fcos(fl.a) * f.rx * 0.98;
        const v = fsin(fl.a) * f.ry * 0.98;
        const ax = hubX + (u * c - v * s) * facing;
        const ay = hubY + u * s + v * c;
        const tx = ox - fl.side * 2 * facing - 6 * fcos(fl.side * 0.9) * facing;
        const ty = oy + fl.side * 7;
        const mx = (ax + tx) / 2 + fl.side * 14 * facing + fsin(this.T * 1.7 + fl.ph) * (W > 2 ? 2 : 6);
        const my = (ay + ty) / 2 - 10 + fl.side * 8 + (W > 2 && W < 3.5 ? -4 * hardT : 0);
        const len = Math.sqrt((tx - ax) * (tx - ax) + (ty - ay) * (ty - ay));
        const N = Math.ceil(len * 1.6);
        let lx = 1e9;
        let ly = 1e9;
        const pts: number[] = [];
        for (let k = 0; k <= N; k++) {
          const q = k / N;
          if (q > grow) break;
          const x = Math.round(
            (1 - q) * (1 - q) * ax +
              2 * (1 - q) * q * mx +
              q * q * tx +
              fsin(q * 20 + this.T * 3 + fl.ph) * 0.6 * (1 - q),
          );
          const y = Math.round((1 - q) * (1 - q) * ay + 2 * (1 - q) * q * my + q * q * ty);
          pts.push(x, y);
          if (x === lx && y === ly) continue;
          lx = x;
          ly = y;
          if (tear > 0) {
            if (Math.abs(q - 0.5) < tear * 0.6) continue;
            if (BAY8[((y & 7) << 3) | (x & 7)]! < tear - 0.2) continue;
          }
          let col =
            q > grow - 0.04
              ? C('collagen', 4)
              : Math.floor(q * 40) % 3 === 0
                ? C('collagen', 2)
                : C('vessel', 4 + (h2(x, y) > 0.6 ? 1 : 0));
          let e = 0;
          if (q < 0.35) fx.set(x, y + 1, C('vessel', 2));
          if (W > 2.0 && W < 3.5) {
            const ph = q * 4 + (W - 2) * 3;
            if (ph - Math.floor(ph) < 0.12) {
              col = C('core', 5);
              e = Math.round(0.3 * EM);
            }
          }
          fx.set(x, y, col, e);
        }
        for (const tw of fl.twigs) {
          if (tw.u > grow) continue;
          const pi = Math.min(pts.length / 2 - 1, Math.round(tw.u * N));
          if (pi < 0) continue;
          const bx0 = pts[pi * 2]!;
          const by0 = pts[pi * 2 + 1]!;
          const L = tw.l * Math.min(1, (grow - tw.u) * 5);
          for (let k = 1; k <= L; k++) {
            const x = Math.round(bx0 + fcos(tw.a - Math.PI / 2) * k * facing);
            const y = Math.round(by0 + fsin(tw.a - Math.PI / 2) * k * 0.7);
            if (tear > 0 && BAY8[((y & 7) << 3) | (x & 7)]! < tear) continue;
            fx.set(x, y, C('vessel', 2));
          }
        }
      }
    }
    // the web creeps over the foe (2.0 → 3.5 s), then fades
    if (W > 2.0 && W < 4.4) {
      const reach = (W - 2.0) * 16;
      const fade = W > 3.5 ? ss(3.5, 4.4, W) : 0;
      for (const [x0, y0, d] of this.web) {
        if (d > reach) continue;
        const x = Math.round(inp.foeX + x0 * facing);
        const y = Math.round(inp.foeY + y0);
        if (BAY8[((y & 7) << 3) | (x & 7)]! < fade) continue;
        fx.set(x, y, d % 3 === 0 ? foeLit : foeDark);
      }
    }
  }
}
