import {
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  EMPTY_DAMAGE_RESULT,
  createMatterMap,
  hash32,
  type BodyStats,
  type BodyTransform,
  type Fighter,
  type FighterOptions,
  type FighterTickCtx,
  type FighterView,
  type HitResult,
  type MatterBody,
  type MatterWorld,
  type OverlapResult,
  type RenderLayer,
  type SimEvent,
  type TitanDef,
  type TitanId,
} from '@/contracts';
import type { MatchDeps } from '../match';

/** Minimal test doubles for the Match tests: a world that only counts ticks and a fighter driven by a per-tick callback. */
export function makeFakeWorld(_seed: number): MatterWorld & { ticks: number; carved: number[] } {
  let ticks = 0;
  const carved: number[] = [];
  const bodies = new Map<number, MatterBody>();
  const w = {
    get tickCount(): number {
      return ticks;
    },
    get ticks(): number {
      return ticks;
    },
    carved,
    createBody(spec: Parameters<MatterWorld['createBody']>[0]): MatterBody {
      const b: MatterBody = {
        id: bodies.size,
        kind: spec.kind,
        ownerSlot: spec.ownerSlot,
        map: spec.map,
        materials: spec.materials,
        transform: spec.transform,
        attributes: spec.attributes,
        cohesionScale: 1,
        heatScale: 1,
      };
      bodies.set(b.id, b);
      return b;
    },
    removeBody: (id: number) => void bodies.delete(id),
    getBody: (id: number) => bodies.get(id),
    applyDamage: () => ({ ...EMPTY_DAMAGE_RESULT }),
    overlap: (_id: number, _s: unknown, out?: OverlapResult) =>
      out ?? { cells: 0, x: NaN, y: NaN, nearestX: NaN, nearestY: NaN, coverage: 0 },
    solidAt: () => false,
    tick: () => void ticks++,
    drainEvents: () => undefined,
    stats: () => emptyStats(),
    grow: () => 0,
    shed: () => 0,
    heal: () => undefined,
    restore: () => undefined,
    carve: (id: number) => void carved.push(id),
    setGravitySource: () => undefined,
    spawnParticles: () => undefined,
    spawnChunk: () => undefined,
    setLighting: () => undefined,
    renderLayers: (): RenderLayer[] => [],
    debugOverlay: () => null,
    hash: () => hash32(ticks),
  };
  return w as unknown as MatterWorld & { ticks: number; carved: number[] };
}

export function emptyStats(): BodyStats {
  return {
    mass: 100,
    initialMass: 100,
    massFrac: 1,
    cells: 100,
    initialCells: 100,
    coreIntegrity: 1,
    anchoredFrac: 1,
    exposedCoreFrac: 0,
    burningCells: 0,
    infectedCells: 0,
    crackedCells: 0,
    massGained: 0,
    massLost: 0,
    regionGrid: new Float32Array(64).fill(1),
  };
}

export function makeFakeView(slot: 0 | 1, body: MatterBody, titan: TitanId = 'lastone'): FighterView {
  return {
    slot,
    titan,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    facing: slot === 0 ? 1 : -1,
    boundsX0: 0,
    boundsY0: 0,
    boundsX1: 0,
    boundsY1: 0,
    state: 'idle',
    moveId: null,
    moveSlot: null,
    aim: null,
    phase: null,
    moveTick: 0,
    phaseTick: 0,
    moveTotal: 0,
    chargeFrac: 0,
    cancellable: false,
    hitstunTicks: 0,
    guardUp: false,
    guardHealth: 1,
    intangible: false,
    stats: { speedMul: 1, damageMul: 1, mass: 5, reachMul: 1, tempoMul: 1 },
    bodyStats: emptyStats(),
    integrityPct: 100,
    resource: 1,
    resourceMax: 1,
    meter: 0,
    ko: false,
    threats: [],
    parts: 0,
    lensRadius: 0,
    lensStrength: 0,
    freezeTicks: 0,
    body,
  };
}

export interface FakeFighter extends Fighter {
  ticks: number;
  lastInput: { pressed: number; held: number };
  freezes: number[];
  script?: (f: FakeFighter, ctx: FighterTickCtx) => void;
  victory: boolean;
  rounds: number;
}

export function makeFakeFighter(opts: FighterOptions): FakeFighter {
  const transform: BodyTransform = {
    x: opts.x,
    y: opts.y,
    anchorX: 10,
    anchorY: 10,
    facing: opts.facing,
    lean: 0,
  };
  const body = opts.world.createBody({
    kind: 'titan',
    ownerSlot: opts.slot,
    map: createMatterMap(20, 20),
    materials: [],
    attributes: opts.def.attributes,
    seed: opts.seed,
    transform,
  });
  const view = makeFakeView(opts.slot, body, opts.def.id);
  view.x = opts.x;
  view.y = opts.y;
  const f: FakeFighter = {
    slot: opts.slot,
    def: opts.def,
    body,
    view,
    ticks: 0,
    lastInput: { pressed: 0, held: 0 },
    freezes: [],
    victory: false,
    rounds: 0,
    tick(ctx) {
      f.ticks++;
      f.lastInput.pressed = ctx.input.pressed;
      f.lastInput.held = ctx.input.held;
      f.script?.(f, ctx);
    },
    probe: (_s, out) => out ?? { cells: 0, x: NaN, y: NaN, nearestX: NaN, nearestY: NaN, coverage: 0 },
    receive: (): HitResult => ({
      blocked: 0,
      cellsRemoved: 0,
      massRemoved: 0,
      x: 0,
      y: 0,
      connected: false,
      hitstop: 0,
    }),
    freeze(t) {
      f.freezes.push(t);
    },
    renderLayers: () => [],
    debugShapes: () => undefined,
    nextRound(x, y, facing) {
      f.rounds++;
      view.x = x;
      view.y = y;
      view.facing = facing;
      view.ko = false;
      view.integrityPct = 100;
      view.state = 'idle';
    },
    setVictory() {
      f.victory = true;
    },
    moveById: () => undefined,
  };
  return f;
}

export function fakeDef(id: TitanId): TitanDef {
  return {
    id,
    name: id,
    nameKo: id,
    epithet: '',
    attributes: { mass: 5, cohesion: 5, heat: 5, gravity: 5, reach: 5, tempo: 5 },
    resource: { id: 'tendrils', name: 'r', nameKo: 'r', max: 1, start: 1, display: 'bar' },
    destruction: 'FRACTURE',
    passive: { name: '', text: '' },
    failureMode: { name: '', text: '' },
    materials: [],
    art: { w: 20, h: 20, coreX: 10, coreY: 10, coreRadius: 3, params: {} },
    moves: [],
    ai: { weights: {}, style: '' },
    ui: { accent: '#fff', accent2: '#fff', tagline: '' },
  };
}

export function fakeDeps(): MatchDeps {
  return {
    createWorld: makeFakeWorld,
    createFighter: makeFakeFighter,
    getTitanDef: fakeDef,
    arena: DEFAULT_ARENA,
    lighting: DEFAULT_LIGHTING,
  };
}

export type { SimEvent };
