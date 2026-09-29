import {
  EMPTY_DAMAGE_RESULT,
  REGION_GRID,
  Rng,
  hash32,
  worldToLocal,
  type BodySpec,
  type BodyStats,
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
  type ChunkSpawn,
  type RenderLayer,
  type SimEvent,
  type StageLighting,
  type ViewRect,
} from '@/contracts';
import { shapeBounds, shapeContains } from '../shapes';

/**
 * A small MatterWorld test double: pixel-accurate overlap against live cells (same space.ts maths as the real world),
 * damage that simply deletes cells inside the shape (front-first, ≈1 cell per energy), honest BodyStats and regionGrid,
 * heal/restore/carve. No physics, no debris. Records what the combat code asked of it so tests can assert on it.
 */
export interface FakeWorld extends MatterWorld {
  /** Every damage event applied, in order (deep-copied scalars, shape by reference). */
  readonly damageLog: { bodyId: number; ev: DamageEvent; result: DamageResult }[];
  readonly particleCount: number;
  readonly chunkCount: number;
  readonly sources: (GravitySource | null)[];
  readonly shedLog: { bodyId: number; mass: number; style: string }[];
}

interface FakeBody extends MatterBody {
  snapshotMaterial: Uint8Array;
  snapshotDensity: Uint8Array;
  massPerCell: Float64Array;
  statsObj: BodyStats;
  dirtyStats: boolean;
  regionInitial: Float32Array;
}

const TMP = { x: 0, y: 0 };

