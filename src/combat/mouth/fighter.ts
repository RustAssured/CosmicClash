import {
  BLOW_HITSTOP_TICKS,
  BLOW_SHAKE_PX,
  Btn,
  DamageFlag,
  ANALYTIC_PACE_EXP,
  ROUND_LENGTH_PACE,
  Rng,
  TICK_DT,
  clamp,
  createMatterMap,
  makeLayer,
  rgba,
  type ArenaInfo,
  type BlowWeight,
  type BodyStats,
  type DamageEvent,
  type DamageShape,
  type DebugShape,
  type EffectiveStats,
  type Fighter,
  type FighterOptions,
  type FighterTickCtx,
  type FighterView,
  type HitResult,
  type MatterBody,
  type MatterWorld,
  type MoveDef,
  type MoveSlot,
  type OverlapResult,
  type RenderLayer,
  type SimEvent,
  type ThreatShape,
  type TitanDef,
  type ViewRect,
} from '@/contracts';
import { resolveMaterials } from '@/titans/materialTable';
import { isMouthBossDef } from '@/titans/mouth/def';
import type { RenderLayerMouth } from '@/render/mouthPass';
import type { HitInfo } from '../behaviour';
import { PACE } from '../fighter';
import { MouthCore, type MouthStepOut } from './core';
import { MouthGeom } from './geom';
import { MouthHurt } from './hurt';
import { registerMouthKnobs } from './knobs';
import {
  MOUTH_BOSS,
  MOUTH_CONST as C,
  MOUTH_LIVE,
  MOUTH_LOOK,
  MOUTH_MOVES,
  type MouthMoveName,
} from './tuning';
import { DMath } from '@/contracts/dmath';
export { MOUTH_LOOK };

/**
 * The Mouth (아귀) as a fighter (Phase 3B–3E, Gate 3A, D37). It is not matter: `MouthFighter` implements the Match's `Fighter`
 * contract directly over the crane (`MouthCore`, the prototype's motion and damage model), with capsule hurtboxes
 * (`MouthHurt`) and the GPU look (`MouthGeom` → src/render/mouthPass.ts).
 *
 * - Input (§6): stick X slides the anchor along the perimeter (oracle literal: right = clockwise), stick Y held at the strike
 *   picks the height (up = high, down = low); Strike = Bite, Crush = Sweep, Signature = Coil & crush; Surge / Guard /
 *   Ultimate are unbound. A strike pressed during another is buffered for 9 ticks.
 * - The view's x, y is the HEAD (what the foe fights, orbits and aims at); the live bounds are head + neck + the anchor's exit,
 *   so the camera keeps the anchored edge in view (§1) and the foe's frame tether keeps it within reach of the edge.
 * - Bites and the crush strike the foe's matter (`foe.receive`) like any blow: a point CRUSH at the mouth, a ring round the
 *   held foe. The coil holds the foe (its root drawn to the coil centre, its footwork damped); Surge early in the coil, or
 *   enough damage on the wrapped neck, breaks the hold (§3).
 * - Blows taken resolve on the capsules (§2): power = energy / eRef; head / neck (×1.6 stretched) / coil damage; every hit
 *   chips the current jaw-ring (§5). The anchor never moves from a blow; the head takes it as a kick into its spring.
 * - The stand-in matter body is a single cell parked far outside the arena (contracts need one; nothing touches it).
 */

const STRIKE_BITS: readonly [number, MouthMoveName, MoveSlot][] = [
  [Btn.STRIKE, 'bite', 'strike'],
  [Btn.CRUSH, 'sweep', 'crush'],
  [Btn.SIGNATURE, 'coil', 'signature'],
];
const PARK = -8000;

/** What the HUD and the Mouth's AI read off the view (FighterView.mouth). */
export interface MouthViewExtra {
  /** Health in each jaw-ring, 0..1 (ring 0 goes first). */
  rings: number[];
  /** Chips on each ring (the emblem draws them). */
  chips: number[];
  /** Neck strands cut (≥ 3 at the knockout: the head comes loose). */
  severed: number;
  boss: boolean;
  enraged: boolean;
  /** Anchor arc length, perimeter, and the exit point and normal (the AI's frame). */
  s: number;
  per: number;
  exitX: number;
  exitY: number;
  nx: number;
  ny: number;
  /** Current beat, the running move, whether a coil holds the foe. */
  beat: string;
  move: MouthMoveName | null;
  holding: boolean;
  /** Straight reach from the exit (px) after the reach slider and the safe strip. */
  reach: number;
}
export type MouthFighterView = FighterView & { mouth: MouthViewExtra };

