import { LOGICAL_H, LOGICAL_W, MAX_DEBRIS_CHUNKS, TICK_DT, type ViewRect } from '@/contracts';
import type { WorldCore } from './core';
import { PK } from './particles';
import { lerpPx, scalePx } from './util';

const EMPTY32 = new Uint32Array(0);
const EMPTY8 = new Uint8Array(0);
const QUANT = 48; // rotation steps per turn: pixel-art friendly stepped tumbling
const QSTEP = (Math.PI * 2) / QUANT;

/** A rigid tumbling piece of debris. Sprite is in WORLD orientation (mirroring/lean already applied). */
export class Chunk {
  alive = false;
  id = 0;
  /** Centre of mass, world px. */
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  angle = 0;
  spin = 0;
  mass = 0;
  w = 0;
  h = 0;
  /** Pivot (centre of mass) in sprite coordinates. */
  cx = 0;
  cy = 0;
  pixels: Uint32Array = EMPTY32;
  emis: Uint8Array = EMPTY8;
  /** Edge normal direction index 1..8 (0 = interior) per sprite pixel, for tumbling rim light. */
  nrm: Uint8Array = EMPTY8;
  hasEmis = false;
  radius = 1;
  cells = 0;
  age = 0;
  grace = 0;
  origin = -1;
  front = false;
  brittle = 0.5;
  heat = 0;
  /** No body impacts until `age` reaches this (post-bounce immunity). */
  noHitUntil = 0;
  /** Sleeping = settled; skipped by physics unless a gravity source is active. */
  asleep = false;
}

/** Pool of chunks (fixed capacity, objects preallocated). */
export class ChunkPool {
  readonly cap: number;
  readonly list: Chunk[];
  private readonly freeList: Int32Array;
  private freeTop = 0;
  hi = 0;
  count = 0;
  nextId = 1;
  massLive = 0;

  constructor(cap = MAX_DEBRIS_CHUNKS) {
    this.cap = cap;
    this.list = new Array<Chunk>(cap);
    for (let i = 0; i < cap; i++) this.list[i] = new Chunk();
    this.freeList = new Int32Array(cap);
  }

  private claim(core: WorldCore): Chunk {
    let slot: number;
    if (this.freeTop > 0) slot = this.freeList[--this.freeTop]!;
    else if (this.hi < this.cap) slot = this.hi++;
    else {
      // Full: the oldest+smallest chunk degrades to dust and its slot is reused right away.
      slot = this.pickVictim();
      const v = this.list[slot]!;
      degradeToDust(core, v);
      v.alive = false;
      this.massLive -= v.mass;
      v.pixels = EMPTY32;
      v.emis = EMPTY8;
      v.nrm = EMPTY8;
      this.count--;
    }
    this.count++;
    return this.list[slot]!;
  }

