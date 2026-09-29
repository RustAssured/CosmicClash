import { Rng, clamp, createMatterMap, type MatterMap, type StageLighting, type TitanDef } from '@/contracts';
import { ArtCanvas, buildLitRamps, type ShadeParams } from './canvas';
import { linkIndex, rasterLink, RIVET_OFFSET } from './chainLink';
import { keepLargestComponent } from './field';
import { fbm, hash01 } from './noise';

/**
 * THE NEXUS — a crimson graph. A faceted violet/ice crystal hub sits in a collar of hardened chain; six spokes run out to an
 * inner ring of nodes, diagonals to an outer ring, and a few open outer arcs leave loose chain ends. Chains are drawn link by link
 * (a face-on link is a ring with a real hole, the next one is seen edge-on as a bar), nodes are faceted crimson beads with a
 * white-hot core in a riveted socket, and thin sinew filaments hang off the outer nodes. The graph is deliberately sparse: the
 * void between chains is what makes it a network, and chains are the ONLY bonds between nodes, so cutting one isolates a
 * sub-graph (the failure mode). Growth room is left around the intact body.
 */

export interface NexusNode {
  x: number;
  y: number;
  r: number;
  /** 0 = hub, 1 = inner ring, 2 = outer ring. */
  ring: 0 | 1 | 2;
}

export interface NexusEdge {
  a: number;
  b: number;
  /** Flat polyline [x, y, …] in map cells, from node a's socket to node b's socket, every ~2 px. */
  pts: number[];
  len: number;
}

export interface NexusRig {
  /** Map cell of the hub (also the core). */
  hub: { x: number; y: number; r: number };
  /** Index 0 is the hub. */
  nodes: NexusNode[];
  edges: NexusEdge[];
  /** Sinew filaments hanging from node `from`: flat polylines [x, y, …]. */
  tassels: { from: number; pts: number[] }[];
  /** Where new nodes may bud (map cells) and the outward direction there. */
  buds: { x: number; y: number; nx: number; ny: number; from: number }[];
  ids: {
    crystal: number;
    hubcore: number;
    chain: number;
    node: number;
    nodecore: number;
    lattice: number;
    deadnode: number;
  };
}

interface NodeSpec {
  a: number;
  d: number;
  r: number;
  ring: 1 | 2;
}
interface P {
  centre: [number, number];
  hub: { r: number; coreR: number };
  nodes: NodeSpec[];
  edges: [number, number][];
  bow: number;
  tassels: number;
  buds: number;
}

const params = (def: TitanDef): P => def.art.params as unknown as P;

const matId = (def: TitanDef, key: string): number => {
  const i = def.materials.findIndex((m) => m.key === key);
  if (i < 0) throw new Error(`nexus: material '${key}' missing`);
  return i + 1;
};

const DEG = Math.PI / 180;
const SOCKET = 2.6;

