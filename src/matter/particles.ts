import { LOGICAL_H, LOGICAL_W, MAX_PARTICLES, TICK_DT, type ParticleKind, type ViewRect } from '@/contracts';
import type { WorldCore } from './core';
import { BAYER4, lerpPx, scalePx } from './util';

/** Particle kinds (Uint8). Order matches contracts ParticleKind. */
export const PK = {
  spark: 0,
  ember: 1,
  dust: 2,
  gas: 3,
  ash: 4,
  glint: 5,
  plasma: 6,
  shard: 7,
  mote: 8,
} as const;
export const KIND_ID: Record<ParticleKind, number> = {
  spark: 0,
  ember: 1,
  dust: 2,
  gas: 3,
  ash: 4,
  glint: 5,
  plasma: 6,
  shard: 7,
  mote: 8,
};

/** Particle flag bits. */
export const PF_STRETCH = 1;
export const PF_HARVEST = 2;
/** Near-camera puff: drawn into the 2x near layer with class parallax, growing as it ages (a plume thrown at the viewer). */
export const PF_NEAR = 4;

const MAX_RAMPS = 512;
const RAMP_STRIDE = 8;

/** Pooled struct-of-arrays particle system. Never allocates after construction. */
export class ParticlePool {
  readonly cap: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly life: Uint16Array;
  readonly lifeMax: Uint16Array;
  readonly kind: Uint8Array;
  readonly size: Uint8Array;
  readonly emis: Uint8Array;
  readonly rampId: Uint16Array;
  readonly fieldScale: Float32Array;
  readonly drag: Float32Array;
  readonly mass: Float32Array;
  /** Body id credited when the particle is consumed (-1 = none) and the body it came from. */
  readonly credit: Int16Array;
  readonly origin: Int16Array;
  readonly sinkX: Float32Array;
  readonly sinkY: Float32Array;
  /** Homing acceleration toward the sink (px/s²); 0 = free flight. */
  readonly homing: Float32Array;
  readonly flags: Uint8Array;
  private readonly freeList: Int32Array;
  private freeTop: number;
  private ring = 0;
  /** High-water mark: slots >= hi have never been used. */
  hi = 0;
  count = 0;
  /** Σ mass of live particles (kept in float64 for the ledger). */
  massLive = 0;

  readonly rampColors = new Uint32Array(MAX_RAMPS * RAMP_STRIDE);
  readonly rampLen = new Uint8Array(MAX_RAMPS);
  rampCount = 0;

  constructor(cap = MAX_PARTICLES) {
    this.cap = cap;
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.life = new Uint16Array(cap);
    this.lifeMax = new Uint16Array(cap);
    this.kind = new Uint8Array(cap);
    this.size = new Uint8Array(cap);
    this.emis = new Uint8Array(cap);
    this.rampId = new Uint16Array(cap);
    this.fieldScale = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.mass = new Float32Array(cap);
    this.credit = new Int16Array(cap).fill(-1);
    this.origin = new Int16Array(cap).fill(-1);
    this.sinkX = new Float32Array(cap);
    this.sinkY = new Float32Array(cap);
    this.homing = new Float32Array(cap);
    this.flags = new Uint8Array(cap);
    this.freeList = new Int32Array(cap);
    this.freeTop = 0;
  }

  /** Intern a packed colour ramp (bright -> dark over life). Returns its id. Linear scan: call per spawn batch, not per particle. */
  internRamp(colors: ArrayLike<number>): number {
    const len = Math.min(RAMP_STRIDE, colors.length);
    for (let r = 0; r < this.rampCount; r++) {
      if (this.rampLen[r] !== len) continue;
      let same = true;
      for (let k = 0; k < len; k++)
        if (this.rampColors[r * RAMP_STRIDE + k] !== colors[k]! >>> 0) {
          same = false;
          break;
        }
      if (same) return r;
    }
    if (this.rampCount >= MAX_RAMPS) return 0; // table full: reuse the first ramp rather than allocate
    const r = this.rampCount++;
    this.rampLen[r] = len;
    for (let k = 0; k < len; k++) this.rampColors[r * RAMP_STRIDE + k] = colors[k]! >>> 0;
    return r;
  }