  /** Oldest+smallest chunk is degraded first. Deterministic scan. */
  private pickVictim(): number {
    let best = 0;
    let bestScore = Infinity;
    for (let i = 0; i < this.hi; i++) {
      const c = this.list[i]!;
      if (!c.alive) continue;
      const score = c.mass * (1 + Math.min(c.age, 3600) / 1800);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  private release(c: Chunk, slot: number): void {
    if (!c.alive) return;
    c.alive = false;
    this.massLive -= c.mass;
    c.pixels = EMPTY32;
    c.emis = EMPTY8;
    c.nrm = EMPTY8;
    this.freeList[this.freeTop++] = slot;
    this.count--;
  }

  /** Remove chunk (mass must already have been routed by the caller). */
  free(c: Chunk): void {
    const slot = this.list.indexOf(c);
    if (slot >= 0) this.release(c, slot);
  }

  freeAt(slot: number): void {
    this.release(this.list[slot]!, slot);
  }

  /**
   * Add a chunk from a world-orientation sprite. `pixels`/`emis` are adopted (not copied). Returns the chunk, or null for
   * empty sprites. `x,y` = centre of mass, `px,py` = pivot inside the sprite (centre of mass).
   */
  add(
    core: WorldCore,
    pixels: Uint32Array,
    emis: Uint8Array | null,
    w: number,
    h: number,
    px: number,
    py: number,
    x: number,
    y: number,
    vx: number,
    vy: number,
    spin: number,
    mass: number,
    origin: number,
    brittle: number,
    heat: number,
  ): Chunk {
    const c = this.claim(core);
    c.alive = true;
    c.id = this.nextId++;
    c.x = x;
    c.y = y;
    c.vx = vx;
    c.vy = vy;
    c.angle = 0;
    c.spin = spin;
    c.mass = mass;
    c.w = w;
    c.h = h;
    c.cx = px;
    c.cy = py;
    c.pixels = pixels;
    c.hasEmis = emis !== null;
    c.emis = emis ?? EMPTY8;
    c.age = 0;
    c.grace = 0;
    c.origin = origin;
    c.brittle = brittle;
    c.heat = heat;
    c.asleep = false;
    c.noHitUntil = 0;
    // depth cheat: ~1 in 4 chunks render in front of the titans (deterministic from id)
    c.front = ((c.id * 2654435761) >>> 0) % 4 === 0;
    this.massLive += mass;
    computeChunkGeometry(c);
    return c;
  }
}

/** Radius, opaque cell count and edge normals from the sprite. */
function computeChunkGeometry(c: Chunk): void {
  const { w, h, pixels } = c;
  const nrm = new Uint8Array(w * h);
  let cells = 0;
  let r2 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (pixels[i]! >>> 24 === 0) continue;
      cells++;
      const dx = x + 0.5 - c.cx;
      const dy = y + 0.5 - c.cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) r2 = d2;
      let nx = 0;
      let ny = 0;
      if (x === 0 || pixels[i - 1]! >>> 24 === 0) nx -= 1;
      if (x === w - 1 || pixels[i + 1]! >>> 24 === 0) nx += 1;
      if (y === 0 || pixels[i - w]! >>> 24 === 0) ny -= 1;
      if (y === h - 1 || pixels[i + w]! >>> 24 === 0) ny += 1;
      if (nx !== 0 || ny !== 0) {
        let a = Math.atan2(ny, nx);
        if (a < 0) a += Math.PI * 2;
        nrm[i] = 1 + (Math.round(a / (Math.PI / 4)) & 7);
      }
    }
  }
  c.nrm = nrm;
  c.cells = cells;
  c.radius = Math.sqrt(r2) + 1;
}

/** Turn a chunk into dust particles that carry its mass (used on overflow and hard destruction). */
export function degradeToDust(core: WorldCore, c: Chunk): void {
  const n = Math.min(6, 1 + (c.cells >> 4));
  const p = core.particles;
  const per = c.mass / n;
  // Sample a few opaque pixels for colours.
  let k = 0;
  const step = Math.max(1, Math.floor(c.pixels.length / (n + 1)));
  for (let i = 0; i < c.pixels.length && k < n; i += step) {
    let j = i;
    while (j < c.pixels.length && c.pixels[j]! >>> 24 === 0) j++;
    if (j >= c.pixels.length) break;
    const col = c.pixels[j]!;
    const rid = p.internRamp([col, scalePx(col, 190), scalePx(col, 120)]);
    const ang = core.rng.next() * Math.PI * 2;
    const sp = 10 + core.rng.next() * 30;
    p.spawn(
      core,
      PK.dust,
      c.x + (core.rng.next() - 0.5) * c.radius,
      c.y + (core.rng.next() - 0.5) * c.radius,
      c.vx * 0.5 + Math.cos(ang) * sp,
      c.vy * 0.5 + Math.sin(ang) * sp,
      50 + core.rng.int(40),
      2,
      0,
      rid,
      1,
      0.8,
      per,
    );
    k++;
  }
  if (k === 0) core.ledger.dissipated += c.mass;
  else {
    // Remaining mass after integer division rounding.
    core.ledger.dissipated += c.mass - per * k;
  }
  // chunkPool.massLive is reduced by release(); particle mass was added by spawn: net conserved.
}

/**
 * Split a chunk into `k` shards by a jittered Voronoi partition of its opaque pixels (impact fracture). Momentum
 * conserving: shards inherit the parent velocity plus a radial burst from (ix, iy). Mass is split by pixel share.
 */