export class MouthFighter implements Fighter {
  readonly slot: 0 | 1;
  readonly def: TitanDef;
  readonly body: MatterBody;
  readonly view: MouthFighterView;
  readonly world: MatterWorld;
  readonly arena: ArenaInfo;
  readonly core: MouthCore;
  readonly hurt = new MouthHurt();
  readonly geom = new MouthGeom();
  readonly stats: EffectiveStats = { speedMul: 1, damageMul: 1, mass: 10, reachMul: 1, tempoMul: 1 };
  /** The match knobs' balance handles (src/debug/matchKnobs.ts). */
  readonly feel = { power: 1, durability: 1, knockMul: 1 };
  readonly behaviour = null;
  /**
   * This match's pace (MatchConfig.pace, the Options row ROUND LENGTH; S11). The titans' pace scales the matter a blow takes;
   * the Mouth is not matter, so its jaw-ring health takes blows × pace / the Normal pace (core.paceMul) instead. Its own
   * blows go through the foe's `receive`, which applies the foe's pace.
   */
  get pace(): number {
    return this.paceV;
  }
  set pace(v: number) {
    this.paceV = v;
    this.core.paceMul = DMath.pow(v / ROUND_LENGTH_PACE.normal, ANALYTIC_PACE_EXP);
  }
  private paceV = ROUND_LENGTH_PACE.normal;
  private readonly rng: Rng;
  private readonly out: MouthStepOut = { impact: null, coiling: false, ended: false };

  /* ---- per tick ---- */
  private events: SimEvent[] = [];
  private foe: Fighter | null = null;
  private tickNo = 0;
  private live = false;
  ko = false;
  victory = false;
  private bufMove: MouthMoveName | null = null;
  private bufUntil = -1;
  private beatIndex = -1;
  private moveStartTick = 0;
  private beatStartTick = 0;
  private coilTicks = 0;
  private holding = false;

  /* ---- what the attacker reads back after a blow (FighterImpl.afterHit) ---- */
  lastBodyTouched = true;
  lastLandedWeight: BlowWeight = 'medium';
  lastOnDamaged = 0;
  lastDeltaW = 0;
  /** This fighter's blow description, read by the defender's `receive`. */
  readonly hitInfo: HitInfo = {
    knockX: 0,
    knockY: 0,
    guardPressure: 1,
    hitstopBase: 7,
    heavy: true,
    continuous: false,
    stunMul: 1,
    moveId: '',
  };
  private foeKoAnnounced = false;

  /* ---- scratch ---- */
  private readonly ev: DamageEvent;
  private readonly shape = { kind: 'point', x: 0, y: 0, r: 0 } as Extract<DamageShape, { kind: 'point' }>;
  private readonly ring = { kind: 'ring', x: 0, y: 0, r0: 0, r1: 0 } as Extract<
    DamageShape,
    { kind: 'ring' }
  >;
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
  private readonly threatPool: ThreatShape[] = [];
  private readonly back: RenderLayerMouth;
  private readonly front: RenderLayerMouth;
  private readonly layers: RenderLayer[] = [];
  private geomT = -1;
  private readonly bodyStats: BodyStats;

