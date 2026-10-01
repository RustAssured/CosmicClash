import { CellFlag, MAX_BODY_DIM, MS_PER_TICK } from '@/contracts';
import { CONN_NOW, type Body, type WorldPoint } from './body';
import { breakBondD, breakBondR } from './cells';
import type { WorldCore } from './core';
import type { Launch } from './debris';
import { localToWorldF } from './dmg';

/**
 * WOUNDS — "damage may count instantly, separation takes time" (SLICE_PLAN §6, D1).
 *
 * A heavy blow opens a WOUND: its contact point, launch direction, energy and the world tick at which its matter shears. The
 * matter the blow frees is not removed at once: it is HELD in the body as SLABS — pieces partitioned along the weakest bonds
 * (grain seams), outlined by HAIRLINE bonds (bond byte 1: still bonded for connectivity, drawn as a fissure from the impact
 * frame on) and tagged in `map.detached` with their slab slot. Held slabs are connectivity anchors (an island that is held
 * does not fall off). Each slab shears at its own tick: its boundary bonds are severed, the connectivity pass releases it,
 * and `woundLaunch` gives it the wound's momentum (same speed for every slab of a wound along the launch direction, a lateral
 * fan, spin from the lever arm about its own centre of mass). Mass never leaves the cells before the shear, so the ledger is
 * untouched: the held mass simply goes to chunks (or, for fluids, particles) one slab at a time.
 *
 * Timing: the shear begins SHEAR_TARGET_MS after the impact frame in WALL time; the hit-stop (`DamageEvent.hitstop`, during
 * which the world is not ticked) counts toward it, so a heavy blow with a long hit-stop shears on its first world tick.
 */

export const MAX_WOUNDS = 8;
/** Slab slots per body; slot s (1..MAX_SLABS) is the tag written into `map.detached` (a byte). */
export const MAX_SLABS = 250;
/** The bond byte of a hairline crack: still connected, but drawn as a fissure and severed when its slab shears. */
export const HAIRLINE = 1;
/** Ticks after a blow during which detaching matter belongs to its wound. */
export const WOUND_WINDOW = 90;
/** When a wound's slabs begin to shear, in wall milliseconds after the impact frame (hit-stop included). */
export const SHEAR_TARGET_MS = 140;
/** Islands (in a wound window) larger than this (cells) are split and released over several ticks instead of in one piece. */
export const STAGGER_MIN = 40;
/** Islands larger than this (or 25 % of the body) are split even without a recent blow. */
export const BIG_ISLAND = 1500;

export const SLAB_FREE = 0;
export const SLAB_HELD = 1;
export const SLAB_RELEASING = 2;

/** Shear schedule horizon (ticks, power of two). */
const SCHED = 64;
const SCHED_MASK = SCHED - 1;
/** At most this share of a wound's held mass shears on any one tick (several small pieces may share a tick). */
export const SHED_PER_TICK = 0.08;

/** Per-body wound and slab book (all of it is simulation state and hashed). */
export class WoundBook {
  /* ---- wounds (ring) ---- */
  readonly tick = new Int32Array(MAX_WOUNDS).fill(-1_000_000);
  /** Contact point, body-local float cells (it follows the body as it is knocked away). */
  readonly lx = new Float32Array(MAX_WOUNDS);
  readonly ly = new Float32Array(MAX_WOUNDS);
  /** Unit launch direction (world). */
  readonly dx = new Float32Array(MAX_WOUNDS);
  readonly dy = new Float32Array(MAX_WOUNDS);
  readonly energy = new Float32Array(MAX_WOUNDS);
  readonly sourceMass = new Float32Array(MAX_WOUNDS);
  /** World tick at which the wound's slabs begin to shear. */
  readonly shear = new Int32Array(MAX_WOUNDS);
  /** Launch speed of the wound's slabs (px/s); 0 until the first slab of the wound is held or released. */
  readonly speed = new Float32Array(MAX_WOUNDS);
  /** Slow-cut (FRACTURE) edges of this wound still waiting to be severed. */
  readonly pending = new Int32Array(MAX_WOUNDS);
  /** Mass this wound has held so far (sets its per-tick shedding budget). */
  readonly mass = new Float64Array(MAX_WOUNDS);
  /** Pieces a hold of this wound is cut into (the damage type's grain: a shear frees few big slabs, a crater many blocks). */
  readonly grain = new Uint8Array(MAX_WOUNDS).fill(16);
  next = 0;

