import { clamp, rgba, pb, pg, pr, type RenderLayer } from '@/contracts';
import { DMath } from '@/contracts/dmath';
import { hash01, type NexusGroups, type NexusRig } from '@/titans';
import { linkIndex, rasterLink, RIVET_OFFSET } from '@/titans/art/chainLink';
import { BodySkin, BodySpaceLayer, IdleClock, IdleRng, Pool, fcos, fsin, h2, ss } from '../fx/idle';

/**
 * THE NEXUS'S LIVING IDLE (idle handover: specs/nexus.md, prototype `nexus.src.html`, approved by WJ: "staccato clockwork,
 * always deciding"). The graph never flows: gems tick between whole-pixel positions (a 1 px pull-back, an overshoot, a
 * settle), the chains between them are forged anew every frame from the rig's polylines (slack when the gems close in,
 * taut when they part, rattling when a gem moves), thoughts run along the chains as heat, the heart's facets light in turn,
 * and every 7–11 s the graph decides: it clenches, fires every spoke, snaps its rim out and resets gem by gem. It leans
 * toward the prey ring by ring, veins of assimilation creep through the gems and buds of crystal push out and crumble.
 *
 * Presentation only (S19). The body is composited at render time into a `BodySkin` (the matter map is never written): the
 * live map is copied, the cells of every live gem and of every intact chain are cleared, then chains, sinew, gems and veins
 * are drawn where they are this step. Buds go into a `BodySpaceLayer` (they reach past the map). The state advances one
 * fixed step per sim tick with that tick's inputs (recorded by the behaviour), so it is the same at any frame rate and on
 * both netplay peers. Damage stays: a cell the fight changed is drawn as the matter module shows it, a chain that is not
 * intact keeps its painted cells and holds both of its gems at home, a dark gem never moves or lights.
 */

/** What the fight tells the idle each tick. */
export interface NexusIdleInput {
  /** 1 at rest (idle / moving / intro, no move); 0 during moves, hitstun, guard. */
  rest: number;
  ko: boolean;
  /** Harvest running: thoughts run ~2.7× as often and as fast. */
  harvest: boolean;
  /** Real growth happened recently (no cosmetic buds then). */
  growing: boolean;
  /** The prey side in map space (±1: the body is mirrored by the renderer, so normally +1). */
  d: number;
  /** Per node: lit and not dark (1), else 0. */
  live: Uint8Array;
  /** Per chain: intact enough to be forged anew (1), else 0 (its painted cells stay). */
  edges: Uint8Array;
}

/** The live matter the idle reads (the fighter's `body.map`). */
export interface NexusIdleMap {
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
const RING = 16;
const TAU = Math.PI * 2;
const VEIN_MAX = 24;
const VEIN_PATHS = 3;
/** A core's glow at rest (the prototype's 0.08 of full), in emissive bytes. */
const CORE_GLOW = 40;

interface Signal {
  e: number;
  from: number;
  t0: number;
  speed: number;
  hops: number;
  big: boolean;
}
interface Vein {
  n: number;
  t0: number;
  life: number;
  paths: number;
  len: Int8Array;
  px: Int8Array;
  py: Int8Array;
}
interface Bud {
  t0: number;
  b: number;
  life: number;
  id: number;
}

export class NexusIdle {
  readonly skin: BodySkin;
  /** Buds of crystal (they reach past the map): in the titan band, outlined like the body. */
  readonly buds: BodySpaceLayer;

  private readonly W: number;
  private readonly H: number;
  private readonly rig: NexusRig;
  private readonly nN: number;
  private readonly nE: number;
  private readonly origBase: Uint32Array;
  private readonly seedA: number;

  /* palette ladders (the painted colours of a material, sorted by luminance: a higher index is hotter) */
  private readonly LN: Uint32Array;
  private readonly LC: Uint32Array;
  private readonly CH: Uint32Array;
  private readonly NCH: number;
  /** Per cell: 1 = on the gem ladder LN, 2 = on the heart ladder LC, 0 = neither; and its index there. */
  private readonly ladKind: Uint8Array;
  private readonly ladIdx: Int8Array;

  /* parts */
  private readonly nodeBody: Int32Array[];
  private readonly nodeSinew: Int32Array[];
  private readonly sinewTas: Int16Array;
  private readonly sinewS: Float32Array;
  private readonly tasNx: Float32Array;
  private readonly tasNy: Float32Array;
  /** Per cell: the heart's facet sector (0..7, 255 = not the heart), radius from the hub; a gem cell's upper-left facet light. */
  private readonly heartSec: Uint8Array;
  private readonly hubR: Float32Array;
  private readonly upF: Float32Array;
  private readonly isCore: Uint8Array;

  /* chains */
  private readonly eT: Float32Array[];
  private readonly eP: Float32Array[];
  private readonly eLinks: Int32Array;
  private readonly eD0: Float32Array;
  private readonly eSide: Int8Array;
  private readonly eNx: Float32Array;
  private readonly eNy: Float32Array;
  private readonly rattle: Float32Array;
  /** The painted rivet colour, and per chain the rig length over its polyline's arc (link spacing at rest = the painter's). */
  private rivet = 0;
  private readonly eArcScale: Float32Array;
  /** Per chain, each link's centre at rest (x, y), and per cell whether it is painted chain. */
  private readonly eRest: Float32Array[] = [];
  private readonly chainAt: Uint8Array;
  /** Each chain's painted cells (cleared when it is forged anew). */
  private readonly edgeCells: Int32Array[];
  private readonly adj: number[][];
  private readonly rimOrder: number[];

  /* the clock and per-tick inputs */
  readonly clock = new IdleClock();
  private readonly rng: IdleRng;
  private readonly seed: number;
  private readonly ring: NexusIdleInput[];
  private readonly ringTick = new Int32Array(RING).fill(-1);
  private readonly lastIn: NexusIdleInput;

  /* gems */
  private readonly atX: Int32Array;
  private readonly atY: Int32Array;
  private readonly mOn: Uint8Array;
  private readonly mT0: Float64Array;
  private readonly mFX: Int32Array;
  private readonly mFY: Int32Array;
  private readonly mTX: Int32Array;
  private readonly mTY: Int32Array;
  private readonly mDX: Int8Array;
  private readonly mDY: Int8Array;
  private readonly mAnt: Float32Array;
  private readonly mSnap: Float32Array;
  private readonly mSettle: Float32Array;
  private readonly flash: Float32Array;
  private readonly posX: Int32Array;
  private readonly posY: Int32Array;
  private readonly prevX: Int32Array;
  private readonly velX: Float32Array;
  private readonly swA: Float32Array;
  private readonly swV: Float32Array;
  private readonly frozen: Uint8Array;

