import type { DamageEvent, DamageResult, DamageShape, DamageType, OverlapResult } from './damage';
import type { ArenaInfo, RenderLayer, StageLighting, ViewRect } from './render';
import type { SimEvent } from './sim';
import type { TitanAttributes } from './titan';

/* ------------------------------------------------------------------------------------------------ *
 *  MATERIALS
 *  Physics is owned by the matter module (archetype library, tuned by B2); look is authored per titan
 *  (B3). A titan's JSON lists MaterialSpec[]: `base` names a physics archetype in the matter library,
 *  `physics` overrides individual fields, `visual` is the titan's own look. The matter module resolves
 *  MaterialSpec[] → MaterialDef[] (index 0 is ALWAYS the reserved EMPTY material, cells with material 0
 *  are void). Material ids are indices into the resolved table and fit a Uint8.
 * ------------------------------------------------------------------------------------------------ */

export type DebrisKind = 'chunk' | 'dust' | 'gas' | 'ember' | 'shard' | 'liquid' | 'none';

export interface MaterialPhysics {
  /** Relative mass per cell at density byte 128: rock 1.0, iron 2.4, ice 0.6, gas 0.05, plasma 0.15. */
  density: number;
  /** 0..255 base bond strength between like cells; scaled by the owning titan's COHESION. */
  bond: number;
  /** 0..1 crack initiation resistance (1 = very tough). */
  toughness: number;
  /** 0..1: high = cracks propagate & the material shatters into chunks; low = erodes into dust/deforms. */
  brittleness: number;
  /**
   * Multiplier on incoming energy per damage type. 0 = immune, 1 = baseline, 2 = takes double, capped 4.
   * This table IS the rock-paper-scissors of the game: matchups must emerge from these numbers + the sim.
   */
  resist: Record<DamageType, number>;
  /** Energy needed to raise one cell by 1 temperature unit (higher = heats slower). */
  heatCapacity: number;
  /** 0..1 diffusion coefficient per tick to each neighbour (stable scheme: must keep 4·k ≤ 1). */
  conductivity: number;
  /** Temperature at which the cell ignites and burns on its own; 0 = non-flammable. */
  ignition: number;
  /** Integrity (0..255 scale) lost per tick while burning. */
  burnRate: number;
  /** Temperature at which the cell vaporises outright (becomes gas/embers); 0 = never. */
  vaporize: number;
  /** 0..1 fraction of incoming THERMAL energy soaked without heating cells (atmosphere, oceans absorb heat). */
  heatAbsorb: number;
  /** True for gas that burns/ignites when hot (atmosphere-as-fuel: "ignited gas feeding the Black Hole"). */
  flammableGas: boolean;
  /** 0..1 how easily ASSIMILATION infection takes hold and spreads through this material. */
  assimilable: number;
  /** What removed cells of this material become. */
  debris: DebrisKind;
  /** Material key the cell turns into when burnt out (e.g. 'ash'); '' = simply removed as embers/ash particles. */
  ashTo: string;
  /** If true, this material never counts toward "anchored" connectivity (gas, liquid clouds) — it drifts away when unsupported. */
  fluid: boolean;
}

export interface MaterialVisual {
  /** Hex ramp dark→light (3–8 steps) used to re-light exposed/debris cells. Hue-shifted. */
  ramp: string[];
  /** Base emissive 0..255 (glows/bloom even when cold). */
  emissive: number;
  /** Heat glow ramp cool→hot (hex), applied by temperature; last entry = white-hot. Omit = generic ember ramp. */
  glowRamp?: string[];
  /** Colour cells char toward while burning / after burn. */
  char: string;
  /** Crack line colour. */
  crack: string;
  /** Tint when infected/assimilated (Nexus lattice etc.); omit = crimson lattice default. */
  infect?: string;
  /** Debris tint override (defaults to ramp mid). */
  debris?: string;
}