export function splitChunk(
  core: WorldCore,
  pool: ChunkPool,
  c: Chunk,
  k: number,
  ix: number,
  iy: number,
  burst: number,
): boolean {
  if (c.cells < k * 4) return false;
  const rng = core.rng;
  const w = c.w;
  const h = c.h;
  const seedX: number[] = [];
  const seedY: number[] = [];
  let guard = 0;
  while (seedX.length < k && guard++ < 64) {
    const sx = rng.int(w);
    const sy = rng.int(h);
    if (c.pixels[sy * w + sx]! >>> 24 === 0) continue;
    seedX.push(sx);
    seedY.push(sy);
  }
  if (seedX.length < 2) return false;
  const kk = seedX.length;
  const owner = new Int8Array(w * h).fill(-1);
  const counts = new Int32Array(kk);
  const minX = new Int32Array(kk).fill(1 << 20);
  const minY = new Int32Array(kk).fill(1 << 20);
  const maxX = new Int32Array(kk).fill(-1);
  const maxY = new Int32Array(kk).fill(-1);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (c.pixels[y * w + x]! >>> 24 === 0) continue;
      let best = 0;
      let bd = Infinity;
      for (let s = 0; s < kk; s++) {
        const dx = x - seedX[s]!;
        const dy = y - seedY[s]!;
        const d = dx * dx + dy * dy + rng.next() * 3;
        if (d < bd) {
          bd = d;
          best = s;
        }
      }
      owner[y * w + x] = best;
      counts[best]!++;
      if (x < minX[best]!) minX[best] = x;
      if (x > maxX[best]!) maxX[best] = x;
      if (y < minY[best]!) minY[best] = y;
      if (y > maxY[best]!) maxY[best] = y;
    }
  const total = c.cells;
  const parentAngle = c.angle;
  const cos = Math.cos(c.angle);
  const sin = Math.sin(c.angle);
  const parent = {
    x: c.x,
    y: c.y,
    vx: c.vx,
    vy: c.vy,
    spin: c.spin,
    mass: c.mass,
    origin: c.origin,
    brittle: c.brittle,
    heat: c.heat,
  };
  const cxp = c.cx;
  const cyp = c.cy;
  const srcPix = c.pixels;
  const srcEmi = c.hasEmis ? c.emis : null;
  // Free the parent first so the pool has room and ledger masses stay consistent.
  pool.free(c);
  let massLeft = parent.mass;
  let lastChunk: Chunk | null = null;
  for (let s = 0; s < kk; s++) {
    const n = counts[s]!;
    if (n === 0) continue;
    const bw = maxX[s]! - minX[s]! + 1;
    const bh = maxY[s]! - minY[s]! + 1;
    const pix = new Uint32Array(bw * bh);
    const emi = srcEmi ? new Uint8Array(bw * bh) : null;
    let sx = 0;
    let sy = 0;
    for (let y = minY[s]!; y <= maxY[s]!; y++)
      for (let x = minX[s]!; x <= maxX[s]!; x++) {
        if (owner[y * w + x] !== s) continue;
        const o = (y - minY[s]!) * bw + (x - minX[s]!);
        pix[o] = srcPix[y * w + x]!;
        if (emi) emi[o] = srcEmi![y * w + x]!;
        sx += x + 0.5;
        sy += y + 0.5;
      }
    sx /= n;
    sy /= n;
    const m = (parent.mass * n) / total;
    massLeft -= m;
    // World position of this shard's CoM: rotate its offset from the parent pivot by the parent angle.
    const ox = sx - cxp;
    const oy = sy - cyp;
    const wx = parent.x + ox * cos - oy * sin;
    const wy = parent.y + ox * sin + oy * cos;
    let dx = wx - ix;
    let dy = wy - iy;
    const dl = Math.sqrt(dx * dx + dy * dy) + 1e-6;
    dx /= dl;
    dy /= dl;
    const sp = burst * (0.6 + 0.8 * rng.next());
    const ch = pool.add(
      core,
      pix,
      emi,
      bw,
      bh,
      sx - minX[s]!,
      sy - minY[s]!,
      wx,
      wy,
      parent.vx + dx * sp,
      parent.vy + dy * sp,
      parent.spin + (rng.next() - 0.5) * 6,
      m,
      parent.origin,
      parent.brittle,
      parent.heat,
    );
    ch.angle = parentAngle;
    ch.grace = 12;
    lastChunk = ch;
  }
  // Rounding remainder (and the share of any empty group) stays with the last shard so mass is conserved exactly.
  if (lastChunk !== null && massLeft !== 0) {
    lastChunk.mass += massLeft;
    pool.massLive += massLeft;
  } else if (massLeft !== 0) core.ledger.dissipated += massLeft;
  return true;
}

