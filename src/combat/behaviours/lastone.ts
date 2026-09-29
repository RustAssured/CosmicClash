import {
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
  type OverlapResult,
  type RenderLayer,
  type ViewRect,
} from '@/contracts';
import { blend, type LastOneRig } from '@/titans';
import { Behaviour, type HitInfo, type InterceptResult } from '../behaviour';
import type { FighterImpl } from '../fighter';
import { Overlay } from '../fx/overlay';
import type { ActiveMove } from '../move';
import { asShape, makeFatShape, shapeIntersectsDisc } from '../shapes';
import { NODES, TendrilSystem, makeTendrilPalette, type Posture, type TendrilPalette } from './tendrils';

const ALPHA_EYE = 0.75;
const ease = (cur: number, target: number, rate: number): number => cur + (target - cur) * rate;
const C_PUPIL_D = hex('#02070b');
const C_PUPIL_M = hex('#0b232b');
const C_IRIS_GOLD = hex('#f0c860');
const C_IRIS_TEAL = hex('#2f9a86');
/** Ticks without being hit before a tendril starts to regrow, and between regrowth steps. */
const REGROW_QUIET = 150;
const REGROW_EVERY = 7;
/** How much of a blow's energy becomes tendril damage, and the soak per tendril in the path. */
const TENDRIL_DAMAGE = 0.42;
const SOAK_PER_TENDRIL = 0.05;
const SOAK_MAX = 0.35;
/** Extra damage to the eye per unit of exposure (tendrils lost / total). */
const EXPOSURE_GAIN = 0.9;

/**
 * THE LAST ONE. Tendrils (verlet chains) are the eye's shield: blows sweep through them first, they sever one by one, and as
 * they fall the eye is exposed and takes extra damage. A quiet tendril regrows (Patient Regrowth). Also owns the secondary
 * animation: eye tracking + blink overlay, halo glow, beam and eye-flare FX, tendril afterimages.
 */
export class LastOneBehaviour extends Behaviour {
  private rig!: LastOneRig;
  private sys!: TendrilSystem;
  private pal!: TendrilPalette;
  private back!: Overlay;
  private front!: Overlay;
  private eye!: Overlay;
  private fx!: Overlay;
  private readonly post: Posture = { guard: 0, rise: 0, focus: 0, limp: 0, agitation: 0, eyeX: 0, eyeY: 0 };
  private readonly xy = { x: 0, y: 0 };
  private readonly wp = { x: 0, y: 0 };
  private readonly cut = { lost: 0, x: 0, y: 0 };
  private readonly tmpShape = makeFatShape();
  private readonly hitNode = new Int8Array(64);
  private gazeX = 0;
  private gazeY = 0;
  private regrowClock = 0;
  private flare = 0;
  private haloGlow = 0;
  private trailCount = 0;
  private readonly trail: Float32Array;
  private trailHead = 0;
  private readonly extraEv: DamageEvent;
  private readonly extraShape = makeFatShape();
  private lastCueTick = -99;
  private prevAlive = 0;
  private shardRamp: number[] = [];
  private moteRamp: number[] = [];

  constructor(f: FighterImpl) {
    super(f);
    this.trail = new Float32Array(4 * 24 * NODES * 2);
    this.extraEv = {
      type: 'FRACTURE',
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
      params: { penetration: 10 },
    };
  }

  override attach(): void {
    const f = this.f;
    this.rig = f.rig as LastOneRig;
    this.sys = new TendrilSystem(this.rig.roots);
    const shell = f.def.materials.find((m) => m.key === 'shell')!.visual.ramp;
    const gilt = f.def.materials.find((m) => m.key === 'gilt')!.visual.ramp;
    this.pal = makeTendrilPalette(shell, gilt);
    this.shardRamp = this.pal.body.slice(3, 7);
    this.moteRamp = this.pal.tip.slice(2);
    this.back = new Overlay('lastone-tendrils-back', -1, 320, 300, 'normal', true);
    this.front = new Overlay('lastone-tendrils-front', 1, 320, 300, 'normal', true);
    this.eye = new Overlay('lastone-eye', 0.5, 64, 64, 'normal');
    this.fx = new Overlay('lastone-fx', 20, 512, 352, 'add', true);
    f.resourceMax = this.sys.n;
    f.resource = this.sys.n;
    this.prevAlive = this.sys.n;
    this.regrowClock = 0;
    this.sys.settle(f.body.transform);
    this.trailCount = 0;
  }

