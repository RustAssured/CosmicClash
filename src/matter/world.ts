import {
  DamageFlag,
  MAX_BODY_DIM,
  MAX_PARTICLES,
  TICK_DT,
  type ArenaInfo,
  type BodySpec,
  type BodyStats,
  type ChunkSpawn,
  type DamageEvent,
  type DamageResult,
  type DamageShape,
  type DebugOverlayMode,
  type GravitySource,
  type GrowSpec,
  type MatterBody,
  type MatterWorld,
  type OverlapResult,
  type ParticleSpawn,
  type RenderLayer,
  type SimEvent,
  type StageLighting,
  type ViewRect,
} from '@/contracts';
import { Body, type WorldPoint, CONN_NOW, CONN_STEADY } from './body';
import { initBody } from './bodyinit';
import { stepChunks } from './chunks';
import { runConnectivity } from './connectivity';
import { stepFronts } from './cracks';
import { WorldCore } from './core';
import { beginDamage, DamageCtx } from './dmg';
import { CHISEL_DELAY, applyFracture, chisel } from './fracture';
import { hashWorld } from './hash';
import { applyKinetic, stepFuses } from './kinetic';
import { KIND_ID } from './particles';
import { mix32 } from './util';
import { endSpray } from './debris';
import { MatterRender } from './render';
import { refreshVisuals } from './visual';
import * as life from './lifecycle';
import { applyCrush, stepWaves } from './crush';
import { applyThermal, stepThermal } from './thermal';
import { applyTidal } from './tidal';
import { applyAssimilation, stepInfection } from './assimilation';
import { debugOverlay } from './debug';
import { impactBurst } from './blowfx';

/** A multi-tick damage application waiting to deliver its remaining slices. */
class Job {
  active = false;
  /** 0 = deliver another slice of a multi-tick event; 1 = the deferred FRACTURE chisel. */
  kind = 0;
  bodyId = -1;
  ev!: DamageEvent;
  remaining = 0;
  energy = 0;
  /** Ticks to wait before the job first acts. */
  delay = 0;
  /** Body transform when a deferred chisel was queued: the chisel follows the body the blow struck (see `shiftEvent`). */
  bx = 0;
  by = 0;
}

/** Slide a deferred blow's world-space shape and origin by (dx, dy) so it keeps biting the same matter. */
function shiftEvent(ev: DamageEvent, dx: number, dy: number): void {
  const s = ev.shape;
  if (s.kind === 'line') {
    s.x0 += dx;
    s.y0 += dy;
    s.x1 += dx;
    s.y1 += dy;
  } else {
    s.x += dx;
    s.y += dy;
  }
  ev.originX += dx;
  ev.originY += dy;
}

const MAX_JOBS = 48;

const DEFAULT_PARTICLE_DRAG: Record<string, number> = {
  spark: 0.4,
  ember: 0.6,
  dust: 1.2,
  gas: 1.6,
  ash: 1.4,
  glint: 2,
  plasma: 0.8,
  shard: 0.7,
  mote: 0.5,
};

/** Live counters and ledger for tests, the bench and the dev sandbox. */
export interface MatterDiagnostics {
  chunks: number;
  particles: number;
  chunkMass: number;
  particleMass: number;
  bodies: number;
  /** Pending multi-tick damage slices and deferred chisels. */
  jobs: number;
}

/** Everything the mass ledger tracks. `error` is the conservation residual (should be ~0). */
export interface LedgerReport {
  created: number;
  injected: number;
  deleted: number;
  dissipated: number;
  credited: number;
  cellMass: number;
  poolMass: number;
  chunkMass: number;
  particleMass: number;
  /** (created + injected) - (cells + pools + chunks + particles + dissipated + deleted) */
  error: number;
}

/** MatterWorld plus the extras used by the sandbox, tests and bench (all optional for integrators). */
export interface MatterWorldEx extends MatterWorld {
  /** Arena used for the soft walls that keep debris in the play area (default: DEFAULT_ARENA). */
  setArena(a: ArenaInfo): void;
  /** Force a visual/stat refresh of one body (or all) without ticking. */
  refresh(bodyId?: number): void;
  ledger(): LedgerReport;
  diagnostics(): MatterDiagnostics;
  /** World AABB of a body's live cells (false if the body is gone or empty). */
  liveBounds(bodyId: number, out: { x0: number; y0: number; x1: number; y1: number }): boolean;
  /** Run connectivity immediately (tests, carve). */
  settleBody(bodyId: number): void;
  /** Internal state access for tests. */
  readonly core: WorldCore;
}