  constructor(opts: FighterOptions) {
    this.slot = opts.slot;
    this.def = opts.def;
    this.world = opts.world;
    this.arena = opts.arena;
    this.rng = new Rng((opts.seed ^ 0x6d0a7a1) >>> 0);
    this.core = new MouthCore({
      arena: opts.arena,
      boss: isMouthBossDef(opts.def),
      rand: () => this.rng.next(),
    });
    this.core.grabCheck = (x, y, r) => this.grabCheck(x, y, r);
    this.pace = opts.pace ?? PACE.damageTaken;
    // the stand-in body: one cell, parked far outside the arena, no debris impacts (the Mouth is analytic)
    const map = createMatterMap(4, 4);
    const i = 2 * 4 + 2;
    map.material[i] = 1;
    map.density[i] = 128;
    map.baseColor[i] = rgba(212, 94, 80);
    map.coreX = 2;
    map.coreY = 2;
    map.coreRadius = 1;
    this.body = opts.world.createBody({
      kind: 'titan',
      ownerSlot: opts.slot,
      map,
      materials: resolveMaterials(opts.def.materials),
      attributes: opts.def.attributes,
      seed: opts.seed,
      transform: { x: PARK, y: PARK, anchorX: 2, anchorY: 2, facing: 1, lean: 0 },
      takesDebrisImpacts: false,
    });
    this.ev = {
      type: 'CRUSH',
      shape: this.shape,
      energy: 0,
      dirX: 1,
      dirY: 0,
      duration: 1,
      sourceMass: 10,
      sourceBodyId: this.body.id,
      originX: 0,
      originY: 0,
      flags: 0,
      params: {},
    };
    for (let k = 0; k < 2; k++)
      this.threatPool.push({
        shape: { kind: 'point', x: 0, y: 0, r: 0 },
        type: 'CRUSH',
        energy: 0,
        ticksUntilLive: 0,
        ticksLive: 0,
        detached: false,
      });
    this.bodyStats = {
      mass: 100,
      initialMass: 100,
      massFrac: 1,
      cells: 1,
      initialCells: 1,
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
    this.back = makeLayer(`mouth-back-${opts.slot}`, 'screen', -1.5, 1, 1) as RenderLayerMouth;
    // Gate 3A §4: the foe is drawn between the coils (behind every titan layer) and the neck and head (over every titan layer,
    // still under the debris and effects at z ≥ 10)
    this.front = makeLayer(`mouth-front-${opts.slot}`, 'screen', 9, 1, 1) as RenderLayerMouth;
    this.back.mouth = { list: this.geom.list, back: true };
    this.front.mouth = { list: this.geom.list, back: false };
    this.view = this.makeView();
    this.core.place(this.startS(opts.x));
    this.syncView();
  }

  /** Round start: the anchor on the bottom edge under the slot's start mark (both fighters then begin in one frame). */
  private startS(x: number): number {
    const a = this.arena;
    return this.core.sAt(clamp(x, a.minX + 140, a.maxX - 140), a.maxY);
  }

  private makeView(): MouthFighterView {
    return {
      slot: this.slot,
      titan: this.def.id,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      facing: this.slot === 0 ? 1 : -1,
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
      bodyStats: this.bodyStats,
      integrityPct: 100,
      resource: 4,
      resourceMax: 4,
      meter: 0,
      ko: false,
      threats: [],
      parts: 4,
      lensRadius: 0,
      lensStrength: 0,
      freezeTicks: 0,
      body: this.body,
      mouth: {
        rings: [1, 1, 1, 1],
        chips: [0, 0, 0, 0],
        severed: 0,
        boss: this.core.boss,
        enraged: false,
        s: 0,
        per: 0,
        exitX: 0,
        exitY: 0,
        nx: 0,
        ny: 0,
        beat: 'watching',
        move: null,
        holding: false,
        reach: 0,
      },
    };
  }

  /* ================================================================================================ *
   *  TICK
   * ================================================================================================ */

  tick(ctx: FighterTickCtx): void {
    this.tickNo = ctx.tick;
    this.events = ctx.events;
    this.foe = ctx.foe;
    this.live = ctx.live;
    this.view.freezeTicks = 0;
    // the debug overlay's panel (after the match registered its own knobs, so their reset does not drop it)
    if (!this.knobsOn) {
      this.knobsOn = true;
      registerMouthKnobs(this);
    }
    const core = this.core;
    const inp = ctx.input;
    if (!this.ko && !this.victory) {
      core.slideIn = Math.abs(inp.moveX) > 0.2 ? clamp(inp.moveX, -1, 1) : 0;
      core.variant = inp.moveY < -0.5 ? -1 : inp.moveY > 0.5 ? 1 : 0;
      for (const [bit, mv] of STRIKE_BITS)
        if (inp.pressed & bit) {
          this.bufMove = mv;
          this.bufUntil = this.tickNo + MOUTH_LIVE.buffer;
        }
      if (this.live && this.bufMove && this.tickNo <= this.bufUntil && !core.move) {
        if (core.begin(this.bufMove)) this.onBegin(this.bufMove);
        this.bufMove = null;
      }
    } else {
      core.slideIn = 0;
    }
    const fv = ctx.foe.view;
    core.oppX = fv.x;
    core.oppY = fv.y;
    core.oppR = foeCoreRadius(fv);
    this.takeDebris();
    core.step(TICK_DT, this.out);
    this.afterStep();
    this.hurt.refresh(core);
    this.publishCapsules();
    this.syncView();
  }

  /** Hand the matter world this tick's capsules, so debris bounces off the Mouth (Gate 3A §2, D37). */
  private publishCapsules(): void {
    const h = this.hurt;
    const buf = this.capBuf;
    for (let i = 0; i < h.n; i++) {
      const c = h.caps[i]!;
      const o = i * 6;
      buf[o] = c.x0;
      buf[o + 1] = c.y0;
      buf[o + 2] = c.x1;
      buf[o + 3] = c.y1;
      buf[o + 4] = c.r;
      buf[o + 5] = c.part === 'head' ? 0 : c.part === 'neck' ? 1 : 2;
    }
    this.world.setCapsules?.(this.slot, buf, h.n);
  }

  /** Debris that struck the capsules since last tick (the world queued it): the prototype's damage per part. */
  private takeDebris(): void {
    const w = this.world;
    if (!w.drainCapsuleHits) return;
    const n = w.drainCapsuleHits(this.slot, this.debrisHits);
    if (n === 0 || this.ko) return;
    const H = this.debrisHits;
    // the spray of its own blow (the chunks a bite or crush just tore out of the foe, all round the head) does not wound it on
    // the way out (S11: against 우리, whose parts tear out whole, it took more from its own bites than from the foe); a
    // thrown chunk always counts
    const ownSpray = this.tickNo - this.lastDealtTick <= MOUTH_LIVE.ownSprayTicks;
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      if (ownSpray && H[o + 4] === 0) continue;
      const part = H[o + 3] === 0 ? 'head' : H[o + 3] === 1 ? 'neck' : 'coil';
      const power = Math.min(MOUTH_LIVE.powerMax, (H[o + 2]! / MOUTH_LIVE.eRef) * MOUTH_LIVE.debrisMul);
      if (power < 0.02) continue;
      this.core.hit(part, power, 0.5, 0);
      this.events.push({
        t: 'matter',
        kind: 'impact',
        x: H[o]!,
        y: H[o + 1]!,
        mass: H[o + 5]!,
        slot: this.slot,
      });
    }
    if (this.core.dmg.ko && !this.ko) this.enterKo();
  }
  private knobsOn = false;
  /** Tick of the last blow it landed (its own spray, `takeDebris`). */
  private lastDealtTick = -1e9;
  private readonly capBuf = new Float64Array(48 * 6);
  private readonly debrisHits: number[] = [];

