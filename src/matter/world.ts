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
import {
  CHUNK_FREE,
  CHUNK_LAUNCHED,
  CHUNK_ORBIT,
  getSprite32,
  getSprite8,
  splitChunk,
  stepChunks,
  type Chunk,
} from './chunks';
import { runConnectivity } from './connectivity';
import { stepFronts, stepSlowCuts } from './cracks';
import { WorldCore } from './core';
import { beginDamage, DamageCtx, localToWorldF } from './dmg';
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
import { HAIRLINE, finishReleases, shearDelay, stepWounds } from './wound';
import { extractChunk } from './debris';
import { defineShell, finishShellSwap, restoreShell, stepShellSwap, swapShell, type FarFace } from './shell';

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
  /** The wound of the blow a deferred chisel belongs to (its pit sheds as that wound's slabs), or -1. */
  wound = -1;
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
/** Debris-impact energy a body can take per world tick (one heavy chunk's worth). */
const DEBRIS_TICK_BUDGET = 60;

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
  /** Held wound slabs waiting to shear (all bodies). */
  heldSlabs: number;
  /** Routing of the last world tick: body mass lost, mass routed to particles (+ dissipated) and to rigid chunks. */
  tickBodyLoss: number;
  tickToParticles: number;
  tickToChunks: number;
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
  /** Implemented (the contract still marks them optional until the Lead makes them required). */
  bodyToChunk(bodyId: number, vx: number, vy: number, spin: number): number;
  jointHealth(bodyId: number, cells: Int32Array | readonly number[]): number;
  /**
   * Light in a body's CRUSH fissures (packed RGBA; `null` = dark cracks; `undefined` = the default: molten rock's glow if the
   * body holds a magma-archetype material, else none). The Witness sets its white-gold / cyan wound light here.
   */
  setFissureGlow(bodyId: number, colour: number | null | undefined): void;
  /**
   * Aftermath export: the debris/particle layers supersampled k× ((k·LOGICAL_W)×(k·LOGICAL_H), k 1..8, fresh buffers). Reads the
   * frozen world from any view; never steps or mutates the simulation.
   */
  renderExport(view: ViewRect, k: number): RenderLayer[];
  /* ---- the two-hemisphere world (proposal 142, with S3) ---- */
  /**
   * Give a body a far face: every cell farther than `shell` cells from its core centre (the Planet: magmaR), or every cell of a
   * map-sized mask with `shell[i] = 1`, exists twice; the far face is the pristine body mirrored about the core column. False if
   * it already has one. `far` (proposal 135): the far face painted as it will be drawn after the next half-turn (map-sized
   * material / density / height / baseColor; only the shell cells are read); omitted = the pristine body mirrored.
   */
  defineShell(bodyId: number, shell: number | Uint8Array, far?: FarFace): boolean;
  /**
   * Commit a half-turn: exact swap of the near and far shell faces (the core stays), time-sliced in row bands over `ticks` world
   * ticks (default 18 = 0.3 s; ≤ 1 = at once). Settles wounds/cuts in flight first. False if no shell or a swap is running.
   */
  swapShell(bodyId: number, ticks?: number): boolean;
  /** Fraction of the running swap done (rows moved / h); 1 when none is running; -1 if the body has no shell. */
  shellProgress(bodyId: number): number;
  /** Which face is toward the viewer: 0 the original, 1 the other; -1 if the body has no shell. */
  shellFace(bodyId: number): number;
  /** Returns the new chunk's id (comets, lost moons). */
  spawnChunk(spec: ChunkSpawn): number;
  /* ---- capture (Tidal Draw), thrown debris (proposal 142) ---- */
  setOrbit(slot: 0 | 1, spec: OrbitSpec | null): void;
  chunksInShape(shape: DamageShape, out: Int32Array): number;
  chunkState(id: number, out: ChunkStateOut): boolean;
  captureChunk(id: number, slot: 0 | 1): boolean;
  releaseChunk(id: number): boolean;
  retireChunk(id: number): boolean;
  strikeChunk(id: number, x: number, y: number, energy: number, dirX: number, dirY: number): boolean;
  launchChunk(id: number, vx: number, vy: number, creditBodyId: number, slot?: 0 | 1 | -1): boolean;
}