const EMPTY_STATS: BodyStats = Object.freeze({
  mass: 0,
  initialMass: 0,
  massFrac: 0,
  cells: 0,
  initialCells: 0,
  coreIntegrity: 0,
  anchoredFrac: 0,
  exposedCoreFrac: 1,
  burningCells: 0,
  infectedCells: 0,
  crackedCells: 0,
  massGained: 0,
  massLost: 0,
  regionGrid: new Float32Array(64),
}) as BodyStats;

function newResult(): DamageResult {
  return {
    cellsTouched: 0,
    cellsRemoved: 0,
    massRemoved: 0,
    massTransferred: 0,
    contactX: NaN,
    contactY: NaN,
    impulseX: 0,
    impulseY: 0,
    onDamagedFraction: 0,
    revealedInterior: false,
  };
}

const pt: WorldPoint = { x: 0, y: 0 };
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

class MatterWorldImpl implements MatterWorldEx {
  readonly core: WorldCore;
  private readonly ctx = new DamageCtx();
  private readonly jobs: Job[] = [];
  private readonly render = new MatterRender();
  private readonly overlays = new Map<string, RenderLayer>();

  constructor(seed: number) {
    this.core = new WorldCore(seed);
    for (let i = 0; i < MAX_JOBS; i++) this.jobs.push(new Job());
    this.core.chunkImpact = (body, chunk, x, y, dx, dy, speed) => {
      // Debris impact: a capped KINETIC point blow. Modest by design; heavy fast chunks still hurt.
      const energy = Math.min(90, 0.5 * chunk.mass * (speed / 60) * (speed / 60) * 2.2);
      if (energy < 2) return;
      const ev: DamageEvent = {
        type: 'KINETIC',
        shape: { kind: 'point', x, y, r: Math.max(1.6, Math.min(6, Math.sqrt(chunk.cells) * 0.55)) },
        energy,
        dirX: dx,
        dirY: dy,
        duration: 1,
        sourceMass: Math.min(2, chunk.mass * 0.15),
        sourceBodyId: -1,
        originX: x,
        originY: y,
        flags: 0,
        params: { scatter: 0.6 },
      };
      this.applySlice(body, ev, energy, true, newResult());
      this.core.emitMatter('impact', x, y, chunk.mass, body.ownerSlot);
    };
  }

  get tickCount(): number {
    return this.core.tick;
  }

  /* ------------------------------------------------------------------ bodies */

  createBody(spec: BodySpec): MatterBody {
    const core = this.core;
    if (spec.map.w > MAX_BODY_DIM || spec.map.h > MAX_BODY_DIM)
      throw new Error(`matter: body map ${spec.map.w}x${spec.map.h} exceeds MAX_BODY_DIM ${MAX_BODY_DIM}`);
    const id = core.nextBodyId++;
    const body = new Body(id, spec);
    initBody(core, body);
    core.bodyById[id] = body;
    core.bodyList.push(body);
    this.updateBodyMotion(body, true);
    return body;
  }

  removeBody(id: number): void {
    const core = this.core;
    const b = core.bodyById[id];
    if (!b) return;
    b.refreshStats();
    core.ledger.deleted += b.map.mass; // cells + pool vanish with the body
    core.bodyById[id] = undefined;
    const i = core.bodyList.indexOf(b);
    if (i >= 0) core.bodyList.splice(i, 1);
  }

  getBody(id: number): MatterBody | undefined {
    return this.core.bodyById[id];
  }

  /* ------------------------------------------------------------------ damage */

