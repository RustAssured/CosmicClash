import type { AIContext, Difficulty } from './ai';
import type { DamageEvent, DamageShape, DamageType, OverlapResult } from './damage';
import type { InputFrame, InputSource } from './input';
import type { BodyStats, MatterBody, MatterWorld } from './matter';
import type { ArenaInfo, RenderLayer, StageId, StageLighting, ViewRect } from './render';
import type { Rng } from './rng';
import type { AimDir, EffectiveStats, MoveDef, MoveSlot, TitanDef, TitanId } from './titan';

/* ------------------------------------------------------------------------------------------------ *
 *  SIM EVENTS — one bus for everything the presentation layers react to (camera, audio, rumble, stage,
 *  particles, HUD announcer). Produced by fighters, the matter world and the match; consumed by app.
 * ------------------------------------------------------------------------------------------------ */

export type SimEvent =
  /** A move enters startup (anticipation pose visible this same tick). */
  | {
      t: 'move';
      slot: 0 | 1;
      titan: TitanId;
      moveId: string;
      moveSlot: MoveSlot;
      aim: AimDir;
      x: number;
      y: number;
    }
  /** Charge began / progressed (frac 0..1) / released. */
  | {
      t: 'charge';
      slot: 0 | 1;
      titan: TitanId;
      moveId: string;
      frac: number;
      phase: 'start' | 'hold' | 'release';
    }
  /** Startup ends and the active phase begins (whoosh/boom cue). */
  | {
      t: 'release';
      slot: 0 | 1;
      titan: TitanId;
      moveId: string;
      moveSlot: MoveSlot;
      x: number;
      y: number;
      power: number;
    }
  | { t: 'surge'; slot: 0 | 1; titan: TitanId; x: number; y: number; dirX: number; dirY: number }
  | {
      t: 'hit';
      attacker: 0 | 1;
      target: 0 | 1;
      /** The TARGET's titan id. */
      titan: TitanId;
      x: number;
      y: number;
      dirX: number;
      dirY: number;
      type: DamageType;
      energy: number;
      cellsRemoved: number;
      massRemoved: number;
      /** 0..1 share of the blow absorbed by Guard. */
      blocked: number;
      heavy: boolean;
      /** Landed on already-damaged matter (punish feedback). */
      onDamaged: number;
    }
  | { t: 'guard'; slot: 0 | 1; x: number; y: number; type: DamageType; broke: boolean }
  /** Expanding ring: renderer refraction + stage dust ripple. strength 0..1, radius = final radius px. */
  | { t: 'shockwave'; x: number; y: number; strength: number; radius: number; hue: number }
  /** Freeze sim for `ticks` (Match applies; clamped 60–135 ms since D27) and calls `freeze(ticks)` on BOTH fighters once per event; frozen fighters keep buffering input. */
  | { t: 'hitstop'; ticks: number }
  /** Camera shake impulse toward (dirX,dirY), amplitude px, low-frequency damped. */
  | { t: 'shake'; dirX: number; dirY: number; amp: number }
  /** amount is a fraction (0.1 = 10 % micro-zoom). */
  | { t: 'zoom'; amount: number }
  | { t: 'roll'; radians: number }
  /**
   * A burst of light. With x/y it is LOCAL (an impact light at that world point, never a full-screen wash — D5);
   * without, presentation treats it as local to the frame centre. `amount` 0..1.
   */
  | { t: 'flash'; amount: number; x?: number; y?: number }
  /**
   * Feel instrumentation (always emitted; cheap). accept: a command was taken this tick (`cmd` = move slot, 'steer',
   * 'feint', 'guard'). respond: the first tick on which that command changed a drawn pixel (`channel` says which:
   * integer root position, pose/rotation, a light/emissive, or a detached fx), `ticks` since accept. settle: the body is
   * back within rest thresholds, `ticks` since accept.
   */
  | {
      t: 'feel';
      slot: 0 | 1;
      kind: 'accept' | 'respond' | 'settle';
      cmd: string;
      ticks: number;
      channel?: 'root' | 'pose' | 'light' | 'fx';
    }
  /** scale is a fraction of real speed (0.05..1) for `ticks` sim ticks. */
  | { t: 'timescale'; scale: number; ticks: number }
  | { t: 'ko'; slot: 0 | 1; x: number; y: number }
  /** Matter-world happenings: island detached, ignition, crack burst, mass consumed by a sink, chunk impact. */
  | {
      t: 'matter';
      kind: 'detach' | 'ignite' | 'crack' | 'consume' | 'harvest' | 'impact' | 'evaporate' | 'boil';
      x: number;
      y: number;
      mass: number;
      slot: 0 | 1 | -1;
    }
  | { t: 'ultimate'; slot: 0 | 1; titan: TitanId; phase: 'start' | 'end'; x: number; y: number }
  | { t: 'rumble'; slot: 0 | 1; strong: number; weak: number; ms: number }
  | {
      t: 'round';
      phase: 'intro' | 'fight' | 'ko' | 'timeover' | 'end' | 'match';
      round: number;
      winner: 0 | 1 | -1;
    }
  | { t: 'resource'; slot: 0 | 1; kind: 'gain' | 'spend' | 'break'; amount: number }
  /** Free-form cosmetic cue keyed per titan (e.g. 'tendril-sever', 'moon-lost', 'node-dark', 'disk-shed'). */
  | { t: 'cue'; slot: 0 | 1; titan: TitanId; id: string; x: number; y: number; amount: number }
  /**
   * Arena hazards (src/sim/hazards.ts): `comet-warn` = a comet will enter at (x, y) heading (vx, vy) in `CometSchedule.warn`
   * ticks (id −1); `comet-enter` = it is in play as matter chunk `id`; `comet-retire` = it left the arena uncaught.
   */
  | {
      t: 'hazard';
      kind: 'comet-warn' | 'comet-enter' | 'comet-retire';
      id: number;
      x: number;
      y: number;
      vx: number;
      vy: number;
    };