/** JSON-authored material entry inside a titan definition. */
export interface MaterialSpec {
  /** Unique key inside the titan (e.g. 'crust', 'mantle', 'core', 'ocean'). */
  key: string;
  /** Physics archetype key from the matter library (e.g. 'rock', 'iron', 'ice', 'plasma', 'lattice', 'glass'). */
  base: string;
  /** Field overrides on top of the archetype. */
  physics?: Partial<Omit<MaterialPhysics, 'resist'>> & { resist?: Partial<Record<DamageType, number>> };
  visual: MaterialVisual;
}

/** Resolved material (packed colours). Index in the table = material id used in MatterMap.material. */
export interface MaterialDef extends MaterialPhysics {
  id: number;
  key: string;
  ramp: number[];
  emissive: number;
  glowRamp: number[];
  char: number;
  crack: number;
  infect: number;
  debrisColor: number;
  /** Resolved id of `ashTo` (0 = none). */
  ashId: number;
}

/* ------------------------------------------------------------------------------------------------ *
 *  MATTER MAP — 1 cell = 1 logical pixel. Structure-of-arrays, allocated once, mutated in place.
 * ------------------------------------------------------------------------------------------------ */

/** Half-open dirty rectangle in map-local cells. */
export interface DirtyRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** flags bits (Uint8). */
export const CellFlag = {
  BURNING: 1,
  CRACKED: 2,
  CHARRED: 4,
  ASSIMILATED: 8,
  SHRAPNEL: 16,
  SURFACE: 32, // adjacent to void (maintained by the matter module)
  GLOWING: 64,
  RESERVED: 128,
} as const;

export interface MatterMap {
  readonly w: number;
  readonly h: number;

  /* ---- per-cell simulation state (index = y * w + x) ---- */
  /** Material id (index into the body's material table). 0 = void/no matter. */
  readonly material: Uint8Array;
  /** Per-cell density byte; 128 = the material's nominal density. Mass = Σ density/128 · material.density. */
  readonly density: Uint8Array;
  /** 0..255. 255 = pristine. Cell is removed when it reaches 0. */
  readonly integrity: Uint8Array;
  /** Temperature units. Ambient = 0. Ignition/vaporise thresholds live on materials. */
  readonly temperature: Float32Array;
  /** Bond strength (0..255) to the right (x+1) and down (y+1) neighbour. 0 = broken. */
  readonly bondR: Uint8Array;
  readonly bondD: Uint8Array;
  /** 0..255 assimilation amount (ASSIMILATION). */
  readonly infection: Uint8Array;
  /** 0..255 emitted light this frame (drives bloom). Maintained by the matter module's visual refresh. */
  readonly emissive: Uint8Array;
  /** 0 = attached to core anchor, 1 = disconnected island awaiting detachment. */
  readonly detached: Uint8Array;
  /** CellFlag bits. */
  readonly flags: Uint8Array;
  /** Relief height 0..255 authored by the generator (for re-lighting newly exposed surfaces). */
  readonly height: Uint8Array;

  /* ---- art ---- */
  /** Pristine, fully lit colour of each cell as authored by the generator (packed RGBA, alpha 255 where matter). */
  readonly baseColor: Uint32Array;
  /**
   * DISPLAYED colour of each cell (packed RGBA; alpha 0 where void). Owned by the matter module's visual refresh
   * (heat glow, char, infection, cracks, rim on freshly exposed edges layered on baseColor). This array IS the
   * titan sprite the renderer uploads.
   */
  readonly pixels: Uint32Array;

  /* ---- metadata ---- */
  /** Core anchor in map-local cells: connectivity root, transform anchor, "where the heart is". */
  coreX: number;
  coreY: number;
  coreRadius: number;

  /** Cells changed since the renderer last consumed the rect. Renderer clears it after upload (sets to null). */
  dirty: DirtyRect | null;
  /** Monotonic counter bumped whenever `pixels` changes (renderer cache key). */
  version: number;