export function createFakeWorld(seed = 1): FakeWorld {
  const bodies: FakeBody[] = [];
  let tickCount = 0;
  let nextId = 1;
  const rng = new Rng(seed);
  const damageLog: FakeWorld['damageLog'] = [];
  let particleCount = 0;
  let chunkCount = 0;
  const sources: (GravitySource | null)[] = [null, null];
  const shedLog: FakeWorld['shedLog'] = [];
  const bounds = { x0: 0, y0: 0, x1: 0, y1: 0 };

  const cellMass = (b: FakeBody, i: number): number => {
    const m = b.map.material[i]!;
    if (m === 0) return 0;
    return (b.map.density[i]! / 128) * (b.materials[m]?.density ?? 1);
  };

  const recount = (b: FakeBody): void => {
    const map = b.map;
    let mass = 0;
    let cells = 0;
    for (let i = 0; i < map.material.length; i++) {
      if (map.material[i] !== 0) {
        cells++;
        mass += cellMass(b, i);
      }
    }
    map.mass = mass;
    map.liveCells = cells;
    b.dirtyStats = false;
  };

  const regionCounts = (b: FakeBody, out: Float32Array, alive: boolean): void => {
    const map = b.map;
    out.fill(0);
    const G = REGION_GRID;
    for (let y = 0; y < map.h; y++) {
      const ry = Math.min(G - 1, Math.floor((y / map.h) * G));
      for (let x = 0; x < map.w; x++) {
        const i = y * map.w + x;
        const solid = alive ? map.material[i] !== 0 : b.snapshotMaterial[i] !== 0;
        if (!solid) continue;
        // world orientation: mirror columns when facing −1
        const lx = b.transform.facing === 1 ? x : map.w - 1 - x;
        const rx = Math.min(G - 1, Math.floor((lx / map.w) * G));
        out[ry * G + rx]! += 1;
      }
    }
  };

  const getStats = (b: FakeBody): BodyStats => {
    if (b.dirtyStats) recount(b);
    const s = b.statsObj;
    const map = b.map;
    s.mass = map.mass;
    s.initialMass = map.initialMass;
    s.massFrac = map.initialMass > 0 ? map.mass / map.initialMass : 0;
    s.cells = map.liveCells;
    s.initialCells = map.initialCells;
    // core integrity: fraction of core-disc cells still present × mean integrity
    let coreCells = 0;
    let coreAlive = 0;
    const R = Math.ceil(map.coreRadius);
    for (let y = -R; y <= R; y++)
      for (let x = -R; x <= R; x++) {
        if (x * x + y * y > map.coreRadius * map.coreRadius) continue;
        const cx = map.coreX + x;
        const cy = map.coreY + y;
        if (cx < 0 || cy < 0 || cx >= map.w || cy >= map.h) continue;
        coreCells++;
        if (map.material[cy * map.w + cx] !== 0) coreAlive += map.integrity[cy * map.w + cx]! / 255;
      }
    s.coreIntegrity = coreCells > 0 ? coreAlive / coreCells : 0;
    s.anchoredFrac = 1;
    s.exposedCoreFrac = 0;
    s.burningCells = 0;
    s.infectedCells = 0;
    s.crackedCells = 0;
    const cur = new Float32Array(REGION_GRID * REGION_GRID);
    regionCounts(b, cur, true);
    const ini = new Float32Array(REGION_GRID * REGION_GRID);
    regionCounts(b, ini, false);
    for (let i = 0; i < cur.length; i++) s.regionGrid[i] = ini[i]! > 0 ? Math.min(1, cur[i]! / ini[i]!) : 0;
    return s;
  };

  const world: FakeWorld = {
    get tickCount() {
      return tickCount;
    },
    damageLog,
    get particleCount() {
      return particleCount;
    },
    get chunkCount() {
      return chunkCount;
    },
    sources,
    shedLog,

    createBody(spec: BodySpec): MatterBody {
      const map = spec.map;
      for (let i = 0; i < map.material.length; i++) {
        if (map.material[i] !== 0) {
          map.integrity[i] = 255;
          map.pixels[i] = map.baseColor[i]!;
        }
      }
      const b: FakeBody = {
        id: nextId++,
        kind: spec.kind,
        ownerSlot: spec.ownerSlot,
        map,
        materials: spec.materials,
        transform: spec.transform,
        attributes: spec.attributes,
        cohesionScale: 1,
        heatScale: 1,
        snapshotMaterial: map.material.slice(),
        snapshotDensity: map.density.slice(),
        massPerCell: new Float64Array(0),
        statsObj: {
          mass: 0,
          initialMass: 0,
          massFrac: 1,
          cells: 0,
          initialCells: 0,
          coreIntegrity: 1,
          anchoredFrac: 1,
          exposedCoreFrac: 0,
          burningCells: 0,
          infectedCells: 0,
          crackedCells: 0,
          massGained: 0,
          massLost: 0,
          regionGrid: new Float32Array(REGION_GRID * REGION_GRID),
        },
        dirtyStats: true,
        regionInitial: new Float32Array(REGION_GRID * REGION_GRID),
      };
      recount(b);
      map.initialMass = map.mass;
      map.initialCells = map.liveCells;
      bodies[b.id] = b;
      return b;
    },
    removeBody(id: number): void {
      delete bodies[id];
    },
    getBody(id: number): MatterBody | undefined {
      return bodies[id];
    },

    applyDamage(bodyId: number, ev: DamageEvent): DamageResult {
      const b = bodies[bodyId];
      if (!b) return { ...EMPTY_DAMAGE_RESULT };
      const map = b.map;
      shapeBounds(ev.shape, bounds);
      // gather cells inside the shape, ordered front-first along the blow direction
      const cand: { i: number; k: number; wx: number; wy: number }[] = [];
      for (let wy = Math.floor(bounds.y0); wy <= Math.ceil(bounds.y1); wy++) {
        for (let wx = Math.floor(bounds.x0); wx <= Math.ceil(bounds.x1); wx++) {
          const px = wx + 0.5;
          const py = wy + 0.5;
          if (!shapeContains(ev.shape, px, py)) continue;
          worldToLocal(b.transform, px, py, TMP);
          const lx = Math.floor(TMP.x);
          const ly = Math.floor(TMP.y);
          if (lx < 0 || ly < 0 || lx >= map.w || ly >= map.h) continue;
          const i = ly * map.w + lx;
          if (map.material[i] === 0) continue;
          cand.push({ i, k: px * ev.dirX + py * ev.dirY, wx: px, wy: py });
        }
      }
      if (cand.length === 0) return { ...EMPTY_DAMAGE_RESULT };
      cand.sort((a, c) => a.k - c.k || a.i - c.i);
      const budget = Math.max(0, Math.round(ev.energy));
      const n = Math.min(cand.length, budget);
      let mass = 0;
      let sx = 0;
      let sy = 0;
      for (let j = 0; j < n; j++) {
        const c = cand[j]!;
        mass += cellMass(b, c.i);
        map.material[c.i] = 0;
        map.integrity[c.i] = 0;
        map.pixels[c.i] = 0;
        sx += c.wx;
        sy += c.wy;
      }
      let cx = 0;
      let cy = 0;
      for (const c of cand) {
        cx += c.wx;
        cy += c.wy;
      }
      map.mass -= mass;
      map.liveCells -= n;
      map.version++;
      b.dirtyStats = true;
      const res: DamageResult = {
        cellsTouched: cand.length,
        cellsRemoved: n,
        massRemoved: mass,
        massTransferred: 0,
        contactX: n > 0 ? sx / n : cx / cand.length,
        contactY: n > 0 ? sy / n : cy / cand.length,
        impulseX: ev.dirX * ev.energy * 0.3,
        impulseY: ev.dirY * ev.energy * 0.3,
        onDamagedFraction: 0,
        revealedInterior: false,
      };
      damageLog.push({ bodyId, ev, result: res });
      return res;
    },

    overlap(bodyId: number, shape: DamageShape, out?: OverlapResult): OverlapResult {
      const res = out ?? { cells: 0, x: NaN, y: NaN, nearestX: NaN, nearestY: NaN, coverage: 0 };
      res.cells = 0;
      res.x = NaN;
      res.y = NaN;
      res.nearestX = NaN;
      res.nearestY = NaN;
      res.coverage = 0;
      const b = bodies[bodyId];
      if (!b) return res;
      const map = b.map;
      shapeBounds(shape, bounds);
      let sx = 0;
      let sy = 0;
      let cells = 0;
      let integ = 0;
      let best = Infinity;
      const ox = shape.kind === 'line' ? shape.x0 : shape.x;
      const oy = shape.kind === 'line' ? shape.y0 : shape.y;
      for (let wy = Math.floor(bounds.y0); wy <= Math.ceil(bounds.y1); wy++) {
        for (let wx = Math.floor(bounds.x0); wx <= Math.ceil(bounds.x1); wx++) {
          const px = wx + 0.5;
          const py = wy + 0.5;
          if (!shapeContains(shape, px, py)) continue;
          worldToLocal(b.transform, px, py, TMP);
          const lx = Math.floor(TMP.x);
          const ly = Math.floor(TMP.y);
          if (lx < 0 || ly < 0 || lx >= map.w || ly >= map.h) continue;
          const i = ly * map.w + lx;
          if (map.material[i] === 0) continue;
          cells++;
          sx += px;
          sy += py;
          integ += map.integrity[i]! / 255;
          const d = (px - ox) * (px - ox) + (py - oy) * (py - oy);
          if (d < best) {
            best = d;
            res.nearestX = px;
            res.nearestY = py;
          }
        }
      }
      res.cells = cells;
      if (cells > 0) {
        res.x = sx / cells;
        res.y = sy / cells;
        const area = Math.max(1, (bounds.x1 - bounds.x0) * (bounds.y1 - bounds.y0) * 0.6);
        res.coverage = Math.min(1, integ / area);
      }
      return res;
    },
    solidAt(bodyId: number, wx: number, wy: number): boolean {
      const b = bodies[bodyId];
      if (!b) return false;
      worldToLocal(b.transform, wx, wy, TMP);
      const lx = Math.floor(TMP.x);
      const ly = Math.floor(TMP.y);
      if (lx < 0 || ly < 0 || lx >= b.map.w || ly >= b.map.h) return false;
      return b.map.material[ly * b.map.w + lx] !== 0;
    },

    tick(): void {
      tickCount++;
    },
    drainEvents(_into: SimEvent[]): void {
      /* the double emits nothing */
    },

    stats(bodyId: number): BodyStats {
      const b = bodies[bodyId];
      if (!b) throw new Error(`fakeWorld: no body ${bodyId}`);
      return getStats(b);
    },

    grow(_bodyId: number, _spec: GrowSpec): number {
      return 0;
    },
    shed(bodyId: number, mass: number, style: 'burn' | 'blow' | 'evaporate'): number {
      shedLog.push({ bodyId, mass, style });
      return 0;
    },
    heal(bodyId: number, fraction: number, seed2: number): void {
      const b = bodies[bodyId];
      if (!b) return;
      const r = new Rng(seed2);
      const map = b.map;
      for (let i = 0; i < map.material.length; i++) {
        if (map.material[i] === 0 && b.snapshotMaterial[i] !== 0 && r.chance(fraction)) {
          map.material[i] = b.snapshotMaterial[i]!;
          map.density[i] = b.snapshotDensity[i]!;
          map.integrity[i] = 170;
          map.pixels[i] = map.baseColor[i]!;
        }
      }
      recount(b);
      map.version++;
    },
    restore(bodyId: number): void {
      const b = bodies[bodyId];
      if (!b) return;
      const map = b.map;
      map.material.set(b.snapshotMaterial);
      map.density.set(b.snapshotDensity);
      for (let i = 0; i < map.material.length; i++) {
        map.integrity[i] = map.material[i] !== 0 ? 255 : 0;
        map.pixels[i] = map.material[i] !== 0 ? map.baseColor[i]! : 0;
      }
      recount(b);
      map.version++;
    },
    carve(bodyId: number, massFrac: number, seed2: number): void {
      const b = bodies[bodyId];
      if (!b) return;
      const r = new Rng(seed2);
      const map = b.map;
      let guard = 0;
      while (map.mass > map.initialMass * massFrac && guard++ < 400) {
        // a crater-ish bite biased away from the core, sometimes a slash
        const a = r.range(0, Math.PI * 2);
        const rad = r.range(0.35, 1) * Math.min(map.w, map.h) * 0.42;
        const cx = map.coreX + Math.cos(a) * rad;
        const cy = map.coreY + Math.sin(a) * rad;
        const cr = r.range(5, 13);
        for (let y = Math.floor(cy - cr); y <= Math.ceil(cy + cr); y++)
          for (let x = Math.floor(cx - cr); x <= Math.ceil(cx + cr); x++) {
            if (x < 0 || y < 0 || x >= map.w || y >= map.h) continue;
            if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > cr * cr) continue;
            const i = y * map.w + x;
            if (map.material[i] === 0) continue;
            if ((x - map.coreX) ** 2 + (y - map.coreY) ** 2 < (map.coreRadius * 1.3) ** 2 && massFrac > 0.3) continue;
            map.mass -= cellMass(b, i);
            map.liveCells--;
            map.material[i] = 0;
            map.integrity[i] = 0;
            map.pixels[i] = 0;
          }
      }
      b.dirtyStats = true;
      map.version++;
    },

    setGravitySource(slot: 0 | 1, src: GravitySource | null): void {
      sources[slot] = src;
    },
    spawnParticles(spec: ParticleSpawn): void {
      particleCount += spec.count;
    },
    spawnChunk(_spec: ChunkSpawn): void {
      chunkCount++;
    },

    setLighting(_l: StageLighting): void {
      /* no-op */
    },
    renderLayers(_view: ViewRect, _alpha: number): RenderLayer[] {
      return [];
    },
    debugOverlay(_bodyId: number, _mode: DebugOverlayMode): RenderLayer | null {
      return null;
    },

    hash(): number {
      let h = hash32(tickCount, nextId, rng.getState()[0]);
      for (const b of bodies) {
        if (!b) continue;
        h = hash32(h, b.id, b.map.liveCells, Math.round(b.map.mass * 100), b.map.version);
      }
      return h >>> 0;
    },
  };
  return world;
}