  override reset(heal: number): void {
    const f = this.f;
    this.sys.heal(Math.max(heal, 0.5), f.body.transform);
    this.sys.settle(f.body.transform);
    this.trailCount = 0;
    this.flare = 0;
    for (const k of ['guard', 'rise', 'focus', 'limp', 'agitation'] as const) this.post[k] = 0;
    f.resource = this.sys.aliveCount();
    this.prevAlive = f.resource;
    this.regrowClock = 0;
  }

  get tendrilsAlive(): number {
    return this.sys.aliveCount();
  }

  /** Remaining tendril length, 0..1. */
  get tendrilLength(): number {
    return this.sys.lengthFrac();
  }

  /** Multiplier on the Guard shell: the tendrils are the shield, so it thins as they die. */
  override guardMultiplier(): number {
    return 0.3 + 0.7 * (this.sys.aliveCount() / this.sys.n);
  }

  override adjustStats(_s: EffectiveStats, _massFrac: number): void {
    // Last One has no passive stat modifiers: the failure mode is the exposed eye (see intercept)
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  hits
   * ---------------------------------------------------------------------------------------------- */

  override probeParts(shape: DamageShape, out: OverlapResult): number {
    const f = this.f;
    if (f.ko) return 0;
    let hits = 0;
    let sx = 0;
    let sy = 0;
    const s = this.sys;
    for (let i = 0; i < s.n; i++) {
      const cnt = s.count[i]!;
      if (cnt < 4) continue;
      const base = i * NODES;
      for (let k = 2; k < cnt; k++) {
        const x = s.x[base + k]!;
        const y = s.y[base + k]!;
        if (shapeIntersectsDisc(shape, x, y, 2.6)) {
          hits++;
          sx += x;
          sy += y;
          break;
        }
      }
    }
    if (hits > 0) {
      if (out.cells === 0) {
        out.x = sx / hits;
        out.y = sy / hits;
        out.nearestX = out.x;
        out.nearestY = out.y;
        out.coverage = Math.max(out.coverage, 0.1);
      }
      out.cells += hits;
    }
    return hits;
  }

  override intercept(ev: DamageEvent, info: HitInfo, res: InterceptResult): void {
    const f = this.f;
    const s = this.sys;
    // which tendrils does the blow sweep through, and where along each?
    let touched = 0;
    for (let i = 0; i < s.n; i++) {
      this.hitNode[i] = 0;
      const cnt = s.count[i]!;
      if (cnt < 4) continue;
      const base = i * NODES;
      for (let k = 2; k < cnt; k++) {
        if (shapeIntersectsDisc(ev.shape, s.x[base + k]!, s.y[base + k]!, 2.6)) {
          this.hitNode[i] = k;
          touched++;
          break;
        }
      }
    }
    if (touched > 0) {
      this.regrowClock = 0;
      res.touched = true;
      res.partsHit = touched;
      const soak = clamp(touched * SOAK_PER_TENDRIL, 0, SOAK_MAX) * (info.continuous ? 0.4 : 1);
      res.absorbed = soak;
      const perTendril = (ev.energy * TENDRIL_DAMAGE * (info.continuous ? 0.5 : 1)) / Math.sqrt(touched);
      for (let i = 0; i < s.n; i++) {
        const k = this.hitNode[i]!;
        if (k === 0) continue;
        if (s.damage(i, k, perTendril, this.cut)) this.onSever(info);
      }
    }
    // the exposed eye: tendrils lost ⇒ extra damage when the blow reaches the eye
    const exposure = 1 - s.aliveCount() / s.n;
    if (exposure > 0.04) {
      const t = f.body.transform;
      localToWorld(t, this.rig.eye.x + 0.5, this.rig.eye.y + 0.5, this.xy);
      const er = this.rig.eye.r * ALPHA_EYE;
      if (shapeIntersectsDisc(ev.shape, this.xy.x, this.xy.y, er)) {
        const extra = ev.energy * (1 - res.absorbed) * exposure * EXPOSURE_GAIN;
        if (extra >= 1) {
          const e2 = this.extraEv;
          const sh = this.extraShape;
          sh.kind = 'point';
          sh.x = this.xy.x;
          sh.y = this.xy.y;
          sh.r = er;
          e2.type = ev.type;
          e2.energy = extra;
          e2.dirX = ev.dirX;
          e2.dirY = ev.dirY;
          e2.sourceMass = ev.sourceMass;
          e2.sourceBodyId = ev.sourceBodyId;
          e2.originX = ev.originX;
          e2.originY = ev.originY;
          e2.flags = 0;
          const r = f.world.applyDamage(f.body.id, e2);
          res.extraCells += r.cellsRemoved;
          res.extraMass += r.massRemoved;
          res.touched = true;
          if (this.f.tickNo - this.lastCueTick > 8) {
            this.lastCueTick = this.f.tickNo;
            f.events.push({
              t: 'cue',
              slot: f.slot,
              titan: f.def.id,
              id: 'eye-exposed',
              x: this.xy.x,
              y: this.xy.y,
              amount: exposure,
            });
          }
        }
      }
    }
  }

  private onSever(info: HitInfo): void {
    const f = this.f;
    const c = this.cut;
    f.events.push({
      t: 'cue',
      slot: f.slot,
      titan: f.def.id,
      id: 'tendril-sever',
      x: c.x,
      y: c.y,
      amount: c.lost,
    });
    // celadon shards + golden motes where it parted
    const sp = f.particleSpawn;
    sp.kind = 'shard';
    sp.x = c.x;
    sp.y = c.y;
    sp.vx = info.knockX * 0.3;
    sp.vy = -40;
    sp.spread = 90;
    sp.count = 3;
    sp.ramp = this.shardRamp;
    sp.life = [20, 44];
    sp.fieldScale = 0.6;
    sp.emissive = 30;
    sp.size = 1;
    sp.drag = 0.8;
    f.world.spawnParticles(sp);
    sp.kind = 'mote';
    sp.count = 4;
    sp.ramp = this.moteRamp;
    sp.emissive = 200;
    sp.spread = 60;
    f.world.spawnParticles(sp);
    this.regrowClock = 0;
  }

  override onDamaged(energy: number, dx: number, dy: number): void {
    this.sys.recoil(dx * Math.min(6, energy / 90), dy * Math.min(6, energy / 90));
    this.regrowClock = 0;
  }

  override onKo(): void {
    this.post.limp = 0.01;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  per tick
   * ---------------------------------------------------------------------------------------------- */

  override onMoveStart(m: ActiveMove): void {
    if (m.def?.slot === 'surge') this.trailCount = 0;
  }

  override update(_ctx: FighterTickCtx): void {
    const f = this.f;
    const t = f.body.transform;
    const m = f.mv;
    const tick = f.tickNo;
    localToWorld(t, this.rig.eye.x + 0.5, this.rig.eye.y + 0.5, this.xy);
    const P = this.post;
    P.eyeX = this.xy.x;
    P.eyeY = this.xy.y;

    // ---- posture targets (smoothed) ----
    const id = m.def?.id ?? '';
    const slot = m.def?.slot;
    P.guard = ease(P.guard, f.guardUp ? 1 : 0, 0.22);
    let rise = 0;
    if (slot === 'ultimate') {
      rise =
        m.phase === 'startup'
          ? smoothstep(0, m.startup, m.phaseTick)
          : m.phase === 'active'
            ? 1
            : 1 - clamp01(m.phaseTick / m.recovery);
    }
    P.rise = ease(P.rise, rise, 0.1);
    let focus = 0;
    if (id === 'lastone.gaze' && (m.phase === 'startup' || m.phase === 'charge')) {
      focus =
        m.phase === 'charge'
          ? 0.4 + 0.6 * clamp01(m.chargeTicks / Math.max(1, m.chargeMax))
          : 0.25 * (m.phaseTick / m.startup);
    }
    P.focus = ease(P.focus, focus, 0.15);
    P.limp = f.ko ? ease(P.limp, 1, 0.04) : 0;
    const spd = Math.hypot(f.vx, f.vy);
    P.agitation = ease(P.agitation, clamp01(spd / 260), 0.15);

    // ---- scripted whip targets ----
    this.steerWhips(m);

    this.sys.step(t, P, f.vx, f.vy, tick);

    // ---- passive: patient regrowth ----
    this.regrowClock++;
    if (!f.ko && this.regrowClock > REGROW_QUIET && this.regrowClock % REGROW_EVERY === 0) {
      this.sys.regrowStep();
    }
    // HUD pips follow remaining tendril length; announce every change so the HUD can animate it
    const alive = this.sys.aliveCount();
    if (alive !== this.prevAlive) {
      f.events.push({
        t: 'resource',
        slot: f.slot,
        kind: alive > this.prevAlive ? 'gain' : 'spend',
        amount: Math.abs(alive - this.prevAlive),
      });
      this.prevAlive = alive;
    }
    f.resource = alive;
    f.view.parts = alive;

    // ---- afterimage during Sidestep ----
    if (slot === 'surge' && (tick & 1) === 0) this.pushTrail();
    else if (slot !== 'surge' && this.trailCount > 0 && (tick & 1) === 0) this.trailCount--;

    this.drawAll(tick, id, slot, m);
  }

  /** Drive whip tips from the live hitbox shapes so the tendrils physically carry the blow. */
  private steerWhips(m: ActiveMove): void {
    const s = this.sys;
    const f = this.f;
    const dir = f.facing;
    // scripted targets fade quickly unless re-asserted below (whips let go the moment their hitbox window closes)
    const decay = m.phase === 'active' ? 0.3 : 0.7;
    for (let i = 0; i < s.n; i++) s.tw[i] = s.tw[i]! * decay;
    if (!m.def || m.feint) return;
    const t = f.body.transform;
    const isLash = m.def.id === 'lastone.lash' || m.def.id === 'lastone.lunge';
    const heavy = m.def.id === 'lastone.shatter';
    if (!isLash && !heavy) return;
    if (m.phase === 'startup') {
      // wind up: whips draw back behind the body
      const w = clamp01(m.phaseTick / Math.max(3, m.startup * 0.8));
      for (let i = 0; i < s.n; i++) {
        const kind = s.roots[i]!.kind;
        if (kind === 'crown') continue;
        s.tx[i] = t.x - dir * (40 + (i % 4) * 8);
        s.ty[i] = t.y - 30 + (i % 4) * 22;
        s.tw[i] = Math.max(s.tw[i]!, 0.55 * w);
      }
    } else if (m.phase === 'active') {
      const at = m.phaseTick - 1;
      let group = 0;
      for (let k = 0; k < (m.variant?.hitboxes.length ?? 0); k++) {
        if (!f.liveHitShape(k, at, this.tmpShape)) continue;
        const sh = this.tmpShape;
        const hb = m.variant!.hitboxes[k]!;
        if (sh.kind === 'line' && at >= hb.from - 1 && at < hb.to + 2) {
          for (let i = 0; i < s.n; i++) {
            const kind = s.roots[i]!.kind;
            if ((kind === 'hem' || kind === 'front') && i % 4 === group % 4) {
              s.tx[i] = sh.x1;
              s.ty[i] = sh.y1 + ((i >> 2) % 3) * 4 - 4;
              s.tw[i] = 1;
            }
          }
          group++;
        } else if (sh.kind === 'cone') {
          const tipX = sh.x + sh.dirX * sh.range;
          const tipY = sh.y + sh.dirY * sh.range;
          for (let i = 0; i < s.n; i++) {
            const kind = s.roots[i]!.kind;
            if (kind === 'crown') continue;
            s.tx[i] = tipX + ((i % 5) - 2) * 6;
            s.ty[i] = tipY + ((i % 3) - 1) * 10;
            s.tw[i] = 0.9;
          }
        }
      }
    }
  }

  private pushTrail(): void {
    const s = this.sys;
    const size = s.n * NODES * 2;
    const off = (this.trailHead & 3) * size;
    for (let i = 0; i < s.n * NODES; i++) {
      this.trail[off + i * 2] = s.x[i]!;
      this.trail[off + i * 2 + 1] = s.y[i]!;
    }
    this.trailHead++;
    this.trailCount = Math.min(4, this.trailCount + 1);
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  drawing
   * ---------------------------------------------------------------------------------------------- */

  private drawAll(tick: number, id: string, slot: string | undefined, m: ActiveMove): void {
    const f = this.f;
    const t = f.body.transform;
    const glow = clamp01(
      0.35 + this.post.focus * 0.9 + (f.guardUp ? 0.3 : 0) + (slot === 'ultimate' ? 0.6 : 0),
    );

    // tendrils behind and in front of the body. A calm, near-stationary Last One redraws them every other tick (their idle sway is
    // slow and the renderer interpolates the layer position), which halves the cost of the most expensive raster in the module.
    const calm =
      (f.state === 'idle' || f.state === 'move' || f.state === 'intro') &&
      Math.hypot(f.vx, f.vy) < 60 &&
      this.trailCount === 0;
    if (!calm || (tick & 1) === 0 || !this.back.layer.visible) {
      this.back.begin(t.x, t.y);
      this.sys.draw(this.back, false, this.pal, glow);
      if (this.trailCount > 0) this.drawAfterimage(this.back, tick);
      this.back.end();
      this.front.begin(t.x, t.y);
      this.sys.draw(this.front, true, this.pal, glow);
      this.front.end();
    }

    this.drawEye(tick, id);
    this.drawFx(tick, id, slot, m);
  }

  /** Pale ghosts of the tendrils along the sidestep path, dissolving. */
  private drawAfterimage(ov: Overlay, tick: number): void {
    const s = this.sys;
    const size = s.n * NODES * 2;
    const ghost = blend(this.pal.body[5]!, this.pal.tip[3]!, 0.25);
    for (let g = 0; g < this.trailCount; g++) {
      const off = ((this.trailHead - 1 - g) & 3) * size;
      const keep = 0.75 - g * 0.2;
      for (let i = 0; i < s.n; i++) {
        const cnt = s.count[i]!;
        if (cnt < 3) continue;
        for (let k = 1; k < cnt; k++) {
          const j = (i * NODES + k) * 2;
          const x = Math.round(this.trail[off + j]!);
          const y = Math.round(this.trail[off + j + 1]!);
          if (((x * 5 + y * 11 + tick) & 7) / 8 < keep - k * 0.02) ov.set(x, y, ghost, 90);
        }
      }
    }
  }

  private drawEye(tick: number, id: string): void {
    const f = this.f;
    const t = f.body.transform;
    const map = f.body.map;
    const ids = this.rig.ids;
    const ov = this.eye;
    const R = this.rig.eye.r;
    const ex = this.rig.eye.x;
    const ey = this.rig.eye.y;
    if (f.ko && f.stateTicks > 30) {
      ov.hide();
      return;
    }
    // gaze: toward the foe, a few px, smoothed (the eye leads the body)
    const fv = f.foe.view;
    let gx = fv.x - f.px;
    let gy = fv.y - f.py - 20;
    const gl = Math.hypot(gx, gy) || 1;
    const reach = 3.2;
    gx = (gx / gl) * reach * clamp01(gl / 60);
    gy = (gy / gl) * reach * clamp01(gl / 60) * 0.8;
    const lx = gx * t.facing;
    this.gazeX += (lx - this.gazeX) * 0.2;
    this.gazeY += (gy - this.gazeY) * 0.2;
    // blink: a quick lid sweep every ~5.5 s (never in the middle of a Gaze)
    const bt = (tick + f.slot * 97) % 330;
    let lid = 0;
    if (bt < 8 && id !== 'lastone.gaze' && !f.ko) lid = 1 - Math.abs((bt - 4) / 4);
    if (f.ko) lid = clamp01(f.stateTicks / 20) * 0.7;
    if (f.state === 'hitstun') lid = Math.max(lid, 0.5);

    localToWorld(t, ex + 0.5, ey + 0.5, this.xy);
    ov.begin(this.xy.x, this.xy.y);
    const pupilD = C_PUPIL_D;
    const pupilM = C_PUPIL_M;
    const irisGold = C_IRIS_GOLD;
    const irisTeal = C_IRIS_TEAL;
    const lidHi = this.pal.body[5]!;
    const lidMid = this.pal.body[3]!;
    const lidLo = this.pal.body[1]!;
    const wpos = this.wp;
    const Ri = Math.ceil(R);
    for (let dy = -Ri; dy <= Ri; dy++) {
      for (let dx = -Ri; dx <= Ri; dx++) {
        const lx0 = Math.round(ex) + dx;
        const ly0 = Math.round(ey) + dy;
        if (lx0 < 0 || ly0 < 0 || lx0 >= map.w || ly0 >= map.h) continue;
        const idx = ly0 * map.w + lx0;
        const mat = map.material[idx]!;
        if (mat !== ids.pupil && mat !== ids.iris && mat !== ids.eye) continue;
        if (map.integrity[idx]! === 0) continue;
        const q = Math.hypot(dx, dy);
        let c = 0;
        // the map's pupil disc is re-painted as iris centre; the moving pupil is drawn on top
        const pr = Math.hypot(dx - this.gazeX, dy - this.gazeY);
        if (mat === ids.pupil || (mat === ids.iris && q < 8)) {
          if (pr < 5.4) c = pr < 3.4 ? pupilD : pupilM;
          else if (mat === ids.pupil) c = q < 4.5 ? blend(irisGold, irisTeal, 0.3) : irisGold;
        }
        if (lid > 0.02) {
          const lidEdge = -R + lid * 2 * R * 0.95;
          if (dy < lidEdge && q < R + 0.5)
            c = dy > lidEdge - 1.6 ? lidLo : dy > lidEdge - 3.5 ? lidMid : lidHi;
        }
        if (c !== 0) {
          localToWorld(t, lx0 + 0.5, ly0 + 0.5, wpos);
          ov.set(Math.floor(wpos.x), Math.floor(wpos.y), c, mat === ids.pupil ? 0 : 60);
        }
      }
    }
    ov.end();
  }

  private drawFx(tick: number, id: string, slot: string | undefined, m: ActiveMove): void {
    const f = this.f;
    const t = f.body.transform;
    const fx = this.fx;
    fx.begin(t.x, t.y);

    // ---- eye flare (Shatter Blow) & gaze charge ----
    let flare = 0;
    if (m.def?.extra?.['eyeFlare'] && !m.feint) {
      if (m.phase === 'startup') flare = 0.25 + 0.75 * (m.phaseTick / Math.max(1, m.startup));
      else if (m.phase === 'active') flare = 1;
      else flare = Math.max(0, 1 - m.phaseTick / 10);
    }
    if (id === 'lastone.gaze') {
      if (m.phase === 'startup') flare = 0.2 + 0.3 * (m.phaseTick / m.startup);
      else if (m.phase === 'charge') flare = 0.5 + 0.5 * clamp01(m.chargeTicks / m.chargeMax);
      else if (m.phase === 'active') flare = 1;
      else flare = Math.max(0, 0.6 - m.phaseTick / 40);
    }
    if (slot === 'ultimate') flare = Math.max(flare, this.post.rise * 0.9);
    this.flare += (flare - this.flare) * 0.35;
    if (this.flare > 0.02) {
      const pulse = 1 + 0.12 * Math.sin(tick * 0.6);
      fx.glow(
        this.post.eyeX,
        this.post.eyeY,
        (10 + 26 * this.flare) * pulse,
        255,
        230,
        150,
        0.55 * this.flare,
      );
      if (this.flare > 0.6) fx.glow(this.post.eyeX, this.post.eyeY, 8 * this.flare, 255, 255, 240, 0.9);
    }
    // ---- converging sparks while charging the Gaze ----
    if (id === 'lastone.gaze' && m.phase === 'charge') {
      const c = clamp01(m.chargeTicks / m.chargeMax);
      for (let k = 0; k < 6; k++) {
        const a = k * 1.047 + tick * 0.11;
        const r = 34 * (1 - ((tick * 0.05 + k * 0.17) % 1)) * (0.5 + 0.5 * (1 - c * 0.3));
        fx.glow(
          this.post.eyeX + Math.cos(a) * r,
          this.post.eyeY + Math.sin(a) * r,
          2.6,
          255,
          225,
          140,
          0.9 * (0.4 + c),
        );
      }
    }
    // ---- beams ----
    if (m.def?.tags.includes('beam') && m.phase === 'active' && !m.feint) {
      const hbs = m.variant?.hitboxes ?? [];
      const at = m.phaseTick - 1;
      for (let k = 0; k < hbs.length; k++) {
        const hb = hbs[k]!;
        if (hb.shape.kind !== 'line' || at < hb.from || at >= hb.to) continue;
        if (!f.liveHitShape(k, at, this.tmpShape)) continue;
        this.drawBeam(
          fx,
          this.tmpShape.x0,
          this.tmpShape.y0,
          this.tmpShape.x1,
          this.tmpShape.y1,
          this.tmpShape.width,
          tick,
          slot === 'ultimate',
        );
      }
    }
    // ---- halo ----
    let halo = 0.16 + 0.05 * Math.sin(tick * 0.05 + f.slot);
    if (slot === 'ultimate')
      halo =
        m.phase === 'startup'
          ? 0.2 + 0.8 * smoothstep(0, m.startup, m.phaseTick)
          : m.phase === 'active'
            ? 1
            : 0.8 * (1 - m.phaseTick / m.recovery);
    else if (id === 'lastone.gaze') halo = Math.max(halo, this.flare * 0.7);
    else if (m.def?.extra?.['eyeFlare']) halo = Math.max(halo, this.flare * 0.6);
    this.haloGlow += (halo - this.haloGlow) * 0.2;
    if (this.haloGlow > 0.03) this.drawHalo(fx, tick);
    fx.end();
  }

  /**
   * A beam, evaluated per pixel from its distance to the axis (so a diagonal beam has no holes or dotting): a hot white core,
   * an amber body that reddens toward its edge, and a soft additive halo, with a slow shimmer travelling along its length.
   */
  private drawBeam(
    fx: Overlay,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    width: number,
    tick: number,
    big: boolean,
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const halfW = Math.max(3, width * 0.5);
    const reach = halfW * (big ? 2.1 : 1.6);
    const bx0 = Math.max(fx.ox, Math.floor(Math.min(x0, x1) - reach));
    const bx1 = Math.min(fx.ox + fx.w - 1, Math.ceil(Math.max(x0, x1) + reach));
    const by0 = Math.max(fx.oy, Math.floor(Math.min(y0, y1) - reach));
    const by1 = Math.min(fx.oy + fx.h - 1, Math.ceil(Math.max(y0, y1) + reach));
    const phase = tick * 0.9;
    for (let y = by0; y <= by1; y++) {
      const py = y + 0.5 - y0;
      for (let x = bx0; x <= bx1; x++) {
        const px = x + 0.5 - x0;
        const along = px * ux + py * uy;
        if (along < -halfW || along > len) continue;
        const perp = Math.abs(py * ux - px * uy);
        if (perp > reach) continue;
        const s = along > 0 ? along / len : 0;
        const w = halfW * (1 - s * 0.4);
        const u = perp / w;
        const shimmer = 0.5 + 0.5 * Math.sin(along * 0.28 - phase);
        // brightness along the beam: full at the eye, a little dimmer at the far end, a soft round cap behind the source
        const cap = (along < 0 ? 1 + along / halfW : 1) * (s > 0.84 ? (1 - s) / 0.16 : 1);
        if (cap <= 0) continue;
        let r: number;
        let g: number;
        let b: number;
        const core = 0.26 + 0.08 * shimmer;
        if (u < core) {
          r = 255;
          g = 250;
          b = 232;
        } else if (u < 1) {
          const q = (u - core) / (1 - core);
          r = 255;
          g = 226 - 96 * q;
          b = 165 - 118 * q;
        } else {
          const q = Math.max(0, 1 - (u - 1) / (reach / w - 1));
          const k = q * q;
          r = 150 * k;
          g = 84 * k;
          b = 34 * k;
        }
        fx.add(x, y, r * cap, g * cap, b * cap);
      }
    }
    // source flare
    fx.glow(x0, y0, halfW * 1.8, 255, 236, 170, 0.8);
  }

  private drawHalo(fx: Overlay, tick: number): void {
    const f = this.f;
    const t = f.body.transform;
    const map = f.body.map;
    const h = this.rig.halo;
    const c = Math.cos(h.tilt);
    const sn = Math.sin(h.tilt);
    const gilt = this.rig.ids.gilt;
    const strength = this.haloGlow;
    const N = 120;
    const wpos = this.wp;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * 6.2832;
      const ex = Math.cos(a) * h.a;
      const ey = Math.sin(a) * h.b;
      const lx = h.cx + ex * c - ey * sn;
      const ly = h.cy + ex * sn + ey * c;
      const ix = Math.floor(lx);
      const iy = Math.floor(ly);
      if (ix < 0 || iy < 0 || ix >= map.w || iy >= map.h) continue;
      if (map.material[iy * map.w + ix] !== gilt) continue; // only where the halo still exists
      localToWorld(t, lx, ly, wpos);
      const tw = 0.6 + 0.4 * Math.sin(a * 6 - tick * 0.12);
      const k = strength * tw;
      fx.add(Math.floor(wpos.x), Math.floor(wpos.y), 255 * k, 214 * k, 120 * k);
      if (strength > 0.5) fx.glow(wpos.x, wpos.y, 3, 255, 214, 130, 0.25 * strength * tw);
    }
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  Behaviour plumbing
   * ---------------------------------------------------------------------------------------------- */

  override renderLayers(_view: ViewRect, _alpha: number, out: RenderLayer[]): void {
    out.push(this.back.layer, this.front.layer, this.eye.layer, this.fx.layer);
  }

  override debugShapes(out: DebugShape[]): void {
    const sh = makeFatShape();
    sh.kind = 'point';
    sh.x = this.post.eyeX;
    sh.y = this.post.eyeY;
    sh.r = this.rig.eye.r * ALPHA_EYE;
    out.push({ shape: asShape(sh), color: 0xff40ffff, label: 'eye (exposed as tendrils fall)' });
  }
}
