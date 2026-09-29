import {
  KO_CORE_INTEGRITY,
  REGION_GRID,
  Rng,
  leanShift,
  type BodyKind,
  type BodySpec,
  type BodyStats,
  type BodyTransform,
  type MatterBody,
  type MatterMap,
  type MaterialDef,
  type TitanAttributes,
} from '@/contracts';
import { K_CONE, K_LINE, type ShapeQ } from './shape';

export const TILE = 16;
export const TILE_SHIFT = 4;

/** Capacities of the connectivity change frontier (Body.connSeed) and of its removal events. */
export const CONN_SEED_CAP = 4096;
export const CONN_EVT_CAP = 8192;

/** Connectivity-check urgency (Body.connDirty): soft = burn erosion, steady = a process is still cutting, now = a direct hit. */
export const CONN_SOFT = 1;
export const CONN_STEADY = 2;
export const CONN_NOW = 3;

/** Tile activity bits (Body.tileAct). A tile is only simulated while it has one of these. */
export const ACT_HEAT = 1;
export const ACT_INFECT = 2;

const R2 = REGION_GRID * REGION_GRID;
const MAX_FRONTS = 160;
const MAX_FUSES = 96;

/** Snapshot of the pristine body (taken at creation) used by restore()/heal(). */
export interface Snapshot {
  material: Uint8Array;
  density: Uint8Array;
  bondR: Uint8Array;
  bondD: Uint8Array;
  height: Uint8Array;
  baseColor: Uint32Array;
  flags: Uint8Array;
  mass: number;
  cells: number;
}

/** Last blow that hit the body: chunks that detach shortly afterwards inherit this impulse. */
export interface BlowInfo {
  tick: number;
  dirX: number;
  dirY: number;
  energy: number;
  x: number;
  y: number;
  sourceMass: number;
  /** 0..1 how "explosive" the blow is (1 = crater ejecta style radial scatter, 0 = directional push). */
  radial: number;
}

export interface WorldPoint {
  x: number;
  y: number;
}

/**
 * Internal body state. Implements the public `MatterBody` (exact contract fields) and adds everything the simulation
 * needs: pristine snapshot, activity tiles, region statistics, crack fronts, shrapnel fuses, mass pool.
 */
export class Body implements MatterBody {
  readonly id: number;
  readonly kind: BodyKind;
  readonly ownerSlot: 0 | 1 | -1;
  readonly map: MatterMap;
  readonly materials: readonly MaterialDef[];
  readonly transform: BodyTransform;
  readonly attributes: TitanAttributes;
  cohesionScale = 1;
  heatScale = 1;

  readonly w: number;
  readonly h: number;
  readonly n: number;
  readonly seed: number;
  readonly rng: Rng;
  takesDebrisImpacts: boolean;

  /** Mass per cell at density 128, by material id. */
  readonly matDensity: Float32Array;
  /** Resistance multipliers flattened: index m*6 + damage-type index (DAMAGE_TYPES order). */
  readonly resistTab: Float32Array;
  /** Per-material half-conductivity (k = 0.25 * conductivity, so 4k <= 1: the explicit heat scheme is unconditionally stable). */
  readonly condTab: Float32Array;
  /** Scratch for tile lists. */
  readonly tileList: Int32Array;
  readonly tileNext: Uint8Array;
  /** 1 for materials with a low bond (<= 60): gas/plasma/liquid-like matter that a tidal field can strip from the inside. */
  readonly looseMat: Uint8Array;
  /** TIDAL cadence carry: energy from ticks skipped between applications, and the last tick one was applied. */
  tidalCarry = 0;
  lastTidalTick = -100;
  /** 1 for fluid materials (gas/plasma/liquid clouds: never anchor other cells). */
  readonly matFluid: Uint8Array;
  /** Material emissive levels (0..255) by id: lets the visual fast path skip the material object. */
  readonly matEmissive: Uint8Array;
  /** Materials that occur on the pristine outer surface (others count as "interior" when exposed). */
  readonly surfaceMat: Uint8Array;
  /** Interned particle ramp ids per material: index m*5 + {0 dust, 1 shard, 2 ember, 3 gas, 4 infect}. Filled at creation. */
  readonly rampIds: Int32Array;
  /** Count of interior-only materials exposed since the last read (drives DamageResult.revealedInterior). */
  revealCount = 0;