  applyDamage(bodyId: number, ev: DamageEvent): DamageResult {
    const res = newResult();
    const body = this.core.bodyById[bodyId];
    if (!body || !(ev.energy > 0) || !Number.isFinite(ev.energy)) return res;
    const dur = ev.duration > 1 ? Math.floor(ev.duration) : 1;
    const continuous = (ev.flags & DamageFlag.CONTINUOUS) !== 0;
    const e0 = continuous || dur === 1 ? ev.energy : ev.energy / dur;
    this.applySlice(body, ev, e0, true, res);
    if (dur > 1) {
      for (let i = 0; i < this.jobs.length; i++) {
        const j = this.jobs[i]!;
        if (j.active) continue;
        j.active = true;
        j.kind = 0;
        j.bodyId = bodyId;
        j.ev = { ...ev, shape: { ...ev.shape }, params: { ...ev.params } };
        j.remaining = dur - 1;
        j.energy = e0;
        j.delay = 0;
        break;
      }
    }
    return res;
  }

  /** Apply one tick's worth of an event to `body`. */
  private applySlice(body: Body, ev: DamageEvent, energy: number, first: boolean, res: DamageResult): void {
    const core = this.core;
    if (ev.type === 'TIDAL') {
      // Tidal fields cover whole bodies: apply every 3rd tick with the skipped energy carried (same total, a third of the cost).
      if (core.tick - body.lastTidalTick < 3 && !((ev.flags & DamageFlag.CONTINUOUS) === 0 && first)) {
        body.tidalCarry += energy;
        return;
      }
      energy += body.tidalCarry;
      body.tidalCarry = 0;
      body.lastTidalTick = core.tick;
    }
    const ctx = beginDamage(core, this.ctx, body, ev, energy, first);
    if (ctx === null) {
      // Type-specific effects that do not need covered cells (e.g. harvesting already-torn matter) live in the models.
      if (ev.type === 'ASSIMILATION' || ev.type === 'TIDAL') this.applyEmpty(ev.type);
      return;
    }
    if (first && (ev.type === 'FRACTURE' || ev.type === 'KINETIC' || ev.type === 'CRUSH')) impactBurst(ctx);
    switch (ev.type) {
      case 'FRACTURE':
        applyFracture(ctx, res);
        if (ctx.chisel > 0) this.queueChisel(body, ev, ctx.chisel);
        break;
      case 'KINETIC':
        applyKinetic(ctx, res);
        break;
      case 'CRUSH':
        applyCrush(ctx, res);
        break;
      case 'THERMAL':
        applyThermal(ctx, res);
        break;
      case 'TIDAL':
        applyTidal(ctx, res);
        break;
      case 'ASSIMILATION':
        applyAssimilation(ctx, res);
        break;
    }
    endSpray(core); // never leave mass parked in the spray accumulator across API calls
  }

  /** Defer the chisel share of a FRACTURE blow (see fracture.ts): it re-runs the blow's shape against what the cuts left behind. */
  private queueChisel(body: Body, ev: DamageEvent, energy: number): void {
    for (let i = 0; i < this.jobs.length; i++) {
      const j = this.jobs[i]!;
      if (j.active) continue;
      j.active = true;
      j.kind = 1;
      j.bodyId = body.id;
      j.ev = { ...ev, shape: { ...ev.shape }, params: { ...ev.params } };
      j.remaining = 1;
      j.energy = energy;
      j.delay = CHISEL_DELAY;
      j.bx = body.transform.x;
      j.by = body.transform.y;
      return;
    }
    // Queue full: chisel at once rather than lose the energy.
    const ctx = beginDamage(this.core, this.ctx, body, ev, energy, false);
    if (ctx !== null) chisel(ctx, energy);
    endSpray(this.core);
  }

  private applyEmpty(_t: string): void {
    /* nothing covered: no effect */
  }

  overlap(bodyId: number, shape: DamageShape, out?: OverlapResult): OverlapResult {
    const r: OverlapResult = out ?? { cells: 0, x: NaN, y: NaN, nearestX: NaN, nearestY: NaN, coverage: 0 };
    r.cells = 0;
    r.x = NaN;
    r.y = NaN;
    r.nearestX = NaN;
    r.nearestY = NaN;
    r.coverage = 0;
    const core = this.core;
    const body = core.bodyById[bodyId];
    if (!body) return r;
    const q = core.q.set(shape);
    const n = body.collect(q, core.covIdx, core.covW);
    if (n === 0) return r;
    const ox = q.originX();
    const oy = q.originY();
    const w = body.w;
    const integ = body.map.integrity;
    let sx = 0;
    let sy = 0;
    let sI = 0;
    let best = Infinity;
    let bx = 0;
    let by = 0;
    for (let k = 0; k < n; k++) {
      const i = core.covIdx[k]!;
      const x = i % w;
      body.cellWorld(x, (i - x) / w, pt);
      sx += pt.x;
      sy += pt.y;
      sI += integ[i]!;
      const d = (pt.x - ox) * (pt.x - ox) + (pt.y - oy) * (pt.y - oy);
      if (d < best) {
        best = d;
        bx = pt.x;
        by = pt.y;
      }
    }
    r.cells = n;
    r.x = sx / n;
    r.y = sy / n;
    r.nearestX = bx;
    r.nearestY = by;
    r.coverage = Math.min(1, sI / (255 * Math.max(1, q.area)));
    return r;
  }