/** A live arena comet as fighters see it (read-only snapshot, refreshed every tick before the fighters tick). */
export interface ArenaComet {
  /** Matter chunk id (use it with the world's capture API). */
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  mass: number;
  /** 0 free, 1 captured, 2 launched (chunkState mode); `owner` = capturing slot or −1. */
  mode: number;
  owner: number;
}

/* ------------------------------------------------------------------------------------------------ *
 *  FIGHTERS
 * ------------------------------------------------------------------------------------------------ */

export type FighterState =
  | 'intro'
  | 'idle'
  | 'move'
  | 'startup'
  | 'charge'
  | 'active'
  | 'recovery'
  | 'hitstun'
  | 'guard'
  | 'guardbreak'
  | 'surge'
  | 'ko'
  | 'victory';

export type MovePhase = 'startup' | 'charge' | 'active' | 'recovery';

/** Readable orbital states (SLICE_PLAN §5): how a fighter is moving relative to its foe. */
export type OrbitState = 'neutral' | 'orbit' | 'closing' | 'widening' | 'collision' | 'slingshot';

/** A live or upcoming hit shape (world space) — read by the AI (telegraphs), Training overlay and probes. */
export interface ThreatShape {
  shape: DamageShape;
  type: DamageType;
  energy: number;
  /** 0 = live now, >0 = ticks until it becomes live. */
  ticksUntilLive: number;
  /** Ticks remaining while live. */
  ticksLive: number;
  /** True for projectiles/beams/moons that exist independent of the attacker's body. */
  detached: boolean;
}

/**
 * Read-only per-tick snapshot of a fighter. Fighters mutate ONE FighterView instance in place (no allocation);
 * consumers must copy what they need to keep across ticks.
 */
