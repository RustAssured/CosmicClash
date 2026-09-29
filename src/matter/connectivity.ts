import { CONN_EVT_CAP, type Body, type WorldPoint } from './body';
import type { WorldCore } from './core';
import { MODE_MECH, detachVelocity, endSpray, extractChunk, sprayCell, type Launch } from './debris';
import { killCell } from './cells';

const MIN_CHUNK_CELLS = 5;
const tmpPt: WorldPoint = { x: 0, y: 0 };
const launch: Launch = { vx: 0, vy: 0, spin: 0 };

/**
 * Connectivity + detachment. Flood-fills from the core anchor over live cells through intact bonds (iterative, int stack,
 * generation-stamped so no clearing pass). Fluid cells never anchor solids (the flood may enter a fluid from a solid, but
 * never leave a fluid into a solid). Everything not reached is an island:
 *   - solid islands with >= MIN_CHUNK_CELLS cells become one rigid tumbling chunk;
 *   - smaller ones and unanchored fluid cells disperse as particles (mass carried).
 * Emits a `detach` matter event per island. Runs in O(live cells).
 */
export function runConnectivity(core: WorldCore, body: Body): void {
  body.connDirty = 0;
  body.lastConnTick = core.tick;
  if (!body.connFull && !body.hasFluid && !core.forceFullConn && localPass(core, body)) {
    // Handled from the changed spots alone (nothing cut off, or only small islands released): no full flood.
    body.anchoredFrac = 1;
    body.connFull = false;
    resetFrontier(body);
    return;
  }
  const map = body.map;
  const w = body.w;
  const n = body.n;
  const mat = map.material;
  const bondR = map.bondR;
  const bondD = map.bondD;
  const stamp = body.stamp;
  const fluid = body.matFluid;

  let gen = body.stampGen + 2;
  if (gen > 0xfffffff0) {
    stamp.fill(0);
    gen = 2;
  }
  body.stampGen = gen;

  const st = core.stack;
  st.clear();
  // --- seeds: live cells of the core disc ---
  const disc = body.coreDiscIdx;
  for (let k = 0; k < disc.length; k++) {
    const c = disc[k]!;
    if (mat[c] !== 0 && stamp[c] !== gen) {
      stamp[c] = gen;
      st.push(c);
    }
  }
  if (st.size === 0) {
    // Core gone: anchor the LARGEST connected mass (a stray cell near the old core must not orphan the rest of the body).
    const best = largestMass(core, body, gen);
    if (best < 0) {
      body.anchoredFrac = 1;
      return;
    }
    gen += 2; // the measuring pass left marks at gen+1: move past them
    body.stampGen = gen;
    stamp[best] = gen;
    st.push(best);
  }
  floodAnchored(body, st, gen);

  // --- islands ---
  const comp = core.stack2;
  const work = core.stack;
  for (let c0 = 0; c0 < n; c0++) {
    if (mat[c0] === 0 || stamp[c0]! >= gen) continue;
    // Flood one component (bonds only), collecting cells into `comp`.
    comp.clear();
    work.clear();
    stamp[c0] = gen + 1;
    work.push(c0);
    while (work.size > 0) {
      const c = work.pop();
      comp.push(c);
      const x = c % w;
      if (x < w - 1 && bondR[c] !== 0 && stamp[c + 1]! < gen) {
        stamp[c + 1] = gen + 1;
        work.push(c + 1);
      }
      if (x > 0 && bondR[c - 1] !== 0 && stamp[c - 1]! < gen) {
        stamp[c - 1] = gen + 1;
        work.push(c - 1);
      }
      if (bondD[c] !== 0 && stamp[c + w]! < gen) {
        stamp[c + w] = gen + 1;
        work.push(c + w);
      }
      if (c >= w && bondD[c - w] !== 0 && stamp[c - w]! < gen) {
        stamp[c - w] = gen + 1;
        work.push(c - w);
      }
    }
    releaseIsland(core, body, comp.data, comp.size, fluid);
  }
  body.anchoredFrac = 1;
  body.connFull = false;
  resetFrontier(body);
}

