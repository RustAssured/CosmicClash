import {
  clamp,
  clamp01,
  hex,
  localToWorld,
  type DamageEvent,
  type DamageShape,
  type DebugShape,
  type EffectiveStats,
  type FighterTickCtx,
  type OverlapResult,
  type RenderLayer,
  type ViewRect,
} from '@/contracts';
import { groupNexusCells, hash01, type NexusGroups, type NexusRig } from '@/titans';
import { Behaviour, type HitInfo, type InterceptResult } from '../behaviour';
import type { FighterImpl } from '../fighter';
import { ChainPen } from '../fx/chain';
import { Overlay } from '../fx/overlay';
import type { ActiveMove } from '../move';
import { asShape, makeFatShape, shapeIntersectsDisc } from '../shapes';

const MAX_CHAINS = 3;
const MAX_WHIPS = 8;
const WHIP_N = 7;
const WHIP_LEN = 6.5;
const SEGS = 8;
/** Below this fraction of its cells a node no longer counts as alive. */
const NODE_ALIVE = 0.4;
/** A chain with fewer surviving cells than this fraction is gone whatever its bonds say. */
const EDGE_ALIVE = 0.3;
const CAGE_SEG_W = 0.34; // half-angle of a cage segment (rad)

interface RootCfg {
  mul: number;
  ticks: number;
  chains: number;
  snap: number;
}
interface CageCfg {
  segments: number;
  radius: [number, number];
  build: number;
  closeFrom: number;
  closeTo: number;
  hp: number;
  breakAt: number;
  crush: { energy: number; latch: number; compress: number; crater: number };
}

/**
 * THE NEXUS. A graph of nodes and chains around a crystal hub.
 *
 *  - Failure mode: chains are the ONLY bonds between nodes, so a cut chain isolates a sub-graph. Every few ticks (and at once when
 *    a blow lands) the behaviour walks the bond graph of each chain, works out which nodes are still wired to the hub and puts
 *    the rest out: their gems go dark and grey, they stop glowing and stop counting as `parts`. Because this runs the moment the
 *    blow is applied — before the matter world's connectivity pass — the island breaks away already dead and dull, not as
 *    healthy debris.
 *  - Growth: mass credited by harvesting is built into new lattice cells budding off the outer nodes; each 60 cells adds a node
 *    of capacity and the Nexus drifts heavier.
 *  - Chains: Latch lashes one out, Constrict roots the foe with three that persist until the Nexus is hurt hard enough to snap
 *    them, and Ingesloten Oog builds a cage of eight segments around the foe that the foe can break by hitting it, and crushes
 *    inward if it is left whole.
 *  - Secondary animation: light travelling along every live chain toward the hub, breathing nodes, a shimmering crystal, loose
 *    chain ends whipping when a chain is cut.
 */
export class NexusBehaviour extends Behaviour {
  private rig!: NexusRig;
  private groups!: NexusGroups;
  private pen!: ChainPen;
  private front!: Overlay;
  private cageOv!: Overlay;
  private fx!: Overlay;
  private nN = 0;
  private nE = 0;

  /* graph state */
  private nodeInit!: Int32Array;
  private edgeInit!: Int32Array;
  private nodeLive!: Int32Array;
  private edgeLive!: Int32Array;
  private edgeOk!: Uint8Array;
  private lit!: Uint8Array;
  private litNew!: Uint8Array;
  private dark!: Uint8Array;
  private darkEdge!: Uint8Array;
  private adj: number[][] = [];
  private queue!: Int32Array;
  private litCount = 0;
  private origBase!: Uint32Array;
  private origMat!: Uint8Array;
  private stamp!: Int32Array;
  private stamps = 1;
  private stack!: Int32Array;
  private lastVersion = -1;
  private lastEval = -100;
  private farCell = -1;
  private matDead = 0;
  private matNode = 0;
  private matNodeCore = 0;
  private emissiveOf!: Uint8Array;

  /* growth */
  private bank = 0;
  private lastFoeMass = 0;
  private harvesting = false;
  private lastHarvest = -1000;
  private grownCells = 0;
  private lastGrow = -1000;
  private budIdx = 0;

  /* chains */
  private readonly chOn = new Uint8Array(MAX_CHAINS);
  private readonly chNode = new Int16Array(MAX_CHAINS);
  private readonly chOffX = new Float32Array(MAX_CHAINS);
  private readonly chOffY = new Float32Array(MAX_CHAINS);
  private rootUntil = 0;
  private snapAcc = 0;
  private rootCfg: RootCfg | null = null;
  private rootedThisMove = false;
  private latchState = 0; // 0 none, 1 hooked, 2 retracting
  private latchT0 = 0;
  private latchNode = 1;
  private latchOffX = 0;
  private latchOffY = 0;
  private latchTipX = 0;
  private latchTipY = 0;

  /* whips (loose chain ends) */
  private readonly wx = new Float32Array(MAX_WHIPS * WHIP_N);
  private readonly wy = new Float32Array(MAX_WHIPS * WHIP_N);
  private readonly wpx = new Float32Array(MAX_WHIPS * WHIP_N);
  private readonly wpy = new Float32Array(MAX_WHIPS * WHIP_N);
  private readonly wLife = new Int16Array(MAX_WHIPS);
  private whipHead = 0;
  private readonly sx = new Float32Array(WHIP_N);
  private readonly sy = new Float32Array(WHIP_N);

  /* the cage (Ingesloten Oog) */
  private cage = { on: false, t: 0, cx: 0, cy: 0, r: 0, spin: 0, broken: false, crushed: false, fade: 0 };
  private cageCfg: CageCfg | null = null;
  private readonly segHp = new Float32Array(SEGS);
  private readonly segOn = new Uint8Array(SEGS);
  private readonly shape = makeFatShape();
  private readonly dmgCrush = {
    type: 'CRUSH' as const,
    energy: 0,
    duration: 1,
    flags: 0,
    params: { compress: 10, crater: 16, scatter: 1.2 },
  };
  private readonly dmgLatch = {
    type: 'ASSIMILATION' as const,
    energy: 0,
    duration: 1,
    flags: 4,
    params: { latch: 240 },
  };

  /* colours */
  private chainRamp: number[] = [];
  private nodeRamp: number[] = [];
  private lean = 0;
  private readonly xy = { x: 0, y: 0 };
  private readonly xy2 = { x: 0, y: 0 };
  private readonly tip = { x: 0, y: 0 };
  private nodeWX!: Float32Array;
  private nodeWY!: Float32Array;

  constructor(f: FighterImpl) {
    super(f);
  }