  /* the choreography */
  private readonly signals = new Pool<Signal>(64, () => ({
    e: 0,
    from: 0,
    t0: 0,
    speed: 0,
    hops: 0,
    big: false,
  }));
  private readonly veins = new Pool<Vein>(8, () => ({
    n: 0,
    t0: 0,
    life: 1,
    paths: 0,
    len: new Int8Array(VEIN_PATHS),
    px: new Int8Array(VEIN_PATHS * VEIN_MAX),
    py: new Int8Array(VEIN_PATHS * VEIN_MAX),
  }));
  private readonly budPool = new Pool<Bud>(4, () => ({ t0: 0, b: 0, life: 1, id: 0 }));
  private budIds = 0;
  private nextTick = 0.4;
  private nextSig = 0.8;
  private nextDecide = 5;
  private nextLean = 9;
  private nextVein = 1.5;
  private nextBud = 4;
  private decOn = false;
  private decT0 = 0;
  private decFired = false;
  private decSnapped = false;
  private decReset = false;
  private leanOn = false;
  private leanT0 = 0;
  private leanDir = 1;
  private readonly leanOff = new Int32Array(3);
  private leanTw = -1;
  private leanTwOff = 0;
  private wasRest = true;
  private heartStep = 0;
  private drawnAt = -1;

  /* the sinks' per-link state (rasterLink calls back per pixel; no closure per link) */
  private sTone = 0;
  private sHeat = 0;
  /** The forged link's displacement from where it sits at rest (whole pixels): its painted texture travels with it. */
  private sDx = 0;
  private sDy = 0;
  private readonly sinkChain = (px: number, py: number, light: number): void => {
    const W = this.W;
    if (px < 0 || py < 0 || px >= W || py >= this.H) return;
    const i = py * W + px;
    const heat = this.sHeat;
    if (heat <= 0.08) {
      // the painted colour of the cell this pixel sits on at rest (exact at rest), else the forged shade
      const sx = px - this.sDx;
      const sy = py - this.sDy;
      if (sx >= 0 && sy >= 0 && sx < W && sy < this.H && this.chainAt[sy * W + sx]) {
        this.skin.px[i] = this.origBase[sy * W + sx]!;
        this.skin.emis[i] = 0;
        return;
      }
    }
    let k = linkIndex(light, this.sTone, this.NCH);
    if (heat > 0.08) k = clamp(k + Math.round(heat * 4), 0, this.CH.length - 2);
    this.skin.px[i] = this.CH[k]!;
    this.skin.emis[i] = heat > 0.5 ? Math.min(255, 140 * heat) : 0;
  };
  private readonly sinkBud = (px: number, py: number, light: number): void => {
    this.buds.putPal(px, py, this.CH, linkIndex(light, 0, this.NCH));
  };