  private onBegin(n: MouthMoveName): void {
    const slot = STRIKE_BITS.find((b) => b[1] === n)![2];
    this.moveStartTick = this.tickNo;
    this.beatStartTick = this.tickNo;
    this.beatIndex = 0;
    this.coilTicks = 0;
    this.events.push({
      t: 'move',
      slot: this.slot,
      titan: this.def.id,
      moveId: `mouth.${n}`,
      moveSlot: slot,
      aim: this.core.variant < 0 ? 'up' : this.core.variant > 0 ? 'down' : 'forward',
      x: this.core.hdX,
      y: this.core.hdY,
    });
    this.events.push({ t: 'feel', slot: this.slot, kind: 'accept', cmd: slot, ticks: 0 });
  }

  private afterStep(): void {
    const core = this.core;
    const out = this.out;
    const m = core.move;
    const b = core.beat();
    if (m && b.index !== this.beatIndex) {
      // the wind-up ends: the strike is thrown (audio, the camera's dolly)
      if (this.beatIndex === 0 && b.index > 0)
        this.events.push({
          t: 'release',
          slot: this.slot,
          titan: this.def.id,
          moveId: `mouth.${m.n}`,
          moveSlot: STRIKE_BITS.find((q) => q[1] === m.n)![2],
          x: core.hdX,
          y: core.hdY,
          power: 1,
        });
      this.beatIndex = b.index;
      this.beatStartTick = this.tickNo;
    }
    if (!m) this.beatIndex = -1;
    if (out.impact === 'bite') this.biteStrike();
    if (out.impact === 'crush' && m?.grabbed) this.crushStrike();
    // coil & crush: hold the foe through coil and crush; Surge early in the coil or a cut wrap breaks free
    const held = !!m && m.n === 'coil' && m.grabbed === true && (b.name === 'coil' || b.name === 'crush');
    if (held && !this.holding)
      this.events.push({
        t: 'cue',
        slot: this.slot,
        titan: this.def.id,
        id: 'grab',
        x: m.tgX,
        y: m.tgY,
        amount: 1,
      });
    this.holding = held;
    if (held) this.hold(b.name, b.u);
    if (out.coiling && held) {
      if (this.coilTicks++ % MOUTH_LIVE.coilEvery === 0) this.coilStrike();
    }
  }

  private hold(beat: string, u: number): void {
    const m = this.core.move!;
    const foe = this.foe as unknown as {
      px?: number;
      py?: number;
      vx?: number;
      vy?: number;
      applyStatus?: (mul: number, ticks: number) => void;
      view: FighterView;
    };
    // escapes (§3): a Surge in the first 0.35 s of the coil beat; enough damage on the wrapped third of the neck
    const coilDur = MOUTH_MOVES.coil[1][1];
    const surge = foe.view.state === 'surge' && beat === 'coil' && u * coilDur <= MOUTH_LIVE.surgeEscape;
    if (surge || m.wrapDmg >= MOUTH_LIVE.wrapEscape) {
      this.core.release();
      this.holding = false;
      this.events.push({
        t: 'cue',
        slot: this.slot,
        titan: this.def.id,
        id: 'escape',
        x: m.tgX,
        y: m.tgY,
        amount: surge ? 1 : 2,
      });
      return;
    }
    // held: the root is drawn to the coil centre (critically damped, ≈ 2 Hz) and its footwork is damped
    if (typeof foe.px === 'number' && typeof foe.py === 'number') {
      const k = 1 - DMath.exp(-TICK_DT * MOUTH_LIVE.holdRate);
      foe.px += (m.tgX - foe.px) * k;
      foe.py += (m.tgY - foe.py) * k;
      if (typeof foe.vx === 'number') foe.vx *= 0.6;
      if (typeof foe.vy === 'number') foe.vy *= 0.6;
    }
    foe.applyStatus?.(0.12, 2);
  }