  /** Claim a slot; when full the ring pointer recycles the next slot (its mass dissipates). */
  alloc(core: WorldCore): number {
    let s: number;
    if (this.freeTop > 0) {
      s = this.freeList[--this.freeTop]!;
    } else if (this.hi < this.cap) {
      s = this.hi++;
    } else {
      s = this.ring;
      this.ring = (this.ring + 1) % this.cap;
      // Steal the slot: its carried mass dissipates. (Not returned to the free list: we reuse it right now.)
      const m = this.mass[s]!;
      if (m !== 0) {
        this.massLive -= m;
        core.ledger.dissipated += m;
        this.mass[s] = 0;
      }
      this.count--;
    }
    this.count++;
    return s;
  }

  /** Remove particle `s`; its carried mass dissipates (unless credited by the caller first). */
  kill(core: WorldCore, s: number, alreadyAccounted: boolean): void {
    if (this.life[s] === 0) return;
    const m = this.mass[s]!;
    if (m !== 0) {
      this.massLive -= m;
      if (!alreadyAccounted) core.ledger.dissipated += m;
      this.mass[s] = 0;
    }
    this.life[s] = 0;
    this.freeList[this.freeTop++] = s;
    this.count--;
  }

  /** Full-parameter spawn. Returns the slot. `mass` is carried mass in mass units (0 for pure VFX). */
  spawn(
    core: WorldCore,
    kind: number,
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
    size: number,
    emis: number,
    rampId: number,
    fieldScale: number,
    drag: number,
    mass: number,
  ): number {
    const s = this.alloc(core);
    this.x[s] = x;
    this.y[s] = y;
    this.vx[s] = vx;
    this.vy[s] = vy;
    const l = life < 1 ? 1 : life > 65000 ? 65000 : life | 0;
    this.life[s] = l;
    this.lifeMax[s] = l;
    this.kind[s] = kind;
    this.size[s] = size;
    this.emis[s] = emis;
    this.rampId[s] = rampId;
    this.fieldScale[s] = fieldScale;
    this.drag[s] = drag;
    this.mass[s] = mass;
    this.massLive += this.mass[s]!;
    this.credit[s] = -1;
    this.origin[s] = -1;
    this.homing[s] = 0;
    this.flags[s] = 0;
    return s;
  }