/** Forget the change frontier (a pass has accounted for everything recorded so far). */
function resetFrontier(body: Body): void {
  body.connSeedN = 0;
  body.connEvtN = 0;
  body.seedGen++;
  if (body.seedGen > 0x7ffffff0) {
    body.seedMark.fill(0);
    body.seedGen = 1;
  }
}

/** Largest number of cells the local search may visit before the full flood is cheaper. */
const LOCAL_BUDGET = 6000;
/** Rings the search may grow around the changed spots. */
const LOCAL_DEPTH = 64;
const SEED_MAX = 4096;
const localQueue = new Int32Array(LOCAL_BUDGET + 8);
/** Union-find over the frontier cells' groups (flow sets), and its per-set pending-work counters. */
const flowParent = new Int32Array(SEED_MAX + 8);
const pending = new Int32Array(SEED_MAX + 8);
const rootPending = new Int32Array(SEED_MAX + 8);
/** Union-find over flow sets that share a removal cluster (island rule). */
const linkParent = new Int32Array(SEED_MAX + 8);
const groupActive = new Int32Array(SEED_MAX + 8);
const groupIsland = new Int32Array(SEED_MAX + 8);
const islandMin = new Int32Array(SEED_MAX + 8);
const clusterFirst = new Int32Array(CONN_EVT_CAP);
const clusterStamp = new Int32Array(CONN_EVT_CAP);
let passId = 0;

function findRoot(par: Int32Array, a: number): number {
  while (par[a] !== a) {
    par[a] = par[par[a]!]!;
    a = par[a]!;
  }
  return a;
}

/**
 * The connectivity pass computed from the changed spots alone; returns false when the full flood is needed.
 *
 * Before the recorded changes the bond graph was connected (the last full pass anchored everything). The changes are removals
 * (cells, bonds); call the live cells beside them the FRONTIER, grouped into CLUSTERS (Body.noteKill/noteBreak: the frontier of
 * one connected removed region, or of removals sharing a frontier cell). Any path of the old graph that crossed a removal
 * entered and left through frontier cells of one cluster, so:
 *   - if the frontier cells of every cluster still reach each other in the new graph, nothing was cut off (the paths can be
 *     re-routed around the removals);
 *   - the same holds after deleting islands that are COMPLETE components (fully explored, no core cell inside), provided every
 *     cluster (and every chain of clusters linked through such islands) leaves exactly one still-growing group: then all the
 *     growing groups belong to one component that the core anchors, and the complete components are the islands.
 * The search grows all frontier cells at once, ring by ring (union-find over the fronts, at most LOCAL_DEPTH rings and
 * LOCAL_BUDGET cells), so a crater rim, a burn front, a crumb knocked loose or a crack that has not cut through is settled
 * within a few rings, while a cut that severs something big (or a spent budget) returns false. Islands are released in the
 * same canonical order as the full flood (ascending by lowest cell, cells sorted), so both paths give identical results.
 */