  /* ---- extra per-cell state ---- */
  /** Static low-frequency "vein" noise 19..115 (x/64 = 0.3..1.8): makes infection spread in branching veins rather than a disc. */
  readonly vein: Uint8Array;
  /** Scratch generation stamps for flood fills / searches. */
  readonly stamp: Uint32Array;
  stampGen = 1;
  /** Per-cell temperature scratch for double buffering / misc float scratch. */
  readonly aux: Float32Array;

  snap!: Snapshot;

  /* ---- tiles ---- */
  readonly tilesX: number;
  readonly tilesY: number;
  readonly tileVis: Uint8Array;
  readonly tileAct: Uint8Array;
  /** Set when any tile needs a visual refresh (fast skip). */
  visDirty = false;
  /** Whole body needs a visual refresh (facing flip, lighting change). */
  visAll = true;

  /* ---- region statistics ---- */
  readonly regionOfX: Uint8Array;
  readonly regionOfY: Uint8Array;
  readonly regionDirty: Uint8Array;
  readonly regionMass: Float64Array;
  readonly regionCells: Int32Array;
  readonly regionInteg: Float64Array;
  readonly regionBurn: Int32Array;
  readonly regionInfect: Int32Array;
  readonly regionCrack: Int32Array;
  readonly regionPristine: Int32Array;
  statsDirty = true;
  readonly stats: BodyStats;
  /** Core disc offsets (relative cell indices) built once. */
  coreDiscIdx: Int32Array = new Int32Array(0);
  /** 1 for cells of the core disc (the anchor of connectivity): losing one of them forces a full flood. */
  readonly coreMask: Uint8Array;
  corePristine = 1;
  /** Live bounding box in local cells (updated with stats). */
  liveX0 = 0;
  liveY0 = 0;
  liveX1 = 0;
  liveY1 = 0;

  /* ---- connectivity ---- */
  /** 0 = clean, else CONN_SOFT / CONN_STEADY / CONN_NOW: how soon the next connectivity pass should run. */
  connDirty = CONN_NOW;
  lastConnTick = -100;
  anchoredFrac = 1;
  /**
   * Frontier of the changes since the last connectivity pass: live cells next to a removed cell or a broken bond (deduplicated
   * through `seedMark`). Each removal is an EVENT; events that touch (a shared frontier cell, or 4-adjacent removed cells) are
   * unioned, so the frontier cells of one connected removed region share a cluster (connectivity.ts uses this to decide whether
   * anything was cut off).
   */
  readonly connSeed = new Int32Array(CONN_SEED_CAP);
  connSeedN = 0;
  readonly connEvtParent = new Int32Array(CONN_EVT_CAP);
  connEvtN = 0;
  readonly seedMark: Int32Array;
  /** Event that first put each frontier cell on the list (valid while seedMark[c] === seedGen). */
  readonly cellEvt: Int32Array;
  readonly killMark: Int32Array;
  readonly killEvt: Int32Array;
  seedGen = 1;
  /** Group labels for the local reconnection search (always all-zero between passes). */
  readonly connLabel: Int32Array;
  /** A full flood is required: first pass, matter was added, or the frontier overflowed. */
  connFull = true;
  /** Bodies with fluid materials need the directed (solid -> fluid only) flood: they always take the full pass. */
  readonly hasFluid: boolean;

  /* ---- mass economy ---- */
  /** Mass received from sinks that has not yet been built into cells (see grow()). Counts toward `map.mass`. */
  pool = 0;
  massGained = 0;
  massLost = 0;
  /** Cumulative ledger inputs for this body. */
  removedTotal = 0;