  constructor(
    map: { w: number; h: number; material: Uint8Array },
    rig: NexusRig,
    groups: NexusGroups,
    origBase: Uint32Array,
    paintSeed: number,
    seed: number,
    slot: number,
  ) {
    const W = (this.W = map.w);
    const H = (this.H = map.h);
    const N = W * H;
    this.rig = rig;
    this.nN = rig.nodes.length;
    this.nE = rig.edges.length;
    this.origBase = origBase;
    this.seedA = (paintSeed & 0xfff) + 733;
    this.seed = seed;
    this.rng = new IdleRng(seed);
    this.skin = new BodySkin(W, H);
    this.buds = new BodySpaceLayer(`nexus-buds-${slot}`, 0.5, W + 64, H + 64, rig.hub.x, rig.hub.y);
    const ids = rig.ids;
    const mat = map.material;
    const nN = this.nN;
    const nE = this.nE;

    // ---- palette ladders from the painted colours (sorted by luminance; "hotter" = a higher index) ----
    const lum = (c: number): number => 0.3 * pr(c) + 0.59 * pg(c) + 0.11 * pb(c);
    const uniq = (m: number): number[] => {
      const s = new Set<number>();
      for (let i = 0; i < N; i++) if (mat[i] === m) s.add((origBase[i]! | 0xff000000) >>> 0);
      return [...s].sort((a, b) => lum(a) - lum(b));
    };
    const chainCols = uniq(ids.chain);
    const nodeCols = uniq(ids.node);
    const coreCols = uniq(ids.nodecore);
    const crysCols = uniq(ids.crystal);
    const hubCols = uniq(ids.hubcore);
    // the prototype's white-hot top is off the palette: the heart's own brightest colour takes its place (spec §6)
    const white = hubCols.length ? hubCols[hubCols.length - 1]! : rgba(255, 242, 246);
    this.LN = Uint32Array.from([...nodeCols, ...coreCols.slice(-3), white]);
    this.LC = Uint32Array.from([...crysCols, ...hubCols.slice(-2), white]);
    const pick = (a: number[], k: number): number => a[Math.max(0, Math.min(a.length - 1, k))] ?? white;
    this.CH = Uint32Array.from([
      ...chainCols,
      pick(nodeCols, Math.floor(nodeCols.length * 0.6)),
      pick(nodeCols, nodeCols.length - 1),
      ...coreCols.slice(-2),
      white,
    ]);
    this.NCH = chainCols.length;
    this.ladKind = new Uint8Array(N);
    this.ladIdx = new Int8Array(N).fill(-1);
    const idxN = new Map<number, number>();
    this.LN.forEach((c, k) => idxN.set(c, k));
    const idxC = new Map<number, number>();
    this.LC.forEach((c, k) => idxC.set(c, k));
    for (let i = 0; i < N; i++) {
      const m = mat[i]!;
      const c = (origBase[i]! | 0xff000000) >>> 0;
      if (m === ids.node || m === ids.nodecore) {
        const k = idxN.get(c);
        if (k !== undefined) {
          this.ladKind[i] = 1;
          this.ladIdx[i] = k;
        }
      } else if (m === ids.crystal || m === ids.hubcore) {
        const k = idxC.get(c);
        if (k !== undefined) {
          this.ladKind[i] = 2;
          this.ladIdx[i] = k;
        }
      }
    }

    // ---- parts: each gem's cells (bezel, socket chain, core, crystal) and its sinew ----
    const body: number[][] = Array.from({ length: nN }, () => []);
    const sinew: number[][] = Array.from({ length: nN }, () => []);
    for (let n = 0; n < nN; n++) {
      const cells = groups.nodeCells[n]!;
      for (let k = 0; k < cells.length; k++) {
        const i = cells[k]!;
        if (mat[i] === 0) continue;
        (mat[i] === ids.lattice ? sinew : body)[n]!.push(i);
      }
    }
    this.nodeBody = body.map((a) => Int32Array.from(a));
    this.nodeSinew = sinew.map((a) => Int32Array.from(a));
    // sinew: which filament a cell hangs on and how far along it
    this.sinewTas = new Int16Array(N).fill(-1);
    this.sinewS = new Float32Array(N);
    const best = new Float32Array(N).fill(1e9);
    const nT = rig.tassels.length;
    this.tasNx = new Float32Array(nT);
    this.tasNy = new Float32Array(nT);
    rig.tassels.forEach((T, ti) => {
      const P = T.pts;
      const np = P.length / 2;
      const a = DMath.atan2(P[P.length - 1]! - P[1]!, P[P.length - 2]! - P[0]!);
      this.tasNx[ti] = -DMath.sin(a);
      this.tasNy[ti] = DMath.cos(a);
      const cells = this.nodeSinew[T.from] ?? new Int32Array(0);
      for (let k = 0; k < cells.length; k++) {
        const i = cells[k]!;
        const x = i % W;
        const y = (i - x) / W;
        let bd = 1e9;
        let bs = 0;
        for (let s = 0; s < np; s++) {
          const d = DMath.hypot(x + 0.5 - P[s * 2]!, y + 0.5 - P[s * 2 + 1]!);
          if (d < bd) {
            bd = d;
            bs = s / Math.max(1, np - 1);
          }
        }
        if (bd < 3 && (this.sinewTas[i]! < 0 || bd < best[i]!)) {
          this.sinewTas[i] = ti;
          this.sinewS[i] = bs;
          best[i] = bd;
        }
      }
    });
    // the heart's facets, a gem's upper-left facet light, the cores
    this.heartSec = new Uint8Array(N).fill(255);
    this.hubR = new Float32Array(N);
    this.upF = new Float32Array(N);
    this.isCore = new Uint8Array(N);
    const hub = rig.nodes[0]!;
    for (let n = 0; n < nN; n++) {
      const Nd = rig.nodes[n]!;
      const cells = this.nodeBody[n]!;
      for (let k = 0; k < cells.length; k++) {
        const i = cells[k]!;
        const x = i % W;
        const y = (i - x) / W;
        const m = mat[i]!;
        if (m === ids.nodecore || m === ids.hubcore) this.isCore[i] = 1;
        if (n === 0 && (m === ids.crystal || m === ids.hubcore)) {
          const a = DMath.atan2(y + 0.5 - hub.y, x + 0.5 - hub.x);
          this.heartSec[i] = ((Math.floor((a / TAU) * 8 + 8.5) % 8) + 8) % 8;
          this.hubR[i] = DMath.hypot(x + 0.5 - hub.x, y + 0.5 - hub.y);
        }
        this.upF[i] = (x + 0.5 - Nd.x) * -0.55 + (y + 0.5 - Nd.y) * -0.7;
      }
    }

    // ---- chains: the rig's polylines, their arc parameter, link count, rest length, bow side ----
    this.eT = [];
    this.eP = [];
    this.eLinks = new Int32Array(nE);
    this.eD0 = new Float32Array(nE);
    this.eSide = new Int8Array(nE);
    this.eNx = new Float32Array(nE);
    this.eNy = new Float32Array(nE);
    this.rattle = new Float32Array(nE);
    this.eArcScale = new Float32Array(nE).fill(1);
    this.edgeCells = groups.edgeCells;
    this.adj = Array.from({ length: nN }, () => []);
    rig.edges.forEach((e, k) => {
      const pts = e.pts;
      const n = pts.length / 2;
      const t = new Float32Array(n);
      let acc = 0;
      for (let s = 1; s < n; s++) {
        acc += DMath.hypot(pts[s * 2]! - pts[s * 2 - 2]!, pts[s * 2 + 1]! - pts[s * 2 - 1]!);
        t[s] = acc;
      }
      for (let s = 0; s < n; s++) t[s] = t[s]! / (acc || 1);
      this.eT.push(t);
      this.eP.push(new Float32Array(n * 2));
      const A = rig.nodes[e.a]!;
      const B = rig.nodes[e.b]!;
      this.eLinks[k] = Math.max(2, Math.round(e.len / 7));
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const dl = DMath.hypot(dx, dy) || 1;
      this.eD0[k] = dl;
      this.eNx[k] = -dy / dl;
      this.eNy[k] = dx / dl;
      this.eSide[k] = k % 2 === 0 ? 1 : -1;
      this.adj[e.a]!.push(k);
      this.adj[e.b]!.push(k);
    });
    this.chainAt = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (mat[i] === ids.chain) this.chainAt[i] = 1;
    this.calibrateChains(mat, origBase, ids.chain);
    this.rimOrder = [];
    for (let n = 0; n < nN; n++) if (rig.nodes[n]!.ring === 2) this.rimOrder.push(n);
    const ang = (n: number): number => DMath.atan2(rig.nodes[n]!.y - hub.y, rig.nodes[n]!.x - hub.x);
    this.rimOrder.sort((a, b) => ang(a) - ang(b));

    // ---- per-gem state, per-tick inputs ----
    const mk = (): NexusIdleInput => ({
      rest: 1,
      ko: false,
      harvest: false,
      growing: false,
      d: 1,
      live: new Uint8Array(nN).fill(1),
      edges: new Uint8Array(nE).fill(1),
    });
    this.ring = Array.from({ length: RING }, mk);
    this.lastIn = mk();
    this.atX = new Int32Array(nN);
    this.atY = new Int32Array(nN);
    this.mOn = new Uint8Array(nN);
    this.mT0 = new Float64Array(nN);
    this.mFX = new Int32Array(nN);
    this.mFY = new Int32Array(nN);
    this.mTX = new Int32Array(nN);
    this.mTY = new Int32Array(nN);
    this.mDX = new Int8Array(nN);
    this.mDY = new Int8Array(nN);
    this.mAnt = new Float32Array(nN);
    this.mSnap = new Float32Array(nN);
    this.mSettle = new Float32Array(nN);
    this.flash = new Float32Array(nN);
    this.posX = new Int32Array(nN);
    this.posY = new Int32Array(nN);
    this.prevX = new Int32Array(nN);
    this.velX = new Float32Array(nN);
    this.swA = new Float32Array(nN);
    this.swV = new Float32Array(nN);
    this.frozen = new Uint8Array(nN);
  }

