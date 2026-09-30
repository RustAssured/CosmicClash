import {
  CellFlag,
  DamageFlag,
  clamp,
  clamp01,
  hex,
  type DamageEvent,
  type DamageShape,
  type DebugShape,
  type FighterTickCtx,
  type MatterBody,
  type OverlapResult,
  type RenderLayer,
  type ViewRect,
} from '@/contracts';
import { generateMoonBody } from '@/titans/art/planet';
import type { PlanetRig } from '@/titans';
import { Behaviour, type HitInfo, type InterceptResult } from '../behaviour';
import type { FighterImpl } from '../fighter';
import { BodyOverlay } from '../fx/bodyOverlay';
import { TrackedBodyLayer } from '../fx/bodyLayer';
import { GlowSprite } from '../fx/glowSprite';
import { bayer, glowD, rampAt, rampDither, ribbon, ringBand, tn } from '../fx/lib';
import { Overlay } from '../fx/overlay';
import type { ActiveMove } from '../move';
import { asShape, makeFatShape, shapeIntersectsDisc } from '../shapes';

/** Moon modes. */
const ORBIT = 0;
const SLAM = 1;
const RETURN = 2;
const DRIFT = 3;
const GONE = 4;

/** Share of a blow a moon in its way takes for the planet, and the most all moons together can soak. */
const MOON_SHARE = 0.22;
const SOAK_MAX = 0.3;
/** A moon shoved harder than this (impulse per unit of its remaining mass) is knocked out of orbit; below this mass fraction it breaks up. */
const KNOCK_LIMIT = 170;
const BREAK_FRAC = 0.28;
/** A drifting moon further than this from the planet is lost for good. */
const LOST_RADIUS = 300;
const GRAVITY_STRENGTH = 12;
const GRAVITY_RADIUS = 250;

interface SlamCfg {
  speed: number;
  energy: number;
  crater: number;
  compress: number;
  shock: number;
  recoil: number;
  life: number;
}
interface BarrageCfg {
  from: number;
  gap: number;
  speed: number;
  energy: number;
  crater: number;
  compress: number;
  shock: number;
}

class Moon {
  body!: MatterBody;
  layer!: TrackedBodyLayer;
  mode = ORBIT;
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  /** Orbit angle, and the current orbital angular speed multiplier. */
  ang = 0;
  age = 0;
  radius = 12;
  slamHit = false;
  /** Trail of recent positions for the flight ribbon. */
  readonly tx = new Float32Array(14);
  readonly ty = new Float32Array(14);
  spec!: PlanetRig['moons'][number];
  back = false;
}

const INTERIOR = (r: PlanetRig['ids'], m: number): boolean =>
  m === r.crust || m === r.mantle || m === r.magma || m === r.core;

/**
 * THE PLANET. Crush and tectonics with real moons: each moon is a separate matter body on a visible elliptical orbit (in front of
 * and behind the world), its weapon and its shield. Guard swings them between the planet and the foe; Moon Slam flings one as a
 * CRUSH projectile that comes home (or breaks); Cataclysm compresses the foe, quakes it, then rains both moons on it. Blows that
 * reach a moon damage the moon itself, and a hard one knocks it out of orbit for good. The atmosphere is matter that soaks heat and
 * can be stripped; cracks in the crust glow with magma; the gravity well gathers debris into a slow ring.
 */
export class PlanetBehaviour extends Behaviour {
  private rig!: PlanetRig;
  private moons: Moon[] = [];
  private skin!: BodyOverlay;
  private glow!: BodyOverlay;
  private halo!: GlowSprite;
  private fx!: Overlay;
  private cfg!: SlamCfg;
  private barrage: BarrageCfg | null = null;
  private lit!: Uint8Array;
  private expo!: Uint8Array;
  private flame: number[] = [];
  private mantle: number[] = [];
  private magma: number[] = [];
  private crustR: number[] = [];
  private cloudC: number[] = [];
  private tmp = makeFatShape();
  private readonly ov: OverlapResult = {
    cells: 0,
    x: NaN,
    y: NaN,
    nearestX: NaN,
    nearestY: NaN,
    coverage: 0,
  };
  private readonly ev: DamageEvent;
  private readonly evShape = makeFatShape();
  private readonly dmg = {
    type: 'CRUSH' as const,
    energy: 0,
    duration: 1,
    flags: 0,
    params: { crater: 16, compress: 8, shock: 1.2 } as DamageEvent['params'],
  };
  /* input memory (aim of the slam) */
  private aimX = 1;
  private aimY = 0;
  private guardBlend = 0;
  private spinBoost = 0;
  /* monitoring of the failure mode */
  private atmoCells0 = 1;
  private oceanCells0 = 1;
  private atmoFrac = 1;
  private oceanFrac = 1;
  private cracked = 0;
  private atmoCue = 0;
  private lastOcean = 1;
  private lastVer = -1;
  private redraw = 0;
  private barrageNext = 0;
  private quaked = false;
  private tickLast = 0;

  constructor(f: FighterImpl) {
    super(f);
    this.ev = {
      type: 'CRUSH',
      shape: asShape(this.evShape),
      energy: 0,
      dirX: 1,
      dirY: 0,
      duration: 1,
      sourceMass: 3,
      sourceBodyId: -1,
      originX: 0,
      originY: 0,
      flags: 0,
      params: {},
    };
  }