/* ---------------------------------------------------------------------------------------------- *
 *  Physics
 * ---------------------------------------------------------------------------------------------- */

const CHUNK_DRAG = 0.32; // per second: slow drift, long persistence ("the arena is a record of the fight")
const SPIN_DRAG = 0.22;

export function stepChunks(core: WorldCore): void {
  const pool = core.chunks;
  const dt = TICK_DT;
  const a = core.arena;
  const g0 = core.gravity[0];
  const g1 = core.gravity[1];
  const anyField = g0.active || g1.active;
  const kd = 1 - CHUNK_DRAG * dt;
  const sd = 1 - SPIN_DRAG * dt;
  const wall = 60; // soft wall zone
  for (let s = 0; s < pool.hi; s++) {
    const c = pool.list[s]!;
    if (!c.alive) continue;
    c.age++;
    if (c.heat > 0) c.heat = c.heat * 0.985 - 0.05 > 0 ? c.heat * 0.985 - 0.05 : 0;
    // Gravel wears away: small old chunks degrade to dust so big remains stay the record of the fight.
    if (c.mass < 5 && c.age > 1500) {
      degradeToDust(core, c);
      pool.freeAt(s);
      continue;
    }
    if (c.asleep && !anyField) {
      if (core.tick % 8 === 0) collideBodies(core, c);
      continue;
    }
    let vx = c.vx;
    let vy = c.vy;
    if (anyField) {
      if (g0.active) {
        const dx = g0.x - c.x;
        const dy = g0.y - c.y;
        const d2 = dx * dx + dy * dy;
        const R = g0.radius;
        if (d2 < R * R) {
          const d = Math.sqrt(d2) + 1e-6;
          if (g0.consumeRadius > 0 && d < g0.consumeRadius + c.radius * 0.25) {
            consumeChunk(core, pool, c, s, g0.creditBodyId);
            continue;
          }
          const acc = (g0.strength * 2 * (1 - d / R)) / d;
          vx += dx * acc * dt;
          vy += dy * acc * dt;
          c.asleep = false;
        }
      }
      if (g1.active) {
        const dx = g1.x - c.x;
        const dy = g1.y - c.y;
        const d2 = dx * dx + dy * dy;
        const R = g1.radius;
        if (d2 < R * R) {
          const d = Math.sqrt(d2) + 1e-6;
          if (g1.consumeRadius > 0 && d < g1.consumeRadius + c.radius * 0.25) {
            consumeChunk(core, pool, c, s, g1.creditBodyId);
            continue;
          }
          const acc = (g1.strength * 2 * (1 - d / R)) / d;
          vx += dx * acc * dt;
          vy += dy * acc * dt;
          c.asleep = false;
        }
      }
    }
    vx *= kd;
    vy *= kd;
    c.spin *= sd;
    // Soft arena walls: a spring that eases chunks back in (never a hard clamp, so debris can still drift a bit outside).
    if (c.x < a.minX + wall) vx += (a.minX + wall - c.x) * 2.2 * dt;
    else if (c.x > a.maxX - wall) vx -= (c.x - (a.maxX - wall)) * 2.2 * dt;
    if (c.y < a.minY + wall) vy += (a.minY + wall - c.y) * 2.2 * dt;
    else if (c.y > a.maxY - wall) vy -= (c.y - (a.maxY - wall)) * 2.2 * dt;
    c.vx = vx;
    c.vy = vy;
    c.x += vx * dt;
    c.y += vy * dt;
    c.angle += c.spin * dt;
    if (!anyField && vx * vx + vy * vy < 3 && Math.abs(c.spin) < 0.08) {
      c.vx = 0;
      c.vy = 0;
      c.spin = 0;
      c.asleep = true;
    }
    if (c.age >= c.noHitUntil) collideBodies(core, c);
  }
}