export function buildNexusRig(def: TitanDef, seed: number): NexusRig {
  const p = params(def);
  const rng = new Rng(seed ^ 0x2e805);
  const [cx, cy] = p.centre;
  const nodes: NexusNode[] = [{ x: cx, y: cy, r: p.hub.r, ring: 0 }];
  for (const n of p.nodes) {
    const a = (n.a + rng.range(-1.5, 1.5)) * DEG;
    const d = n.d + rng.range(-1.2, 1.2);
    nodes.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, r: n.r, ring: n.ring });
  }
  const edges: NexusEdge[] = [];
  p.edges.forEach(([ia, ib], k) => {
    const A = nodes[ia]!;
    const B = nodes[ib]!;
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const dl = Math.hypot(dx, dy) || 1;
    const nx = -dy / dl;
    const ny = dx / dl;
    // a gentle bow, alternating sides so the graph looks hand-strung rather than ruled
    const bow = p.bow * (k % 2 === 0 ? 1 : -1) * (0.6 + 0.8 * hash01(ia, ib, seed & 0xffff));
    const mx = (A.x + B.x) / 2 + nx * bow * 2;
    const my = (A.y + B.y) / 2 + ny * bow * 2;
    const ra = A.r + (ia === 0 ? 3 : SOCKET);
    const rb = B.r + (ib === 0 ? 3 : SOCKET);
    // flatten the quadratic bezier densely, then keep the part outside both sockets, resampled every 2 px
    const dense: number[] = [];
    const N = 240;
    for (let s = 0; s <= N; s++) {
      const t = s / N;
      const u = 1 - t;
      dense.push(u * u * A.x + 2 * u * t * mx + t * t * B.x, u * u * A.y + 2 * u * t * my + t * t * B.y);
    }
    const pts: number[] = [];
    let acc = 0;
    let len = 0;
    let lastX = NaN;
    let lastY = NaN;
    for (let s = 0; s <= N; s++) {
      const x = dense[s * 2]!;
      const y = dense[s * 2 + 1]!;
      const inA = Math.hypot(x - A.x, y - A.y) < ra;
      const inB = Math.hypot(x - B.x, y - B.y) < rb;
      if (inA || inB) continue;
      if (Number.isNaN(lastX)) {
        pts.push(x, y);
      } else {
        acc += Math.hypot(x - lastX, y - lastY);
        len += Math.hypot(x - lastX, y - lastY);
        if (acc >= 2) {
          pts.push(x, y);
          acc = 0;
        }
      }
      lastX = x;
      lastY = y;
    }
    if (pts.length >= 4) {
      const lx = pts[pts.length - 2]!;
      const ly = pts[pts.length - 1]!;
      if (Math.hypot(lx - lastX, ly - lastY) > 0.5) pts.push(lastX, lastY);
    }
    edges.push({ a: ia, b: ib, pts, len });
  });
  // sinew filaments: random walks leaving the outer (and a few inner) nodes outward
  const tassels: NexusRig['tassels'] = [];
  for (let t = 0; t < p.tassels; t++) {
    const ni = 1 + (t % nodes.length === 0 ? 0 : (t * 5) % (nodes.length - 1));
    const N = nodes[ni]!;
    const outer = N.ring === 2;
    const base = Math.atan2(N.y - cy, N.x - cx) + rng.range(-0.7, 0.7);
    let x = N.x + Math.cos(base) * (N.r + SOCKET - 1);
    let y = N.y + Math.sin(base) * (N.r + SOCKET - 1);
    let h = base;
    const path: number[] = [x, y];
    const len = Math.floor(rng.range(outer ? 5 : 3, outer ? 10 : 6));
    for (let s = 0; s < len; s++) {
      h += rng.range(-0.22, 0.22);
      x += Math.cos(h) * 1.6;
      y += Math.sin(h) * 1.6;
      path.push(x, y);
    }
    tassels.push({ from: ni, pts: path });
  }
  const buds: NexusRig['buds'] = [];
  for (let i = 0; i < Math.min(p.buds, 6); i++) {
    const N = nodes[7 + i];
    if (!N) break;
    const ang = Math.atan2(N.y - cy, N.x - cx);
    const nx = Math.cos(ang);
    const ny = Math.sin(ang);
    buds.push({ x: N.x + nx * (N.r + 12), y: N.y + ny * (N.r + 12), nx, ny, from: 7 + i });
  }
  return {
    hub: { x: cx, y: cy, r: p.hub.r },
    nodes,
    edges,
    tassels,
    buds,
    ids: {
      crystal: matId(def, 'crystal'),
      hubcore: matId(def, 'hubcore'),
      chain: matId(def, 'chain'),
      node: matId(def, 'node'),
      nodecore: matId(def, 'nodecore'),
      lattice: matId(def, 'lattice'),
      deadnode: matId(def, 'deadnode'),
    },
  };
}

// Key light for the hand-shaded gems and bezels (upper left, toward the camera); the chain links share it via chainLink.ts.
const LX = -0.55;
const LY = -0.7;
const LZ = 0.62;

/** Distance to a regular polygon of `n` sides (apothem measure) rotated by `rot`: the max of the face-normal projections. */
const polyDist = (dx: number, dy: number, rot: number, n: number): number => {
  let best = -1e9;
  for (let k = 0; k < n; k++) {
    const a = rot + (k * Math.PI * 2) / n;
    const d = dx * Math.cos(a) + dy * Math.sin(a);
    if (d > best) best = d;
  }
  return best;
};

interface Ctx {
  cv: ArtCanvas;
  rig: NexusRig;
  W: number;
  H: number;
  seedA: number;
  /** Stage-lit ramps by material id. */
  ramps: number[][];
}