  /** Coil & crush, end of the reach beat: does the grab circle at the locked target overlap the foe's live bounds? */
  private grabCheck(x: number, y: number, r: number): boolean {
    const fv = this.foe?.view;
    if (!fv || fv.ko || fv.intangible || !this.live) return false;
    const cx = clamp(x, fv.boundsX0, fv.boundsX1);
    const cy = clamp(y, fv.boundsY0, fv.boundsY1);
    return DMath.hypot(x - cx, y - cy) <= r;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  blows dealt
   * ---------------------------------------------------------------------------------------------- */

  private rageMul(): number {
    return this.core.enraged() ? MOUTH_BOSS.enrage.power : 1;
  }

  /** The bite (and the sweep's bite): a point CRUSH at the mouth, r = the lip ring (heavy). A miss still shakes the air. */
  private biteStrike(): void {
    const core = this.core;
    const n = core.move?.n ?? 'bite';
    const s = this.shape;
    s.x = core.hdX;
    s.y = core.hdY;
    s.r = MOUTH_LIVE.biteR;
    const I = core.I;
    let dx = core.hdX - I.Xx;
    let dy = core.hdY - I.Xy;
    const l = DMath.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const energy = (n === 'sweep' ? MOUTH_LIVE.sweepEnergy : MOUTH_LIVE.biteEnergy) * this.rageMul();
    const hit = this.deliver(s, energy, dx, dy, 620, 'heavy', `mouth.${n}`, {
      crater: 16,
      compress: 10,
      penetration: 14,
      scatter: 1.2,
    });
    if (!hit) {
      // the bite closes on nothing: the prototype's impact still lands (hit-stop and shake belong to a real hit)
      this.events.push({ t: 'shake', dirX: dx, dirY: dy, amp: BLOW_SHAKE_PX.medium * 0.5 });
      this.events.push({ t: 'shockwave', x: core.hdX, y: core.hdY, strength: 0.25, radius: 90, hue: 0.02 });
    }
  }

  private crushStrike(): void {
    const m = this.core.move!;
    const r = this.ring;
    const fr = m.foeR;
    r.x = m.tgX;
    r.y = m.tgY;
    r.r0 = Math.max(4, fr - 14);
    r.r1 = fr + 14;
    // a grab: the coils close round the core, so Guard does not stop the crush (the escapes are a Surge early in the coil or
    // cutting the wrapped neck, S11)
    this.deliver(
      r,
      MOUTH_LIVE.crushEnergy * this.rageMul(),
      0,
      -1,
      0,
      'heavy',
      'mouth.coil',
      { crater: 12, compress: 14, scatter: 1.1 },
      DamageFlag.UNBLOCKABLE,
    );
  }

  private coilStrike(): void {
    const m = this.core.move!;
    const r = this.ring;
    const fr = m.foeR;
    r.x = m.tgX;
    r.y = m.tgY;
    r.r0 = Math.max(4, fr - 10);
    r.r1 = fr + 10;
    this.deliver(
      r,
      MOUTH_LIVE.coilEnergy * this.rageMul(),
      0,
      -1,
      0,
      'light',
      'mouth.coil',
      { crater: 4, compress: 5 },
      DamageFlag.UNBLOCKABLE,
    );
  }

  /** Probe the foe and hand it the blow (the FighterImpl.strike / afterHit path, minus the matter body). */
  private deliver(
    shape: DamageShape,
    energy: number,
    dirX: number,
    dirY: number,
    knock: number,
    weight: BlowWeight,
    moveId: string,
    params: DamageEvent['params'],
    flags = 0,
  ): boolean {
    const foe = this.foe;
    if (!foe || !this.live) return false;
    const fv = foe.view;
    if (fv.intangible || fv.ko) return false;
    const ov = foe.probe(shape, this.ovTmp);
    if (ov.cells <= 0) return false;
    const e = this.ev;
    e.type = 'CRUSH';
    e.shape = shape;
    e.energy = energy * this.feel.power;
    e.dirX = dirX;
    e.dirY = dirY;
    e.duration = 1;
    e.sourceMass = this.stats.mass;
    e.sourceBodyId = -1;
    e.originX = this.core.hdX;
    e.originY = this.core.hdY;
    e.flags = (fv.integrityPct < 24 ? DamageFlag.FINISHER : 0) | flags;
    e.params = params;
    e.weight = weight;
    const info = this.hitInfo;
    info.knockX = dirX * knock;
    info.knockY = dirY * knock;
    info.guardPressure = weight === 'heavy' ? 1 : 0.3;
    info.hitstopBase = 7;
    info.heavy = weight === 'heavy';
    info.continuous = false;
    info.stunMul = weight === 'heavy' ? 1 : 0.4;
    info.moveId = moveId;
    const res = foe.receive(e, this, this.events);
    if (!res.connected) return false;
    this.lastDealtTick = this.tickNo;
    this.afterHit(res, e, info, weight);
    return true;
  }

  private afterHit(res: HitResult, e: DamageEvent, info: HitInfo, weight0: BlowWeight): void {
    const foe = this.foe!;
    const fv = foe.view;
    const ev = this.events;
    const graze = (foe as unknown as { lastBodyTouched?: boolean }).lastBodyTouched === false;
    const koBlow = fv.ko && !this.foeKoAnnounced;
    const weight: BlowWeight = koBlow
      ? 'catastrophic'
      : ((foe as unknown as { lastLandedWeight?: BlowWeight }).lastLandedWeight ?? weight0);
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
      weight,
    });
    if (res.hitstop > 0) ev.push({ t: 'hitstop', ticks: res.hitstop });
    ev.push({
      t: 'shake',
      dirX: e.dirX,
      dirY: e.dirY,
      amp: graze ? BLOW_SHAKE_PX[weight] * 0.4 : BLOW_SHAKE_PX[weight],
    });
    if (info.heavy && !graze) {
      ev.push({ t: 'zoom', amount: clamp(e.energy / 40000, 0.008, 0.05) });
      ev.push({
        t: 'shockwave',
        x: res.x,
        y: res.y,
        strength: clamp(e.energy / 3200, 0.15, 1),
        radius: 50 + e.energy * 0.09,
        hue: 0.02,
      });
      ev.push({
        t: 'rumble',
        slot: this.slot,
        strong: clamp(e.energy / 2400, 0.05, 0.6),
        weak: 0.2,
        ms: 160,
      });
      ev.push({ t: 'rumble', slot: foe.slot, strong: clamp(e.energy / 1300, 0.1, 1), weak: 0.5, ms: 260 });
    }
    if (koBlow) {
      this.foeKoAnnounced = true;
      ev.push({ t: 'timescale', scale: 0.3, ticks: 40 });
      ev.push({ t: 'flash', amount: 0.7, x: res.x, y: res.y });
      ev.push({ t: 'hitstop', ticks: BLOW_HITSTOP_TICKS.catastrophic });
      ev.push({ t: 'shake', dirX: e.dirX, dirY: e.dirY, amp: BLOW_SHAKE_PX.catastrophic });
      ev.push({ t: 'shockwave', x: res.x, y: res.y, strength: 1, radius: 240, hue: 0.02 });
      ev.push({ t: 'zoom', amount: 0.05 });
    }
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  blows taken
   * ---------------------------------------------------------------------------------------------- */

