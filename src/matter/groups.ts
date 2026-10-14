import { rgba } from '@/contracts';
import { CONN_NOW, type Body } from './body';
import type { WorldCore } from './core';
import { endSpray, extractChunk } from './debris';
import type { Chunk } from './chunks';
import { DMath } from '@/contracts/dmath';

/**
 * CHUNK GROUPS (Gate 2C, 우리; uri/docs/URI_SPEC.md §7, the oracle's `tear` / `hitAt` in uri/src/30_breaking_compose.js).
 *
 * A body may carry a per-cell group id (`Body.cellGroups`, MatterWorldEx.setCellGroups): 우리's parts are pre-split into irregular
 * chunks of ~8–11 px. On this path a wound is a WHOLE pre-split chunk, not D1's crack/hold/shear slab:
 * - the struck chunk leaves as ONE tumbling debris piece with its own colours (`extractChunk`: exact mass transfer, the cells'
 *   displayed pixels, the body's angle), flung away from the impact with the body's own velocity added — it visibly leaves,
 *   it never vanishes;
 * - a heavy hit takes neighbouring chunks too (power > 1: up to 2 × power chunks within 7 × power cells);
 * - the matter left around the hole glows: each live cell of another chunk beside a torn cell becomes exposed habitat or crack
 *   with probability 0.7 (half each), mass kept (the density byte absorbs the material change; the rounding goes to the ledger).
 * All draws come from the body's own RNG stream (hashed), so tearing is deterministic.
 */

/** Tunables of the oracle (`tear`, `hitAt`). */
export const TEAR = {
  /** Struck chunk's tear power = 1 + power × 0.6; neighbours 1 + power × 0.5. */
  strikeK: 0.6,
  neighbourK: 0.5,
  /** Neighbours: sampled within 7 × power cells, 40 tries, at most 2 × power chunks in all. */
  radiusK: 7,
  tries: 40,
  maxK: 2,
  /** Piece speed (0.5 + U·1.4) × power px per oracle frame (60 Hz) and spin (U − 0.5) × 2.4 × power × 0.6 rad/s. */
  speedLo: 0.5,
  speedSpan: 1.4,
  spinK: 2.4 * 0.6,
  /** Wound glow: probability a bordering cell turns, and the share of those that become habitat (the rest crack). */
  woundP: 0.7,
  habitatShare: 0.5,
} as const;

const HABITAT_LIT = rgba(255, 214, 150);
const HABITAT_DARK = rgba(44, 20, 10);
const CRACK_LIT = rgba(255, 170, 90);

/** Scratch: the cells of one group, and per-call group stamps. */
let cellBuf = new Int32Array(4096);
let seen = new Int32Array(1024);
let seenGen = 0;

/** The wound materials of a body: by key ('habitat', 'crack') unless given. -1 = none (no glow). */
function woundMat(body: Body, key: string): number {
  const mats = body.materials;
  for (let i = 1; i < mats.length; i++) if (mats[i]!.key === key) return i;
  return -1;
}

/** Collect the live cells of group `g` into the scratch buffer; returns the count. */
function collectGroup(body: Body, g: number): number {
  const groups = body.cellGroups!;
  const mat = body.map.material;
  let n = 0;
  for (let c = 0; c < body.n; c++) {
    if (groups[c] !== g || mat[c] === 0) continue;
    if (n >= cellBuf.length) {
      const nb = new Int32Array(cellBuf.length * 2);
      nb.set(cellBuf);
      cellBuf = nb;
    }
    cellBuf[n++] = c;
  }
  return n;
}

/**
 * Tear group `g` out of `body` as one debris chunk flung from the world impact point (ix, iy) with tear power `power`
 * (the oracle's `tear`), then light the wound around it. Returns the chunk, or null when the group has no live cell left.
 */
export function tearGroup(
  core: WorldCore,
  body: Body,
  g: number,
  ix: number,
  iy: number,
  power: number,
  glow = true,
): Chunk | null {
  if (body.cellGroups === null) return null;
  const n = collectGroup(body, g);
  if (n === 0) return null;
  return tearCells(core, body, cellBuf.slice(0, n), n, g, ix, iy, power, glow);
}