/**
 * Stamp one link into the canvas (colour overrides, hand-shaded by `rasterLink` so painted and animated chains match) and, for a
 * face-on link, note where its rivets go.
 */
function paintLink(
  c: Ctx,
  x: number,
  y: number,
  tx: number,
  ty: number,
  ring: boolean,
  toneBias: number,
  rivets: number[],
): void {
  const { cv, W, rig } = c;
  const rp = c.ramps[rig.ids.chain]!;
  const H = c.H;
  rasterLink(x, y, tx, ty, ring, (px, py, light) => {
    if (px < 0 || py < 0 || px >= W || py >= H) return;
    const i = py * W + px;
    cv.mat[i] = rig.ids.chain;
    cv.relief[i] = 3;
    cv.over[i] = rp[linkIndex(light, toneBias, rp.length)]!;
  });
  if (ring) {
    for (const s of [-1, 1]) {
      rivets.push(Math.round(x + tx * s * RIVET_OFFSET), Math.round(y + ty * s * RIVET_OFFSET));
    }
  }
}

function paintEdge(c: Ctx, e: NexusEdge, k: number, rivets: number[]): void {
  const { pts } = e;
  if (pts.length < 4) return;
  const n = Math.max(2, Math.round(e.len / 7));
  const step = e.len / n;
  // walk the polyline, dropping a link every `step` px of arc length
  let acc = 0;
  let next = step / 2;
  let link = 0;
  for (let s = 0; s + 3 < pts.length; s += 2) {
    const x0 = pts[s]!;
    const y0 = pts[s + 1]!;
    const x1 = pts[s + 2]!;
    const y1 = pts[s + 3]!;
    const seg = Math.hypot(x1 - x0, y1 - y0);
    if (seg < 1e-6) continue;
    while (next <= acc + seg && link < n) {
      const f = (next - acc) / seg;
      const tx = (x1 - x0) / seg;
      const ty = (y1 - y0) / seg;
      const tone = (link % 2 === 0 ? 0.25 : -0.25) + (hash01(k, link, c.seedA + 3) - 0.5) * 0.4;
      paintLink(c, x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, tx, ty, link % 2 === 0, tone, rivets);
      link++;
      next += step;
    }
    acc += seg;
  }
}

/** Facet lighting: the pyramid facet whose outward direction is `ang` (slope `slope`) against the key light, −0.5 … 0.95. */
function facetLight(ang: number, slope: number): number {
  const nx = Math.cos(ang) * slope;
  const ny = Math.sin(ang) * slope;
  const l = Math.sqrt(nx * nx + ny * ny + 1);
  return (nx * LX + ny * LY + LZ) / l;
}

/** Which of `n` equal sectors (centred on `rot + k·2π/n`) the angle `th` falls in, and the distance in px to the nearest rib. */
function sectorOf(th: number, rot: number, n: number, r: number): { k: number; rib: number } {
  const w = (Math.PI * 2) / n;
  const a = th - rot + w / 2;
  const k = Math.floor((((a / w) % n) + n) % n);
  const off = Math.abs((((a % w) + w) % w) - w / 2);
  return { k, rib: (w / 2 - off) * r };
}

/**
 * Nodes: a faceted crimson gem (six crown facets around a flat table, a white-hot core) set in a hexagonal bezel of forged chain
 * metal. Hand-shaded per facet — crisp flat colours, lit ribs — so the cut reads at any size; the bezel is pinned with rivets.
 */