  /* ---- crack fronts (FRACTURE / CRUSH tectonics) ---- */
  readonly frontX = new Int16Array(MAX_FRONTS);
  readonly frontY = new Int16Array(MAX_FRONTS);
  readonly frontDir = new Int8Array(MAX_FRONTS);
  readonly frontStress = new Float32Array(MAX_FRONTS);
  readonly frontAcc = new Float32Array(MAX_FRONTS);
  readonly frontSpeed = new Float32Array(MAX_FRONTS);
  readonly frontLife = new Int16Array(MAX_FRONTS);
  readonly frontGen = new Int8Array(MAX_FRONTS);
  frontCount = 0;

  /* ---- slow cuts: FRACTURE seams whose bonds are severed progressively (a visible growing fissure) ---- */
  readonly slowEdges = new Int32Array(4096);
  slowN = 0;
  slowPos = 0;

  /* ---- shrapnel fuses (KINETIC EMBED) ---- */
  readonly fuseCell = new Int32Array(MAX_FUSES);
  readonly fuseTimer = new Int16Array(MAX_FUSES);
  readonly fuseEnergy = new Float32Array(MAX_FUSES);
  readonly fuseDirX = new Float32Array(MAX_FUSES);
  readonly fuseDirY = new Float32Array(MAX_FUSES);
  fuseCount = 0;

  /* ---- assimilation harvest config (last ASSIMILATION event that hit this body) ---- */
  harvestFrom = -1;
  harvestX = 0;
  harvestY = 0;
  harvest = 0;
  harvestUntil = -1;
  /** Infection activity counter: number of infected cells above the spread threshold (tile activity aids it). */
  infectActive = 0;

  /* ---- misc ---- */
  readonly blow: BlowInfo = {
    tick: -1000,
    dirX: 0,
    dirY: 0,
    energy: 0,
    x: 0,
    y: 0,
    sourceMass: 1,
    radial: 0.5,
  };
  private readonly rr = { a: 0, b: 0 };
  private readonly cr = { a: 0, b: 0 };
  /** World AABB of the full map rectangle and estimated velocity (px/s) from transform deltas; refreshed each tick. */
  aabbX0 = 0;
  aabbY0 = 0;
  aabbX1 = 0;
  aabbY1 = 0;
  vx = 0;
  vy = 0;
  lastX = NaN;
  lastY = NaN;
  /** Facing the visuals were last lit for (informational). */
  litFacing = 1;
  /** Tick counter of this body's last visual refresh. */
  hotTiles = 0;