export interface FighterView {
  slot: 0 | 1;
  titan: TitanId;
  /** Anchor position (world) and velocity px/s. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  /**
   * Whole-body angular state. `angle` (rad) is the visual orientation the body is drawn with (torsion/lean for the
   * Witness, the surface phase for the Planet's spin); `spin` its angular velocity (rad/s). 0 for titans without it.
   */
  angle: number;
  spin: number;
  /** Depth offset from the combat plane in px (z-offset prototype, D27/§5); 0 = in plane. */
  z: number;
  /** Planar orbital footwork state relative to the foe (for AI, camera, telemetry); 'neutral' when orbit is off. */
  orbit: OrbitState;
  /** World AABB of live matter (approximate, updated each tick). */
  boundsX0: number;
  boundsY0: number;
  boundsX1: number;
  boundsY1: number;
  state: FighterState;
  moveId: string | null;
  moveSlot: MoveSlot | null;
  aim: AimDir | null;
  phase: MovePhase | null;
  /** Ticks into the current move (from input), into the current phase, and the move's total ticks. */
  moveTick: number;
  phaseTick: number;
  moveTotal: number;
  /** 0..1 charge accumulation for hold-to-charge moves. */
  chargeFrac: number;
  /** True while a windup can still be feinted/cancelled into Guard/Surge. */
  cancellable: boolean;
  hitstunTicks: number;
  guardUp: boolean;
  /** 0..1 remaining Guard shell strength (sustained Crush breaks it). */
  guardHealth: number;
  intangible: boolean;
  /** Live effective stats derived from remaining mass. */
  stats: EffectiveStats;
  /** Live matter statistics (updated in place). */
  bodyStats: BodyStats;
  /** HUD integrity %, 0 (KO) … 100 (pristine): min of core-integrity and mass margins over the KO thresholds. */
  integrityPct: number;
  /** The unique resource (tendrils, nodes, accreted mass, fuel, moons, fragments) and its max. */
  resource: number;
  resourceMax: number;
  /** Ultimate meter 0..1. */
  meter: number;
  ko: boolean;
  /** Live and upcoming hit shapes, including detached projectiles/beams. */
  threats: ThreatShape[];
  /** Titan-specific pip count for the HUD (tendrils left, moons, dark/live nodes, …). */
  parts: number;
  /** Black-hole lensing source, if this titan lenses the scene. */
  lensRadius: number;
  lensStrength: number;
  /** Total ticks of hit-stop left on this fighter (visual vibration). */
  freezeTicks: number;
  /** The live body (for HUD portrait / debug). */
  body: MatterBody;
}

export interface FighterOptions {
  slot: 0 | 1;
  def: TitanDef;
  world: MatterWorld;
  seed: number;
  lighting: StageLighting;
  arena: ArenaInfo;
  x: number;
  y: number;
  facing: 1 | -1;
  /** Reuse a generated body across rounds (damage persists as scars). */
  existingBody?: MatterBody;
  /** From MatchConfig: locomotion model and depth-offset prototype. */
  footwork?: 'classic' | 'orbit';
  zdepth?: boolean;
  /** From MatchConfig: build the Last One as the Witness. */
  witness?: boolean;
}

export interface FighterTickCtx {
  tick: number;
  input: InputFrame;
  foe: Fighter;
  world: MatterWorld;
  rng: Rng;
  arena: ArenaInfo;
  events: SimEvent[];
  /** False during intro/outro: movement allowed, attacks ignored. */
  live: boolean;
  /** Live arena comets (empty on stages without them). */
  comets?: readonly ArenaComet[];
}

export interface HitResult {
  /** Fraction (0..1) of the incoming energy absorbed by Guard/parts. */
  blocked: number;
  cellsRemoved: number;
  massRemoved: number;
  /** World-space contact point for FX. */
  x: number;
  y: number;
  /** True if the blow connected with anything (body cell, part, projectile). */
  connected: boolean;
  /** Suggested hit-stop in ticks (already scaled by energy and masses). */
  hitstop: number;
}

export interface DebugShape {
  shape: DamageShape;
  color: number;
  label?: string;
}

export interface Fighter {
  readonly slot: 0 | 1;
  readonly def: TitanDef;
  readonly body: MatterBody;
  readonly view: FighterView;

  /** Advance one tick (Match order: fighter 0, fighter 1, then world.tick()). */
  tick(ctx: FighterTickCtx): void;
  /** Pixel-accurate probe used by the ATTACKER: does this shape touch any hittable thing (body cells, parts, orbiting moons)? */
  probe(shape: DamageShape, out?: OverlapResult): OverlapResult;
  /** Resolve an incoming attack: Guard, parts intercepts, then the matter world. Sets hit-stun/knockback. */
  receive(ev: DamageEvent, attacker: Fighter, events: SimEvent[]): HitResult;
  /** Freeze visuals for hit-stop (Match calls when it applies a hitstop). */
  freeze(ticks: number): void;
  /** Layers for this fighter (body sprite, tendrils, moons, beams, telegraphs…) for the given view/alpha. */
  renderLayers(view: ViewRect, alpha: number): RenderLayer[];
  /** Hitboxes/hurt shapes for Training overlay. */
  debugShapes(out: DebugShape[]): void;
  /** Prepare for the next round: reposition, keep damage as partially healed scars, refill resource/meter as rules say. */
  nextRound(x: number, y: number, facing: 1 | -1, healFraction: number, seed: number): void;
  /** Harness/training only: set the ultimate meter (0..1). Optional; fighters that support it implement it. */
  debugSetMeter?(v: number): void;
  /**
   * Symmetric pair resolution (collision, separation, momentum exchange). The Match calls it on fighter 0 ONLY, once per
   * live tick, after both fighters ticked and before world.tick(), so neither slot's order (D17) biases contact.
   */
  resolvePair?(foe: Fighter, ctx: FighterTickCtx): void;
  /** Fold fighter-private simulation state (rig regions, behaviour state) into a determinism hash (proposal 160/162). */
  stateHash?(h: number): number;
  /** Called by the match when the foe's KO is final/round decided (victory pose). */
  setVictory(): void;
  /** For the AI's short-horizon lookahead: frame data lookup by move id. */
  moveById(id: string): MoveDef | undefined;
}