  override attach(): void {
    const f = this.f;
    const rig = f.rig as NexusRig;
    this.rig = rig;
    const map = f.body.map;
    this.groups = groupNexusCells(map, rig);
    this.nN = rig.nodes.length;
    this.nE = rig.edges.length;
    const nN = this.nN;
    const nE = this.nE;
    this.nodeInit = Int32Array.from(this.groups.nodeCells, (c) => c.length);
    this.edgeInit = Int32Array.from(this.groups.edgeCells, (c) => c.length);
    this.nodeLive = this.nodeInit.slice();
    this.edgeLive = this.edgeInit.slice();
    this.edgeOk = new Uint8Array(nE).fill(1);
    this.lit = new Uint8Array(nN).fill(1);
    this.litNew = new Uint8Array(nN);
    this.dark = new Uint8Array(nN);
    this.darkEdge = new Uint8Array(nE);
    this.queue = new Int32Array(nN);
    this.adj = Array.from({ length: nN }, () => []);
    rig.edges.forEach((e, k) => {
      this.adj[e.a]!.push(k);
      this.adj[e.b]!.push(k);
    });
    this.origBase = map.baseColor.slice();
    this.origMat = map.material.slice();
    this.stamp = new Int32Array(map.w * map.h);
    this.stack = new Int32Array(4096);
    this.matDead = rig.ids.deadnode;
    this.matNode = rig.ids.node;
    this.matNodeCore = rig.ids.nodecore;
    this.emissiveOf = new Uint8Array(f.body.materials.length);
    for (let m = 0; m < f.body.materials.length; m++) this.emissiveOf[m] = f.body.materials[m]?.emissive ?? 0;
    this.nodeWX = new Float32Array(nN);
    this.nodeWY = new Float32Array(nN);

    const chain = f.def.materials.find((m) => m.key === 'chain')!.visual.ramp.map(hex);
    this.chainRamp = chain;
    this.nodeRamp = f.def.materials.find((m) => m.key === 'node')!.visual.ramp.map(hex);
    this.pen = new ChainPen(chain);
    this.front = new Overlay('nexus-chains', 1, 560, 360, 'normal', false);
    this.cageOv = new Overlay('nexus-cage', 2, 420, 420, 'normal', true);
    this.fx = new Overlay('nexus-fx', 20, 360, 320, 'add', true);
    this.rootCfg = (f.slotMoves.crush?.extra?.['root'] as RootCfg | undefined) ?? null;
    this.cageCfg = (f.slotMoves.ultimate?.extra?.['cage'] as CageCfg | undefined) ?? null;
    f.resourceMax = f.def.resource.max;
    this.litCount = nN - 1;
    f.resource = this.litCount;
    this.evaluate(true);
  }

  override reset(_heal: number): void {
    this.revive();
    this.clearChains();
    this.cage.on = false;
    this.cage.fade = 0;
    this.latchState = 0;
    this.whipHead = 0;
    this.wLife.fill(0);
    this.evaluate(true);
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  stats, guard
   * ---------------------------------------------------------------------------------------------- */

  private get ratio(): number {
    return clamp01(this.litCount / Math.max(1, this.nN - 1));
  }

  override adjustStats(s: EffectiveStats, massFrac: number): void {
    const r = this.ratio;
    s.reachMul *= 0.72 + 0.28 * r;
    s.damageMul *= 0.85 + 0.15 * r;
    // Growth: what it has eaten makes it heavier (and, through the fighter's own maths, a touch slower to shove)
    s.mass *= 1 + 0.5 * Math.max(0, massFrac - 1);
  }

  override guardMultiplier(): number {
    return 0.55 + 0.45 * this.ratio;
  }

  override leanBias(): number {
    return this.lean;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  graph: liveness, darkness
   * ---------------------------------------------------------------------------------------------- */

  /** Is the bond from cell `i` toward `dir` (0 right, 1 left, 2 down, 3 up) intact? Returns the neighbour or −1. */
  private step(i: number, dir: number): number {
    const map = this.f.body.map;
    const W = map.w;
    switch (dir) {
      case 0:
        return map.bondR[i]! > 0 && map.material[i + 1]! !== 0 ? i + 1 : -1;
      case 1:
        return i > 0 && map.bondR[i - 1]! > 0 && map.material[i - 1]! !== 0 ? i - 1 : -1;
      case 2:
        return map.bondD[i]! > 0 && map.material[i + W]! !== 0 ? i + W : -1;
      default:
        return i >= W && map.bondD[i - W]! > 0 && map.material[i - W]! !== 0 ? i - W : -1;
    }
  }

  /**
   * Walk chain `e` from node `from` along intact bonds. Returns true if it reaches `to`. `farCell` is left as the reached cell
   * farthest from `from` (where a cut chain's loose end is).
   */
  private walkEdge(e: number, from: number, to: number): boolean {
    const g = this.groups.of;
    const map = this.f.body.map;
    const mat = map.material;
    const gen = ++this.stamps;
    const stamp = this.stamp;
    const stack = this.stack;
    const cells = this.groups.edgeCells[e]!;
    const own = this.nN + e;
    let top = 0;
    // seeds: chain cells bonded to a live cell of `from`
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k]!;
      if (mat[i] === 0) continue;
      for (let d = 0; d < 4; d++) {
        const j = this.step(i, d);
        if (j >= 0 && g[j] === from) {
          stamp[i] = gen;
          stack[top++] = i;
          break;
        }
      }
    }
    const F = this.rig.nodes[from]!;
    const W = map.w;
    let far = -1;
    let farD = -1;
    let reached = false;
    while (top > 0 && top < stack.length - 4) {
      const i = stack[--top]!;
      const x = i % W;
      const dd = Math.hypot(x + 0.5 - F.x, (i - x) / W + 0.5 - F.y);
      if (dd > farD) {
        farD = dd;
        far = i;
      }
      for (let d = 0; d < 4; d++) {
        const j = this.step(i, d);
        if (j < 0) continue;
        const gj = g[j];
        if (gj === to) {
          reached = true;
        } else if (gj === own && stamp[j] !== gen) {
          stamp[j] = gen;
          stack[top++] = j;
        }
      }
    }
    this.farCell = far;
    return reached;
  }