  constructor(id: number, spec: BodySpec) {
    this.id = id;
    this.kind = spec.kind;
    this.ownerSlot = spec.ownerSlot;
    this.map = spec.map;
    this.materials = spec.materials;
    this.transform = spec.transform;
    this.attributes = spec.attributes;
    this.seed = spec.seed >>> 0;
    this.rng = new Rng(this.seed ^ 0x5bd1e995);
    this.w = spec.map.w;
    this.h = spec.map.h;
    this.n = this.w * this.h;
    this.takesDebrisImpacts = spec.takesDebrisImpacts ?? spec.kind === 'titan';

    this.matDensity = new Float32Array(256);
    for (let i = 0; i < spec.materials.length; i++) this.matDensity[i] = spec.materials[i]!.density;
    this.resistTab = new Float32Array(256 * 6);
    for (let i = 0; i < spec.materials.length; i++) {
      const r = spec.materials[i]!.resist;
      this.resistTab[i * 6] = r.FRACTURE;
      this.resistTab[i * 6 + 1] = r.ASSIMILATION;
      this.resistTab[i * 6 + 2] = r.TIDAL;
      this.resistTab[i * 6 + 3] = r.THERMAL;
      this.resistTab[i * 6 + 4] = r.CRUSH;
      this.resistTab[i * 6 + 5] = r.KINETIC;
    }
    this.condTab = new Float32Array(256);
    for (let i = 0; i < spec.materials.length; i++)
      this.condTab[i] = 0.25 * Math.max(0, Math.min(1, spec.materials[i]!.conductivity));
    this.looseMat = new Uint8Array(256);
    for (let i = 1; i < spec.materials.length; i++) this.looseMat[i] = spec.materials[i]!.bond <= 60 ? 1 : 0;
    this.matEmissive = new Uint8Array(256);
    for (let i = 0; i < spec.materials.length; i++) this.matEmissive[i] = spec.materials[i]!.emissive;
    this.matFluid = new Uint8Array(256);
    for (let i = 0; i < spec.materials.length; i++) this.matFluid[i] = spec.materials[i]!.fluid ? 1 : 0;
    this.surfaceMat = new Uint8Array(256);
    this.rampIds = new Int32Array(256 * 5).fill(0);

    this.vein = new Uint8Array(this.n);
    this.stamp = new Uint32Array(this.n);
    this.aux = new Float32Array(this.n);
    this.coreMask = new Uint8Array(this.n);
    this.seedMark = new Int32Array(this.n);
    this.cellEvt = new Int32Array(this.n);
    this.killMark = new Int32Array(this.n);
    this.killEvt = new Int32Array(this.n);
    this.connLabel = new Int32Array(this.n);
    let fluidAny = false;
    for (let i = 1; i < spec.materials.length; i++) if (spec.materials[i]!.fluid) fluidAny = true;
    this.hasFluid = fluidAny;

    this.tilesX = (this.w + TILE - 1) >> TILE_SHIFT;
    this.tilesY = (this.h + TILE - 1) >> TILE_SHIFT;
    this.tileVis = new Uint8Array(this.tilesX * this.tilesY);
    this.tileAct = new Uint8Array(this.tilesX * this.tilesY);
    this.tileList = new Int32Array(this.tilesX * this.tilesY);
    this.tileNext = new Uint8Array(this.tilesX * this.tilesY);

    this.regionOfX = new Uint8Array(this.w);
    this.regionOfY = new Uint8Array(this.h);
    for (let x = 0; x < this.w; x++)
      this.regionOfX[x] = Math.min(REGION_GRID - 1, Math.floor((x * REGION_GRID) / this.w));
    for (let y = 0; y < this.h; y++)
      this.regionOfY[y] = Math.min(REGION_GRID - 1, Math.floor((y * REGION_GRID) / this.h));
    this.regionDirty = new Uint8Array(R2).fill(1);
    this.regionMass = new Float64Array(R2);
    this.regionCells = new Int32Array(R2);
    this.regionInteg = new Float64Array(R2);
    this.regionBurn = new Int32Array(R2);
    this.regionInfect = new Int32Array(R2);
    this.regionCrack = new Int32Array(R2);
    this.regionPristine = new Int32Array(R2);

    this.stats = {
      mass: 0,
      initialMass: 0,
      massFrac: 1,
      cells: 0,
      initialCells: 0,
      coreIntegrity: 1,
      anchoredFrac: 1,
      exposedCoreFrac: 0,
      burningCells: 0,
      infectedCells: 0,
      crackedCells: 0,
      massGained: 0,
      massLost: 0,
      regionGrid: new Float32Array(R2).fill(1),
    };
  }

  /* -------------------------------------------------------------------------------------------- *
   *  Coordinates (all consistent with contracts/space.ts, evaluated per integer row)
   * -------------------------------------------------------------------------------------------- */

  /** Horizontal world shear of local row `j` (cosmetic lean). */
  rowShift(j: number): number {
    const t = this.transform;
    return t.lean === 0 ? 0 : leanShift(t.lean, j, t.anchorY);
  }

  /** World position of the CENTRE of local cell (i, j). */
  cellWorld(i: number, j: number, out: WorldPoint): void {
    const t = this.transform;
    out.x = t.x + (i + 0.5 - t.anchorX) * t.facing + this.rowShift(j);
    out.y = t.y + (j + 0.5 - t.anchorY);
  }

  /** Local cell index containing world point, or -1 if outside the map. */
  cellAtWorld(wx: number, wy: number): number {
    const t = this.transform;
    const ly = wy - t.y + t.anchorY;
    const j = Math.floor(ly);
    if (j < 0 || j >= this.h) return -1;
    const dx = wx - t.x - this.rowShift(j);
    const i = Math.floor(dx * t.facing + t.anchorX);
    if (i < 0 || i >= this.w) return -1;
    return j * this.w + i;
  }

