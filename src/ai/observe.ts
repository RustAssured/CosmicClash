import {
  REGION_GRID,
  type FighterState,
  type FighterView,
  type MovePhase,
  type MoveSlot,
  type ThreatShape,
} from '@/contracts';

/** Flattened copy of a public ThreatShape: an AABB is all the AI needs (it never sees the foe's pending input, only its telegraphs). */
export interface ThreatSnap {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  energy: number;
  /** DAMAGE_TYPES index. */
  type: number;
  until: number;
  live: number;
  detached: boolean;
}

/** Everything about a fighter's PUBLIC view the AI is allowed to remember. Preallocated; filled in place. */
export class Snapshot {
  tick = 0;
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  facing: 1 | -1 = 1;
  state: FighterState = 'idle';
  moveSlot: MoveSlot | null = null;
  moveId: string | null = null;
  phase: MovePhase | null = null;
  moveTick = 0;
  phaseTick = 0;
  moveTotal = 0;
  chargeFrac = 0;
  cancellable = false;
  hitstunTicks = 0;
  guardUp = false;
  guardHealth = 1;
  intangible = false;
  bx0 = 0;
  by0 = 0;
  bx1 = 0;
  by1 = 0;
  integrityPct = 100;
  massFrac = 1;
  /** Share of the fighter's live cells that carry an assimilation infection (public body statistics). */
  infectFrac = 0;
  meter = 0;
  parts = 0;
  ko = false;
  mass = 5;
  reachMul = 1;
  readonly region = new Float32Array(REGION_GRID * REGION_GRID).fill(1);
  threatCount = 0;
  readonly threats: ThreatSnap[] = Array.from({ length: 8 }, () => ({
    x0: 0,
    y0: 0,
    x1: 0,
    y1: 0,
    energy: 0,
    type: 0,
    until: 0,
    live: 0,
    detached: false,
  }));

  /** Copy the public view. `withRegions` refreshes the 8×8 integrity grid too (it changes slowly). */
  copy(v: FighterView, tick: number, withRegions: boolean): void {
    this.tick = tick;
    this.x = v.x;
    this.y = v.y;
    this.vx = v.vx;
    this.vy = v.vy;
    this.facing = v.facing;
    this.state = v.state;
    this.moveSlot = v.moveSlot;
    this.moveId = v.moveId;
    this.phase = v.phase;
    this.moveTick = v.moveTick;
    this.phaseTick = v.phaseTick;
    this.moveTotal = v.moveTotal;
    this.chargeFrac = v.chargeFrac;
    this.cancellable = v.cancellable;
    this.hitstunTicks = v.hitstunTicks;
    this.guardUp = v.guardUp;
    this.guardHealth = v.guardHealth;
    this.intangible = v.intangible;
    this.bx0 = v.boundsX0;
    this.by0 = v.boundsY0;
    this.bx1 = v.boundsX1;
    this.by1 = v.boundsY1;
    this.integrityPct = v.integrityPct;
    this.massFrac = v.bodyStats.massFrac;
    this.infectFrac = v.bodyStats.infectedCells / Math.max(1, v.bodyStats.cells);
    this.meter = v.meter;
    this.parts = v.parts;
    this.ko = v.ko;
    this.mass = v.stats.mass;
    this.reachMul = v.stats.reachMul;
    if (withRegions) this.region.set(v.bodyStats.regionGrid);
    const n = Math.min(v.threats.length, this.threats.length);
    this.threatCount = n;
    for (let i = 0; i < n; i++) copyThreat(this.threats[i]!, v.threats[i]!);
  }
}

const TYPE_INDEX: Record<string, number> = {
  FRACTURE: 0,
  ASSIMILATION: 1,
  TIDAL: 2,
  THERMAL: 3,
  CRUSH: 4,
  KINETIC: 5,
};

function copyThreat(dst: ThreatSnap, t: ThreatShape): void {
  const s = t.shape;
  switch (s.kind) {
    case 'point':
    case 'field':
      dst.x0 = s.x - s.r;
      dst.x1 = s.x + s.r;
      dst.y0 = s.y - s.r;
      dst.y1 = s.y + s.r;
      break;
    case 'line': {
      const h = s.width * 0.5;
      dst.x0 = Math.min(s.x0, s.x1) - h;
      dst.x1 = Math.max(s.x0, s.x1) + h;
      dst.y0 = Math.min(s.y0, s.y1) - h;
      dst.y1 = Math.max(s.y0, s.y1) + h;
      break;
    }
    case 'cone': {
      // bounding box of the wedge: origin, the two edge points and the tip
      const a = Math.atan2(s.dirY, s.dirX);
      let x0 = s.x;
      let x1 = s.x;
      let y0 = s.y;
      let y1 = s.y;
      for (const da of [-s.halfAngle, 0, s.halfAngle]) {
        const px = s.x + Math.cos(a + da) * s.range;
        const py = s.y + Math.sin(a + da) * s.range;
        x0 = Math.min(x0, px);
        x1 = Math.max(x1, px);
        y0 = Math.min(y0, py);
        y1 = Math.max(y1, py);
      }
      dst.x0 = x0;
      dst.x1 = x1;
      dst.y0 = y0;
      dst.y1 = y1;
      break;
    }
    case 'ring':
      dst.x0 = s.x - s.r1;
      dst.x1 = s.x + s.r1;
      dst.y0 = s.y - s.r1;
      dst.y1 = s.y + s.r1;
      break;
  }
  dst.energy = t.energy;
  dst.type = TYPE_INDEX[t.type] ?? 0;
  dst.until = t.ticksUntilLive;
  dst.live = t.ticksLive;
  dst.detached = t.detached;
}

/**
 * Ring buffer of the foe's past public views. `at(tick)` returns the snapshot no newer than `tick` — asking for
 * `now − reactionTicks` gives the delayed observation; there is no API to read the present or the future.
 */
export class ObservationRing {
  private readonly buf: Snapshot[];
  private head = 0;
  private count = 0;
  private lastRegionTick = -1e9;

  constructor(capacity = 48) {
    this.buf = Array.from({ length: capacity }, () => new Snapshot());
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.lastRegionTick = -1e9;
  }

  push(v: FighterView, tick: number): void {
    const s = this.buf[this.head]!;
    const regions = tick - this.lastRegionTick >= 6 || this.count === 0;
    if (regions) this.lastRegionTick = tick;
    s.copy(v, tick, regions);
    if (!regions) {
      // carry the last grid forward
      const prev = this.buf[(this.head + this.buf.length - 1) % this.buf.length]!;
      s.region.set(prev.region);
    }
    this.head = (this.head + 1) % this.buf.length;
    if (this.count < this.buf.length) this.count++;
  }

  /** The newest snapshot that is at least `delay` ticks old (or the oldest one we have). */
  delayed(now: number, delay: number): Snapshot {
    const want = now - delay;
    let best: Snapshot | null = null;
    for (let i = 0; i < this.count; i++) {
      const s = this.buf[(this.head - 1 - i + this.buf.length * 2) % this.buf.length]!;
      if (s.tick <= want) {
        best = s;
        break;
      }
      best = s; // keep the oldest seen as a fallback
    }
    return best ?? this.buf[0]!;
  }
}