  /** Recompute node/chain liveness and which nodes are still wired to the hub; darken what fell off. */
  private evaluate(force = false): void {
    const f = this.f;
    const map = f.body.map;
    const tick = f.tickNo;
    if (!force && map.version === this.lastVersion && tick - this.lastEval < 30) return;
    this.lastVersion = map.version;
    this.lastEval = tick;
    const mat = map.material;
    const { nodeCells, edgeCells } = this.groups;
    const nN = this.nN;
    for (let n = 0; n < nN; n++) {
      const cells = nodeCells[n]!;
      let c = 0;
      for (let k = 0; k < cells.length; k++) if (mat[cells[k]!] !== 0) c++;
      this.nodeLive[n] = c;
    }
    for (let e = 0; e < this.nE; e++) {
      const cells = edgeCells[e]!;
      let c = 0;
      for (let k = 0; k < cells.length; k++) if (mat[cells[k]!] !== 0) c++;
      this.edgeLive[e] = c;
      const ed = this.rig.edges[e]!;
      const ok =
        c >= EDGE_ALIVE * this.edgeInit[e]! &&
        this.nodeLive[ed.a]! >= NODE_ALIVE * this.nodeInit[ed.a]! &&
        this.nodeLive[ed.b]! >= NODE_ALIVE * this.nodeInit[ed.b]! &&
        this.walkEdge(e, ed.a, ed.b);
      if (this.edgeOk[e] && !ok) this.onEdgeCut(e);
      this.edgeOk[e] = ok ? 1 : 0;
    }
    // reachability from the hub over intact chains between live nodes
    this.litNew.fill(0);
    const q = this.queue;
    let head = 0;
    let tail = 0;
    if (this.nodeLive[0]! >= NODE_ALIVE * this.nodeInit[0]!) {
      this.litNew[0] = 1;
      q[tail++] = 0;
    }
    while (head < tail) {
      const n = q[head++]!;
      for (const e of this.adj[n]!) {
        if (!this.edgeOk[e]) continue;
        const ed = this.rig.edges[e]!;
        const o = ed.a === n ? ed.b : ed.a;
        if (this.litNew[o] || this.nodeLive[o]! < NODE_ALIVE * this.nodeInit[o]!) continue;
        this.litNew[o] = 1;
        q[tail++] = o;
      }
    }
    let count = 0;
    for (let n = 1; n < nN; n++) {
      if (this.lit[n] && !this.litNew[n]) this.goDark(n);
      this.lit[n] = this.litNew[n]!;
      if (this.lit[n]) count++;
    }
    this.lit[0] = this.litNew[0]!;
    if (count !== this.litCount) {
      this.litCount = count;
      this.syncResource();
    }
  }

  private syncResource(): void {
    const f = this.f;
    const grown = Math.min(4, Math.floor(this.grownCells / 60));
    const next = this.litCount + grown;
    if (next < f.resource)
      f.events.push({ t: 'resource', slot: f.slot, kind: 'spend', amount: f.resource - next });
    else if (next > f.resource)
      f.events.push({ t: 'resource', slot: f.slot, kind: 'gain', amount: next - f.resource });
    f.resource = next;
    f.view.parts = Math.floor(next);
  }

  /** A chain has just been cut: its loose ends whip. */
  private onEdgeCut(e: number): void {
    const ed = this.rig.edges[e]!;
    const map = this.f.body.map;
    const t = this.f.body.transform;
    for (const [from, to] of [
      [ed.a, ed.b],
      [ed.b, ed.a],
    ] as const) {
      // only the end still attached to something living whips; a dead end just falls with its island
      if (this.nodeLive[from]! < NODE_ALIVE * this.nodeInit[from]!) continue;
      if (this.walkEdge(e, from, to) || this.farCell < 0) continue;
      const W = map.w;
      const lx = this.farCell % W;
      const ly = (this.farCell - lx) / W;
      localToWorld(t, lx + 0.5, ly + 0.5, this.xy);
      const N = this.rig.nodes[from]!;
      localToWorld(t, N.x, N.y, this.xy2);
      let dx = this.xy.x - this.xy2.x;
      let dy = this.xy.y - this.xy2.y;
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl;
      dy /= dl;
      this.spawnWhip(this.xy.x, this.xy.y, dx, dy, 5.5);
    }
  }

