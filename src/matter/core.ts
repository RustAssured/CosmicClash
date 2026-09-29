import {
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  MAX_BODY_DIM,
  Rng,
  hex,
  type ArenaInfo,
  type SimEvent,
  type StageLighting,
} from '@/contracts';
import type { Body } from './body';
import { ChunkPool, type Chunk } from './chunks';
import { CutFinder } from './cuts';
import { ParticlePool } from './particles';
import { ShapeQ } from './shape';
import { IntStack } from './util';

export interface GravityState {
  active: boolean;
  x: number;
  y: number;
  strength: number;
  radius: number;
  consumeRadius: number;
  creditBodyId: number;
}

/**
 * Mass ledger (cumulative, float64). Conservation law checked by tests:
 *   created + injected = Σ_bodies(cellMass + pool) + chunkMassLive + particleMassLive + dissipated + deleted
 */
export interface Ledger {
  /** Σ initial mass of bodies created. */
  created: number;
  /** Matter that appeared from a snapshot/external source: heal, restore, grow beyond the pool, spawnChunk. */
  injected: number;
  /** Matter that was destroyed without going through debris: removeBody, restore trimming grown cells, pool resets. */
  deleted: number;
  /** Particle expiry / evaporation / shed. */
  dissipated: number;
  /** Informational: total ever credited into body pools. */
  credited: number;
}

export interface ResolvedLighting {
  /** Unit direction FROM the surface TOWARD the light (view space), x right, y down, z toward camera. */
  lx: number;
  ly: number;
  lz: number;
  key: number;
  ambient: number;
  rim: number;
  src: StageLighting;
}

export type MatterKind = 'detach' | 'ignite' | 'crack' | 'consume' | 'harvest' | 'impact' | 'evaporate' | 'boil';
const KINDS: MatterKind[] = ['detach', 'ignite', 'crack', 'consume', 'harvest', 'impact', 'evaporate', 'boil'];
/** Aggregation window in ticks per kind (0 = immediate). Noisy kinds are merged so audio/camera are not flooded. */
const WINDOW: Record<MatterKind, number> = {
  detach: 0,
  ignite: 20,
  crack: 8,
  consume: 10,
  harvest: 10,
  impact: 0,
  evaporate: 14,
  boil: 16,
};

interface Agg {
  mass: number;
  sx: number;
  sy: number;
  n: number;
  slot: 0 | 1 | -1;
  last: number;
}

function resolveLighting(l: StageLighting): ResolvedLighting {
  const len2 = Math.hypot(l.dir[0], l.dir[1]) || 1;
  return {
    lx: l.dir[0] / len2,
    ly: l.dir[1] / len2,
    lz: l.dir[2],
    key: hex(l.color),
    ambient: hex(l.ambient),
    rim: hex(l.rim),
    src: l,
  };
}

/**
 * Shared world state: pools, ledger, gravity, lighting, event queue and scratch buffers. Every simulation module takes
 * a WorldCore so no module owns global state.
 */
export class WorldCore {
  readonly seed: number;
  readonly rng: Rng;
  tick = 0;
  nextBodyId = 0;
  readonly bodyById: (Body | undefined)[] = [];
  readonly bodyList: Body[] = [];
  readonly particles: ParticlePool;
  readonly chunks: ChunkPool;
  readonly ledger: Ledger = { created: 0, injected: 0, deleted: 0, dissipated: 0, credited: 0 };
  readonly gravity: [GravityState, GravityState] = [
    { active: false, x: 0, y: 0, strength: 0, radius: 1, consumeRadius: 0, creditBodyId: -1 },
    { active: false, x: 0, y: 0, strength: 0, radius: 1, consumeRadius: 0, creditBodyId: -1 },
  ];
  lighting: ResolvedLighting = resolveLighting(DEFAULT_LIGHTING);
  arena: ArenaInfo = { ...DEFAULT_ARENA };

  /* ---- events ---- */
  readonly events: SimEvent[] = [];
  private readonly agg: Agg[] = KINDS.map(() => ({ mass: 0, sx: 0, sy: 0, n: 0, slot: -1, last: -1000 }));