/** `tearGroup` on an explicit cell list (all live, all of group `g`). */
function tearCells(
  core: WorldCore,
  body: Body,
  cells: Int32Array,
  n: number,
  g: number,
  ix: number,
  iy: number,
  power: number,
  glow: boolean,
): Chunk | null {
  const rng = body.rng;
  // the piece's own centre (world) for its direction away from the impact
  let sx = 0;
  let sy = 0;
  const w = body.w;
  const p = { x: 0, y: 0 };
  for (let k = 0; k < n; k++) {
    const c = cells[k]!;
    const x = c % w;
    body.cellWorld(x, (c - x) / w, p);
    sx += p.x;
    sy += p.y;
  }
  sx /= n;
  sy /= n;
  const a = DMath.atan2(sy - iy, sx - ix) + (rng.next() - 0.5) * 0.6;
  const sp = (TEAR.speedLo + rng.next() * TEAR.speedSpan) * power * 60 * body.groupScale; // oracle px/frame at the body scale
  const spin = (rng.next() - 0.5) * TEAR.spinK * power;
  const ch = extractChunk(
    core,
    body,
    cells,
    n,
    body.vx + DMath.cos(a) * sp,
    body.vy + DMath.sin(a) * sp,
    spin,
  );
  endSpray(core);
  if (ch !== null) {
    ch.fast = true; // it leaves with its push at once (no heaviness ramp) and is the wound's matter, never a weapon
    ch.launchNear = false;
    core.emitMatter('detach', ch.x, ch.y, ch.mass, body.ownerSlot);
  }
  if (glow)
    lightWound(core, body, cells, n, g, woundMat(body, 'habitat'), woundMat(body, 'crack'), TEAR.woundP);
  // the hole may have cut a piece off: plain matter sheds it next tick (a field-held body keeps it: connectivity.ts)
  if (body.connDirty < CONN_NOW) body.connDirty = CONN_NOW;
  return ch;
}

/**
 * S2's call (proposal 175): tear the listed live cells out as ONE tumbling chunk at the given velocity (px/s) and spin (rad/s),
 * and optionally light the wound: each live 4-neighbour of a torn cell takes `wound.mats[0]` or `[1]` (half each) with
 * probability `wound.chance` (the oracle: 0.7, exposed habitat / crack), mass kept. Returns the chunk or null.
 */
export function tearCellList(
  core: WorldCore,
  body: Body,
  cells: Int32Array,
  n: number,
  vx: number,
  vy: number,
  spin: number,
  wound?: { mats: readonly [number, number]; chance: number },
): Chunk | null {
  const mat = body.map.material;
  let m = 0;
  const live = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    const c = cells[k]!;
    if (c >= 0 && c < body.n && mat[c] !== 0) live[m++] = c;
  }
  if (m === 0) return null;
  const ch = extractChunk(core, body, live, m, vx, vy, spin);
  endSpray(core);
  if (ch !== null) {
    ch.fast = true;
    ch.launchNear = false;
    core.emitMatter('detach', ch.x, ch.y, ch.mass, body.ownerSlot);
  }
  if (wound) lightWound(core, body, live, m, -1, wound.mats[0], wound.mats[1], wound.chance);
  if (body.connDirty < CONN_NOW) body.connDirty = CONN_NOW;
  return ch;
}

/** The oracle's glowing wound: live cells of other groups beside the torn cells become exposed habitat / crack. */
function lightWound(
  core: WorldCore,
  body: Body,
  cells: Int32Array,
  n: number,
  g: number,
  hab: number,
  crk: number,
  chance: number,
): void {
  if (hab < 0 && crk < 0) return;
  const map = body.map;
  const mat = map.material;
  const groups = body.cellGroups;
  const w = body.w;
  const h = body.h;
  const rng = body.rng;
  // stamp every candidate once (row-major over the torn cells' neighbours, in the torn cells' order: deterministic)
  if (seen.length < body.n) seen = new Int32Array(body.n);
  if (++seenGen > 0x7ffffff0) {
    seen.fill(0);
    seenGen = 1;
  }
  const DX = [1, -1, 0, 0];
  const DY = [0, 0, 1, -1];
  for (let k = 0; k < n; k++) {
    const c = cells[k]!;
    const x = c % w;
    const y = (c - x) / w;
    for (let d = 0; d < 4; d++) {
      const xx = x + DX[d]!;
      const yy = y + DY[d]!;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (mat[j] === 0 || (groups !== null && groups[j] === g) || seen[j] === seenGen) continue;
      seen[j] = seenGen;
      if (rng.next() >= chance) continue;
      const to = rng.next() < TEAR.habitatShare ? (hab >= 0 ? hab : crk) : crk >= 0 ? crk : hab;
      convertCell(core, body, j, to, xx, yy);
    }
  }
}

