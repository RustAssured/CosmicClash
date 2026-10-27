import { hex, pb, pg, pr, type MatterMap, type RenderLayer } from '@/contracts';
import { DMath } from '@/contracts/dmath';
import type { LastOneRig } from '@/titans';
import { BAY8, BodySkin, IdleClock, IdleRng, Pool, clampN, fcos, fsin, h2, ss } from '../fx/idle';
import type { Overlay } from '../fx/overlay';
import { NODES, type TendrilSystem } from './tendrils';

/**
 * THE WITNESS'S LIVING IDLE, render side (idle handover: specs/witness.md, prototype `witness.src.html`; WJ: "an idol that
 * swims… Love it!!!"). The motion that is hit (the veil, the swim, the tilt, the pulse, taste and the Five Witnesses' clock)
 * is sim state in lastonePose.ts; everything here only recolours, stepped once per sim tick from that tick's recorded inputs.
 *  - The body is presented as a skin (the live map with the idle's edits): the hem pulls in by whole-pixel rims on the
 *    stroke; the lantern beats and its light runs out through the lattice and the seams; a glint crosses the glaze; the halo's
 *    glint runs the ring and its gems precess (gathering behind the lead eye for the testimony).
 *  - Five eyes, five minds: the lead eye follows the foe with overshooting saccades, one darts, one looks behind, one lags,
 *    one looks where the foe was 1.6 s ago; out-of-step blinks; a lock narrows every pupil; the socket bevels turn like
 *    apertures and align for the testimony.
 *  - An overlay: spores off the tips, the tips igniting one by one, the five testimony marks closing on the foe.
 * Pristine cells only (integrity 255, no fight flags): damage, char and cracks keep the fight's drawing. Every colour is a
 * step along the Witness's own ladders (its painted colours and ramps, by luminance).
 */

export interface WitnessIdleInput {
  /** The sim pose's clock (ticks), weight, Witness seconds (−1 none), seconds since the pulse. */
  pt: number;
  w: number;
  wit: number;
  pu: number;
  ko: boolean;
  koTicks: number;
  hitstun: boolean;
  /** A Gaze is charging (the eyes hold open). */
  gaze: boolean;
  facing: 1 | -1;
  /** Body anchor (world) and the foe (world). */
  x: number;
  y: number;
  foeX: number;
  foeY: number;
}

const RING = 16;
const MEM = 96;
const DT = IdleClock.DT;
const TAU = Math.PI * 2;
const FIGHT_FLAGS = 1 | 2 | 4 | 8 | 64;
/** The prototype's glow scale (0..0.35) onto emissive bytes. */
const EM = 255;