function localPass(core: WorldCore, body: Body): boolean {
  const map = body.map;
  const w = body.w;
  const mat = map.material;
  const bondR = map.bondR;
  const bondD = map.bondD;
  const label = body.connLabel;
  const seeds = body.connSeed;
  const nSeeds = body.connSeedN;
  let ng = 0;
  for (let k = 0; k < nSeeds; k++) {
    const c = seeds[k]!;
    if (mat[c] === 0 || label[c] !== 0) continue;
    label[c] = ng + 1;
    flowParent[ng] = ng;
    pending[ng] = 1;
    localQueue[ng] = c;
    ng++;
  }
  let result = ng <= 1; // one live frontier cell (or none): nothing can have been cut off
  let tail = ng;
  let islands = false;
  if (!result) {
    let head = 0;
    let checkAt = 2;
    for (let depth = 1; depth <= LOCAL_DEPTH && head < tail && tail < LOCAL_BUDGET; depth++) {
      const ringEnd = tail;
      while (head < ringEnd && tail < LOCAL_BUDGET) {
        const c = localQueue[head++]!;
        const lc = label[c]!;
        pending[lc - 1]!--;
        const x = c % w;
        for (let dir = 0; dir < 4; dir++) {
          let nn: number;
          if (dir === 0) {
            if (x >= w - 1 || bondR[c] === 0) continue;
            nn = c + 1;
          } else if (dir === 1) {
            if (x === 0 || bondR[c - 1] === 0) continue;
            nn = c - 1;
          } else if (dir === 2) {
            if (bondD[c] === 0) continue;
            nn = c + w;
          } else {
            if (c < w || bondD[c - w] === 0) continue;
            nn = c - w;
          }
          const ln = label[nn]!;
          if (ln === 0) {
            label[nn] = lc;
            pending[lc - 1]!++;
            localQueue[tail++] = nn;
          } else if (ln !== lc) {
            const a = findRoot(flowParent, ln - 1);
            const b = findRoot(flowParent, lc - 1);
            if (a !== b) flowParent[a] = b;
          }
        }
      }
      if (depth === checkAt || head >= tail || tail >= LOCAL_BUDGET || depth === LOCAL_DEPTH) {
        checkAt *= 2;
        const verdict = judge(body, ng);
        if (verdict !== 0) {
          result = true;
          islands = verdict === 2;
          break;
        }
      }
    }
  }
  if (result && islands) releaseLocalIslands(core, body, tail);
  for (let k = 0; k < tail; k++) label[localQueue[k]!] = 0;
  return result;
}

/**
 * Judge the search state. 1 = every cluster unified (nothing cut off); 2 = the island rule holds (complete components can be
 * released; their groups are marked in `rootPending`); 0 = undecided or unsafe (run the full flood).
 */
function judge(body: Body, ng: number): number {
  const label = body.connLabel;
  passId++;
  // Groups pending work: a flow set is COMPLETE when nothing of it is left to expand.
  rootPending.fill(0, 0, ng);
  for (let k = 0; k < ng; k++) rootPending[findRoot(flowParent, k)]! += pending[k]!;
  // Every cluster unified?
  let unified = true;
  for (let k = 0; k < ng && unified; k++) {
    const cl = body.clusterOf(localQueue[k]!);
    if (clusterStamp[cl] !== passId) {
      clusterStamp[cl] = passId;
      clusterFirst[cl] = k;
    } else if (findRoot(flowParent, k) !== findRoot(flowParent, clusterFirst[cl]!)) unified = false;
  }
  if (unified) return 1;
  // Island rule. Link the flow sets that share a cluster.
  for (let k = 0; k < ng; k++) {
    linkParent[k] = k;
    groupActive[k] = 0;
    groupIsland[k] = 0;
  }
  passId++;
  for (let k = 0; k < ng; k++) {
    const cl = body.clusterOf(localQueue[k]!);
    const rk = findRoot(flowParent, k);
    if (clusterStamp[cl] !== passId) {
      clusterStamp[cl] = passId;
      clusterFirst[cl] = rk;
    } else {
      const a = findRoot(linkParent, clusterFirst[cl]!);
      const b = findRoot(linkParent, rk);
      if (a !== b) linkParent[a] = b;
    }
  }
  let anyIsland = false;
  for (let r = 0; r < ng; r++) {
    if (findRoot(flowParent, r) !== r) continue;
    const g = findRoot(linkParent, r);
    if (rootPending[r] === 0) {
      groupIsland[g]!++;
      anyIsland = true;
    } else groupActive[g]!++;
  }
  if (!anyIsland) return 0;
  for (let r = 0; r < ng; r++) {
    if (findRoot(flowParent, r) !== r) continue;
    const g = findRoot(linkParent, r);
    if (groupActive[g]! > 1) return 0;
    if (groupIsland[g]! > 0 && groupActive[g] !== 1) return 0;
  }
  // No island may hold a core cell, and the core must exist (else the full flood picks the anchor).
  const disc = body.coreDiscIdx;
  const mat = body.map.material;
  let liveCore = false;
  for (let k = 0; k < disc.length; k++) {
    const c = disc[k]!;
    if (mat[c] === 0) continue;
    liveCore = true;
    const l = label[c]!;
    if (l !== 0 && rootPending[findRoot(flowParent, l - 1)] === 0) return 0;
  }
  return liveCore ? 2 : 0;
}