  /** Advance all particles one tick: drag, gravity sources, homing, consumption. */
  step(core: WorldCore): void {
    const dt = TICK_DT;
    const { x, y, vx, vy, life } = this;
    const g0 = core.gravity[0];
    const g1 = core.gravity[1];
    const hi = this.hi;
    for (let s = 0; s < hi; s++) {
      let l = life[s]!;
      if (l === 0) continue;
      l--;
      if (l === 0) {
        life[s] = 1;
        this.kill(core, s, false);
        continue;
      }
      life[s] = l;
      let px = x[s]!;
      let py = y[s]!;
      let pvx = vx[s]!;
      let pvy = vy[s]!;
      const dr = this.drag[s]!;
      if (dr > 0) {
        const k = 1 - dr * dt;
        pvx *= k;
        pvy *= k;
      }
      const fs = this.fieldScale[s]!;
      if (fs > 0) {
        if (g0.active) {
          const dx = g0.x - px;
          const dy = g0.y - py;
          const d2 = dx * dx + dy * dy;
          const R = g0.radius;
          if (d2 < R * R) {
            const d = Math.sqrt(d2) + 1e-6;
            if (g0.consumeRadius > 0 && d < g0.consumeRadius) {
              this.consume(core, s, g0.creditBodyId, px, py);
              continue;
            }
            const a = (g0.strength * 2 * (1 - d / R) * fs) / d;
            pvx += dx * a * dt;
            pvy += dy * a * dt;
          }
        }
        if (g1.active) {
          const dx = g1.x - px;
          const dy = g1.y - py;
          const d2 = dx * dx + dy * dy;
          const R = g1.radius;
          if (d2 < R * R) {
            const d = Math.sqrt(d2) + 1e-6;
            if (g1.consumeRadius > 0 && d < g1.consumeRadius) {
              this.consume(core, s, g1.creditBodyId, px, py);
              continue;
            }
            const a = (g1.strength * 2 * (1 - d / R) * fs) / d;
            pvx += dx * a * dt;
            pvy += dy * a * dt;
          }
        }
      }
      const hm = this.homing[s]!;
      if (hm > 0) {
        let sinkX = this.sinkX[s]!;
        let sinkY = this.sinkY[s]!;
        const cb = this.credit[s]!;
        if (cb >= 0) {
          const slot = core.bodySlot(cb);
          if (slot >= 0 && core.gravity[slot]!.active) {
            sinkX = core.gravity[slot]!.x;
            sinkY = core.gravity[slot]!.y;
          }
        }
        const dx = sinkX - px;
        const dy = sinkY - py;
        const d = Math.sqrt(dx * dx + dy * dy) + 1e-6;
        if (d < 10) {
          this.consume(core, s, cb, px, py);
          continue;
        }
        // Central pull, a modest tangential (swirl) push, and damping of the tangential velocity: angular momentum is kept at
        // launch, then bleeds off, so streams SPIRAL in instead of orbiting forever.
        const ax = dx / d;
        const ay = dy / d;
        // Older streams are pulled harder and lose their swirl faster: arrival is guaranteed, the spiral stays graceful.
        const age = 1 - l / this.lifeMax[s]!;
        const hmE = hm * (1 + 4 * age * age);
        const ramp = 0.45 + Math.min(1.6, 90 / d);
        const tx = -ay;
        const ty = ax;
        const vt = pvx * tx + pvy * ty;
        const swirl = 0.16 * Math.min(1, d / 80);
        const damp = 3.5 + 12 * age;
        pvx += (ax * hmE * ramp + tx * hmE * swirl * ramp - tx * vt * damp) * dt;
        pvy += (ay * hmE * ramp + ty * hmE * swirl * ramp - ty * vt * damp) * dt;
        const sp2 = pvx * pvx + pvy * pvy;
        const cap = 620;
        if (sp2 > cap * cap) {
          const k = cap / Math.sqrt(sp2);
          pvx *= k;
          pvy *= k;
        }
      }
      px += pvx * dt;
      py += pvy * dt;
      x[s] = px;
      y[s] = py;
      vx[s] = pvx;
      vy[s] = pvy;
    }
  }

  /** Particle reached a sink: credit its mass to `bodyId` (or dissipate if there is no such body). */
  private consume(core: WorldCore, s: number, bodyId: number, px: number, py: number): void {
    const m = this.mass[s]!;
    if (m > 0) {
      this.massLive -= m;
      this.mass[s] = 0;
      core.creditMass(bodyId, m, px, py, this.origin[s]!, this.flags[s]! & 2 ? 'harvest' : 'consume');
    }
    this.life[s] = 0;
    this.freeList[this.freeTop++] = s;
    this.count--;
  }

  /** Kill every live particle (carried mass dissipates). Used by carve() so a harness state starts without a dust storm. */
  purge(core: WorldCore): void {
    for (let s = 0; s < this.hi; s++) if (this.life[s]! > 0) this.kill(core, s, false);
  }

  /** Reset (tests / world reset). */
  clear(): void {
    this.life.fill(0);
    this.mass.fill(0);
    this.freeTop = 0;
    this.hi = 0;
    this.ring = 0;
    this.count = 0;
    this.massLive = 0;
  }
}

/* ---------------------------------------------------------------------------------------------- *
 *  Rasterisation of particles into a screen-space layer (pixel-art dithering instead of alpha)
 * ---------------------------------------------------------------------------------------------- */