  /* ---- spray accumulator (mass-conserving particle emission for removed cells) ---- */
  sprayMass = 0;
  sprayX = 0;
  sprayY = 0;
  sprayVx = 0;
  sprayVy = 0;
  sprayKind = 2;
  sprayRamp = 0;

  /* ---- scratch shared by damage models ---- */
  readonly q = new ShapeQ();
  readonly covIdx = new Int32Array(MAX_BODY_DIM * MAX_BODY_DIM);
  readonly covW = new Float32Array(MAX_BODY_DIM * MAX_BODY_DIM);
  readonly cuts = new CutFinder();
  readonly stack = new IntStack(4096);
  readonly stack2 = new IntStack(4096);

  /** Hook: a chunk hit a body (set by the world; applies a capped KINETIC event). */
  chunkImpact: (body: Body, chunk: Chunk, x: number, y: number, dirX: number, dirY: number, speed: number) => void = () => {};

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.rng = new Rng(this.seed ^ 0xa5a5a5a5);
    this.particles = new ParticlePool();
    this.chunks = new ChunkPool();
  }

  setLighting(l: StageLighting): void {
    this.lighting = resolveLighting(l);
    for (const b of this.bodyList) b.visAll = true;
  }

  /** Owner slot of a body (for gravity-source lookups); -1 if none/unknown. */
  bodySlot(bodyId: number): number {
    const b = this.bodyById[bodyId];
    return b !== undefined && b.ownerSlot >= 0 ? b.ownerSlot : -1;
  }

  /**
   * Credit mass that arrived at a sink to `bodyId`'s pool (and debit the originator's `massLost`). If the receiving body
   * does not exist the mass dissipates. Caller has already removed the mass from the live chunk/particle tallies.
   */
  creditMass(bodyId: number, mass: number, x: number, y: number, originBody: number, kind: 'consume' | 'harvest'): void {
    const b = bodyId >= 0 ? this.bodyById[bodyId] : undefined;
    if (b === undefined) {
      this.ledger.dissipated += mass;
      return;
    }
    b.pool += mass;
    b.massGained += mass;
    b.statsDirty = true;
    this.ledger.credited += mass;
    if (originBody >= 0) {
      const o = this.bodyById[originBody];
      if (o !== undefined && o !== b) {
        o.massLost += mass;
        o.statsDirty = true;
      }
    }
    this.emitMatter(kind, x, y, mass, b.ownerSlot);
  }

  /** Queue a matter event. Noisy kinds aggregate over a window (see WINDOW); flush happens in `flushEvents`. */
  emitMatter(kind: MatterKind, x: number, y: number, mass: number, slot: 0 | 1 | -1): void {
    const k = KINDS.indexOf(kind);
    if (WINDOW[kind] === 0) {
      if (this.events.length < 96)
        this.events.push({ t: 'matter', kind, x, y, mass, slot });
      return;
    }
    const a = this.agg[k]!;
    a.mass += mass;
    a.sx += x * Math.max(mass, 0.01);
    a.sy += y * Math.max(mass, 0.01);
    a.n += Math.max(mass, 0.01);
    a.slot = slot;
  }

  /** End-of-tick: emit aggregated events whose window elapsed. */
  flushEvents(): void {
    for (let k = 0; k < KINDS.length; k++) {
      const a = this.agg[k]!;
      const kind = KINDS[k]!;
      const win = WINDOW[kind];
      if (a.n > 0 && this.tick - a.last >= win) {
        if (this.events.length < 96)
          this.events.push({ t: 'matter', kind, x: a.sx / a.n, y: a.sy / a.n, mass: a.mass, slot: a.slot });
        a.mass = 0;
        a.sx = 0;
        a.sy = 0;
        a.n = 0;
        a.last = this.tick;
      }
    }
  }

  drainEvents(into: SimEvent[]): void {
    for (let i = 0; i < this.events.length; i++) into.push(this.events[i]!);
    this.events.length = 0;
  }
}