const lum = (c: number): number => 0.3 * pr(c) + 0.59 * pg(c) + 0.11 * pb(c);
/** First index whose value is ≥ v in an ascending array. */
function lowerBound(a: Float32Array, v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
const adiff = (a: number, b: number): number => {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return d;
};

interface Eye {
  k: number;
  cx: number;
  cy: number;
  r: number;
  rp: number;
  tilt: number;
  gmax: number;
  gx: number;
  gy: number;
  /** Saccade: on, start (step), from, to. */
  sOn: boolean;
  sT0: number;
  sFx: number;
  sFy: number;
  sTx: number;
  sTy: number;
  next: number;
  dartA: number;
  dartUntil: number;
  slow: number;
  slowOn: boolean;
  lid: number;
  blinkT0: number;
  ap: number;
  apv: number;
  k2: number;
  /** The socket's annulus: cells, angles, radii; its polar table. */
  ann: Int32Array;
  annA: Float32Array;
  annD: Float32Array;
  aR0: number;
  tab: Int32Array;
  /** Cells of the eye disc, and each one's distance from the eye's centre and the ray's cos / sin (fixed). */
  cells: Int32Array;
  cellD: Float32Array;
  cellC: Float32Array;
  cellS: Float32Array;
}

interface Gem {
  a: number;
  rho: number;
  off: number;
  sdx: Int8Array;
  sdy: Int8Array;
  /** The sprite's source cells (their colour is read from the painted body). */
  src: Int32Array;
}

interface Spore {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  ph: number;
}

export class WitnessIdle {
  private readonly W: number;
  private readonly H: number;
  private readonly N: number;
  private readonly ids: LastOneRig['ids'];
  private readonly anchorX: number;
  private readonly anchorY: number;
  /* the painted body (the first lit frame), the ladders built from it */
  private pi0!: Uint32Array;
  private ready = false;
  private readonly lad: number[][] = [];
  private readonly rank: Map<number, number>[] = [];
  private readonly ramps: Record<string, number[]>;
  /* map facts */
  private readonly mat0: Uint8Array;
  private readonly dCore: Float32Array;
  private readonly rim: Uint8Array;
  private readonly craze: Uint8Array;
  private readonly eyeOf: Int8Array;
  private readonly annOf: Int8Array;
  private readonly ringOf: Uint8Array;
  private readonly ringA: Float32Array;
  private readonly ringR: Float32Array;
  private readonly pathOf: Uint8Array;
  private readonly gemCell: Uint8Array;
  private readonly plainOf: Int32Array;
  private readonly eyes: Eye[] = [];
  private readonly gems: Gem[] = [];
  /** Cell lists: core, inner + seam (lantern), inner + shell (glaze), ring, rim. */
  private readonly coreL: Int32Array;
  private readonly litL: Int32Array;
  private readonly litD: Float32Array;
  private readonly seamL: Int32Array;
  private readonly glazeL: Int32Array;
  private readonly glazeK: Float32Array;
  /** Scratch: the lantern's light level per cell this frame, and the cells it touched. */
  private readonly litBuf: Uint8Array;
  private readonly touched: Int32Array;
  private readonly ringL: Int32Array;
  private readonly rimL: Int32Array;
  /** Tendrils in order round the core (the tips ignite in turn). */
  private readonly order: Int16Array;
  private readonly ell: { cx: number; cy: number; a: number; b: number; c: number; s: number };
  /* state */
  readonly clock = new IdleClock();
  private readonly ringIn: WitnessIdleInput[];
  private readonly ringTick = new Int32Array(RING).fill(-1);
  private readonly lastIn: WitnessIdleInput;
  private readonly memX = new Float32Array(MEM);
  private readonly memY = new Float32Array(MEM);
  private memN = 0;
  private readonly rng: IdleRng;
  private readonly seed: number;
  private steps = 0;
  private lockT0 = -1;
  private nextLock = 390;
  private nextBlink = 150;
  private nextBeat = 36;
  private nextGlint = 60;
  private nextSpore = 90;
  private readonly beats = new Pool<{ t0: number; big: boolean }>(6, () => ({ t0: 0, big: false }));
  private readonly glints = new Pool<{ t0: number }>(3, () => ({ t0: 0 }));
  private readonly spores = new Pool<Spore>(24, () => ({ x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 1, ph: 0 }));
  private readonly skin: BodySkin;
  private skinVer = -1;
  private dirty = true;
  /** Tendril tips per recorded tick (the spores' sources). */
  private readonly nT: number;
  private readonly tipX: Float32Array;
  private readonly tipY: Float32Array;

  constructor(
    map: MatterMap,
    rig: LastOneRig,
    materials: { key: string; visual: { ramp: string[] } }[],
    anchor: { x: number; y: number },
    seed: number,
  ) {
    const W = (this.W = map.w);
    const H = (this.H = map.h);
    const N = (this.N = W * H);
    this.ids = rig.ids;
    this.anchorX = anchor.x;
    this.anchorY = anchor.y;
    this.seed = seed;
    this.rng = new IdleRng(seed);
    this.skin = new BodySkin(W, H);
    this.nT = rig.roots.length;
    this.tipX = new Float32Array(RING * this.nT);
    this.tipY = new Float32Array(RING * this.nT);
    this.ramps = {};
    for (const m of materials) this.ramps[m.key] = m.visual.ramp.map((h) => (hex(h) | 0xff000000) >>> 0);
    const I = this.ids;
    const mat = (this.mat0 = Uint8Array.from(map.material));
    const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= W || y >= H ? 0 : mat[y * W + x]!);
    const cx0 = rig.core.x + 0.5;
    const cy0 = rig.core.y + 0.5;
    this.dCore = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = i % W;
      const y = (i - x) / W;
      this.dCore[i] = Math.sqrt((x + 0.5 - cx0) * (x + 0.5 - cx0) + (y + 0.5 - cy0) * (y + 0.5 - cy0));
    }
    // the halo's ellipse
    const HA = rig.halo;
    this.ell = { cx: HA.cx, cy: HA.cy, a: HA.a, b: HA.b, c: DMath.cos(HA.tilt), s: DMath.sin(HA.tilt) };
    // eyes: centre from the pupil; the socket bevel as a polar table (it turns like an aperture)
    this.eyeOf = new Int8Array(N).fill(-1);
    this.annOf = new Int8Array(N).fill(-1);
    rig.eyes.forEach((e, k) => {
      let sx = 0;
      let sy = 0;
      let c = 0;
      for (let y = Math.floor(e.y - e.r); y <= e.y + e.r; y++)
        for (let x = Math.floor(e.x - e.r); x <= e.x + e.r; x++)
          if (at(x, y) === I.pupil && DMath.hypot(x - e.x, y - e.y) < e.r) {
            sx += x + 0.5;
            sy += y + 0.5;
            c++;
          }
      const ecx = c ? sx / c : e.x + 0.5;
      const ecy = c ? sy / c : e.y + 0.5;
      const aR0 = e.socketR - 2.5;
      const aR1 = e.socketR + 1.5;
      const NA = 96;
      const NR = 9;
      const tab = new Int32Array(NA * NR).fill(-1);
      const ann: number[] = [];
      const annA: number[] = [];
      const annD: number[] = [];
      for (let y = Math.floor(ecy - aR1 - 1); y <= ecy + aR1 + 1; y++)
        for (let x = Math.floor(ecx - aR1 - 1); x <= ecx + aR1 + 1; x++) {
          if (!at(x, y)) continue;
          const d = DMath.hypot(x + 0.5 - ecx, y + 0.5 - ecy);
          if (d < aR0 || d > aR1) continue;
          const a = DMath.atan2(y + 0.5 - ecy, x + 0.5 - ecx);
          const i = y * W + x;
          ann.push(i);
          annA.push(a);
          annD.push(d);
          const ri = clampN(Math.round((d - aR0) * 2), 0, NR - 1);
          const ai = ((Math.round((a / TAU) * NA) % NA) + NA) % NA;
          tab[ri * NA + ai] = i;
        }
      for (let ri = 0; ri < NR; ri++)
        for (let pass = 0; pass < 3; pass++)
          for (let ai = 0; ai < NA; ai++)
            if (tab[ri * NA + ai]! < 0) {
              const l = tab[ri * NA + ((ai + NA - 1) % NA)]!;
              const r = tab[ri * NA + ((ai + 1) % NA)]!;
              if (l >= 0) tab[ri * NA + ai] = l;
              else if (r >= 0) tab[ri * NA + ai] = r;
            }
      const cells: number[] = [];
      for (let y = Math.floor(ecy - e.r - 1); y <= ecy + e.r + 1; y++)
        for (let x = Math.floor(ecx - e.r - 1); x <= ecx + e.r + 1; x++) {
          if (!at(x, y)) continue;
          if (DMath.hypot(x + 0.5 - ecx, y + 0.5 - ecy) <= e.r + 0.6) {
            this.eyeOf[y * W + x] = k;
            cells.push(y * W + x);
          }
        }
      this.eyes.push({
        k,
        cx: ecx,
        cy: ecy,
        r: e.r,
        rp: Math.max(1, Math.sqrt(c / Math.PI)),
        tilt: e.tilt,
        gmax: Math.max(1, Math.round(e.r * 0.3)),
        gx: 0,
        gy: 0,
        sOn: false,
        sT0: 0,
        sFx: 0,
        sFy: 0,
        sTx: 0,
        sTy: 0,
        next: 0,
        dartA: 0,
        dartUntil: -1,
        slow: 0,
        slowOn: false,
        lid: 1,
        blinkT0: -1,
        ap: 0,
        apv: 0.05 * (k % 2 ? -1 : 1) * (0.6 + k * 0.2),
        k2: 0,
        ann: Int32Array.from(ann),
        annA: Float32Array.from(annA),
        annD: Float32Array.from(annD),
        aR0,
        tab,
        cells: Int32Array.from(cells),
        cellD: Float32Array.from(cells, (i) =>
          DMath.hypot((i % W) + 0.5 - ecx, Math.floor(i / W) + 0.5 - ecy),
        ),
        cellC: Float32Array.from(cells, (i) =>
          DMath.cos(DMath.atan2(Math.floor(i / W) + 0.5 - ecy, (i % W) + 0.5 - ecx)),
        ),
        cellS: Float32Array.from(cells, (i) =>
          DMath.sin(DMath.atan2(Math.floor(i / W) + 0.5 - ecy, (i % W) + 0.5 - ecx)),
        ),
      });
    });
    for (const E of this.eyes) for (const i of E.ann) if (this.eyeOf[i]! < 0) this.annOf[i] = E.k;
    // the halo ring, the path its gems may travel (empty cells included)
    this.ringOf = new Uint8Array(N);
    this.ringA = new Float32Array(N);
    this.ringR = new Float32Array(N);
    this.pathOf = new Uint8Array(N);
    const ringL: number[] = [];
    for (let i = 0; i < N; i++) {
      const x = i % W;
      const y = (i - x) / W;
      const [a, rho] = this.ellOf(x + 0.5, y + 0.5);
      this.ringA[i] = a;
      this.ringR[i] = rho;
      if (Math.abs(rho - 1) < 0.075 && mat[i] === I.gilt && this.eyeOf[i]! < 0 && this.annOf[i]! < 0) {
        this.ringOf[i] = 1;
        ringL.push(i);
      }
      if (Math.abs(rho - 1) < 0.1 && !mat[i]) this.pathOf[i] = 1;
    }
    this.ringL = Int32Array.from(ringL);
    // the hem: lower-mantle rims that pull in on the stroke
    this.rim = new Uint8Array(N);
    const hemTop = cy0 + 12;
    const edge: number[] = [];
    for (let i = 0; i < N; i++) {
      if (!mat[i] || this.ringOf[i]) continue;
      const x = i % W;
      const y = (i - x) / W;
      if (y < hemTop) continue;
      if (!at(x + 1, y) || !at(x - 1, y) || !at(x, y + 1)) {
        this.rim[i] = 1;
        edge.push(i);
      }
    }
    for (const i of edge) {
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, -1],
        [0, 1],
      ] as const) {
        const j = (y + dy) * W + x + dx;
        if (j >= 0 && j < N && mat[j] && !this.rim[j] && !this.ringOf[j]) this.rim[j] = 2;
      }
    }
    const rimL: number[] = [];
    for (let i = 0; i < N; i++) if (this.rim[i]) rimL.push(i);
    this.rimL = Int32Array.from(rimL);
    // the glaze's crazing: a fixed web of hairline cracks
    this.craze = new Uint8Array(N);
    const coreL: number[] = [];
    const litL: number[] = [];
    const glazeL: number[] = [];
    for (let i = 0; i < N; i++) {
      const m = mat[i]!;
      if (m === I.core) coreL.push(i);
      if (m === I.inner || m === I.seam) litL.push(i);
      if (m !== I.inner && m !== I.shell) continue;
      glazeL.push(i);
      const x = i % W;
      const y = (i - x) / W;
      const bx = Math.floor(x / 5);
      const by = Math.floor((y + (bx & 1) * 2) / 5);
      if (h2(bx, by) > 0.5 ? x % 5 === 0 : (y + (bx & 1) * 2) % 5 === 0) this.craze[i] = 1;
    }
    this.coreL = Int32Array.from(coreL);
    // sorted by the key a front sweeps along (distance from the core; the glint's diagonal), so a tick visits only the band
    // of cells a front is crossing (a range search), not the whole lattice
    litL.sort((a, b) => this.dCore[a]! - this.dCore[b]!);
    this.litL = Int32Array.from(litL);
    this.litD = Float32Array.from(litL, (i) => this.dCore[i]!);
    const gk = (i: number): number => (i % W) * 0.8 + Math.floor(i / W) * 0.6;
    glazeL.sort((a, b) => gk(a) - gk(b));
    this.glazeL = Int32Array.from(glazeL);
    this.glazeK = Float32Array.from(glazeL, gk);
    const seams: number[] = [];
    for (const i of litL) if (mat[i] === I.seam) seams.push(i);
    this.seamL = Int32Array.from(seams);
    this.litBuf = new Uint8Array(N);
    this.touched = new Int32Array(litL.length);
    this.gemCell = new Uint8Array(N);
    this.plainOf = new Int32Array(N).fill(-1);
    const ord = rig.roots.map((_, i) => i);
    ord.sort(
      (a, b) =>
        DMath.atan2(rig.roots[a]!.y - cy0, rig.roots[a]!.x - cx0) -
        DMath.atan2(rig.roots[b]!.y - cy0, rig.roots[b]!.x - cx0),
    );
    this.order = new Int16Array(rig.roots.length);
    ord.forEach((ti, idx) => (this.order[ti] = idx));
    const mk = (): WitnessIdleInput => ({
      pt: 0,
      w: 0,
      wit: -1,
      pu: 99,
      ko: false,
      koTicks: 0,
      hitstun: false,
      gaze: false,
      facing: 1,
      x: 0,
      y: 0,
      foeX: 0,
      foeY: 0,
    });
    this.ringIn = Array.from({ length: RING }, mk);
    this.lastIn = mk();
    this.buildGems(map.baseColor);
  }

  private ellOf(x: number, y: number): [number, number] {
    const E = this.ell;
    const dx = x - E.cx;
    const dy = y - E.cy;
    const u = dx * E.c + dy * E.s;
    const v = -dx * E.s + dy * E.c;
    return [DMath.atan2(v / E.b, u / E.a), DMath.hypot(u / E.a, v / E.b)];
  }

  /**
   * The ladders are built from the first lit frame of the pristine body (the matter world lights `pixels`; the ladders must
   * hold the colours actually drawn). They are data only: no idle state depends on when this runs.
   */
  private build(map: MatterMap): void {
    const N = this.N;
    this.pi0 = Uint32Array.from(map.pixels);
    const nm = 1 + Math.max(...Object.values(this.ids));
    const keyOf = Object.entries(this.ids);
    for (let m = 0; m < nm; m++) {
      const set = new Set<number>();
      for (let i = 0; i < N; i++) if (this.mat0[i] === m && this.pi0[i]) set.add(this.pi0[i]! >>> 0);
      const key = keyOf.find(([, id]) => id === m)?.[0];
      for (const c of (key && this.ramps[key]) || []) set.add(c);
      const L = [...set].sort((a, b) => lum(a) - lum(b));
      this.lad[m] = L;
      const R = new Map<number, number>();
      L.forEach((c, k) => R.set(c, k));
      this.rank[m] = R;
    }
    this.ready = true;
  }

  /**
   * The gems: pink beads on the ring (with their gilt setting), lifted off and set travelling. Found from the painted colours
   * at attach, so they travel from the first tick whenever the first frame is drawn (frame-rate independence).
   */
  private buildGems(pi0: Uint32Array): void {
    const N = this.N;
    const W = this.W;
    const I = this.ids;
    const isG = (i: number): boolean => {
      if (!this.ringOf[i]) return false;
      const c = pi0[i]!;
      return pr(c) - pg(c) > 40 || (pr(c) > 180 && pb(c) > 140 && pr(c) - pg(c) > 25);
    };
    const seen = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (!isG(i) || seen[i]) continue;
      const q = [i];
      const list: number[] = [];
      seen[i] = 1;
      while (q.length) {
        const j = q.pop()!;
        list.push(j);
        const x = j % W;
        const y = (j - x) / W;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const k = (y + dy) * W + x + dx;
            if (k >= 0 && k < N && !seen[k] && isG(k)) {
              seen[k] = 1;
              q.push(k);
            }
          }
      }
      let sx = 0;
      let sy = 0;
      for (const j of list) {
        sx += (j % W) + 0.5;
        sy += Math.floor(j / W) + 0.5;
      }
      const gx = sx / list.length;
      const gy = sy / list.length;
      const dxs: number[] = [];
      const dys: number[] = [];
      const src: number[] = [];
      for (let y = Math.floor(gy) - 3; y <= gy + 3; y++)
        for (let x = Math.floor(gx) - 3; x <= gx + 3; x++) {
          const j = y * W + x;
          if (j < 0 || j >= N) continue;
          const d = DMath.hypot(x + 0.5 - gx, y + 0.5 - gy);
          const gilt = this.mat0[j] === I.gilt;
          if (
            isG(j) ||
            (gilt && this.ringOf[j] && d < 2.3) ||
            (gilt && !this.ringOf[j] && this.eyeOf[j]! < 0 && this.annOf[j]! < 0 && d < 2.6)
          ) {
            dxs.push(x - Math.round(gx));
            dys.push(y - Math.round(gy));
            src.push(j);
          }
        }
      for (const j of src) this.gemCell[j] = 1;
      const [a, rho] = this.ellOf(gx, gy);
      this.gems.push({
        a,
        rho,
        off: 0,
        sdx: Int8Array.from(dxs),
        sdy: Int8Array.from(dys),
        src: Int32Array.from(src),
      });
    }
    // what a gem leaves behind: the plain ring colour nearest along the ring (−2: it stood off the ring)
    for (let i = 0; i < N; i++) {
      if (!this.gemCell[i]) continue;
      if (!this.ringOf[i]) {
        this.plainOf[i] = -2;
        continue;
      }
      let best = -1;
      let bd = 1e9;
      const x = i % W;
      const y = (i - x) / W;
      for (let dy = -5; dy <= 5; dy++)
        for (let dx = -5; dx <= 5; dx++) {
          const j = (y + dy) * W + x + dx;
          if (j < 0 || j >= N || !this.ringOf[j] || this.gemCell[j]) continue;
          const d = Math.abs(this.ringR[j]! - this.ringR[i]!) * 60 + Math.sqrt(dx * dx + dy * dy) * 0.3;
          if (d < bd) {
            bd = d;
            best = j;
          }
        }
      this.plainOf[i] = best;
    }
  }

  /* ---- ladders ---- */
  private stepC(c: number, m: number, k: number): number {
    const L = this.lad[m];
    const r = this.rank[m]?.get(c >>> 0);
    if (!L || r === undefined) return c;
    return L[clampN(r + k, 0, L.length - 1)]!;
  }
  private xl(c: number, m: number, m2: number, k: number): number {
    const L = this.lad[m];
    const L2 = this.lad[m2];
    const r = this.rank[m]?.get(c >>> 0);
    if (!L || !L2 || r === undefined) return c;
    const u = L.length > 1 ? r / (L.length - 1) : 0.5;
    return L2[clampN(Math.round(u * (L2.length - 1)) + k, 0, L2.length - 1)]!;
  }
  private ladAt(m: number, u: number): number {
    const L = this.lad[m]!;
    return L[clampN(Math.round(u * (L.length - 1)), 0, L.length - 1)]!;
  }

  reset(): void {
    this.clock.reset();
    this.rng.reseed(this.seed);
    this.ringTick.fill(-1);
    this.memN = 0;
    this.steps = 0;
    this.lockT0 = -1;
    this.nextLock = 390;
    this.nextBlink = 150;
    this.nextBeat = 36;
    this.nextGlint = 60;
    this.nextSpore = 90;
    this.beats.clear();
    this.glints.clear();
    this.spores.clear();
    for (const E of this.eyes) {
      E.gx = E.gy = 0;
      E.sOn = false;
      E.next = 0;
      E.dartUntil = -1;
      E.slowOn = false;
      E.lid = 1;
      E.blinkT0 = -1;
      E.ap = 0;
      E.k2 = 0;
    }
    for (const G of this.gems) G.off = 0;
    this.skinVer = -1;
    this.dirty = true;
  }

  record(tick: number, inp: WitnessIdleInput): void {
    if (this.clock.last < 0) this.clock.last = tick - 1;
    const k = tick & (RING - 1);
    Object.assign(this.ringIn[k]!, inp);
    this.ringTick[k] = tick;
    Object.assign(this.lastIn, inp);
  }
  private inputAt(tick: number): WitnessIdleInput {
    const k = tick & (RING - 1);
    return this.ringTick[k] === tick ? this.ringIn[k]! : this.lastIn;
  }

  advance(tick: number): boolean {
    const n = this.clock.due(tick);
    for (let i = 0; i < n; i++) {
      const tk = tick - n + 1 + i;
      this.step(this.inputAt(tk));
      if (this.steps > this.nextSpore) {
        this.nextSpore = this.steps + 21 + Math.floor(this.rng.next() * 54);
        if (this.inputAt(tk).w > 0.5 && this.ringTick[tk & (RING - 1)] === tk) this.spawnSpore(tk);
      }
    }
    if (n > 0) this.dirty = true;
    return n > 0;
  }

  /** Map-local angle from eye E to a world point (the drawn facing mirrors x). */
  private angTo(E: Eye, inp: WitnessIdleInput, wx: number, wy: number): number {
    const ex = inp.x + (E.cx - this.anchorX) * inp.facing;
    const ey = inp.y + (E.cy - this.anchorY);
    return DMath.atan2(wy - ey, (wx - ex) * inp.facing);
  }

  private step(inp: WitnessIdleInput): void {
    this.clock.t += DT;
    const st = ++this.steps;
    const R = this.rng;
    const W = inp.wit;
    const wit = W >= 0;
    const calm = inp.w > 0.9 && !inp.ko;
    // the foe's track for the eye that looks where it was
    this.memX[st % MEM] = inp.foeX;
    this.memY[st % MEM] = inp.foeY;
    this.memN = Math.min(MEM, this.memN + 1);
    // ---- moments: a lock, a blink (one eye), lantern beats, glaze glints, spores ----
    if (calm && (!wit || W > 6.5)) {
      if (st > this.nextLock) {
        this.lockT0 = st;
        this.nextLock = st + 360 + Math.floor(R.next() * 360);
      }
      if (st > this.nextBlink) {
        const E = this.eyes[Math.floor(R.next() * this.eyes.length)];
        if (E && E.blinkT0 < 0) E.blinkT0 = st;
        this.nextBlink = st + 96 + Math.floor(R.next() * 180);
      }
    }
    if (this.lockT0 >= 0 && (st - this.lockT0 > 84 || !calm)) this.lockT0 = -1;
    if (st > this.nextBeat) {
      const b = this.beats.alloc();
      if (b) {
        b.t0 = st;
        b.big = wit && W > 1.6 && W < 2.4;
      }
      this.nextBeat = st + (wit && W > 1.4 && W < 4 ? 54 : 114 + Math.floor(R.next() * 24));
    }
    for (let i = this.beats.n - 1; i >= 0; i--) if (st - this.beats.items[i]!.t0 > 180) this.beats.kill(i);
    if (st > this.nextGlint) {
      const g = this.glints.alloc();
      if (g) g.t0 = st;
      this.nextGlint = st + 300 + Math.floor(R.next() * 180);
    }
    for (let i = this.glints.n - 1; i >= 0; i--) if (st - this.glints.items[i]!.t0 > 240) this.glints.kill(i);
    // ---- five eyes, five minds ----
    const locked = (this.lockT0 >= 0 && calm) || (wit && W > 1.3 && W < 4.6);
    const t = st * DT;
    for (const E of this.eyes) {
      let a = this.angTo(E, inp, inp.foeX, inp.foeY);
      // in the fight every eye is on the foe; at rest each has its own mind
      if (!locked && inp.w > 0.5) {
        if (E.k === 1) {
          if (st > E.dartUntil) {
            E.dartA = R.next() * TAU;
            E.dartUntil = st + 21 + Math.floor(R.next() * 42);
          }
          a = E.dartA;
        } else if (E.k === 2) a = a + Math.PI + fsin(t * 0.3) * 0.8;
        else if (E.k === 3) {
          if (!E.slowOn) {
            E.slow = a;
            E.slowOn = true;
          } else E.slow = E.slow + adiff(a, E.slow) * (0.5 * DT);
          a = E.slow;
        } else if (E.k === 4 && this.memN >= MEM) {
          const j = (st + 1) % MEM;
          a = this.angTo(E, inp, this.memX[j]!, this.memY[j]!);
        }
      }
      const wx = clampN(Math.round(fcos(a) * E.gmax), -E.gmax, E.gmax);
      const wy = clampN(Math.round(fsin(a) * E.gmax), -E.gmax, E.gmax);
      const due = locked || E.k === 1 || inp.w <= 0.5 || st > E.next;
      if (!E.sOn && due && (wx !== E.gx || wy !== E.gy)) {
        E.sOn = true;
        E.sT0 = st;
        E.sFx = E.gx;
        E.sFy = E.gy;
        E.sTx = wx;
        E.sTy = wy;
        E.next =
          st +
          (E.k === 0 ? 72 + Math.floor(R.next() * 150) : E.k === 3 ? 24 : 48 + Math.floor(R.next() * 120));
      }
      if (E.sOn) {
        const u = st - E.sT0;
        const jump = Math.abs(E.sTx - E.sFx) + Math.abs(E.sTy - E.sFy);
        if (u < 1) {
          // every saccade passes through one in-between frame
          E.gx = Math.round((E.sFx + E.sTx) / 2);
          E.gy = Math.round((E.sFy + E.sTy) / 2);
        } else if (u < 4 && E.k === 0 && jump >= 2) {
          // the lead eye overshoots a long jump by a pixel
          E.gx = clampN(E.sTx + Math.sign(E.sTx - E.sFx), -E.gmax - 1, E.gmax + 1);
          E.gy = clampN(E.sTy + Math.sign(E.sTy - E.sFy), -E.gmax - 1, E.gmax + 1);
        } else {
          E.gx = E.sTx;
          E.gy = E.sTy;
          E.sOn = false;
        }
      }
      // lids: a blink (closes 0.09 s, shut to 0.16 s, opens by 0.42 s); open through the testimony; the fight's own lids
      E.lid = 1;
      if (E.blinkT0 >= 0) {
        const u = (st - E.blinkT0) * DT;
        E.lid = u < 0.09 ? 1 - u / 0.09 : u < 0.16 ? 0 : ss(0.16, 0.42, u);
        if (u > 0.42) E.blinkT0 = -1;
      }
      if (inp.gaze || (wit && W > 1.3 && W < 4.6)) {
        E.lid = 1;
        E.blinkT0 = -1;
      }
      if (inp.hitstun) E.lid = Math.min(E.lid, 0.5);
      if (inp.ko) E.lid = Math.min(E.lid, 1 - clampN((inp.koTicks - E.k * 3) / 20, 0, 1) * 0.7);
      E.k2 = locked ? -Math.min(Math.max(1, Math.round(E.rp) - 1), 2) : 0;
      // socket bevels turn like apertures; they align for the testimony
      if (wit && W > 1.4 && W < 4.6) E.ap = E.ap + adiff(0, E.ap) * (1 - DMath.exp(-DT * 3));
      else E.ap += E.apv * DT * inp.w;
    }
    // ---- halo gems: precessing, gathering behind the lead eye for the testimony ----
    const lead = this.eyes[0];
    for (let k = 0; k < this.gems.length; k++) {
      const G = this.gems[k]!;
      if (wit && W > 1.6 && W < 4.6 && lead) {
        const to = this.ellOf(lead.cx, lead.cy)[0] + (k - (this.gems.length - 1) / 2) * 0.16;
        G.off = G.off + adiff(to - G.a, G.off) * (1 - DMath.exp(-DT * 2.2));
      } else G.off += DT * 0.11 * inp.w;
    }
    // ---- spores ----
    for (let i = this.spores.n - 1; i >= 0; i--) {
      const s = this.spores.items[i]!;
      s.age += DT;
      if (s.age > s.life) {
        this.spores.kill(i);
        continue;
      }
      s.x += (s.vx + fsin(s.age * 2 + s.ph) * 3) * DT;
      s.y += s.vy * DT;
      s.vy *= 1 - DT * 0.3;
    }
  }

  /** Record this tick's tendril tips (world; NaN = no tip), where that tick's spore may leave from. */
  recordTips(tick: number, sys: TendrilSystem): void {
    const k = tick & (RING - 1);
    const o = k * this.nT;
    for (let i = 0; i < this.nT; i++) {
      const cnt = sys.count[i]!;
      const j = i * NODES + cnt - 1;
      this.tipX[o + i] = cnt >= 2 ? sys.x[j]! : NaN;
      this.tipY[o + i] = cnt >= 2 ? sys.y[j]! : NaN;
    }
  }

  /** A spore leaves a random tip (the tips as recorded on that tick). */
  private spawnSpore(tick: number): void {
    const R = this.rng;
    const i = Math.floor(R.next() * this.nT);
    const o = (tick & (RING - 1)) * this.nT;
    const x = this.tipX[o + i]!;
    const y = this.tipY[o + i]!;
    const vx = (R.next() - 0.5) * 4;
    const vy = -4 - R.next() * 5;
    const life = 2 + R.next() * 2;
    const ph = R.next() * 9;
    if (Number.isNaN(x)) return;
    const s = this.spores.alloc();
    if (!s) return;
    s.x = x;
    s.y = y;
    s.vx = vx;
    s.vy = vy;
    s.age = 0;
    s.life = life;
    s.ph = ph;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  drawing
   * ---------------------------------------------------------------------------------------------- */

  /** Present the body as drawn in place of the body layer (rebuilt when a step ran or the map changed). */
  presentBody(map: MatterMap, body: RenderLayer): void {
    if (!this.ready) {
      if (!map.pixels.some((c) => c !== 0)) return;
      this.build(map);
    }
    const changed = this.dirty || map.version !== this.skinVer;
    if (changed) {
      this.dirty = false;
      this.skinVer = map.version;
      this.shade(map);
    }
    this.skin.present(body, changed);
  }

  private shade(map: MatterMap): void {
    const S = this.skin;
    S.copyFrom(map.pixels, map.emissive);
    const px = S.px;
    const em = S.emis;
    const inp = this.lastIn;
    const st = this.steps;
    const W = inp.wit;
    const wit = W >= 0;
    const w = inp.w;
    const I = this.ids;
    const MW = this.W;
    const mat = map.material;
    const integ = map.integrity;
    const flags = map.flags;
    const pi0 = this.pi0;
    const ok = (i: number): boolean => mat[i] !== 0 && integ[i] === 255 && (flags[i]! & FIGHT_FLAGS) === 0;
    if (w < 0.02) {
      // the fight (and a KO): only the eyes, with the fight's own lids
      this.shadeEyes(map, px, em, ok, false);
      return;
    }
    // the hem pulls in by whole-pixel rims on the stroke (render only: the matter keeps every cell)
    const pu = inp.pu;
    const c = (pu < 0.35 ? ss(0, 0.35, pu) : pu < 1.3 ? 1 - ss(0.35, 1.3, pu) : 0) * w;
    if (c > 0.35)
      for (const i of this.rimL)
        if (ok(i) && (this.rim[i] === 1 || c > 0.85)) {
          px[i] = 0;
          em[i] = 0;
        }
    // the lantern: beats in the core, light rising through the lattice and the seams
    const flood = wit ? ss(1.7, 2.1, W) * (1 - ss(4.2, 5.4, W)) : 0;
    let kCore = 0;
    for (let b = 0; b < this.beats.n; b++) {
      const B = this.beats.items[b]!;
      const u = (st - B.t0) * DT;
      if (u < 0.12) kCore = Math.max(kCore, B.big ? 2 : 1);
      else if (u < 0.3) kCore = Math.max(kCore, 1);
    }
    kCore = Math.max(kCore, Math.round(flood));
    if (kCore > 0)
      for (const i of this.coreL)
        if (ok(i) && px[i]) {
          px[i] = this.stepC(pi0[i]!, I.core, kCore);
          em[i] = Math.max(em[i]!, Math.round(0.035 * kCore * EM));
        }
    // each beat's front lights a thin ring of the lattice (3 px full, a 6 px dissolving tail): only that band is visited
    const litB = this.litBuf;
    const touched = this.touched;
    let nt = 0;
    for (let b = 0; b < this.beats.n; b++) {
      const B = this.beats.items[b]!;
      const r = (st - B.t0) * DT * (B.big ? 70 : 46);
      for (let n = lowerBound(this.litD, r - 9); n < this.litL.length && this.litD[n]! < r; n++) {
        const i = this.litL[n]!;
        const f = r - this.litD[n]!;
        let lit = 0;
        if (f > 0 && f < 3) lit = 2;
        else if (f >= 3 && f < 9) {
          const x = i % MW;
          const y = (i - x) / MW;
          if (BAY8[((y & 7) << 3) | (x & 7)]! > (f - 3) / 6) lit = 1;
        }
        if (lit === 0) continue;
        if (litB[i] === 0) touched[nt++] = i;
        if (lit > litB[i]!) litB[i] = lit;
      }
    }
    // the flood (the testimony): every seam, through a Bayer threshold
    if (flood > 0)
      for (const i of this.seamL) {
        const x = i % MW;
        const y = (i - x) / MW;
        if (BAY8[((y & 7) << 3) | (x & 7)]! >= flood) continue;
        if (litB[i] === 0) touched[nt++] = i;
        litB[i] = 3;
      }
    for (let n = 0; n < nt; n++) {
      const i = touched[n]!;
      const raw = litB[i]!;
      litB[i] = 0;
      if (!ok(i) || !px[i]) continue;
      // fading with distance from the core (the flood is not)
      const lit = raw === 3 ? 2 : raw * Math.max(0, 1 - this.dCore[i]! / 95);
      if (lit < 1) continue;
      if (mat[i] === I.seam) {
        px[i] = this.xl(pi0[i]!, I.seam, I.core, lit >= 2 ? 1 : -1);
        em[i] = Math.max(em[i]!, Math.round((lit >= 2 ? 0.3 : 0.1) * EM));
      } else px[i] = this.stepC(pi0[i]!, I.inner, 1);
    }
    // the glaze: a slow glint along the crazing (a diagonal band 5 px wide: only that band is visited)
    for (let g = 0; g < this.glints.n; g++) {
      const age = (st - this.glints.items[g]!.t0) * DT;
      const k1 = age * 55 + 30;
      for (let n = lowerBound(this.glazeK, k1 - 5); n < this.glazeL.length && this.glazeK[n]! < k1; n++) {
        const i = this.glazeL[n]!;
        if (!ok(i) || !px[i]) continue;
        const f = k1 - this.glazeK[n]!;
        if (f <= 0 || f >= 5) continue;
        const cz = this.craze[i] === 1;
        if (!cz && f >= 1.6) continue;
        px[i] = this.stepC(px[i] === pi0[i] ? pi0[i]! : px[i]!, mat[i]!, cz ? 2 : 1);
        if (cz && f < 2) em[i] = Math.max(em[i]!, Math.round(0.08 * EM));
      }
    }
    this.shadeEyes(map, px, em, ok, true);
    // the halo: a glint runs the ring; the gems travel
    const sweep = (st * DT * 0.5) % TAU;
    const bright = wit && W > 1.6 && W < 4.4;
    for (const i of this.ringL) {
      if (!ok(i) || !px[i]) continue;
      if (this.gemCell[i]) {
        const p = this.plainOf[i]!;
        // a gem's own cell takes the plain ring beside it (never paint into a destroyed one)
        px[i] = p >= 0 && ok(p) ? pi0[p]! : 0;
        continue;
      }
      const da = Math.abs(adiff(this.ringA[i]!, -sweep));
      if (da < 0.07) px[i] = this.stepC(pi0[i]!, I.gilt, 2);
      else if (da < 0.18 || bright) px[i] = this.stepC(pi0[i]!, I.gilt, 1);
    }
    for (const G of this.gems) {
      for (let s = 0; s < G.src.length; s++) {
        const j = G.src[s]!;
        if (!this.ringOf[j] && this.gemCell[j] && ok(j)) px[j] = 0;
      }
    }
    for (const G of this.gems) {
      const a = G.a + G.off;
      const E = this.ell;
      const u = fcos(a) * E.a * G.rho;
      const v = fsin(a) * E.b * G.rho;
      const X = Math.round(E.cx + u * E.c - v * E.s);
      const Y = Math.round(E.cy + u * E.s + v * E.c);
      for (let s = 0; s < G.src.length; s++) {
        const j0 = G.src[s]!;
        // a gem whose setting the fight destroyed stays gone
        if (integ[j0] === 0 || mat[j0] === 0) continue;
        const x = X + G.sdx[s]!;
        const y = Y + G.sdy[s]!;
        if (x < 0 || y < 0 || x >= MW || y >= this.H) continue;
        const i = y * MW + x;
        if (this.mat0[i] && !this.ringOf[i] && !this.gemCell[i]) continue;
        if (!this.mat0[i] && !this.pathOf[i]) continue;
        if (this.mat0[i] && !ok(i)) continue;
        const pc = pi0[j0]!;
        px[i] = bright ? this.stepC(pc, I.gilt, 1) : pc;
        if (pr(pc) - pg(pc) > 30) em[i] = Math.max(em[i]!, Math.round(0.15 * EM));
      }
    }
  }

  /** The eyes: the pupil re-sampled inside the iris by whole pixels, narrowing on a lock; lids; the turning bevels. */
  private shadeEyes(
    map: MatterMap,
    px: Uint32Array,
    em: Uint8Array,
    ok: (i: number) => boolean,
    idle: boolean,
  ): void {
    const I = this.ids;
    const MW = this.W;
    const N = this.N;
    const pi0 = this.pi0;
    const inp = this.lastIn;
    const W = inp.wit;
    const testimony = W >= 0 && W > 1.3 && W < 4.6;
    const lockOn = idle && (this.lockT0 >= 0 || testimony);
    for (const E of this.eyes) {
      const P = E.rp;
      const nP = Math.max(1, P + E.k2);
      const ca = fcos(-E.tilt);
      const sa = fsin(-E.tilt);
      const rr = E.r + 0.6;
      for (let n = 0; n < E.cells.length; n++) {
        const i = E.cells[n]!;
        if (!ok(i) || !px[i]) continue;
        const x = i % MW;
        const y = (i - x) / MW;
        const qx = x + 0.5;
        const qy = y + 0.5;
        // the lid: shell porcelain closing along the eye's own tilt, a seam lash line at its edge
        if (E.lid < 1) {
          const lx = (qx - E.cx) * ca - (qy - E.cy) * sa;
          const ly = (qx - E.cx) * sa + (qy - E.cy) * ca;
          const hh = Math.sqrt(Math.max(0, rr * rr - lx * lx));
          const up = -hh * E.lid;
          const lo = hh * Math.min(1, E.lid * 1.5 + 0.15);
          if (ly < up || ly > lo) {
            const edge = ly < up ? up - ly : ly - lo;
            px[i] =
              edge < 1
                ? (this.lad[I.seam]![1] ?? px[i]!)
                : this.ladAt(I.shell, clampN(0.75 - (edge / (hh + 1)) * 0.5, 0.2, 0.9));
            em[i] = 0;
            continue;
          }
        }
        const gx = E.gx;
        const gy = E.gy;
        const dp = Math.sqrt((qx - E.cx - gx) * (qx - E.cx - gx) + (qy - E.cy - gy) * (qy - E.cy - gy));
        let src = -1;
        if (dp <= P + 0.7) {
          if (dp > nP + 0.3) {
            // narrowed: the iris shows where the pupil gave way
            const a = DMath.atan2(qy - E.cy - gy, qx - E.cx - gx);
            src = Math.floor(E.cy + fsin(a) * (P + 1.4)) * MW + Math.floor(E.cx + fcos(a) * (P + 1.4));
          } else src = Math.floor(qy - gy) * MW + Math.floor(qx - gx);
        } else {
          const d0 = E.cellD[n]!;
          if (d0 <= P + 0.7) {
            // the cells the pupil vacated take the iris mirrored outward along the ray
            const r2 = P + 0.7 + (P + 0.7 - d0) + 0.6;
            src = Math.floor(E.cy + E.cellS[n]! * r2) * MW + Math.floor(E.cx + E.cellC[n]! * r2);
          }
        }
        if (src >= 0 && src < N && this.mat0[src] && ok(src)) px[i] = pi0[src]!;
        if (lockOn && map.material[i] === I.iris) {
          px[i] = this.stepC(px[i] === pi0[i] ? pi0[i]! : px[i]!, I.iris, 1);
          em[i] = Math.max(em[i]!, Math.round(0.08 * EM));
        }
      }
      if (!idle) continue;
      // the socket bevel as an aperture
      const NA = 96;
      for (let n = 0; n < E.ann.length; n++) {
        const i = E.ann[n]!;
        if (!ok(i) || !px[i]) continue;
        const ri = clampN(Math.round((E.annD[n]! - E.aR0) * 2), 0, 8);
        const ai = ((Math.round(((E.annA[n]! - E.ap) / TAU) * NA) % NA) + NA) % NA;
        const j = E.tab[ri * NA + ai]!;
        if (j >= 0 && ok(j)) px[i] = pi0[j]!;
      }
    }
  }

  /**
   * The overlay (world space): spores, the tips igniting one by one for the Five Witnesses, the testimony marks closing on
   * the foe with threads of sight from each eye.
   */
  drawFx(ov: Overlay, sys: TendrilSystem): void {
    if (!this.ready) return;
    const inp = this.lastIn;
    const W = inp.wit;
    const iris = this.ramps['iris'] ?? [];
    const gilt = this.ramps['gilt'] ?? [];
    const IR = (k: number): number => iris[clampN(k, 0, iris.length - 1)] ?? 0xffffffff;
    const GR = (k: number): number => gilt[clampN(k, 0, gilt.length - 1)] ?? 0xffffffff;
    // spores
    for (let n = 0; n < this.spores.n; n++) {
      const s = this.spores.items[n]!;
      const k = s.age / s.life;
      const x = Math.round(s.x);
      const y = Math.round(s.y);
      if (BAY8[((y & 7) << 3) | (x & 7)]! < k) continue;
      ov.set(x, y, k < 0.3 ? GR(5) : k < 0.65 ? IR(4) : GR(3), Math.round(0.15 * (1 - k) * EM));
    }
    if (W < 0) return;
    // the tips ignite in turn round the core
    for (let i = 0; i < sys.n; i++) {
      const cnt = sys.count[i]!;
      if (cnt < 3) continue;
      const idx = this.order[i]!;
      if (!(W > 1.0 + idx * 0.045 && W < 5.4 - idx * 0.03)) continue;
      const j = i * NODES + cnt - 1;
      const c = IR(6);
      ov.set(Math.round(sys.x[j]!), Math.round(sys.y[j]!), c, Math.round(0.35 * EM));
      ov.set(Math.round(sys.x[j - 1]!), Math.round(sys.y[j - 1]!), IR(5), Math.round(0.2 * EM));
    }
    // the testimony: five marks closing on the foe, spinning in whole steps; threads of sight for a breath
    if (W < 1.8 || W > 4.8) return;
    const u = W - 1.8;
    const fade = W > 4.0 ? ss(4.0, 4.8, W) : 0;
    const rr = [26, 19, 14, 11, 10][Math.min(4, Math.floor(u * 14))]!;
    const spin = Math.floor(u * 3) * (TAU / 30);
    const ox = Math.round(inp.foeX);
    const oy = Math.round(inp.foeY);
    for (let k = 0; k < 5; k++) {
      const a = -Math.PI / 2 + (k * TAU) / 5 + spin;
      const x = Math.round(ox + fcos(a) * rr);
      const y = Math.round(oy + fsin(a) * rr);
      const c = IR(k === 0 ? 6 : 5);
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const X = x + dx;
        const Y = y + dy;
        if (BAY8[((Y & 7) << 3) | (X & 7)]! < fade) continue;
        ov.set(X, Y, dx || dy ? IR(3) : c, Math.round(0.35 * EM));
      }
      const E = this.eyes[k];
      if (u < 0.6 && E) {
        const ex = inp.x + (E.cx - this.anchorX) * inp.facing;
        const ey = inp.y + (E.cy - this.anchorY);
        const dx = x - ex;
        const dy = y - ey;
        const L = Math.max(Math.abs(dx), Math.abs(dy));
        for (let s = E.r + 4; s < L - 4; s += 3) {
          const qx = Math.round(ex + (dx * s) / L);
          const qy = Math.round(ey + (dy * s) / L);
          if (BAY8[((qy & 7) << 3) | (qx & 7)]! < u / 0.6) continue;
          ov.set(qx, qy, IR(4), Math.round(0.2 * EM));
        }
      }
    }
  }
}