  /** Mass scheduled to shear on each upcoming tick (ring by tick & SCHED_MASK; `schedTick` says which tick a slot holds). */
  readonly schedMass = new Float64Array(SCHED);
  readonly schedTick = new Int32Array(SCHED).fill(-1);

  /* ---- slabs (index 1..MAX_SLABS) ---- */
  readonly state = new Uint8Array(MAX_SLABS + 1);
  readonly woundOf = new Int8Array(MAX_SLABS + 1);
  readonly shearAt = new Int32Array(MAX_SLABS + 1);
  readonly start = new Int32Array(MAX_SLABS + 1);
  readonly count = new Int32Array(MAX_SLABS + 1);
  /** Cell lists of the slabs (ranges `start..start+count`). */
  readonly cells: Int32Array;
  top = 0;
  /** Slabs not FREE (held or releasing). */
  held = 0;

  constructor(n: number) {
    this.cells = new Int32Array(n);
  }

  reset(): void {
    this.tick.fill(-1_000_000);
    this.grain.fill(16);
    this.speed.fill(0);
    this.pending.fill(0);
    this.mass.fill(0);
    this.schedMass.fill(0);
    this.schedTick.fill(-1);
    this.next = 0;
    this.state.fill(0);
    this.count.fill(0);
    this.top = 0;
    this.held = 0;
  }
}

/* ------------------------------------------------------------------------------------------------ *
 *  Wounds
 * ------------------------------------------------------------------------------------------------ */

const pt: WorldPoint = { x: 0, y: 0 };

/** World ticks from the blow to its first shear: SHEAR_TARGET_MS of wall time minus the hit-stop (at least one tick). */
export function shearDelay(hitstop: number): number {
  return Math.max(1, Math.round(SHEAR_TARGET_MS / MS_PER_TICK) - Math.max(0, Math.round(hitstop)));
}

/**
 * Open a wound for a blow applied during world tick `core.tick` (the next world tick is the impact frame's). Contact and
 * outward normal are body-local; the launch direction blends the blow (its inward part removed: pieces slide off, never
 * into the body) with the outward normal by `radial` (0 = a directional push, 1 = crater ejecta).
 */
export function openWound(
  core: WorldCore,
  body: Body,
  fx: number,
  fy: number,
  nx: number,
  ny: number,
  dirX: number,
  dirY: number,
  energy: number,
  sourceMass: number,
  radial: number,
  hitstop: number,
  grain = 16,
): number {
  const b = body.wounds;
  const w = b.next;
  b.grain[w] = grain;
  b.next = (b.next + 1) % MAX_WOUNDS;
  const f = body.transform.facing;
  let nwx = nx * f;
  let nwy = ny;
  const nl = Math.sqrt(nwx * nwx + nwy * nwy);
  if (nl > 1e-6) {
    nwx /= nl;
    nwy /= nl;
  } else {
    nwx = -dirX;
    nwy = -dirY;
  }
  const dOut = dirX * nwx + dirY * nwy;
  const vdx = dirX - Math.min(0, dOut) * nwx;
  const vdy = dirY - Math.min(0, dOut) * nwy;
  let ux = (1 - radial) * vdx + radial * nwx;
  let uy = (1 - radial) * vdy + radial * nwy;
  const ul = Math.sqrt(ux * ux + uy * uy);
  if (ul > 1e-4) {
    ux /= ul;
    uy /= ul;
  } else {
    ux = nwx;
    uy = nwy;
  }
  b.tick[w] = core.tick;
  b.lx[w] = fx;
  b.ly[w] = fy;
  b.dx[w] = ux;
  b.dy[w] = uy;
  b.energy[w] = energy;
  b.sourceMass[w] = sourceMass;
  b.shear[w] = core.tick + 1 + shearDelay(hitstop);
  b.speed[w] = 0;
  b.pending[w] = 0;
  b.mass[w] = 0;
  return w;
}