  override attach(): void {
    const f = this.f;
    this.rig = f.rig as PlanetRig;
    const r = this.rig;
    const ramp = (k: string): number[] => f.def.materials.find((m) => m.key === k)!.visual.ramp.map(hex);
    this.mantle = ramp('mantle');
    this.magma = ramp('magma');
    this.crustR = ramp('crust');
    this.cloudC = ramp('cloud');
    this.flame = ramp('magma');
    this.cfg = f.slotMoves.signature!.extra!['slam'] as SlamCfg;
    this.barrage = (f.slotMoves.ultimate?.extra?.['barrage'] as BarrageCfg | undefined) ?? null;
    const map = f.body.map;
    this.skin = new BodyOverlay('planet-skin', 0.2, map.w, map.h, 'normal', true);
    this.glow = new BodyOverlay('planet-glow', 0.3, map.w, map.h, 'add', true);
    this.halo = new GlowSprite('planet-halo', -0.5, 118, [40, 90, 150], 0.5, 6);
    this.fx = new Overlay('planet-fx', 20, 800, 560, 'add', true);
    this.expo = new Uint8Array(map.w * map.h);
    // light on every face cell (0..255), from the same key the painter used
    const L = f.lighting;
    const kx = L.dir[0] * 0.8;
    const ky = L.dir[1];
    const kz = L.dir[2];
    const kn = Math.hypot(kx, ky, kz) || 1;
    this.lit = new Uint8Array(map.w * map.h);
    const cx = f.def.art.coreX + 0.5;
    const cy = f.def.art.coreY + 0.5;
    for (let y = 0; y < map.h; y++)
      for (let x = 0; x < map.w; x++) {
        const i = y * map.w + x;
        if (r.nz[i] === 0) continue;
        const nx = (x + 0.5 - cx) / r.radius;
        const ny = (y + 0.5 - cy) / r.radius;
        this.lit[i] = Math.round(clamp01((nx * kx + ny * ky + (r.nz[i]! / 255) * kz) / kn) * 255);
      }
    // material census (initial)
    let a = 0;
    let o = 0;
    for (let i = 0; i < map.material.length; i++) {
      const m = map.material[i]!;
      if (m === r.ids.atmosphere || m === r.ids.cloud) a++;
      else if (m === r.ids.ocean) o++;
    }
    this.atmoCells0 = Math.max(1, a);
    this.oceanCells0 = Math.max(1, o);
    this.lastOcean = 1;
    // the moons: real bodies
    this.moons = [];
    const specs = r.moons;
    for (let i = 0; i < specs.length; i++) this.spawnMoon(i);
    f.resourceMax = specs.length;
    f.resource = specs.length;
    this.updateOrbit(0, true);
  }

  private spawnMoon(i: number): void {
    const f = this.f;
    const spec = this.rig.moons[i]!;
    const g = generateMoonBody(f.def, f.seed, f.lighting, i);
    const t = f.body.transform;
    const body = f.world.createBody({
      kind: 'moon',
      ownerSlot: f.slot,
      map: g.map,
      materials: g.materials,
      attributes: { mass: 3, cohesion: 8, heat: 6, gravity: 0, reach: 1, tempo: 1 },
      seed: f.seed + 101 * (i + 1),
      transform: { x: t.x, y: t.y, anchorX: g.map.coreX, anchorY: g.map.coreY, facing: 1, lean: 0 },
      takesDebrisImpacts: false,
    });
    const m = new Moon();
    m.body = body;
    m.layer = new TrackedBodyLayer(`planet-moon-${f.slot}-${i}`, 1, body);
    m.spec = spec;
    m.ang = spec.phase;
    m.radius = spec.r;
    this.moons[i] = m;
  }

  override reset(heal: number): void {
    const f = this.f;
    // a body ground to nothing cannot regrow: rebuild it from its template
    if (f.view.bodyStats.massFrac < 0.05) f.world.restore(f.body.id);
    for (let i = 0; i < this.rig.moons.length; i++) {
      const m = this.moons[i];
      if (m && m.mode !== GONE) {
        f.world.heal(m.body.id, Math.max(heal, 0.5), f.seed + i);
        m.mode = ORBIT;
      } else {
        if (m) m.layer.layer.visible = false;
        this.spawnMoon(i);
      }
    }
    f.resource = this.moons.length;
    f.resourceMax = this.moons.length;
    this.barrageNext = 0;
    this.quaked = false;
    this.atmoCue = 0;
    this.updateOrbit(f.tickNo, true);
  }