function paintNodes(c: Ctx): void {
  const { cv, W, rig } = c;
  const bead = c.ramps[rig.ids.node]!;
  const core = c.ramps[rig.ids.nodecore]!;
  const chain = c.ramps[rig.ids.chain]!;
  const SIDES = 6;
  for (let ni = 1; ni < rig.nodes.length; ni++) {
    const N = rig.nodes[ni]!;
    const R = N.r;
    const rot = (hash01(ni, 7, c.seedA) - 0.5) * 0.5;
    for (let y = Math.floor(N.y - R - SOCKET - 2); y <= Math.ceil(N.y + R + SOCKET + 2); y++) {
      for (let x = Math.floor(N.x - R - SOCKET - 2); x <= Math.ceil(N.x + R + SOCKET + 2); x++) {
        if (x < 0 || y < 0 || x >= W || y >= c.H) continue;
        const dx = x + 0.5 - N.x;
        const dy = y + 0.5 - N.y;
        const r = Math.hypot(dx, dy);
        const i = y * W + x;
        // polygon apothem is smaller than the circumradius: scale so the bead fills roughly the same disc
        const dp = polyDist(dx, dy, rot, SIDES);
        const th = Math.atan2(dy, dx);
        const sec = sectorOf(th, rot, SIDES, r);
        if (dp < R * 0.97) {
          const f = dp / (R * 0.97);
          cv.relief[i] = 5 + (R - dp) * 1.2;
          if (r < R * 0.34) {
            cv.mat[i] = rig.ids.nodecore;
            const q = r / (R * 0.34);
            cv.over[i] = core[Math.min(core.length - 1, q < 0.4 ? 4 : q < 0.68 ? 3 : q < 0.9 ? 2 : 1)]!;
            continue;
          }
          cv.mat[i] = rig.ids.node;
          let idx: number;
          if (f < 0.46) {
            // the table: flat and bright, warmer toward the core
            idx = 4.1 + (0.46 - f) * 2.6;
          } else {
            const lit = facetLight(rot + sec.k * ((Math.PI * 2) / SIDES), 0.95);
            idx = 1.5 + (lit + 0.3) * 3.3 + (hash01(sec.k, ni, c.seedA + 21) - 0.5) * 0.6;
            if (f > 0.86) idx -= 0.9; // the girdle falls into shadow
            if (sec.rib < 0.55 && f > 0.5) idx += lit > 0.25 ? 0.9 : -1.3; // ribs: bright on lit facets, dark on the others
          }
          cv.over[i] = bead[clamp(Math.round(idx), 0, bead.length - 2)]!;
        } else if (dp < R + SOCKET && dp >= R * 0.9) {
          // the bezel
          cv.mat[i] = rig.ids.chain;
          cv.relief[i] = 3.4;
          const lit = Math.cos(th - Math.atan2(LY, LX));
          const outer = dp > R + SOCKET - 0.9;
          cv.over[i] = chain[clamp(Math.round(3.4 + lit * 1.8 - (outer ? 1.5 : 0)), 0, chain.length - 1)]!;
        }
      }
    }
    // rivets on the bezel corners and a hard glint on the brightest upper-left facets
    for (let k = 0; k < SIDES; k++) {
      const ang = rot + Math.PI / SIDES + (k * Math.PI * 2) / SIDES;
      const rx = Math.round(N.x + (Math.cos(ang) * (R + SOCKET * 0.5)) / Math.cos(Math.PI / SIDES));
      const ry = Math.round(N.y + (Math.sin(ang) * (R + SOCKET * 0.5)) / Math.cos(Math.PI / SIDES));
      const i = ry * W + rx;
      if (cv.mat[i] === rig.ids.chain) cv.over[i] = chain[chain.length - 2]!;
    }
    for (const [gx, gy, k] of [
      [N.x - R * 0.5, N.y - R * 0.46, 2],
      [N.x - R * 0.36, N.y - R * 0.6, 1],
    ] as const) {
      const i = Math.round(gy) * W + Math.round(gx);
      if (cv.mat[i] === rig.ids.node) cv.over[i] = bead[bead.length - k]!;
    }
  }
}

/**
 * The hub: a cut gem drawn as a wireframe crystal. Deep violet and magenta facets (eight-sided crown, table split into eight
 * triangles that meet at a white-hot heart) with bright ice-blue wire ribs and a lit girdle, so it reads as a translucent
 * solid outlined in light. Sits in an octagonal collar of chain metal that the six spokes clamp onto.
 */