/** A wound for matter that lets go without a blow (a big island freed by fire or erosion): a slow drift away from the core. */
export function openDriftWound(core: WorldCore, body: Body, cx: number, cy: number): number {
  const t = body.transform;
  let nx = cx - t.x;
  let ny = cy - t.y;
  const l = Math.sqrt(nx * nx + ny * ny);
  if (l > 1e-3) {
    nx /= l;
    ny /= l;
  } else {
    nx = 0;
    ny = -1;
  }
  body.worldToLocalF(cx, cy, pt);
  const w = openWound(core, body, pt.x, pt.y, nx * t.facing, ny, nx, ny, 0, 1, 1, 0, 10);
  body.wounds.shear[w] = core.tick + 1;
  return w;
}

/** The most recent wound of `body` opened within `maxAge` ticks, or -1. */
export function recentWound(core: WorldCore, body: Body, maxAge = WOUND_WINDOW): number {
  const b = body.wounds;
  let best = -1;
  let bestTick = -Infinity;
  for (let w = 0; w < MAX_WOUNDS; w++) {
    const t = b.tick[w]!;
    if (core.tick - t <= maxAge && t > bestTick) {
      bestTick = t;
      best = w;
    }
  }
  return best;
}

/** Launch speed (px/s) of the wound's slabs, fixed by the first mass it frees: 190·√(E/(m+25)) scaled by the source mass. */
export function woundSpeed(core: WorldCore, body: Body, w: number, mass: number): number {
  const b = body.wounds;
  if (b.speed[w]! > 0) return b.speed[w]!;
  const E = b.energy[w]!;
  let v: number;
  if (E > 0) {
    const sm = Math.pow(Math.max(0.3, b.sourceMass[w]!) / 5, 0.25);
    v = 190 * Math.sqrt(E / (mass + 25)) * sm * (0.92 + core.rng.next() * 0.16);
    v = Math.max(24, Math.min(430, v));
  } else v = 16 + core.rng.next() * 26;
  b.speed[w] = v;
  return v;
}

/**
 * Launch of a piece of wound `w` (mass `mass`, centre of mass at world (cx, cy)): the wound speed along its direction (so the
 * pieces carry the wound's directional momentum) plus a lateral fan by the piece's offset from the contact, plus half the
 * body's own velocity. `out.spin` is filled by `woundSpin` once the chunk's moment of inertia is known.
 */
export function woundLaunch(
  core: WorldCore,
  body: Body,
  w: number,
  cx: number,
  cy: number,
  mass: number,
  out: Launch,
): void {
  const b = body.wounds;
  const v = woundSpeed(core, body, w, mass);
  const dx = b.dx[w]!;
  const dy = b.dy[w]!;
  localToWorldF(body, b.lx[w]!, b.ly[w]!, pt);
  const ox = cx - pt.x;
  const oy = cy - pt.y;
  const tx = -dy;
  const ty = dx;
  const off = ox * tx + oy * ty;
  const lat = Math.max(-1, Math.min(1, off / (8 + Math.sqrt(ox * ox + oy * oy)))) * 0.35;
  const jit = 0.94 + core.rng.next() * 0.12;
  out.vx = v * jit * (dx + lat * tx) + body.vx * 0.5;
  out.vy = v * jit * (dy + lat * ty) + body.vy * 0.5;
  out.spin = 0;
}

/** Lever-arm spin coefficient (fraction of the off-centre impulse that becomes tumbling). */
const SPIN_K = 0.06;

/**
 * Spin of a piece from the lever arm of its push: the impulse J = m·v acts on the piece's contact-facing side (a point one
 * radius from its centre of mass toward the wound contact), so ω = k·((p − c) × J) / I. A piece centred on the line of the
 * blow does not spin; pieces either side of it spin in opposite senses.
 */
export function woundSpin(
  body: Body,
  w: number,
  cx: number,
  cy: number,
  vx: number,
  vy: number,
  mass: number,
  radius: number,
  inertia: number,
): number {
  const b = body.wounds;
  localToWorldF(body, b.lx[w]!, b.ly[w]!, pt);
  let rx = cx - pt.x;
  let ry = cy - pt.y;
  const rl = Math.sqrt(rx * rx + ry * ry);
  if (rl < 1e-3) return 0;
  rx /= rl;
  ry /= rl;
  const R = Math.max(1, radius * 0.7);
  // lever (p − c) = −R·r̂ ; torque = lever × (m·v)
  const torque = -R * mass * (rx * vy - ry * vx);
  const s = (SPIN_K * torque) / Math.max(1e-3, inertia);
  return Math.max(-8, Math.min(8, s));
}