  solidAt(bodyId: number, wx: number, wy: number): boolean {
    const body = this.core.bodyById[bodyId];
    if (!body) return false;
    const c = body.cellAtWorld(wx, wy);
    return c >= 0 && body.map.material[c] !== 0 && body.map.integrity[c] !== 0;
  }

  /* ------------------------------------------------------------------ stepping */

  private updateBodyMotion(b: Body, init: boolean): void {
    const t = b.transform;
    if (init || Number.isNaN(b.lastX)) {
      b.vx = 0;
      b.vy = 0;
    } else {
      b.vx = (t.x - b.lastX) / TICK_DT;
      b.vy = (t.y - b.lastY) / TICK_DT;
      // Teleports (round reset) must not read as huge velocities.
      if (Math.abs(b.vx) > 2000 || Math.abs(b.vy) > 2000) {
        b.vx = 0;
        b.vy = 0;
      }
    }
    b.lastX = t.x;
    b.lastY = t.y;
    const xa = t.x + (0 - t.anchorX) * t.facing;
    const xb = t.x + (b.w - t.anchorX) * t.facing;
    const pad = Math.abs(t.lean);
    b.aabbX0 = Math.min(xa, xb) - pad;
    b.aabbX1 = Math.max(xa, xb) + pad;
    b.aabbY0 = t.y - t.anchorY;
    b.aabbY1 = t.y - t.anchorY + b.h;
  }

  private lapT0 = 0;
  private lap(section: number): void {
    const clock = this.core.clock;
    if (!clock) return;
    const t1 = clock();
    this.core.prof[section] = this.core.prof[section]! + (t1 - this.lapT0);
    this.lapT0 = t1;
  }

