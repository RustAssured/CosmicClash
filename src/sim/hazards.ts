import {
  Rng,
  hash32,
  type ArenaComet,
  type ArenaInfo,
  type ChunkStateOut,
  type MatterWorld,
  type SimEvent,
  type StageLighting,
  type TitanDef,
} from '@/contracts';
import { generateCometBody } from '@/titans/art/comet';
import { DMath } from '@/contracts/dmath';

/**
 * Arena hazards (SLICE_PLAN §9, proposal 134): comets crossing the Star-birth Shearfield on a READABLE cadence — a warning
 * glint at the entry point `warn` ticks ahead, then a nucleus enters as a real matter chunk on a straight, legible line across
 * the fight band. Gravity (the Planet's well, Tidal Draw) bends it like any debris; the Planet's Comet Shepherd captures it
 * through the world's capture API; a comet that leaves the arena uncaught is retired (its mass dissipates).
 *
 * Pure and deterministic: its own seeded stream, sim ticks only, state folded into Match.hash().
 */
interface Live {
  id: number;
  enteredTick: number;
}

const MAX_AGE_TICKS = 60 * 14;

export class ArenaHazards {
  /** Snapshot the fighters read this tick. Reused objects; never hold on to them across ticks. */
  readonly comets: ArenaComet[] = [];
  private readonly rng: Rng;
  private readonly live: Live[] = [];
  private nextAt: number;
  private pending: { at: number; x: number; y: number; vx: number; vy: number } | null = null;
  private readonly st: ChunkStateOut = {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    spin: 0,
    mass: 0,
    radius: 0,
    mode: 0,
    owner: -1,
    origin: -1,
    temp: 0,
  };
  private readonly pool: ArenaComet[] = [];
  private spawned = 0;

  constructor(
    private readonly world: MatterWorld,
    private readonly arena: ArenaInfo,
    private readonly lighting: StageLighting,
    private readonly cometDef: TitanDef,
    seed: number,
  ) {
    this.rng = new Rng(seed);
    const s = arena.comets!;
    // the first comet comes after a full interval: the round opens on the fighters, not the sky
    this.nextAt = this.rng.intRange(s.every[0], s.every[1]);
  }

  /** Advance one fight tick (`roundTick` = ticks since the round went live). Emits hazard events. */
  step(roundTick: number, events: SimEvent[]): void {
    const s = this.arena.comets!;
    this.refresh(roundTick, events);
    // warn → enter
    if (!this.pending && roundTick >= this.nextAt - s.warn && this.uncaught() < s.maxLive) {
      this.pending = { at: this.nextAt, ...this.plan() };
      const p = this.pending;
      events.push({ t: 'hazard', kind: 'comet-warn', id: -1, x: p.x, y: p.y, vx: p.vx, vy: p.vy });
    }
    if (this.pending && roundTick >= this.pending.at) {
      this.enter(this.pending, roundTick, events);
      this.pending = null;
      this.nextAt = roundTick + this.rng.intRange(s.every[0], s.every[1]);
    }
  }

  private uncaught(): number {
    let n = 0;
    for (const c of this.comets) if (c.mode === 0) n++;
    return n;
  }

  /** Entry point on a side edge or the top corners, aimed across the fight band so the path reads at once. */
  private plan(): { x: number; y: number; vx: number; vy: number } {
    const a = this.arena;
    const s = a.comets!;
    const fromLeft = this.rng.chance(0.5);
    const inset = a.softWall + 8;
    const x = fromLeft ? a.minX + inset : a.maxX - inset;
    const y = this.rng.range(a.minY + inset, a.restY - 40);
    const tx = (a.minX + a.maxX) / 2 + this.rng.range(-160, 160) * (fromLeft ? 1 : -1);
    const ty = a.restY + this.rng.range(-110, 60);
    const len = DMath.hypot(tx - x, ty - y) || 1;
    const sp = this.rng.range(s.speed[0], s.speed[1]);
    return { x, y, vx: ((tx - x) / len) * sp, vy: ((ty - y) / len) * sp };
  }

  private enter(p: { x: number; y: number; vx: number; vy: number }, tick: number, events: SimEvent[]): void {
    const s = this.arena.comets!;
    const body = generateCometBody(this.cometDef, (this.rng.nextU32() ^ this.spawned) >>> 0, this.lighting);
    this.spawned++;
    const map = body.map;
    const id = this.world.spawnChunk({
      pixels: map.baseColor,
      w: map.w,
      h: map.h,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      spin: this.rng.range(-0.6, 0.6),
      mass: s.mass,
    });
    if (typeof id !== 'number' || id < 0) return;
    this.live.push({ id, enteredTick: tick });
    events.push({ t: 'hazard', kind: 'comet-enter', id, x: p.x, y: p.y, vx: p.vx, vy: p.vy });
  }

  /** Re-read every live comet from the world; retire the ones leaving the arena uncaught or too old. */
  private refresh(roundTick: number, events: SimEvent[]): void {
    const w = this.world;
    const a = this.arena;
    this.comets.length = 0;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const l = this.live[i]!;
      if (!w.chunkState || !w.chunkState(l.id, this.st)) {
        this.live.splice(i, 1); // shattered, consumed or merged into debris: no longer a comet
        continue;
      }
      const c = this.st;
      const leaving =
        c.mode === 0 &&
        ((c.x < a.minX + a.softWall && c.vx < 0) ||
          (c.x > a.maxX - a.softWall && c.vx > 0) ||
          (c.y < a.minY + a.softWall && c.vy < 0) ||
          (c.y > a.maxY - a.softWall && c.vy > 0));
      const tooOld = c.mode === 0 && roundTick - l.enteredTick > MAX_AGE_TICKS;
      if (leaving || tooOld) {
        if (w.retireChunk) w.retireChunk(l.id);
        else w.releaseChunk?.(l.id);
        events.push({ t: 'hazard', kind: 'comet-retire', id: l.id, x: c.x, y: c.y, vx: c.vx, vy: c.vy });
        this.live.splice(i, 1);
        continue;
      }
      const o = this.pool[this.comets.length] ?? {
        id: 0,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        mass: 0,
        mode: 0,
        owner: -1,
      };
      this.pool[this.comets.length] = o;
      o.id = l.id;
      o.x = c.x;
      o.y = c.y;
      o.vx = c.vx;
      o.vy = c.vy;
      o.mass = c.mass;
      o.mode = c.mode;
      o.owner = c.owner;
      this.comets.push(o);
    }
    this.comets.reverse();
  }

  hash(h: number): number {
    h = hash32(h, this.nextAt, this.spawned, this.pending ? this.pending.at : -1, this.live.length);
    for (const l of this.live) h = hash32(h, l.id, l.enteredTick);
    const r = this.rng.getState();
    return hash32(h, r[0], r[1], r[2], r[3]);
  }

  /** New round: forget comets (the world keeps their matter as ordinary debris) and restart the cadence. */
  resetRound(): void {
    for (const l of this.live) this.world.releaseChunk?.(l.id);
    this.live.length = 0;
    this.comets.length = 0;
    this.pending = null;
    const s = this.arena.comets!;
    this.nextAt = this.rng.intRange(s.every[0], s.every[1]);
  }
}