/* ------------------------------------------------------------------------------------------------ *
 *  Slabs: partition along grain seams, hairline outlines, staggered shear
 * ------------------------------------------------------------------------------------------------ */

const NMAX = MAX_BODY_DIM * MAX_BODY_DIM;
const mark = new Int32Array(NMAX);
let markGen = 0;
const localOf = new Int32Array(NMAX);
const pieceOf = new Int32Array(NMAX);
const dist = new Int32Array(NMAX);
const dmin = new Float64Array(NMAX);
let heap = new Float64Array(4096);
const MAX_PIECES = 24;
const seedK = new Int32Array(MAX_PIECES * 2);
const pCount = new Int32Array(MAX_PIECES * 2);
const pSx = new Float64Array(MAX_PIECES * 2);
const pSy = new Float64Array(MAX_PIECES * 2);
const pX0 = new Int32Array(MAX_PIECES * 2);
const pY0 = new Int32Array(MAX_PIECES * 2);
const pX1 = new Int32Array(MAX_PIECES * 2);
const pY1 = new Int32Array(MAX_PIECES * 2);
const remap = new Int32Array(MAX_PIECES * 2);
const order = new Int32Array(MAX_PIECES * 2);
const orderKey = new Float64Array(MAX_PIECES * 2);
const slotOfPiece = new Int32Array(MAX_PIECES * 2);
const pMass = new Float64Array(MAX_PIECES * 2);
const F_CRACK = CellFlag.CRACKED;

function nextGen(): number {
  markGen++;
  if (markGen > 0x7ffffff0) {
    mark.fill(0);
    markGen = 1;
  }
  return markGen;
}

function heapPush(n: number, v: number): number {
  if (n >= heap.length) {
    const nh = new Float64Array(heap.length * 2);
    nh.set(heap);
    heap = nh;
  }
  let i = n;
  heap[i] = v;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heap[p]! <= heap[i]!) break;
    const t = heap[p]!;
    heap[p] = heap[i]!;
    heap[i] = t;
    i = p;
  }
  return n + 1;
}

function heapPop(n: number): number {
  const top = heap[0]!;
  const last = heap[n - 1]!;
  n--;
  if (n > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && heap[l]! < heap[m]!) m = l;
      if (r < n && heap[r]! < heap[m]!) m = r;
      if (m === i) break;
      const t = heap[m]!;
      heap[m] = heap[i]!;
      heap[i] = t;
      i = m;
    }
  }
  return top;
}

/**
 * Partition `count` cells into about `want` connected pieces whose borders follow the weak bonds: seeds by farthest-point
 * sampling (the first one nearest the contact), then a bond-weighted region growing (crossing a weak seam is expensive, so
 * the fronts stall there and the seam becomes the border). Oversized pieces are halved, crumbs merged. Fills `pieceOf` for
 * the marked cells and returns the number of pieces.
 */