  tick(): void {
    const core = this.core;
    core.tick++;
    this.lapT0 = core.clock ? core.clock() : 0;
    const bodies = core.bodyList;
    for (let i = 0; i < bodies.length; i++) this.updateBodyMotion(bodies[i]!, false);

    // Multi-tick damage jobs.
    for (let i = 0; i < this.jobs.length; i++) {
      const j = this.jobs[i]!;
      if (!j.active) continue;
      const body = core.bodyById[j.bodyId];
      if (!body) {
        j.active = false;
        continue;
      }
      if (j.delay > 0) {
        j.delay--;
        continue;
      }
      if (j.kind === 1) {
        // The blow that queued this chisel usually knocks the body away within the delay: chase it, or the pit lands on empty air.
        shiftEvent(j.ev, body.transform.x - j.bx, body.transform.y - j.by);
        const ctx = beginDamage(core, this.ctx, body, j.ev, j.energy, false);
        if (ctx !== null) chisel(ctx, j.energy);
        endSpray(core);
        j.active = false;
        continue;
      }
      this.applySlice(body, j.ev, j.energy, false, newResult());
      if (--j.remaining <= 0) j.active = false;
    }
    this.lap(0);

    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i]!;
      stepFronts(core, b);
      stepFuses(core, b);
    }
    this.lap(1);
    for (let i = 0; i < bodies.length; i++) stepThermal(core, bodies[i]!);
    this.lap(2);
    for (let i = 0; i < bodies.length; i++) stepInfection(core, bodies[i]!);
    this.lap(3);
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i]!;
      if (
        b.connDirty !== 0 &&
        core.tick - b.lastConnTick >= (b.connDirty === CONN_NOW ? 1 : b.connDirty === CONN_STEADY ? 3 : 6)
      )
        runConnectivity(core, b);
    }
    this.lap(4);
    stepWaves(core);
    this.lap(5);
    stepChunks(core);
    this.lap(6);
    core.particles.step(core);
    this.lap(7);
    for (let i = 0; i < bodies.length; i++) refreshVisuals(core, bodies[i]!);
    this.lap(8);
    for (let i = 0; i < bodies.length; i++) bodies[i]!.refreshStats();
    endSpray(core);
    core.flushEvents();
    this.lap(9);
  }

  drainEvents(into: SimEvent[]): void {
    this.core.drainEvents(into);
  }

  /* ------------------------------------------------------------------ queries */

  stats(bodyId: number): BodyStats {
    const b = this.core.bodyById[bodyId];
    return b ? b.refreshStats() : EMPTY_STATS;
  }

  /* ------------------------------------------------------------------ mass economy */

  grow(bodyId: number, spec: GrowSpec): number {
    const b = this.core.bodyById[bodyId];
    return b ? life.grow(this.core, b, spec) : 0;
  }
  shed(bodyId: number, mass: number, style: 'burn' | 'blow' | 'evaporate'): number {
    const b = this.core.bodyById[bodyId];
    return b ? life.shed(this.core, b, mass, style) : 0;
  }
  heal(bodyId: number, fraction: number, seed: number): void {
    const b = this.core.bodyById[bodyId];
    if (!b) return;
    this.cancelProcesses(bodyId);
    life.heal(this.core, b, fraction, seed);
  }
  restore(bodyId: number): void {
    const b = this.core.bodyById[bodyId];
    if (!b) return;
    this.cancelProcesses(bodyId);
    life.restore(this.core, b);
  }

  /** Between rounds: multi-tick damage jobs and shock rings aimed at this body must not leak into the next round. */
  private cancelProcesses(bodyId: number): void {
    for (const j of this.jobs) if (j.active && j.bodyId === bodyId) j.active = false;
    for (const w of this.core.waves) if (w.active && w.bodyId === bodyId) w.active = false;
    const b = this.core.bodyById[bodyId];
    if (b) {
      b.tidalCarry = 0;
      b.lastTidalTick = -100;
    }
  }
  carve(bodyId: number, massFrac: number, seed: number): void {
    const b = this.core.bodyById[bodyId];
    if (b) life.carve(this, b, massFrac, seed);
  }

  /* ------------------------------------------------------------------ fields, particles, chunks */

  setGravitySource(slot: 0 | 1, src: GravitySource | null): void {
    const g = this.core.gravity[slot];
    if (src === null) {
      g.active = false;
      return;
    }
    g.active = true;
    g.x = src.x;
    g.y = src.y;
    g.strength = src.strength;
    g.radius = Math.max(1, src.radius);
    g.consumeRadius = src.consumeRadius ?? 0;
    g.creditBodyId = src.creditBodyId ?? -1;
  }

  spawnParticles(spec: ParticleSpawn): void {
    const core = this.core;
    const P = core.particles;
    const rid = P.internRamp(spec.ramp);
    const kind = KIND_ID[spec.kind];
    const drag = spec.drag ?? DEFAULT_PARTICLE_DRAG[spec.kind] ?? 1;
    const rng = core.rng;
    const n = Math.min(spec.count | 0, MAX_PARTICLES);
    const l0 = spec.life[0];
    const l1 = Math.max(l0, spec.life[1]);
    for (let i = 0; i < n; i++) {
      const a = rng.next() * Math.PI * 2;
      const r = Math.sqrt(rng.next()) * spec.spread;
      P.spawn(
        core,
        kind,
        spec.x,
        spec.y,
        spec.vx + Math.cos(a) * r,
        spec.vy + Math.sin(a) * r,
        l0 + rng.next() * (l1 - l0),
        Math.max(1, Math.min(3, spec.size | 0)),
        spec.emissive,
        rid,
        spec.fieldScale,
        drag,
        0,
      );
    }
  }

  spawnChunk(spec: ChunkSpawn): void {
    const core = this.core;
    core.ledger.injected += spec.mass;
    const emi = spec.emissive ? spec.emissive.slice() : null;
    core.chunks.add(
      core,
      spec.pixels.slice(),
      emi,
      spec.w,
      spec.h,
      spec.w / 2,
      spec.h / 2,
      spec.x,
      spec.y,
      spec.vx,
      spec.vy,
      spec.spin,
      spec.mass,
      -1,
      0.5,
      0,
    );
  }

  /* ------------------------------------------------------------------ rendering */

  setLighting(l: StageLighting): void {
    this.core.setLighting(l);
  }

  renderLayers(view: ViewRect, alpha: number): RenderLayer[] {
    return this.render.render(this.core, view, alpha);
  }

  debugOverlay(bodyId: number, mode: DebugOverlayMode): RenderLayer | null {
    const b = this.core.bodyById[bodyId];
    if (!b) return null;
    return debugOverlay(this.core, b, mode, this.overlays);
  }

  /* ------------------------------------------------------------------ determinism */

  hash(): number {
    // Pending multi-tick jobs and deferred chisels are simulation state too.
    return hashWorld(this.core, (h) => {
      for (let i = 0; i < this.jobs.length; i++) {
        const j = this.jobs[i]!;
        if (!j.active) continue;
        h = mix32(h, i | (j.kind << 8) | (j.bodyId << 12));
        h = mix32(h, j.remaining | (j.delay << 16));
        f64[0] = j.energy;
        h = mix32(mix32(h, u32[0]!), u32[1]!);
      }
      return h;
    });
  }

  /* ------------------------------------------------------------------ extras */

  setArena(a: ArenaInfo): void {
    this.core.arena = { ...a };
  }

  refresh(bodyId?: number): void {
    const core = this.core;
    const list = bodyId === undefined ? core.bodyList : [core.bodyById[bodyId]!].filter(Boolean);
    for (const b of list) {
      refreshVisuals(core, b);
      b.refreshStats();
    }
  }

  ledger(): LedgerReport {
    const core = this.core;
    let cell = 0;
    let pool = 0;
    for (const b of core.bodyList) {
      let m = 0;
      const md = b.matDensity;
      const mat = b.map.material;
      const den = b.map.density;
      for (let i = 0; i < b.n; i++) {
        const mm = mat[i]!;
        if (mm !== 0) m += (md[mm]! * den[i]!) / 128;
      }
      cell += m;
      pool += b.pool;
    }
    const l = core.ledger;
    const chunkMass = core.chunks.massLive;
    const particleMass = core.particles.massLive + core.sprayMass;
    const error =
      l.created + l.injected - (cell + pool + chunkMass + particleMass + l.dissipated + l.deleted);
    return { ...l, cellMass: cell, poolMass: pool, chunkMass, particleMass, error };
  }

  diagnostics(): MatterDiagnostics {
    const core = this.core;
    return {
      chunks: core.chunks.count,
      particles: core.particles.count,
      chunkMass: core.chunks.massLive,
      particleMass: core.particles.massLive,
      bodies: core.bodyList.length,
      jobs: this.jobs.reduce((n, j) => n + (j.active ? 1 : 0), 0),
    };
  }

  liveBounds(bodyId: number, out: { x0: number; y0: number; x1: number; y1: number }): boolean {
    const b = this.core.bodyById[bodyId];
    if (!b) return false;
    const s = b.refreshStats();
    if (s.cells === 0) return false;
    // Scan region grid for the local live bbox, then map to world.
    const w = b.w;
    const mat = b.map.material;
    let x0 = w;
    let y0 = b.h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < b.h; y++) {
      const base = y * w;
      for (let x = 0; x < w; x++) {
        if (mat[base + x] === 0) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return false;
    const t = b.transform;
    const wa = t.x + (x0 - t.anchorX) * t.facing;
    const wb = t.x + (x1 + 1 - t.anchorX) * t.facing;
    out.x0 = Math.min(wa, wb) - Math.abs(t.lean);
    out.x1 = Math.max(wa, wb) + Math.abs(t.lean);
    out.y0 = t.y + (y0 - t.anchorY);
    out.y1 = t.y + (y1 + 1 - t.anchorY);
    return true;
  }

  settleBody(bodyId: number): void {
    const b = this.core.bodyById[bodyId];
    if (b) runConnectivity(this.core, b);
  }
}

/** Create the destruction simulation. Deterministic: same seed + same call sequence => same `hash()`. */
export function createMatterWorld(seed: number): MatterWorldEx {
  return new MatterWorldImpl(seed);
}