/** A gravity owner's capture ring: centre (world px), radius (px) and angular speed (rad/s, sign = direction). */
export interface OrbitSpec {
  x: number;
  y: number;
  radius: number;
  omega: number;
  /** Vertical scale of the ring (default 1 = circle; S3's debris ring: 0.26, the moons' plane). */
  flatten?: number;
}

/** What `chunkState` reports. `mode`: 0 free, 1 captured (pinned), 2 launched. */
export interface ChunkStateOut {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  mass: number;
  radius: number;
  mode: number;
  owner: number;
  origin: number;
  temp: number;
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
  /** Reused event of a thrown chunk's impact. */
  private readonly launchEv: DamageEvent = {
    type: 'KINETIC',
    shape: { kind: 'point', x: 0, y: 0, r: 2 },
    energy: 0,
    dirX: 1,
    dirY: 0,
    duration: 1,
    sourceMass: 1,
    sourceBodyId: -1,
    originX: 0,
    originY: 0,
    flags: 0,
    params: { scatter: 1 },
  };

  constructor(seed: number) {
    this.core = new WorldCore(seed);
    for (let i = 0; i < MAX_JOBS; i++) this.jobs.push(new Job());
    this.core.chunkImpact = (body, chunk, x, y, dx, dy, speed) => {
      // Debris impact: a capped KINETIC point blow. Modest by design; heavy fast chunks still hurt.
      const ex = Math.max(0, speed - 100) / 60;
      let energy = Math.min(DEBRIS_TICK_BUDGET, 0.5 * chunk.mass * ex * ex * 2.2);
      // A body takes at most one heavy chunk's worth of debris damage per tick, however many pieces land together.
      if (body.debrisTick !== this.core.tick) {
        body.debrisTick = this.core.tick;
        body.debrisEnergy = 0;
      }
      energy = Math.min(energy, DEBRIS_TICK_BUDGET - body.debrisEnergy);
      if (energy < 2) return;
      body.debrisEnergy += energy;
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
    this.core.launchImpact = (body, chunk, x, y, dx, dy, speed) => {
      // A thrown chunk (Tidal Draw ammunition, a slung comet): uncapped, credited to the thrower.
      const v = speed / 60;
      const energy = 0.5 * chunk.mass * v * v;
      if (energy < 2) return;
      const ev = this.launchEv;
      const sh = ev.shape as { kind: 'point'; x: number; y: number; r: number };
      sh.x = x;
      sh.y = y;
      sh.r = Math.max(2, Math.min(14, Math.sqrt(chunk.cells) * 0.55));
      ev.energy = energy;
      ev.dirX = dx;
      ev.dirY = dy;
      ev.sourceMass = Math.max(0.5, Math.min(12, chunk.mass / 20));
      ev.sourceBodyId = chunk.credit;
      ev.originX = x;
      ev.originY = y;
      this.applySlice(body, ev, energy, true, newResult());
      this.core.emitMatter('impact', x, y, chunk.mass, body.ownerSlot);
    };
  }

  /* ------------------------------------------------------------------ capture: Tidal Draw, thrown debris, comets */

  /** Set (or clear) a gravity owner's capture ring. Clearing it lets its captured chunks go (they keep their velocity). */
  setOrbit(slot: 0 | 1, spec: OrbitSpec | null): void {
    const o = this.core.orbits[slot];
    if (spec === null) {
      o.active = false;
      return;
    }
    o.active = true;
    o.x = spec.x;
    o.y = spec.y;
    o.radius = Math.max(1, spec.radius);
    o.omega = spec.omega;
    o.flatten = spec.flatten ?? 1;
  }

  /** Ids of the live chunks whose centre lies in the shape (or, for a point shape, whose disc touches it). Returns the count. */
  chunksInShape(shape: DamageShape, out: Int32Array): number {
    const core = this.core;
    const q = core.q.set(shape);
    const pool = core.chunks;
    let n = 0;
    for (let i = 0; i < pool.hi && n < out.length; i++) {
      const c = pool.list[i]!;
      if (!c.alive) continue;
      let hit = q.weight(c.x, c.y) > 0;
      if (!hit && shape.kind === 'point') {
        const dx = c.x - shape.x;
        const dy = c.y - shape.y;
        const rr = shape.r + c.radius;
        hit = dx * dx + dy * dy <= rr * rr;
      }
      if (hit) out[n++] = c.id;
    }
    return n;
  }

  private chunkById(id: number): Chunk | null {
    const pool = this.core.chunks;
    for (let i = 0; i < pool.hi; i++) {
      const c = pool.list[i]!;
      if (c.alive && c.id === id) return c;
    }
    return null;
  }

  /** Read a chunk's state into `out`. False if the chunk no longer exists (degraded, consumed, split). */
  chunkState(id: number, out: ChunkStateOut): boolean {
    const c = this.chunkById(id);
    if (!c) return false;
    out.x = c.x;
    out.y = c.y;
    out.vx = c.vx;
    out.vy = c.vy;
    out.angle = c.angle;
    out.spin = c.spin;
    out.mass = c.mass;
    out.radius = c.radius;
    out.mode = c.mode;
    out.owner = c.owner;
    out.origin = c.origin;
    out.temp = c.temp;
    return true;
  }

  /**
   * Capture a chunk into `slot`'s ring (any chunk: severed enemy matter included). A captured chunk is pinned — never degraded
   * to make room — and rides the ring until released, launched, or the ring is cleared. False if the chunk is gone or the
   * owner has no ring.
   */
  captureChunk(id: number, slot: 0 | 1): boolean {
    const o = this.core.orbits[slot];
    const c = this.chunkById(id);
    if (!c || !o.active) return false;
    c.mode = CHUNK_ORBIT;
    c.owner = slot;
    c.credit = -1;
    c.phase = Math.atan2((c.y - o.y) / Math.max(0.05, o.flatten), c.x - o.x);
    // each chunk gets its own lane in a band around the ring radius (deterministic from its id)
    c.ring = o.radius + ((Math.imul(c.id, 2654435761) >>> 0) % 13) - 6;
    c.asleep = false;
    return true;
  }

  /**
   * A blow lands on a chunk (a ring chunk soaking a hit as armour, a comet struck): it is knocked out of any ring and, if big
   * enough, breaks into 2-3 free pieces flung along (dirX, dirY) from the hit point (x, y). Mass is conserved. False if gone.
   */
  strikeChunk(id: number, x: number, y: number, energy: number, dirX: number, dirY: number): boolean {
    const c = this.chunkById(id);
    if (!c) return false;
    const pool = this.core.chunks;
    c.mode = CHUNK_FREE;
    c.owner = -1;
    c.credit = -1;
    c.asleep = false;
    const dl = Math.hypot(dirX, dirY) || 1;
    const push = Math.sqrt(Math.max(0, energy) / Math.max(1, c.mass)) * 40;
    c.vx += (dirX / dl) * push;
    c.vy += (dirY / dl) * push;
    const k = energy > 600 ? 3 : 2;
    if (energy >= 60 && pool.count < pool.cap - k)
      splitChunk(this.core, pool, c, k, x, y, Math.min(240, Math.sqrt(energy) * 4));
    return true;
  }

  /** Remove a chunk from play (an uncaught comet leaving the arena): its mass is booked as dissipated. False if it is gone. */
  retireChunk(id: number): boolean {
    const c = this.chunkById(id);
    if (!c) return false;
    this.core.ledger.dissipated += c.mass;
    this.core.chunks.free(c);
    return true;
  }

  /** Let a captured chunk go (it keeps its velocity and is ordinary debris again). */
  releaseChunk(id: number): boolean {
    const c = this.chunkById(id);
    if (!c) return false;
    c.mode = CHUNK_FREE;
    c.owner = -1;
    c.credit = -1;
    return true;
  }

  /**
   * Throw a chunk: it flies at (vx, vy) px/s (no wells, no capture) until it hits a body other than its thrower's, where it
   * lands an UNCAPPED KINETIC blow (energy ½·m·(v/60)², credited to `creditBodyId`), then becomes ordinary debris. `slot` is the
   * thrower's slot (its bodies are never hit), -1 for none.
   */
  launchChunk(id: number, vx: number, vy: number, creditBodyId: number, slot: 0 | 1 | -1 = -1): boolean {
    const c = this.chunkById(id);
    if (!c) return false;
    c.mode = CHUNK_LAUNCHED;
    c.owner = slot;
    c.credit = creditBodyId;
    c.vx = vx;
    c.vy = vy;
    c.asleep = false;
    c.noHitUntil = 0;
    c.fast = true; // no slow heaviness ramp: it was thrown
    return true;
  }

  setFissureGlow(bodyId: number, colour: number | null | undefined): void {
    const b = this.core.bodyById[bodyId];
    if (!b) return;
    b.setFissureGlow(colour);
    b.visAll = true;
    b.visDirty = true;
  }

  defineShell(bodyId: number, shell: number | Uint8Array, far?: FarFace): boolean {
    const b = this.core.bodyById[bodyId];
    return b ? defineShell(this.core, b, shell, far) : false;
  }

  swapShell(bodyId: number, ticks?: number): boolean {
    const b = this.core.bodyById[bodyId];
    return b ? swapShell(this.core, b, ticks) : false;
  }

  shellProgress(bodyId: number): number {
    const b = this.core.bodyById[bodyId];
    if (!b || b.shell === null) return -1;
    return b.shell.swapLeft > 0 ? b.shell.swapRow / b.h : 1;
  }

  shellFace(bodyId: number): number {
    const b = this.core.bodyById[bodyId];
    return b && b.shell !== null ? b.shell.face : -1;
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
    core.ledger.deleted += b.map.mass + (b.shell !== null ? b.shell.farMass : 0); // cells + pool (+ a far face) vanish with the body
    core.bodyById[id] = undefined;
    const i = core.bodyList.indexOf(b);
    if (i >= 0) core.bodyList.splice(i, 1);
  }

  /**
   * A severed rig region leaves as ONE rigid chunk: every live cell moves into it (exact ledger transfer: cells → chunk mass),
   * the body is removed (only its accretion pool, if any, is booked as deleted). Returns the chunk id, or -1 if the body is
   * gone or empty. A rotated region's chunk starts at the region's angle, exactly where it was drawn.
   */
  bodyToChunk(bodyId: number, vx: number, vy: number, spin: number): number {
    const core = this.core;
    const b = core.bodyById[bodyId];
    if (!b) return -1;
    const mat = b.map.material;
    const cells = core.covIdx;
    let n = 0;
    for (let c = 0; c < b.n; c++) if (mat[c] !== 0) cells[n++] = c;
    let id = -1;
    if (n > 0) {
      const ch = extractChunk(core, b, cells, n, vx, vy, spin);
      if (ch) {
        ch.spin = spin;
        id = ch.id;
        core.emitMatter('detach', ch.x, ch.y, ch.mass, b.ownerSlot);
      }
    }
    this.removeBody(bodyId);
    return id;
  }

  /**
   * 0..1 health of a joint patch: Σ integrity of its live cells that are still bonded (at least one intact, non-hairline bond to
   * a live neighbour, and not held by a shearing wound) over the patch's pristine Σ (255 per cell). Allocation-free.
   */
  jointHealth(bodyId: number, cells: Int32Array | readonly number[]): number {
    const b = this.core.bodyById[bodyId];
    if (!b || cells.length === 0) return 0;
    const { material: mat, integrity: integ, bondR, bondD, detached: det } = b.map;
    const w = b.w;
    let sum = 0;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k]!;
      if (c < 0 || c >= b.n || mat[c] === 0 || det[c] !== 0) continue;
      const x = c % w;
      const bonded =
        (x < w - 1 && mat[c + 1] !== 0 && bondR[c]! > HAIRLINE) ||
        (x > 0 && mat[c - 1] !== 0 && bondR[c - 1]! > HAIRLINE) ||
        (c + w < b.n && mat[c + w] !== 0 && bondD[c]! > HAIRLINE) ||
        (c >= w && mat[c - w] !== 0 && bondD[c - w]! > HAIRLINE);
      if (bonded) sum += integ[c]!;
    }
    return sum / (255 * cells.length);
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