  /** Live mass in mass units and the value at creation (mass ledger includes transfers received). Updated by matter. */
  mass: number;
  initialMass: number;
  liveCells: number;
  initialCells: number;
}

/** Allocate an empty map (all void). Titan generators fill it in; matter takes ownership via createBody. */
export function createMatterMap(w: number, h: number): MatterMap {
  const n = w * h;
  return {
    w,
    h,
    material: new Uint8Array(n),
    density: new Uint8Array(n),
    integrity: new Uint8Array(n),
    temperature: new Float32Array(n),
    bondR: new Uint8Array(n),
    bondD: new Uint8Array(n),
    infection: new Uint8Array(n),
    emissive: new Uint8Array(n),
    detached: new Uint8Array(n),
    flags: new Uint8Array(n),
    height: new Uint8Array(n),
    baseColor: new Uint32Array(n),
    pixels: new Uint32Array(n),
    coreX: w >> 1,
    coreY: h >> 1,
    coreRadius: 6,
    dirty: null,
    version: 0,
    mass: 0,
    initialMass: 0,
    liveCells: 0,
    initialCells: 0,
  };
}

/* ------------------------------------------------------------------------------------------------ *
 *  BODIES
 * ------------------------------------------------------------------------------------------------ */

/** World placement of a body. Mutated by the owner (Fighter) every tick BEFORE world.tick(). See space.ts. */
export interface BodyTransform {
  /** World position of the anchor cell. */
  x: number;
  y: number;
  /** Anchor in map-local cells (normally the core). */
  anchorX: number;
  anchorY: number;
  /** +1 = as authored (faces right), -1 = mirrored. */
  facing: 1 | -1;
  /** Cosmetic integer-row shear in px (see space.ts leanShift). Also used by hit-testing. */
  lean: number;
}

export type BodyKind = 'titan' | 'moon' | 'part';

export interface BodySpec {
  kind: BodyKind;
  /** 0/1 = player slot that owns it; -1 = neutral. */
  ownerSlot: 0 | 1 | -1;
  /** Map produced by a titan generator (`baseColor`/`height` filled; the matter module inits the rest). */
  map: MatterMap;
  materials: readonly MaterialDef[];
  /** Attributes modulate the physics: COHESION scales bonds, HEAT TOLERANCE scales ignition/vaporise, etc. */
  attributes: TitanAttributes;
  /** RNG seed for this body's private stream (crack seeds, jitter). */
  seed: number;
  transform: BodyTransform;
  /** Whether the body's cells may be pulled/tossed as debris by fields, and whether it takes debris impacts. */
  takesDebrisImpacts?: boolean;
}

export interface MatterBody {
  readonly id: number;
  readonly kind: BodyKind;
  readonly ownerSlot: 0 | 1 | -1;
  readonly map: MatterMap;
  readonly materials: readonly MaterialDef[];
  readonly transform: BodyTransform;
  readonly attributes: TitanAttributes;
  /**
   * LIVE tuning multipliers owned by the fighter (default 1), read by the matter world every tick. `cohesionScale`
   * scales all bond strengths in every damage model (the Asteroid's "rubble pile held by weak gravity" drops it as
   * mass falls); `heatScale` scales ignition/vaporise thresholds and thermal resistance.
   */
  cohesionScale: number;
  heatScale: number;
}

/** Per-body report (cheap; computed incrementally by matter, safe to read every tick). */
export interface BodyStats {
  mass: number;
  initialMass: number;
  /** mass / initialMass. May exceed 1 for accretors (Black Hole, Nexus). */
  massFrac: number;
  cells: number;
  initialCells: number;
  /** 0..1 health of the core anchor region: (mean integrity of core-radius cells) × (core still present). */
  coreIntegrity: number;
  /** Fraction of live cells still connected to the core anchor. */
  anchoredFrac: number;
  /** 0..1 how much of the core region is exposed to void (nothing covering it). */
  exposedCoreFrac: number;
  burningCells: number;
  infectedCells: number;
  crackedCells: number;
  /** Mass received from / lost to other bodies through TIDAL/ASSIMILATION transfer. */
  massGained: number;
  massLost: number;
  /**
   * REGION_GRID×REGION_GRID (row-major, 8×8) integrity per region relative to pristine, 0..1, in WORLD orientation
   * (column 0 = world-left, row 0 = top), accounting for the body's current facing. NaN-free.
   */
  regionGrid: Float32Array;
}