function consumeChunk(core: WorldCore, pool: ChunkPool, c: Chunk, slot: number, creditBody: number): void {
  const m = c.mass;
  // Route mass before releasing: pool.massLive drops by m, body pool gains m.
  core.creditMass(creditBody, m, c.x, c.y, c.origin, 'consume');
  pool.freeAt(slot);
}

/** Chunk vs bodies: fast heavy chunks deal a capped KINETIC impact and bounce; slow ones are nudged out. */
function collideBodies(core: WorldCore, c: Chunk): void {
  const bl = core.bodyList;
  for (let bi = 0; bi < bl.length; bi++) {
    const b = bl[bi]!;
    if (!b.takesDebrisImpacts) continue;
    if (b.id === c.origin && c.age < c.grace + 40) continue;
    const r = c.radius;
    if (c.x + r < b.aabbX0 || c.x - r > b.aabbX1 || c.y + r < b.aabbY0 || c.y - r > b.aabbY1) continue;
    // Probe the centre and four points at 0.55 radius on the chunk's rotated axes.
    const cs = Math.cos(c.angle);
    const sn = Math.sin(c.angle);
    const rr = r * 0.55;
    let hits = 0;
    let hx = 0;
    let hy = 0;
    for (let k = 0; k < 5; k++) {
      let px = c.x;
      let py = c.y;
      if (k > 0) {
        const ax = k === 1 ? rr : k === 2 ? -rr : 0;
        const ay = k === 3 ? rr : k === 4 ? -rr : 0;
        px += ax * cs - ay * sn;
        py += ax * sn + ay * cs;
      }
      const ci = b.cellAtWorld(px, py);
      if (ci >= 0 && b.map.material[ci] !== 0 && b.map.integrity[ci] !== 0) {
        hits++;
        hx += px;
        hy += py;
      }
    }
    if (hits === 0) continue;
    hx /= hits;
    hy /= hits;
    const rvx = c.vx - b.vx;
    const rvy = c.vy - b.vy;
    const speed = Math.sqrt(rvx * rvx + rvy * rvy);
    // Direction out of the body: from its core to the chunk.
    const t = b.transform;
    let nx = c.x - t.x;
    let ny = c.y - t.y;
    const nl = Math.sqrt(nx * nx + ny * ny) + 1e-6;
    nx /= nl;
    ny /= nl;
    const vn = rvx * nx + rvy * ny;
    if (speed > 120 && c.mass > 1.2 && vn < 0 && core.tick >= b.debrisImmuneUntil) {
      core.chunkImpact(b, c, hx, hy, rvx / speed, rvy / speed, speed);
      // Bounce with heavy loss, shed some spin.
      const e = 0.35;
      c.vx = c.vx - (1 + e) * vn * nx;
      c.vy = c.vy - (1 + e) * vn * ny;
      c.vx += b.vx * 0.3;
      c.vy += b.vy * 0.3;
      c.spin += (core.rng.next() - 0.5) * 8;
      c.noHitUntil = c.age + 18; // brief immunity so one bounce is not counted twice
      c.asleep = false;
      // Push clear so it does not sit inside the body.
      c.x += nx * 2;
      c.y += ny * 2;
      if (c.brittle > 0.6 && speed > 170 && c.mass > 6 && core.chunks.count < core.chunks.cap - 4) {
        splitChunk(core, core.chunks, c, 2 + (speed > 260 ? 1 : 0), hx, hy, speed * 0.25);
        return;
      }
    } else {
      // Gentle push out so slow debris does not accumulate inside a titan.
      c.vx += nx * 22 * TICK_DT;
      c.vy += ny * 22 * TICK_DT;
      c.asleep = false;
    }
    return;
  }
}

/* ---------------------------------------------------------------------------------------------- *
 *  Rasterisation
 * ---------------------------------------------------------------------------------------------- */

const LIT = new Int32Array(8);

