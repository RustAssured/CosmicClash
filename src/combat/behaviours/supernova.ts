import {
  DamageFlag,
  clamp,
  clamp01,
  hex,
  localToWorld,
  smoothstep,
  type DamageEvent,
  type DamageShape,
  type DebugShape,
  type EffectiveStats,
  type FighterTickCtx,
  type MoveDef,
  type RenderLayer,
  type ViewRect,
} from '@/contracts';
import { supernovaGranules, type SupernovaGranules } from '@/titans/art/supernova';
import type { SupernovaRig } from '@/titans';
import { Behaviour, type HitInfo, type InterceptResult } from '../behaviour';
import type { FighterImpl } from '../fighter';
import { BodyOverlay } from '../fx/bodyOverlay';
import { GlowSprite } from '../fx/glowSprite';
import { flameColumn, glowD, plasmaBall, rampAt, rampDither, ribbon, ringBand, streak, tn } from '../fx/lib';
import { Overlay } from '../fx/overlay';
import type { ActiveMove } from '../move';
import { asShape, makeFatShape, shapeIntersectsDisc } from '../shapes';

/* ---- fuel economy -------------------------------------------------------------------------------------------------------- */
/** Fraction of the star's initial mass that burns away per fuel point spent: spending all 100 fuel shrinks it by over a third. */
const SHED_PER_FUEL = 0.006;
/** Burning never takes the star below this mass fraction (the remnant), so spending fuel cannot kill it. */
const SHED_FLOOR = 0.3;
/** The debt of burnt mass is paid to the matter world in lumps: `world.shed` scans the whole map. */
const SHED_LUMP = 0.012;
/** Quiet ticks (no move started, nothing landed, nothing taken) before the star cools and regains fuel, and the rate. */
const COOL_AFTER = 100;
const COOL_PER_TICK = 1.6 / 60;
/** Fuel regained per unit of THERMAL/KINETIC energy the star absorbs, and the most one blow can give. */
const ABSORB_GAIN = 0.006;
const ABSORB_MAX = 4;

/* ---- passives / failure mode ------------------------------------------------------------------------------------------------ */
/** Radiance: the aura is applied every few ticks; its heat (temperature units per cell at full weight) grows with fuel. */
const AURA_EVERY = 3;
const AURA_RADIUS = 96;
/** Exposed core: extra damage to the core per unit of exposure when a blow reaches it. */
const EXPOSURE_GAIN = 1.5;
/** Mass fractions at which the outer layers blow off in a sheet (once each per round), and how much mass each takes. */
const LAYER_BLOWS = [0.78, 0.6, 0.45];
const LAYER_BLOW_MASS = 0.045;

/** Length of the Solar Wind smear memory, in ticks. */
const TRAIL = 20;

const SIN = new Float32Array(256);
for (let i = 0; i < 256; i++) SIN[i] = Math.sin((i / 256) * Math.PI * 2);

interface WallCfg {
  half: number;
  width: number;
  life: number;
  every: number;
  energy: number;
}

interface Arc {
  /** Period, offset (ticks), base limb angle, footpoint half-separation (rad), height (px). */
  period: number;
  offset: number;
  angle: number;
  sep: number;
  h: number;
}

/**
 * THE SUPERNOVA. Fuel is the resource and the clock of the fight: moves burn it (the star shrinks as it burns), a quiet star
 * cools and regains a little, blows of heat and force it absorbs are turned into fuel (Radiance). At zero fuel it collapses
 * into one desperate final nova and fights on as a dim remnant. Heavy damage blows the outer layers off in sheets and exposes
 * the core, which then takes far more damage. Everything the player sees on the star itself is drawn here: the granulation
 * churning on the map cells, the pulsing core, prominence arcs launching and falling back, the coronal glow, fireballs, the
 * wall of fire, the collapse and the nova ring.
 */
export class SupernovaBehaviour extends Behaviour {
  private rig!: SupernovaRig;
  private gran!: SupernovaGranules;
  private shimmer!: BodyOverlay;
  private halo!: GlowSprite;
  private prom!: Overlay;
  private fx!: Overlay;
  private flame: number[] = [];
  private ember: number[] = [];
  private collapseDef: MoveDef | undefined;
  private wallCfg: WallCfg = { half: 50, width: 16, life: 54, every: 4, energy: 30 };

  /* fuel */
  private debt = 0;
  private lastAct = 0;
  private lastTick = -1;
  private hurt = 0;
  /* failure mode + collapse */
  private blows = 0;
  private collapsed = false;
  private remnant = false;
  private novaDone = false;
  /* wall of fire */
  private wallLife = 0;
  private wallStart = 0;
  private wallX = 0;
  private wallY = 0;
  private wallPower = 1;
  private wallLastHit = -99;
  /* fireball */
  private fbX = 0;
  private fbY = 0;
  private fbR = 0;
  private fbHit = false;
  private fbHitTick = -99;
  private fbLive = false;
  /* surge trail (ring buffer of recent star positions) */
  private readonly trail = new Float32Array(TRAIL * 2);
  private trailN = 0;
  private trailHead = 0;
  /* per-frame draw state */
  private haloA = 0;
  private readonly arcs: Arc[] = [
    { period: 331, offset: 40, angle: -0.34, sep: 0.2, h: 34 },
    { period: 397, offset: 190, angle: 1.5, sep: 0.17, h: 28 },
    { period: 359, offset: 275, angle: -2.05, sep: 0.19, h: 31 },
  ];
  private readonly tmp = makeFatShape();
  private readonly xy = { x: 0, y: 0 };
  private readonly dmg = {
    type: 'THERMAL' as const,
    energy: 0,
    duration: 1,
    flags: DamageFlag.CONTINUOUS as number,
    params: { shock: 0.25, scatter: 0.6 } as DamageEvent['params'],
  };
  private readonly auraEv: DamageEvent;
  private readonly auraShape = makeFatShape();
  private readonly extraEv: DamageEvent;
  private readonly extraShape = makeFatShape();
  private readonly wallShape = makeFatShape();

  constructor(f: FighterImpl) {
    super(f);
    this.auraEv = {
      type: 'THERMAL',
      shape: asShape(this.auraShape),
      energy: 4,
      dirX: 1,
      dirY: 0,
      duration: 1,
      sourceMass: 5,
      sourceBodyId: -1,
      originX: 0,
      originY: 0,
      flags: DamageFlag.CONTINUOUS,
      params: { heat: 6, scatter: 0.2 },
    };
    this.extraEv = {
      type: 'THERMAL',
      shape: asShape(this.extraShape),
      energy: 0,
      dirX: 1,
      dirY: 0,
      duration: 1,
      sourceMass: 5,
      sourceBodyId: -1,
      originX: 0,
      originY: 0,
      flags: 0,
      params: { scatter: 1 },
    };
  }