  /** Moons still bound to the planet (orbiting, flung or returning): the HUD count and the resource ceiling. */
  get moonsAlive(): number {
    let n = 0;
    for (const m of this.moons) if (m.mode !== GONE && m.mode !== DRIFT) n++;
    return n;
  }
  get moonBodies(): readonly Moon[] {
    return this.moons;
  }
  get atmosphere(): number {
    return this.atmoFrac;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  moons: orbits
   * ---------------------------------------------------------------------------------------------- */

  /** Where moon `m` sits on its orbit right now, blended toward the shield position while Guard is up. */
  private orbitPos(m: Moon, out: { x: number; y: number }, back: { v: boolean }, slotIdx: number): void {
    const f = this.f;
    const s = m.spec;
    const ex = Math.cos(m.ang) * s.a;
    const ey = Math.sin(m.ang) * s.b;
    const ct = Math.cos(s.tilt);
    const st = Math.sin(s.tilt);
    let x = ex * ct - ey * st;
    let y = ex * st + ey * ct;
    back.v = Math.sin(m.ang) < 0;
    const gb = this.guardBlend;
    if (gb > 0.01) {
      // shield: stand in front of the planet on the foe's side, one above the other
      const sx = f.facing * (this.rig.radius + 16 + slotIdx * 6);
      const sy = (slotIdx - (this.moons.length - 1) / 2) * 40;
      x += (sx - x) * gb;
      y += (sy - y) * gb;
      if (gb > 0.5) back.v = false;
    }
    out.x = f.px + x;
    out.y = f.py + y;
  }

  private updateOrbit(tick: number, snap: boolean): void {
    const f = this.f;
    const p = { x: 0, y: 0 };
    const b = { v: false };
    for (let i = 0; i < this.moons.length; i++) {
      const m = this.moons[i]!;
      if (m.mode === GONE) continue;
      if (m.mode === ORBIT) {
        const w = ((Math.PI * 2) / m.spec.period) * (1 + this.spinBoost * 3);
        m.ang += w;
        this.orbitPos(m, p, b, i);
        m.back = b.v;
        if (snap) {
          m.x = p.x;
          m.y = p.y;
        } else {
          // ease toward the target so blends (guard, return) are smooth
          m.x += (p.x - m.x) * 0.5;
          m.y += (p.y - m.y) * 0.5;
        }
        m.vx = 0;
        m.vy = 0;
      }
      const t = m.body.transform;
      t.x = Math.round(m.x);
      t.y = Math.round(m.y);
      m.layer.tickStart();
    }
    void tick;
    void f;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  parts: hits, soak, knock-out
   * ---------------------------------------------------------------------------------------------- */

  override probeParts(shape: DamageShape, out: OverlapResult): number {
    let hits = 0;
    for (const m of this.moons) {
      if (m.mode === GONE) continue;
      this.f.world.overlap(m.body.id, shape, this.ov);
      if (this.ov.cells > 0) {
        if (out.cells === 0) {
          out.x = this.ov.x;
          out.y = this.ov.y;
          out.nearestX = this.ov.nearestX;
          out.nearestY = this.ov.nearestY;
          out.coverage = Math.max(out.coverage, this.ov.coverage * 0.5);
        }
        out.cells += this.ov.cells;
        hits++;
      }
    }
    return hits;
  }

  override intercept(ev: DamageEvent, _info: HitInfo, res: InterceptResult): void {
    const f = this.f;
    let n = 0;
    for (const m of this.moons) {
      if (m.mode === GONE) continue;
      this.f.world.overlap(m.body.id, ev.shape, this.ov);
      if (this.ov.cells <= 0) continue;
      n++;
      // the moon takes its share of the blow, for real: it is matter
      const e2 = this.ev;
      e2.type = ev.type;
      e2.shape = ev.shape;
      e2.energy = ev.energy * MOON_SHARE;
      e2.dirX = ev.dirX;
      e2.dirY = ev.dirY;
      e2.duration = 1;
      e2.flags = ev.flags & ~DamageFlag.PIERCE;
      e2.params = ev.params;
      e2.sourceMass = ev.sourceMass;
      e2.sourceBodyId = ev.sourceBodyId;
      e2.originX = ev.originX;
      e2.originY = ev.originY;
      const r = f.world.applyDamage(m.body.id, e2);
      const frac = f.world.stats(m.body.id).massFrac;
      const push = Math.hypot(r.impulseX, r.impulseY) / Math.max(0.2, frac);
      if (frac < BREAK_FRAC) this.loseMoon(m, ev.dirX * 90, ev.dirY * 90, true);
      else if (push > KNOCK_LIMIT && m.mode !== DRIFT) {
        m.mode = DRIFT;
        m.age = 0;
        m.vx = ev.dirX * Math.min(8, push * 0.012) + (m.x - f.px) * 0.004;
        m.vy = ev.dirY * Math.min(8, push * 0.012) - 1;
        f.events.push({ t: 'shake', dirX: ev.dirX, dirY: ev.dirY, amp: 5 });
      }
    }
    if (n > 0) {
      res.touched = true;
      res.partsHit += n;
      res.absorbed = Math.max(res.absorbed, Math.min(SOAK_MAX, MOON_SHARE * n));
    }
  }

  /** A moon is lost: what is left of it drifts off as a debris chunk, and the pip goes out. */
  private loseMoon(m: Moon, vx: number, vy: number, broke: boolean): void {
    const f = this.f;
    if (m.mode === GONE) return;
    const wasBound = m.mode !== DRIFT;
    const map = m.body.map;
    const px = new Uint32Array(map.pixels);
    const em = new Uint8Array(map.emissive);
    const mass = f.world.stats(m.body.id).mass;
    if (mass > 0.5)
      f.world.spawnChunk({
        pixels: px,
        emissive: em,
        w: map.w,
        h: map.h,
        x: m.x + map.w / 2 - m.body.transform.anchorX,
        y: m.y + map.h / 2 - m.body.transform.anchorY,
        vx: vx || m.vx * 60,
        vy: vy || m.vy * 60,
        spin: broke ? 1.6 : 0.5,
        mass,
      });
    f.world.removeBody(m.body.id);
    m.mode = GONE;
    m.layer.layer.visible = false;
    f.events.push({ t: 'cue', slot: f.slot, titan: f.def.id, id: 'moon-lost', x: m.x, y: m.y, amount: 1 });
    f.events.push({ t: 'resource', slot: f.slot, kind: 'spend', amount: 1 });
    f.events.push({ t: 'shockwave', x: m.x, y: m.y, strength: 0.35, radius: 110, hue: 0.6 });
    if (wasBound && f.resource > this.moonsAlive) f.resource = this.moonsAlive;
    this.spinBoost = 0;
  }

  /** The Guard shell is as strong as the atmosphere that remains (and the moons standing in front of it). */
  override guardMultiplier(): number {
    let shield = 0;
    for (const m of this.moons) if (m.mode === ORBIT) shield += 0.12;
    return 0.4 + 0.6 * this.atmoFrac + shield;
  }

  override onDamaged(energy: number, _dx: number, _dy: number): void {
    this.spinBoost = Math.min(1, this.spinBoost + energy / 4000);
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  moons: slam and barrage
   * ---------------------------------------------------------------------------------------------- */

  private pickMoon(): Moon | null {
    // the moon nearest the foe's side, in orbit
    const f = this.f;
    let best: Moon | null = null;
    let bd = 1e9;
    for (const m of this.moons) {
      if (m.mode !== ORBIT) continue;
      const d = Math.abs(m.x - f.foe.view.x);
      if (d < bd) {
        bd = d;
        best = m;
      }
    }
    return best;
  }

  private launch(m: Moon, speed: number, aimX: number, aimY: number): void {
    const l = Math.hypot(aimX, aimY) || 1;
    m.mode = SLAM;
    m.age = 0;
    m.slamHit = false;
    m.vx = (aimX / l) * speed;
    m.vy = (aimY / l) * speed;
    m.tx.fill(m.x);
    m.ty.fill(m.y);
  }

  override onRelease(m: ActiveMove): void {
    const f = this.f;
    const id = m.def?.id;
    if (id === 'planet.moonslam') {
      const moon = this.pickMoon();
      if (!moon) {
        // nothing to throw: the cost is handed back
        f.resource = Math.min(this.moonsAlive, f.resource + 1);
        return;
      }
      const cf = m.chargeMax > 0 ? m.chargeTicks / m.chargeMax : 0;
      // aim: the stick if it is held, otherwise straight at the foe
      let ax = this.aimX;
      let ay = this.aimY;
      if (Math.hypot(ax, ay) < 0.3) {
        ax = f.foe.view.x - moon.x;
        ay = f.foe.view.y - moon.y;
      }
      this.launch(moon, this.cfg.speed * (1 + 0.35 * cf), ax, ay);
      this.spinBoost = 0.6;
    } else if (id === 'planet.impact') this.spinBoost = 1;
    else if (id === 'planet.cataclysm') this.quaked = false;
  }

  override onMoveEnd(m: ActiveMove, _interrupted: boolean): void {
    if (m.def?.id === 'planet.cataclysm') this.barrageNext = 0;
  }

  override onKo(): void {
    for (const mo of this.moons) if (mo.mode === SLAM) mo.mode = RETURN;
  }

  override resolveVolumes(ctx: FighterTickCtx): void {
    const f = this.f;
    const tick = ctx.tick;
    const m = f.mv;
    // stick aim, remembered for the slam
    this.aimX = ctx.input.moveX;
    this.aimY = ctx.input.moveY;
    // cataclysm: after the quake the moons rain on the foe one after another
    if (m.def?.id === 'planet.cataclysm' && this.barrage && m.phase === 'active') {
      const at = m.phaseTick - 1;
      const b = this.barrage;
      if (at >= b.from && at >= this.barrageNext) {
        const moon = this.pickMoon();
        if (moon) {
          this.launch(moon, b.speed, f.foe.view.x - moon.x, f.foe.view.y - moon.y);
          moon.slamHit = false;
        }
        this.barrageNext = at + b.gap;
      }
    }
    if (m.def?.id === 'planet.cataclysm' && m.phase === 'active' && !this.quaked && m.phaseTick - 1 >= 52) {
      this.quaked = true;
      const t = f.body.transform;
      f.events.push(
        { t: 'flash', amount: 0.45 },
        { t: 'shake', dirX: f.facing, dirY: 0.4, amp: 13 },
        { t: 'shockwave', x: f.foe.view.x, y: f.foe.view.y, strength: 1, radius: 300, hue: 0.08 },
        { t: 'zoom', amount: 0.04 },
        { t: 'cue', slot: f.slot, titan: f.def.id, id: 'crust-crack', x: t.x, y: t.y, amount: 1 },
      );
    }
    // flying moons
    const cfg = this.cfg;
    const bar = this.barrage;
    for (const mo of this.moons) {
      if (mo.mode === SLAM) {
        mo.age++;
        mo.x += mo.vx;
        mo.y += mo.vy;
        for (let k = 13; k > 0; k--) {
          mo.tx[k] = mo.tx[k - 1]!;
          mo.ty[k] = mo.ty[k - 1]!;
        }
        mo.tx[0] = mo.x;
        mo.ty[0] = mo.y;
        const ult = m.def?.id === 'planet.cataclysm';
        const energy = ult
          ? (bar?.energy ?? 900)
          : cfg.energy * (m.def?.id === 'planet.moonslam' ? m.power : 1);
        if (!mo.slamHit && f.live) {
          const sh = this.tmp;
          sh.kind = 'point';
          sh.x = mo.x;
          sh.y = mo.y;
          sh.r = mo.radius + 2;
          this.dmg.energy = energy;
          this.dmg.params.crater = ult ? (bar?.crater ?? 14) : cfg.crater;
          this.dmg.params.compress = ult ? (bar?.compress ?? 7) : cfg.compress;
          this.dmg.params.shock = ult ? (bar?.shock ?? 1) : cfg.shock;
          const hit = f.strike(
            sh,
            this.dmg,
            mo.vx * 50,
            mo.vy * 50,
            0.6,
            12,
            'signature',
            'planet.moonslam',
            1,
          );
          if (hit) {
            mo.slamHit = true;
            // the moon pays for the blow: a KINETIC bruise where it struck
            const e2 = this.ev;
            const s2 = this.evShape;
            s2.kind = 'point';
            s2.x = mo.x + Math.sign(mo.vx) * mo.radius * 0.6;
            s2.y = mo.y;
            s2.r = mo.radius * 0.7;
            e2.type = 'KINETIC';
            e2.energy = energy * cfg.recoil;
            e2.dirX = -Math.sign(mo.vx || 1);
            e2.dirY = 0;
            e2.flags = 0;
            e2.params = { crater: 3 };
            e2.sourceMass = 4;
            e2.sourceBodyId = f.body.id;
            e2.originX = mo.x;
            e2.originY = mo.y;
            f.world.applyDamage(mo.body.id, e2);
            if (f.world.stats(mo.body.id).massFrac < BREAK_FRAC)
              this.loseMoon(mo, mo.vx * 30, mo.vy * 30, true);
            else {
              mo.mode = RETURN;
              mo.vx *= -0.3;
              mo.vy *= -0.3;
            }
          }
        }
        if (mo.mode === SLAM) {
          f.addThreat(asShape(this.moonShape(mo)), 'CRUSH', energy, 0, 4, true);
          if (mo.age > cfg.life || Math.hypot(mo.x - f.px, mo.y - f.py) > 470) mo.mode = RETURN;
        }
      } else if (mo.mode === RETURN) {
        const dx = f.px - mo.x;
        const dy = f.py - mo.y;
        const d = Math.hypot(dx, dy) || 1;
        mo.vx += (dx / d) * 0.9;
        mo.vy += (dy / d) * 0.9;
        mo.vx *= 0.93;
        mo.vy *= 0.93;
        const sp = Math.hypot(mo.vx, mo.vy);
        if (sp > 9) {
          mo.vx *= 9 / sp;
          mo.vy *= 9 / sp;
        }
        mo.x += mo.vx;
        mo.y += mo.vy;
        // captured back into orbit when it reaches the orbit ring
        const orb = Math.hypot(mo.spec.a, mo.spec.b) * 0.9;
        if (d < orb) {
          mo.mode = ORBIT;
          mo.ang = Math.atan2((mo.y - f.py) / Math.max(1, mo.spec.b), (mo.x - f.px) / Math.max(1, mo.spec.a));
          if (f.resource < this.moonsAlive) {
            f.resource = Math.min(this.moonsAlive, f.resource + 1);
            f.events.push({ t: 'resource', slot: f.slot, kind: 'gain', amount: 1 });
          }
        }
      } else if (mo.mode === DRIFT) {
        // knocked out of orbit: the planet's gravity tugs at it; it wobbles home only if it was not thrown far
        mo.age++;
        const dx = f.px - mo.x;
        const dy = f.py - mo.y;
        const d = Math.hypot(dx, dy) || 1;
        const g = 0.028 * (1 / Math.max(0.6, d / 160));
        mo.vx += (dx / d) * g * 4;
        mo.vy += (dy / d) * g * 4;
        mo.x += mo.vx;
        mo.y += mo.vy;
        if (d > LOST_RADIUS || mo.age > 260) this.loseMoon(mo, mo.vx * 60, mo.vy * 60, false);
        else if (mo.age > 90 && d < 190 && Math.hypot(mo.vx, mo.vy) < 2.2) mo.mode = RETURN;
      }
      if (mo.mode !== ORBIT && mo.mode !== GONE) {
        const t = mo.body.transform;
        t.x = Math.round(mo.x);
        t.y = Math.round(mo.y);
        mo.layer.tickStart();
        mo.back = false;
      }
    }
    void tick;
  }

  private moonShape(mo: Moon): ReturnType<typeof makeFatShape> {
    const s = this.evShape;
    s.kind = 'point';
    s.x = mo.x;
    s.y = mo.y;
    s.r = mo.radius + 2;
    return s;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  per tick
   * ---------------------------------------------------------------------------------------------- */

  override update(ctx: FighterTickCtx): void {
    const f = this.f;
    const tick = ctx.tick;
    const m = f.mv;
    this.tickLast = tick;
    this.guardBlend += ((f.guardUp ? 1 : 0) - this.guardBlend) * 0.16;
    const surge = m.def?.slot === 'surge';
    this.spinBoost *= 0.985;
    if (surge) this.spinBoost = Math.max(this.spinBoost, 0.8);
    this.updateOrbit(tick, false);

    // Gravity Well (passive): a small well that gathers debris into a slow ring
    f.world.setGravitySource(
      f.slot,
      f.ko
        ? null
        : {
            x: f.px,
            y: f.py,
            strength: GRAVITY_STRENGTH,
            radius: GRAVITY_RADIUS,
          },
    );

    // failure-mode monitors (cheap: every few ticks)
    if (tick % 6 === 0) this.monitor();
    f.resource = clamp(f.resource, 0, this.moonsAlive);
    f.view.parts = this.moonsAlive;

    this.draw(tick, m);
  }

  private monitor(): void {
    const f = this.f;
    const map = f.body.map;
    const r = this.rig.ids;
    let a = 0;
    let o = 0;
    const mat = map.material;
    for (let i = 0; i < mat.length; i++) {
      const mm = mat[i]!;
      if (mm === r.atmosphere || mm === r.cloud) a++;
      else if (mm === r.ocean) o++;
    }
    this.atmoFrac = clamp01(a / this.atmoCells0);
    this.oceanFrac = clamp01(o / this.oceanCells0);
    const t = f.body.transform;
    if (this.atmoFrac < 0.66 && this.atmoCue < 1) {
      this.atmoCue = 1;
      f.events.push({
        t: 'cue',
        slot: f.slot,
        titan: f.def.id,
        id: 'atmo-strip',
        x: t.x,
        y: t.y,
        amount: 0.5,
      });
    }
    if (this.atmoFrac < 0.3 && this.atmoCue < 2) {
      this.atmoCue = 2;
      f.events.push({ t: 'cue', slot: f.slot, titan: f.def.id, id: 'atmo-strip', x: t.x, y: t.y, amount: 1 });
    }
    if (this.oceanFrac < this.lastOcean - 0.06) {
      this.lastOcean = this.oceanFrac;
      f.events.push({
        t: 'cue',
        slot: f.slot,
        titan: f.def.id,
        id: 'ocean-boil',
        x: t.x,
        y: t.y,
        amount: 1 - this.oceanFrac,
      });
    }
    const cr = f.view.bodyStats.crackedCells;
    if (cr > this.cracked + 350) {
      this.cracked = cr;
      f.events.push({
        t: 'cue',
        slot: f.slot,
        titan: f.def.id,
        id: 'crust-crack',
        x: t.x,
        y: t.y,
        amount: clamp01(cr / 3000),
      });
    }
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  drawing
   * ---------------------------------------------------------------------------------------------- */

  private draw(tick: number, m: ActiveMove): void {
    const f = this.f;
    const map = f.body.map;
    // skin + glow every third tick (clouds drift slowly; the reveal only changes with the map)
    if (tick % 3 === 0 || map.version !== this.lastVer) {
      if (tick % 3 === 0 || this.redraw++ % 2 === 0) {
        this.drawSkin(tick);
        this.drawGlow(tick);
        this.lastVer = map.version;
      }
    }
    this.drawFx(tick, m);
  }

  private stampExposure(): boolean {
    const f = this.f;
    const map = f.body.map;
    const W = map.w;
    const H = map.h;
    const expo = this.expo;
    expo.fill(0);
    const fl = map.flags;
    const mat = map.material;
    const ids = this.rig.ids;
    let any = false;
    for (let y = 3; y < H - 3; y++)
      for (let x = 3; x < W - 3; x++) {
        const i = y * W + x;
        if (mat[i] === 0 || (fl[i]! & CellFlag.SURFACE) === 0) continue;
        for (let dy = -3; dy <= 3; dy++)
          for (let dx = -3; dx <= 3; dx++) {
            const j = i + dy * W + dx;
            if (mat[j] !== 0 && INTERIOR(ids, mat[j]!)) {
              expo[j] = 1;
              any = true;
            }
          }
      }
    return any;
  }

  private drawSkin(tick: number): void {
    const f = this.f;
    const map = f.body.map;
    const S = this.skin;
    S.clear();
    const W = map.w;
    const H = map.h;
    const mat = map.material;
    const ids = this.rig.ids;
    const rig = this.rig;
    const anyExpo = this.stampExposure();
    const clouds = rig.clouds;
    const px = S.px;
    const em = S.emis!;
    const density = this.atmoFrac;
    const drift = tick * 0.03;
    const cn = this.cloudC;
    let any = false;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const mm = mat[i]!;
        if (mm === 0) continue;
        if (anyExpo && this.expo[i] === 1) {
          // the strata the damage exposed: crust, banded mantle, flowing magma, white-hot core
          if (mm === ids.crust) {
            const v = 0.25 + 0.5 * tn(x * 0.5, y * 0.9 + 3) + 0.15 * (((x + y) & 3) === 0 ? 1 : 0);
            px[i] = rampDither(this.crustR, v, x, y);
            em[i] = 0;
          } else if (mm === ids.mantle) {
            const band =
              0.5 +
              0.5 * Math.sin(Math.hypot(x - rig.core.x, y - rig.core.y) * 0.55 + 2.2 * tn(x * 0.3, y * 0.3));
            px[i] = rampDither(this.mantle, 0.45 + 0.5 * band, x, y);
            em[i] = 80;
          } else if (mm === ids.magma) {
            const v = 0.45 + 0.5 * tn(x * 0.35 + tick * 0.09, y * 0.35 - tick * 0.06);
            px[i] = rampDither(this.magma, v, x, y);
            em[i] = 190;
          } else {
            px[i] = rampAt(this.magma, 0.92 + 0.08 * Math.sin(tick * 0.1));
            em[i] = 240;
          }
          any = true;
          continue;
        }
        const nz = rig.nz[i]!;
        if (nz === 0 || density < 0.05) continue;
        if (mm === ids.atmosphere || mm === ids.cloud) continue;
        // drifting clouds over the face, lit like the surface, thinning as the atmosphere is stripped
        const lat = rig.lat[i]!;
        const lx = rig.lon[i]! / 256 + drift * (1 + 0.5 * Math.cos((lat / 127 - 0.5) * Math.PI));
        const l0 = Math.floor(lx);
        const lf = lx - l0;
        const row = lat * 256;
        const d = (clouds[row + (l0 & 255)]! * (1 - lf) + clouds[row + ((l0 + 1) & 255)]! * lf) / 255;
        const foreshorten = (0.45 + 0.55 * (nz / 255)) * Math.min(1, Math.max(0, (nz - 70) / 90));
        const a = d * density * foreshorten * 0.72;
        const thr = 0.12 + 0.55 * bayer(x, y);
        if (a <= thr) continue;
        const lit = this.lit[i]! / 255;
        const v = 0.2 + 0.75 * lit * (0.6 + 0.4 * a);
        px[i] =
          0xff000000 | (cn[Math.min(cn.length - 1, Math.round(clamp01(v) * (cn.length - 1)))]! & 0xffffff);
        any = true;
      }
    if (any) S.mark();
    S.commit();
  }

  private drawGlow(tick: number): void {
    const f = this.f;
    const map = f.body.map;
    const G = this.glow;
    G.clear();
    const fl = map.flags;
    const mat = map.material;
    const W = map.w;
    const H = map.h;
    const ids = this.rig.ids;
    const px = G.px;
    const em = G.emis!;
    let any = false;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const mm = mat[i]!;
        if (mm === 0) continue;
        if ((fl[i]! & CellFlag.CRACKED) !== 0) {
          // magma light leaking through the fissures: brighter the deeper the crack runs
          const deep = mm === ids.crust ? 1 : mm === ids.mantle ? 1.3 : 0.55;
          const flick = 0.55 + 0.45 * tn(x * 0.4 + tick * 0.05, y * 0.4);
          const a = deep * flick;
          px[i] =
            0xff000000 |
            (Math.min(255, 14 * a) << 16) |
            (Math.min(255, 70 * a) << 8) |
            Math.min(255, 130 * a);
          em[i] = Math.min(255, 130 * a);
          any = true;
        } else if (mm === ids.atmosphere && ((i * 2654435761) ^ ((tick >> 2) * 40503)) % 23 === 0) {
          px[i] = 0xff000000 | (90 << 16) | (70 << 8) | 40;
          em[i] = 90;
          any = true;
        }
      }
    if (any) G.mark();
    G.commit();
  }

  private drawFx(tick: number, m: ActiveMove): void {
    const f = this.f;
    const t = f.body.transform;
    const X = this.fx;
    X.begin(t.x, t.y);
    const id = m.def?.id ?? '';
    const at = m.phase === 'active' ? m.phaseTick - 1 : -1;
    const R = this.rig.radius;
    const dir = f.facing;
    // moon ribbons in flight
    for (const mo of this.moons) {
      if (mo.mode === SLAM) {
        const pos = (u: number, out: { x: number; y: number }): void => {
          const q = clamp(u, 0, 1) * 12;
          const k = Math.min(12, Math.floor(q));
          const fr = q - k;
          out.x = mo.tx[k]! + (mo.tx[k + 1]! - mo.tx[k]!) * fr;
          out.y = mo.ty[k]! + (mo.ty[k + 1]! - mo.ty[k]!) * fr;
        };
        ribbon(X, pos, 1, 0, 60, 1, mo.radius * 0.55, tick, this.flame);
        glowD(X, mo.x, mo.y, mo.radius * 2.2, 200, 190, 230, 0.35);
      }
    }
    if (id === 'planet.nudge' && m.phase === 'active' && f.liveHitShape(0, at, this.tmp)) {
      const s = this.tmp;
      const q = at / 8;
      ringBand(
        X,
        s.x,
        s.y,
        s.r * (0.6 + q),
        s.r * (0.9 + q) + 3,
        tick,
        this.mantle,
        1 - 0.6 * q,
        [0, Math.PI * 2],
        0.9,
      );
      glowD(X, s.x, s.y, s.r * 1.4, 120, 170, 255, 0.35 * (1 - q));
    }
    if (id === 'planet.impact') {
      if (m.phase === 'startup') {
        const q = clamp01(m.phaseTick / m.startup);
        for (let i = 0; i < 26; i++) {
          const a = i * 2.399 + tick * 0.05;
          const rr = (R + 60) * (1 - q) * (0.5 + (0.5 * ((i * 37) % 10)) / 10) + R * 0.6;
          X.set(
            Math.round(t.x + Math.cos(a) * rr),
            Math.round(t.y + Math.sin(a) * rr * 0.8),
            rampAt(this.mantle, 0.5 + 0.5 * q),
            200,
          );
        }
      } else if (m.phase === 'active' && f.liveHitShape(0, at, this.tmp)) {
        const s = this.tmp;
        const q = at / 8;
        ringBand(
          X,
          s.x,
          s.y + 6,
          10 + 120 * q,
          16 + 132 * q,
          tick,
          this.magma,
          1.1 - 0.6 * q,
          [0, Math.PI * 2],
          0.34,
        );
        glowD(X, s.x, s.y, 50 * (1 - q) + 10, 255, 190, 110, 0.6 * (1 - q));
      }
    }
    if (id === 'planet.moonslam' && (m.phase === 'startup' || m.phase === 'charge')) {
      const moon = this.pickMoon();
      if (moon) {
        // an aiming line of dots from the chosen moon toward the aim point, brightening with charge
        let ax = this.aimX;
        let ay = this.aimY;
        if (Math.hypot(ax, ay) < 0.3) {
          ax = f.foe.view.x - moon.x;
          ay = f.foe.view.y - moon.y;
        }
        const l = Math.hypot(ax, ay) || 1;
        const cf = m.phase === 'charge' ? clamp01(m.chargeTicks / Math.max(1, m.chargeMax)) : 0.2;
        for (let d = 24; d < 170 + 130 * cf; d += 7)
          X.set(
            Math.round(moon.x + (ax / l) * d),
            Math.round(moon.y + (ay / l) * d),
            rampAt(this.magma, 0.5 + 0.5 * cf),
            180,
          );
        glowD(X, moon.x, moon.y, moon.radius * (1.8 + 1.2 * cf), 255, 170, 90, 0.4 * (0.4 + cf));
      }
    }
    if (id === 'planet.cataclysm') {
      const fv = f.foe.view;
      if (m.phase === 'startup') {
        const q = clamp01(m.phaseTick / m.startup);
        // gravity: rings collapse onto the foe
        for (let k = 0; k < 3; k++) {
          const u = (q * 1.5 + k / 3) % 1;
          ringBand(
            X,
            fv.x,
            fv.y,
            150 * (1 - u),
            150 * (1 - u) + 3,
            tick + k * 5,
            this.mantle,
            0.4 + 0.8 * q,
            [0, Math.PI * 2],
            0.7,
          );
        }
      } else if (m.phase === 'active') {
        if (at < 52) {
          for (let k = 0; k < 3; k++) {
            const u = (at * 0.03 + k / 3) % 1;
            ringBand(
              X,
              fv.x,
              fv.y,
              100 * (1 - u),
              100 * (1 - u) + 3,
              tick + k * 5,
              this.magma,
              1,
              [0, Math.PI * 2],
              0.7,
            );
          }
        } else if (f.liveHitShape(1, Math.min(at, 61), this.tmp)) {
          const s = this.tmp;
          const q = clamp01((at - 52) / 12);
          ringBand(
            X,
            s.x,
            s.y + 20,
            20 + 190 * q,
            30 + 200 * q,
            tick,
            this.magma,
            1.2 - 0.7 * q,
            [0, Math.PI * 2],
            0.36,
          );
          glowD(X, s.x, s.y, 80 * (1 - q) + 12, 255, 200, 120, 0.8 * (1 - q));
        }
      }
    }
    void dir;
    X.end();
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  plumbing
   * ---------------------------------------------------------------------------------------------- */

  override renderLayers(_view: ViewRect, _alpha: number, out: RenderLayer[]): void {
    const f = this.f;
    const body = out[out.length - 1]!;
    this.skin.follow(body);
    this.glow.follow(body);
    const t = f.body.transform;
    this.halo.place(t.x, t.y, body.prevX, body.prevY, 0.28 + 0.5 * this.atmoFrac);
    out.push(this.halo.layer, this.skin.layer, this.glow.layer);
    for (const mo of this.moons) {
      if (mo.mode === GONE) continue;
      mo.layer.flush(mo.back ? -1 : 1);
      mo.layer.layer.visible = true;
      out.push(mo.layer.layer);
    }
    out.push(this.fx.layer);
  }

  override debugShapes(out: DebugShape[]): void {
    for (const mo of this.moons) {
      if (mo.mode === GONE) continue;
      const s = makeFatShape();
      s.kind = 'point';
      s.x = mo.x;
      s.y = mo.y;
      s.r = mo.radius;
      out.push({ shape: asShape(s), color: mo.mode === SLAM ? 0xff3040ff : 0xffe0b060, label: 'moon' });
    }
  }

  /** Test access. */
  shapeTouchesMoon(shape: DamageShape): boolean {
    for (const mo of this.moons)
      if (mo.mode !== GONE && shapeIntersectsDisc(shape, mo.x, mo.y, mo.radius)) return true;
    return false;
  }
  get updatedAt(): number {
    return this.tickLast;
  }
  moonFrac(i: number): number {
    const mo = this.moons[i];
    return mo && mo.mode !== GONE ? this.f.world.stats(mo.body.id).massFrac : 0;
  }
}