/** Writes particles into `pix`/`emi` (LOGICAL_W×LOGICAL_H). Returns [minY, maxY] touched via core.rasterY. */
export function rasterParticles(
  pool: ParticlePool,
  view: ViewRect,
  alpha: number,
  pix: Uint32Array,
  emi: Uint8Array,
  yRange: { a: number; b: number },
  nearPix?: Uint32Array,
  nearEmi?: Uint8Array,
  nearRange?: { a: number; b: number },
): void {
  const W = LOGICAL_W;
  const H = LOGICAL_H;
  const vx0 = view.x0;
  const vy0 = view.y0;
  const ext = alpha * TICK_DT;
  const hi = pool.hi;
  const { x, y, vx, vy, life, lifeMax, kind, size, emis, rampId, flags } = pool;
  const rc = pool.rampColors;
  const rl = pool.rampLen;
  let minY = yRange.a;
  let maxY = yRange.b;
  for (let s = 0; s < hi; s++) {
    const l = life[s]!;
    if (l === 0) continue;
    if ((flags[s]! & PF_NEAR) !== 0) {
      if (nearPix && nearEmi && nearRange) drawNearPuff(pool, s, view, ext, nearPix, nearEmi, nearRange);
      continue;
    }
    const pvx = vx[s]!;
    const pvy = vy[s]!;
    const px = Math.floor(x[s]! + pvx * ext - vx0);
    const py = Math.floor(y[s]! + pvy * ext - vy0);
    if (px < -6 || py < -6 || px >= W + 6 || py >= H + 6) continue;
    const lm = lifeMax[s]!;
    const frac = l / lm; // 1 -> 0 over life
    const k = kind[s]!;
    const rid = rampId[s]!;
    const len = rl[rid]!;
    const ci = len <= 1 ? 0 : Math.min(len - 1, Math.floor((1 - frac) * len));
    const col = rc[rid * RAMP_STRIDE + ci]! | 0;
    let sz = size[s]!;
    let em = emis[s]!;
    // Soft kinds fade with ordered dither in the last third of life.
    let thr = 16;
    const soft = k === PK.dust || k === PK.gas || k === PK.ash || k === PK.mote;
    if (soft) {
      const f = frac < 0.4 ? frac / 0.4 : 1;
      thr = Math.max(1, Math.ceil(f * 16));
    }
    if (k === PK.gas) sz = sz + Math.floor((1 - frac) * 2);
    if (em > 0 && frac < 0.3) em = (em * frac) / 0.3;
    const e8 = em | 0;
    if (flags[s]! & PF_STRETCH) {
      // Streak along the velocity: spaghettified matter. Length grows with speed.
      const sp = Math.sqrt(pvx * pvx + pvy * pvy);
      const n = Math.min(7, 1 + Math.floor(sp / 55));
      // Falling matter heats up with speed (tidal friction): tint toward white-hot, then orange-hot, as it nears the sink.
      let scol = col;
      let se = e8;
      if (sp > 150 && !(flags[s]! & PF_HARVEST)) {
        const hh = Math.min(1, (sp - 150) / 260);
        scol =
          hh < 0.5
            ? lerpPx(col, 0xffe6f8ff, (hh * 2 * 230) | 0)
            : lerpPx(0xffe6f8ff, 0xff3c96ff, ((hh - 0.5) * 2 * 210) | 0);
        if (se < 150) se = 150;
      }

      const ux = sp > 1e-3 ? pvx / sp : 0;
      const uy = sp > 1e-3 ? pvy / sp : 0;
      for (let q = 0; q < n; q++) {
        const qx = Math.floor(x[s]! + pvx * ext - vx0 - ux * q);
        const qy = Math.floor(y[s]! + pvy * ext - vy0 - uy * q);
        if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
        const o = qy * W + qx;
        pix[o] = q === 0 ? scol : (scol & 0x00ffffff) | 0xff000000;
        if (se > emi[o]!) emi[o] = q === 0 ? se : se >> 1;
        if (qy < minY) minY = qy;
        if (qy > maxY) maxY = qy;
      }
      continue;
    }
    if (sz <= 1) {
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      if (thr < 16 && BAYER4[((py & 3) << 2) | (px & 3)]! >= thr) continue;
      const o = py * W + px;
      pix[o] = col;
      if (e8 > emi[o]!) emi[o] = e8;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    } else {
      const r = sz >> 1;
      const x0 = px - r;
      const y0 = py - r;
      const w2 = sz;
      for (let yy = 0; yy < w2; yy++) {
        const sy = y0 + yy;
        if (sy < 0 || sy >= H) continue;
        for (let xx = 0; xx < w2; xx++) {
          const sx = x0 + xx;
          if (sx < 0 || sx >= W) continue;
          // Round the corners of bigger blobs so they read as soft puffs rather than squares.
          if (sz >= 3 && (xx === 0 || xx === w2 - 1) && (yy === 0 || yy === w2 - 1)) continue;
          if (sz >= 6) {
            const cx = xx - (w2 - 1) / 2;
            const cy = yy - (w2 - 1) / 2;
            if (cx * cx + cy * cy > (w2 * w2) / 4) continue;
          }
          if (thr < 16 && BAYER4[((sy & 3) << 2) | (sx & 3)]! >= thr) continue;
          const o = sy * W + sx;
          pix[o] = col;
          if (e8 > emi[o]!) emi[o] = e8;
          if (sy < minY) minY = sy;
          if (sy > maxY) maxY = sy;
        }
      }
    }
  }
  yRange.a = minY;
  yRange.b = maxY;
}