/** Rasterise all visible chunks into the back and front screen layers. */
export function rasterChunks(
  core: WorldCore,
  view: ViewRect,
  alpha: number,
  backPix: Uint32Array,
  backEmi: Uint8Array,
  frontPix: Uint32Array,
  frontEmi: Uint8Array,
  backRange: { a: number; b: number },
  frontRange: { a: number; b: number },
): void {
  const pool = core.chunks;
  const W = LOGICAL_W;
  const H = LOGICAL_H;
  const ext = alpha * TICK_DT;
  // Edge-lighting LUT: outward normal index k (0..7 => angle k*45° from +x, clockwise on screen) vs the stage light.
  const L = core.lighting;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const lit = Math.cos(a) * L.lx + Math.sin(a) * L.ly;
    LIT[k] = Math.round(256 * (1 + 0.5 * lit));
  }
  for (let s = 0; s < pool.hi; s++) {
    const c = pool.list[s]!;
    if (!c.alive) continue;
    const sx = c.x + c.vx * ext - view.x0;
    const sy = c.y + c.vy * ext - view.y0;
    const R = c.radius + 1;
    if (sx + R < 0 || sy + R < 0 || sx - R >= W || sy - R >= H) continue;
    const q = Math.round(c.angle / QSTEP);
    const th = q * QSTEP;
    const cs = Math.cos(th);
    const sn = Math.sin(th);
    const rotSteps = ((q * 8) / QUANT) | 0; // approx normal rotation in 45° units
    // Chunks behind the titans are a touch darker: cheap depth.
    const depthDim = c.front ? 256 : 214;
    const pix = c.front ? frontPix : backPix;
    const emi = c.front ? frontEmi : backEmi;
    const range = c.front ? frontRange : backRange;
    const y0 = Math.max(0, Math.floor(sy - R));
    const y1 = Math.min(H - 1, Math.ceil(sy + R));
    const { pixels, w, h, nrm } = c;
    const hasE = c.hasEmis;
    const emis = c.emis;
    const heat = c.heat;
    const heatE = heat > 6 ? Math.min(255, heat) : 0;
    if (y0 < range.a) range.a = y0;
    if (y1 > range.b) range.b = y1;
    for (let dy = y0; dy <= y1; dy++) {
      const ry = dy + 0.5 - sy;
      // chord of the bounding circle limits x extent
      const disc = R * R - ry * ry;
      if (disc < 0) continue;
      const half = Math.sqrt(disc);
      const x0 = Math.max(0, Math.floor(sx - half));
      const x1 = Math.min(W - 1, Math.ceil(sx + half));
      // sprite coords at (x0 + 0.5): u = cs*rx + sn*ry + cx ; v = -sn*rx + cs*ry + cy
      let rx = x0 + 0.5 - sx;
      let u = cs * rx + sn * ry + c.cx;
      let v = -sn * rx + cs * ry + c.cy;
      const dU = cs;
      const dV = -sn;
      for (let dx = x0; dx <= x1; dx++, u += dU, v += dV) {
        if (u < 0 || v < 0) continue;
        const iu = u | 0;
        const iv = v | 0;
        if (iu >= w || iv >= h) continue;
        const si = iv * w + iu;
        let p = pixels[si]! | 0;
        if (p >>> 24 === 0) continue;
        const nk = nrm[si]!;
        if (nk !== 0) {
          const lk = LIT[(nk - 1 + rotSteps) & 7]!;
          p = scalePx(p, lk);
          // Rim facing away from the key light: a 1-px dark, hue-shifted (cool violet) edge that separates the chunk from a bright scene.
          if (lk < 232) p = lerpPx(p, 0xff4a2436, 150);
        }
        // Undersides sit in shade: top of the chunk full, bottom ~25% darker.
        p = scalePx(p, (284 - ((dy - sy + R) * 60) / (2 * R)) | 0);
        if (depthDim !== 256) p = scalePx(p, depthDim);
        const o = dy * W + dx;
        pix[o] = p;
        let e = hasE ? emis[si]! : 0;
        if (heatE > e) e = heatE;
        if (e > 0) emi[o] = e;
      }
      rx = 0;
    }
  }
}

/** For tests: exported kind ids. */
export const CHUNK_DUST_KIND = PK.dust;