function partition(
  body: Body,
  cells: Int32Array,
  count: number,
  want: number,
  cxl: number,
  cyl: number,
  gen: number,
): number {
  const w = body.w;
  const bondR = body.map.bondR;
  const bondD = body.map.bondD;
  let nP = Math.max(1, Math.min(MAX_PIECES, want));
  // Farthest-point seeds.
  let first = 0;
  let bd = Infinity;
  for (let k = 0; k < count; k++) {
    const c = cells[k]!;
    const x = c % w;
    const y = (c - x) / w;
    const d = (x + 0.5 - cxl) * (x + 0.5 - cxl) + (y + 0.5 - cyl) * (y + 0.5 - cyl);
    dmin[k] = Infinity;
    if (d < bd) {
      bd = d;
      first = k;
    }
  }
  seedK[0] = first;
  for (let s = 1; s <= nP; s++) {
    const sc = cells[seedK[s - 1]!]!;
    const sx = sc % w;
    const sy = (sc - sx) / w;
    let far = -1;
    let fd = -1;
    for (let k = 0; k < count; k++) {
      const c = cells[k]!;
      const x = c % w;
      const y = (c - x) / w;
      const d = (x - sx) * (x - sx) + (y - sy) * (y - sy);
      if (d < dmin[k]!) dmin[k] = d;
      if (dmin[k]! > fd) {
        fd = dmin[k]!;
        far = k;
      }
    }
    if (s === nP) break;
    if (fd <= 0) {
      nP = s;
      break;
    }
    seedK[s] = far;
  }
  // Bond-weighted region growing (Dijkstra over the 4-neighbour bond graph of the set).
  for (let k = 0; k < count; k++) {
    dist[k] = 0x3fffffff;
    pieceOf[cells[k]!] = -1;
  }
  let hn = 0;
  for (let s = 0; s < nP; s++) {
    const k = seedK[s]!;
    dist[k] = 0;
    pieceOf[cells[k]!] = s;
    hn = heapPush(hn, k);
  }
  while (hn > 0) {
    const v = heapPop(hn);
    hn--;
    const k = v % 65536;
    const dk = Math.floor(v / 65536);
    if (dk !== dist[k]) continue;
    const c = cells[k]!;
    const p = pieceOf[c]!;
    const x = c % w;
    for (let dir = 0; dir < 4; dir++) {
      let nb: number;
      let bond: number;
      if (dir === 0) {
        if (x >= w - 1) continue;
        nb = c + 1;
        bond = bondR[c]!;
      } else if (dir === 1) {
        if (x === 0) continue;
        nb = c - 1;
        bond = bondR[nb]!;
      } else if (dir === 2) {
        nb = c + w;
        if (nb >= body.n) continue;
        bond = bondD[c]!;
      } else {
        nb = c - w;
        if (nb < 0) continue;
        bond = bondD[nb]!;
      }
      if (mark[nb] !== gen) continue;
      const kn = localOf[nb]!;
      const cost = bond <= HAIRLINE ? 14 : 1 + ((255 - bond) >> 5);
      const nd = dk + cost;
      if (nd < dist[kn]!) {
        dist[kn] = nd;
        pieceOf[nb] = p;
        hn = heapPush(hn, nd * 65536 + kn);
      }
    }
  }
  // Unreached cells (only joined by broken bonds) go to the nearest seed.
  for (let k = 0; k < count; k++) {
    const c = cells[k]!;
    if (pieceOf[c]! >= 0) continue;
    const x = c % w;
    const y = (c - x) / w;
    let best = 0;
    let bdd = Infinity;
    for (let s = 0; s < nP; s++) {
      const sc = cells[seedK[s]!]!;
      const sx = sc % w;
      const sy = (sc - sx) / w;
      const d = (x - sx) * (x - sx) + (y - sy) * (y - sy);
      if (d < bdd) {
        bdd = d;
        best = s;
      }
    }
    pieceOf[c] = best;
  }
  // Piece bounding boxes and counts; halve oversized pieces along their longer axis.
  const target = count / nP;
  measure(body, cells, count, nP);
  const n0 = nP;
  for (let p = 0; p < n0 && nP < MAX_PIECES; p++) {
    if (pCount[p]! <= target * 1.4 || pCount[p]! < 12) continue;
    const horiz = pX1[p]! - pX0[p]! >= pY1[p]! - pY0[p]!;
    const mid = horiz ? pSx[p]! / pCount[p]! : pSy[p]! / pCount[p]!;
    const np = nP++;
    for (let k = 0; k < count; k++) {
      const c = cells[k]!;
      if (pieceOf[c] !== p) continue;
      const x = c % w;
      const y = (c - x) / w;
      if ((horiz ? x + 0.5 : y + 0.5) > mid) pieceOf[c] = np;
    }
  }
  // Merge crumbs (< 5 cells) into a neighbouring piece.
  measure(body, cells, count, nP);
  for (let p = 0; p < nP; p++) {
    if (pCount[p]! === 0 || pCount[p]! >= 5) continue;
    let into = -1;
    for (let k = 0; k < count && into < 0; k++) {
      const c = cells[k]!;
      if (pieceOf[c] !== p) continue;
      const x = c % w;
      for (let dir = 0; dir < 4; dir++) {
        const nb =
          dir === 0 ? (x < w - 1 ? c + 1 : -1) : dir === 1 ? (x > 0 ? c - 1 : -1) : dir === 2 ? c + w : c - w;
        if (nb < 0 || nb >= body.n || mark[nb] !== gen) continue;
        const q = pieceOf[nb]!;
        if (q !== p && pCount[q]! > 0) {
          into = q;
          break;
        }
      }
    }
    if (into < 0) continue;
    for (let k = 0; k < count; k++) if (pieceOf[cells[k]!] === p) pieceOf[cells[k]!] = into;
    pCount[into]! += pCount[p]!;
    pCount[p] = 0;
  }
  // Compact ids.
  let m = 0;
  for (let p = 0; p < nP; p++) remap[p] = pCount[p]! > 0 ? m++ : -1;
  for (let k = 0; k < count; k++) pieceOf[cells[k]!] = remap[pieceOf[cells[k]!]!]!;
  measure(body, cells, count, m);
  return m;
}