/** A big soft puff in the near (2x) layer: pixel-doubled, dither-faded, growing with age. */
function drawNearPuff(
  pool: ParticlePool,
  s: number,
  view: ViewRect,
  ext: number,
  pix: Uint32Array,
  emi: Uint8Array,
  range: { a: number; b: number },
): void {
  const W = LOGICAL_W;
  const H = LOGICAL_H;
  const frac = pool.life[s]! / pool.lifeMax[s]!;
  const sx = Math.floor(pool.x[s]! + pool.vx[s]! * ext - view.x0);
  const sy = Math.floor(pool.y[s]! + pool.vy[s]! * ext - view.y0);
  const base = pool.size[s]!;
  const d = Math.round((base + (1 - frac) * base * 0.9) * 2);
  const r = d / 2;
  if (sx + r < 0 || sy + r < 0 || sx - r >= W || sy - r >= H) return;
  const rid = pool.rampId[s]!;
  const len = pool.rampLen[rid]!;
  const ci = len <= 1 ? 0 : Math.min(len - 1, Math.floor((1 - frac) * len));
  const col = pool.rampColors[rid * RAMP_STRIDE + ci]! | 0;
  const thr = Math.max(1, Math.ceil(Math.min(1, frac / 0.5) * 12));
  const y0 = Math.max(0, Math.floor(sy - r));
  const y1 = Math.min(H - 1, Math.ceil(sy + r));
  if (y0 < range.a) range.a = y0;
  if (y1 > range.b) range.b = y1;
  for (let y = y0; y <= y1; y++) {
    for (let x = Math.max(0, Math.floor(sx - r)); x <= Math.min(W - 1, Math.ceil(sx + r)); x++) {
      const dx = x + 0.5 - sx;
      const dy = y + 0.5 - sy;
      if (dx * dx + dy * dy > r * r) continue;
      if (BAYER4[((y & 3) << 2) | (x & 3)]! >= thr) continue;
      // Underside shade: the lower half of a puff is darker (volume).
      const sh = (256 - Math.max(0, Math.min(90, ((dy + r) * 90) / (2 * r)))) | 0;
      const o = y * W + x;
      pix[o] = scalePx(col, sh);
      emi[o] = 0;
    }
  }
}