  /** The node fell off the graph: grey it out, kill its glow, and its chains with it. */
  private goDark(n: number): void {
    if (this.dark[n]) return;
    this.dark[n] = 1;
    const f = this.f;
    const t = f.body.transform;
    const N = this.rig.nodes[n]!;
    let minX = 1e9;
    let minY = 1e9;
    let maxX = -1;
    let maxY = -1;
    const map = f.body.map;
    const W = map.w;
    const darkenList = (cells: Int32Array): void => {
      for (let k = 0; k < cells.length; k++) {
        const i = cells[k]!;
        if (map.material[i] === 0) continue;
        this.darkenCell(i);
        const x = i % W;
        const y = (i - x) / W;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    };
    darkenList(this.groups.nodeCells[n]!);
    for (const e of this.adj[n]!) {
      if (this.darkEdge[e]) continue;
      this.darkEdge[e] = 1;
      darkenList(this.groups.edgeCells[e]!);
    }
    if (maxX >= 0) this.markDirty(minX - 1, minY - 1, maxX + 2, maxY + 2);
    localToWorld(t, N.x, N.y, this.xy);
    f.events.push({
      t: 'cue',
      slot: f.slot,
      titan: f.def.id,
      id: 'node-dark',
      x: this.xy.x,
      y: this.xy.y,
      amount: 1,
    });
    // a puff of grey ash where the light went out
    const sp = f.particleSpawn;
    sp.kind = 'ash';
    sp.x = this.xy.x;
    sp.y = this.xy.y;
    sp.vx = 0;
    sp.vy = -10;
    sp.spread = 40;
    sp.count = 10;
    sp.ramp = [hex('#8a8084'), hex('#50464a'), hex('#241e20')];
    sp.life = [30, 70];
    sp.fieldScale = 0.3;
    sp.emissive = 0;
    sp.size = 1;
    sp.drag = 1;
    f.world.spawnParticles(sp);
  }

  private darkenCell(i: number): void {
    const map = this.f.body.map;
    const c = this.origBase[i]!;
    const r = c & 255;
    const g = (c >>> 8) & 255;
    const b = (c >>> 16) & 255;
    const l = 0.3 * r + 0.59 * g + 0.11 * b;
    const gr = (0.15 * r + 0.85 * l * 0.92 + 6) | 0;
    const gg = (0.15 * g + 0.85 * l * 0.86 + 5) | 0;
    const gb = (0.15 * b + 0.85 * l * 0.9 + 7) | 0;
    const px = ((255 << 24) | (Math.min(255, gb) << 16) | (Math.min(255, gg) << 8) | Math.min(255, gr)) >>> 0;
    map.baseColor[i] = px;
    map.pixels[i] = px;
    map.emissive[i] = 0;
    const m = map.material[i]!;
    if (m === this.matNode || m === this.matNodeCore) map.material[i] = this.matDead;
  }

  private markDirty(x0: number, y0: number, x1: number, y1: number): void {
    const map = this.f.body.map;
    const d = map.dirty;
    if (d === null) map.dirty = { x0, y0, x1, y1 };
    else {
      if (x0 < d.x0) d.x0 = x0;
      if (y0 < d.y0) d.y0 = y0;
      if (x1 > d.x1) d.x1 = x1;
      if (y1 > d.y1) d.y1 = y1;
    }
    map.version++;
  }

  /** Between rounds: everything that was greyed out is lit again (the matter world already regrew the cells). */
  private revive(): void {
    const map = this.f.body.map;
    const W = map.w;
    let minX = 1e9;
    let minY = 1e9;
    let maxX = -1;
    let maxY = -1;
    const all = [...this.groups.nodeCells, ...this.groups.edgeCells];
    for (const cells of all)
      for (let k = 0; k < cells.length; k++) {
        const i = cells[k]!;
        if (map.material[i] === 0) continue;
        const om = this.origMat[i]!;
        if (map.baseColor[i] === this.origBase[i] && map.material[i] === om) continue;
        map.baseColor[i] = this.origBase[i]!;
        map.pixels[i] = this.origBase[i]!;
        map.material[i] = om;
        map.emissive[i] = this.emissiveOf[om]!;
        const x = i % W;
        const y = (i - x) / W;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    if (maxX >= 0) this.markDirty(minX - 1, minY - 1, maxX + 2, maxY + 2);
    this.dark.fill(0);
    this.darkEdge.fill(0);
    this.lit.fill(1);
    this.edgeOk.fill(1);
    this.litCount = this.nN - 1;
    this.syncResource();
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  growth: harvested mass is built into new lattice
   * ---------------------------------------------------------------------------------------------- */

  private grow(): void {
    const f = this.f;
    const tick = f.tickNo;
    // what the foe loses while a harvest runs is what the Nexus can build with (its own mass pool is not credited: see extra.noCredit)
    const foeMass = (f.foe.view.bodyStats as { mass: number }).mass;
    if (f.mv.def?.id === 'nexus.harvest') this.lastHarvest = tick;
    this.harvesting = tick - this.lastHarvest < 40;
    if (this.harvesting && foeMass < this.lastFoeMass) this.bank += (this.lastFoeMass - foeMass) * 0.5;
    this.lastFoeMass = foeMass;
    if (tick - this.lastGrow < 45 || f.ko) return;
    const lattice = f.body.materials.findIndex((m) => m.key === 'lattice');
    if (lattice < 0) return;
    const per = f.body.materials[lattice]!.density;
    const pool = this.bank;
    const cells = Math.min(48, Math.floor((pool * 0.9) / Math.max(0.05, per)));
    if (cells < 12 || this.rig.buds.length === 0) return;
    const bud = this.rig.buds[this.budIdx++ % this.rig.buds.length]!;
    localToWorld(f.body.transform, bud.x, bud.y, this.xy);
    const added = f.world.grow(f.body.id, {
      cells,
      materialKey: 'lattice',
      nearX: this.xy.x,
      nearY: this.xy.y,
    });
    this.lastGrow = tick;
    if (added <= 0) return;
    this.bank = Math.max(0, this.bank - (added * per) / 0.9);
    this.grownCells += added;
    f.events.push({
      t: 'cue',
      slot: f.slot,
      titan: f.def.id,
      id: 'harvest',
      x: this.xy.x,
      y: this.xy.y,
      amount: added,
    });
    this.syncResource();
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  moves: chains, root, cage
   * ---------------------------------------------------------------------------------------------- */

  override onMoveStart(m: ActiveMove): void {
    this.rootedThisMove = false;
    if (m.def?.id === 'nexus.latch') this.latchState = 0;
  }

  override onMoveEnd(m: ActiveMove, _interrupted: boolean): void {
    if (m.def?.id === 'nexus.oog' && this.cage.on) this.endCage(false);
    if (m.def?.id === 'nexus.latch' && m.hits === 0) {
      this.latchState = 2;
      this.latchT0 = this.f.tickNo;
      this.latchTipX = this.tip.x;
      this.latchTipY = this.tip.y;
    }
  }

  override onDealt(_energy: number): void {
    const f = this.f;
    const m = f.mv;
    const id = m.def?.id;
    const fv = f.foe.view;
    if (id === 'nexus.latch' && this.latchState !== 1) {
      this.latchState = 1;
      this.latchT0 = f.tickNo;
      this.latchNode = this.frontNode(0);
      this.latchOffX = (this.tip.x - fv.x) * 0.9;
      this.latchOffY = this.tip.y - fv.y;
      f.events.push({
        t: 'cue',
        slot: f.slot,
        titan: f.def.id,
        id: 'chain-latch',
        x: this.tip.x,
        y: this.tip.y,
        amount: 1,
      });
    } else if (id === 'nexus.constrict' && !this.rootedThisMove && this.rootCfg) {
      this.rootedThisMove = true;
      this.attachChains(this.rootCfg);
    }
  }

  override onDamaged(energy: number, _dx: number, _dy: number): void {
    // graph liveness is re-read at once: the blow's cuts are in the bond graph but the matter world has not detached anything yet
    this.evaluate(true);
    if (this.rootUntil > this.f.tickNo && this.rootCfg) {
      this.snapAcc += energy;
      if (this.snapAcc >= this.rootCfg.snap) this.snapChains();
    }
  }

  /** The `k`-th lit node counting from the front (most forward along the facing). */
  private frontNode(k: number): number {
    const f = this.f;
    let best = -1;
    let bestScore = -1e9;
    let seen = 0;
    const used = new Uint8Array(0);
    void used;
    // selection by repeated maximum: nN is 13, this is not a hot path
    const taken = this.stackTaken;
    taken.fill(0);
    for (let pass = 0; pass <= k; pass++) {
      best = -1;
      bestScore = -1e9;
      for (let n = 1; n < this.nN; n++) {
        if (!this.lit[n] || taken[n]) continue;
        const s =
          (this.rig.nodes[n]!.x - this.rig.hub.x) *
          f.facing *
          (f.body.transform.facing === f.facing ? 1 : -1);
        if (s > bestScore) {
          bestScore = s;
          best = n;
        }
      }
      if (best >= 0) taken[best] = 1;
      seen++;
    }
    void seen;
    return best < 0 ? 0 : best;
  }
  private readonly stackTaken = new Uint8Array(32);

  private attachChains(cfg: RootCfg): void {
    const f = this.f;
    const fv = f.foe.view;
    const n = Math.min(MAX_CHAINS, cfg.chains);
    const halfH = Math.max(12, (fv.boundsY1 - fv.boundsY0) / 2);
    const halfW = Math.max(12, (fv.boundsX1 - fv.boundsX0) / 2);
    for (let i = 0; i < MAX_CHAINS; i++) {
      this.chOn[i] = i < n ? 1 : 0;
      this.chNode[i] = this.frontNode(i);
      // anchor points on the near side of the foe, spread over its height
      this.chOffX[i] = -f.facing * halfW * 0.5 + (hash01(i, f.tickNo, 3) - 0.5) * 8;
      this.chOffY[i] = (i - (n - 1) / 2) * halfH * 0.5;
    }
    this.rootUntil = f.tickNo + cfg.ticks;
    this.snapAcc = 0;
    const foe = f.foe as unknown as { applyStatus?: (mul: number, ticks: number) => void };
    foe.applyStatus?.(cfg.mul, cfg.ticks);
    f.events.push({
      t: 'cue',
      slot: f.slot,
      titan: f.def.id,
      id: 'chain-latch',
      x: fv.x,
      y: fv.y,
      amount: n,
    });
  }

  private clearChains(): void {
    this.chOn.fill(0);
    this.rootUntil = 0;
    const foe = this.f.foe as unknown as { clearStatus?: () => void } | undefined;
    foe?.clearStatus?.();
  }

  /** The chains part: whips fly off both ends and the foe is free. */
  private snapChains(): void {
    const f = this.f;
    const fv = f.foe.view;
    for (let i = 0; i < MAX_CHAINS; i++) {
      if (!this.chOn[i]) continue;
      const ex = fv.x + this.chOffX[i]!;
      const ey = fv.y + this.chOffY[i]!;
      this.nodePos(this.chNode[i]!);
      const dx = this.xy.x - ex;
      const dy = this.xy.y - ey;
      const dl = Math.hypot(dx, dy) || 1;
      this.spawnWhip(ex, ey, dx / dl, dy / dl, 6);
    }
    this.clearChains();
    f.events.push({ t: 'cue', slot: f.slot, titan: f.def.id, id: 'chain-snap', x: fv.x, y: fv.y, amount: 1 });
  }

  private nodePos(n: number): void {
    localToWorld(this.f.body.transform, this.rig.nodes[n]!.x, this.rig.nodes[n]!.y, this.xy);
  }

  /* --- the cage --- */

  private startCage(): void {
    const cfg = this.cageCfg;
    if (!cfg) return;
    const fv = this.f.foe.view;
    const c = this.cage;
    c.on = true;
    c.t = 0;
    c.cx = fv.x;
    c.cy = fv.y;
    c.r = cfg.radius[0];
    c.spin = 0;
    c.broken = false;
    c.crushed = false;
    c.fade = 0;
    this.segHp.fill(cfg.hp);
    this.segOn.fill(1);
    this.f.events.push({
      t: 'cue',
      slot: this.f.slot,
      titan: this.f.def.id,
      id: 'chain-latch',
      x: c.cx,
      y: c.cy,
      amount: SEGS,
    });
  }

  /** The cage is over: `crushed` = it closed on the foe, otherwise it was broken or the move ended. */
  private endCage(crushed: boolean): void {
    const c = this.cage;
    if (!c.on) return;
    c.on = false;
    c.crushed = crushed;
    c.fade = crushed ? 14 : 24;
    if (!crushed) {
      // the surviving segments fall away as whips
      for (let k = 0; k < SEGS; k++) {
        if (!this.segOn[k]) continue;
        const a = this.segAngle(k) + c.spin;
        this.spawnWhip(c.cx + Math.cos(a) * c.r, c.cy + Math.sin(a) * c.r, Math.cos(a), Math.sin(a), 3.5);
      }
    }
  }

  private segAngle(k: number): number {
    return (k / SEGS) * Math.PI * 2;
  }

  override resolveVolumes(_ctx: FighterTickCtx): void {
    const f = this.f;
    const m = f.mv;
    const cfg = this.cageCfg;
    if (f.ko) return;
    if (
      m.def?.id === 'nexus.oog' &&
      !m.feint &&
      m.phase === 'active' &&
      !this.cage.on &&
      this.cage.fade === 0 &&
      !this.cage.crushed
    ) {
      this.startCage();
    }
    if (!this.cage.on || !cfg) return;
    const c = this.cage;
    if (m.def?.id !== 'nexus.oog' || m.phase === 'recovery') {
      this.endCage(false);
      return;
    }
    c.t = m.phaseTick - 1;
    const fv = f.foe.view;
    // the cage is centred where the foe was, with lag: a quick dash out of it strands the cage
    const lag = c.t < cfg.closeFrom ? 0.09 : 0.035;
    c.cx += (fv.x - c.cx) * lag;
    c.cy += (fv.y - c.cy) * lag;
    c.spin += 0.012;
    if (c.t <= cfg.closeFrom) c.r = cfg.radius[0];
    else {
      const u = clamp01((c.t - cfg.closeFrom) / Math.max(1, cfg.closeTo - cfg.closeFrom));
      c.r = cfg.radius[0] + (cfg.radius[1] - cfg.radius[0]) * (u * u * (3 - 2 * u));
    }
    let alive = 0;
    for (let k = 0; k < SEGS; k++) alive += this.segOn[k]!;
    if (SEGS - alive >= cfg.breakAt) {
      this.endCage(false);
      f.events.push({
        t: 'cue',
        slot: f.slot,
        titan: f.def.id,
        id: 'chain-snap',
        x: c.cx,
        y: c.cy,
        amount: 1,
      });
      return;
    }
    // the crush
    if (c.t === cfg.closeTo) {
      const reach = cfg.radius[1] + 14;
      if (Math.hypot(fv.x - c.cx, fv.y - c.cy) <= reach) {
        const sh = this.shape;
        sh.kind = 'point';
        sh.x = c.cx;
        sh.y = c.cy;
        sh.r = reach + 8;
        this.dmgCrush.energy = cfg.crush.energy;
        this.dmgCrush.params.compress = cfg.crush.compress;
        this.dmgCrush.params.crater = cfg.crush.crater;
        const hit = f.strike(sh, this.dmgCrush, 0, 0, 1, 14, 'ultimate', 'nexus.oog', 1);
        if (hit) {
          this.dmgLatch.energy = cfg.crush.energy * 0.12;
          this.dmgLatch.params.latch = cfg.crush.latch;
          f.strike(sh, this.dmgLatch, 0, 0, 0.1, 0, 'ultimate', 'nexus.oog', 1);
        }
      }
      this.endCage(true);
      return;
    }
    // a threat for the AI and the training overlay: a disc that goes live at closeTo
    const sh = this.shape;
    sh.kind = 'point';
    sh.x = c.cx;
    sh.y = c.cy;
    sh.r = cfg.radius[1] + 22;
    f.addThreat(
      asShape(sh) as DamageShape,
      'CRUSH',
      cfg.crush.energy,
      Math.max(0, cfg.closeTo - c.t),
      6,
      true,
    );
  }

  /** Sample discs along the live cage segments (parts the foe's blows can hit). */
  private forEachSegDisc(cb: (k: number, x: number, y: number) => boolean): void {
    const c = this.cage;
    if (!c.on) return;
    const build = this.cageCfg?.build ?? 1;
    const reveal = clamp01(c.t / build);
    for (let k = 0; k < SEGS; k++) {
      if (!this.segOn[k]) continue;
      const a0 = this.segAngle(k) + c.spin;
      for (let s = 0; s < 5; s++) {
        const u = (s / 4 - 0.5) * 2 * CAGE_SEG_W * reveal;
        if (cb(k, c.cx + Math.cos(a0 + u) * c.r, c.cy + Math.sin(a0 + u) * c.r)) return;
      }
    }
  }

  override probeParts(shape: DamageShape, out: OverlapResult): number {
    if (!this.cage.on) return 0;
    let hits = 0;
    let sx = 0;
    let sy = 0;
    this.forEachSegDisc((_k, x, y) => {
      if (shapeIntersectsDisc(shape, x, y, 7)) {
        hits++;
        sx += x;
        sy += y;
      }
      return false;
    });
    if (hits > 0) {
      if (out.cells === 0) {
        out.x = sx / hits;
        out.y = sy / hits;
        out.nearestX = out.x;
        out.nearestY = out.y;
        out.coverage = Math.max(out.coverage, 0.08);
      }
      out.cells += hits;
    }
    return hits;
  }

  override intercept(ev: DamageEvent, _info: HitInfo, res: InterceptResult): void {
    if (!this.cage.on || !this.cageCfg) return;
    const hp = this.cageCfg.hp;
    const dead = new Uint8Array(0);
    void dead;
    let struck = 0;
    const hit = this.hitSegs;
    hit.fill(0);
    this.forEachSegDisc((k, x, y) => {
      if (shapeIntersectsDisc(ev.shape, x, y, 7)) hit[k] = 1;
      return false;
    });
    for (let k = 0; k < SEGS; k++) {
      if (!hit[k]) continue;
      struck++;
      this.segHp[k] = this.segHp[k]! - ev.energy * 0.7;
      if (this.segHp[k]! <= 0 && this.segOn[k]) {
        this.segOn[k] = 0;
        const c = this.cage;
        const a = this.segAngle(k) + c.spin;
        this.spawnWhip(c.cx + Math.cos(a) * c.r, c.cy + Math.sin(a) * c.r, Math.cos(a), Math.sin(a), 4.5);
      }
    }
    if (struck > 0) {
      res.touched = true;
      res.partsHit += struck;
      res.absorbed = Math.max(res.absorbed, Math.min(0.5, (0.18 * struck * ev.energy) / Math.max(1, hp)));
    }
  }
  private readonly hitSegs = new Uint8Array(SEGS);

  override onKo(): void {
    this.cage.on = false;
    this.cage.fade = 0;
    this.clearChains();
    this.latchState = 0;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  whips: verlet chains that fly loose
   * ---------------------------------------------------------------------------------------------- */

  private spawnWhip(x: number, y: number, dx: number, dy: number, speed: number): void {
    const w = this.whipHead++ % MAX_WHIPS;
    this.wLife[w] = 110;
    const o = w * WHIP_N;
    for (let k = 0; k < WHIP_N; k++) {
      // the tip trails: points are laid back along the direction of travel, moving with `speed`
      const px = x - dx * k * WHIP_LEN * 0.9;
      const py = y - dy * k * WHIP_LEN * 0.9;
      this.wx[o + k] = px;
      this.wy[o + k] = py;
      this.wpx[o + k] = px - dx * speed * (1 - k / WHIP_N);
      this.wpy[o + k] = py - dy * speed * (1 - k / WHIP_N);
    }
  }

  private stepWhips(): void {
    for (let w = 0; w < MAX_WHIPS; w++) {
      if (this.wLife[w]! <= 0) continue;
      this.wLife[w]!--;
      const o = w * WHIP_N;
      for (let k = 0; k < WHIP_N; k++) {
        const i = o + k;
        const vx = (this.wx[i]! - this.wpx[i]!) * 0.982;
        const vy = (this.wy[i]! - this.wpy[i]!) * 0.982 + 0.16;
        this.wpx[i] = this.wx[i]!;
        this.wpy[i] = this.wy[i]!;
        this.wx[i] = this.wx[i]! + vx;
        this.wy[i] = this.wy[i]! + vy;
      }
      for (let it = 0; it < 3; it++)
        for (let k = 0; k + 1 < WHIP_N; k++) {
          const a = o + k;
          const b = a + 1;
          const dx = this.wx[b]! - this.wx[a]!;
          const dy = this.wy[b]! - this.wy[a]!;
          const dl = Math.hypot(dx, dy) || 1;
          const diff = (dl - WHIP_LEN) / dl;
          const half = k === 0 ? 0.35 : 0.5;
          this.wx[a] = this.wx[a]! + dx * diff * half;
          this.wy[a] = this.wy[a]! + dy * diff * half;
          this.wx[b] = this.wx[b]! - dx * diff * (1 - half);
          this.wy[b] = this.wy[b]! - dy * diff * (1 - half);
        }
    }
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  per tick
   * ---------------------------------------------------------------------------------------------- */

  override update(_ctx: FighterTickCtx): void {
    const f = this.f;
    const tick = f.tickNo;
    const t = f.body.transform;
    this.evaluate();
    this.grow();
    this.stepWhips();
    const root = this.rootCfg;
    if (this.rootUntil > 0 && tick >= this.rootUntil) this.clearChains();
    if (root && this.rootUntil > tick && f.foe.view.ko) this.clearChains();
    if (this.cage.fade > 0 && !this.cage.on) this.cage.fade--;
    // a slow sway; a heave when Constrict winds up
    const m = f.mv;
    this.lean = Math.sin(tick * 0.021 + f.slot) * 1.8;
    if (m.def?.id === 'nexus.constrict' && m.phase === 'startup') this.lean += -5 * clamp01(m.phaseTick / 14);
    f.view.parts = Math.floor(f.resource);
    for (let n = 0; n < this.nN; n++) {
      localToWorld(t, this.rig.nodes[n]!.x, this.rig.nodes[n]!.y, this.xy);
      this.nodeWX[n] = this.xy.x;
      this.nodeWY[n] = this.xy.y;
    }
    this.draw(tick, m);
  }

  private draw(tick: number, m: ActiveMove): void {
    const f = this.f;
    const t = f.body.transform;
    const fv = f.foe.view;
    // chains span from the Nexus to the foe: centre that overlay between them
    const midX = (t.x + fv.x) / 2;
    const midY = (t.y + fv.y) / 2;
    this.front.begin(midX, midY);
    this.cageOv.begin(this.cage.cx || fv.x, this.cage.cy || fv.y);
    this.fx.begin(t.x, t.y);
    if (!f.ko || f.stateTicks < 40) {
      this.drawGraphFx(tick, m);
      this.drawLatch(tick, m);
      this.drawRoot(tick);
      this.drawWhips();
      this.drawCage(tick, m);
    }
    this.front.end();
    this.cageOv.end();
    this.fx.end();
  }

  /** Light running along the chains toward the hub, breathing nodes, the crystal's shimmer. */
  private drawGraphFx(tick: number, m: ActiveMove): void {
    const fx = this.fx;
    const rig = this.rig;
    const t = this.f.body.transform;
    const harvesting = m.def?.id === 'nexus.harvest' && (m.phase === 'active' || m.phase === 'charge');
    const speed = harvesting ? 0.03 : 0.011;
    for (let e = 0; e < this.nE; e++) {
      if (!this.edgeOk[e] || this.darkEdge[e]) continue;
      const ed = rig.edges[e]!;
      const pts = ed.pts;
      const cnt = pts.length / 2;
      if (cnt < 3) continue;
      // flow runs from the outer node toward the inner one (toward the hub)
      const outward = rig.nodes[ed.a]!.ring >= rig.nodes[ed.b]!.ring;
      for (let p = 0; p < 2; p++) {
        let s = (tick * speed + e * 0.37 + p * 0.5) % 1;
        if (!outward) s = 1 - s;
        const fi = s * (cnt - 1);
        const i0 = Math.floor(fi);
        const fr = fi - i0;
        const i1 = Math.min(cnt - 1, i0 + 1);
        const lx = pts[i0 * 2]! + (pts[i1 * 2]! - pts[i0 * 2]!) * fr;
        const ly = pts[i0 * 2 + 1]! + (pts[i1 * 2 + 1]! - pts[i0 * 2 + 1]!) * fr;
        localToWorld(t, lx, ly, this.xy);
        fx.glow(this.xy.x, this.xy.y, harvesting ? 3.6 : 2.6, 255, 120, 150, harvesting ? 0.95 : 0.7);
      }
    }
    for (let n = 1; n < this.nN; n++) {
      if (!this.lit[n]) continue;
      const N = rig.nodes[n]!;
      const br = 0.2 + 0.1 * Math.sin(tick * 0.06 + n * 1.9);
      fx.glow(this.nodeWX[n]!, this.nodeWY[n]!, N.r * 1.25, 255, 40, 80, br + (harvesting ? 0.15 : 0));
    }
    // the hub: a breathing heart and a slow diagonal shimmer through the crystal
    const H = rig.hub;
    fx.glow(
      this.nodeWX[0]!,
      this.nodeWY[0]!,
      14 + 2 * Math.sin(tick * 0.05),
      255,
      110,
      170,
      0.28 + (harvesting ? 0.2 : 0),
    );
    const map = this.f.body.map;
    const W = map.w;
    const crystal = rig.ids.crystal;
    const phase = tick * 0.32;
    const R = Math.ceil(H.r);
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const lx = Math.round(H.x) + dx;
        const ly = Math.round(H.y) + dy;
        if (map.material[ly * W + lx] !== crystal) continue;
        const band = (((lx + ly * 0.7 - phase) % 13) + 13) % 13;
        if (band < 1.6) {
          localToWorld(t, lx + 0.5, ly + 0.5, this.xy);
          fx.add(
            Math.floor(this.xy.x),
            Math.floor(this.xy.y),
            70 * (1 - band / 1.6),
            95 * (1 - band / 1.6),
            130 * (1 - band / 1.6),
          );
        }
      }
    }
  }

  /** The Latch chain: paid out along the hit line, then hooked into the foe until it lets go. */
  private drawLatch(tick: number, m: ActiveMove): void {
    const f = this.f;
    const id = m.def?.id;
    const fv = f.foe.view;
    let reveal = 0;
    if (id === 'nexus.latch' && !m.feint && (m.phase === 'active' || m.phase === 'startup')) {
      this.nodePos(this.frontNode(0));
      if (m.phase === 'startup') {
        // coiled: a short length hangs from the front node
        const u = clamp01(m.phaseTick / Math.max(1, m.startup));
        this.tip.x = this.xy.x + f.facing * 10 * u;
        this.tip.y = this.xy.y + 6 * u;
        this.pen.span(this.front, this.xy.x, this.xy.y, this.tip.x, this.tip.y, 2, 0.4, tick * 0.2, 1);
        return;
      }
      const at = m.phaseTick - 1;
      const sh = this.shape;
      if (f.liveHitShape(0, at, sh) && sh.kind === 'line') {
        this.tip.x = sh.x1;
        this.tip.y = sh.y1;
        reveal = 1;
      }
    } else if (this.latchState === 1) {
      const age = tick - this.latchT0;
      if (age > 46 || fv.ko) {
        this.latchState = 2;
        this.latchT0 = tick;
        this.latchTipX = fv.x + this.latchOffX;
        this.latchTipY = fv.y + this.latchOffY;
        return;
      }
      this.tip.x = fv.x + this.latchOffX;
      this.tip.y = fv.y + this.latchOffY;
      reveal = 1;
      this.nodePos(this.latchNode);
    } else if (this.latchState === 2) {
      const age = tick - this.latchT0;
      if (age > 10) {
        this.latchState = 0;
        return;
      }
      this.nodePos(this.latchNode);
      this.tip.x = this.latchTipX;
      this.tip.y = this.latchTipY;
      reveal = 1 - age / 10;
      // retracting: the whole span shortens toward the node
      this.tip.x = this.xy.x + (this.tip.x - this.xy.x) * reveal;
      this.tip.y = this.xy.y + (this.tip.y - this.xy.y) * reveal;
      reveal = 1;
    }
    if (reveal <= 0) return;
    const ox = this.xy.x;
    const oy = this.xy.y;
    this.pen.span(this.front, ox, oy, this.tip.x, this.tip.y, 3, 1.2, tick * 0.25, 1, this.xy2);
    // the hook
    this.front.disc(this.tip.x, this.tip.y, 2, this.chainRamp[6]!);
    this.fx.glow(this.tip.x, this.tip.y, 5, 255, 90, 120, 0.5);
  }

  /** Constrict: three taut chains from the front nodes into the foe, humming with light while they hold. */
  private drawRoot(tick: number): void {
    const f = this.f;
    if (this.rootUntil <= tick) return;
    const fv = f.foe.view;
    const left = this.rootUntil - tick;
    const tense = clamp01(1 - this.snapAcc / Math.max(1, this.rootCfg?.snap ?? 1));
    for (let i = 0; i < MAX_CHAINS; i++) {
      if (!this.chOn[i]) continue;
      this.nodePos(this.chNode[i]!);
      const ex = fv.x + this.chOffX[i]!;
      const ey = fv.y + this.chOffY[i]!;
      const sag = 1.5 + (1 - tense) * 7 + (left < 24 ? (24 - left) * 0.3 : 0);
      this.pen.span(
        this.front,
        this.xy.x,
        this.xy.y,
        ex,
        ey,
        sag,
        1.4 * (1 - tense) + 0.5,
        tick * 0.3 + i,
        1,
      );
      this.front.disc(ex, ey, 2.2, this.chainRamp[5]!);
      this.fx.glow(ex, ey, 6, 255, 70, 100, 0.4 * tense + 0.15);
    }
  }

  private drawWhips(): void {
    for (let w = 0; w < MAX_WHIPS; w++) {
      const life = this.wLife[w]!;
      if (life <= 0) continue;
      const o = w * WHIP_N;
      // the last few ticks: the chain crumbles from the tip
      const n = life < 24 ? Math.max(2, Math.ceil((life / 24) * WHIP_N)) : WHIP_N;
      for (let k = 0; k < n; k++) {
        this.sx[k] = this.wx[o + k]!;
        this.sy[k] = this.wy[o + k]!;
      }
      this.pen.polyline(this.front, this.sx, this.sy, n);
    }
  }

  private drawCage(tick: number, m: ActiveMove): void {
    const c = this.cage;
    const cfg = this.cageCfg;
    if (!cfg || (!c.on && c.fade === 0)) return;
    const ov = this.cageOv;
    const build = cfg.build;
    const reveal = c.on ? clamp01(c.t / build) : 1;
    // as the cage closes it tightens toward the crush; when it fades after the crush it flashes
    const closing = c.on
      ? clamp01((c.t - cfg.closeFrom) / Math.max(1, cfg.closeTo - cfg.closeFrom))
      : c.crushed
        ? 1
        : 0;
    const R = c.on ? c.r : c.crushed ? cfg.radius[1] : c.r;
    let drawn = 0;
    for (let k = 0; k < SEGS; k++) {
      if (!this.segOn[k] && c.on) continue;
      const a0 = this.segAngle(k) + c.spin;
      const w = CAGE_SEG_W * reveal;
      if (w <= 0.01) continue;
      const arc = R * 2 * w;
      const n = Math.max(2, Math.round(arc / 7));
      for (let i = 0; i < n; i++) {
        const u = ((i + 0.5) / n - 0.5) * 2 * w;
        const a = a0 + u;
        const px = c.cx + Math.cos(a) * R;
        const py = c.cy + Math.sin(a) * R;
        // tangent of the circle
        this.pen.link(ov, px, py, -Math.sin(a), Math.cos(a), i + k, this.segHp[k]! < cfg.hp * 0.4 ? -0.5 : 0);
        drawn++;
      }
      // joint beads between segments, glowing as the crush nears
      const ja = a0 + Math.PI / SEGS;
      const jx = c.cx + Math.cos(ja) * R;
      const jy = c.cy + Math.sin(ja) * R;
      if (reveal > 0.6) {
        ov.disc(jx, jy, 3.2, this.nodeRamp[3]!, 60);
        ov.disc(jx - 0.6, jy - 0.6, 1.6, this.nodeRamp[5]!, 90);
        this.fx.glow(jx, jy, 8 + closing * 6, 255, 60, 100, 0.3 + closing * 0.4);
      }
    }
    if (c.on && closing > 0.8 && tick % 2 === 0)
      this.fx.glow(c.cx, c.cy, R + 10, 255, 60, 90, 0.16 * closing);
    if (!c.on && c.crushed) this.fx.glow(c.cx, c.cy, R + 24, 255, 120, 140, 0.55 * (c.fade / 14));
    void drawn;
    void m;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  layers, debug
   * ---------------------------------------------------------------------------------------------- */

  override renderLayers(_view: ViewRect, _alpha: number, out: RenderLayer[]): void {
    out.push(this.front.layer, this.cageOv.layer, this.fx.layer);
  }

  override debugShapes(out: DebugShape[]): void {
    const c = this.cage;
    if (c.on) {
      const sh = makeFatShape();
      sh.kind = 'point';
      sh.x = c.cx;
      sh.y = c.cy;
      sh.r = c.r;
      out.push({ shape: asShape(sh), color: 0xff3a5aff, label: 'cage' });
    }
    for (let i = 0; i < MAX_CHAINS; i++) {
      if (!this.chOn[i]) continue;
      const fv = this.f.foe.view;
      this.nodePos(this.chNode[i]!);
      const sh = makeFatShape();
      sh.kind = 'line';
      sh.x0 = this.xy.x;
      sh.y0 = this.xy.y;
      sh.x1 = fv.x + this.chOffX[i]!;
      sh.y1 = fv.y + this.chOffY[i]!;
      sh.width = 3;
      out.push({ shape: asShape(sh), color: 0xff5a3aff, label: 'chain' });
    }
  }

  /* --- test / AI access --- */
  get litNodes(): number {
    return this.litCount;
  }
  get rooted(): boolean {
    return this.rootUntil > this.f.tickNo;
  }
  get cageActive(): boolean {
    return this.cage.on;
  }
  nodeLit(n: number): boolean {
    return this.lit[n] === 1;
  }
  get grown(): number {
    return this.grownCells;
  }
  clamp01(v: number): number {
    return clamp(v, 0, 1);
  }
}