  /** Continuous local coordinates of a world point (row shear evaluated at the containing row). */
  worldToLocalF(wx: number, wy: number, out: WorldPoint): void {
    const t = this.transform;
    const ly = wy - t.y + t.anchorY;
    const dx = wx - t.x - this.rowShift(Math.floor(ly));
    out.x = dx * t.facing + t.anchorX;
    out.y = ly;
  }

  /**
   * Candidate cell window (inclusive, clipped to the map) for a world-space AABB. Row-wise x ranges depend on the row
   * shear and mirroring, so callers loop rows and call `rowXRange`.
   */
  rowRange(by0: number, by1: number, out: { a: number; b: number }): boolean {
    const t = this.transform;
    let j0 = Math.ceil(by0 - t.y + t.anchorY - 0.5);
    let j1 = Math.floor(by1 - t.y + t.anchorY - 0.5);
    if (j0 < 0) j0 = 0;
    if (j1 > this.h - 1) j1 = this.h - 1;
    out.a = j0;
    out.b = j1;
    return j1 >= j0;
  }

  /** Inclusive local x range of cells in row `j` whose centres lie in world x ∈ [bx0, bx1]. */
  rowXRange(j: number, bx0: number, bx1: number, out: { a: number; b: number }): boolean {
    const t = this.transform;
    const sh = this.rowShift(j);
    let i0: number;
    let i1: number;
    if (t.facing === 1) {
      i0 = Math.ceil(bx0 - t.x - sh + t.anchorX - 0.5);
      i1 = Math.floor(bx1 - t.x - sh + t.anchorX - 0.5);
    } else {
      i0 = Math.ceil(t.anchorX - 0.5 + t.x + sh - bx1);
      i1 = Math.floor(t.anchorX - 0.5 + t.x + sh - bx0);
    }
    if (i0 < 0) i0 = 0;
    if (i1 > this.w - 1) i1 = this.w - 1;
    out.a = i0;
    out.b = i1;
    return i1 >= i0;
  }

  /**
   * Collect live cells covered by `q` into (idx, wgt). Returns the count. Rows scanned in order, so the list order is
   * deterministic. `idx`/`wgt` must have capacity >= w*h.
   */
  collect(q: ShapeQ, idx: Int32Array, wgt: Float32Array, looseOnly = false): number {
    const map = this.map;
    const mat = map.material;
    const integ = map.integrity;
    const t = this.transform;
    const w = this.w;
    const rr = this.rr;
    const cr = this.cr;
    if (!this.rowRange(q.by0, q.by1, rr)) return 0;
    let n = 0;
    const flags = map.flags;
    const loose = this.looseMat;
    for (let j = rr.a; j <= rr.b; j++) {
      const wy = t.y + (j + 0.5 - t.anchorY);
      if (!q.rowSpan(wy)) continue;
      if (!this.rowXRange(j, q.sx0, q.sx1, cr)) continue;
      const sh = this.rowShift(j);
      const rowBase = j * w;
      const f = t.facing;
      for (let i = cr.a; i <= cr.b; i++) {
        const c = rowBase + i;
        if (mat[c] === 0 || integ[c] === 0) continue;
        if (looseOnly && (flags[c]! & 32) === 0 && loose[mat[c]!] === 0) continue;
        const wx = t.x + (i + 0.5 - t.anchorX) * f + sh;
        const wt = q.weight(wx, wy);
        if (wt > 0) {
          idx[n] = c;
          wgt[n] = wt;
          n++;
        }
      }
    }
    return n;
  }

  /** True if the shape kind benefits from a directional axis (line/cone). */
  static isDirectional(q: ShapeQ): boolean {
    return q.kind === K_LINE || q.kind === K_CONE;
  }

  /* -------------------------------------------------------------------------------------------- *
   *  Dirty tracking
   * -------------------------------------------------------------------------------------------- */