function measure(body: Body, cells: Int32Array, count: number, nP: number): void {
  const w = body.w;
  for (let p = 0; p < nP; p++) {
    pCount[p] = 0;
    pSx[p] = 0;
    pSy[p] = 0;
    pX0[p] = 1 << 20;
    pY0[p] = 1 << 20;
    pX1[p] = -1;
    pY1[p] = -1;
  }
  for (let k = 0; k < count; k++) {
    const c = cells[k]!;
    const p = pieceOf[c]!;
    const x = c % w;
    const y = (c - x) / w;
    pCount[p]!++;
    pSx[p]! += x + 0.5;
    pSy[p]! += y + 0.5;
    if (x < pX0[p]!) pX0[p] = x;
    if (x > pX1[p]!) pX1[p] = x;
    if (y < pY0[p]!) pY0[p] = y;
    if (y > pY1[p]!) pY1[p] = y;
  }
}

/** Free slab slots of the body. */
function freeSlots(b: WoundBook): number {
  let n = 0;
  for (let s = 1; s <= MAX_SLABS; s++) if (b.state[s] === SLAB_FREE) n++;
  return n;
}

/** Move the live slab ranges to the front of the cell buffer. */
function compactSlabs(b: WoundBook): void {
  let top = 0;
  // ascending start keeps the copy safe (ranges only move left)
  for (;;) {
    let next = -1;
    let ns = Infinity;
    for (let s = 1; s <= MAX_SLABS; s++)
      if (b.state[s] !== SLAB_FREE && b.start[s]! >= top && b.start[s]! < ns) {
        ns = b.start[s]!;
        next = s;
      }
    if (next < 0) break;
    const st = b.start[next]!;
    const cn = b.count[next]!;
    if (st !== top) b.cells.copyWithin(top, st, st + cn);
    b.start[next] = top;
    top += cn;
  }
  b.top = top;
}

/**
 * Target piece size for `count` held cells cut into about `grain` pieces (12..200 cells each). Ten or more pieces keep any one
 * shear tick under ~1/10 of what the wound sheds.
 */
export function pieceTarget(count: number, grain: number): number {
  return Math.max(12, Math.min(200, count / grain));
}

/**
 * Hold `count` live cells (distinct) as slabs of wound `w` — a held core-disc cell stops anchoring (connectivity.ts) and stops
 * counting toward core integrity (body.ts) at once — : partition them along the grain,
 * outline every piece with hairline bonds, tag the cells and schedule one piece per tick from `firstShear` on, nearest the
 * contact first. Returns false (nothing changed) when the body has no slab slots or buffer left.
 */