/* ------------------------------------------------------------------------------------------------ *
 *  PARTICLES & CHUNKS (spawned by combat for VFX / by matter internally)
 * ------------------------------------------------------------------------------------------------ */

export type ParticleKind = 'spark' | 'ember' | 'dust' | 'gas' | 'ash' | 'glint' | 'plasma' | 'shard' | 'mote';

export interface ParticleSpawn {
  kind: ParticleKind;
  x: number;
  y: number;
  /** Velocity px/s. */
  vx: number;
  vy: number;
  /** Random spread added to the velocity (px/s, uniform in a disc). */
  spread: number;
  count: number;
  /** Packed ramp bright→dark over the particle's life (1–6 colours). */
  ramp: number[];
  /** Life in ticks (min,max). */
  life: [number, number];
  /** 1 = full world gravity fields; 0 = ignore fields. */
  fieldScale: number;
  /** Emissive strength 0..255 (bloom). */
  emissive: number;
  /** 1..3 pixels. */
  size: number;
  /** Drag per second (0 = none). */
  drag?: number;
}

export interface ChunkSpawn {
  /** RGBA pixels (alpha 0 = void) of the chunk, row-major. */
  pixels: Uint32Array;
  emissive?: Uint8Array;
  w: number;
  h: number;
  /** World position of the chunk's centre and velocity px/s, angular velocity rad/s. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  /** Mass units carried by the chunk. */
  mass: number;
}

/* ------------------------------------------------------------------------------------------------ *
 *  THE WORLD
 * ------------------------------------------------------------------------------------------------ */

export type DebugOverlayMode =
  'temperature' | 'integrity' | 'bonds' | 'infection' | 'islands' | 'stress' | 'materials';

export interface GravitySource {
  x: number;
  y: number;
  /** Pull acceleration at radius/2 in px/s² (falls off with distance to 0 at `radius`). */
  strength: number;
  radius: number;
  /** Debris entering this radius is consumed and its mass credited to `creditBodyId` (Black Hole disk). -1 = none. */
  consumeRadius?: number;
  creditBodyId?: number;
}

/** Mass-conservation ledger: everything created or injected must be accounted for in cells, pools, chunks, particles, or dissipated. */
export interface MatterLedger {
  created: number;
  injected: number;
  deleted: number;
  dissipated: number;
  credited: number;
  cellMass: number;
  poolMass: number;
  chunkMass: number;
  particleMass: number;
  /** (created + injected) − (cells + pools + chunks + particles + dissipated + deleted); ≈ 0. */
  error: number;
}

export interface GrowSpec {
  /** Number of cells to add, seeded from the outside in by adjacency to existing matter. */
  cells: number;
  /** Material key to grow (must exist in the body's table). */
  materialKey: string;
  /** Where growth prefers to occur, in world coordinates (default: around the core). */
  nearX?: number;
  nearY?: number;
}

/**
 * The destruction simulation. Pure TypeScript — NO DOM, NO three — so it runs headless in Node for tests and
 * the balance tournament. Deterministic: the same seed + the same call sequence yields the same `hash()`.
 * Zero allocation in hot loops; ≤ 5 ms per tick for two full bodies + debris.
 */
export interface MatterWorld {
  readonly tickCount: number;

  /* ---- bodies ---- */
  createBody(spec: BodySpec): MatterBody;
  removeBody(id: number): void;
  getBody(id: number): MatterBody | undefined;