  private findEvt(a: number): number {
    const par = this.connEvtParent;
    while (par[a] !== a) {
      par[a] = par[par[a]!]!;
      a = par[a]!;
    }
    return a;
  }

  private unionEvt(a: number, b: number): void {
    const ra = this.findEvt(a);
    const rb = this.findEvt(b);
    if (ra !== rb) this.connEvtParent[ra] = rb;
  }

  /** Start a removal event; -1 (and a full flood requested) if the event list is full. */
  private newEvt(): number {
    if (this.connEvtN >= CONN_EVT_CAP) {
      this.connFull = true;
      return -1;
    }
    const e = this.connEvtN++;
    this.connEvtParent[e] = e;
    return e;
  }

  private seedTouch(c: number, e: number): void {
    if (this.seedMark[c] === this.seedGen) {
      this.unionEvt(this.cellEvt[c]!, e);
      return;
    }
    if (this.connSeedN >= CONN_SEED_CAP) {
      this.connFull = true;
      return;
    }
    this.seedMark[c] = this.seedGen;
    this.cellEvt[c] = e;
    this.connSeed[this.connSeedN++] = c;
  }

  /** Cell `i` is about to be removed: its live 4-neighbours join the change frontier, and removed neighbours join its event. */
  noteKill(i: number): void {
    if (this.connFull) return;
    if (this.coreMask[i] !== 0) {
      // An anchor cell died: the components it anchored may be orphaned without any cut. Only the full flood decides that.
      this.connFull = true;
      return;
    }
    const e = this.newEvt();
    if (e < 0) return;
    const w = this.w;
    const mat = this.map.material;
    const x = i % w;
    this.killMark[i] = this.seedGen;
    this.killEvt[i] = e;
    if (x > 0) this.touchNeighbour(i - 1, e, mat);
    if (x < w - 1) this.touchNeighbour(i + 1, e, mat);
    if (i >= w) this.touchNeighbour(i - w, e, mat);
    if (i + w < this.n) this.touchNeighbour(i + w, e, mat);
  }

  private touchNeighbour(j: number, e: number, mat: Uint8Array): void {
    if (mat[j] !== 0) this.seedTouch(j, e);
    else if (this.killMark[j] === this.seedGen) this.unionEvt(e, this.killEvt[j]!);
  }

  /** The bond between live cells `u` and `v` was just broken. */
  noteBreak(u: number, v: number): void {
    if (this.connFull) return;
    const e = this.newEvt();
    if (e < 0) return;
    this.seedTouch(u, e);
    this.seedTouch(v, e);
  }

  /** Root of a frontier cell's event cluster. */
  clusterOf(c: number): number {
    return this.findEvt(this.cellEvt[c]!);
  }