export type FighterFactory = (opts: FighterOptions) => Fighter;

/* ------------------------------------------------------------------------------------------------ *
 *  MATCH
 * ------------------------------------------------------------------------------------------------ */

export type MatchMode = 'versus' | 'vsai' | 'training' | 'attract' | 'aivai';
export type SlotController = 'human' | 'ai' | 'dummy';

export interface SlotConfig {
  titan: TitanId;
  controller: SlotController;
  /** For 'ai' controllers. */
  aiLevel?: Difficulty;
}

export interface MatchConfig {
  seed: number;
  stage: StageId;
  mode: MatchMode;
  slots: [SlotConfig, SlotConfig];
  /** Harness: start damaged. */
  startState?: 'intact' | '50' | '10';
  /** Training: infinite time, no KO, regenerating dummy. */
  infinite?: boolean;
  /** Distance in px between the fighters' anchors at each round start (default 380). The harness uses it to stage contact quickly. */
  startGap?: number;
  /** Locomotion model (SLICE_PLAN §6): 'classic' (default, the current floor-less side view) or 'orbit' (planar orbital footwork). */
  footwork?: 'classic' | 'orbit';
  /** Shallow depth offset prototype (draw order, ±12 % scale, parallax; collision suppressed while |Δz| is large). */
  zdepth?: boolean;
  /**
   * The Last One is played as the rebuilt Witness (rig regions, new kit). The app turns it on by default since Phase 2
   * (`witness=0` in the URL for the old Last One); sim configs, tests and tools leave it off unless they ask for it.
   */
  witness?: boolean;
}

export type RoundPhase = 'intro' | 'fight' | 'ko' | 'timeover' | 'roundend' | 'matchend';

/** Pure, headless match orchestrator (src/sim). Runs identically in the browser and in Node. */
export interface MatchApi {
  readonly config: MatchConfig;
  readonly world: MatterWorld;
  readonly fighters: [Fighter, Fighter];
  readonly tick: number;
  readonly phase: RoundPhase;
  readonly phaseTick: number;
  readonly round: number;
  readonly wins: [number, number];
  readonly winner: 0 | 1 | -1;
  /** Ticks left on the round clock. */
  readonly roundTicksLeft: number;
  /** Ticks of hit-stop remaining (sim frozen). */
  readonly hitstopTicks: number;
  /** Requested time scale for the loop (KO dilation), 1 = normal. */
  readonly timeScale: number;
  /** Events produced by the last step() (cleared at the start of each step). */
  readonly events: readonly SimEvent[];
  /** Set input sources; `null` slot = idle dummy. */
  setSources(a: InputSource | null, b: InputSource | null): void;
  /** Advance exactly one tick. */
  step(): void;
  /** State hash for determinism tests (world + fighters + phase). */
  hash(): number;
  /** Current arena. */
  readonly arena: ArenaInfo;
  readonly lighting: StageLighting;
  readonly stage: StageId;
  /** Construct the AI context for slot `s` (public state only). */
  aiContext(s: 0 | 1): AIContext;
}

/* ------------------------------------------------------------------------------------------------ *
 *  HUD
 * ------------------------------------------------------------------------------------------------ */

export interface HudState {
  match: MatchApi;
  round: number;
  wins: [number, number];
  roundTicksLeft: number;
  phase: RoundPhase;
  announcer: string | null;
  /** Training mode: show frame data for these views. */
  training: boolean;
  paused: boolean;
}