  probe(shape: DamageShape, out?: OverlapResult): OverlapResult {
    const r = out ?? this.probeOut;
    if (this.ko) {
      r.cells = 0;
      r.x = r.y = r.nearestX = r.nearestY = NaN;
      r.coverage = 0;
      return r;
    }
    return this.hurt.probe(shape, r);
  }

  receive(ev: DamageEvent, attacker: Fighter, events: SimEvent[]): HitResult {
    this.events = events;
    const res = this.hitRes;
    res.blocked = 0;
    res.cellsRemoved = 0;
    res.massRemoved = 0;
    res.connected = false;
    res.hitstop = 0;
    res.x = NaN;
    res.y = NaN;
    this.lastBodyTouched = true;
    this.lastOnDamaged = 0;
    this.lastDeltaW = 0;
    if (this.ko) return res;
    const ov = this.hurt.probe(ev.shape, this.ovTmp);
    if (ov.cells <= 0) return res;
    const h = this.hurt.hit;
    const core = this.core;
    const ringsBefore = [0, 1, 2, 3].map((g) => core.ringHealth(g) > 0);
    const severBefore = core.dmg.severF.filter((f) => f < 1).length;
    const continuous = (ev.flags & DamageFlag.CONTINUOUS) !== 0;
    const energy = ev.energy / Math.max(0.05, this.feel.durability);
    const power = clamp(
      (energy / MOUTH_LIVE.eRef) * (continuous ? MOUTH_LIVE.continuousMul : 1),
      0,
      MOUTH_LIVE.powerMax,
    );
    const lost = core.hit(h.part, power, h.at, h.at);
    // the anchor never moves; the head takes the blow as a kick into its spring (the neck absorbs it)
    const info = (attacker as unknown as { hitInfo?: HitInfo }).hitInfo;
    const kx = info ? info.knockX : ev.dirX * 300;
    const ky = info ? info.knockY : ev.dirY * 300;
    const am = Math.max(0.5, attacker.view.stats.mass);
    const kk = MOUTH_LIVE.headKick * this.feel.knockMul * clamp(am / 6, 0.4, 1.6) * (continuous ? 0.1 : 1);
    if (h.part !== 'coil') core.kick(kx * kk, ky * kk);
    const landed: BlowWeight = ev.weight ?? 'medium';
    this.lastLandedWeight = landed;
    res.connected = true;
    res.x = h.x;
    res.y = h.y;
    res.cellsRemoved = Math.round(lost * 8);
    res.massRemoved = lost;
    res.hitstop = continuous ? 0 : BLOW_HITSTOP_TICKS[landed];
    // cues: a jaw-ring breaks, a strand is cut
    for (let g = 0; g < 4; g++)
      if (ringsBefore[g] && core.ringHealth(g) <= 0)
        events.push({
          t: 'cue',
          slot: this.slot,
          titan: this.def.id,
          id: 'ring-break',
          x: core.hdX,
          y: core.hdY,
          amount: g,
        });
    if (core.dmg.severF.filter((f) => f < 1).length > severBefore)
      events.push({
        t: 'cue',
        slot: this.slot,
        titan: this.def.id,
        id: 'strand-sever',
        x: h.x,
        y: h.y,
        amount: 1,
      });
    if (core.dmg.ko && !this.ko) this.enterKo();
    this.hurt.refresh(core);
    this.publishCapsules();
    this.syncView();
    return res;
  }