function paintHub(c: Ctx): void {
  const { cv, W, rig } = c;
  const H = rig.hub;
  const R = H.r;
  const cr = c.ramps[rig.ids.crystal]!;
  const hc = c.ramps[rig.ids.hubcore]!;
  const ch = c.ramps[rig.ids.chain]!;
  const rot = Math.PI / 8;
  const tableF = 0.56;
  for (let y = Math.floor(H.y - R - 5); y <= Math.ceil(H.y + R + 5); y++) {
    for (let x = Math.floor(H.x - R - 5); x <= Math.ceil(H.x + R + 5); x++) {
      const dx = x + 0.5 - H.x;
      const dy = y + 0.5 - H.y;
      const r = Math.hypot(dx, dy);
      const i = y * W + x;
      const d8 = polyDist(dx, dy, rot, 8);
      const th = Math.atan2(dy, dx);
      if (d8 >= R) {
        if (d8 < R + 3.4) {
          cv.mat[i] = rig.ids.chain;
          cv.relief[i] = 4;
          const lit = Math.cos(th - Math.atan2(LY, LX));
          cv.over[i] = ch[clamp(Math.round(3.4 + lit * 1.9 - (d8 > R + 2.4 ? 1.5 : 0)), 0, ch.length - 1)]!;
        }
        continue;
      }
      const f = d8 / R;
      const sec = sectorOf(th, rot, 8, r);
      const facetAng = rot + sec.k * (Math.PI / 4);
      cv.relief[i] = f > tableF ? 6 + (1 - f) * 14 : 16;
      if (r < 4.4) {
        cv.mat[i] = rig.ids.hubcore;
        cv.over[i] = hc[Math.min(hc.length - 1, r < 1.5 ? 4 : r < 2.6 ? 3 : r < 3.6 ? 2 : 1)]!;
        continue;
      }
      cv.mat[i] = rig.ids.crystal;
      const lit = facetLight(facetAng, 0.85);
      let idx: number;
      if (f > tableF) {
        idx = 1.5 + (lit + 0.5) * 2.5 + (f - 0.78) * 1.2;
      } else {
        // the table: triangles alternately lit and shadowed, cooling toward ice around the heart
        const alt = sec.k % 2 === 0 ? 0.8 : -0.5;
        idx = 2.7 + lit * 0.9 + alt + (tableF - f) * 3.4;
      }
      // a refraction band through the lit crown facets
      const band = (((x + y * 0.7) % 7) + 7) % 7;
      if (f > tableF && lit > 0.15 && band < 1.2) idx += 1;
      let col = cr[clamp(Math.round(idx), 0, 5)]!;
      // wireframe: ribs between facets and around the table, brighter on the lit side
      const rib = sec.rib < 0.6 && r > 4.4;
      const tableRim = Math.abs(f - tableF) * R < 0.6;
      if (rib || tableRim) col = cr[lit > -0.05 ? 6 : 5]!;
      if (d8 > R - 1.1) col = cr[lit > 0.1 ? 7 : 2]!; // the girdle: bright on the lit side, dark on the far side
      cv.over[i] = col;
    }
  }
  // hard glints on the upper-left crown
  for (const [gx, gy] of [
    [H.x - R * 0.5, H.y - R * 0.62],
    [H.x - R * 0.3, H.y - R * 0.74],
  ] as const) {
    const i = Math.round(gy) * W + Math.round(gx);
    if (cv.mat[i] === rig.ids.crystal) cv.over[i] = cr[7]!;
  }
}

function paintTassels(c: Ctx): void {
  const { cv, W, rig } = c;
  for (const { pts: path } of rig.tassels) {
    for (let s = 0; s + 3 < path.length; s += 2) {
      const ax = path[s]!;
      const ay = path[s + 1]!;
      const bx = path[s + 2]!;
      const by = path[s + 3]!;
      const steps = Math.ceil(Math.hypot(bx - ax, by - ay) * 2);
      const t = s / path.length;
      const hw = 1.25 * (1 - 0.6 * t);
      for (let q = 0; q <= steps; q++) {
        const x = ax + ((bx - ax) * q) / Math.max(1, steps);
        const y = ay + ((by - ay) * q) / Math.max(1, steps);
        for (let yy = Math.floor(y - hw); yy <= Math.ceil(y + hw); yy++)
          for (let xx = Math.floor(x - hw); xx <= Math.ceil(x + hw); xx++) {
            if (xx < 0 || yy < 0 || xx >= W || yy >= c.H) continue;
            if (Math.hypot(xx + 0.5 - x, yy + 0.5 - y) > hw + 0.15) continue;
            const i = yy * W + xx;
            if (cv.mat[i] !== 0) continue;
            cv.mat[i] = rig.ids.lattice;
            cv.relief[i] = 2.2;
            cv.tone[i] = 0.4 + (hash01(xx, yy, c.seedA + 9) - 0.5) * 0.8;
          }
      }
    }
    // a little bead on the tip
    const tx = path[path.length - 2]!;
    const ty = path[path.length - 1]!;
    for (let yy = Math.floor(ty - 1.6); yy <= Math.ceil(ty + 1.6); yy++)
      for (let xx = Math.floor(tx - 1.6); xx <= Math.ceil(tx + 1.6); xx++) {
        if (xx < 0 || yy < 0 || xx >= W || yy >= c.H) continue;
        if (Math.hypot(xx + 0.5 - tx, yy + 0.5 - ty) > 1.6) continue;
        const i = yy * W + xx;
        if (cv.mat[i] === 0 || cv.mat[i] === rig.ids.lattice) {
          cv.mat[i] = rig.ids.lattice;
          cv.relief[i] = 4.5;
          cv.tone[i] = 1.6;
        }
      }
  }
}