  /** Apply one tick's worth of an event to `body`. A two-face shell mid-swap separates at once (no held slabs: shell.ts). */
  private applySlice(body: Body, ev: DamageEvent, energy: number, first: boolean, res: DamageResult): void {
    const core = this.core;
    if (body.shell === null || body.shell.swapLeft === 0) {
      this.applySliceNow(body, ev, energy, first, res);
      return;
    }
    const was = core.woundsOff;
    core.woundsOff = true;
    this.applySliceNow(body, ev, energy, first, res);
    core.woundsOff = was;
  }

  private applySliceNow(
    body: Body,
    ev: DamageEvent,
    energy: number,
    first: boolean,
    res: DamageResult,
  ): void {
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
        if (ctx.chisel > 0) this.queueChisel(body, ev, ctx.chisel, ctx.wound);
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

  /**
   * Defer the chisel share of a FRACTURE blow (see fracture.ts): it re-runs the blow's shape against what the cuts left
   * behind, one tick AFTER the wound's shear (so the slabs the cuts outlined leave as slabs, not as the chisel's dust).
   */
  private queueChisel(body: Body, ev: DamageEvent, energy: number, wound: number): void {
    for (let i = 0; i < this.jobs.length; i++) {
      const j = this.jobs[i]!;
      if (j.active) continue;
      j.active = true;
      j.kind = 1;
      j.bodyId = body.id;
      j.ev = { ...ev, shape: { ...ev.shape }, params: { ...ev.params } };
      j.remaining = 1;
      j.energy = energy;
      j.delay = this.core.woundsOff ? CHISEL_DELAY : shearDelay(ev.hitstop ?? 0) + 1;
      j.bx = body.transform.x;
      j.by = body.transform.y;
      j.wound = wound;
      return;
    }
    // Queue full: chisel at once rather than lose the energy.
    const ctx = beginDamage(this.core, this.ctx, body, ev, energy, false);
    if (ctx !== null) chisel(ctx, energy, wound);
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
    if (b.rotStep() !== 0) {
      // A rotated region: the disc around its pivot that holds the map at any angle.
      const r =
        Math.sqrt(Math.max(t.anchorX, b.w - t.anchorX) ** 2 + Math.max(t.anchorY, b.h - t.anchorY) ** 2) + 2;
      const px = Math.round(t.x);
      const py = Math.round(t.y);
      b.aabbX0 = px - r;
      b.aabbX1 = px + r;
      b.aabbY0 = py - r;
      b.aabbY1 = py + r;
      return;
    }
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
        const was = core.woundsOff;
        if (body.shell !== null && body.shell.swapLeft > 0) core.woundsOff = true;
        const ctx = beginDamage(core, this.ctx, body, j.ev, j.energy, false);
        if (ctx !== null) chisel(ctx, j.energy, core.woundsOff ? -1 : j.wound);
        endSpray(core);
        core.woundsOff = was;
        j.active = false;
        continue;
      }
      this.applySlice(body, j.ev, j.energy, false, newResult());
      if (--j.remaining <= 0) j.active = false;
    }
    this.lap(0);

    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i]!;
      if (b.shell !== null && b.shell.swapLeft > 0) stepShellSwap(b);
      stepFronts(core, b);
      stepSlowCuts(core, b);
      stepFuses(core, b);
      stepWounds(core, b);
    }
    this.lap(1);
    for (let i = 0; i < bodies.length; i++) stepThermal(core, bodies[i]!);
    this.lap(2);
    for (let i = 0; i < bodies.length; i++) stepInfection(core, bodies[i]!);
    this.lap(3);
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i]!;
      // a two-face shell mid-swap holds its connectivity until the last band has moved (shell.ts)
      if (b.shell !== null && b.shell.swapLeft > 0) continue;
      if (
        b.connDirty !== 0 &&
        core.tick - b.lastConnTick >= (b.connDirty === CONN_NOW ? 1 : b.connDirty === CONN_STEADY ? 3 : 6)
      )
        runConnectivity(core, b);
      finishReleases(core, b);
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
    let bodyMass = 0;
    for (let i = 0; i < bodies.length; i++) bodyMass += bodies[i]!.refreshStats().mass;
    endSpray(core);
    this.updateRoute(bodyMass);
    core.flushEvents();
    this.lap(9);
  }

  /** Per-tick routing counters (diagnostics; see WorldCore.route). */
  private updateRoute(bodyMass: number): void {
    const core = this.core;
    const r = core.route;
    const m = core.routeMark;
    const parts = core.particles.massLive + core.sprayMass + core.ledger.dissipated;
    const chunks = core.chunks.massLive;
    r.tick = core.tick;
    r.bodyLoss = Number.isNaN(m.bodyMass) ? 0 : m.bodyMass - bodyMass;
    r.toParticles = parts - m.particles;
    r.toChunks = chunks - m.chunks;
    m.bodyMass = bodyMass;
    m.particles = parts;
    m.chunks = chunks;
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
    finishShellSwap(b);
    life.heal(this.core, b, fraction, seed);
  }
  restore(bodyId: number): void {
    const b = this.core.bodyById[bodyId];
    if (!b) return;
    this.cancelProcesses(bodyId);
    finishShellSwap(b);
    life.restore(this.core, b);
    restoreShell(this.core, b);
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

  /** Reused read-outs of the gravity sources (presentation reads them every frame: no garbage). */
  private readonly gravOut: [GravitySource, GravitySource] = [
    { x: 0, y: 0, strength: 0, radius: 1, consumeRadius: 0, creditBodyId: -1 },
    { x: 0, y: 0, strength: 0, radius: 1, consumeRadius: 0, creditBodyId: -1 },
  ];

  /** The source currently set for `slot`, or null (read-only: a copy, refreshed per call; never touches sim state). */
  gravitySourceOf(slot: 0 | 1): GravitySource | null {
    const g = this.core.gravity[slot];
    if (!g.active) return null;
    const o = this.gravOut[slot];
    o.x = g.x;
    o.y = g.y;
    o.strength = g.strength;
    o.radius = g.radius;
    o.consumeRadius = g.consumeRadius;
    o.creditBodyId = g.creditBodyId;
    return o;
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

  /**
   * Inject a chunk (comets, a lost moon): its mass is booked as injected. Returns the chunk id (the arena module keeps it to
   * steer, capture or launch the chunk later). The pixels are copied into a pooled sprite buffer.
   */
  spawnChunk(spec: ChunkSpawn): number {
    const core = this.core;
    core.ledger.injected += spec.mass;
    const n = spec.w * spec.h;
    const pix = getSprite32(n);
    pix.set(spec.pixels.subarray(0, n));
    let emi: Uint8Array | null = null;
    if (spec.emissive) {
      emi = getSprite8(n);
      emi.set(spec.emissive.subarray(0, n));
    }
    const ch = core.chunks.add(
      core,
      pix,
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
    return ch.id;
  }

  /* ------------------------------------------------------------------ rendering */

  setLighting(l: StageLighting): void {
    this.core.setLighting(l);
  }

  renderLayers(view: ViewRect, alpha: number): RenderLayer[] {
    return this.render.render(this.core, view, alpha);
  }

  renderExport(view: ViewRect, k: number): RenderLayer[] {
    return this.render.exportLayers(this.core, view, 0, k);
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
        h = mix32(h, j.wound + 1);
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
      cell += m + (b.shell !== null ? b.shell.farMass : 0);
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
      heldSlabs: core.bodyList.reduce((n, b) => n + b.wounds.held, 0),
      tickBodyLoss: core.route.bodyLoss,
      tickToParticles: core.route.toParticles,
      tickToChunks: core.route.toChunks,
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
    if (b.rotStep() !== 0) {
      // the rotated corners of the live box
      out.x0 = Infinity;
      out.y0 = Infinity;
      out.x1 = -Infinity;
      out.y1 = -Infinity;
      for (let k = 0; k < 4; k++) {
        localToWorldF(b, k & 1 ? x1 + 1 : x0, k & 2 ? y1 + 1 : y0, pt);
        out.x0 = Math.min(out.x0, pt.x);
        out.x1 = Math.max(out.x1, pt.x);
        out.y0 = Math.min(out.y0, pt.y);
        out.y1 = Math.max(out.y1, pt.y);
      }
      return true;
    }
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