  private enterKo(): void {
    this.ko = true;
    this.holding = false;
    this.view.ko = true;
    this.view.state = 'ko';
    this.events.push({ t: 'ko', slot: this.slot, x: this.core.hdX, y: this.core.hdY });
  }

  freeze(ticks: number): void {
    this.view.freezeTicks = ticks;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  view
   * ---------------------------------------------------------------------------------------------- */

  private syncView(): void {
    const v = this.view;
    const core = this.core;
    v.x = core.hdX;
    v.y = core.hdY;
    v.vx = core.hdVx;
    v.vy = core.hdVy;
    const fx = this.foe?.view.x ?? core.hdX + 1;
    v.facing = fx >= core.hdX ? 1 : -1;
    // live bounds (§1): the head with its jaw-rings, the neck, and the anchor's edge and exit — not the whole coil bundle,
    // which runs off past the frame by design — so the camera keeps the anchored edge in view
    const I = core.I;
    let x0 = Math.min(core.hdX - 75, I.E.px, I.Xx - 30);
    let y0 = Math.min(core.hdY - 75, I.E.py, I.Xy - 30);
    let x1 = Math.max(core.hdX + 75, I.E.px, I.Xx + 30);
    let y1 = Math.max(core.hdY + 75, I.E.py, I.Xy + 30);
    const nk = core.neck;
    for (let i = 0; i < C.neckSamples; i += 3) {
      const x = nk[i * 4]!;
      const y = nk[i * 4 + 1]!;
      if (x - 28 < x0) x0 = x - 28;
      if (y - 28 < y0) y0 = y - 28;
      if (x + 28 > x1) x1 = x + 28;
      if (y + 28 > y1) y1 = y + 28;
    }
    const a = this.arena;
    v.boundsX0 = Math.max(a.minX, x0);
    v.boundsY0 = Math.max(a.minY, y0);
    v.boundsX1 = Math.min(a.maxX, x1);
    v.boundsY1 = Math.min(a.maxY, y1);
    const b = core.beat();
    const m = core.move;
    if (this.ko) v.state = 'ko';
    else if (this.victory) v.state = 'victory';
    else if (!this.live) v.state = this.tickNo < 2 ? 'intro' : 'idle';
    else if (!m) v.state = Math.abs(core.sv) > 20 ? 'move' : 'idle';
    else
      v.state =
        b.index === 0 ? 'startup' : b.name === 'recover' || b.name === 'release' ? 'recovery' : 'active';
    if (m) {
      const slot = STRIKE_BITS.find((q) => q[1] === m.n)![2];
      const sec = core.moveSeconds(m.n, m.v);
      v.moveId = `mouth.${m.n}`;
      v.moveSlot = slot;
      v.aim = m.v < 0 ? 'up' : m.v > 0 ? 'down' : 'forward';
      v.phase = b.index === 0 ? 'startup' : v.state === 'recovery' ? 'recovery' : 'active';
      v.moveTick = this.tickNo - this.moveStartTick;
      v.phaseTick = this.tickNo - this.beatStartTick;
      v.moveTotal = Math.round((sec.startup + sec.active + sec.recovery) * 60);
    } else {
      v.moveId = null;
      v.moveSlot = null;
      v.aim = null;
      v.phase = null;
      v.moveTick = 0;
      v.phaseTick = 0;
      v.moveTotal = 0;
    }
    const D = core.dmg;
    v.integrityPct = Math.max(0, Math.min(100, (D.hp / D.hpMax) * 100));
    this.bodyStats.massFrac = D.hp / D.hpMax;
    this.bodyStats.coreIntegrity = D.hp / D.hpMax;
    const mx = v.mouth;
    let rings = 0;
    for (let g = 0; g < 4; g++) {
      mx.rings[g] = core.ringHealth(g);
      mx.chips[g] = D.ringGaps[g]!.length;
      if (mx.rings[g]! > 0) rings++;
    }
    v.resource = rings;
    v.parts = rings;
    mx.severed = D.severF.filter((f) => f < 1).length;
    mx.enraged = core.enraged();
    mx.s = core.s;
    mx.per = core.per;
    mx.exitX = I.Xx;
    mx.exitY = I.Xy;
    mx.nx = I.E.nx;
    mx.ny = I.E.ny;
    mx.beat = b.name;
    mx.move = m?.n ?? null;
    mx.holding = this.holding;
    mx.reach = Math.min(C.maxReach * 0.9, 640 - MOUTH_LIVE.safeStrip - C.exitInset);
    // threats (the AI's telegraphs): the locked strike point while the wind-up runs
    v.threats.length = 0;
    if (m && (b.index === 0 || b.name === 'strike' || b.name === 'sweep') && m.n !== 'coil') {
      const th = this.threatPool[0]!;
      const sh = th.shape as Extract<DamageShape, { kind: 'point' }>;
      const path = m.path;
      sh.x = path ? path[4] : m.tgX;
      sh.y = path ? path[5] : m.tgY;
      sh.r = MOUTH_LIVE.biteR;
      th.energy = MOUTH_LIVE.biteEnergy;
      const sec = core.moveSeconds(m.n, m.v);
      th.ticksUntilLive = Math.max(0, Math.round(sec.startup * 60) + (b.index === 0 ? 9 : 0) - v.moveTick);
      th.ticksLive = 10;
      v.threats.push(th);
    } else if (m && m.n === 'coil' && b.index === 0) {
      const th = this.threatPool[1]!;
      const sh = th.shape as Extract<DamageShape, { kind: 'point' }>;
      sh.x = m.tgX;
      sh.y = m.tgY;
      sh.r = MOUTH_LIVE.grabR;
      th.energy = MOUTH_LIVE.crushEnergy;
      th.ticksUntilLive = Math.max(0, 22 - v.moveTick);
      th.ticksLive = 66;
      v.threats.push(th);
    }
    v.ko = this.ko;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  presentation
   * ---------------------------------------------------------------------------------------------- */

  renderLayers(_view: ViewRect, _alpha: number): RenderLayer[] {
    if (this.geomT !== this.core.t) {
      this.geom.build(this.core, MOUTH_LOOK);
      this.geomT = this.core.t;
    }
    this.layers.length = 0;
    this.layers.push(this.back, this.front);
    return this.layers;
  }

  debugShapes(out: DebugShape[]): void {
    const h = this.hurt;
    for (let i = 0; i < h.n; i++) {
      const c = h.caps[i]!;
      out.push({
        shape: { kind: 'line', x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, width: c.r * 2 },
        color:
          c.part === 'head'
            ? rgba(255, 220, 120, 120)
            : c.part === 'neck'
              ? rgba(255, 120, 120, 90)
              : rgba(140, 120, 220, 70),
        label: i === 0 ? 'MOUTH' : undefined,
      });
    }
    for (const t of this.view.threats)
      out.push({ shape: t.shape, color: rgba(255, 90, 70, 140), label: 'BITE' });
  }

  nextRound(x: number, _y: number, _facing: 1 | -1, healFraction: number, _seed: number): void {
    const core = this.core;
    core.heal(healFraction);
    core.place(this.startS(x));
    this.ko = false;
    this.victory = false;
    this.holding = false;
    this.bufMove = null;
    this.beatIndex = -1;
    this.foeKoAnnounced = false;
    this.view.ko = false;
    this.view.state = 'intro';
    this.hurt.refresh(core);
    this.publishCapsules();
    this.syncView();
  }

  setVictory(): void {
    this.victory = true;
    this.view.state = 'victory';
  }

  moveById(id: string): MoveDef | undefined {
    return this.def.moves.find((m) => m.id === id);
  }

  stateHash(h: number): number {
    return this.core.hash(h);
  }
}

/** Radius of a foe's core for the wrap (§3): the carapace / torso of a big titan, the whole body of a small one. */
export function foeCoreRadius(v: FighterView): number {
  const hw = (v.boundsX1 - v.boundsX0) / 2;
  const hh = (v.boundsY1 - v.boundsY0) / 2;
  return clamp(Math.min(hw, hh) * 0.62, 30, 80);
}