  override attach(): void {
    const f = this.f;
    this.rig = f.rig as SupernovaRig;
    this.gran = supernovaGranules(f.def, f.seed);
    const ramp = (key: string): number[] => f.def.materials.find((m) => m.key === key)!.visual.ramp.map(hex);
    const prom = ramp('prominence');
    this.flame = [...prom, 0xfffffff0 >>> 0];
    this.flame[this.flame.length - 1] = hex('#ffffff');
    this.ember = [hex('#ffe27a'), hex('#ffae38'), hex('#f0621f'), hex('#7c1d33')];
    const map = f.body.map;
    this.shimmer = new BodyOverlay('supernova-shimmer', 0.2, map.w, map.h, 'add', true);
    this.halo = new GlowSprite('supernova-halo', -0.5, 132, [120, 60, 26], 0.22);
    this.prom = new Overlay('supernova-prom', 0.4, 400, 360, 'normal', true);
    this.fx = new Overlay('supernova-fx', 20, 800, 560, 'add', true);
    this.collapseDef = f.movesById.get('supernova.collapse');
    const wall = f.slotMoves.signature?.extra?.['wall'] as WallCfg | undefined;
    if (wall) this.wallCfg = wall;
    f.resourceMax = f.def.resource.max;
    f.resource = f.def.resource.start;
  }

  override reset(_heal: number): void {
    const f = this.f;
    f.resource = f.resourceMax;
    this.debt = 0;
    this.blows = 0;
    this.collapsed = false;
    this.remnant = false;
    this.novaDone = false;
    this.wallLife = 0;
    this.fbLive = false;
    this.fbHit = false;
    this.hurt = 0;
    this.trailN = 0;
    this.lastAct = f.tickNo;
  }

