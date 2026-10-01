import {
  type DamageParams,
  Btn,
  DamageFlag,
  EMPTY_DAMAGE_RESULT,
  HITSTOP_MAX_TICKS,
  HITSTOP_MIN_TICKS,
  INPUT_BUFFER_TICKS,
  KO_CORE_INTEGRITY,
  KO_MASS_FRAC,
  MAX_FIGHTER_DX,
  MAX_FIGHTER_DY,
  TICK_DT,
  clamp,
  clamp01,
  hex,
  localToWorld,
  makeLayer,
  type AimDir,
  type ArenaInfo,
  type BodyStats,
  type DamageEvent,
  type DamageShape,
  type DamageType,
  type DebugShape,
  type EffectiveStats,
  type Fighter,
  type FighterOptions,
  type FighterState,
  type FighterTickCtx,
  type FighterView,
  type HitboxDef,
  type HitResult,
  type InputFrame,
  type MatterBody,
  type MatterWorld,
  type MoveDef,
  type MoveSlot,
  type OverlapResult,
  type ParticleSpawn,
  type RenderLayer,
  type SimEvent,
  type StageLighting,
  type ThreatShape,
  type TitanDef,
  type ViewRect,
} from '@/contracts';
import { generateTitanBody, rememberRig, rigOfMap, type TitanRig } from '@/titans';
import { buildRigFor } from '@/titans/rigs';
import type { Behaviour, HitInfo, InterceptResult } from './behaviour';
import { createBehaviour } from './behaviours';
import { resolveFeel, type Feel } from './feel';
import { FeelTracker, type DrawnState } from './feelTrack';
import { makeImpactResult, makeMassProps, measureMass, resolveImpact } from './impact';
import { InputBuffer } from './inputBuffer';
import { ActiveMove, MAX_HITBOXES, aimFromStick, fillDisplacement, resolveFrame } from './move';
import { ORBIT, ZDEPTH, classifyOrbit, makeOrbitFrame, orbitFrame, type OrbitMemory } from './orbit';
import { Angular, anticipationKick, poseLeanTarget, spinKeysOf } from './pose';
import {
  aimRotation,
  asShape,
  copyShape,
  instantiateTemplate,
  makeFatShape,
  shapeIntersectsDisc,
  translateShape,
  type Bounds,
  type FatShape,
  type TemplatePlacement,
} from './shapes';
import { computeStats, topSpeed } from './stats';
import { TUNING as T } from './tuning';

/** Damage-type absorption profile of a titan's Guard shell (the guard move's `extra.shell`). */
export interface ShellProfile {
  /** Fraction (0..1) of the incoming energy absorbed by a healthy shell, per damage type. */
  absorb: Partial<Record<DamageType, number>>;
}

const ATTACK_BITS: readonly number[] = [Btn.ULTIMATE, Btn.SIGNATURE, Btn.CRUSH, Btn.STRIKE, Btn.SURGE];
const BIT_SLOT: Record<number, MoveSlot> = {
  [Btn.STRIKE]: 'strike',
  [Btn.CRUSH]: 'crush',
  [Btn.SURGE]: 'surge',
  [Btn.SIGNATURE]: 'signature',
  [Btn.ULTIMATE]: 'ultimate',
};
const MAX_THREATS = 20;
const DEFAULT_SHELL: ShellProfile = { absorb: {} };

const makeStats = (): EffectiveStats => ({ speedMul: 1, damageMul: 1, mass: 5, reachMul: 1, tempoMul: 1 });

const emptyBodyStats = (): BodyStats => ({
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
  regionGrid: new Float32Array(64),
});

/**
 * The generic Fighter: input buffer, move state machine (startup → charge → active → recovery), feint/guard/surge cancels,
 * movement with weight, pixel-accurate hit resolution against the foe's matter, guard shells, hit-stun and knockback,
 * meter and resource, live stats from remaining mass, KO, and the per-tick FighterView. Everything titan-specific lives in a
 * `Behaviour` (tendrils, fragments…) plus the titan's JSON move data. Zero allocation per tick.
 */
/** Where the graded tether starts (the hard cap is MAX_FIGHTER_DX/DY): see docs/proposals/006-fighter-tether.md. */
const TAU = Math.PI * 2;
const TETHER_SOFT_DX = 330;
const TETHER_SOFT_DY = 140;

export class FighterImpl implements Fighter {
  readonly slot: 0 | 1;
  readonly def: TitanDef;
  readonly body: MatterBody;
  readonly view: FighterView;
  readonly world: MatterWorld;
  readonly arena: ArenaInfo;
  readonly lighting: StageLighting;
  readonly rig: TitanRig;
  readonly behaviour: Behaviour;
  readonly stats: EffectiveStats = makeStats();
  readonly seed: number;

  /* ---- kinematics (px, px/s) ---- */
  px: number;
  py: number;
  vx = 0;
  vy = 0;
  facing: 1 | -1;
  /** Position of the transform on the previous tick (render interpolation). */
  prevTx: number;
  prevTy: number;
  leanF = 0;
  leanV = 0;

  /* ---- state ---- */
  state: FighterState = 'intro';
  stateTicks = 0;
  readonly mv = new ActiveMove();
  hitstunTicks = 0;
  stunElapsed = 0;
  stunEndTick = -1e9;
  guardHealth = 1;
  guardUp = false;
  guardTicks = 0;
  guardLockUntil = 0;
  guardBreakTicks = 0;
  surgeReadyAt = 0;
  escapeReadyAt = 0;
  meter = 0;
  resource: number;
  resourceMax: number;
  ko = false;
  victory = false;
  live = false;
  intangible = false;
  freezeTicks = 0;
  freezeAge = 0;
  /** Time-limited speed multiplier put on this fighter by the foe (chains, tar, …): 1 = none. See `applyStatus`. */
  statusMul = 1;
  statusTicks = 0;
  /** Set by `receive`: did the last blow reach this fighter's body (false = it only skimmed parts such as tendrils or moons)? */
  lastBodyTouched = true;
  lastHitTick = -1e9;
  lastHitDirX = 1;
  lastHitDirY = 0;
  lastDealtTick = -1e9;
  tickNo = 0;
  /** Per-titan body-weight tuning (defaults from mass; the JSON `feel` block overrides). */
  readonly feel: Feel;
  /** Locomotion model and the depth-offset prototype (MatchConfig.footwork / zdepth). */
  readonly footwork: 'classic' | 'orbit';
  readonly zdepth: boolean;
  /** Whole-body angular state (torsion or free spin): written to FighterView.angle/spin. */
  readonly ang = new Angular();
  /** Depth offset (px, +toward the viewer) and its velocity: only moves with `zdepth`. */
  z = 0;
  vz = 0;
  /** Orbital state of the last tick (view.orbit) and the classifier's memory. */
  private readonly orbitMem: OrbitMemory = { prevVr: 0, sling: 0 };
  private readonly oframe = makeOrbitFrame();
  /** Acceleration state of the underdamped stick-to-velocity filter. */
  private accX = 0;
  private accY = 0;
  /** True while a KO tumble glides on its long time constant. */
  private tumble = false;
  /** Velocity time constant while stunned, set by the last blow (a light blow is braked at once). */
  private brakeTau: number = T.stunDragTau;
  /** Visual offsets (whole px, added to the transform only): hit vibration and attacker follow-through. */
  private shudderAmp = 0;
  private followX = 0;
  private followY = 0;
  /** The exact visual offset used for the transform this tick (so a later re-placement keeps it). */
  private offX = 0;
  private offY = 0;
  /** Attack axis of the move in progress (unit, world) and the matching template rotation. */
  aimUx = 1;
  aimUy = 0;
  private readonly rot = { c: 1, s: 0 };
  private readonly placement: TemplatePlacement = { x: 0, y: 0, facing: 1, scale: 1, rotC: 1, rotS: 0 };
  /** Next scripted spin key of the move in progress. */
  private spinIdx = 0;
  /** Feel instrumentation and the pixel guarantee of the accept tick. */
  readonly feelTrack = new FeelTracker();
  private readonly drawn: DrawnState = { rx: 0, ry: 0, lean: 0 };
  private acceptAt = -1;
  /** Direction (facing-relative sign) the accept-tick pose kick should take if nothing else moved a pixel. */
  private acceptDir = 1;
  /** Stick-as-command tracking (a fresh push or a sharp change of direction is a new 'steer' command). */
  private steerOn = false;
  private steerDX = 0;
  private steerDY = 0;
  private steerIdle = 99;
  /** Mass properties (centre of mass, gyration) measured lazily when a blow lands, and the impact scratch. */
  private readonly massProps = makeMassProps();
  private readonly impact = makeImpactResult();
  /** The lean target used this tick (settle detection). */
  private leanTarget = 0;
  private fxDist = 0;
  private lastFxTick = -1e9;
  private fxIdle = 0;

  /* ---- per-tick context (valid inside tick()) ---- */
  events: SimEvent[] = [];
  foe!: Fighter;
  ctx!: FighterTickCtx;
  input!: InputFrame;
  readonly buf = new InputBuffer();

  /* ---- data lookups ---- */
  readonly slotMoves: Partial<Record<MoveSlot, MoveDef>> = {};
  readonly movesById = new Map<string, MoveDef>();
  shell: ShellProfile = DEFAULT_SHELL;

  /* ---- preallocated scratch ---- */
  readonly hitInfo: HitInfo = {
    knockX: 0,
    knockY: 0,
    guardPressure: 0,
    hitstopBase: 8,
    heavy: false,
    continuous: false,
    stunMul: 1,
    moveId: '',
  };
  private readonly liveShape: FatShape = makeFatShape();
  private readonly deepShape: FatShape = makeFatShape();
  private readonly candShape: FatShape = makeFatShape();
  private readonly evShape: FatShape = makeFatShape();
  private readonly ev: DamageEvent;
  private readonly evIn: DamageEvent;
  private readonly ovTmp: OverlapResult = {
    cells: 0,
    x: NaN,
    y: NaN,
    nearestX: NaN,
    nearestY: NaN,
    coverage: 0,
  };
  private readonly probeOut: OverlapResult = {
    cells: 0,
    x: NaN,
    y: NaN,
    nearestX: NaN,
    nearestY: NaN,
    coverage: 0,
  };
  private readonly hitRes: HitResult = {
    blocked: 0,
    cellsRemoved: 0,
    massRemoved: 0,
    x: 0,
    y: 0,
    connected: false,
    hitstop: 0,
  };
  private readonly icpt: InterceptResult = {
    absorbed: 0,
    partsHit: 0,
    extraCells: 0,
    extraMass: 0,
    touched: false,
  };
  private readonly threatPool: ThreatShape[] = [];
  private readonly threatShapes: FatShape[] = [];
  private threatCount = 0;
  private readonly layerOut: RenderLayer[] = [];
  private readonly bodyLayer: RenderLayer;
  private readonly sparkRamp: number[];
  /** Reusable particle request (behaviours mutate it and hand it to `world.spawnParticles`). */
  readonly particleSpawn: ParticleSpawn;
  /** Cached live bounds: refreshed from the world when the matter changed / the body flipped / every few ticks, else shifted with the transform. */
  private readonly bbCache = { tx: 0, ty: 0, lean: 0, facing: 1, version: -1, stamp: -1e9 };
  private readonly bodyDirty = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private lastEventTick = -1e9;
  private readonly bnd: Bounds = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private moveActiveNow = false;

  constructor(opts: FighterOptions) {
    this.slot = opts.slot;
    this.def = opts.def;
    this.world = opts.world;
    this.arena = opts.arena;
    this.lighting = opts.lighting;
    this.seed = opts.seed;
    this.facing = opts.facing;
    this.px = opts.x;
    this.py = opts.y;
    this.prevTx = opts.x;
    this.prevTy = opts.y;
    this.resource = opts.def.resource.start;
    this.resourceMax = opts.def.resource.max;
    this.footwork = opts.footwork ?? 'classic';
    this.zdepth = !!opts.zdepth;

    for (const m of opts.def.moves) {
      this.movesById.set(m.id, m);
      if (m.extra?.['followUpOnly']) continue;
      if (!this.slotMoves[m.slot]) this.slotMoves[m.slot] = m;
    }
    const guard = this.slotMoves.guard;
    if (guard?.extra?.['shell']) this.shell = guard.extra['shell'] as ShellProfile;

    if (opts.existingBody) {
      this.body = opts.existingBody;
      this.rig = rigOfMap(opts.existingBody.map) ?? buildRigFor(opts.def, opts.seed);
    } else {
      const g = generateTitanBody(opts.def, opts.seed, opts.lighting);
      this.rig = g.rig;
      this.body = opts.world.createBody({
        kind: 'titan',
        ownerSlot: opts.slot,
        map: g.map,
        materials: g.materials,
        attributes: opts.def.attributes,
        seed: opts.seed,
        transform: {
          x: opts.x,
          y: opts.y,
          anchorX: g.map.coreX,
          anchorY: g.map.coreY,
          facing: opts.facing,
          lean: 0,
        },
      });
      rememberRig(g.map, g.rig);
    }
    const t = this.body.transform;
    t.x = Math.round(opts.x);
    t.y = Math.round(opts.y);
    t.facing = opts.facing;
    t.lean = 0;

    this.ev = this.makeEvent();
    this.evIn = this.makeEvent();
    for (let i = 0; i < MAX_THREATS; i++) {
      const sh = makeFatShape();
      this.threatShapes.push(sh);
      this.threatPool.push({
        shape: asShape(sh),
        type: 'FRACTURE',
        energy: 0,
        ticksUntilLive: 0,
        ticksLive: 0,
        detached: false,
      });
    }
    const map = this.body.map;
    const bl = makeLayer(`titan-${opts.slot}`, 'world', 0, 1, 1);
    bl.pixels = map.pixels;
    bl.emissive = map.emissive;
    bl.w = map.w;
    bl.h = map.h;
    bl.anchorX = t.anchorX;
    bl.anchorY = t.anchorY;
    this.bodyLayer = bl;
    const acc = hex(opts.def.ui.accent);
    const acc2 = hex(opts.def.ui.accent2);
    this.sparkRamp = [0xffffffff, acc2, acc, (acc & 0x00ffffff) | 0x99000000];
    this.feel = resolveFeel(opts.def);
    this.particleSpawn = {
      kind: 'spark',
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      spread: 120,
      count: 0,
      ramp: this.sparkRamp,
      life: [12, 30],
      fieldScale: 0.2,
      emissive: 200,
      size: 1,
      drag: 1.5,
    };

    this.view = this.makeView();
    this.behaviour = createBehaviour(this);
    this.behaviour.attach();
    this.refreshStats();
    this.syncView();
  }