export function paintNexus(
  def: TitanDef,
  seed: number,
  lighting: StageLighting,
): { map: MatterMap; rig: NexusRig } {
  const rig = buildNexusRig(def, seed);
  const ids = rig.ids;
  const W = def.art.w;
  const H = def.art.h;
  const cv = new ArtCanvas(W, H);
  const ramps = buildLitRamps(def.materials, lighting, 0.9);
  const c: Ctx = { cv, rig, W, H, seedA: (seed & 0xfff) + 733, ramps };
  const rivets: number[] = [];

  rig.edges.forEach((e, k) => paintEdge(c, e, k, rivets));
  paintNodes(c);
  paintHub(c);
  paintTassels(c);
  keepLargestComponent(cv.mat, W, H);
  cv.invalidate();
  // rivets: a bright dot at the pinned ends of the face-on links
  const chainR = ramps[ids.chain]!;
  for (let k = 0; k + 1 < rivets.length; k += 2) {
    const i = rivets[k + 1]! * W + rivets[k]!;
    if (cv.mat[i] === ids.chain) cv.over[i] = chainR[chainR.length - 2]!;
  }
  for (let i = 0; i < W * H; i++) if (cv.mat[i] === ids.lattice && cv.relief[i] === 0) cv.relief[i] = 2;

  const shade: (Partial<ShadeParams> | undefined)[] = [];
  shade[ids.lattice] = { contrast: 1.2, dither: 0.4, ao: 0.3, rim: 0.6, outline: 0.4 };
  const colors = cv.render({ ramps, params: shade, lighting, rimMix: 0.25 });
  paintTasselFinish(c, colors, ramps);

  const map = createMatterMap(W, H);
  cv.writeTo(map, colors, (m) =>
    m === ids.chain
      ? 132
      : m === ids.crystal
        ? 118
        : m === ids.hubcore
          ? 200
          : m === ids.lattice
            ? 70
            : m === ids.nodecore
              ? 170
              : 128,
  );
  map.coreX = Math.round(rig.hub.x);
  map.coreY = Math.round(rig.hub.y);
  map.coreRadius = def.art.coreRadius;
  return { map, rig };
}

/** Sinew: pink filaments with a glinting tip. */
function paintTasselFinish(c: Ctx, colors: Uint32Array, ramps: number[][]): void {
  const { cv, W, rig } = c;
  const lat = ramps[rig.ids.lattice]!;
  for (let y = 1; y < cv.h - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (cv.mat[i] !== rig.ids.lattice) continue;
      const sparkle = hash01(x, y, 4747) > 0.86 ? 1 : 0;
      const k = clamp(
        2 + (cv.tone[i]! > 1 ? 2 : 0) + sparkle + (fbm(x * 0.4, y * 0.4, 9, 2) > 0 ? 1 : 0),
        1,
        lat.length - 1,
      );
      colors[i] = lat[Math.round(k)]!;
    }
}

/** Which part of the graph every solid cell belongs to (for liveness tests, darkening and growth): built once per body. */
export interface NexusGroups {
  /** Per cell: node index (0 = hub) as `n`, edge index as `nodes + e`, or −1. Sinew belongs to the node it hangs from. */
  of: Int16Array;
  nodeCells: Int32Array[];
  edgeCells: Int32Array[];
}