  /**
   * Learn the painted chain colours: forge every chain once at rest (the painter's own positions and tone hash) and, for each
   * link shade index, take the colour the painted body has under it most often (and the rivets' colour). A chain forged at
   * rest is then the painted one, so the idle never pops when a gem leaves home or comes back; the hot steps above the
   * forged range stay the prototype's.
   */
  private calibrateChains(mat: Uint8Array, base: Uint32Array, chainId: number): void {
    const W = this.W;
    const H = this.H;
    const n = this.NCH;
    const votes: Map<number, number>[] = Array.from({ length: n }, () => new Map());
    const rivet = new Map<number, number>();
    const vote = (m: Map<number, number>, c: number): void => {
      m.set(c, (m.get(c) ?? 0) + 1);
    };
    let tone = 0;
    const sink = (px: number, py: number, light: number): void => {
      if (px < 0 || py < 0 || px >= W || py >= H) return;
      const i = py * W + px;
      if (mat[i] !== chainId) return;
      vote(votes[linkIndex(light, tone, n)]!, (base[i]! | 0xff000000) >>> 0);
    };
    const rivets: number[] = [];
    this.rig.edges.forEach((ed, e) => {
      const pts = ed.pts;
      const links = this.eLinks[e]!;
      const step = ed.len / links;
      const rest = new Float32Array(links * 2);
      this.eRest[e] = rest;
      let acc = 0;
      let next = step / 2;
      let link = 0;
      for (let s = 0; s + 3 < pts.length; s += 2) {
        const x0 = pts[s]!;
        const y0 = pts[s + 1]!;
        const sx = pts[s + 2]! - x0;
        const sy = pts[s + 3]! - y0;
        const seg = DMath.hypot(sx, sy);
        if (seg < 1e-6) continue;
        while (next <= acc + seg && link < links) {
          const f = (next - acc) / seg;
          const tx = sx / seg;
          const ty = sy / seg;
          tone = (link % 2 === 0 ? 0.25 : -0.25) + (hash01(e, link, this.seedA + 3) - 0.5) * 0.4;
          const lx = x0 + sx * f;
          const ly = y0 + sy * f;
          rest[link * 2] = lx;
          rest[link * 2 + 1] = ly;
          rasterLink(lx, ly, tx, ty, link % 2 === 0, sink);
          if (link % 2 === 0)
            for (let sg = -1; sg <= 1; sg += 2) {
              rivets.push(Math.round(lx + tx * sg * RIVET_OFFSET), Math.round(ly + ty * sg * RIVET_OFFSET));
            }
          link++;
          next += step;
        }
        acc += seg;
      }
    });
    for (let k = 0; k + 1 < rivets.length; k += 2) {
      const x = rivets[k]!;
      const y = rivets[k + 1]!;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      if (mat[i] === chainId) vote(rivet, (base[i]! | 0xff000000) >>> 0);
    }
    const top = (m: Map<number, number>): number => {
      let bc = -1;
      let bn = 0;
      for (const [c, v] of m)
        if (v > bn) {
          bn = v;
          bc = c;
        }
      return bc;
    };
    for (let k = 0; k < n; k++) {
      const c = top(votes[k]!);
      if (c >= 0) this.CH[k] = c;
    }
    const rc = top(rivet);
    this.rivet = rc >= 0 ? rc : this.CH[n - 1]!;
    // the painter spaces links by the rig's length; forging spaces them along the current arc, scaled to match at rest
    this.rig.edges.forEach((ed, e) => {
      const P = ed.pts;
      let arc = 0;
      for (let s = 2; s < P.length; s += 2) arc += DMath.hypot(P[s]! - P[s - 2]!, P[s + 1]! - P[s - 1]!);
      this.eArcScale[e] = arc > 0 ? ed.len / arc : 1;
    });
  }

  /** A new round: the idle starts over. */
  reset(): void {
    this.clock.reset();
    this.rng.reseed(this.seed);
    this.ringTick.fill(-1);
    this.atX.fill(0);
    this.atY.fill(0);
    this.mOn.fill(0);
    this.flash.fill(0);
    this.posX.fill(0);
    this.posY.fill(0);
    this.prevX.fill(0);
    this.velX.fill(0);
    this.swA.fill(0);
    this.swV.fill(0);
    this.rattle.fill(0);
    this.signals.clear();
    this.veins.clear();
    this.budPool.clear();
    this.nextTick = 0.4;
    this.nextSig = 0.8;
    this.nextDecide = 5;
    this.nextLean = 9;
    this.nextVein = 1.5;
    this.nextBud = 4;
    this.decOn = false;
    this.leanOn = false;
    this.leanOff.fill(0);
    this.leanTw = -1;
    this.leanTwOff = 0;
    this.wasRest = true;
    this.heartStep = 0;
    this.drawnAt = -1;
    this.buds.clear();
  }

  /** The fight's state this sim tick (called from the behaviour's `update`; render-side data the sim never reads). */
  record(tick: number, inp: NexusIdleInput): void {
    if (this.clock.last < 0) this.clock.last = tick - 1;
    const k = tick & (RING - 1);
    copyInput(this.ring[k]!, inp);
    this.ringTick[k] = tick;
    copyInput(this.lastIn, inp);
  }

  private inputAt(tick: number): NexusIdleInput {
    const k = tick & (RING - 1);
    return this.ringTick[k] === tick ? this.ring[k]! : this.lastIn;
  }

  /** Catch up with the sim tick (fixed 1/60 s steps, each with its own tick's input). */
  advance(tick: number): boolean {
    const n = this.clock.due(tick);
    for (let i = 0; i < n; i++) this.step(this.inputAt(tick - n + 1 + i));
    return n > 0;
  }