/** Change a live cell's material keeping its mass (density byte rescaled; the rounding is booked in the ledger). */
function convertCell(core: WorldCore, body: Body, c: number, to: number, x: number, y: number): void {
  const map = body.map;
  if (map.material[c] === to) return;
  const before = body.cellMass(c);
  const d = Math.round((before * 128) / Math.max(1e-6, body.matDensity[to]!));
  map.material[c] = to;
  map.density[c] = d < 1 ? 1 : d > 255 ? 255 : d;
  const diff = body.cellMass(c) - before;
  if (diff > 0) core.ledger.injected += diff;
  else if (diff < 0) core.ledger.dissipated -= diff;
  // the oracle's wound colours (shadeAt: code 7 = a lit lattice of habitat over dark, code 8 = hot crack)
  const key = body.materials[to]!.key;
  map.baseColor[c] =
    key === 'crack' ? CRACK_LIT : (x + y) % 4 === 0 || (x - y) % 4 === 0 ? HABITAT_LIT : HABITAT_DARK;
  body.touchPoint(x, y);
}

/**
 * A blow on a grouped body at world (wx, wy) with power `power` (the oracle's `hitAt`): the struck chunk tears out (tear power
 * 1 + 0.6·power); a heavy blow (power > 1) also tears neighbouring chunks (1 + 0.5·power) sampled within 7·power cells, up to
 * 2·power chunks in all. Returns the number of chunks torn (0 = nothing of this body drawn there).
 */
export function hitTear(core: WorldCore, body: Body, wx: number, wy: number, power: number): number {
  if (body.cellGroups === null) return 0;
  const c0 = body.cellAtWorld(wx, wy);
  if (c0 < 0 || body.map.material[c0] === 0) return 0;
  const groups = body.cellGroups;
  const w = body.w;
  const g0 = groups[c0]!;
  const x0 = c0 % w;
  const y0 = (c0 - x0) / w;
  let torn = tearGroup(core, body, g0, wx, wy, 1 + power * TEAR.strikeK) !== null ? 1 : 0;
  if (power > 1) {
    const R = TEAR.radiusK * power * body.groupScale; // cells shrink with the body
    const cap = power * TEAR.maxK;
    const rng = body.rng;
    const done: number[] = [g0];
    for (let k = 0; k < TEAR.tries; k++) {
      const a = rng.next() * Math.PI * 2;
      const r = rng.next() * R;
      const jx = Math.round(x0 + DMath.cos(a) * r);
      const jy = Math.round(y0 + DMath.sin(a) * r);
      if (jx < 0 || jy < 0 || jx >= w || jy >= body.h) continue;
      const j = jy * w + jx;
      if (body.map.material[j] === 0) continue;
      const g = groups[j]!;
      if (done.includes(g)) continue;
      done.push(g);
      if (done.length <= cap && tearGroup(core, body, g, wx, wy, 1 + power * TEAR.neighbourK) !== null)
        torn++;
    }
  }
  return torn;
}

/**
 * Let a whole body go as its chunks (the 50 % rule, a neck failure in pieces, the break-apart): every live group tears out,
 * flung from world (fx, fy) with power `power` (break-apart: 0.35 for the chamber, 0.55 for the rest). When the debris pool has
 * fewer free slots than groups (`maxPieces`, default: the free slots), neighbouring groups are merged on a coarse grid of
 * their centres so no piece is degraded to dust on arrival. No wound glow (nothing is left to glow). Returns pieces made.
 */