  /** Mark an inclusive local cell rect as changed: visuals, region stats. Cheap; call after any mutation. */
  touch(x0: number, y0: number, x1: number, y1: number): void {
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > this.w - 1) x1 = this.w - 1;
    if (y1 > this.h - 1) y1 = this.h - 1;
    if (x1 < x0 || y1 < y0) return;
    // Visual refresh needs a one-cell margin (neighbour presence changes edge lighting).
    let tx0 = (x0 - 1) >> TILE_SHIFT;
    let ty0 = (y0 - 1) >> TILE_SHIFT;
    let tx1 = (x1 + 1) >> TILE_SHIFT;
    let ty1 = (y1 + 1) >> TILE_SHIFT;
    if (tx0 < 0) tx0 = 0;
    if (ty0 < 0) ty0 = 0;
    if (tx1 > this.tilesX - 1) tx1 = this.tilesX - 1;
    if (ty1 > this.tilesY - 1) ty1 = this.tilesY - 1;
    for (let ty = ty0; ty <= ty1; ty++) {
      const base = ty * this.tilesX;
      for (let tx = tx0; tx <= tx1; tx++) this.tileVis[base + tx] = 1;
    }
    this.visDirty = true;
    const rx0 = this.regionOfX[x0]!;
    const rx1 = this.regionOfX[x1]!;
    const ry0 = this.regionOfY[y0]!;
    const ry1 = this.regionOfY[y1]!;
    for (let ry = ry0; ry <= ry1; ry++)
      for (let rx = rx0; rx <= rx1; rx++) this.regionDirty[ry * REGION_GRID + rx] = 1;
    this.statsDirty = true;
  }

  /**
   * Mark ONE cell as changed: refreshes only its own tile (and a neighbouring tile if the cell lies on a tile border, since
   * edge lighting reads neighbours) and its stats region. Much cheaper than `touch` for scattered single-cell changes.
   */
  touchPoint(x: number, y: number): void {
    const tx = x >> TILE_SHIFT;
    const ty = y >> TILE_SHIFT;
    const tv = this.tileVis;
    const tw = this.tilesX;
    tv[ty * tw + tx] = 1;
    const lx = x & (TILE - 1);
    const ly = y & (TILE - 1);
    if (lx === 0 && tx > 0) tv[ty * tw + tx - 1] = 1;
    else if (lx === TILE - 1 && tx < tw - 1) tv[ty * tw + tx + 1] = 1;
    if (ly === 0 && ty > 0) tv[(ty - 1) * tw + tx] = 1;
    else if (ly === TILE - 1 && ty < this.tilesY - 1) tv[(ty + 1) * tw + tx] = 1;
    this.visDirty = true;
    this.regionDirty[this.regionOfY[y]! * REGION_GRID + this.regionOfX[x]!] = 1;
    this.statsDirty = true;
  }

  touchCell(c: number): void {
    const y = (c / this.w) | 0;
    const x = c - y * this.w;
    this.touch(x, y, x, y);
  }

  /** Wake a tile (thermal/infection activity) around a cell. */
  wakeCell(c: number, bit: number): void {
    const y = (c / this.w) | 0;
    const x = c - y * this.w;
    this.wakeRect(x, y, x, y, bit);
  }

  wakeRect(x0: number, y0: number, x1: number, y1: number, bit: number): void {
    let tx0 = (x0 - 1) >> TILE_SHIFT;
    let ty0 = (y0 - 1) >> TILE_SHIFT;
    let tx1 = (x1 + 1) >> TILE_SHIFT;
    let ty1 = (y1 + 1) >> TILE_SHIFT;
    if (tx0 < 0) tx0 = 0;
    if (ty0 < 0) ty0 = 0;
    if (tx1 > this.tilesX - 1) tx1 = this.tilesX - 1;
    if (ty1 > this.tilesY - 1) ty1 = this.tilesY - 1;
    for (let ty = ty0; ty <= ty1; ty++) {
      const base = ty * this.tilesX;
      for (let tx = tx0; tx <= tx1; tx++) this.tileAct[base + tx] = this.tileAct[base + tx]! | bit;
    }
  }

  /** Mass of live cell `c` (0 for void). */
  cellMass(c: number): number {
    const m = this.map.material[c]!;
    return m === 0 ? 0 : (this.matDensity[m]! * this.map.density[c]!) / 128;
  }

  /* -------------------------------------------------------------------------------------------- *
   *  Stats
   * -------------------------------------------------------------------------------------------- */

  private recomputeRegion(r: number): void {
    const map = this.map;
    const mat = map.material;
    const integ = map.integrity;
    const flags = map.flags;
    const inf = map.infection;
    const dens = map.density;
    const w = this.w;
    const rx = r % REGION_GRID;
    const ry = (r / REGION_GRID) | 0;
    const x0 = Math.ceil((rx * w) / REGION_GRID - 1e-9);
    const x1 = Math.min(w, Math.ceil(((rx + 1) * w) / REGION_GRID - 1e-9));
    const y0 = Math.ceil((ry * this.h) / REGION_GRID - 1e-9);
    const y1 = Math.min(this.h, Math.ceil(((ry + 1) * this.h) / REGION_GRID - 1e-9));
    let mass = 0;
    let cells = 0;
    let isum = 0;
    let burn = 0;
    let infect = 0;
    let crack = 0;
    const md = this.matDensity;
    for (let y = y0; y < y1; y++) {
      const base = y * w;
      for (let x = x0; x < x1; x++) {
        const c = base + x;
        const m = mat[c]!;
        if (m === 0) continue;
        cells++;
        mass += (md[m]! * dens[c]!) / 128;
        isum += integ[c]!;
        const f = flags[c]!;
        if (f & 1) burn++;
        if (f & 2) crack++;
        if (inf[c]! >= 64) infect++;
      }
    }
    this.regionMass[r] = mass;
    this.regionCells[r] = cells;
    this.regionInteg[r] = isum;
    this.regionBurn[r] = burn;
    this.regionInfect[r] = infect;
    this.regionCrack[r] = crack;
    this.regionDirty[r] = 0;
  }

  /** Recompute every dirty region and refresh `map.mass/liveCells` + `stats` (in place). */
  refreshStats(): BodyStats {
    if (!this.statsDirty) return this.stats;
    for (let r = 0; r < R2; r++) if (this.regionDirty[r]) this.recomputeRegion(r);
    this.statsDirty = false;
    let mass = 0;
    let cells = 0;
    let burn = 0;
    let infect = 0;
    let crack = 0;
    for (let r = 0; r < R2; r++) {
      mass += this.regionMass[r]!;
      cells += this.regionCells[r]!;
      burn += this.regionBurn[r]!;
      infect += this.regionInfect[r]!;
      crack += this.regionCrack[r]!;
    }
    mass += this.pool;
    const map = this.map;
    map.mass = mass;
    map.liveCells = cells;
    const s = this.stats;
    s.mass = mass;
    s.initialMass = map.initialMass;
    s.massFrac = map.initialMass > 0 ? mass / map.initialMass : 0;
    s.cells = cells;
    s.initialCells = map.initialCells;
    s.burningCells = burn;
    s.infectedCells = infect;
    s.crackedCells = crack;
    s.massGained = this.massGained;
    s.massLost = this.massLost;
    s.anchoredFrac = this.anchoredFrac;
    this.computeCore(s);
    this.computeRegionGrid(s.regionGrid);
    return s;
  }

  private computeCore(s: BodyStats): void {
    const map = this.map;
    const integ = map.integrity;
    const mat = map.material;
    const disc = this.coreDiscIdx;
    let sum = 0;
    for (let k = 0; k < disc.length; k++) {
      const c = disc[k]!;
      if (mat[c] !== 0) sum += integ[c]!;
    }
    s.coreIntegrity = this.corePristine > 0 ? Math.min(1, sum / (255 * this.corePristine)) : 0;
    // Exposure: 16 rays from the core centre outwards; a ray is open if it meets no live cell beyond the core radius.
    const cx = map.coreX;
    const cy = map.coreY;
    const cr = map.coreRadius;
    let open = 0;
    const maxR = Math.max(this.w, this.h);
    for (let a = 0; a < 16; a++) {
      const ang = (a * Math.PI) / 8 + 0.1;
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      let hit = false;
      for (let d = cr + 1.5; d < maxR; d += 1) {
        const x = Math.floor(cx + dx * d);
        const y = Math.floor(cy + dy * d);
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) break;
        if (mat[y * this.w + x] !== 0) {
          hit = true;
          break;
        }
      }
      if (!hit) open++;
    }
    s.exposedCoreFrac = open / 16;
  }

  private computeRegionGrid(out: Float32Array): void {
    const flip = this.transform.facing === -1;
    for (let ry = 0; ry < REGION_GRID; ry++) {
      for (let rx = 0; rx < REGION_GRID; rx++) {
        const r = ry * REGION_GRID + rx;
        const p = this.regionPristine[r]!;
        const v = p > 0 ? Math.min(1, this.regionInteg[r]! / (255 * p)) : 1;
        const col = flip ? REGION_GRID - 1 - rx : rx;
        out[ry * REGION_GRID + col] = v;
      }
    }
  }

  /** True when the body meets a KO threshold (used by tests; Match owns the real KO logic). */
  isKo(): boolean {
    const s = this.refreshStats();
    return s.coreIntegrity < KO_CORE_INTEGRITY;
  }
}