  private rnd(): number {
    return this.rng.next();
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  gem motion: staccato keyframes in whole pixels
   * ---------------------------------------------------------------------------------------------- */

  private tickTo(n: number, t: number, tx: number, ty: number, ant = 0.07, snap = 0.05, settle = 0.12): void {
    const fx = this.atX[n]!;
    const fy = this.atY[n]!;
    if (fx === tx && fy === ty) return;
    this.mOn[n] = 1;
    this.mT0[n] = t;
    this.mFX[n] = fx;
    this.mFY[n] = fy;
    this.mTX[n] = tx;
    this.mTY[n] = ty;
    this.mDX[n] = Math.sign(tx - fx);
    this.mDY[n] = Math.sign(ty - fy);
    this.mAnt[n] = ant;
    this.mSnap[n] = snap;
    this.mSettle[n] = settle;
    for (const e of this.adj[n]!) this.rattle[e] = Math.min(1.6, this.rattle[e]! + 1.1);
  }

  /** Where gem n is at time t (sets `pX`/`pY`); commits a finished move. */
  private pX = 0;
  private pY = 0;
  private nodePos(n: number, t: number): void {
    if (!this.mOn[n]) {
      this.pX = this.atX[n]!;
      this.pY = this.atY[n]!;
      return;
    }
    const u = t - this.mT0[n]!;
    const ant = this.mAnt[n]!;
    const snap = this.mSnap[n]!;
    if (u < 0) {
      this.pX = this.mFX[n]!;
      this.pY = this.mFY[n]!;
    } else if (u < ant) {
      // the pull back
      this.pX = this.mFX[n]! - this.mDX[n]!;
      this.pY = this.mFY[n]! - this.mDY[n]!;
    } else if (u < ant + snap) {
      // the snap, overshooting
      this.pX = this.mTX[n]! + this.mDX[n]!;
      this.pY = this.mTY[n]! + this.mDY[n]!;
    } else if (u < ant + snap + this.mSettle[n]!) {
      this.pX = this.mTX[n]!;
      this.pY = this.mTY[n]!;
    } else {
      this.atX[n] = this.mTX[n]!;
      this.atY[n] = this.mTY[n]!;
      this.mOn[n] = 0;
      this.pX = this.atX[n]!;
      this.pY = this.atY[n]!;
    }
  }

  /** Stop where it stands (the prototype's `at = nodePos(); move = null`). */
  private halt(n: number, t: number): void {
    this.nodePos(n, t);
    this.atX[n] = this.pX;
    this.atY[n] = this.pY;
    this.mOn[n] = 0;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  thoughts, the decision, the lean, veins, buds
   * ---------------------------------------------------------------------------------------------- */

  private fire(n: number, t: number, hops: number, skip: number, big: boolean, inp: NexusIdleInput): void {
    const fast = inp.harvest ? 2.7 : 1;
    for (const e of this.adj[n]!) {
      if (e === skip || !inp.edges[e]) continue;
      if (!big && this.rnd() > 0.5 / (1 + hops * 0.35)) continue;
      const s = this.signals.alloc();
      if (!s) return;
      s.e = e;
      s.from = n;
      s.t0 = t;
      s.speed = (big ? 120 : 70 + this.rnd() * 30) * fast;
      s.hops = hops;
      s.big = big;
    }
  }

  private arrive(n: number, t: number, hops: number, via: number, big: boolean, inp: NexusIdleInput): void {
    if (!inp.live[n]) return;
    this.flash[n] = Math.max(this.flash[n]!, big ? 1 : 0.75);
    if (hops < (big ? 2 : 5) && (big ? n >= 1 && n <= 6 : this.rnd() < 0.7))
      this.fire(n, t, hops + 1, via, big && hops < 1, inp);
  }

  private decide(t: number, inp: NexusIdleInput): void {
    if (this.decOn && t - this.decT0 < 3.2) return;
    this.decOn = true;
    this.decT0 = t;
    this.decFired = false;
    this.decSnapped = false;
    this.decReset = false;
    // the clench: every gem pulls one pixel toward the heart
    const hub = this.rig.hub;
    for (let n = 1; n < this.nN; n++) {
      if (!inp.live[n] || this.frozen[n]) continue;
      const Nd = this.rig.nodes[n]!;
      const dx = Math.sign(Math.round(hub.x - Nd.x));
      const dy = Math.sign(Math.round(hub.y - Nd.y));
      this.halt(n, t);
      this.tickTo(n, t + (Nd.ring === 2 ? 0.06 : 0), dx, dy, 0, 0.04, 0.04);
    }
  }

  private vein(t: number, inp: NexusIdleInput): void {
    const n = Math.floor(this.rnd() * this.nN);
    if (!inp.live[n]) return;
    const V = this.veins.alloc();
    if (!V) return;
    const Nd = this.rig.nodes[n]!;
    const k = n === 0 ? 3 : 1 + Math.floor(this.rnd() * 2);
    V.n = n;
    V.t0 = t;
    V.paths = k;
    for (let j = 0; j < k; j++) {
      let a = this.rnd() * TAU;
      let x = 0;
      let y = 0;
      const len = Math.min(VEIN_MAX - 1, Math.floor(Nd.r * (0.7 + this.rnd() * 0.5)));
      V.px[j * VEIN_MAX] = 0;
      V.py[j * VEIN_MAX] = 0;
      for (let s = 0; s < len; s++) {
        a += (this.rnd() - 0.5) * 1.2;
        x += fcos(a);
        y += fsin(a);
        V.px[j * VEIN_MAX + s + 1] = Math.round(x);
        V.py[j * VEIN_MAX + s + 1] = Math.round(y);
      }
      V.len[j] = len + 1;
    }
    V.life = 1.8 + this.rnd() * 1.4;
  }

  private bud(t: number, inp: NexusIdleInput): void {
    const B = this.rig.buds;
    let live = 0;
    for (let i = 0; i < B.length; i++) if (inp.live[B[i]!.from]) live++;
    if (!live) return;
    let pickN = Math.floor(this.rnd() * live);
    let b = -1;
    for (let i = 0; i < B.length; i++)
      if (inp.live[B[i]!.from] && pickN-- === 0) {
        b = i;
        break;
      }
    const P = this.budPool.alloc();
    if (!P || b < 0) return;
    P.t0 = t;
    P.b = b;
    P.life = 2.4 + this.rnd() * 1.2;
    P.id = this.budIds++;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  one fixed step
   * ---------------------------------------------------------------------------------------------- */

  private step(inp: NexusIdleInput): void {
    const dt = IdleClock.DT;
    const C = this.clock;
    C.t += dt;
    const t = C.t;
    const nN = this.nN;
    const rest = inp.rest > 0 && !inp.ko;
    // a gem whose chain is not intact holds still (no gap opens), and so does a dark one
    for (let n = 0; n < nN; n++) {
      let fz = n === 0 || !inp.live[n] ? 1 : 0;
      if (!fz) for (const e of this.adj[n]!) if (!inp.edges[e]) fz = 1;
      this.frozen[n] = fz;
      if (fz && n !== 0 && (this.mOn[n] || this.atX[n] || this.atY[n])) {
        this.mOn[n] = 0;
        this.atX[n] = 0;
        this.atY[n] = 0;
      }
    }
    if (inp.ko) {
      // KO: everything home, all idle stops, the heart's facets hold their last step
      this.atX.fill(0);
      this.atY.fill(0);
      this.mOn.fill(0);
      this.decOn = false;
      this.leanOn = false;
      this.signals.clear();
      this.veins.clear();
      this.budPool.clear();
    } else if (!rest && this.wasRest) {
      // the first tick that is not calm: a clockwork snap to attention (home within 5 ticks), the schedulers stop
      for (let n = 1; n < nN; n++) {
        if (this.frozen[n]) continue;
        this.halt(n, t);
        this.tickTo(n, t, 0, 0, 0, 2 / 60, 3 / 60);
      }
      this.decOn = false;
      this.leanOn = false;
    }
    this.wasRest = rest;
    if (!inp.ko) this.heartStep = Math.floor(t / 0.13) % 8;

    // ---- the schedulers ----
    if (rest) {
      if (t > this.nextTick) {
        let cnt = 0;
        for (let n = 1; n < nN; n++) if (!this.mOn[n] && !this.frozen[n]) cnt++;
        if (cnt) {
          let k = Math.floor(this.rnd() * cnt);
          let n = 1;
          for (; n < nN; n++) if (!this.mOn[n] && !this.frozen[n] && k-- === 0) break;
          // a new place within 2 px of home; sometimes back home
          const tx = this.rnd() < 0.3 ? 0 : Math.round((this.rnd() - 0.5) * 4);
          const ty = this.rnd() < 0.3 ? 0 : Math.round((this.rnd() - 0.5) * 4);
          this.tickTo(n, t, tx, ty);
        }
        this.nextTick = t + 0.18 + this.rnd() * 0.42;
      }
      if (t > this.nextDecide) {
        this.decide(t, inp);
        this.nextDecide = t + 7 + this.rnd() * 4;
      }
      if (t > this.nextLean) {
        this.leanOn = true;
        this.leanT0 = t;
        this.leanDir = inp.d < 0 ? -1 : 1;
        this.nextLean = t + 8 + this.rnd() * 6;
      }
      if (t > this.nextVein) {
        this.vein(t, inp);
        this.nextVein = t + 0.5 + this.rnd() * 1.2;
      }
      if (t > this.nextBud) {
        // cosmetic buds never run while the Nexus really grows
        if (!inp.growing && !inp.harvest) this.bud(t, inp);
        this.nextBud = t + 3 + this.rnd() * 3;
      }
    }
    if (!inp.ko && t > this.nextSig) {
      // thoughts keep running in a fight (a harvest speeds them up)
      const n = Math.floor(this.rnd() * nN);
      if (inp.live[n]) {
        this.flash[n] = 0.6;
        this.fire(n, t, 0, -1, false, inp);
      }
      this.nextSig = t + (0.35 + this.rnd() * 0.7) / (inp.harvest ? 2.7 : 1);
    }

    // ---- the decision's choreography ----
    if (this.decOn) {
      const u = t - this.decT0;
      if (!this.decFired && u > 0.42) {
        this.decFired = true;
        this.flash[0] = 1.2;
        for (const e of this.adj[0]!) {
          if (!inp.edges[e]) continue;
          const s = this.signals.alloc();
          if (!s) break;
          s.e = e;
          s.from = 0;
          s.t0 = t;
          s.speed = 150;
          s.hops = 0;
          s.big = true;
        }
      }
      if (!this.decSnapped && u > 0.95) {
        this.decSnapped = true;
        const hub = this.rig.hub;
        for (let n = 1; n < nN; n++) {
          if (this.frozen[n]) continue;
          const Nd = this.rig.nodes[n]!;
          this.halt(n, t);
          if (Nd.ring === 2) {
            const a = DMath.atan2(Nd.y - hub.y, Nd.x - hub.x);
            this.tickTo(n, t, Math.round(fcos(a) * 3), Math.round(fsin(a) * 3), 0, 0.035, 0.06);
            this.flash[n] = 1;
          } else this.tickTo(n, t, 0, 0, 0, 0.035, 0.05);
        }
      }
      if (!this.decReset && u > 1.9) {
        this.decReset = true;
        // reset around the ring, gem by gem
        for (let k = 0; k < this.rimOrder.length; k++) {
          const n = this.rimOrder[k]!;
          if (this.frozen[n]) continue;
          this.halt(n, t);
          this.tickTo(n, t + k * 0.09, 0, 0);
        }
      }
      if (u > 3.2) this.decOn = false;
    }

    // ---- the hunting lean: heart, inner ring, outer ring ----
    this.leanOff.fill(0);
    this.leanTw = -1;
    this.leanTwOff = 0;
    if (this.leanOn) {
      const u = t - this.leanT0;
      const d = this.leanDir;
      const stepIn = (dl: number): number => (u > dl && u < 1.7 + dl * 0.6 ? 1 : 0);
      this.leanOff[0] = stepIn(0) * d;
      this.leanOff[1] = stepIn(0.08) * d * 2;
      this.leanOff[2] = stepIn(0.16) * d * 3;
      // the live gem nearest the prey twitches twice
      let best = -1e9;
      const hub = this.rig.hub;
      for (const n of this.rimOrder) {
        if (this.frozen[n]) continue;
        const s = (this.rig.nodes[n]!.x - hub.x) * d;
        if (s > best) {
          best = s;
          this.leanTw = n;
        }
      }
      if ((u > 0.3 && u < 0.36) || (u > 0.55 && u < 0.6)) this.leanTwOff = 2 * d;
      if (this.leanTw >= 0 && u > 0.3 && u < 0.3 + 1.5 / 60) this.flash[this.leanTw] = 1;
      if (u > 2.3) this.leanOn = false;
    }

    // ---- where every gem is (integer offsets from home) ----
    for (let n = 0; n < nN; n++) {
      this.nodePos(n, t);
      let lx = 0;
      if (!this.frozen[n] || n === 0) {
        lx = this.leanOff[this.rig.nodes[n]!.ring] ?? 0;
        if (n === this.leanTw) lx += this.leanTwOff;
      }
      const x = this.pX + lx;
      this.posX[n] = x;
      this.posY[n] = this.pY;
      this.velX[n] = (x - this.prevX[n]!) / dt;
      this.prevX[n] = x;
      this.flash[n] = Math.max(0, this.flash[n]! - dt * 2.2);
      // the sinew's pendulum, kicked by the gem's own pixel velocity
      this.swV[n] += (-this.velX[n]! * 0.004 - this.swA[n]! * 14) * dt - this.swV[n]! * 2.6 * dt;
      this.swA[n] += this.swV[n]! * dt;
    }
    for (let e = 0; e < this.nE; e++) this.rattle[e] = Math.max(0, this.rattle[e]! - dt * 4);

    // ---- thoughts: advance, arrive; veins and buds age out ----
    const S = this.signals;
    for (let i = S.n - 1; i >= 0; i--) {
      const s = S.items[i]!;
      if (!inp.edges[s.e]) {
        S.kill(i);
        continue;
      }
      const tr = ((t - s.t0) * s.speed) / this.rig.edges[s.e]!.len;
      if (tr >= 1) {
        const ed = this.rig.edges[s.e]!;
        const to = s.from === ed.a ? ed.b : ed.a;
        const hops = s.hops;
        const via = s.e;
        const big = s.big;
        S.kill(i);
        this.arrive(to, t, hops, via, big, inp);
      }
    }
    for (let i = this.veins.n - 1; i >= 0; i--) {
      const V = this.veins.items[i]!;
      if ((t - V.t0) / V.life > 1) this.veins.kill(i);
    }
    for (let i = this.budPool.n - 1; i >= 0; i--) {
      const B = this.budPool.items[i]!;
      if ((t - B.t0) / B.life > 1.2) this.budPool.kill(i);
    }
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  drawing: the composite body (once per advanced tick; presented every frame)
   * ---------------------------------------------------------------------------------------------- */

  render(body: RenderLayer, map: NexusIdleMap): void {
    if (this.drawnAt !== this.clock.last) {
      this.drawnAt = this.clock.last;
      const inp = this.inputAt(this.clock.last);
      this.drawBody(map, inp);
      this.buds.begin(body);
      this.drawBuds(inp);
      this.buds.end();
      this.skin.present(body, true);
    } else {
      this.buds.follow(body);
      this.skin.present(body, false);
    }
  }

  private changed(map: NexusIdleMap, i: number): boolean {
    return (
      map.integrity[i]! < 255 ||
      (map.flags[i]! & FIGHT_FLAGS) !== 0 ||
      map.infection[i]! !== 0 ||
      map.pixels[i] !== this.origBase[i]
    );
  }

  private drawBody(map: NexusIdleMap, inp: NexusIdleInput): void {
    const t = this.clock.t;
    const W = this.W;
    const H = this.H;
    const skin = this.skin;
    skin.copyFrom(map.pixels, map.emissive);
    const px = skin.px;
    const em = skin.emis;
    const mat = map.material;
    const nN = this.nN;
    const nE = this.nE;
    const groupsLive = inp.live;

    // ---- clear what is redrawn: every live gem (and its sinew), every chain forged anew ----
    for (let n = 0; n < nN; n++) {
      if (!groupsLive[n]) continue;
      const a = this.nodeBody[n]!;
      for (let k = 0; k < a.length; k++) {
        px[a[k]!] = 0;
        em[a[k]!] = 0;
      }
      const s = this.nodeSinew[n]!;
      for (let k = 0; k < s.length; k++) {
        px[s[k]!] = 0;
        em[s[k]!] = 0;
      }
    }
    for (let e = 0; e < nE; e++) {
      if (!inp.edges[e]) continue;
      const cells = this.edgeCells[e]!;
      for (let k = 0; k < cells.length; k++) {
        const i = cells[k]!;
        if (mat[i] === 0) continue;
        px[i] = 0;
        em[i] = 0;
      }
    }

    // ---- chains, forged anew between where the gems are now ----
    const rig = this.rig;
    for (let e = 0; e < nE; e++) {
      if (!inp.edges[e]) continue;
      const ed = rig.edges[e]!;
      const A = rig.nodes[ed.a]!;
      const B = rig.nodes[ed.b]!;
      const oax = this.posX[ed.a]!;
      const oay = this.posY[ed.a]!;
      const obx = this.posX[ed.b]!;
      const oby = this.posY[ed.b]!;
      const ddx = B.x + obx - A.x - oax;
      const ddy = B.y + oby - A.y - oay;
      const d1 = Math.sqrt(ddx * ddx + ddy * ddy);
      // closer gems: the chain sags; further: it pulls straight
      const slack = (this.eD0[e]! - d1) * 0.55;
      const pts = ed.pts;
      const tt = this.eT[e]!;
      const P = this.eP[e]!;
      const n = pts.length / 2;
      const side = this.eSide[e]!;
      const nx = this.eNx[e]!;
      const ny = this.eNy[e]!;
      for (let s = 0; s < n; s++) {
        const u = tt[s]!;
        const bow = fsin(Math.PI * u) * slack * side;
        P[s * 2] = pts[s * 2]! + oax + (obx - oax) * u + nx * bow;
        P[s * 2 + 1] = pts[s * 2 + 1]! + oay + (oby - oay) * u + ny * bow;
      }
      let tot = 0;
      for (let s = 1; s < n; s++) {
        const ex = P[s * 2]! - P[s * 2 - 2]!;
        const ey = P[s * 2 + 1]! - P[s * 2 - 1]!;
        tot += Math.sqrt(ex * ex + ey * ey);
      }
      const links = this.eLinks[e]!;
      const step = (tot * this.eArcScale[e]!) / links;
      const rat0 = this.rattle[e]!;
      let acc = 0;
      let next = step / 2;
      let link = 0;
      for (let s = 0; s + 1 < n && link < links; s++) {
        const x0 = P[s * 2]!;
        const y0 = P[s * 2 + 1]!;
        const x1 = P[s * 2 + 2]!;
        const y1 = P[s * 2 + 3]!;
        const sx = x1 - x0;
        const sy = y1 - y0;
        const seg = Math.sqrt(sx * sx + sy * sy);
        if (seg < 1e-6) continue;
        while (next <= acc + seg && link < links) {
          const f = (next - acc) / seg;
          const tx = sx / seg;
          const ty = sy / seg;
          // a rattle: links jump sideways by whole pixels and fall back
          const rat = rat0 > 0.05 ? Math.round(fsin(link * 2.3 + t * 47) * rat0) : 0;
          const lx = x0 + sx * f - ty * rat;
          const ly = y0 + sy * f + tx * rat;
          // the painter's tone hash, so a chain at rest is the painted one
          this.sTone = (link % 2 === 0 ? 0.25 : -0.25) + (hash01(e, link, this.seedA + 3) - 0.5) * 0.4;
          // heat from the thoughts running along this chain
          const fr = next / tot;
          let heat = 0;
          const S = this.signals;
          for (let i = 0; i < S.n; i++) {
            const sg = S.items[i]!;
            if (sg.e !== e) continue;
            const trv = ((t - sg.t0) * sg.speed) / ed.len;
            const fromA = sg.from === ed.a;
            const hf = fromA ? trv : 1 - trv;
            const back = fromA ? -1 : 1;
            const d = (fr - hf) * back;
            if (d > -0.06 && d < 0.35)
              heat = Math.max(heat, d < 0 ? 1 - -d / 0.06 : DMath.exp(-d * 7)) * (sg.big ? 1.3 : 1);
          }
          this.sHeat = heat;
          const rest = this.eRest[e]!;
          this.sDx = Math.round(lx - rest[link * 2]!);
          this.sDy = Math.round(ly - rest[link * 2 + 1]!);
          const ring = link % 2 === 0;
          rasterLink(lx, ly, tx, ty, ring, this.sinkChain);
          if (ring)
            for (let sg = -1; sg <= 1; sg += 2) {
              const rx = Math.round(lx + tx * sg * RIVET_OFFSET);
              const ry = Math.round(ly + ty * sg * RIVET_OFFSET);
              if (rx >= 0 && ry >= 0 && rx < W && ry < H) px[ry * W + rx] = this.rivet;
            }
          link++;
          next += step;
        }
        acc += seg;
      }
    }

    // ---- sinew (behind the gems), swinging with the gem it hangs from ----
    for (let n = 0; n < nN; n++) {
      if (!groupsLive[n]) continue;
      const cells = this.nodeSinew[n]!;
      if (!cells.length) continue;
      const idle = fsin(t * 1.3 + n) * 0.15;
      const sw = this.swA[n]! * 6 + idle;
      const ox0 = this.posX[n]!;
      const oy0 = this.posY[n]!;
      for (let k = 0; k < cells.length; k++) {
        const i = cells[k]!;
        if (mat[i] === 0) continue;
        const ti = this.sinewTas[i]!;
        let ox = 0;
        let oy = 0;
        if (ti >= 0) {
          const s = this.sinewS[i]!;
          const sway = sw * s * s * 3.2;
          ox = Math.round(this.tasNx[ti]! * sway);
          oy = Math.round(this.tasNy[ti]! * sway);
        }
        const x = (i % W) + ox0 + ox;
        const y = ((i / W) | 0) + oy0 + oy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const j = y * W + x;
        px[j] = map.pixels[i]!;
        em[j] = this.changed(map, i) ? map.emissive[i]! : 0;
      }
    }

    // ---- the gems and the heart ----
    const pupil = this.leanOn && this.leanOff[0] ? Math.sign(this.leanOff[0]) : 0;
    const hub = rig.nodes[0]!;
    for (let n = 0; n < nN; n++) {
      if (!groupsLive[n]) continue;
      const cells = this.nodeBody[n]!;
      const fl = this.flash[n]!;
      const flashK = Math.round(fl * 2.2);
      const ox0 = this.posX[n]!;
      const oy0 = this.posY[n]!;
      const Nd = rig.nodes[n]!;
      for (let k = 0; k < cells.length; k++) {
        const i = cells[k]!;
        if (mat[i] === 0) continue;
        const x = (i % W) + ox0;
        const y = ((i / W) | 0) + oy0;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const j = y * W + x;
        // the prototype's sparse glow: only the cores, faintly at rest (0.08) and flaring with a thought (+0.25 · flash);
        // a cell the fight changed keeps the matter module's own emissive (heat glow)
        em[j] = this.isCore[i]
          ? Math.min(255, CORE_GLOW + 160 * fl)
          : this.changed(map, i)
            ? map.emissive[i]!
            : 0;
        const kind = this.ladKind[i]!;
        if (!kind || this.changed(map, i)) {
          px[j] = map.pixels[i]!;
          continue;
        }
        let li = this.ladIdx[i]!;
        if (kind === 2) {
          // facets light in turn around the heart; a decision lights them all
          const sec = this.heartSec[i]!;
          if (sec !== 255) {
            if (sec === this.heartStep) li += 2;
            else if (sec === (this.heartStep + 7) % 8) li += 1;
            li += Math.min(2, flashK);
            // the pupil: a dark slit in the core that watches the prey
            if (
              this.leanOn &&
              this.hubR[i]! < 4.2 &&
              Math.abs((i % W) + 0.5 - hub.x - pupil * 1.5) < 0.6 &&
              Math.abs(((i / W) | 0) + 0.5 - hub.y) < 3.4
            ) {
              px[j] = this.LC[0]!;
              continue;
            }
          }
          px[j] = this.LC[li < 0 ? 0 : li >= this.LC.length ? this.LC.length - 1 : li]!;
          continue;
        }
        // a gem: the core flares, light catches the upper-left facets first
        if (mat[i] === rig.ids.nodecore) {
          if (flashK) li += flashK + 1;
        } else if (flashK) {
          const up = this.upF[i]!;
          if (up > -1) li += up > Nd.r * 0.3 ? flashK : flashK - 1;
        }
        px[j] = this.LN[li < 0 ? 0 : li >= this.LN.length ? this.LN.length - 1 : li]!;
      }
    }

    // ---- veins of assimilation: random walks across a gem, grown and withdrawn ----
    for (let vi = 0; vi < this.veins.n; vi++) {
      const V = this.veins.items[vi]!;
      if (!groupsLive[V.n]) continue;
      const u = (t - V.t0) / V.life;
      const grow = u < 0.4 ? u / 0.4 : u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3;
      const Nd = rig.nodes[V.n]!;
      for (let p = 0; p < V.paths; p++) {
        const m = Math.floor(V.len[p]! * grow);
        for (let s = 1; s < m; s++) {
          const x = Math.round(Nd.x + this.posX[V.n]! + V.px[p * VEIN_MAX + s]!);
          const y = Math.round(Nd.y + this.posY[V.n]! + V.py[p * VEIN_MAX + s]!);
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const j = y * W + x;
          const tip = s >= m - 2;
          px[j] = this.CH[tip ? this.CH.length - 2 : this.NCH + 1]!;
          if (tip) em[j] = 120;
        }
      }
    }
  }

  /* ---- buds: a new gem pushes out of the rim on a stub of chain, pulses, and crumbles ---- */
  private drawBuds(inp: NexusIdleInput): void {
    const t = this.clock.t;
    const L = this.buds;
    const LN = this.LN;
    for (let bi = 0; bi < this.budPool.n; bi++) {
      const Bd = this.budPool.items[bi]!;
      const B = this.rig.buds[Bd.b]!;
      if (!inp.live[B.from]) continue;
      const u = (t - Bd.t0) / Bd.life;
      const Nd = this.rig.nodes[B.from]!;
      const ox = this.posX[B.from]!;
      const oy = this.posY[B.from]!;
      const out = u < 0.35 ? u / 0.35 : 1;
      const sx = Nd.x + ox + B.nx * (Nd.r + 3);
      const sy = Nd.y + oy + B.ny * (Nd.r + 3);
      const ex = sx + B.nx * 9 * out;
      const ey = sy + B.ny * 9 * out;
      // the stub: one or two links
      const nl = out > 0.6 ? 2 : 1;
      if (u < 1)
        for (let l = 0; l < nl; l++) {
          const f = (l + 0.5) / 2;
          rasterLink(sx + (ex - sx) * f, sy + (ey - sy) * f, B.nx, B.ny, l % 2 === 0, this.sinkBud);
        }
      // the seed gem: a tiny faceted bead that grows, pulses with heat, then breaks into falling grains
      const R = 0.8 + 2.6 * ss(0.15, 0.6, u) + fsin(t * 9) * 0.3 * (u < 0.85 ? 1 : 0);
      const cx = ex + B.nx * R;
      const cy = ey + B.ny * R;
      if (u < 0.85) {
        for (let y = Math.floor(cy - R - 1); y <= cy + R + 1; y++)
          for (let x = Math.floor(cx - R - 1); x <= cx + R + 1; x++) {
            const ax = Math.abs(x + 0.5 - cx);
            const ay = Math.abs(y + 0.5 - cy);
            const d = Math.max(ax, ay) * 0.8 + Math.sqrt(ax * ax + ay * ay) * 0.35;
            if (d > R) continue;
            const lit = (x + 0.5 - cx) * -0.5 + (y + 0.5 - cy) * -0.6;
            const core = d < R * 0.35;
            const k = clamp(Math.round(LN.length * 0.45 + lit * 1.2 + (core ? 4 : 0)), 0, LN.length - 1);
            L.putPal(x, y, LN, k, core ? 160 : 0);
          }
      } else {
        const k = (u - 0.85) / 0.35;
        const mid = Math.floor(LN.length * 0.5);
        for (let g = 0; g < 10; g++) {
          const a = h2(g, Bd.id) * 6.28;
          L.putPal(Math.round(cx + fcos(a) * k * 6), Math.round(cy + fsin(a) * k * 6 + k * k * 10), LN, mid);
        }
      }
    }
  }
}

function copyInput(d: NexusIdleInput, s: NexusIdleInput): void {
  d.rest = s.rest;
  d.ko = s.ko;
  d.harvest = s.harvest;
  d.growing = s.growing;
  d.d = s.d;
  d.live.set(s.live);
  d.edges.set(s.edges);
}