export function releaseGroups(
  core: WorldCore,
  body: Body,
  fx: number,
  fy: number,
  power: number,
  maxPieces = core.chunks.cap - core.chunks.count,
): number {
  if (body.cellGroups === null) return 0;
  const groups = body.cellGroups;
  const mat = body.map.material;
  const w = body.w;
  // live groups and their local centres
  let maxG = 0;
  for (let c = 0; c < body.n; c++) if (mat[c] !== 0 && groups[c]! > maxG) maxG = groups[c]!;
  const cnt = new Int32Array(maxG + 1);
  const cx = new Float64Array(maxG + 1);
  const cy = new Float64Array(maxG + 1);
  for (let c = 0; c < body.n; c++) {
    if (mat[c] === 0) continue;
    const g = groups[c]!;
    const x = c % w;
    cnt[g]!++;
    cx[g]! += x;
    cy[g]! += (c - x) / w;
  }
  const live: number[] = [];
  for (let g = 0; g <= maxG; g++)
    if (cnt[g]! > 0) {
      live.push(g);
      cx[g]! /= cnt[g]!;
      cy[g]! /= cnt[g]!;
    }
  if (live.length === 0) return 0;
  const budget = Math.max(1, maxPieces);
  // piece id per group: the group itself, or a grid cell of centres coarse enough to fit the budget
  const piece = new Int32Array(maxG + 1).fill(-1);
  let pieces = live.length;
  if (pieces <= budget) for (const g of live) piece[g] = g;
  else {
    for (let s = 2; ; s++) {
      const ids = new Map<number, number>();
      for (const g of live) {
        const key = Math.floor(cy[g]! / s) * 4096 + Math.floor(cx[g]! / s);
        let id = ids.get(key);
        if (id === undefined) {
          id = ids.size;
          ids.set(key, id);
        }
        piece[g] = id;
      }
      pieces = ids.size;
      if (pieces <= budget || s > Math.max(body.w, body.h)) break;
    }
  }
  // bucket the live cells by piece once (row-major inside each piece), then tear every piece
  const pid = new Int32Array(maxG + 1);
  const ids: number[] = [];
  if (pieces === live.length) live.forEach((g, k) => (pid[g] = k));
  else for (const g of live) pid[g] = piece[g]!;
  for (let k = 0; k < pieces; k++) ids.push(k);
  const start = new Int32Array(pieces + 1);
  for (let c = 0; c < body.n; c++) if (mat[c] !== 0) start[pid[groups[c]!]! + 1]!++;
  for (let k = 0; k < pieces; k++) start[k + 1]! += start[k]!;
  const fill = start.slice(0, pieces);
  const all = new Int32Array(start[pieces]!);
  for (let c = 0; c < body.n; c++) if (mat[c] !== 0) all[fill[pid[groups[c]!]!]!++] = c;
  let made = 0;
  for (const k of ids) {
    const a = start[k]!;
    const n = start[k + 1]! - a;
    if (n > 0 && tearCells(core, body, all.subarray(a, a + n), n, -1, fx, fy, power, false) !== null) made++;
  }
  return made;
}

/** Live groups of a body (distinct group ids of live cells). */
export function liveGroups(body: Body): number {
  if (body.cellGroups === null) return 0;
  const groups = body.cellGroups;
  const mat = body.map.material;
  const seenG = new Set<number>();
  for (let c = 0; c < body.n; c++) if (mat[c] !== 0) seenG.add(groups[c]!);
  return seenG.size;
}

/**
 * Piece budgets for releasing several grouped bodies (the break-apart): the debris pool's free slots shared in proportion to
 * each body's live groups (at least 1 each), so the whole titan fits the pool and nothing turns to dust on arrival.
 */
export function releaseBudgets(core: WorldCore, bodies: readonly Body[]): number[] {
  const free = Math.max(bodies.length, core.chunks.cap - core.chunks.count);
  const want = bodies.map(liveGroups);
  const total = want.reduce((a, b) => a + b, 0);
  if (total <= free) return want;
  return want.map((g) => Math.max(1, Math.floor((g * free) / total)));
}

/** Fraction of `cells` (map-local) still live: the oracle's neck integrity (`neckInt`), wound cells (habitat/crack) counting. */
export function liveFraction(body: Body, cells: ArrayLike<number>): number {
  if (cells.length === 0) return 1;
  const mat = body.map.material;
  let a = 0;
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k]!;
    if (c >= 0 && c < body.n && mat[c] !== 0) a++;
  }
  return a / cells.length;
}