  /* ---- damage ---- */
  /** Apply a damage event to a body (world-space geometry). Immediate effects now; ongoing effects (crack spread,
   *  burning fronts, infection, embedded shrapnel, tidal streams) continue inside tick(). */
  applyDamage(bodyId: number, ev: DamageEvent): DamageResult;
  /** Pixel-accurate overlap of a world-space shape with a body's live cells. Read-only, no allocation of note. */
  overlap(bodyId: number, shape: DamageShape, out?: OverlapResult): OverlapResult;
  /** True if a live cell of the body exists at this world position. */
  solidAt(bodyId: number, wx: number, wy: number): boolean;

  /* ---- stepping ---- */
  /** Advance one fixed tick: heat, cracks, burning, infection, tidal streams, connectivity + detachment, debris and
   *  particle physics, mass transfer. Callers set body transforms first. */
  tick(): void;
  /** Drain events produced since the last drain (detachments, ignitions, crack bursts, chunk impacts, consumption). */
  drainEvents(into: SimEvent[]): void;

  /* ---- queries ---- */
  /**
   * Live statistics of a body. Returns the body's OWN `BodyStats` object, updated in place (cheap to call every tick) — copy what
   * you keep. `BodyStats.mass` includes the accretion *pool* (mass received from sinks but not yet built into cells), so accretors
   * exceed `massFrac = 1`; `grow()` converts pool → cells.
   */
  stats(bodyId: number): BodyStats;
  /** World AABB of a body's live cells (FighterView.bounds*). Returns false if the body is gone or empty. */
  liveBounds(bodyId: number, out: { x0: number; y0: number; x1: number; y1: number }): boolean;
  /** Mass-conservation report (tests/debug): `error` must be ≈ 0. */
  ledger(): MatterLedger;

  /* ---- mass economy ---- */
  /** Add matter to a body (Black Hole disk regrowth, Nexus lattice growth). Returns cells actually added. */
  grow(bodyId: number, spec: GrowSpec): number;
  /** Debit `mass` units from the body without producing matter (Supernova spends fuel → shrinks the star). Returns cells removed. */
  shed(bodyId: number, mass: number, style: 'burn' | 'blow' | 'evaporate'): number;
  /** Between rounds: restore `fraction` (0..1) of the missing matter from the pristine snapshot, leaving scars
   *  (partially cracked/charred cells). Deterministic given `seed`. */
  heal(bodyId: number, fraction: number, seed: number): void;
  /** Reset a body to pristine (state=intact). */
  restore(bodyId: number): void;
  /** Harness: carve a body down to `massFrac` (e.g. 0.5, 0.1) with plausible, deterministic, type-appropriate scarring. */
  carve(bodyId: number, massFrac: number, seed: number): void;

  /* ---- gravity fields, particles, chunks ---- */
  setGravitySource(slot: 0 | 1, src: GravitySource | null): void;
  spawnParticles(spec: ParticleSpawn): void;
  spawnChunk(spec: ChunkSpawn): void;

  /* ---- rendering ---- */
  /** Stage lighting used to re-light freshly exposed surfaces and debris (call at match start; safe to call again). */
  setLighting(l: StageLighting): void;
  /** Arena used for the soft walls that keep debris in the play area (default DEFAULT_ARENA). Call with the stage arena at match start. */
  setArena(a: ArenaInfo): void;
  /** Debris + particle layers rasterised at logical resolution for this view (screen-space layers, z ordered back→front).
   *  `alpha` ∈ [0,1) extrapolates by velocity for smooth >60 Hz display. */
  renderLayers(view: ViewRect, alpha: number): RenderLayer[];
  /** Debug visualisation of one body (Training mode). Returns null for unsupported modes. */
  debugOverlay(bodyId: number, mode: DebugOverlayMode): RenderLayer | null;

  /* ---- determinism ---- */
  /** Stable 32-bit hash of all simulation state (bodies, debris, particles, rng). */
  hash(): number;
}