/** Release every complete component found by the local search, in the canonical order of the full flood. */
function releaseLocalIslands(core: WorldCore, body: Body, tail: number): void {
  const label = body.connLabel;
  const fluid = body.matFluid;
  // Lowest cell index of each complete component.
  islandMin.fill(1 << 30);
  for (let k = 0; k < tail; k++) {
    const c = localQueue[k]!;
    const r = findRoot(flowParent, label[c]! - 1);
    if (rootPending[r] === 0 && c < islandMin[r]!) islandMin[r] = c;
  }
  // Order the complete components by lowest cell (insertion sort: there are few).
  const order = core.stack;
  order.clear();
  for (let k = 0; k < tail; k++) {
    const c = localQueue[k]!;
    const r = findRoot(flowParent, label[c]! - 1);
    if (rootPending[r] === 0 && islandMin[r] === c) {
      // c is the lowest cell of component r: insert (r) keeping ascending order of islandMin.
      let at = order.size;
      order.push(r);
      while (at > 0 && islandMin[order.data[at - 1]!]! > c) {
        order.data[at] = order.data[at - 1]!;
        at--;
      }
      order.data[at] = r;
    }
  }
  const comp = core.stack2;
  for (let i = 0; i < order.size; i++) {
    const r = order.data[i]!;
    comp.clear();
    for (let k = 0; k < tail; k++) {
      const c = localQueue[k]!;
      if (findRoot(flowParent, label[c]! - 1) === r) comp.push(c);
    }
    releaseIsland(core, body, comp.data, comp.size, fluid);
  }
}

