import type { Chunk } from './chunks';
import type { WorldCore } from './core';

/**
 * Analytic hurt capsules in the matter world (Gate 3A §2, D37): a fighter that is not matter (the Mouth) hands the world its
 * capsules every tick (`setCapsules`), and debris meets them by the same rules it meets bodies (D30):
 *  - a chunk wounds only by its OWN speed (> 120 px/s) and mass (> 1.2), never as a fresh wound slab;
 *  - it bounces off (restitution 0.35) and is pushed clear; slow debris is nudged out;
 *  - a thrown chunk (launched) lands an uncapped blow; it never hits its thrower's slot.
 * The world does not damage the capsules itself: each impact is queued (`drainCapsuleHits`) for the owning fighter, which
 * applies its own damage model (coil −2 × power, neck, head).
 */

/** Floats per capsule: x0, y0, x1, y1, r, part (0 head, 1 neck, 2 coil). */
export const CAPSULE_STRIDE = 6;
export const MAX_CAPSULES = 48;
/** Floats per queued hit: x, y, energy, part, launched (0/1), chunk mass. */
export const CAPSULE_HIT_STRIDE = 6;
const MAX_HITS = 16;
/** Debris below this own speed does not wound (D30's DEBRIS_WOUND_SPEED). */
const WOUND_SPEED = 120;
/** Fresh wound slabs bounce for this many ticks without wounding (chunks.ts FRESH_SLAB_TICKS). */
const FRESH_TICKS = 60;
/** At most this much debris energy per tick per slot (world.ts DEBRIS_TICK_BUDGET's spirit). */
const TICK_BUDGET = 300;

export class CapsuleSet {
  readonly data = new Float64Array(MAX_CAPSULES * CAPSULE_STRIDE);
  n = 0;
  /** Union box (broadphase). */
  x0 = 0;
  y0 = 0;
  x1 = 0;
  y1 = 0;
  readonly hits = new Float64Array(MAX_HITS * CAPSULE_HIT_STRIDE);
  nHits = 0;
  tickEnergy = 0;
  energyTick = -1;

  set(src: ArrayLike<number>, n: number): void {
    n = Math.min(n, MAX_CAPSULES);
    this.n = n;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < n * CAPSULE_STRIDE; i++) this.data[i] = src[i]!;
    for (let i = 0; i < n; i++) {
      const o = i * CAPSULE_STRIDE;
      const r = this.data[o + 4]!;
      x0 = Math.min(x0, this.data[o]! - r, this.data[o + 2]! - r);
      y0 = Math.min(y0, this.data[o + 1]! - r, this.data[o + 3]! - r);
      x1 = Math.max(x1, this.data[o]! + r, this.data[o + 2]! + r);
      y1 = Math.max(y1, this.data[o + 1]! + r, this.data[o + 3]! + r);
    }
    this.x0 = x0;
    this.y0 = y0;
    this.x1 = x1;
    this.y1 = y1;
  }

  private push(x: number, y: number, energy: number, part: number, launched: boolean, mass: number): void {
    if (this.nHits >= MAX_HITS) return;
    const o = this.nHits++ * CAPSULE_HIT_STRIDE;
    this.hits[o] = x;
    this.hits[o + 1] = y;
    this.hits[o + 2] = energy;
    this.hits[o + 3] = part;
    this.hits[o + 4] = launched ? 1 : 0;
    this.hits[o + 5] = mass;
  }

  /** Copy the queued hits into `out` (flat, CAPSULE_HIT_STRIDE each) and clear the queue; returns how many. */
  drain(out: number[]): number {
    const n = this.nHits;
    out.length = n * CAPSULE_HIT_STRIDE;
    for (let i = 0; i < n * CAPSULE_HIT_STRIDE; i++) out[i] = this.hits[i]!;
    this.nHits = 0;
    return n;
  }

  /** Chunk vs these capsules (called from the chunk step). Returns true if it touched one. */
  collide(core: WorldCore, c: Chunk, slot: number, launchedMode: number, freshFast: boolean): boolean {
    if (this.n === 0) return false;
    const r = c.radius * 0.6;
    if (c.x + r < this.x0 || c.x - r > this.x1 || c.y + r < this.y0 || c.y - r > this.y1) return false;
    const launched = c.mode === launchedMode;
    if (launched && c.owner === slot) return false;
    for (let i = 0; i < this.n; i++) {
      const o = i * CAPSULE_STRIDE;
      const ax = this.data[o]!;
      const ay = this.data[o + 1]!;
      const bx = this.data[o + 2]!;
      const by = this.data[o + 3]!;
      const cr = this.data[o + 4]!;
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const u = l2 > 1e-9 ? Math.max(0, Math.min(1, ((c.x - ax) * dx + (c.y - ay) * dy) / l2)) : 0;
      const qx = ax + dx * u;
      const qy = ay + dy * u;
      let nx = c.x - qx;
      let ny = c.y - qy;
      const d = Math.sqrt(nx * nx + ny * ny);
      if (d > cr + r) continue;
      nx = d > 1e-6 ? nx / d : 0;
      ny = d > 1e-6 ? ny / d : -1;
      const vn = c.vx * nx + c.vy * ny;
      const own = Math.sqrt(c.vx * c.vx + c.vy * c.vy);
      if (vn < 0 && (launched || (own > WOUND_SPEED && c.mass > 1.2))) {
        if (launched) {
          const v = own / 60;
          this.push(qx + nx * cr, qy + ny * cr, 0.5 * c.mass * v * v, this.data[o + 5]!, true, c.mass);
        } else if (!(c.fast && freshFast)) {
          if (this.energyTick !== core.tick) {
            this.energyTick = core.tick;
            this.tickEnergy = 0;
          }
          const ex = Math.max(0, own - 100) / 60;
          const e = Math.min(TICK_BUDGET - this.tickEnergy, 0.5 * c.mass * ex * ex * 2.2);
          if (e >= 2) {
            this.tickEnergy += e;
            this.push(qx + nx * cr, qy + ny * cr, e, this.data[o + 5]!, false, c.mass);
          }
        }
        // bounce with heavy loss (the bodies' rule), shed some spin
        const k = 1.35;
        c.vx -= k * vn * nx;
        c.vy -= k * vn * ny;
        c.spin += (core.rng.next() - 0.5) * 6;
        c.noHitUntil = c.age + 18;
        c.asleep = false;
      } else {
        // slow debris is eased out (the arena's wreckage drifts round the neck, not through it)
        c.vx += nx * 22 * (1 / 60);
        c.vy += ny * 22 * (1 / 60);
        c.asleep = false;
      }
      // pushed clear of the surface
      const push = cr + r - d;
      if (push > 0) {
        c.x += nx * Math.min(push, 3);
        c.y += ny * Math.min(push, 3);
      }
      return true;
    }
    return false;
  }
}

/** Both slots' capsule sets meet a chunk (the chunk step's hook). */
export function collideCapsules(core: WorldCore, c: Chunk, launchedMode: number): void {
  const fresh = c.age < FRESH_TICKS;
  for (let s = 0; s < 2; s++) if (core.capsules[s]!.collide(core, c, s, launchedMode, fresh)) return;
}