  /** Test/AI access. */
  get fuel(): number {
    return this.f.resource;
  }
  get isRemnant(): boolean {
    return this.remnant;
  }
  get hasCollapsed(): boolean {
    return this.collapsed;
  }
  get wallActive(): boolean {
    return this.wallLife > 0;
  }
  get layerBlows(): number {
    return this.blows;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  fuel and stats
   * ---------------------------------------------------------------------------------------------- */

  private fuelFrac(): number {
    return this.f.resource / Math.max(1, this.f.resourceMax);
  }

  /** A star running on fumes hits softer (a dim remnant softer still): the fuel is what makes its heat, the mass what makes its weight. */
  override adjustStats(s: EffectiveStats, _massFrac: number): void {
    const k = this.fuelFrac();
    s.damageMul *= 0.62 + 0.38 * Math.pow(k, 0.7);
    if (this.remnant) s.damageMul *= 0.85;
  }

  /** Burn `amount` fuel: the HUD bar drops and the star shrinks (the debt is paid to the matter world in lumps). */
  private spend(amount: number, x: number, y: number): number {
    const f = this.f;
    const spent = Math.min(f.resource, amount);
    if (spent <= 0) return 0;
    f.resource -= spent;
    this.debt += spent * SHED_PER_FUEL;
    f.events.push({ t: 'resource', slot: f.slot, kind: 'spend', amount: spent });
    if (spent >= 6)
      f.events.push({
        t: 'cue',
        slot: f.slot,
        titan: f.def.id,
        id: 'fuel-burn',
        x,
        y,
        amount: clamp01(spent / 40),
      });
    return spent;
  }

  private payDebt(force: boolean): void {
    const f = this.f;
    if (this.debt < SHED_LUMP && !(force && this.debt > 0.002)) return;
    const bs = f.view.bodyStats;
    // only burn while there is a star to burn: never below the remnant floor
    if (bs.massFrac > SHED_FLOOR) {
      const mass = Math.min(this.debt, bs.massFrac - SHED_FLOOR) * bs.initialMass;
      if (mass > 0) f.world.shed(f.body.id, mass, 'burn');
    }
    this.debt = 0;
  }

  override onDamaged(_energy: number, _dx: number, _dy: number): void {
    this.lastAct = this.f.tickNo;
    this.hurt = 1;
  }

  override onDealt(_energy: number): void {
    this.lastAct = this.f.tickNo;
  }

  override onMoveStart(m: ActiveMove): void {
    const f = this.f;
    this.lastAct = f.tickNo;
    if (m.def?.slot === 'surge') {
      this.trailN = 0;
      this.trailHead = 0;
    }
  }

  override onRelease(m: ActiveMove): void {
    const f = this.f;
    const def = m.def;
    if (!def) return;
    const fuel = (def.extra?.['fuel'] as number | undefined) ?? 0;
    const cx = f.body.transform.x;
    const cy = f.body.transform.y;
    switch (def.id) {
      case 'supernova.prominence': {
        this.spend(fuel * (1 + 0.5 * (m.chargeMax > 0 ? m.chargeTicks / m.chargeMax : 0)), cx, cy);
        this.armWall(m);
        break;
      }
      case 'supernova.nova': {
        this.spend(Math.min(f.resource, fuel), cx, cy);
        this.detonate(false);
        break;
      }
      case 'supernova.collapse': {
        this.detonate(true);
        break;
      }
      case 'supernova.ejection': {
        this.spend(fuel, cx, cy);
        this.fbLive = true;
        this.fbHit = false;
        break;
      }
      default:
        this.spend(fuel, cx, cy);
    }
  }

  override onMoveEnd(m: ActiveMove, _interrupted: boolean): void {
    const id = m.def?.id;
    if (id === 'supernova.collapse') this.remnant = true;
    if (id === 'supernova.ejection') this.fbLive = false;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  the wall of fire
   * ---------------------------------------------------------------------------------------------- */

  /** The arc that just took off lands where its hitbox ends: leave a wall of fire standing there. */
  private armWall(m: ActiveMove): void {
    const f = this.f;
    const hbs = m.variant?.hitboxes;
    if (!hbs || hbs.length === 0) return;
    if (!f.liveHitShape(0, hbs[0]!.to - 1, this.tmp)) return;
    this.wallX = this.tmp.x;
    this.wallY = this.tmp.y;
    this.wallStart = f.tickNo + hbs[0]!.to;
    this.wallLife = this.wallCfg.life + hbs[0]!.to;
    this.wallPower = m.power;
    this.wallLastHit = -99;
  }

  override resolveVolumes(ctx: FighterTickCtx): void {
    const f = this.f;
    if (f.ko || !ctx.live) return;
    const tick = ctx.tick;
    // ---- the wall ----
    if (this.wallLife > 0) {
      this.wallLife--;
      if (tick >= this.wallStart) {
        const c = this.wallCfg;
        const sh = this.wallShape;
        sh.kind = 'line';
        sh.x0 = this.wallX;
        sh.x1 = this.wallX;
        sh.y0 = this.wallY - c.half;
        sh.y1 = this.wallY + c.half;
        sh.width = c.width;
        if (tick - this.wallLastHit >= c.every) {
          this.dmg.energy = c.energy;
          if (f.strike(sh, this.dmg, 0, -90, 0.15, 3, 'signature', 'supernova.prominence', this.wallPower))
            this.wallLastHit = tick;
        }
        f.addThreat(asShape(sh) as DamageShape, 'THERMAL', c.energy * 4, 0, Math.max(0, this.wallLife), true);
      }
    }
    // ---- Radiance: a faint thermal field around the star, stronger with fuel ----
    if ((tick + f.slot) % AURA_EVERY === 0 && f.resource > 0.5) this.aura();
  }

  private aura(): void {
    const f = this.f;
    const foe = f.foe;
    if (foe.view.intangible || foe.view.ko) return;
    const t = f.body.transform;
    const k = this.fuelFrac();
    const r = AURA_RADIUS * (0.7 + 0.5 * k) * (0.6 + 0.4 * f.view.bodyStats.massFrac);
    // cheap reject: the foe's box must come within the field
    const v = foe.view;
    if (v.boundsX1 < t.x - r || v.boundsX0 > t.x + r || v.boundsY1 < t.y - r || v.boundsY0 > t.y + r) return;
    const sh = this.auraShape;
    sh.kind = 'field';
    sh.x = t.x;
    sh.y = t.y;
    sh.r = r;
    sh.falloff = 1.5;
    const e = this.auraEv;
    e.energy = 4;
    e.params.heat = 4.5 + 8 * k;
    e.sourceMass = f.stats.mass;
    e.sourceBodyId = f.body.id;
    e.originX = t.x;
    e.originY = t.y;
    f.world.applyDamage(foe.body.id, e);
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  absorbing blows, the exposed core, layers blowing off
   * ---------------------------------------------------------------------------------------------- */

  override intercept(ev: DamageEvent, _info: HitInfo, res: InterceptResult): void {
    const f = this.f;
    // Radiance: heat and force that reach the star feed it
    if (ev.type === 'THERMAL' || ev.type === 'KINETIC') {
      const gain = Math.min(ABSORB_MAX, ev.energy * (1 - res.absorbed) * ABSORB_GAIN);
      if (gain > 0.05 && f.resource < f.resourceMax) {
        f.resource = Math.min(f.resourceMax, f.resource + gain);
        f.events.push({ t: 'resource', slot: f.slot, kind: 'gain', amount: gain });
      }
    }
    // the exposed core takes far more of whatever reaches it
    const exposure = f.view.bodyStats.exposedCoreFrac;
    if (exposure > 0.05) {
      const t = f.body.transform;
      localToWorld(t, this.rig.core.x + 0.5, this.rig.core.y + 0.5, this.xy);
      const cr = this.rig.core.r * 1.05;
      if (shapeIntersectsDisc(ev.shape, this.xy.x, this.xy.y, cr)) {
        const extra = ev.energy * (1 - res.absorbed) * exposure * EXPOSURE_GAIN;
        if (extra >= 1) {
          const e2 = this.extraEv;
          const sh = this.extraShape;
          sh.kind = 'point';
          sh.x = this.xy.x;
          sh.y = this.xy.y;
          sh.r = cr;
          e2.type = ev.type;
          e2.energy = extra;
          e2.dirX = ev.dirX;
          e2.dirY = ev.dirY;
          e2.sourceMass = ev.sourceMass;
          e2.sourceBodyId = ev.sourceBodyId;
          e2.originX = ev.originX;
          e2.originY = ev.originY;
          const r = f.world.applyDamage(f.body.id, e2);
          res.extraCells += r.cellsRemoved;
          res.extraMass += r.massRemoved;
          res.touched = true;
        }
      }
    }
  }

  /** Big sheets of the outer plasma blow off as the star is worn down: the failure mode's scripted beats. */
  private layerBlowCheck(): void {
    const f = this.f;
    const bs = f.view.bodyStats;
    for (let i = 0; i < LAYER_BLOWS.length; i++) {
      const bit = 1 << i;
      if (this.blows & bit || bs.massFrac > LAYER_BLOWS[i]!) continue;
      this.blows |= bit;
      const t = f.body.transform;
      f.world.shed(f.body.id, LAYER_BLOW_MASS * bs.initialMass, 'blow');
      f.events.push(
        {
          t: 'cue',
          slot: f.slot,
          titan: f.def.id,
          id: 'layer-blow',
          x: t.x,
          y: t.y,
          amount: 1 - LAYER_BLOWS[i]!,
        },
        { t: 'shake', dirX: -f.facing, dirY: -0.3, amp: 7 },
        { t: 'shockwave', x: t.x, y: t.y, strength: 0.55, radius: 190, hue: 0.07 },
        { t: 'flash', amount: 0.25 },
      );
      this.plasmaBurst(t.x, t.y, 46, 240);
      break;
    }
  }

  /** A burst of plasma and embers thrown outward from (x, y). */
  private plasmaBurst(x: number, y: number, count: number, speed: number): void {
    const f = this.f;
    const sp = f.particleSpawn;
    sp.kind = 'plasma';
    sp.x = x;
    sp.y = y;
    sp.vx = 0;
    sp.vy = 0;
    sp.spread = speed;
    sp.count = count;
    sp.ramp = this.flame.slice(1, 6).reverse();
    sp.life = [22, 60];
    sp.fieldScale = 0.3;
    sp.emissive = 230;
    sp.size = 2;
    sp.drag = 1.1;
    f.world.spawnParticles(sp);
    sp.kind = 'ember';
    sp.ramp = this.ember;
    sp.count = Math.round(count * 0.6);
    sp.size = 1;
    sp.spread = speed * 1.2;
    f.world.spawnParticles(sp);
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  nova and the final collapse
   * ---------------------------------------------------------------------------------------------- */

  /** The star detonates: the ring hitbox goes live this tick. Flash, shock, and the outer layers leave as a sheet of plasma. */
  private detonate(final: boolean): void {
    const f = this.f;
    const t = f.body.transform;
    const bs = f.view.bodyStats;
    const big = final ? 1.2 : 1;
    f.events.push(
      { t: 'flash', amount: final ? 1 : 0.85 },
      { t: 'shake', dirX: f.facing, dirY: 0, amp: 16 * big },
      { t: 'shockwave', x: t.x, y: t.y, strength: 1, radius: 380 * big, hue: 0.07 },
      { t: 'shockwave', x: t.x, y: t.y, strength: 0.6, radius: 240 * big, hue: 0.12 },
      { t: 'zoom', amount: 0.05 },
      { t: 'roll', radians: 0.02 * f.facing },
      { t: 'rumble', slot: f.slot, strong: 0.9, weak: 0.7, ms: 420 },
      { t: 'rumble', slot: f.foe.slot, strong: 1, weak: 0.9, ms: 480 },
      { t: 'cue', slot: f.slot, titan: f.def.id, id: 'layer-blow', x: t.x, y: t.y, amount: 1 },
    );
    // the outer layers are what goes: the corona and photosphere leave as a burst, the core is left burning
    const mass = (final ? 0.16 : 0.1) * bs.initialMass;
    f.world.shed(f.body.id, Math.min(mass, Math.max(0, bs.massFrac - 0.3) * bs.initialMass), 'blow');
    this.plasmaBurst(t.x, t.y, final ? 160 : 110, 330 * big);
    this.novaDone = true;
  }

  /** Fuel at zero: the star collapses into one last nova (once per round), whatever it was doing. */
  private maybeCollapse(): void {
    const f = this.f;
    if (this.collapsed || !this.collapseDef || f.ko || !f.live) return;
    if (f.resource > 0.01 || f.mv.def !== null) return;
    if (f.state === 'guardbreak') return;
    this.collapsed = true;
    f.hitstunTicks = 0;
    f.guardUp = false;
    const t = f.body.transform;
    f.events.push({ t: 'cue', slot: f.slot, titan: f.def.id, id: 'collapse', x: t.x, y: t.y, amount: 1 });
    f.events.push({ t: 'ultimate', slot: f.slot, titan: f.def.id, phase: 'start', x: t.x, y: t.y });
    f.startMove(this.collapseDef, 0, 'forward');
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  per tick
   * ---------------------------------------------------------------------------------------------- */

  override update(ctx: FighterTickCtx): void {
    const f = this.f;
    const tick = ctx.tick;
    const m = f.mv;
    const t = f.body.transform;
    this.hurt *= 0.9;

    if (f.live && !f.ko) {
      // a quiet star cools: fuel comes back slowly
      if (
        tick - this.lastAct > COOL_AFTER &&
        m.def === null &&
        f.state !== 'hitstun' &&
        f.resource < f.resourceMax &&
        !this.remnant
      )
        f.resource = Math.min(f.resourceMax, f.resource + COOL_PER_TICK);
      this.payDebt(tick - this.lastAct > 30);
      this.layerBlowCheck();
      this.maybeCollapse();
    }
    f.view.parts = this.blows === 0 ? 0 : this.blows;

    // the fireball follows its hitbox until it lands
    if (this.fbLive && m.def?.id === 'supernova.ejection' && m.phase === 'active') {
      if (m.hits > 0 && !this.fbHit) {
        this.fbHit = true;
        this.fbHitTick = tick;
      }
      if (!this.fbHit && f.liveHitShape(0, m.phaseTick - 1, this.tmp)) {
        this.fbX = this.tmp.x;
        this.fbY = this.tmp.y;
        this.fbR = this.tmp.r;
      }
    }
    // a short memory of where the star has been (Solar Wind smear)
    if (m.def?.slot === 'surge') {
      const i = this.trailHead % TRAIL;
      this.trail[i * 2] = t.x;
      this.trail[i * 2 + 1] = t.y;
      this.trailHead++;
      this.trailN = Math.min(TRAIL, this.trailN + 1);
      this.windParticles();
    } else if (this.trailN > 0 && (tick & 1) === 0) this.trailN--;
    this.lastTick = tick;

    this.chargeParticles();
    this.draw(tick, m);
  }

  private windParticles(): void {
    const f = this.f;
    const sp = f.particleSpawn;
    const speed = Math.hypot(f.vx, f.vy);
    if (speed < 90) return;
    sp.kind = 'plasma';
    sp.x = f.px;
    sp.y = f.py;
    sp.vx = -f.vx * 0.1;
    sp.vy = -f.vy * 0.1;
    sp.spread = 30;
    sp.count = 3;
    sp.ramp = this.flame.slice(1, 6).reverse();
    sp.life = [18, 44];
    sp.fieldScale = 0.3;
    sp.emissive = 220;
    sp.size = 2;
    sp.drag = 1.4;
    f.world.spawnParticles(sp);
    if ((f.tickNo & 1) === 0) {
      sp.kind = 'ember';
      sp.ramp = this.ember;
      sp.count = 2;
      sp.size = 1;
      sp.spread = 46;
      f.world.spawnParticles(sp);
    }
  }

  /** Gathering sparks drift into the star while it charges a Prominence. */
  private chargeParticles(): void {
    const f = this.f;
    const m = f.mv;
    if (m.def?.id !== 'supernova.prominence' || m.phase !== 'charge' || f.tickNo % 3 !== 0) return;
    const sp = f.particleSpawn;
    const a = (f.tickNo * 0.37) % 6.283;
    sp.kind = 'mote';
    sp.x = f.px + Math.cos(a) * 92;
    sp.y = f.py + Math.sin(a) * 92;
    sp.vx = -Math.cos(a) * 90;
    sp.vy = -Math.sin(a) * 90;
    sp.spread = 8;
    sp.count = 1;
    sp.ramp = this.ember;
    sp.life = [16, 26];
    sp.fieldScale = 0;
    sp.emissive = 240;
    sp.size = 1;
    sp.drag = 0.2;
    f.world.spawnParticles(sp);
  }

  override onKo(): void {
    const f = this.f;
    const t = f.body.transform;
    this.wallLife = 0;
    this.fbLive = false;
    // the star goes out the way stars do: the last of its outer layers leaves as a burst
    const bs = f.view.bodyStats;
    f.world.shed(f.body.id, Math.min(0.2, Math.max(0, bs.massFrac - 0.08)) * bs.initialMass, 'blow');
    this.plasmaBurst(t.x, t.y, 120, 300);
    f.events.push({ t: 'cue', slot: f.slot, titan: f.def.id, id: 'layer-blow', x: t.x, y: t.y, amount: 1 });
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  drawing
   * ---------------------------------------------------------------------------------------------- */

  private draw(tick: number, m: ActiveMove): void {
    const f = this.f;
    const k = this.fuelFrac();
    const massK = clamp01(f.view.bodyStats.massFrac);
    const dying = f.ko ? clamp01(1 - f.stateTicks / 70) : 1;
    const id = m.def?.id ?? '';
    // pulse of the whole star: a slow breath, faster and harder when it is hurt, a held breath in a collapse
    let pulse = 0.5 + 0.5 * Math.sin(tick * (0.06 + 0.05 * this.hurt) + f.slot);
    const collapsing = (id === 'supernova.nova' || id === 'supernova.collapse') && m.phase === 'startup';
    const cq = collapsing ? clamp01(m.phaseTick / Math.max(1, m.startup)) : 0;
    if (collapsing) pulse = 0.6 + 0.4 * Math.sin(tick * (0.2 + 0.6 * cq));
    this.haloA = clamp01(
      (0.34 + 0.2 * pulse) * (0.35 + 0.65 * k) * (0.5 + 0.5 * massK) * dying + 0.35 * cq + 0.22 * this.hurt,
    );

    // the granulation churns every second tick
    if ((tick & 1) === 0) this.drawShimmer(tick, k, pulse, dying, cq);

    this.drawProminences(tick, k, dying, cq);
    this.drawFx(tick, m, id);
  }

  private drawShimmer(tick: number, k: number, pulse: number, dying: number, cq: number): void {
    const f = this.f;
    const map = f.body.map;
    const S = this.shimmer;
    S.clear();
    if (dying <= 0.02) {
      S.commit();
      return;
    }
    const mat = map.material;
    const ids = this.rig.ids;
    const { phase, weight } = this.gran;
    const n = map.w * map.h;
    const px = S.px;
    const em = S.emis!;
    // colour of the churn: gold when the star is full, ember-red as it starves; the collapse whitens it
    const warm = clamp01(0.25 + 0.75 * k + cq);
    const cr = 70 + 60 * warm;
    const cg = 26 + 46 * warm;
    const cb = 4 + 14 * warm + 90 * cq;
    const t1 = tick * 1.7;
    const t2 = tick * 0.9;
    const gain = (0.65 + 0.7 * this.hurt + 1.1 * cq) * dying;
    const corePulse = (0.55 + 0.45 * pulse) * (0.5 + 0.5 * k) + 0.7 * cq;
    let any = false;
    for (let i = 0; i < n; i++) {
      const m = mat[i]!;
      if (m === 0) continue;
      if (m === ids.photosphere || m === ids.inner) {
        const w = weight[i]!;
        if (w === 0) continue;
        const ph = phase[i]!;
        // each granule brightens and fades on its own beat; a wave rolls across them so the surface boils
        const s = SIN[(ph + t1) & 255]! * 0.6 + SIN[(((i * 5) & 255) + t2) & 255]! * 0.4;
        const a = (s * 0.5 + 0.5) ** 2 * (w / 255) * gain;
        if (a < 0.04) continue;
        px[i] =
          0xff000000 | (Math.min(255, cb * a) << 16) | (Math.min(255, cg * a) << 8) | Math.min(255, cr * a);
        em[i] = Math.min(255, 120 * a);
        any = true;
      } else if (m === ids.core) {
        const a = corePulse * (0.6 + 0.4 * SIN[(i * 3 + tick * 2) & 255]!);
        px[i] =
          0xff000000 | (Math.min(255, 70 * a) << 16) | (Math.min(255, 34 * a) << 8) | Math.min(255, 26 * a);
        em[i] = Math.min(255, 70 * a);
        any = true;
      } else if (m === ids.corona) {
        // the corona twinkles: sparse, quick, violet-white
        const h = ((i * 2654435761) ^ ((tick >> 1) * 40503)) >>> 0;
        if ((h & 15) === 0) {
          const a = (0.4 + (0.6 * ((h >>> 8) & 255)) / 255) * dying;
          px[i] =
            0xff000000 |
            (Math.min(255, 120 * a) << 16) |
            (Math.min(255, 80 * a) << 8) |
            Math.min(255, 110 * a);
          em[i] = Math.min(255, 140 * a);
          any = true;
        }
      }
    }
    if (any) S.mark();
    S.commit();
  }

  /** Prominence arcs that launch from the limb, hold, and fall back: cosmetic, and only where the limb is still there. */
  private drawProminences(tick: number, k: number, dying: number, cq: number): void {
    const f = this.f;
    const t = f.body.transform;
    const P = this.prom;
    const calm = f.state === 'idle' || f.state === 'move' || f.state === 'intro';
    const moving = Math.hypot(f.vx, f.vy) > 50;
    if (!calm || moving || (tick & 1) === 0 || !P.layer.visible) {
      P.begin(t.x, t.y);
      const map = f.body.map;
      const massK = clamp01(f.view.bodyStats.massFrac);
      const ids = this.rig.ids;
      const R = this.rig.radius * (0.75 + 0.25 * massK);
      // in a collapse the arcs are drawn back into the star; a dying star lets them fall
      const live = (1 - cq) * dying * (0.4 + 0.6 * k);
      if (live > 0.05) {
        for (let ai = 0; ai < this.arcs.length; ai++) {
          const A = this.arcs[ai]!;
          const u = ((tick + A.offset) % A.period) / A.period;
          let s0 = 0;
          let s1 = 0;
          if (u < 0.28) {
            s1 = smoothstep(0, 0.28, u);
          } else if (u < 0.56) {
            s1 = 1;
          } else if (u < 0.86) {
            s0 = smoothstep(0.56, 0.86, u);
            s1 = 1;
          } else continue;
          const drift = (Math.floor((tick + A.offset) / A.period) * 1.7 + ai) % 6.283;
          const a0 = A.angle + 0.35 * Math.sin(drift) - A.sep;
          const a1 = A.angle + 0.35 * Math.sin(drift) + A.sep;
          const h = A.h * live * (0.6 + 0.4 * Math.sin(u * Math.PI));
          this.drawArch(P, map, ids, R, a0, a1, h, s0, s1, tick, ai, live);
        }
      }
      P.end();
    }
  }

  private drawArch(
    P: Overlay,
    map: FighterImpl['body']['map'],
    ids: SupernovaRig['ids'],
    R: number,
    a0: number,
    a1: number,
    h: number,
    s0: number,
    s1: number,
    tick: number,
    seed: number,
    live: number,
  ): void {
    const f = this.f;
    const t = f.body.transform;
    const rf = R * 0.93;
    // footpoints in map cells must still be plasma
    const c0x = this.rig.core.x + Math.cos(a0) * rf;
    const c0y = this.rig.core.y + Math.sin(a0) * rf;
    const c1x = this.rig.core.x + Math.cos(a1) * rf;
    const c1y = this.rig.core.y + Math.sin(a1) * rf;
    const alive = (x: number, y: number): boolean => {
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      if (ix < 0 || iy < 0 || ix >= map.w || iy >= map.h) return false;
      const m = map.material[iy * map.w + ix]!;
      return m === ids.photosphere || m === ids.inner || m === ids.prominence || m === ids.corona;
    };
    if (!alive(c0x, c0y) || !alive(c1x, c1y)) return;
    const face = t.facing;
    const wx = (lx: number, ly: number, out: { x: number; y: number }): void => {
      out.x = t.x + (lx - this.rig.core.x) * face;
      out.y = t.y + (ly - this.rig.core.y);
    };
    const ca = Math.cos(a0);
    const sa = Math.sin(a0);
    const cb2 = Math.cos(a1);
    const sb = Math.sin(a1);
    const kk = h * 1.34;
    const x0 = c0x;
    const y0 = c0y;
    const x3 = c1x;
    const y3 = c1y;
    const x1 = x0 + ca * kk;
    const y1 = y0 + sa * kk;
    const x2 = x3 + cb2 * kk;
    const y2 = y3 + sb * kk;
    const N = 40;
    const p = this.xy;
    for (let i = 0; i <= N; i++) {
      const s = i / N;
      if (s < s0 || s > s1) continue;
      const u = 1 - s;
      const bx = u * u * u * x0 + 3 * u * u * s * x1 + 3 * u * s * s * x2 + s * s * s * x3;
      const by = u * u * u * y0 + 3 * u * u * s * y1 + 3 * u * s * s * y2 + s * s * s * y3;
      wx(bx, by, p);
      const flow = 0.5 + 0.5 * Math.sin(s * 15 - tick * 0.14 + seed * 2);
      const edge = Math.min(smoothstep(s0, s0 + 0.12, s), smoothstep(s1, s1 - 0.12, s));
      const thick = (1.1 + 1.5 * Math.sin(Math.PI * s)) * (0.6 + 0.4 * edge) * (0.6 + 0.4 * live);
      const v = (0.42 + 0.5 * flow) * (0.5 + 0.5 * edge);
      const col = rampDither(this.flame, v, Math.round(p.x), Math.round(p.y));
      P.disc(p.x, p.y, thick, col, 210);
      if (thick > 1.9) P.disc(p.x, p.y, thick * 0.45, rampAt(this.flame, 0.85 + 0.15 * flow), 255);
    }
  }

  private drawFx(tick: number, m: ActiveMove, id: string): void {
    const f = this.f;
    const t = f.body.transform;
    const X = this.fx;
    X.begin(t.x, t.y);
    const dir = f.facing;
    const R = this.rig.radius;
    const at = m.phase === 'active' ? m.phaseTick - 1 : -1;

    // ---- Solar Wind: the star sheds a ribbon of plasma along the path it just travelled ----
    if (this.trailN > 2) this.drawTrail(X, tick);

    // ---- Flare: the star's face swells, then a fan of flame tongues bursts out to the field ----
    if (id === 'supernova.flare' && !m.feint) {
      const s = this.aimOf(m);
      const mx = t.x + Math.cos(s) * R * 0.92;
      const my = t.y + Math.sin(s) * R * 0.92;
      if (m.phase === 'startup') {
        const q = clamp01(m.phaseTick / m.startup);
        glowD(X, mx, my, 14 + 30 * q, 255, 180, 80, 0.75 * q);
        plasmaBall(
          X,
          mx - Math.cos(s) * 4,
          my - Math.sin(s) * 4,
          4 + 9 * q,
          tick,
          this.flame,
          0,
          0,
          Math.round(140 + 100 * q),
        );
      } else if (m.phase === 'active' && f.liveHitShape(0, at, this.tmp) && this.tmp.kind === 'field') {
        this.drawFlare(X, tick, at, mx, my);
      } else if (m.phase === 'recovery') {
        const q = 1 - m.phaseTick / m.recovery;
        glowD(X, mx, my, 10 + 22 * q, 255, 170, 70, 0.5 * q);
      }
    }

    // ---- Coronal Ejection: gather, throw, burst ----
    if (id === 'supernova.ejection' && !m.feint) {
      const muzzleX = t.x + dir * (R + 6);
      if (m.phase === 'startup') {
        const q = clamp01(m.phaseTick / m.startup);
        const r = 6 + 26 * q * q;
        plasmaBall(X, muzzleX, t.y - 2, r, tick, this.flame, 0, -0.2, Math.round(120 + 120 * q));
        glowD(X, muzzleX, t.y, r * 2.2, 255, 150, 60, 0.28 * q);
        // arms of plasma reach out from the limb toward the ball
        for (let a = 0; a < 5; a++) {
          const ang = (a / 5) * 6.283 + tick * 0.06;
          const rr = R * (1 - 0.35 * (1 - q)) + 4 * Math.sin(tick * 0.2 + a);
          glowD(X, t.x + Math.cos(ang) * rr, t.y + Math.sin(ang) * rr, 5, 255, 190, 90, 0.5 * q);
        }
      } else if (m.phase === 'active' && this.fbLive && !this.fbHit) {
        plasmaBall(X, this.fbX, this.fbY, this.fbR * 0.95, tick, this.flame, dir * 1.6, 0);
        glowD(X, this.fbX, this.fbY, this.fbR * 2.4, 255, 150, 60, 0.34);
        // a comet tail of plasma trailing back toward the star
        for (let s = 1; s <= 9; s++) {
          const q = 1 - s / 10;
          glowD(
            X,
            this.fbX - dir * s * 9,
            this.fbY + Math.sin(tick * 0.4 + s) * 2,
            this.fbR * 0.7 * q + 2,
            255,
            130 + 60 * q,
            50,
            0.22 * q,
          );
        }
      }
      if (this.fbHit && tick - this.fbHitTick < 16)
        this.drawBurst(X, this.fbX, this.fbY, tick - this.fbHitTick, 62);
    }

    // ---- Prominence: charge glow, the flying arc, the wall ----
    if (id === 'supernova.prominence' && !m.feint) {
      if (m.phase === 'startup' || m.phase === 'charge') {
        const q =
          m.phase === 'charge'
            ? 0.4 + 0.6 * clamp01(m.chargeTicks / Math.max(1, m.chargeMax))
            : 0.3 * (m.phaseTick / m.startup);
        const px = t.x + dir * R * 0.5;
        const py = t.y - R - 6 - 10 * q;
        glowD(X, px, py, 12 + 30 * q, 255, 160, 60, 0.46 * q);
        plasmaBall(X, px, py, 4 + 8 * q, tick, this.flame, 0, -0.3, 230);
        // the star's own prominences lean toward the gathering point
        for (let a = 0; a < 3; a++) {
          const ang = -1.2 + a * 0.5 + 0.2 * Math.sin(tick * 0.1 + a);
          glowD(X, t.x + Math.cos(ang) * (R + 4), t.y + Math.sin(ang) * (R + 4), 5, 255, 190, 90, 0.5 * q);
        }
      } else if (m.phase === 'active' && at >= 0 && at < 12 && f.liveHitShape(0, at, this.tmp)) {
        this.drawArcFlight(X, tick, at);
      }
    }
    if (this.wallLife > 0 && tick >= this.wallStart) {
      this.drawWall(X, tick);
      if (tick - this.wallStart < 14)
        this.drawBurst(X, this.wallX, this.wallY + this.wallCfg.half * 0.6, tick - this.wallStart, 52, 0.38);
    } else if (this.wallLife > 0 && id !== 'supernova.prominence') {
      // the arc is still in the air: nothing yet
    }

    // ---- Nova / final collapse ----
    if ((id === 'supernova.nova' || id === 'supernova.collapse') && !m.feint)
      this.drawNova(X, tick, m, id === 'supernova.collapse');

    // ---- Guard: a shimmering shell of plasma ----
    if (f.guardUp) this.drawGuard(X, tick);
    X.end();
  }

  /** The Solar Wind smear: a tapered ribbon of plasma through the star's recent positions (newest at the star), with a soft glow behind it. */
  private drawTrail(X: Overlay, tick: number): void {
    const n = this.trailN;
    const tr = this.trail;
    const head = this.trailHead;
    let total = 0;
    for (let j = 0; j < n - 1; j++) {
      const a = (head - 1 - j + TRAIL * 4) % TRAIL;
      const b = (head - 2 - j + TRAIL * 4) % TRAIL;
      total += Math.hypot(tr[a * 2]! - tr[b * 2]!, tr[a * 2 + 1]! - tr[b * 2 + 1]!);
    }
    if (total < 6) return;
    const pos = (u: number, out: { x: number; y: number }): void => {
      // u: 0 = newest sample, 1 = oldest; linear between samples
      const q = clamp01(u) * (n - 1);
      const j = Math.min(n - 2, Math.floor(q));
      const fr = q - j;
      const a = (head - 1 - j + TRAIL * 4) % TRAIL;
      const b = (head - 2 - j + TRAIL * 4) % TRAIL;
      out.x = tr[a * 2]! + (tr[b * 2]! - tr[a * 2]!) * fr;
      out.y = tr[a * 2 + 1]! + (tr[b * 2 + 1]! - tr[a * 2 + 1]!) * fr;
    };
    const p = this.xy;
    for (let j = 0; j < n; j += 2) {
      pos(j / (n - 1), p);
      const q = 1 - j / n;
      glowD(X, p.x, p.y, 20 + 30 * q, 255, 140, 55, 0.3 * q);
    }
    ribbon(X, pos, 0.85, 0, total, 1, 11, tick, this.flame);
  }

  /** Direction (radians) of the current move's blow, from its aim variant. */
  private aimOf(m: ActiveMove): number {
    const f = this.f;
    const base = m.aim === 'up' ? -0.6 : m.aim === 'down' ? 0.6 : 0;
    return f.facing === 1 ? base : Math.PI - base;
  }

  /** The Flare: tongues of flame fan out of the star's face to the field's centre and a little beyond, a white-hot ball at its heart. */
  private drawFlare(X: Overlay, tick: number, at: number, bx: number, by: number): void {
    const s = this.tmp;
    const dx = s.x - bx;
    const dy = s.y - by;
    const d = Math.hypot(dx, dy) || 1;
    const ang0 = Math.atan2(dy, dx);
    const grow = smoothstep(-1, 3, at);
    const fade = 1 - clamp01((at - 3) / 5);
    const reach = (d + s.r * 1.1) * grow;
    const n = 13;
    for (let i = 0; i < n; i++) {
      const u = (i / (n - 1)) * 2 - 1;
      const a = ang0 + u * 0.62;
      const nn = tn(i * 9.3, tick * 0.7);
      const len = reach * (0.6 + 0.4 * nn) * (1 - 0.32 * Math.abs(u));
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      for (let l = 0; l < len; l += 1) {
        const q = l / len;
        const w = (1 + 3.6 * (1 - q) * (1 - Math.abs(u) * 0.5)) * 0.5;
        const v = (1 - q * 0.8) * (0.55 + 0.5 * tn(l * 0.6 + i * 5, tick * 0.5)) * (0.45 + 0.55 * fade);
        const x = bx + ca * l;
        const y = by + sa * l;
        X.disc(
          x,
          y,
          w,
          rampDither(this.flame, v, Math.round(x), Math.round(y)),
          Math.round(220 * (1 - q * 0.7)),
        );
      }
    }
    plasmaBall(
      X,
      s.x,
      s.y,
      s.r * 0.5 * (0.6 + 0.4 * grow),
      tick,
      this.flame,
      0.6 * Math.cos(ang0),
      0.6 * Math.sin(ang0),
      255,
    );
    glowD(X, s.x, s.y, s.r * 1.3, 255, 150, 60, 0.32 * fade);
    if (at < 3) glowD(X, s.x, s.y, s.r * 0.7, 255, 250, 235, 0.85 * (1 - at / 3));
  }

  /** The shell of an impact: a white flash, two shock rings, sparks flying out. */
  private drawBurst(X: Overlay, x: number, y: number, age: number, r: number, squash = 1): void {
    const q = age / 16;
    const rr = 8 + r * Math.sqrt(q);
    ringBand(X, x, y, rr - 5, rr, age, this.flame, 1 - q, [0, Math.PI * 2], squash);
    glowD(X, x, y, r * (0.9 - 0.4 * q), 255, 200, 110, 0.9 * (1 - q));
    if (age < 5) glowD(X, x, y, r * 0.5, 255, 255, 245, 0.9);
    for (let i = 0; i < 12; i++) {
      const a = i * 0.5236 + 0.3;
      const rr2 = 6 + r * 1.2 * Math.sqrt(q) * (0.6 + 0.4 * tn(i * 7, 3));
      X.set(
        Math.round(x + Math.cos(a) * rr2),
        Math.round(y + Math.sin(a) * rr2),
        rampAt(this.flame, 1 - q),
        240,
      );
    }
  }

  /** The Prominence arc in flight: a comet along a lofted parabola from the shoulder to the landing point. */
  private drawArcFlight(X: Overlay, tick: number, at: number): void {
    const f = this.f;
    const m = f.mv;
    const hb = m.variant!.hitboxes[0]!;
    // start and end of the hitbox sweep in world space
    f.liveHitShape(0, hb.from, this.wallShape);
    const sx = this.wallShape.x;
    const sy = this.wallShape.y;
    f.liveHitShape(0, hb.to - 1, this.wallShape);
    const ex = this.wallShape.x;
    const ey = this.wallShape.y;
    const span = Math.max(1, hb.to - 1 - hb.from);
    const loft = Math.min(46, 0.34 * Math.hypot(ex - sx, ey - sy) + 12);
    const at2 = clamp(at, 0, span);
    const pos = (u: number, out: { x: number; y: number }): void => {
      out.x = sx + (ex - sx) * u;
      out.y = sy + (ey - sy) * u - 4 * loft * u * (1 - u);
    };
    const u = at2 / span;
    const p = this.xy;
    pos(u, p);
    const total = Math.hypot(ex - sx, ey - sy) + loft;
    ribbon(X, pos, Math.max(0, u - 0.55), u, total, 1, 5.5, tick, this.flame);
    plasmaBall(X, p.x, p.y, 6.5, tick, this.flame, 0, 0, 255);
    glowD(X, p.x, p.y, 26, 255, 160, 60, 0.5);
  }

  /** The wall of fire: flame tongues along its whole height with a hot base glow, guttering out over its last ticks. */
  private drawWall(X: Overlay, tick: number): void {
    const c = this.wallCfg;
    const life = clamp01(this.wallLife / 14);
    const rise = clamp01((tick - this.wallStart) / 5);
    const g = life * rise;
    const top = this.wallY - c.half * (0.75 + 0.25 * g);
    const bottom = this.wallY + c.half;
    flameColumn(X, this.wallX, top, bottom, c.width * 0.55, tick, this.flame, 1.25 * g);
    flameColumn(
      X,
      this.wallX - c.width * 0.42,
      top + c.half * 0.3,
      bottom,
      c.width * 0.36,
      tick + 17,
      this.flame,
      1.05 * g,
    );
    flameColumn(
      X,
      this.wallX + c.width * 0.42,
      top + c.half * 0.3,
      bottom,
      c.width * 0.36,
      tick + 41,
      this.flame,
      1.05 * g,
    );
    // the flames lean and rise; a bright seam runs up the middle and embers lift off
    glowD(X, this.wallX, this.wallY, c.half * 0.95, 255, 130, 45, 0.24 * g);
    for (let e = 0; e < 5; e++) {
      const h = ((tick * 3 + e * 37) % 70) / 70;
      X.set(
        Math.round(this.wallX + Math.sin(tick * 0.2 + e * 2.1) * c.width * 0.6),
        Math.round(bottom - h * (bottom - top) * 1.1),
        rampAt(this.flame, 1 - h * 0.5),
        230 * g,
      );
    }
  }

  /** The collapse: motes and a contracting ring fall into the star as its core swells; then the blast ring. */
  private drawNova(X: Overlay, tick: number, m: ActiveMove, final: boolean): void {
    const f = this.f;
    const t = f.body.transform;
    const R = this.rig.radius;
    if (m.phase === 'startup') {
      const q = clamp01(m.phaseTick / Math.max(1, m.startup));
      const ease = q * q;
      // infalling motes, spiralling
      const n = final ? 110 : 84;
      for (let i = 0; i < n; i++) {
        const seed = (i * 37) % 97;
        const life = (q * 1.6 + seed / 97) % 1;
        const rad = (R + 90) * (1 - life) + 6;
        const ang = i * 2.399 + life * 4.2 + tick * 0.02;
        const x = t.x + Math.cos(ang) * rad;
        const y = t.y + Math.sin(ang) * rad * 0.9;
        const tx = t.x + Math.cos(ang - 0.3) * (rad + 18);
        const ty = t.y + Math.sin(ang - 0.3) * (rad + 18) * 0.9;
        streak(X, x, y, tx, ty, 255, 200 + 40 * life, 120 + 100 * life, 0.5 + 0.8 * life);
        X.set(Math.round(x), Math.round(y), rampAt(this.flame, 0.6 + 0.4 * life), 255);
      }
      // the contracting ring and the swelling white heart
      const ringR = (R + 34) * (1 - 0.78 * ease);
      ringBand(X, t.x, t.y, ringR - 3, ringR + 1, tick, this.flame, 0.5 + 0.7 * q);
      glowD(X, t.x, t.y, 20 + 46 * ease, 255, 235, 200, 0.55 * ease);
      if (q > 0.6) glowD(X, t.x, t.y, 14 + 20 * ease, 200, 230, 255, (0.9 * (q - 0.6)) / 0.4);
    } else if (m.phase === 'active') {
      const at = m.phaseTick - 1;
      const boxes = m.variant?.hitboxes ?? [];
      for (let k = 0; k < boxes.length; k++) {
        const hb = boxes[k]!;
        if (at < hb.from || at >= hb.to + 3 || !f.liveHitShape(k, at, this.tmp) || this.tmp.kind !== 'ring')
          continue;
        const s = this.tmp;
        const q = clamp01((at - hb.from) / (hb.to - hb.from));
        // a white-hot leading edge with a wake that thins out behind it; the whole wave dims as it spreads
        ringBand(X, s.x, s.y, s.r0, s.r1, tick + k * 7, this.flame, 1.2 - 0.6 * q);
        glowD(X, s.x, s.y, s.r0 * 0.9, 255, 170, 80, 0.14 * (1 - q));
      }
      if (at < 12) glowD(X, t.x, t.y, 96 - at * 6, 255, 245, 230, 0.9 * (1 - at / 12));
    } else {
      // recovery: the afterglow
      const q = 1 - clamp01(m.phaseTick / Math.max(1, m.recovery));
      glowD(X, t.x, t.y, 60 * q + 12, 255, 150, 60, 0.3 * q);
    }
  }

  /** A shell of plasma around the star while Guard is up: a rippling band that thins and dims as the shell weakens, sparks when struck. */
  private drawGuard(X: Overlay, tick: number): void {
    const f = this.f;
    const t = f.body.transform;
    const R = this.rig.radius * (0.75 + 0.25 * clamp01(f.view.bodyStats.massFrac)) + 6;
    const hp = clamp01(f.view.guardHealth);
    ringBand(X, t.x, t.y, R - 1, R + 2 + 2.5 * hp, tick, this.flame, 0.55 + 0.6 * hp + this.hurt * 0.6);
    // a second, fainter shell just outside, rippling out of phase
    const wob = 2.5 * Math.sin(tick * 0.2);
    ringBand(X, t.x, t.y, R + 6 + wob, R + 7.5 + wob, tick + 9, this.flame, 0.35 * hp);
    glowD(X, t.x, t.y, R + 14, 255, 150, 70, 0.1 + 0.16 * hp + 0.3 * this.hurt);
    if (this.hurt > 0.3)
      for (let i = 0; i < 9; i++) {
        const a = (i * 2.399 + tick * 0.4) % 6.283;
        const rr = R + 3 + 8 * this.hurt * ((i * 7 + tick) % 5) * 0.3;
        X.set(
          Math.round(t.x + Math.cos(a) * rr),
          Math.round(t.y + Math.sin(a) * rr),
          rampAt(this.flame, 0.9),
          255,
        );
      }
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  Behaviour plumbing
   * ---------------------------------------------------------------------------------------------- */

  override renderLayers(_view: ViewRect, _alpha: number, out: RenderLayer[]): void {
    const f = this.f;
    const body = out[out.length - 1]!;
    this.shimmer.follow(body);
    // the halo follows the star (interpolated like the body) and shrinks with it
    const t = f.body.transform;
    this.halo.place(t.x, t.y, body.prevX, body.prevY, this.haloA);
    this.halo.layer.anchorX = this.halo.layer.w >> 1;
    this.halo.layer.anchorY = this.halo.layer.h >> 1;
    out.push(this.halo.layer, this.shimmer.layer, this.prom.layer, this.fx.layer);
  }

  override debugShapes(out: DebugShape[]): void {
    const t = this.f.body.transform;
    const a = makeFatShape();
    a.kind = 'field';
    a.x = t.x;
    a.y = t.y;
    a.r = AURA_RADIUS * (0.7 + 0.5 * this.fuelFrac());
    a.falloff = 1.5;
    out.push({ shape: asShape(a), color: 0xff3080ff, label: 'radiance' });
    if (this.wallLife > 0 && this.f.tickNo >= this.wallStart) {
      const w = makeFatShape();
      w.kind = 'line';
      w.x0 = this.wallX;
      w.x1 = this.wallX;
      w.y0 = this.wallY - this.wallCfg.half;
      w.y1 = this.wallY + this.wallCfg.half;
      w.width = this.wallCfg.width;
      out.push({ shape: asShape(w), color: 0xff3040ff, label: 'fire wall' });
    }
  }

  /** Test/AI access: the star's last update tick. */
  get updatedAt(): number {
    return this.lastTick;
  }
  get quiet(): number {
    return this.f.tickNo - this.lastAct;
  }
  get novaFired(): boolean {
    return this.novaDone;
  }
}