/** Seed cell of the biggest bond-connected component of live cells (ties: the first found), or -1 if the body is empty. Marks stamps gen+1. */
function largestMass(core: WorldCore, body: Body, gen: number): number {
  const map = body.map;
  const w = body.w;
  const n = body.n;
  const mat = map.material;
  const bondR = map.bondR;
  const bondD = map.bondD;
  const stamp = body.stamp;
  const work = core.stack2;
  let best = -1;
  let bestSize = 0;
  for (let c0 = 0; c0 < n; c0++) {
    if (mat[c0] === 0 || stamp[c0]! > gen) continue;
    let size = 0;
    work.clear();
    stamp[c0] = gen + 1;
    work.push(c0);
    while (work.size > 0) {
      const c = work.pop();
      size++;
      const x = c % w;
      if (x < w - 1 && bondR[c] !== 0 && stamp[c + 1]! <= gen) {
        stamp[c + 1] = gen + 1;
        work.push(c + 1);
      }
      if (x > 0 && bondR[c - 1] !== 0 && stamp[c - 1]! <= gen) {
        stamp[c - 1] = gen + 1;
        work.push(c - 1);
      }
      if (bondD[c] !== 0 && stamp[c + w]! <= gen) {
        stamp[c + w] = gen + 1;
        work.push(c + w);
      }
      if (c >= w && bondD[c - w] !== 0 && stamp[c - w]! <= gen) {
        stamp[c - w] = gen + 1;
        work.push(c - w);
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = c0;
    }
  }
  return best;
}

function floodAnchored(
  body: Body,
  st: { size: number; push(v: number): void; pop(): number },
  gen: number,
): void {
  const map = body.map;
  const w = body.w;
  const mat = map.material;
  const bondR = map.bondR;
  const bondD = map.bondD;
  const stamp = body.stamp;
  const fluid = body.matFluid;
  while (st.size > 0) {
    const c = st.pop();
    const cf = fluid[mat[c]!]!;
    const x = c % w;
    let nn: number;
    if (x < w - 1 && bondR[c] !== 0) {
      nn = c + 1;
      if (stamp[nn] !== gen && (cf === 0 || fluid[mat[nn]!] === 1)) {
        stamp[nn] = gen;
        st.push(nn);
      }
    }
    if (x > 0 && bondR[c - 1] !== 0) {
      nn = c - 1;
      if (stamp[nn] !== gen && (cf === 0 || fluid[mat[nn]!] === 1)) {
        stamp[nn] = gen;
        st.push(nn);
      }
    }
    if (bondD[c] !== 0) {
      nn = c + w;
      if (stamp[nn] !== gen && (cf === 0 || fluid[mat[nn]!] === 1)) {
        stamp[nn] = gen;
        st.push(nn);
      }
    }
    if (c >= w && bondD[c - w] !== 0) {
      nn = c - w;
      if (stamp[nn] !== gen && (cf === 0 || fluid[mat[nn]!] === 1)) {
        stamp[nn] = gen;
        st.push(nn);
      }
    }
  }
}

/** Turn one unanchored component into a chunk (solids) and/or particles (fluids, tiny remnants). */
function releaseIsland(
  core: WorldCore,
  body: Body,
  cells: Int32Array,
  count: number,
  fluid: Uint8Array,
): void {
  const map = body.map;
  const mat = map.material;
  // Canonical order (ascending cell index): the result must not depend on how the island was discovered.
  cells.subarray(0, count).sort();
  // Partition: solids to the front (stable enough; deterministic).
  let solid = 0;
  for (let k = 0; k < count; k++) {
    if (fluid[mat[cells[k]!]!] === 0) {
      const t = cells[solid]!;
      cells[solid] = cells[k]!;
      cells[k] = t;
      solid++;
    }
  }
  // Centre of mass (world) of the whole island for the launch.
  let mass = 0;
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < count; k++) {
    const c = cells[k]!;
    const x = c % body.w;
    body.cellWorld(x, (c - x) / body.w, tmpPt);
    const cm = body.cellMass(c);
    mass += cm;
    cx += tmpPt.x * cm;
    cy += tmpPt.y * cm;
  }
  if (mass > 0) {
    cx /= mass;
    cy /= mass;
  }
  const rad = Math.sqrt(count / Math.PI);
  detachVelocity(core, body, cx, cy, mass, rad, launch);
  core.emitMatter('detach', cx, cy, mass, body.ownerSlot);

  if (solid >= MIN_CHUNK_CELLS) {
    // Fluid cells first (before solids are extracted their indices are still valid).
    for (let k = solid; k < count; k++) disperseCell(core, body, cells[k]!, launch.vx, launch.vy);
    endSpray(core);
    extractChunk(core, body, cells, solid, launch.vx, launch.vy, launch.spin);
  } else {
    for (let k = 0; k < count; k++) disperseCell(core, body, cells[k]!, launch.vx, launch.vy);
    endSpray(core);
  }
  body.touch(0, 0, 0, 0);
}

/** Remove one cell as dust/gas/liquid particles moving with (vx, vy). */
function disperseCell(core: WorldCore, body: Body, c: number, vx: number, vy: number): void {
  const m = body.map.material[c]!;
  const x = c % body.w;
  body.cellWorld(x, (c - x) / body.w, tmpPt);
  const mass = killCell(body, c);
  sprayCell(core, body, m, tmpPt.x, tmpPt.y, vx * 0.6, vy * 0.6, mass, MODE_MECH);
  body.touch(x, (c - x) / body.w, x, (c - x) / body.w);
}