export function groupNexusCells(map: MatterMap, rig: NexusRig): NexusGroups {
  const W = map.w;
  const H = map.h;
  const nn = rig.nodes.length;
  const ne = rig.edges.length;
  const of = new Int16Array(W * H).fill(-1);
  const best = new Float32Array(W * H).fill(1e9);
  // nodes (and the hub) claim everything inside their bezel first
  for (let n = 0; n < nn; n++) {
    const N = rig.nodes[n]!;
    const R = N.r + (n === 0 ? 3.6 : SOCKET + 1.3);
    for (let y = Math.max(0, Math.floor(N.y - R - 1)); y <= Math.min(H - 1, Math.ceil(N.y + R + 1)); y++)
      for (let x = Math.max(0, Math.floor(N.x - R - 1)); x <= Math.min(W - 1, Math.ceil(N.x + R + 1)); x++) {
        const i = y * W + x;
        if (map.material[i] === 0) continue;
        const d = Math.hypot(x + 0.5 - N.x, y + 0.5 - N.y);
        if (d < R && d < best[i]!) {
          best[i] = d;
          of[i] = n;
        }
      }
  }
  const claimed = of.slice();
  const near = (pts: number[], x: number, y: number): number => {
    let d = 1e9;
    for (let s = 0; s + 3 < pts.length; s += 2) {
      const ax = pts[s]!;
      const ay = pts[s + 1]!;
      const vx = pts[s + 2]! - ax;
      const vy = pts[s + 3]! - ay;
      const px = x - ax;
      const py = y - ay;
      const t = clamp((px * vx + py * vy) / (vx * vx + vy * vy || 1), 0, 1);
      const dd = Math.hypot(px - vx * t, py - vy * t);
      if (dd < d) d = dd;
    }
    return d;
  };
  // sinew, then chains: nearest polyline within reach
  for (const t of rig.tassels) {
    const bx0 = Math.floor(Math.min(...t.pts.filter((_, k) => k % 2 === 0)) - 3);
    const bx1 = Math.ceil(Math.max(...t.pts.filter((_, k) => k % 2 === 0)) + 3);
    const by0 = Math.floor(Math.min(...t.pts.filter((_, k) => k % 2 === 1)) - 3);
    const by1 = Math.ceil(Math.max(...t.pts.filter((_, k) => k % 2 === 1)) + 3);
    for (let y = Math.max(0, by0); y <= Math.min(H - 1, by1); y++)
      for (let x = Math.max(0, bx0); x <= Math.min(W - 1, bx1); x++) {
        const i = y * W + x;
        if (map.material[i] !== rig.ids.lattice || claimed[i] !== -1) continue;
        const d = near(t.pts, x + 0.5, y + 0.5);
        if (d < 2.6 && d < best[i]!) {
          best[i] = d;
          of[i] = t.from;
        }
      }
  }
  rig.edges.forEach((e, k) => {
    const pts = e.pts;
    if (pts.length < 4) return;
    let x0 = 1e9;
    let x1 = -1e9;
    let y0 = 1e9;
    let y1 = -1e9;
    for (let s = 0; s < pts.length; s += 2) {
      x0 = Math.min(x0, pts[s]!);
      x1 = Math.max(x1, pts[s]!);
      y0 = Math.min(y0, pts[s + 1]!);
      y1 = Math.max(y1, pts[s + 1]!);
    }
    for (let y = Math.max(0, Math.floor(y0 - 6)); y <= Math.min(H - 1, Math.ceil(y1 + 6)); y++)
      for (let x = Math.max(0, Math.floor(x0 - 6)); x <= Math.min(W - 1, Math.ceil(x1 + 6)); x++) {
        const i = y * W + x;
        if (map.material[i] !== rig.ids.chain || claimed[i] !== -1) continue;
        const d = near(pts, x + 0.5, y + 0.5);
        if (d < 6 && d < best[i]!) {
          best[i] = d;
          of[i] = nn + k;
        }
      }
  });
  const counts = new Int32Array(nn + ne);
  for (let i = 0; i < W * H; i++) if (of[i]! >= 0) counts[of[i]!]!++;
  const lists: Int32Array[] = [];
  for (let g = 0; g < nn + ne; g++) lists.push(new Int32Array(counts[g]!));
  const fill = new Int32Array(nn + ne);
  for (let i = 0; i < W * H; i++) {
    const g = of[i]!;
    if (g >= 0) lists[g]![fill[g]!++] = i;
  }
  return { of, nodeCells: lists.slice(0, nn), edgeCells: lists.slice(nn) };
}