export function holdCells(
  core: WorldCore,
  body: Body,
  w: number,
  cells: Int32Array,
  count: number,
  firstShear: number,
): boolean {
  const b = body.wounds;
  if (count <= 0) return false;
  const slots = freeSlots(b);
  if (slots === 0) return false;
  if (b.top + count > b.cells.length) compactSlabs(b);
  if (b.top + count > b.cells.length) return false;
  const map = body.map;
  const w0 = body.w;
  const gen = nextGen();
  let mass = 0;
  for (let k = 0; k < count; k++) {
    const c = cells[k]!;
    mark[c] = gen;
    localOf[c] = k;
    mass += body.cellMass(c);
  }
  const want = Math.min(slots, Math.max(1, Math.round(count / pieceTarget(count, b.grain[w]!))));
  const nP = Math.min(slots, partition(body, cells, count, want, b.lx[w]!, b.ly[w]!, gen));
  if (nP === 0) return false;
  // Shear order: nearest the contact first.
  for (let p = 0; p < nP; p++) {
    order[p] = p;
    const dx = pSx[p]! / pCount[p]! - b.lx[w]!;
    const dy = pSy[p]! / pCount[p]! - b.ly[w]!;
    orderKey[p] = dx * dx + dy * dy;
  }
  for (let i = 1; i < nP; i++) {
    const v = order[i]!;
    let j = i;
    while (j > 0 && orderKey[order[j - 1]!]! > orderKey[v]!) {
      order[j] = order[j - 1]!;
      j--;
    }
    order[j] = v;
  }
  // Piece masses (pieces beyond the free slots — rare — fold into the last one).
  pMass.fill(0, 0, nP);
  for (let k = 0; k < count; k++) {
    const c = cells[k]!;
    pMass[Math.min(pieceOf[c]!, nP - 1)]! += body.cellMass(c);
  }
  b.mass[w]! += mass;
  // Shedding budget: no tick sheds more than SHED_PER_TICK of the wound's mass (a piece that is bigger than that goes alone).
  const cap = SHED_PER_TICK * b.mass[w]!;
  // Slots, shear ticks (pieces in contact order, each on the first tick at or after its predecessor with budget left) and
  // cell ranges.
  let s = 1;
  let at = b.top;
  let t = firstShear;
  for (let r = 0; r < nP; r++) {
    const p = order[r]!;
    const pm = pMass[p]!;
    for (let guard = 0; guard < SCHED - 2; guard++) {
      const q = t & SCHED_MASK;
      const used = b.schedTick[q] === t ? b.schedMass[q]! : 0;
      if (used === 0 || used + pm <= cap) break;
      t++;
    }
    const q = t & SCHED_MASK;
    if (b.schedTick[q] !== t) {
      b.schedTick[q] = t;
      b.schedMass[q] = 0;
    }
    b.schedMass[q]! += pm;
    while (b.state[s] !== SLAB_FREE) s++;
    slotOfPiece[p] = s;
    b.state[s] = SLAB_HELD;
    b.woundOf[s] = w;
    b.shearAt[s] = t;
    b.start[s] = at;
    b.count[s] = 0;
    at += pCount[p]!;
    s++;
  }
  b.top = at;
  b.held += nP;
  for (let k = 0; k < count; k++) {
    const c = cells[k]!;
    // Pieces beyond the free slots (rare) fold into the last scheduled piece.
    const p = Math.min(pieceOf[c]!, nP - 1);
    const sl = slotOfPiece[p]!;
    b.cells[b.start[sl]! + b.count[sl]!] = c;
    b.count[sl]!++;
    map.detached[c] = sl;
  }
  // Hairline outlines: every bond from a slab cell to a cell outside its slab.
  const bondR = map.bondR;
  const bondD = map.bondD;
  const mat = map.material;
  const det = map.detached;
  const flags = map.flags;
  let x0 = w0;
  let y0 = body.h;
  let x1 = -1;
  let y1 = -1;
  for (let k = 0; k < count; k++) {
    const c = cells[k]!;
    const x = c % w0;
    const y = (c - x) / w0;
    const tg = det[c]!;
    if (x < w0 - 1 && mat[c + 1] !== 0 && det[c + 1] !== tg && bondR[c]! > HAIRLINE) {
      bondR[c] = HAIRLINE;
      flags[c] = flags[c]! | F_CRACK;
      flags[c + 1] = flags[c + 1]! | F_CRACK;
    }
    if (x > 0 && mat[c - 1] !== 0 && det[c - 1] !== tg && bondR[c - 1]! > HAIRLINE) {
      bondR[c - 1] = HAIRLINE;
      flags[c] = flags[c]! | F_CRACK;
      flags[c - 1] = flags[c - 1]! | F_CRACK;
    }
    if (y < body.h - 1 && mat[c + w0] !== 0 && det[c + w0] !== tg && bondD[c]! > HAIRLINE) {
      bondD[c] = HAIRLINE;
      flags[c] = flags[c]! | F_CRACK;
      flags[c + w0] = flags[c + w0]! | F_CRACK;
    }
    if (y > 0 && mat[c - w0] !== 0 && det[c - w0] !== tg && bondD[c - w0]! > HAIRLINE) {
      bondD[c - w0] = HAIRLINE;
      flags[c] = flags[c]! | F_CRACK;
      flags[c - w0] = flags[c - w0]! | F_CRACK;
    }
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  body.touch(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
  woundSpeed(core, body, w, mass);
  return true;
}

/** True while a held slab still owns cell `c` (connectivity anchor; craters and cuts leave it alone). */
export function isHeld(body: Body, c: number): boolean {
  const s = body.map.detached[c]!;
  return s !== 0 && body.wounds.state[s] === SLAB_HELD;
}

/** The wound a released (shearing) slab cell belongs to, or -1. */
export function releasingWound(body: Body, cells: Int32Array, count: number): number {
  const det = body.map.detached;
  const b = body.wounds;
  for (let k = 0; k < count; k++) {
    const s = det[cells[k]!]!;
    if (s !== 0 && b.state[s] === SLAB_RELEASING) return b.woundOf[s]!;
  }
  return -1;
}

/** Push every cell of the held slabs onto the connectivity flood (they are anchored until they shear). */
export function seedHeld(body: Body, st: { push(v: number): void }, stamp: Uint32Array, gen: number): void {
  const b = body.wounds;
  const mat = body.map.material;
  const det = body.map.detached;
  for (let s = 1; s <= MAX_SLABS; s++) {
    if (b.state[s] !== SLAB_HELD) continue;
    const a = b.start[s]!;
    const e = a + b.count[s]!;
    for (let k = a; k < e; k++) {
      const c = b.cells[k]!;
      if (mat[c] === 0 || det[c] !== s || stamp[c] === gen) continue;
      stamp[c] = gen;
      st.push(c);
    }
  }
}

/** Sever every bond from slab `s` to matter outside it (the shear). */
function severSlab(body: Body, s: number): void {
  const b = body.wounds;
  const map = body.map;
  const mat = map.material;
  const det = map.detached;
  const w = body.w;
  const a = b.start[s]!;
  const e = a + b.count[s]!;
  for (let k = a; k < e; k++) {
    const c = b.cells[k]!;
    if (mat[c] === 0 || det[c] !== s) continue;
    const x = c % w;
    if (x < w - 1 && mat[c + 1] !== 0 && det[c + 1] !== s) breakBondR(body, c);
    if (x > 0 && mat[c - 1] !== 0 && det[c - 1] !== s) breakBondR(body, c - 1);
    if (c + w < body.n && mat[c + w] !== 0 && det[c + w] !== s) breakBondD(body, c);
    if (c >= w && mat[c - w] !== 0 && det[c - w] !== s) breakBondD(body, c - w);
    body.touchPoint(x, (c - x) / w);
  }
  // (connectivity runs the full flood while any slab is held or releasing: this slab is no longer seeded, so it goes)
  b.state[s] = SLAB_RELEASING;
}

/** Shear the held slabs whose tick has come (before the connectivity pass of this tick, which releases them). */
export function stepWounds(core: WorldCore, body: Body): void {
  const b = body.wounds;
  if (b.held === 0) return;
  for (let s = 1; s <= MAX_SLABS; s++) {
    if (b.state[s] !== SLAB_HELD || b.shearAt[s]! > core.tick) continue;
    severSlab(body, s);
    body.connDirty = CONN_NOW;
  }
}

/** After the connectivity pass: shearing slabs have been released; free their slots. */
export function finishReleases(core: WorldCore, body: Body): void {
  const b = body.wounds;
  if (b.held === 0 || body.lastConnTick !== core.tick) return;
  const det = body.map.detached;
  for (let s = 1; s <= MAX_SLABS; s++) {
    if (b.state[s] !== SLAB_RELEASING) continue;
    const a = b.start[s]!;
    const e = a + b.count[s]!;
    for (let k = a; k < e; k++) {
      const c = b.cells[k]!;
      if (det[c] === s) det[c] = 0;
    }
    b.state[s] = SLAB_FREE;
    b.count[s] = 0;
    b.held--;
  }
  if (b.held === 0) b.top = 0;
}

/** Shear every held slab now (harness carving and tests that need the final state). */
export function flushWounds(core: WorldCore, body: Body): void {
  const b = body.wounds;
  for (let s = 1; s <= MAX_SLABS; s++) if (b.state[s] === SLAB_HELD) b.shearAt[s] = core.tick;
  stepWounds(core, body);
}

/** Drop every wound and slab (restore / heal): held cells simply stay part of the body. */
export function clearWounds(body: Body): void {
  body.wounds.reset();
  body.map.detached.fill(0);
}