  private makeEvent(): DamageEvent {
    return {
      type: 'FRACTURE',
      shape: asShape(this.evShape ?? makeFatShape()),
      energy: 0,
      dirX: 1,
      dirY: 0,
      duration: 1,
      sourceMass: 5,
      sourceBodyId: -1,
      originX: 0,
      originY: 0,
      flags: 0,
      params: {},
    };
  }

  private makeView(): FighterView {
    const threats: ThreatShape[] = [];
    return {
      slot: this.slot,
      titan: this.def.id,
      x: this.px,
      y: this.py,
      vx: 0,
      vy: 0,
      facing: this.facing,
      angle: 0,
      spin: 0,
      z: 0,
      orbit: 'neutral',
      boundsX0: 0,
      boundsY0: 0,
      boundsX1: 0,
      boundsY1: 0,
      state: 'intro',
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
      stats: this.stats,
      bodyStats: emptyBodyStats(),
      integrityPct: 100,
      resource: this.resource,
      resourceMax: this.resourceMax,
      meter: 0,
      ko: false,
      threats,
      parts: 0,
      lensRadius: 0,
      lensStrength: 0,
      freezeTicks: 0,
      body: this.body,
    };
  }

  /* ================================================================================================
   *  TICK
   * ============================================================================================== */

  tick(ctx: FighterTickCtx): void {
    this.tickNo = ctx.tick;
    this.events = ctx.events;
    this.foe = ctx.foe;
    this.ctx = ctx;
    this.input = ctx.input;
    this.live = ctx.live;
    this.freezeTicks = 0;
    if (this.statusTicks > 0 && --this.statusTicks === 0) this.statusMul = 1;
    const t = this.body.transform;
    this.prevTx = t.x;
    this.prevTy = t.y;

    this.buf.note(ctx.input.pressed, ctx.tick);
    this.refreshStats();

    switch (this.state) {
      case 'ko':
      case 'victory':
        this.stateTicks++;
        break;
      case 'hitstun':
        this.stepHitstun();
        break;
      case 'guardbreak':
        this.stepGuardbreak();
        break;
      case 'guard':
        this.stepGuard();
        break;
      case 'startup':
      case 'charge':
      case 'active':
      case 'recovery':
      case 'surge':
        this.stepMove();
        break;
      default:
        this.stepFree();
    }
    this.detectSteer();

    // guard shell recovers while it is down
    if (!this.guardUp && this.guardHealth < 1)
      this.guardHealth = Math.min(1, this.guardHealth + T.guardRegenPerSec * TICK_DT);

    this.integrate();
    this.stepAngular();
    if (this.zdepth) this.stepDepth();
    this.applyTransform();
    if (this.acceptAt === this.tickNo) this.ensureAcceptPixel();
    this.emitMoveFx();
    if (this.moveActiveNow) this.resolveMoveHits();
    this.threatCount = 0;
    this.behaviour.resolveVolumes(ctx);
    this.behaviour.update(ctx);
    this.updateThreats();
    this.syncView();
    this.observeFeel();
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  feel: commands, the accept-tick pixel guarantee, settle
   * ---------------------------------------------------------------------------------------------- */

  /** A command was taken this tick: report it and arm the pixel guarantee (`dir` = facing-relative lean direction of the cue). */
  private acceptCommand(cmd: string, dir: number): void {
    this.acceptAt = this.tickNo;
    this.acceptDir = dir >= 0 ? 1 : -1;
    this.feelTrack.accept(cmd, this.tickNo, this.slot, this.events);
  }

  /**
   * Input is immediate (axiom 3): if nothing the command did has moved a drawn pixel by the end of its accept tick (a
   * root step, the pose kick), the lean takes one more whole pixel toward the cue. Hit tests use the same lean (D4).
   */
  private ensureAcceptPixel(): void {
    const t = this.body.transform;
    this.fillDrawn();
    if (this.feelTrack.changed(this.drawn) !== null) return;
    // a behaviour that answers with its own light / fx (the Planet's telegraphs) owns the accept-tick pixel
    const ch = this.behaviour.feelRespond(this.feelTrack.command);
    if (ch !== null) {
      this.feelTrack.respondVia(ch, this.tickNo, this.slot, this.events);
      return;
    }
    if (this.feel.shear > 0.25) {
      const step = this.acceptDir * (Math.abs(t.lean + this.acceptDir * this.facing) > T.leanMax ? -1 : 1);
      this.leanF += step / this.feel.shear;
      t.lean = this.composeLean();
    } else {
      // a body that never shears (a world) answers with its root: one whole pixel toward the cue
      this.px += this.acceptDir * this.facing;
      t.x = Math.round(this.px + this.offX);
    }
  }

  /** World row-shear lean from the facing-relative lean spring and the body's torsion angle, scaled by the titan's shear. */
  private composeLean(): number {
    const t = this.body.transform;
    const torsion = this.feel.angular.omega > 0 ? this.ang.angle * t.anchorY : 0;
    const w = (this.leanF * this.facing + torsion) * this.feel.shear;
    return Math.round(clamp(w, -T.leanMax, T.leanMax));
  }

  /** Angular state: scripted spin keys of the move in progress, then the spring/drag step. */
  private stepAngular(): void {
    const m = this.mv;
    const keys = m.def && !m.feint && m.phase !== 'charge' ? spinKeysOf(m) : null;
    if (keys) {
      const et = this.effTick();
      while (this.spinIdx < keys.length && keys[this.spinIdx]!.at <= et) {
        this.ang.impulse(keys[this.spinIdx++]!.w * this.facing, this.feel.angular);
      }
    }
    this.ang.step(this.feel.angular);
  }

  /** Depth offset prototype: a spring that always pulls back to the combat plane. */
  private stepDepth(): void {
    const dt = TICK_DT;
    this.vz += (-ZDEPTH.k * this.z - ZDEPTH.c * this.vz) * dt;
    this.z += this.vz * dt;
    if (this.z > ZDEPTH.max) {
      this.z = ZDEPTH.max;
      if (this.vz > 0) this.vz = 0;
    } else if (this.z < -ZDEPTH.max) {
      this.z = -ZDEPTH.max;
      if (this.vz < 0) this.vz = 0;
    }
    if (Math.abs(this.z) < 0.01 && Math.abs(this.vz) < 0.05) {
      this.z = 0;
      this.vz = 0;
    }
  }

  private fillDrawn(): void {
    const t = this.body.transform;
    this.drawn.rx = Math.round(this.px);
    this.drawn.ry = Math.round(this.py);
    this.drawn.lean = t.lean;
  }

  private observeFeel(): void {
    this.fillDrawn();
    const m = this.mv;
    // a torsion body is settled when its twist no longer shows (under the lean threshold at the top row); a free spinner's
    // angle is its surface phase, so only its spin counts
    const twistPx =
      this.feel.angular.omega > 0
        ? Math.abs(this.ang.angle) * this.body.transform.anchorY * this.feel.shear
        : 0;
    let quiet =
      Math.abs(this.leanF - this.leanTarget) < T.settleLean &&
      Math.abs(this.leanV) < T.settleLeanV &&
      Math.abs(this.ang.spin) < T.settleSpin &&
      twistPx < T.settleLean &&
      m.def === null &&
      this.state !== 'hitstun' &&
      this.state !== 'guardbreak';
    // classic: a stick command has also settled only once the body cruises at the asked speed. Orbit footwork never cruises
    // (gravity, the assist and the tether keep bending the path), so there the pose alone says the body has settled.
    if (quiet && this.feelTrack.command === 'steer' && this.footwork !== 'orbit') {
      const top = topSpeed(this.def, this.stats);
      const sx = this.input.moveX;
      const sy = this.input.moveY;
      // the speed the stick asks for (vertical speed is slower in the classic side view)
      const want = Math.hypot(sx, sy) > T.stickDeadzone ? Math.hypot(sx, sy * T.vertSpeedMul) * top : 0;
      quiet = Math.abs(Math.hypot(this.vx, this.vy) - want) < T.settleSpeedFrac * top;
    }
    this.feelTrack.observe(this.tickNo, this.drawn, quiet, this.slot, this.events);
  }

  /** The stick as a command: a fresh push, or a sharp change of direction, while the fighter is free to move. */
  private detectSteer(): void {
    const free = this.state === 'idle' || this.state === 'move' || this.state === 'intro';
    const sx = this.input.moveX;
    const sy = this.input.moveY;
    const mag = Math.hypot(sx, sy);
    if (!free || mag <= T.stickDeadzone) {
      if (++this.steerIdle >= T.steerRearmTicks) this.steerOn = false;
      return;
    }
    this.steerIdle = 0;
    const ux = sx / mag;
    const uy = sy / mag;
    if (this.steerOn && ux * this.steerDX + uy * this.steerDY >= T.steerTurnCos) return;
    this.steerOn = true;
    this.steerDX = ux;
    this.steerDY = uy;
    // the first step: the root moves a whole pixel at once, the top lags behind it (counter-rotation)
    const nx = Math.abs(ux) >= 0.38 ? Math.sign(ux) : 0;
    const ny = Math.abs(uy) >= 0.38 ? Math.sign(uy) : 0;
    this.px += nx * T.steerNudgePx;
    this.py += ny * T.steerNudgePx;
    const fwd = ux * this.facing;
    if (Math.abs(fwd) > 0.2) {
      this.leanF -= Math.sign(fwd) * T.steerCounterLean;
      // the mass resists being set in motion: the whole body rocks back against the push, then follows it
      this.ang.impulse(-Math.sign(ux) * T.commandTorsion * 0.8, this.feel.angular);
    } else {
      // a vertical push: rising pitches the top back, sinking pitches it forward, then the body settles
      this.ang.impulse(Math.sign(uy) * this.facing * T.commandTorsion * 0.8, this.feel.angular);
    }
    this.acceptCommand('steer', -(Math.sign(fwd) || 1));
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  stats / KO
   * ---------------------------------------------------------------------------------------------- */

  refreshStats(): void {
    const bs = this.world.stats(this.body.id);
    this.view.bodyStats = bs;
    computeStats(this.def, bs.massFrac, this.stats);
    this.behaviour?.adjustStats(this.stats, bs.massFrac);
    const coreMargin = (bs.coreIntegrity - KO_CORE_INTEGRITY) / (1 - KO_CORE_INTEGRITY);
    const massMargin = (bs.massFrac - KO_MASS_FRAC) / (1 - KO_MASS_FRAC);
    this.view.integrityPct = clamp(Math.min(coreMargin, massMargin) * 100, 0, 100);
    if (this.live && !this.ko && (bs.coreIntegrity < KO_CORE_INTEGRITY || bs.massFrac < KO_MASS_FRAC))
      this.enterKo();
  }

  private enterKo(): void {
    if (this.ko) return;
    this.ko = true;
    if (this.mv.def) this.endMove(true);
    this.state = 'ko';
    this.stateTicks = 0;
    this.guardUp = false;
    this.hitstunTicks = 0;
    this.intangible = false;
    // final tumble away from the blow: the finishing blow launches far and slow (it plays under the 0.3x time scale)
    this.vx = this.vx * T.koKnockMul + this.lastHitDirX * 150 * this.feel.knockMul;
    this.vy = this.vy * T.koKnockMul + this.lastHitDirY * 90 - 30;
    this.tumble = true;
    this.view.ko = true;
    this.view.state = 'ko';
    this.events.push({ t: 'ko', slot: this.slot, x: this.px, y: this.py });
    this.behaviour.onKo();
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  free states: intro / idle / move
   * ---------------------------------------------------------------------------------------------- */

  private stepFree(): void {
    this.stateTicks++;
    if (!this.live) {
      if (this.state !== 'intro') this.state = 'idle';
      this.updateFreeLabel();
      return;
    }
    if (this.state === 'intro') this.state = 'idle';
    this.beginFromBuffer();
    if (this.state === 'idle' || this.state === 'move') this.updateFreeLabel();
  }

  private updateFreeLabel(): void {
    if (this.state === 'intro') return;
    const sp = Math.hypot(this.vx, this.vy);
    this.state =
      sp > 24 || Math.hypot(this.input.moveX, this.input.moveY) > T.stickDeadzone ? 'move' : 'idle';
  }

  /** Start a buffered attack/surge or raise the guard. Called whenever the fighter is free to act. */
  private beginFromBuffer(): void {
    const bit = this.buf.latest(ATTACK_BITS, this.tickNo);
    if (bit !== 0) {
      const slot = BIT_SLOT[bit]!;
      if (this.tryStart(slot, bit)) return;
    }
    if (this.input.held & Btn.GUARD && this.tickNo >= this.guardLockUntil && this.guardHealth > 0.05)
      this.beginGuard();
  }

  /** Try to begin the primary move of `slot`. Returns whether a move started. */
  tryStart(slot: MoveSlot, bit: number): boolean {
    const def = this.slotMoves[slot];
    if (!def) {
      this.buf.take(bit, this.tickNo);
      return false;
    }
    if (slot === 'ultimate' && this.meter < def.meterCost - 1e-6) {
      this.buf.take(bit, this.tickNo);
      return false;
    }
    if (def.resourceCost > 0 && this.resource < def.resourceCost - 1e-6) {
      this.buf.take(bit, this.tickNo);
      return false;
    }
    if (slot === 'surge' && this.tickNo < this.surgeReadyAt) return false;
    this.buf.take(bit, this.tickNo);
    this.startMove(def, bit);
    return true;
  }

  /** Begin `def` this tick: the anticipation pose is visible on this same tick and the `move` event fires now. */
  startMove(def: MoveDef, button: number, aimOverride?: AimDir): void {
    if (this.mv.def) this.endMove(true);
    const m = this.mv;
    m.reset();
    const aim = aimOverride ?? aimFromStick(this.input.moveY);
    const variant = def.variants[aim];
    const fr = resolveFrame(def, variant);
    const tempo = Math.max(0.5, this.stats.tempoMul);
    m.def = def;
    m.variant = variant;
    m.aim = aim;
    m.button = button;
    m.startup = Math.max(1, Math.round(fr.startup / tempo));
    m.active = fr.active;
    m.recovery = Math.max(1, Math.round(fr.recovery / tempo));
    m.chargeMax = fr.chargeMax;
    m.cancelWindow = fr.cancelWindow;
    m.hitstop = fr.hitstop;
    m.tick = 1;
    m.phase = 'startup';
    m.phaseTick = 1;
    if (variant.hitboxes.length > MAX_HITBOXES)
      throw new Error(`${def.id}: more than ${MAX_HITBOXES} hitboxes`);

    if (def.slot === 'surge') {
      let sx = this.input.moveX;
      let sy = this.input.moveY;
      const l = Math.hypot(sx, sy);
      if (l < 0.35) {
        sx = this.facing;
        sy = 0;
      } else {
        sx /= l;
        sy /= l;
      }
      m.dirX = sx;
      m.dirY = sy;
      this.surgeReadyAt = this.tickNo + T.surgeCooldown + m.startup + m.active + m.recovery;
      if (this.zdepth) {
        // depth prototype: a Surge dives off the plane — toward the viewer with the stick down, away with it up, and
        // behind the foe when it dashes straight through it — then the spring brings it back
        const fv = this.foe.view;
        const through = (fv.x - this.px) * sx + (fv.y - this.py) * sy > 0 && Math.abs(fv.x - this.px) < 260;
        const dir = this.input.moveY > 0.35 ? 1 : this.input.moveY < -0.35 ? -1 : through ? -1 : 0;
        this.vz += dir * ZDEPTH.surgeSpeed;
      }
    }
    this.setAimAxis();
    if (def.slot === 'ultimate') {
      this.meter = Math.max(0, this.meter - def.meterCost);
      this.events.push({
        t: 'ultimate',
        slot: this.slot,
        titan: this.def.id,
        phase: 'start',
        x: this.px,
        y: this.py,
      });
    }
    if (def.resourceCost > 0) {
      this.resource -= def.resourceCost;
      this.events.push({ t: 'resource', slot: this.slot, kind: 'spend', amount: def.resourceCost });
    }
    this.state = def.slot === 'surge' ? 'surge' : 'startup';
    this.stateTicks = 0;
    this.guardUp = false;
    this.moveActiveNow = false;
    this.events.push({
      t: 'move',
      slot: this.slot,
      titan: this.def.id,
      moveId: def.id,
      moveSlot: def.slot,
      aim,
      x: this.px,
      y: this.py,
    });
    if (def.slot === 'surge')
      this.events.push({
        t: 'surge',
        slot: this.slot,
        titan: this.def.id,
        x: this.px,
        y: this.py,
        dirX: m.dirX,
        dirY: m.dirY,
      });
    fillDisplacement(
      m.disp,
      variant.movement,
      def.slot === 'surge' ? 0 : this.vx * this.aimUx + this.vy * this.aimUy,
      TICK_DT,
      T.glideHalfLife,
    );
    this.spinIdx = 0;
    // anticipation on the press tick: the body snaps toward its load pose at once (a whole pixel at least)
    const kick = anticipationKick(m);
    this.leanF += kick;
    this.leanV += kick * 8;
    this.behaviour.onMoveStart(m);
    this.fireKeys();
    this.updateIntangible();
    this.acceptCommand(def.slot, kick !== 0 ? kick : -1);
  }

  /**
   * The attack axis of a move starting now. Classic: horizontal, on the facing side (templates as authored). Orbit: straight
   * at the foe (the facing follows the side the foe is on), so hitboxes, lunges and telegraphs all point where the foe is.
   */
  private setAimAxis(): void {
    if (this.footwork !== 'orbit') {
      this.aimUx = this.facing;
      this.aimUy = 0;
      this.rot.c = 1;
      this.rot.s = 0;
      return;
    }
    const fv = this.foe.view;
    let ux = fv.x - this.px;
    let uy = fv.y - this.py;
    const l = Math.hypot(ux, uy);
    if (l < 1e-6) {
      ux = this.facing;
      uy = 0;
    } else {
      ux /= l;
      uy /= l;
    }
    if (Math.abs(ux) > 0.05 && (ux > 0 ? 1 : -1) !== this.facing) {
      // turning to strike: keep the world lean continuous across the mirror
      this.facing = ux > 0 ? 1 : -1;
      this.leanF = -this.leanF;
      this.leanV = -this.leanV;
    }
    this.aimUx = ux;
    this.aimUy = uy;
    aimRotation(this.facing, ux, uy, this.rot);
  }

  /** Template placement for the move in progress (anchor, facing, reach scale and the aim rotation). */
  private place(scale: number): TemplatePlacement {
    const t = this.body.transform;
    const p = this.placement;
    p.x = t.x;
    p.y = t.y;
    p.facing = this.facing;
    p.scale = scale;
    p.rotC = this.rot.c;
    p.rotS = this.rot.s;
    return p;
  }

  /** The move ended (naturally or cancelled/interrupted). */
  endMove(interrupted: boolean): void {
    const m = this.mv;
    if (!m.def) return;
    m.interrupted = interrupted;
    if (m.def.slot === 'ultimate')
      this.events.push({
        t: 'ultimate',
        slot: this.slot,
        titan: this.def.id,
        phase: 'end',
        x: this.px,
        y: this.py,
      });
    if (m.phase === 'charge' && interrupted)
      this.events.push({
        t: 'charge',
        slot: this.slot,
        titan: this.def.id,
        moveId: m.def.id,
        frac: 0,
        phase: 'release',
      });
    this.behaviour.onMoveEnd(m, interrupted);
    m.def = null;
    m.variant = null;
    m.damp = 1;
    this.moveActiveNow = false;
    this.intangible = false;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  move state machine
   * ---------------------------------------------------------------------------------------------- */

  private stepMove(): void {
    const m = this.mv;
    const def = m.def;
    if (!def) {
      this.state = 'idle';
      return;
    }
    this.stateTicks++;
    const isSurge = def.slot === 'surge';

    // --- cancels: FEINT drops any windup (startup or charge); Guard/Surge only in the first 40% of startup (or while charging) ---
    const winding = !isSurge && !m.feint && (m.phase === 'startup' || m.phase === 'charge');
    const early =
      (m.phase === 'startup' && m.phaseTick <= Math.floor(m.cancelWindow * m.startup)) ||
      m.phase === 'charge';
    if (winding && this.live) {
      if (this.input.pressed & Btn.FEINT) {
        this.feint();
        return this.finishStepMove();
      }
      if (early) {
        if (this.input.held & Btn.GUARD && this.guardHealth > 0.05 && this.tickNo >= this.guardLockUntil) {
          this.endMove(true);
          this.beginGuard();
          return;
        }
        const surge = this.slotMoves.surge;
        if (surge && this.buf.has(Btn.SURGE, this.tickNo) && this.tickNo >= this.surgeReadyAt) {
          this.buf.take(Btn.SURGE, this.tickNo);
          this.startMove(surge, Btn.SURGE);
          return;
        }
      }
    }
    // --- follow-up (Sidestep tail → lunging strike) ---
    const fu = def.extra?.['followUp'] as
      { button: string; from: number; to: number; move: string } | undefined;
    if (fu && this.live && m.tick - 1 >= fu.from && m.tick - 1 < fu.to) {
      const bit = fu.button === 'crush' ? Btn.CRUSH : Btn.STRIKE;
      const target = this.movesById.get(fu.move);
      if (target && this.buf.has(bit, this.tickNo, 4)) {
        this.buf.take(bit, this.tickNo);
        this.startMove(target, bit);
        return;
      }
    }

    // --- advance ---
    m.tick++;
    m.phaseTick++;
    this.advancePhases();
    this.finishStepMove();
  }

  private finishStepMove(): void {
    const m = this.mv;
    if (!m.def) {
      // move finished: act on buffered input in the very same tick (no dead frame)
      this.state = 'idle';
      this.stateTicks = 0;
      this.stepFree();
      return;
    }
    this.fireKeys();
    this.updateIntangible();
  }

  private advancePhases(): void {
    const m = this.mv;
    for (let guard = 0; guard < 4 && m.def; guard++) {
      switch (m.phase) {
        case 'startup':
          if (m.phaseTick <= m.startup) return;
          if (m.chargeMax > 0 && !m.feint && this.input.held & m.button) {
            this.enterPhase('charge');
            m.chargeTicks = 1;
            this.events.push({
              t: 'charge',
              slot: this.slot,
              titan: this.def.id,
              moveId: m.def.id,
              frac: 0,
              phase: 'start',
            });
            return;
          }
          this.enterActive();
          break;
        case 'charge': {
          const held = (this.input.held & m.button) !== 0;
          if (held && m.chargeTicks < m.chargeMax) {
            m.chargeTicks++;
            if ((m.chargeTicks & 7) === 0)
              this.events.push({
                t: 'charge',
                slot: this.slot,
                titan: this.def.id,
                moveId: m.def.id,
                frac: m.chargeTicks / m.chargeMax,
                phase: 'hold',
              });
            return;
          }
          const frac = m.chargeTicks / m.chargeMax;
          this.events.push({
            t: 'charge',
            slot: this.slot,
            titan: this.def.id,
            moveId: m.def.id,
            frac,
            phase: 'release',
          });
          this.enterActive();
          break;
        }
        case 'active':
          if (m.phaseTick <= m.active) return;
          this.moveActiveNow = false;
          this.enterPhase('recovery');
          break;
        case 'recovery':
          if (m.phaseTick <= m.recovery) return;
          this.endMove(false);
          return;
      }
    }
  }

  private enterPhase(p: 'startup' | 'charge' | 'active' | 'recovery'): void {
    const m = this.mv;
    m.phase = p;
    m.phaseTick = 1;
    if (this.mv.def?.slot !== 'surge') this.state = p;
  }

  private enterActive(): void {
    const m = this.mv;
    const def = m.def!;
    const frac = m.chargeMax > 0 ? clamp01(m.chargeTicks / m.chargeMax) : 0;
    const cp = (def.extra?.['chargePower'] as number | undefined) ?? 1;
    const cr = (def.extra?.['chargeReach'] as [number, number] | undefined) ?? [1, 1];
    m.power = 1 + frac * cp;
    m.reach = cr[0] + (cr[1] - cr[0]) * frac;
    if (m.active <= 0) {
      this.enterPhase('recovery');
      return;
    }
    this.enterPhase('active');
    this.moveActiveNow = !m.feint && m.variant!.hitboxes.length > 0;
    this.events.push({
      t: 'release',
      slot: this.slot,
      titan: this.def.id,
      moveId: def.id,
      moveSlot: def.slot,
      x: this.px,
      y: this.py,
      power: m.power,
    });
    m.released = true;
    if (def.slot === 'crush' || def.slot === 'ultimate') {
      // a low-frequency thud for a big body's heavy release, hit or whiff
      const thud =
        T.thudGain *
        Math.pow(Math.max(0.5, this.stats.mass) / 5, T.thudMassExp) *
        this.feel.thud *
        (def.slot === 'ultimate' ? 1.4 : 1);
      if (thud > 0.8) this.events.push({ t: 'shake', dirX: 0, dirY: 1, amp: thud });
    }
    this.behaviour.onRelease(m);
  }

  /** Feint: drop the windup, stumble briefly, no hitboxes. */
  private feint(): void {
    const m = this.mv;
    if (m.phase === 'charge')
      this.events.push({
        t: 'charge',
        slot: this.slot,
        titan: this.def!.id,
        moveId: m.def!.id,
        frac: 0,
        phase: 'release',
      });
    m.feint = true;
    m.active = 0;
    m.recovery = T.feintRecovery;
    m.damp = 0.05;
    this.enterPhase('recovery');
    this.moveActiveNow = false;
    // the windup is thrown away: the body jolts out of its load pose at once
    const dir = this.leanF < 0 ? 1 : -1;
    this.leanF += dir * T.feintJolt;
    this.leanV += dir * T.feintJolt * 10;
    this.ang.impulse(dir * T.commandTorsion * this.facing, this.feel.angular);
    this.acceptCommand('feint', dir);
  }

  /**
   * Choreography clock for movement keys and intangibility: 0-based move ticks with the time spent charging removed, so a
   * charged move plays its release choreography at the same relative timing however long it was held.
   */
  effTick(): number {
    const m = this.mv;
    const skipped = m.chargeTicks > 0 ? (m.phase === 'charge' ? m.chargeTicks - 1 : m.chargeTicks) : 0;
    return m.tick - 1 - skipped;
  }

  private fireKeys(): void {
    const m = this.mv;
    if (!m.def || !m.variant || m.phase === 'charge') return;
    const keys = m.variant.movement;
    const et = this.effTick();
    // a rooted or slowed fighter's dashes and lunges are shortened too
    const push = 0.35 + 0.65 * this.statusMul;
    while (m.keyIdx < keys.length && keys[m.keyIdx]!.at <= et) {
      const k = keys[m.keyIdx++]!;
      if (m.def.slot === 'surge') {
        const sp = Math.hypot(k.ix, k.iy) * push;
        this.vx = m.dirX * sp;
        this.vy = m.dirY * sp;
      } else {
        // ix along the attack axis, iy across it (screen-down for a horizontal axis): 2-D root motion
        const ux = this.aimUx;
        const uy = this.aimUy;
        const sx = -uy * this.facing;
        const sy = ux * this.facing;
        this.vx += (k.ix * ux + k.iy * sx) * push;
        this.vy += (k.ix * uy + k.iy * sy) * push;
      }
      if (k.damp !== undefined) m.damp = k.damp;
    }
  }

  private updateIntangible(): void {
    const m = this.mv;
    const w = m.def?.intangible;
    this.intangible = !!w && !m.feint && this.effTick() >= w[0] && this.effTick() < w[1];
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  guard
   * ---------------------------------------------------------------------------------------------- */

  private beginGuard(): void {
    this.state = 'guard';
    this.stateTicks = 0;
    this.guardTicks = 0;
    this.guardUp = true;
    // the shell goes up with a brace: the body sets itself back on the same tick and the whole mass rocks with it
    this.leanF += T.guardBrace;
    this.leanV += T.guardBrace * 10;
    this.ang.impulse(-T.commandTorsion * this.facing, this.feel.angular);
    this.acceptCommand('guard', -1);
  }

  private stepGuard(): void {
    this.stateTicks++;
    this.guardTicks++;
    if (!this.live) {
      this.dropGuard();
      return;
    }
    // any attack input leaves the guard at once
    const bit = this.buf.latest(ATTACK_BITS, this.tickNo);
    if (bit !== 0) {
      this.guardUp = false;
      this.state = 'idle';
      if (this.tryStart(BIT_SLOT[bit]!, bit)) return;
      this.guardUp = true;
      this.state = 'guard';
    }
    if (!(this.input.held & Btn.GUARD)) this.dropGuard();
  }

  private dropGuard(): void {
    this.guardUp = false;
    this.state = 'idle';
    this.guardLockUntil = this.tickNo + T.guardDropTicks;
    this.stateTicks = 0;
  }

  private stepGuardbreak(): void {
    this.stateTicks++;
    this.guardBreakTicks--;
    if (this.guardBreakTicks <= 0) {
      this.state = 'idle';
      this.guardHealth = T.guardBreakRecover;
      this.stunEndTick = this.tickNo;
      this.stepFree();
    }
  }

  /** Current shell strength 0..~1.2: health × raise ramp × behaviour multiplier. */
  guardStrength(): number {
    const ramp = Math.min(1, 0.5 + (0.5 * (this.guardTicks + 1)) / T.guardRaiseTicks);
    return (0.35 + 0.65 * this.guardHealth) * ramp * this.behaviour.guardMultiplier();
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  hit-stun
   * ---------------------------------------------------------------------------------------------- */

  private stepHitstun(): void {
    this.stateTicks++;
    this.stunElapsed++;
    this.hitstunTicks--;
    // the escape route: SURGE breaks stun after a brief window
    if (
      this.live &&
      this.stunElapsed >= T.stunEscapeTicks &&
      this.tickNo >= this.escapeReadyAt &&
      this.buf.has(Btn.SURGE, this.tickNo)
    ) {
      const surge = this.slotMoves.surge;
      if (surge) {
        this.escapeReadyAt = this.tickNo + T.escapeCooldown;
        this.hitstunTicks = 0;
        this.stunEndTick = this.tickNo;
        this.state = 'idle';
        this.buf.take(Btn.SURGE, this.tickNo);
        this.startMove(surge, Btn.SURGE);
        return;
      }
    }
    if (this.hitstunTicks <= 0) {
      this.hitstunTicks = 0;
      this.state = 'idle';
      this.stunEndTick = this.tickNo;
      this.stepFree();
    }
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  movement
   * ---------------------------------------------------------------------------------------------- */

  private controlMul(): number {
    // a move may override how much steering it leaves the pilot (the Swarm hands the stick to the fragments)
    const o = this.mv.def?.extra?.['ctl'] as
      Partial<Record<'startup' | 'charge' | 'active' | 'recovery', number>> | undefined;
    if (o && this.mv.def && this.state !== 'surge') {
      const v = o[this.mv.phase];
      if (v !== undefined) return v;
    }
    switch (this.state) {
      case 'intro':
      case 'idle':
      case 'move':
        return 1;
      case 'startup':
        return T.ctlStartup;
      case 'charge':
        return T.ctlCharge;
      case 'active':
        return T.ctlActive;
      case 'recovery':
        return T.ctlRecovery;
      case 'guard':
        return T.ctlGuard;
      default:
        return 0;
    }
  }

  private integrate(): void {
    const dt = TICK_DT;
    const m = this.mv;
    let top = topSpeed(this.def, this.stats);
    const sm = this.statusMul;
    if (sm < 1) {
      // rooted / slowed: a lower top speed and a strong drag on whatever velocity is left
      top *= sm;
      const k = Math.pow(sm, dt * 3);
      this.vx *= k;
      this.vy *= k;
    }
    let ctl = this.controlMul();
    if (this.state === 'victory') ctl = 0.2;
    // impulse-driven moves (dashes, lunges) glide on their own damping; steering is nearly off
    const driven = m.def !== null && m.damp < 1;
    if (driven) {
      const k = Math.pow(m.damp, dt);
      this.vx *= k;
      this.vy *= k;
      ctl *= 0.25;
    }
    if (this.footwork === 'orbit') this.thrustOrbit(top, ctl, driven);
    else this.steerClassic(top, ctl, driven);

    // soft arena walls
    const a = this.arena;
    const margin = 36;
    const soft = Math.max(1, a.softWall);
    const dl = this.px - (a.minX + margin);
    const dr = a.maxX - margin - this.px;
    if (dl < soft) this.vx += (1 - Math.max(0, dl) / soft) ** 2 * 900 * dt;
    if (dr < soft) this.vx -= (1 - Math.max(0, dr) / soft) ** 2 * 900 * dt;
    const du = this.py - (a.minY + 90);
    const dd = a.maxY - 60 - this.py;
    if (du < 80) this.vy += (1 - Math.max(0, du) / 80) ** 2 * 700 * dt;
    if (dd < 80) this.vy -= (1 - Math.max(0, dd) / 80) ** 2 * 700 * dt;

    this.px += this.vx * dt;
    this.py += this.vy * dt;
    const minX = a.minX + margin;
    const maxX = a.maxX - margin;
    if (this.px < minX) {
      this.px = minX;
      if (this.vx < 0) this.vx = 0;
    } else if (this.px > maxX) {
      this.px = maxX;
      if (this.vx > 0) this.vx = 0;
    }
    const minY = a.minY + 90;
    const maxY = a.maxY - 60;
    if (this.py < minY) {
      this.py = minY;
      if (this.vy < 0) this.vy = 0;
    } else if (this.py > maxY) {
      this.py = maxY;
      if (this.vy > 0) this.vy = 0;
    }

    this.faceFoe();
    if (this.footwork === 'orbit') this.tetherOrbit(top);
    else this.tetherClassic();
  }

  /**
   * Classic side-view steering: an underdamped stick → velocity filter (heavier bodies lag, overshoot a little, settle),
   * whose acceleration is a bounded force, then the glide when the stick is released; a soft spring toward the rest altitude.
   */
  private steerClassic(top: number, ctl: number, driven: boolean): void {
    const dt = TICK_DT;
    const sx = ctl > 0 ? this.input.moveX : 0;
    const sy = ctl > 0 ? this.input.moveY : 0;
    const mag = Math.hypot(sx, sy);
    const steering = ctl > 0 && mag > T.stickDeadzone;
    const half = Math.pow(0.5, dt / (T.glideHalfLife * this.feel.glideMul));
    if (steering) {
      const w = (T.steerOmega * Math.sqrt(Math.max(0.05, ctl))) / Math.sqrt(this.feel.accelMul);
      const z = this.feel.zeta;
      const amax = T.steerAccelMax / this.feel.accelMul;
      this.vx = this.steerAxis2(this.vx, sx * top * ctl, w, z, half, true, amax);
      this.vy = this.steerAxis2(this.vy, sy * top * T.vertSpeedMul * ctl, w, z, half, false, amax);
    } else {
      this.accX = 0;
      this.accY = 0;
      if (!driven) {
        const k = this.tumble
          ? Math.exp(-dt / T.koGlideTau)
          : this.stunned()
            ? Math.exp(-dt / this.brakeTau)
            : half;
        this.vx *= k;
        this.vy *= k;
      }
    }
    // soft altitude spring toward the rest altitude (a pull, never a floor)
    if (this.state !== 'ko' && (Math.abs(this.input.moveY) < 0.3 || ctl === 0)) {
      this.vy += (-T.altitudeK * (this.py - this.arena.restY) - T.altitudeC * this.vy) * dt;
    } else if (this.state === 'ko') {
      this.vy += 60 * dt;
    }
  }

  /**
   * Planar orbital footwork (`footwork: 'orbit'`, see orbit.ts): the stick is thrust, split into tangential (around the foe)
   * and radial (toward / away) parts in the scaled plane; mutual gravity curves the path; momentum is kept with drag. There
   * is no floor and no rest altitude: the plane is open.
   */
  private thrustOrbit(top: number, ctl: number, driven: boolean): void {
    const dt = TICK_DT;
    const O = ORBIT;
    const EY = O.ey;
    const fv = this.foe.view;
    const f = orbitFrame(this.px, this.py, this.vx, this.vy, fv.x, fv.y, fv.vx, fv.vy, this.oframe);
    // work in S = (x, y·EY): own velocity there
    let Vx = this.vx;
    let Vy = this.vy * EY;
    const sx = ctl > 0 ? this.input.moveX : 0;
    const sy = ctl > 0 ? this.input.moveY : 0;
    const mag = Math.min(1, Math.hypot(sx, sy));
    const thrusting = ctl > 0 && mag > T.stickDeadzone;
    if (thrusting) {
      const a = (O.thrustPerTop * top * ctl) / this.feel.accelMul;
      const at = sx * f.tx + sy * f.ty;
      const ar = sx * f.nx + sy * f.ny;
      let ax = (O.tangential * at * f.tx + O.radial * ar * f.nx) * a;
      let ay = (O.tangential * at * f.ty + O.radial * ar * f.ny) * a;
      // keep the thrust magnitude honest whatever the split (a diagonal push is not stronger)
      const al = Math.hypot(ax, ay);
      const amax = a * mag;
      if (al > amax && al > 1e-9) {
        ax *= amax / al;
        ay *= amax / al;
      }
      Vx += ax * dt;
      Vy += ay * dt;
      // orbit assist: pushing around the foe bends the path around it (a share of v_t²/r toward the foe)
      if (f.r > 1 && Math.abs(at) > 0.2) {
        const vt = Vx * f.tx + Vy * f.ty;
        const ac = ((O.assist * vt * vt) / f.r) * Math.min(1, Math.abs(at));
        Vx += f.nx * ac * dt;
        Vy += f.ny * ac * dt;
      }
      // the component along the thrust relaxes back to top speed: a cap on what the engine can do, not on momentum
      if (al > 1e-9) {
        const ux = ax / al;
        const uy = ay / al;
        const vPar = Vx * ux + Vy * uy;
        const cap = top * ctl * mag;
        if (vPar > cap) {
          const cut = (vPar - cap) * (1 - Math.exp(-dt / O.capTau));
          Vx -= ux * cut;
          Vy -= uy * cut;
        }
      }
      const dk = Math.exp(-dt / O.dragTau);
      Vx *= dk;
      Vy *= dk;
    } else if (!driven) {
      const k = this.tumble
        ? Math.exp(-dt / T.koGlideTau)
        : this.stunned()
          ? Math.exp(-dt / this.brakeTau)
          : Math.pow(0.5, dt / (T.glideHalfLife * this.feel.glideMul));
      Vx *= k;
      Vy *= k;
    }
    // mutual gravity: heavier, more gravitating foes bend the path more
    if (this.state !== 'ko' && f.r > 1) {
      const q = 200 / Math.max(f.r, O.gravityRMin);
      const g = Math.min(
        O.gravityMax,
        O.gravityG * (fv.stats.mass / 5) * (this.foe.def.attributes.gravity / 5) * q * q,
      );
      Vx += f.nx * g * dt;
      Vy += f.ny * g * dt;
    }
    this.vx = Vx;
    this.vy = Vy / EY;
    if (this.state === 'ko') this.vy += 60 * dt;
  }

  private stunned(): boolean {
    return this.state === 'hitstun' || this.state === 'guardbreak';
  }

  /** One axis of underdamped steering: a spring toward the target speed while speeding up, the glide (half-life) when slowing. */
  private steerAxis2(
    v: number,
    target: number,
    w: number,
    z: number,
    half: number,
    isX: boolean,
    amax: number,
  ): number {
    const accelerating = Math.abs(target) > Math.abs(v) || Math.sign(target) !== Math.sign(v);
    if (!accelerating) {
      if (isX) this.accX = 0;
      else this.accY = 0;
      return target + (v - target) * half;
    }
    const dt = TICK_DT;
    let acc = isX ? this.accX : this.accY;
    acc += (w * w * (target - v) - 2 * z * w * acc) * dt;
    acc = clamp(acc, -amax, amax);
    const nv = v + acc * dt;
    if (isX) this.accX = acc;
    else this.accY = acc;
    return nv;
  }

  private faceFoe(): void {
    if (this.ko || this.victory) return;
    const locked =
      this.state === 'startup' ||
      this.state === 'charge' ||
      this.state === 'active' ||
      this.state === 'surge';
    if (locked) return;
    const dx = this.foe.view.x - this.px;
    let nf = this.facing;
    if (dx > T.turnHysteresis) nf = 1;
    else if (dx < -T.turnHysteresis) nf = -1;
    if (nf === this.facing) return;
    // turning round: the world lean carries over the mirror, then the top lags behind the new forward (counter-rotation)
    this.facing = nf;
    this.leanF = -this.leanF - T.turnCounterLean;
    this.leanV = -this.leanV;
  }

  /** Classic tether: never further apart than MAX_FIGHTER_DX/DY, with a graded bleed of outward speed before the cap. */
  private tetherClassic(): void {
    const fv = this.foe.view;
    const dx = this.px - fv.x;
    if (Math.abs(dx) > MAX_FIGHTER_DX) {
      this.px = fv.x + Math.sign(dx) * MAX_FIGHTER_DX;
      if (this.vx * dx > 0) this.vx = 0;
    } else if (Math.abs(dx) > TETHER_SOFT_DX && this.vx * dx > 0) {
      // graded pull-back: the outward speed bleeds off ever faster toward the hard cap (knockback still carries, it just tires)
      const s = (Math.abs(dx) - TETHER_SOFT_DX) / (MAX_FIGHTER_DX - TETHER_SOFT_DX);
      this.vx *= 1 - 0.3 * s * s;
    }
    const dy = this.py - fv.y;
    if (Math.abs(dy) > MAX_FIGHTER_DY) {
      this.py = fv.y + Math.sign(dy) * MAX_FIGHTER_DY;
      if (this.vy * dy > 0) this.vy = 0;
    } else if (Math.abs(dy) > TETHER_SOFT_DY && this.vy * dy > 0) {
      const s = (Math.abs(dy) - TETHER_SOFT_DY) / (MAX_FIGHTER_DY - TETHER_SOFT_DY);
      this.vy *= 1 - 0.3 * s * s;
    }
  }

  /**
   * Orbit tether: radial in the scaled plane (graded bleed of outward radial speed from `tetherSoft`, hard cap at
   * `tetherMax`), plus the view's vertical limit (|dy| ≤ MAX_FIGHTER_DY) so both bodies always fit on screen.
   */
  private tetherOrbit(top: number): void {
    const O = ORBIT;
    const EY = O.ey;
    const fv = this.foe.view;
    const dx = this.px - fv.x;
    const dyS = (this.py - fv.y) * EY;
    const r = Math.hypot(dx, dyS);
    if (r > O.tetherSoft && r > 1e-6) {
      const nx = dx / r;
      const ny = dyS / r;
      const vOut = this.vx * nx + this.vy * EY * ny;
      if (r > O.tetherMax) {
        this.px = fv.x + nx * O.tetherMax;
        this.py = fv.y + (ny * O.tetherMax) / EY;
        if (vOut > 0) {
          this.vx -= nx * vOut;
          this.vy -= (ny * vOut) / EY;
        }
      } else if (vOut > 0) {
        const s = (r - O.tetherSoft) / (O.tetherMax - O.tetherSoft);
        const cut = vOut * 0.3 * s * s;
        this.vx -= nx * cut;
        this.vy -= (ny * cut) / EY;
      }
    }
    const dy = this.py - fv.y;
    if (Math.abs(dy) > MAX_FIGHTER_DY) {
      this.py = fv.y + Math.sign(dy) * MAX_FIGHTER_DY;
      if (this.vy * dy > 0) this.vy = 0;
    }
    // classification for the view (AI, camera, telemetry)
    const f = orbitFrame(this.px, this.py, this.vx, this.vy, fv.x, fv.y, fv.vx, fv.vy, this.oframe);
    const contactR = this.contactRadius() + this.radiusOf(fv);
    this.orbitState = classifyOrbit(f, top, contactR * 1.1, this.orbitMem);
  }

  /** Readable orbital state (orbit footwork only). */
  private orbitState: FighterView['orbit'] = 'neutral';

  /** Contact radius of a body from its live bounds (px): a disc that sits inside the silhouette's box. */
  private radiusOf(v: FighterView): number {
    return 0.25 * (v.boundsX1 - v.boundsX0 + (v.boundsY1 - v.boundsY0)) * 0.85;
  }

  private contactRadius(): number {
    const b = this.liveBounds();
    return 0.25 * (b.x1 - b.x0 + (b.y1 - b.y0)) * 0.85;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  contact: symmetric separation and momentum exchange (Match calls resolvePair on slot 0 only)
   * ---------------------------------------------------------------------------------------------- */

  resolvePair(foeF: Fighter): void {
    if (!(foeF instanceof FighterImpl)) return;
    const A = this as FighterImpl;
    const B = foeF;
    if (A.intangible || B.intangible || A.ko || B.ko) return;
    if ((A.zdepth || B.zdepth) && Math.abs(A.z - B.z) > ZDEPTH.collide) return;
    const mA = Math.max(0.5, A.stats.mass);
    const mB = Math.max(0.5, B.stats.mass);
    const shareA = mB / (mA + mB);
    const shareB = 1 - shareA;
    let nx: number;
    let ny: number;
    let corr = 0;
    const dx = B.px - A.px;
    const dy = B.py - A.py;
    const coreGap = A.body.map.coreRadius + B.body.map.coreRadius + 8;
    if (A.footwork === 'orbit' || B.footwork === 'orbit') {
      const d = Math.hypot(dx, dy);
      if (d > 1e-6) {
        nx = dx / d;
        ny = dy / d;
      } else {
        nx = A.facing;
        ny = 0;
      }
      const contact = Math.max(coreGap, A.contactRadius() + B.contactRadius() - T.overlapAllowance);
      if (d < contact) corr = contact - d;
    } else {
      // classic: separation is horizontal; the cores never pass, the silhouettes may overlap at the edges a little
      nx = dx === 0 ? A.facing : Math.sign(dx);
      ny = 0;
      if (Math.abs(dx) < coreGap && Math.abs(dy) < coreGap) corr = coreGap - Math.abs(dx);
      else {
        const pen = A.maxPenetration(B.view);
        if (pen > T.overlapAllowance) corr = pen - T.overlapAllowance;
      }
    }
    if (corr <= 0) return;
    A.px -= nx * corr * shareA;
    A.py -= ny * corr * shareA;
    B.px += nx * corr * shareB;
    B.py += ny * corr * shareB;
    // momentum: the closing part of the relative velocity is exchanged (nearly inelastic): a lunge shoves, a heavier body yields less
    const vrel = (B.vx - A.vx) * nx + (B.vy - A.vy) * ny;
    if (vrel < 0) {
      const j = (-(1 + T.restitution) * vrel) / (1 / mA + 1 / mB);
      A.vx -= (j / mA) * nx;
      A.vy -= (j / mA) * ny;
      B.vx += (j / mB) * nx;
      B.vy += (j / mB) * ny;
    }
    A.replace();
    B.replace();
  }

  /** Re-place the transform after a position change outside tick() (contact), keeping this tick's visual offset. */
  private replace(): void {
    const t = this.body.transform;
    t.x = Math.round(this.px + this.offX);
    t.y = Math.round(this.py + this.offY);
    this.syncView();
  }

  /** Deepest horizontal overlap (px) between the two bodies' live silhouettes over sampled rows. */
  private maxPenetration(fv: FighterView): number {
    const mine = this.liveBounds();
    const y0 = Math.max(mine.y0, fv.boundsY0);
    const y1 = Math.min(mine.y1, fv.boundsY1);
    if (y1 <= y0) return 0;
    const meLeft = this.px < fv.x;
    let pen = 0;
    for (let wy = Math.ceil(y0); wy < y1; wy += 4) {
      // my extent toward the foe, and the foe's extent toward me
      const a = this.rowEdge(this.body, wy, meLeft ? 1 : -1);
      if (a === null) continue;
      const b = this.rowEdge(fv.body, wy, meLeft ? -1 : 1);
      if (b === null) continue;
      const p = meLeft ? a - b : b - a;
      if (p > pen) pen = p;
    }
    return pen;
  }

  /** World x of the outermost live cell edge of `body` on world row `wy` toward `dir` (+1 right / −1 left), or null. */
  private rowEdge(body: MatterBody, wy: number, dir: 1 | -1): number | null {
    const t = body.transform;
    const map = body.map;
    const ly = Math.floor(wy - t.y + t.anchorY);
    if (ly < 0 || ly >= map.h) return null;
    const row = ly * map.w;
    const shift = Math.round((t.lean * (t.anchorY - ly)) / Math.max(1, t.anchorY));
    // world x grows with lx when facing = +1 and shrinks when facing = −1; find the extreme solid cell toward `dir`
    const highLx = (dir === 1) === (t.facing === 1);
    if (highLx) {
      for (let lx = map.w - 1; lx >= 0; lx--)
        if (map.material[row + lx] !== 0) return this.cellEdge(t, lx, shift, dir);
    } else {
      for (let lx = 0; lx < map.w; lx++)
        if (map.material[row + lx] !== 0) return this.cellEdge(t, lx, shift, dir);
    }
    return null;
  }

  /** World x of the +x (dir=1) or −x (dir=−1) side of local cell `lx`. */
  private cellEdge(t: MatterBody['transform'], lx: number, shift: number, dir: 1 | -1): number {
    if (t.facing === 1) {
      const lower = t.x + (lx - t.anchorX) + shift;
      return dir === 1 ? lower + 1 : lower;
    }
    const upper = t.x - (lx - t.anchorX) + shift;
    return dir === 1 ? upper : upper - 1;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  transform / lean
   * ---------------------------------------------------------------------------------------------- */

  private applyTransform(): void {
    const t = this.body.transform;
    const dt = TICK_DT;
    // lean spring toward (velocity-driven + pose) target — overshoots on direction changes and after every pose kick
    const top = topSpeed(this.def, this.stats);
    const vf = this.vx * this.facing;
    let target =
      clamp((vf / top) * T.leanPerSpeed, -T.leanPerSpeed, T.leanPerSpeed) +
      poseLeanTarget(this.mv) +
      this.behaviour.leanBias();
    // shoved bodies arch with the blow (world lean → facing-relative)
    if (this.state === 'ko') target = clamp(this.lastHitDirX, -1, 1) * 12 * this.facing;
    else if (this.state === 'hitstun') target = clamp(this.lastHitDirX, -1, 1) * 8 * this.facing;
    this.leanTarget = target;
    const w = T.leanOmega;
    const acc = w * w * (target - this.leanF) - 2 * T.leanZeta * w * this.leanV;
    this.leanV += acc * dt;
    this.leanF += this.leanV * dt;
    // idle breathing bob and a slower sway (deterministic in the tick counter; per-titan period and amplitude from `feel`)
    const calm =
      this.state === 'idle' || this.state === 'move' || this.state === 'intro' || this.state === 'guard';
    const F = this.feel;
    const ph = this.slot * 1.7;
    const bob =
      calm && F.bobAmp > 0 ? Math.sin(this.tickNo * ((TAU * TICK_DT) / F.bobPeriod) + ph) * F.bobAmp : 0;
    const sway =
      calm && F.swayAmp > 0
        ? Math.sin(this.tickNo * ((TAU * TICK_DT) / F.swayPeriod) + ph * 2.3) * F.swayAmp
        : 0;
    // hit vibration and follow-through are visual offsets only: the body's position (px, py) is untouched
    let ox = this.followX;
    let oy = this.followY;
    if (this.shudderAmp > 0.05) {
      const a = this.shudderAmp;
      const k = this.tickNo * 2.399;
      ox += Math.sin(k * 5.1 + ph) * a;
      oy += Math.cos(k * 3.7 + ph) * a * 0.7;
      this.shudderAmp *= T.shudderDecay;
    } else this.shudderAmp = 0;
    this.followX *= T.followDecay;
    this.followY *= T.followDecay;
    if (Math.abs(this.followX) < 0.05) this.followX = 0;
    if (Math.abs(this.followY) < 0.05) this.followY = 0;
    this.offX = sway + ox;
    this.offY = bob + oy;
    // whole pixels: what you see is what is hit (space.ts maps integer transforms 1:1 onto cells)
    t.x = Math.round(this.px + this.offX);
    t.y = Math.round(this.py + this.offY);
    t.facing = this.facing;
    t.lean = this.composeLean();
  }

  /**
   * World AABB of live matter (returns a reused object), from `world.liveBounds`. The world scans the whole cell map, so the result is
   * cached: it is refreshed when the map changed, the body flipped, or every 8 ticks, and otherwise shifted by the transform delta.
   */
  liveBounds(): Bounds {
    const t = this.body.transform;
    const c = this.bbCache;
    const o = this.bnd;
    if (this.body.map.version !== c.version || t.facing !== c.facing || this.tickNo - c.stamp > 8) {
      if (!this.world.liveBounds(this.body.id, o)) {
        o.x0 = t.x;
        o.x1 = t.x;
        o.y0 = t.y;
        o.y1 = t.y;
      }
      c.version = this.body.map.version;
      c.facing = t.facing;
      c.stamp = this.tickNo;
    } else {
      const dx = t.x - c.tx;
      const dl = Math.abs(t.lean) - Math.abs(c.lean);
      o.x0 += dx - dl;
      o.x1 += dx + dl;
      o.y0 += t.y - c.ty;
      o.y1 += t.y - c.ty;
    }
    c.tx = t.x;
    c.ty = t.y;
    c.lean = t.lean;
    return o;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  hit resolution — attacker side
   * ---------------------------------------------------------------------------------------------- */

  /** Effective length scale for a hitbox: (reach/5)^reachScale × charge reach. */
  private lengthScale(reachScale: number | undefined): number {
    const reach = (this.def.attributes.reach * this.stats.reachMul) / 5;
    return Math.pow(reach, reachScale ?? 1) * this.mv.reach;
  }

  private resolveMoveHits(): void {
    const m = this.mv;
    const def = m.def;
    const variant = m.variant;
    if (!def || !variant || m.feint) return;
    const at = m.phaseTick - 1;
    const boxes = variant.hitboxes;
    for (let k = 0; k < boxes.length; k++) {
      const hb = boxes[k]!;
      if (at < hb.from || at >= hb.to) continue;
      const last = m.hitAt[k]!;
      if (hb.rehit && hb.rehit > 0) {
        if (last >= 0 && this.tickNo - last < hb.rehit) continue;
      } else if (last >= 0) continue;
      const span = hb.to - hb.from;
      const u = span > 1 ? (at - hb.from) / (span - 1) : 0;
      instantiateTemplate(
        hb.shape,
        this.place(this.lengthScale(hb.reachScale)),
        this.liveShape,
        hb.sweepTo,
        u,
      );
      // a once-per-move blow bites as deep as its own window allows (a lunge carries it further in a few ticks): see deepestBite
      let shape = this.liveShape;
      if (!(hb.rehit && hb.rehit > 0) && hb.to - at > 1) {
        const deep = this.deepestBite(hb, at, span);
        if (deep) shape = deep;
      }
      if (
        this.strike(
          shape,
          hb.damage,
          hb.knockback.x,
          hb.knockback.y,
          hb.guardPressure,
          m.hitstop,
          def.slot,
          def.id,
        )
      ) {
        // a blow that only skimmed the foe's parts (tendrils, moons) stays armed until it reaches the body
        if ((this.foe as unknown as { lastBodyTouched?: boolean }).lastBodyTouched !== false) {
          m.hitAt[k] = this.tickNo;
          m.hits++;
        }
      }
    }
  }

  /**
   * Called on the tick a once-per-move hitbox is about to be tried. If it already touches the foe, look ahead through the rest of
   * its window (the lunge's predicted displacement and the hitbox sweep, at most 8 ticks) for the tick at which it overlaps the
   * foe most, and return the shape there: the first tick of contact is usually a graze of a horn or a crag, and spending the
   * whole blow on it wastes it. Returns null when the current tick is already the best (or nothing is touched yet).
   */
  private deepestBite(hb: HitboxDef, at: number, span: number): FatShape | null {
    const m = this.mv;
    const foe = this.foe;
    if (foe.view.intangible) return null;
    const now = foe.probe(asShape(this.liveShape), this.probeOut).cells;
    if (now <= 0) return null;
    const K = Math.min(hb.to - 1 - at, 8);
    const last = m.disp.length - 1;
    const nowEff = Math.min(last, this.effTick());
    const scale = this.lengthScale(hb.reachScale);
    let best = now;
    let found = false;
    for (let k = 1; k <= K; k++) {
      const u = span > 1 ? (at + k - hb.from) / (span - 1) : 0;
      instantiateTemplate(hb.shape, this.place(scale), this.candShape, hb.sweepTo, u);
      // the lunge carries the shape along the attack axis
      const d = m.disp[Math.min(last, nowEff + k)]! - m.disp[nowEff]!;
      translateShape(this.candShape, d * this.aimUx, d * this.aimUy);
      const c = foe.probe(asShape(this.candShape), this.probeOut).cells;
      if (c > best * 1.12) {
        best = c;
        copyShape(this.deepShape, asShape(this.candShape));
        found = true;
      }
    }
    return found ? this.deepShape : null;
  }

  /**
   * World shape of hitbox `k` of the current move at tick `at` of the active phase (0 = first active tick), for behaviours'
   * visuals (whips, beams). Returns false when there is no such hitbox. `at` is clamped into the hitbox's window.
   */
  liveHitShape(k: number, at: number, out: FatShape): boolean {
    const m = this.mv;
    const hb = m.variant?.hitboxes[k];
    if (!hb) return false;
    const span = hb.to - hb.from;
    const a = clamp(at, hb.from, hb.to - 1);
    const u = span > 1 ? (a - hb.from) / (span - 1) : 0;
    instantiateTemplate(hb.shape, this.place(this.lengthScale(hb.reachScale)), out, hb.sweepTo, u);
    return true;
  }

  /**
   * Probe `shape` against the foe and, if it touches anything, deliver a DamageEvent. Used by hitboxes and by the behaviour's
   * detached volumes (swarm fragments). Returns whether the blow connected.
   */
  strike(
    shape: FatShape,
    dmg: { type: DamageType; energy: number; duration: number; flags: number; params: DamageEvent['params'] },
    kbx: number,
    kby: number,
    guardPressure: number,
    hitstopBase: number,
    slot: MoveSlot,
    moveId: string,
    energyMul = 1,
  ): boolean {
    const foe = this.foe;
    if (foe.view.intangible) return false;
    // depth prototype: bodies far apart in depth pass each other
    if (this.zdepth && Math.abs(this.z - foe.view.z) > ZDEPTH.collide) return false;
    const ov = foe.probe(asShape(shape), this.ovTmp);
    if (ov.cells <= 0) return false;

    copyShape(this.evShape, asShape(shape));
    const e = this.ev;
    e.type = dmg.type;
    e.energy = dmg.energy * this.stats.damageMul * this.mv.power * energyMul * this.feel.power;
    const t = this.body.transform;
    // authored knockback is facing-relative; during a move it turns with the attack axis (orbit footwork)
    const rc = this.mv.def ? this.rot.c : 1;
    const rs = this.mv.def ? this.rot.s : 0;
    const kfx = kbx * this.facing;
    const kwx = rc * kfx - rs * kby;
    const kwy = rs * kfx + rc * kby;
    let dx = kwx;
    let dy = kwy;
    if (shape.kind === 'line' && dx === 0 && dy === 0) {
      dx = shape.x1 - shape.x0;
      dy = shape.y1 - shape.y0;
    }
    if (dx === 0 && dy === 0) dx = this.facing;
    const dl = Math.hypot(dx, dy) || 1;
    e.dirX = dx / dl;
    e.dirY = dy / dl;
    e.duration = dmg.duration;
    e.sourceMass = this.stats.mass;
    // a move with extra.noCredit feeds nobody (the Black Hole's streams must not inflate its own mass without bound)
    e.sourceBodyId = this.mv.def?.extra?.['noCredit'] ? -1 : this.body.id;
    e.originX = t.x;
    e.originY = t.y;
    const fv = foe.view;
    e.flags = dmg.flags | (fv.integrityPct < 24 ? DamageFlag.FINISHER : 0);
    e.params = this.feel.power === 1 ? dmg.params : this.scaleParams(dmg.params, this.feel.power);
    e.shape = asShape(this.evShape);

    const info = this.hitInfo;
    info.knockX = kwx;
    info.knockY = kwy;
    info.guardPressure = guardPressure;
    info.hitstopBase = hitstopBase;
    info.heavy = slot === 'crush' || slot === 'ultimate' || e.energy >= 700;
    info.continuous = (dmg.flags & DamageFlag.CONTINUOUS) !== 0;
    info.stunMul = info.continuous ? 0.25 : 1;
    info.moveId = moveId;

    const res = foe.receive(e, this, this.events);
    if (!res.connected) return false;
    this.afterHit(res, e, info);
    return true;
  }

  private afterHit(res: HitResult, e: DamageEvent, info: HitInfo): void {
    const foe = this.foe;
    const fv = foe.view;
    const ev = this.events;
    this.lastDealtTick = this.tickNo;
    // a graze (only the foe's parts were touched) earns no meter and none of the big-hit presentation
    const graze = (foe as unknown as { lastBodyTouched?: boolean }).lastBodyTouched === false;
    if (this.live && !graze)
      this.meter = Math.min(1, this.meter + e.energy * T.meterDealt * (1 - res.blocked * 0.7));

    const rate = !info.continuous || this.tickNo - this.lastEventTick >= T.continuousEventEvery;
    if (rate) {
      this.lastEventTick = this.tickNo;
      ev.push({
        t: 'hit',
        attacker: this.slot,
        target: foe.slot,
        titan: foe.def.id,
        x: res.x,
        y: res.y,
        dirX: e.dirX,
        dirY: e.dirY,
        type: e.type,
        energy: e.energy,
        cellsRemoved: res.cellsRemoved,
        massRemoved: res.massRemoved,
        blocked: res.blocked,
        heavy: info.heavy,
        onDamaged: (foe as unknown as { lastOnDamaged?: number }).lastOnDamaged ?? 0,
      });
      if (res.hitstop > 0 && !info.continuous) ev.push({ t: 'hitstop', ticks: res.hitstop });
      const massK = Math.pow((this.stats.mass + fv.stats.mass) / 10, 0.55);
      const amp =
        clamp(0.09 * Math.pow(e.energy * (info.continuous ? 6 : 1), 0.62), 0.6, 14) *
        massK *
        (1 - res.blocked * 0.6);
      ev.push({ t: 'shake', dirX: e.dirX, dirY: e.dirY, amp: graze ? amp * 0.4 : amp });
      if (info.heavy && !graze)
        ev.push({ t: 'zoom', amount: clamp((e.energy / 40000) * massK, 0.008, 0.06) });
      // the camera rolls with the spin the blow put into the target (ω-driven; a centre hit barely rolls it)
      const dw = (foe as unknown as { lastDeltaW?: number }).lastDeltaW ?? 0;
      if (!graze && Math.abs(dw) > 0.05)
        ev.push({ t: 'roll', radians: clamp(dw * T.rollPerSpin, -0.022, 0.022) });
      if (e.energy >= 600 && res.blocked < 0.8 && !info.continuous && !graze)
        ev.push({
          t: 'shockwave',
          x: res.x,
          y: res.y,
          strength: clamp((e.energy / 3200) * massK, 0.15, 1),
          radius: (50 + e.energy * 0.09) * massK,
          hue: this.def.destruction === 'THERMAL' ? 0.06 : this.def.destruction === 'FRACTURE' ? 0.42 : 0.1,
        });
      if (!graze)
        ev.push({
          t: 'rumble',
          slot: this.slot,
          strong: clamp(e.energy / 2400, 0.05, 0.6),
          weak: 0.2,
          ms: info.heavy ? 160 : 70,
        });
      if (!graze)
        ev.push({
          t: 'rumble',
          slot: foe.slot,
          strong: clamp(e.energy / 1300, 0.1, 1),
          weak: 0.5,
          ms: info.heavy ? 260 : 110,
        });
    }
    // finishing blow: slow motion, flash, a huge shake
    if (fv.ko && !this.foeKoAnnounced) {
      this.foeKoAnnounced = true;
      ev.push({ t: 'timescale', scale: T.koTimescale, ticks: T.koTimescaleTicks });
      ev.push({ t: 'flash', amount: 0.7, x: res.x, y: res.y });
      ev.push({ t: 'shake', dirX: e.dirX, dirY: e.dirY, amp: 16 });
      ev.push({ t: 'shockwave', x: res.x, y: res.y, strength: 1, radius: 240, hue: 0.1 });
      ev.push({ t: 'zoom', amount: 0.05 });
    }
    if (!graze && !info.continuous) {
      // follow-through: the attacker pushes a few px THROUGH the contact, then eases back
      const push =
        clamp(1.2 + e.energy / 500, 1.2, T.followMax) * this.feel.shudder * (res.blocked > 0.5 ? 0.4 : 1);
      this.followX += e.dirX * push;
      this.followY += e.dirY * push * 0.5;
      const t = this.body.transform;
      this.offX = this.followX;
      this.offY = this.followY;
      t.x = Math.round(this.px + this.offX);
      t.y = Math.round(this.py + this.offY);
    }
    this.spawnHitSparks(res, e);
    this.behaviour.onDealt(e.energy);
  }

  private foeKoAnnounced = false;
  /** Set by receive(): the last hit's onDamagedFraction (read by the attacker for the hit event). */
  lastOnDamaged = 0;

  private spawnHitSparks(res: HitResult, e: DamageEvent): void {
    const s = this.particleSpawn;
    s.kind = 'spark';
    s.ramp = this.sparkRamp;
    s.life[0] = 12;
    s.life[1] = 30;
    s.spread = 120;
    s.emissive = 200;
    s.fieldScale = 0.2;
    s.drag = 1.5;
    s.x = res.x;
    s.y = res.y;
    s.vx = e.dirX * 140;
    s.vy = e.dirY * 140 - 30;
    s.count = clamp(Math.round(e.energy / 60), 2, 14);
    this.world.spawnParticles(s);
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  hit resolution — defender side
   * ---------------------------------------------------------------------------------------------- */

  probe(shape: DamageShape, out?: OverlapResult): OverlapResult {
    const r = out ?? this.probeOut;
    if (this.intangible) {
      r.cells = 0;
      r.x = NaN;
      r.y = NaN;
      r.nearestX = NaN;
      r.nearestY = NaN;
      r.coverage = 0;
      return r;
    }
    this.world.overlap(this.body.id, shape, r);
    this.behaviour.probeParts(shape, r);
    return r;
  }

  receive(evIn: DamageEvent, attacker: Fighter, events: SimEvent[]): HitResult {
    this.events = events;
    const res = this.hitRes;
    const info: HitInfo = (attacker as unknown as { hitInfo?: HitInfo }).hitInfo ?? {
      knockX: evIn.dirX * 300,
      knockY: evIn.dirY * 300,
      guardPressure: 0.5,
      hitstopBase: 8,
      heavy: evIn.energy >= 700,
      continuous: (evIn.flags & DamageFlag.CONTINUOUS) !== 0,
      stunMul: 1,
      moveId: '',
    };
    this.lastBodyTouched = true;
    res.blocked = 0;
    res.cellsRemoved = 0;
    res.massRemoved = 0;
    res.connected = false;
    res.hitstop = 0;
    res.x = NaN;
    res.y = NaN;
    this.lastOnDamaged = 0;

    // work on a private copy so the attacker's event is never mutated
    const e = this.evIn;
    e.type = evIn.type;
    e.shape = evIn.shape;
    e.energy = evIn.energy / this.feel.durability;
    e.dirX = evIn.dirX;
    e.dirY = evIn.dirY;
    e.duration = evIn.duration;
    e.sourceMass = evIn.sourceMass;
    e.sourceBodyId = evIn.sourceBodyId;
    e.originX = evIn.originX;
    e.originY = evIn.originY;
    e.flags = evIn.flags;
    e.params =
      this.feel.durability === 1 ? evIn.params : this.scaleParams(evIn.params, 1 / this.feel.durability);
    const rawEnergy = e.energy;

    // 1. guard shell
    let blocked = 0;
    if (this.guardUp && !this.ko && !(e.flags & DamageFlag.UNBLOCKABLE)) {
      const absorb = this.shell.absorb[e.type] ?? 0.4;
      blocked = clamp01(absorb * this.guardStrength());
      e.energy *= 1 - blocked;
      const drain =
        info.guardPressure *
        (T.guardDrainBase + rawEnergy / T.guardDrainEnergy) *
        (e.type === 'CRUSH' ? 1.4 : 1);
      this.guardHealth -= drain;
      const broke = this.guardHealth <= 0;
      const cx = shapeCentreX(evIn.shape, this.px);
      const cy = shapeCentreY(evIn.shape, this.py);
      events.push({ t: 'guard', slot: this.slot, x: cx, y: cy, type: e.type, broke });
      if (broke) {
        this.guardHealth = 0;
        this.guardUp = false;
        this.state = 'guardbreak';
        this.guardBreakTicks = T.guardBreakStun;
        this.stateTicks = 0;
        events.push({ t: 'resource', slot: this.slot, kind: 'break', amount: 1 });
      }
    }

    // 2. parts (tendrils, moons, fragments)
    const ir = this.icpt;
    ir.absorbed = 0;
    ir.partsHit = 0;
    ir.extraCells = 0;
    ir.extraMass = 0;
    ir.touched = false;
    this.behaviour.intercept(e, info, ir);
    e.energy *= 1 - clamp01(ir.absorbed);
    const partsAbsorb = clamp01(ir.absorbed);

    // hit-stop is decided before the world sees the blow, so matter can time the wound's shear in wall time (DamageEvent.hitstop)
    const mass = Math.max(1, this.stats.mass);
    const hitstop = info.continuous
      ? 0
      : this.hitstopFor(
          info.hitstopBase,
          rawEnergy,
          attacker.view.stats.mass + mass,
          clamp01(blocked + (1 - blocked) * partsAbsorb),
        );
    e.hitstop = hitstop;

    // 3. the matter world
    let dr = EMPTY_DAMAGE_RESULT as Readonly<typeof EMPTY_DAMAGE_RESULT>;
    if (e.energy >= 0.5) {
      dr = this.world.applyDamage(this.body.id, e);
    }
    const cells = dr.cellsRemoved + ir.extraCells;
    res.cellsRemoved = cells;
    res.massRemoved = dr.massRemoved + ir.extraMass;
    res.connected = dr.cellsTouched > 0 || ir.partsHit > 0 || blocked > 0 || ir.touched;
    if (Number.isFinite(dr.contactX)) {
      res.x = dr.contactX;
      res.y = dr.contactY;
    } else {
      res.x = shapeCentreX(evIn.shape, this.px);
      res.y = shapeCentreY(evIn.shape, this.py);
    }
    res.blocked = clamp01(blocked + (1 - blocked) * partsAbsorb);
    this.lastOnDamaged = dr.onDamagedFraction;
    if (!res.connected) return res;
    // A blow that only skimmed parts (tendrils, moons) — no body cell touched, nothing guarded — is a graze: the parts took it, the
    // body is not shoved, stunned or hit-stopped, and the attacker's hitbox stays armed for the body behind them.
    this.lastBodyTouched = dr.cellsTouched > 0 || blocked > 0;
    if (!this.lastBodyTouched) {
      res.hitstop = 0;
      if (!this.ko && this.live) this.behaviour.onDamaged(e.energy, evIn.dirX, evIn.dirY);
      this.syncView();
      return res;
    }

    // 4. knockback, stun, meter, KO
    this.lastHitTick = this.tickNo;
    this.lastHitDirX = evIn.dirX;
    this.lastHitDirY = evIn.dirY;
    this.lastDeltaW = 0;
    const guarded = this.guardUp && blocked > 0.25;
    const kbMul = (guarded ? T.guardKnockbackMul : 1) * (info.continuous ? 0.5 : 1);
    if (!this.ko) {
      // The blow is momentum at a point (impact.ts): Δv = J/m into the body's one velocity (kept until drag or thrust
      // removes it) and, through the lever arm from the centre of mass, a spin. Where it lands decides which dominates.
      const ratio = clamp(
        Math.pow(Math.max(0.5, attacker.view.stats.mass) / mass, T.knockMassExp),
        T.knockRatioMin,
        T.knockRatioMax,
      );
      const rawX = info.knockX + dr.impulseX * T.worldImpulseGain;
      const rawY = info.knockY + dr.impulseY * T.worldImpulseGain;
      const k = T.knockScale * ratio * kbMul * this.feel.knockMul;
      let kx = rawX * k;
      let ky = rawY * k;
      const sp = Math.hypot(kx, ky);
      if (sp > T.knockMax) {
        kx *= T.knockMax / sp;
        ky *= T.knockMax / sp;
      }
      this.applyImpact(res.x, res.y, kx * mass, ky * mass, mass);
      // a light blow is a nudge the stunned body brakes at once; only a heavy shove keeps sliding for the full brake
      this.brakeTau = T.stunDragTau * clamp(Math.hypot(this.vx, this.vy) / 350, 0.3, 1);
      // the body itself recoils too: a bend that a heavy defender shows instead of moving
      const raw = Math.hypot(rawX, rawY);
      const kick = clamp(raw * T.recoilGain * Math.sqrt(ratio) * kbMul * this.feel.recoil, 0, T.recoilMax);
      this.leanV += Math.sign(evIn.dirX || 1) * kick * this.facing * 0.6;
      this.shudderAmp = Math.max(
        this.shudderAmp,
        clamp(T.shudderBase + e.energy / T.shudderEnergy, 0.9, 2) *
          this.feel.shudder *
          (info.continuous ? 0.4 : 1),
      );
      // the frames frozen by hit-stop already show the vibration
      if (!info.continuous) this.applyShudderNow();
    }
    if (!this.ko && this.live) {
      this.meter = Math.min(1, this.meter + rawEnergy * T.meterTaken * (1 - blocked * 0.6));
      const armor = this.mv.def?.tags.includes('armor') && this.mv.phase !== 'recovery';
      if (!guarded && !armor && this.state !== 'guardbreak') {
        let stun =
          T.stunBase *
          Math.sqrt(Math.max(0.05, e.energy) / 300) *
          Math.sqrt(T.massNeutral / mass) *
          info.stunMul;
        if (this.tickNo - this.stunEndTick < T.stunGraceTicks) stun *= T.stunComboScale;
        const ticks = Math.round(clamp(stun, info.continuous ? 0 : T.stunMin, T.stunMax));
        if (ticks > 0) this.enterHitstun(ticks);
      }
      this.behaviour.onDamaged(e.energy, evIn.dirX, evIn.dirY);
      this.refreshStats();
    }

    // 5. hit-stop (decided above, before the world saw the blow)
    res.hitstop = hitstop;
    this.syncView(); // the attacker (and the AI) read this fighter's view before its own tick comes round
    return res;
  }

  /** Hit-stop ticks for a blow (a short beat; momentum and torque carry the weight, D27). */
  private hitstopFor(base: number, energy: number, massSum: number, blocked: number): number {
    const k =
      (base / T.hitstopBaseRef) *
      (energy / T.hitstopEnergyRef) *
      Math.sqrt(massSum / 10) *
      (1 - blocked * 0.4);
    return Math.round(HITSTOP_MIN_TICKS + (HITSTOP_MAX_TICKS - HITSTOP_MIN_TICKS) * clamp01(k));
  }

  /** Spin (rad/s) the last blow put into this body: the attacker reads it for the ω-driven camera roll. */
  lastDeltaW = 0;
  /** Class of the last blow that reached the body (centre / edge / glancing / low). */
  lastHitClass: 'centre' | 'edge' | 'glancing' | 'low' = 'centre';

  /**
   * Apply a blow's momentum (jx, jy) at world point (cx, cy): measure the body's centre of mass and gyration (cached by map
   * version), classify the hit, add Δv = J'/m and Δω, and announce the class as a cue (telemetry, audio, tools).
   */
  private applyImpact(cx: number, cy: number, jx: number, jy: number, mass: number): void {
    const mp = measureMass(this.body.map, this.massProps);
    const com = this.comWorld;
    localToWorld(this.body.transform, mp.comX, mp.comY, com);
    const px = Number.isFinite(cx) ? cx : com.x;
    const py = Number.isFinite(cy) ? cy : com.y;
    const r = resolveImpact(px, py, jx, jy, com.x, com.y, mass, mp.gyration, mp.radius, this.impact);
    this.vx += r.jx / mass;
    this.vy += r.jy / mass;
    this.ang.impulse(r.dw, this.feel.angular);
    this.lastDeltaW = r.dw;
    this.lastHitClass = r.cls;
    this.events.push({
      t: 'cue',
      slot: this.slot,
      titan: this.def.id,
      id: `hit-${r.cls}`,
      x: px,
      y: py,
      amount: r.dw,
    });
  }

  private readonly comWorld = { x: 0, y: 0 };

  /**
   * Continuous movement emissions from the titan's `feel.fx` (a wake of dust or gas, embers, motes...): density follows distance
   * travelled times sqrt(mass), a few particles at most every third tick, so the world's particle pool is never the bottleneck.
   */
  private emitMoveFx(): void {
    const fx = this.feel.fx;
    if (!fx || !this.live || this.ko || this.tickNo - this.lastFxTick < 3) return;
    const svx = this.vx;
    const svy = this.vy;
    const speed = Math.hypot(svx, svy);
    const mf = Math.sqrt(Math.max(0.5, this.stats.mass) / 5);
    this.fxDist += speed * TICK_DT * 3;
    this.fxIdle += fx.idleRate * mf * TICK_DT * 3;
    let n = Math.floor((this.fxDist / 100) * fx.perHundredPx * mf + this.fxIdle);
    if (n <= 0) return;
    this.fxDist = 0;
    this.fxIdle = 0;
    n = Math.min(n, 3);
    this.lastFxTick = this.tickNo;
    const h = Math.imul(this.tickNo + this.slot * 7919, 2654435761) >>> 0;
    const u = (h & 0xffff) / 0xffff - 0.5;
    const w = ((h >>> 16) & 0xffff) / 0xffff - 0.5;
    const dirx = speed > 20 ? svx / speed : -this.facing;
    const s = this.particleSpawn;
    s.kind = fx.kind;
    s.ramp = fx.ramp;
    s.life[0] = fx.life[0];
    s.life[1] = fx.life[1];
    s.spread = fx.spread;
    s.emissive = fx.emissive;
    s.size = fx.size;
    s.fieldScale = 0.4;
    s.drag = 1.2;
    s.x = this.px - dirx * fx.behind + u * 26;
    s.y = this.py + w * 40;
    s.vx = -svx * 0.12;
    s.vy = fx.rise - svy * 0.1;
    s.count = n;
    this.world.spawnParticles(s);
    // restore the shared spawn record to the hit-spark defaults
    s.size = 1;
    s.drag = 1.5;
    s.fieldScale = 0.2;
  }

  private readonly scaledParams: DamageParams = {};

  /** The params with the effects that do not follow energy (infection, harvest, pull, compression, heat, shock) scaled by k (`balance.power` out, 1/`balance.durability` in). */
  private scaleParams(p: DamageParams, k: number): DamageParams {
    const o = this.scaledParams;
    for (const key of Object.keys(o) as (keyof DamageParams)[]) delete o[key];
    Object.assign(o, p);
    if (p.latch !== undefined) o.latch = Math.min(255, p.latch * k);
    if (p.harvest !== undefined) o.harvest = Math.min(1, p.harvest * k);
    if (p.pull !== undefined) o.pull = p.pull * k;
    if (p.compress !== undefined) o.compress = p.compress * k;
    if (p.heat !== undefined) o.heat = p.heat * k;
    if (p.shock !== undefined) o.shock = p.shock * k;
    return o;
  }

  /** Displace the transform by the first vibration sample now (the hit-stop frames are drawn before the next tick). */
  private applyShudderNow(): void {
    const t = this.body.transform;
    const a = this.shudderAmp;
    this.offX = a * (this.slot === 0 ? 1 : -1);
    this.offY = -a * 0.5;
    t.x = Math.round(this.px + this.offX);
    t.y = Math.round(this.py + this.offY);
  }

  private enterHitstun(ticks: number): void {
    if (this.mv.def) this.endMove(true);
    this.guardUp = false;
    this.state = 'hitstun';
    this.hitstunTicks = ticks;
    this.stunElapsed = 0;
    this.stateTicks = 0;
    this.intangible = false;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  threats (for the AI, Training overlay and telegraphs)
   * ---------------------------------------------------------------------------------------------- */

  /** Add a detached or scheduled threat to this tick's list (behaviours call this for projectiles). */
  addThreat(
    shape: DamageShape,
    type: DamageType,
    energy: number,
    ticksUntilLive: number,
    ticksLive: number,
    detached: boolean,
  ): void {
    if (this.threatCount >= MAX_THREATS) return;
    const i = this.threatCount++;
    const th = this.threatPool[i]!;
    copyShape(this.threatShapes[i]!, shape);
    th.type = type;
    th.energy = energy;
    th.ticksUntilLive = ticksUntilLive;
    th.ticksLive = ticksLive;
    th.detached = detached;
  }

  /** Append the current move's hitbox telegraphs after any detached threats the behaviour added this tick, then publish. */
  private updateThreats(): void {
    const m = this.mv;
    if (m.def && m.variant && !m.feint) {
      const boxes = m.variant.hitboxes;
      let until: number;
      let activeTick: number;
      if (m.phase === 'startup') {
        until = m.startup - m.phaseTick + 1;
        activeTick = -until;
      } else if (m.phase === 'charge') {
        until = 3;
        activeTick = -until;
      } else if (m.phase === 'active') {
        until = 0;
        activeTick = m.phaseTick - 1;
      } else {
        until = -1;
        activeTick = 1e9;
      }
      if (until >= 0) {
        for (let k = 0; k < boxes.length && this.threatCount < MAX_THREATS; k++) {
          const hb = boxes[k]!;
          if (activeTick >= hb.to) continue;
          const startIn = Math.max(0, hb.from - activeTick);
          const live = activeTick >= hb.from;
          const span = hb.to - hb.from;
          const uu = live && span > 1 ? (activeTick - hb.from) / (span - 1) : 0;
          const i = this.threatCount++;
          instantiateTemplate(
            hb.shape,
            this.place(this.lengthScale(hb.reachScale)),
            this.threatShapes[i]!,
            hb.sweepTo,
            uu,
          );
          if (!live && m.phase === 'startup') {
            // the attacker keeps moving until the hitbox goes live: show where it WILL be (a lunge covers ground first)
            const last = m.disp.length - 1;
            const hitEff = Math.min(last, m.startup + hb.from);
            const nowEff = Math.min(last, this.effTick());
            const d = m.disp[hitEff]! - m.disp[nowEff]!;
            translateShape(this.threatShapes[i]!, d * this.aimUx, d * this.aimUy);
          }
          if (hb.shape.kind === 'point' && (m.phase === 'startup' || m.phase === 'active')) {
            // a ramming hitbox rides the moving body: publish the swept capsule it will cover while live
            const last = m.disp.length - 1;
            const startEff = live ? Math.min(last, this.effTick()) : Math.min(last, m.startup + hb.from);
            const endEff = Math.min(last, m.startup + hb.to);
            const d = m.disp[endEff]! - m.disp[startEff]!;
            if (Math.abs(d) > 6) {
              const sh = this.threatShapes[i]!;
              const r = sh.r;
              sh.kind = 'line';
              sh.x0 = sh.x;
              sh.y0 = sh.y;
              sh.x1 = sh.x + d * this.aimUx;
              sh.y1 = sh.y + d * this.aimUy;
              sh.width = 2 * r;
            }
          }
          const th = this.threatPool[i]!;
          th.type = hb.damage.type;
          th.energy = hb.damage.energy * this.stats.damageMul * m.power;
          th.ticksUntilLive = live ? 0 : startIn;
          th.ticksLive = Math.max(0, hb.to - Math.max(activeTick, hb.from));
          th.detached = false;
        }
      }
    }
    const vt = this.view.threats;
    vt.length = this.threatCount;
    for (let i = 0; i < this.threatCount; i++) vt[i] = this.threatPool[i]!;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  view
   * ---------------------------------------------------------------------------------------------- */

  private syncView(): void {
    const v = this.view;
    v.x = this.px;
    v.y = this.py;
    v.vx = this.vx;
    v.vy = this.vy;
    v.facing = this.facing;
    v.angle = this.ang.angle;
    v.spin = this.ang.spin;
    v.z = this.z;
    v.orbit = this.footwork === 'orbit' ? this.orbitState : 'neutral';
    const b = this.liveBounds();
    v.boundsX0 = b.x0;
    v.boundsY0 = b.y0;
    v.boundsX1 = b.x1;
    v.boundsY1 = b.y1;
    v.state = this.state;
    const m = this.mv;
    if (m.def) {
      v.moveId = m.def.id;
      v.moveSlot = m.def.slot;
      v.aim = m.aim;
      v.phase = m.phase;
      v.moveTick = m.tick;
      v.phaseTick = m.phaseTick;
      v.moveTotal = m.startup + m.active + m.recovery;
      v.chargeFrac = m.chargeMax > 0 ? clamp01(m.chargeTicks / m.chargeMax) : 0;
      v.cancellable =
        !m.feint &&
        m.def.slot !== 'surge' &&
        ((m.phase === 'startup' && m.phaseTick <= Math.floor(m.cancelWindow * m.startup)) ||
          m.phase === 'charge');
    } else {
      v.moveId = null;
      v.moveSlot = null;
      v.aim = null;
      v.phase = null;
      v.moveTick = 0;
      v.phaseTick = 0;
      v.moveTotal = 0;
      v.chargeFrac = 0;
      v.cancellable = false;
    }
    v.hitstunTicks = this.hitstunTicks;
    v.guardUp = this.guardUp;
    v.guardHealth = this.guardHealth;
    v.intangible = this.intangible;
    v.resource = this.resource;
    v.resourceMax = this.resourceMax;
    v.meter = this.meter;
    v.ko = this.ko;
    v.freezeTicks = this.freezeTicks;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  Fighter API: freeze / layers / debug / rounds
   * ---------------------------------------------------------------------------------------------- */

  /**
   * Put a time-limited speed multiplier on this fighter (`mul` < 1 slows/roots it for `ticks` fighter ticks; a stronger effect
   * replaces a weaker one, an equal or weaker one only extends the time). Used by the foe's chains.
   */
  applyStatus(mul: number, ticks: number): void {
    if (this.ko) return;
    if (this.statusTicks <= 0 || mul <= this.statusMul) this.statusMul = mul;
    this.statusTicks = Math.max(this.statusTicks, ticks);
  }

  clearStatus(): void {
    this.statusMul = 1;
    this.statusTicks = 0;
  }

  freeze(ticks: number): void {
    this.freezeTicks = Math.max(this.freezeTicks, ticks);
    this.freezeAge = 0;
    this.view.freezeTicks = this.freezeTicks;
    this.behaviour.onFreeze(ticks);
  }

  renderLayers(view: ViewRect, alpha: number): RenderLayer[] {
    const out = this.layerOut;
    out.length = 0;
    const t = this.body.transform;
    const map = this.body.map;
    const L = this.bodyLayer;
    let jx = 0;
    let jy = 0;
    if (this.freezeTicks > 0) {
      // hit-stop vibration: the victim shudders, the attacker only presses in
      const victim = this.tickNo - this.lastHitTick < 3;
      const amp = victim ? 1.6 : 0.6;
      const h = (this.freezeAge++ * 2654435761) >>> 0;
      jx = Math.round(((h & 255) / 127.5 - 1) * amp);
      jy = Math.round((((h >>> 8) & 255) / 127.5 - 1) * amp * 0.6);
    }
    L.x = t.x + jx;
    L.y = t.y + jy;
    L.prevX = this.prevTx + jx;
    L.prevY = this.prevTy + jy;
    L.facing = t.facing;
    L.lean = t.lean;
    L.anchorX = t.anchorX;
    L.anchorY = t.anchorY;
    L.version = map.version;
    const md = map.dirty;
    if (md !== null) {
      // copy the matter world's changed rect into our own (the renderer nulls `L.dirty` after upload) and consume it
      let d = L.dirty;
      if (d === null) {
        d = this.bodyDirty;
        d.x0 = md.x0;
        d.y0 = md.y0;
        d.x1 = md.x1;
        d.y1 = md.y1;
        L.dirty = d;
      } else {
        if (md.x0 < d.x0) d.x0 = md.x0;
        if (md.y0 < d.y0) d.y0 = md.y0;
        if (md.x1 > d.x1) d.x1 = md.x1;
        if (md.y1 > d.y1) d.y1 = md.y1;
      }
      map.dirty = null;
    }
    L.pixels = map.pixels;
    L.emissive = map.emissive;
    out.push(L);
    this.behaviour.renderLayers(view, alpha, out);
    return out;
  }

  debugShapes(out: DebugShape[]): void {
    const m = this.mv;
    if (m.def && m.variant && m.phase === 'active') {
      const at = m.phaseTick - 1;
      for (const hb of m.variant.hitboxes) {
        if (at < hb.from || at >= hb.to) continue;
        const sh = makeFatShape();
        const span = hb.to - hb.from;
        instantiateTemplate(
          hb.shape,
          this.place(this.lengthScale(hb.reachScale)),
          sh,
          hb.sweepTo,
          span > 1 ? (at - hb.from) / (span - 1) : 0,
        );
        out.push({ shape: asShape(sh), color: 0xff3040ff, label: hb.id });
      }
    }
    for (let i = 0; i < this.threatCount; i++) {
      const th = this.threatPool[i]!;
      if (th.ticksUntilLive > 0) {
        const sh = makeFatShape();
        copyShape(sh, th.shape);
        out.push({ shape: asShape(sh), color: 0xff30c0ff, label: `t-${th.ticksUntilLive}` });
      }
    }
    this.behaviour.debugShapes(out);
  }

  nextRound(x: number, y: number, facing: 1 | -1, healFraction: number, seed: number): void {
    if (this.mv.def) this.endMove(true);
    this.px = x;
    this.py = y;
    this.vx = 0;
    this.vy = 0;
    this.facing = facing;
    this.leanF = 0;
    this.leanV = 0;
    this.state = 'intro';
    this.stateTicks = 0;
    this.ko = false;
    this.victory = false;
    this.foeKoAnnounced = false;
    this.hitstunTicks = 0;
    this.guardUp = false;
    this.guardHealth = 1;
    this.guardBreakTicks = 0;
    this.intangible = false;
    this.moveActiveNow = false;
    this.meter = Math.min(this.meter, T.meterCarryOver);
    this.resource = this.resourceMax;
    this.buf.clear();
    this.surgeReadyAt = 0;
    this.escapeReadyAt = 0;
    this.stunEndTick = -1e9;
    this.lastHitTick = -1e9;
    this.freezeTicks = 0;
    this.statusMul = 1;
    this.statusTicks = 0;
    this.tumble = false;
    this.accX = 0;
    this.accY = 0;
    this.shudderAmp = 0;
    this.followX = 0;
    this.followY = 0;
    this.offX = 0;
    this.offY = 0;
    this.ang.reset();
    this.z = 0;
    this.vz = 0;
    this.orbitMem.prevVr = 0;
    this.orbitMem.sling = 0;
    this.orbitState = 'neutral';
    this.lastDeltaW = 0;
    this.steerOn = false;
    this.feelTrack.reset();
    this.world.heal(this.body.id, healFraction, seed);
    const t = this.body.transform;
    t.x = Math.round(x);
    t.y = Math.round(y);
    t.facing = facing;
    t.lean = 0;
    this.prevTx = t.x;
    this.prevTy = t.y;
    this.bbCache.stamp = -1e9;
    this.behaviour.reset(healFraction);
    this.refreshStats();
    this.threatCount = 0;
    this.updateThreats();
    this.syncView();
  }

  debugSetMeter(v: number): void {
    this.meter = clamp(v, 0, 1);
  }

  setVictory(): void {
    if (this.ko) return;
    if (this.mv.def) this.endMove(true);
    this.victory = true;
    this.state = 'victory';
    this.stateTicks = 0;
    this.guardUp = false;
    this.behaviour.setVictory();
    this.syncView();
  }

  moveById(id: string): MoveDef | undefined {
    return this.movesById.get(id);
  }

  /** Does a disc (part) of mine overlap `shape`? Used by behaviours for part probing. */
  static discHit(shape: DamageShape, x: number, y: number, r: number): boolean {
    return shapeIntersectsDisc(shape, x, y, r);
  }

  /** INPUT_BUFFER_TICKS re-exported for tests. */
  static readonly BUFFER = INPUT_BUFFER_TICKS;
}

function shapeCentreX(s: DamageShape, fallback: number): number {
  switch (s.kind) {
    case 'line':
      return (s.x0 + s.x1) * 0.5;
    default:
      return Number.isFinite(s.x) ? s.x : fallback;
  }
}
function shapeCentreY(s: DamageShape, fallback: number): number {
  switch (s.kind) {
    case 'line':
      return (s.y0 + s.y1) * 0.5;
    default:
      return Number.isFinite(s.y) ? s.y : fallback;
  }
}
