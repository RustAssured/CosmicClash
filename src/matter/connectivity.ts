import type { Body, WorldPoint } from './body';
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
    // Core gone: anchor the live cell nearest the core so the body keeps its main mass.
    let best = -1;
    let bd = Infinity;
    for (let c = 0; c < n; c++) {
      if (mat[c] === 0) continue;
      const x = c % w;
      const y = (c - x) / w;
      const d = (x - map.coreX) * (x - map.coreX) + (y - map.coreY) * (y - map.coreY);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    if (best < 0) {
      body.anchoredFrac = 1;
      return;
    }
    stamp[best] = gen;
    st.push(best);
  }
  floodAnchored(body, st, gen);

  // --- islands ---
  const comp = core.stack2;
  const work = core.stack;
  let islands = 0;
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
    islands++;
    releaseIsland(core, body, comp.data, comp.size, fluid);
  }
  void islands;
  body.anchoredFrac = 1;
}

function floodAnchored(body: Body, st: { size: number; push(v: number): void; pop(): number }, gen: number): void {
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
function releaseIsland(core: WorldCore, body: Body, cells: Int32Array, count: number, fluid: Uint8Array): void {
  const map = body.map;
  const mat = map.material;
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
    const solidMass = mass;
    void solidMass;
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
