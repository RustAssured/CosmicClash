import {
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
import { InputBuffer } from './inputBuffer';
import { ActiveMove, MAX_HITBOXES, aimFromStick, fillDisplacement, resolveFrame } from './move';
import {
  asShape,
  copyShape,
  instantiateTemplate,
  makeFatShape,
  shapeIntersectsDisc,
  translateShape,
  type Bounds,
  type FatShape,
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

    // guard shell recovers while it is down
    if (!this.guardUp && this.guardHealth < 1)
      this.guardHealth = Math.min(1, this.guardHealth + T.guardRegenPerSec * TICK_DT);

    this.integrate();
    this.applyTransform();
    if (this.moveActiveNow) this.resolveMoveHits();
    this.threatCount = 0;
    this.behaviour.resolveVolumes(ctx);
    this.behaviour.update(ctx);
    this.updateThreats();
    this.syncView();
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
    // final tumble away from the blow
    this.vx += this.lastHitDirX * 150;
    this.vy += this.lastHitDirY * 90 - 30;
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
    }
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
      def.slot === 'surge' ? 0 : this.vx * this.facing,
      TICK_DT,
      T.glideHalfLife,
    );
    this.behaviour.onMoveStart(m);
    this.fireKeys();
    this.updateIntangible();
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
        this.vx += k.ix * this.facing * push;
        this.vy += k.iy * push;
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
    const sx = ctl > 0 ? this.input.moveX : 0;
    const sy = ctl > 0 ? this.input.moveY : 0;
    const mag = Math.hypot(sx, sy);
    const steering = ctl > 0 && mag > T.stickDeadzone;
    const half = Math.pow(0.5, dt / T.glideHalfLife);
    if (steering) {
      const a = 1 - Math.exp((-dt * Math.max(0.05, ctl)) / T.accelTau);
      this.vx = this.steerAxis(this.vx, sx * top * ctl, a, half);
      this.vy = this.steerAxis(this.vy, sy * top * T.vertSpeedMul * ctl, a, half);
    } else if (!driven) {
      this.vx *= half;
      this.vy *= half;
    }
    // soft altitude spring toward the rest altitude (a pull, never a floor)
    if (this.state !== 'ko' && (Math.abs(this.input.moveY) < 0.3 || ctl === 0)) {
      this.vy += (-T.altitudeK * (this.py - this.arena.restY) - T.altitudeC * this.vy) * dt;
    } else if (this.state === 'ko') {
      this.vy += 60 * dt;
    }

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
    this.constrainToFoe();
  }

  /** One axis of first-order steering: accelerate with τ toward the target, glide (half-life) when the target is slower. */
  private steerAxis(v: number, target: number, a: number, half: number): number {
    const accelerating = Math.abs(target) > Math.abs(v) || Math.sign(target) !== Math.sign(v);
    if (accelerating) return v + (target - v) * a;
    return target + (v - target) * half;
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
    if (dx > T.turnHysteresis) this.facing = 1;
    else if (dx < -T.turnHysteresis) this.facing = -1;
  }

  /** Tether (never further apart than MAX_FIGHTER_DX/DY) and pixel-mask body separation. */
  private constrainToFoe(): void {
    const fv = this.foe.view;
    let dx = this.px - fv.x;
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
    if (this.intangible || fv.intangible || this.ko) return;
    dx = this.px - fv.x;
    // the cores never pass through each other
    const coreGap = this.body.map.coreRadius + fv.body.map.coreRadius + 8;
    if (Math.abs(dx) < coreGap && Math.abs(this.py - fv.y) < coreGap) {
      const s = dx === 0 ? this.facing * -1 : Math.sign(dx);
      this.px = fv.x + s * coreGap;
      if (this.vx * s < 0) this.vx = 0;
      return;
    }
    // edges of the two bodies may overlap a little, then push apart (heavier yields less)
    const pen = this.maxPenetration(fv);
    if (pen > T.overlapAllowance) {
      const s = dx === 0 ? -this.facing : Math.sign(dx);
      const mSelf = this.stats.mass;
      const mFoe = fv.stats.mass;
      const share = clamp((mFoe / (mSelf + mFoe)) * 1.2, 0.2, 1);
      this.px += s * (pen - T.overlapAllowance) * share;
      if (this.vx * s < 0) this.vx *= 0.6;
    }
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

  private poseLean(): number {
    const m = this.mv;
    if (!m.def) return 0;
    const pose = m.def.extra?.['pose'] as Record<string, { lean: number }> | undefined;
    const heavy = m.def.slot === 'crush' || m.def.slot === 'ultimate';
    const back = pose?.['startup']?.lean ?? (heavy ? -7 : -4);
    const fwd = pose?.['active']?.lean ?? (heavy ? 9 : 6);
    const rec = pose?.['recovery']?.lean ?? 2;
    const chg = pose?.['charge']?.lean ?? -6;
    switch (m.phase) {
      case 'startup':
        return back * clamp01(m.phaseTick / Math.max(1, Math.min(6, m.startup)));
      case 'charge':
        return chg;
      case 'active':
        return fwd;
      default:
        return rec * (1 - clamp01(m.phaseTick / Math.max(1, m.recovery)));
    }
  }

  private applyTransform(): void {
    const t = this.body.transform;
    const dt = TICK_DT;
    // lean spring toward (velocity-driven + pose) target — overshoots slightly on direction changes
    const top = topSpeed(this.def, this.stats);
    const vf = this.vx * this.facing;
    let target =
      clamp((vf / top) * T.leanPerSpeed, -T.leanPerSpeed, T.leanPerSpeed) +
      this.poseLean() +
      this.behaviour.leanBias();
    // shoved bodies arch with the blow (world lean → facing-relative)
    if (this.state === 'ko') target = clamp(this.lastHitDirX, -1, 1) * 12 * this.facing;
    else if (this.state === 'hitstun') target = clamp(this.lastHitDirX, -1, 1) * 8 * this.facing;
    const w = T.leanOmega;
    const acc = w * w * (target - this.leanF) - 2 * T.leanZeta * w * this.leanV;
    this.leanV += acc * dt;
    this.leanF += this.leanV * dt;
    // idle breathing bob (deterministic in the tick counter)
    const calm =
      this.state === 'idle' || this.state === 'move' || this.state === 'intro' || this.state === 'guard';
    const bob = calm ? Math.sin(this.tickNo * 0.052 + this.slot * 1.7) * T.idleBob : 0;
    // whole pixels: what you see is what is hit (space.ts maps integer transforms 1:1 onto cells)
    t.x = Math.round(this.px);
    t.y = Math.round(this.py + bob);
    t.facing = this.facing;
    t.lean = Math.round(this.leanF * this.facing);
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
      const t = this.body.transform;
      instantiateTemplate(
        hb.shape,
        { x: t.x, y: t.y, facing: this.facing, scale: this.lengthScale(hb.reachScale) },
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
    const t = this.body.transform;
    const scale = this.lengthScale(hb.reachScale);
    let best = now;
    let found = false;
    for (let k = 1; k <= K; k++) {
      const u = span > 1 ? (at + k - hb.from) / (span - 1) : 0;
      instantiateTemplate(
        hb.shape,
        { x: t.x, y: t.y, facing: this.facing, scale },
        this.candShape,
        hb.sweepTo,
        u,
      );
      translateShape(
        this.candShape,
        (m.disp[Math.min(last, nowEff + k)]! - m.disp[nowEff]!) * this.facing,
        0,
      );
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
    const t = this.body.transform;
    instantiateTemplate(
      hb.shape,
      { x: t.x, y: t.y, facing: this.facing, scale: this.lengthScale(hb.reachScale) },
      out,
      hb.sweepTo,
      u,
    );
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
    const ov = foe.probe(asShape(shape), this.ovTmp);
    if (ov.cells <= 0) return false;

    copyShape(this.evShape, asShape(shape));
    const e = this.ev;
    e.type = dmg.type;
    e.energy = dmg.energy * this.stats.damageMul * this.mv.power * energyMul;
    const t = this.body.transform;
    let dx = kbx * this.facing;
    let dy = kby;
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
    e.params = dmg.params;
    e.shape = asShape(this.evShape);

    const info = this.hitInfo;
    info.knockX = kbx * this.facing;
    info.knockY = kby;
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
      const massK = Math.pow(this.stats.mass / 5, 0.3);
      const amp =
        clamp(0.09 * Math.pow(e.energy * (info.continuous ? 6 : 1), 0.62), 0.6, 14) *
        massK *
        (1 - res.blocked * 0.6);
      ev.push({ t: 'shake', dirX: e.dirX, dirY: e.dirY, amp: graze ? amp * 0.4 : amp });
      if (info.heavy && !graze) {
        ev.push({ t: 'zoom', amount: clamp(e.energy / 40000, 0.008, 0.045) });
        ev.push({ t: 'roll', radians: clamp(e.energy / 90000, 0.003, 0.02) * (e.dirX >= 0 ? 1 : -1) });
      }
      if (e.energy >= 600 && res.blocked < 0.8 && !info.continuous && !graze)
        ev.push({
          t: 'shockwave',
          x: res.x,
          y: res.y,
          strength: clamp(e.energy / 3200, 0.15, 1),
          radius: 50 + e.energy * 0.09,
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
      ev.push({ t: 'flash', amount: 0.7 });
      ev.push({ t: 'shake', dirX: e.dirX, dirY: e.dirY, amp: 16 });
      ev.push({ t: 'shockwave', x: res.x, y: res.y, strength: 1, radius: 240, hue: 0.1 });
      ev.push({ t: 'zoom', amount: 0.05 });
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
    e.energy = evIn.energy;
    e.dirX = evIn.dirX;
    e.dirY = evIn.dirY;
    e.duration = evIn.duration;
    e.sourceMass = evIn.sourceMass;
    e.sourceBodyId = evIn.sourceBodyId;
    e.originX = evIn.originX;
    e.originY = evIn.originY;
    e.flags = evIn.flags;
    e.params = evIn.params;
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
    const mass = Math.max(1, this.stats.mass);
    const massRatio = T.massNeutral / mass;
    const guarded = this.guardUp && blocked > 0.25;
    const kbMul = (guarded ? T.guardKnockbackMul : 1) * (info.continuous ? 0.5 : 1);
    if (!this.ko) {
      this.vx += (info.knockX * massRatio + dr.impulseX * T.worldImpulseGain * massRatio) * kbMul;
      this.vy += (info.knockY * massRatio + dr.impulseY * T.worldImpulseGain * massRatio) * kbMul;
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

    // 5. hit-stop suggestion
    const massScale = Math.sqrt((attacker.view.stats.mass + mass) / 10);
    const base =
      info.hitstopBase * (0.7 + rawEnergy / T.hitstopEnergyRef) * massScale * (1 - res.blocked * 0.4);
    res.hitstop = info.continuous ? 0 : Math.round(clamp(base, HITSTOP_MIN_TICKS, HITSTOP_MAX_TICKS));
    this.syncView(); // the attacker (and the AI) read this fighter's view before its own tick comes round
    return res;
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
      const t = this.body.transform;
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
            { x: t.x, y: t.y, facing: this.facing, scale: this.lengthScale(hb.reachScale) },
            this.threatShapes[i]!,
            hb.sweepTo,
            uu,
          );
          if (!live && m.phase === 'startup') {
            // the attacker keeps moving until the hitbox goes live: show where it WILL be (a lunge covers ground first)
            const last = m.disp.length - 1;
            const hitEff = Math.min(last, m.startup + hb.from);
            const nowEff = Math.min(last, this.effTick());
            translateShape(this.threatShapes[i]!, (m.disp[hitEff]! - m.disp[nowEff]!) * this.facing, 0);
          }
          if (hb.shape.kind === 'point' && (m.phase === 'startup' || m.phase === 'active')) {
            // a ramming hitbox rides the moving body: publish the swept capsule it will cover while live
            const last = m.disp.length - 1;
            const startEff = live ? Math.min(last, this.effTick()) : Math.min(last, m.startup + hb.from);
            const endEff = Math.min(last, m.startup + hb.to);
            const d = (m.disp[endEff]! - m.disp[startEff]!) * this.facing;
            if (Math.abs(d) > 6) {
              const sh = this.threatShapes[i]!;
              const r = sh.r;
              sh.kind = 'line';
              sh.x0 = sh.x;
              sh.y0 = sh.y;
              sh.x1 = sh.x + d;
              sh.y1 = sh.y;
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
      const t = this.body.transform;
      const at = m.phaseTick - 1;
      for (const hb of m.variant.hitboxes) {
        if (at < hb.from || at >= hb.to) continue;
        const sh = makeFatShape();
        const span = hb.to - hb.from;
        instantiateTemplate(
          hb.shape,
          { x: t.x, y: t.y, facing: this.facing, scale: this.lengthScale(hb.reachScale) },
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
