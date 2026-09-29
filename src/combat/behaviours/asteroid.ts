import {
  clamp,
  clamp01,
  hex,
  localToWorld,
  type DamageEvent,
  type DamageShape,
  type DebugShape,
  type EffectiveStats,
  type FighterTickCtx,
  type OverlapResult,
  type RenderLayer,
  type ViewRect,
} from '@/contracts';
import { hash01, type AsteroidRig } from '@/titans';
import { Behaviour, type HitInfo, type InterceptResult } from '../behaviour';
import type { FighterImpl } from '../fighter';
import { Overlay } from '../fx/overlay';
import type { ActiveMove } from '../move';
import { asShape, makeFatShape, shapeIntersectsDisc } from '../shapes';

/** Below this mass fraction the rock loses cohesion (rubble pile); leaves again above the upper bound (hysteresis). */
const RUBBLE_ENTER = 0.35;
const RUBBLE_EXIT = 0.42;
const MOMENTUM_MAX = 5;
const MOMENTUM_HOLD = 150;
const MAX_FRAGS = 12;
const PEBBLES = 6;

interface SwarmCfg {
  count: number;
  speed: number;
  steer: number;
  energy: number;
  radius: number;
  rehit: number;
  life: number;
  orbit: number;
}
interface CascadeCfg {
  count: number;
  life: number;
  sweepFrom: number;
  sweepTo: number;
}

/**
 * THE ASTEROID. Hit-and-run kinetics: orbiting pebbles and dust motes, a lean-sheared tumble, MOMENTUM (consecutive hits speed it
 * up), the RUBBLE PILE failure mode (below ~35% mass: cohesion drops, blows soften, still fast), the steerable Swarm of fragments
 * (each a small KINETIC projectile; survivors re-merge and refund the resource) and the Kessler storm visuals.
 */
export class AsteroidBehaviour extends Behaviour {
  private rig!: AsteroidRig;
  private back!: Overlay;
  private front!: Overlay;
  private fx!: Overlay;
  private ramp: number[] = [];
  private ice: number[] = [];
  private dustRamp: number[] = [];
  private emberRamp: number[] = [];

  /* passives */
  private momentum = 0;
  private momentumClock = 0;
  private rubble = false;
  private shed = 0;
  private regenClock = 0;

  /* swarm */
  private readonly sx = new Float32Array(MAX_FRAGS);
  private readonly sy = new Float32Array(MAX_FRAGS);
  private readonly svx = new Float32Array(MAX_FRAGS);
  private readonly svy = new Float32Array(MAX_FRAGS);
  private readonly sCd = new Int16Array(MAX_FRAGS);
  private readonly sState = new Uint8Array(MAX_FRAGS); // 0 off, 1 out, 2 returning
  private swarmTx = 0;
  private swarmTy = 0;
  private swarmOut = 0;
  private cfg: SwarmCfg | null = null;
  private readonly frag = makeFatShape();
  private readonly dmg = {
    type: 'KINETIC' as const,
    energy: 0,
    duration: 1,
    flags: 0,
    params: { crater: 3, penetration: 4, scatter: 0.8 },
  };
  private leanPhase = 0;
  private lean = 0;
  private readonly xy = { x: 0, y: 0 };
  private trailClock = 0;

  constructor(f: FighterImpl) {
    super(f);
  }

  override attach(): void {
    const f = this.f;
    this.rig = f.rig as AsteroidRig;
    const reg = f.def.materials.find((m) => m.key === 'regolith')!.visual.ramp.map(hex);
    const kam = f.def.materials.find((m) => m.key === 'kamacite')!.visual.ramp.map(hex);
    this.ramp = [reg[2]!, reg[3]!, reg[4]!, reg[5]!, kam[4]!, kam[6]!];
    this.ice = f.def.materials.find((m) => m.key === 'ice')!.visual.ramp.map(hex);
    this.dustRamp = [reg[6]!, reg[5]!, reg[4]!, reg[3]!];
    this.emberRamp = [hex('#fff3c2'), hex('#ffc65a'), hex('#e8783a'), hex('#8a3a26')];
    this.back = new Overlay('asteroid-orbit-back', -1, 288, 256, 'normal', true);
    this.front = new Overlay('asteroid-orbit-front', 1, 288, 256, 'normal', true);
    this.fx = new Overlay('asteroid-fx', 20, 800, 384, 'add', true);
    const sw = f.slotMoves.signature?.extra?.['swarm'] as SwarmCfg | undefined;
    this.cfg = sw ?? null;
    f.resourceMax = f.def.resource.max;
    f.resource = f.def.resource.start;
  }

  override reset(_heal: number): void {
    this.swarmOut = 0;
    this.sState.fill(0);
    this.momentum = 0;
    this.shed = 0;
    this.f.resource = this.f.resourceMax;
    this.rubble = false;
    this.f.body.cohesionScale = 1;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  passives: momentum + rubble pile
   * ---------------------------------------------------------------------------------------------- */

  override adjustStats(s: EffectiveStats, massFrac: number): void {
    if (!this.rubble && massFrac < RUBBLE_ENTER) this.enterRubble();
    else if (this.rubble && massFrac > RUBBLE_EXIT) {
      this.rubble = false;
      this.f.body.cohesionScale = 1;
    }
    s.speedMul *= 1 + 0.055 * this.momentum;
    s.tempoMul *= 1 + 0.04 * this.momentum;
    if (this.rubble) {
      s.damageMul *= 0.8;
      s.reachMul *= 0.94;
    }
  }

  private enterRubble(): void {
    this.rubble = true;
    this.f.body.cohesionScale = 0.55;
    const f = this.f;
    f.events.push({
      t: 'cue',
      slot: f.slot,
      titan: f.def.id,
      id: 'rubble-pile',
      x: f.px,
      y: f.py,
      amount: 1,
    });
  }

  get momentumStacks(): number {
    return this.momentum;
  }
  get isRubble(): boolean {
    return this.rubble;
  }

  override onDealt(_energy: number): void {
    const f = this.f;
    if (this.momentum < MOMENTUM_MAX) {
      this.momentum++;
      f.events.push({
        t: 'cue',
        slot: f.slot,
        titan: f.def.id,
        id: 'momentum',
        x: f.px,
        y: f.py,
        amount: this.momentum,
      });
    }
    this.momentumClock = 0;
  }

  override onDamaged(energy: number, _dx: number, _dy: number): void {
    // big blows knock fragments loose
    this.shed += energy / 520;
    while (this.shed >= 1 && this.f.resource > 0) {
      this.shed -= 1;
      this.f.resource -= 1;
      this.f.events.push({ t: 'resource', slot: this.f.slot, kind: 'spend', amount: 1 });
    }
    if (this.shed >= 1) this.shed = 0;
  }

  /** Fragments out in the world are parts: a blow that sweeps through them can shatter them (the Swarm is counterable). */
  override probeParts(shape: DamageShape, out: OverlapResult): number {
    if (this.swarmOut === 0 || this.f.ko) return 0;
    const r = (this.cfg?.radius ?? 4.5) + 2;
    let hits = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < MAX_FRAGS; i++) {
      if (this.sState[i] === 0) continue;
      if (shapeIntersectsDisc(shape, this.sx[i]!, this.sy[i]!, r)) {
        hits++;
        sx += this.sx[i]!;
        sy += this.sy[i]!;
      }
    }
    if (hits > 0) {
      if (out.cells === 0) {
        out.x = sx / hits;
        out.y = sy / hits;
        out.nearestX = out.x;
        out.nearestY = out.y;
        out.coverage = Math.max(out.coverage, 0.05);
      }
      out.cells += hits;
    }
    return hits;
  }

  override intercept(ev: DamageEvent, _info: HitInfo, res: InterceptResult): void {
    if (this.swarmOut === 0) return;
    const f = this.f;
    const r = (this.cfg?.radius ?? 4.5) + 2;
    let lost = 0;
    for (let i = 0; i < MAX_FRAGS; i++) {
      if (this.sState[i] === 0) continue;
      if (!shapeIntersectsDisc(ev.shape, this.sx[i]!, this.sy[i]!, r)) continue;
      // shattered: dust and glints, and the fragment is gone for good (no refund)
      const sp = f.particleSpawn;
      sp.kind = 'dust';
      sp.x = this.sx[i]!;
      sp.y = this.sy[i]!;
      sp.vx = ev.dirX * 50;
      sp.vy = ev.dirY * 50;
      sp.spread = 60;
      sp.count = 4;
      sp.ramp = this.dustRamp;
      sp.life = [14, 30];
      sp.fieldScale = 0.4;
      sp.emissive = 40;
      sp.size = 1;
      sp.drag = 1;
      f.world.spawnParticles(sp);
      f.events.push({
        t: 'cue',
        slot: f.slot,
        titan: f.def.id,
        id: 'fragment-lost',
        x: this.sx[i]!,
        y: this.sy[i]!,
        amount: 1,
      });
      this.sState[i] = 0;
      lost++;
    }
    if (lost > 0) {
      res.touched = true;
      res.partsHit += lost;
      res.absorbed = Math.max(res.absorbed, Math.min(0.2, 0.04 * lost));
    }
  }

  override guardMultiplier(): number {
    return this.rubble ? 0.7 : 1;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  swarm
   * ---------------------------------------------------------------------------------------------- */

  override onRelease(m: ActiveMove): void {
    if (m.def?.id !== 'asteroid.swarm' || !this.cfg) return;
    const f = this.f;
    const cfg = this.cfg;
    const n = Math.min(MAX_FRAGS, cfg.count);
    this.swarmOut = n;
    this.swarmTx = f.px + f.facing * 90;
    this.swarmTy = f.py - 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.2832 + hash01(i, f.tickNo, 5);
      this.sx[i] = f.px + Math.cos(a) * 16;
      this.sy[i] = f.py + Math.sin(a) * 16;
      this.svx[i] = Math.cos(a) * 4 + f.facing * 2;
      this.svy[i] = Math.sin(a) * 4;
      this.sCd[i] = 0;
      this.sState[i] = 1;
    }
    for (let i = n; i < MAX_FRAGS; i++) this.sState[i] = 0;
  }

  override onMoveEnd(m: ActiveMove, _interrupted: boolean): void {
    if (m.def?.id === 'asteroid.swarm') {
      for (let i = 0; i < MAX_FRAGS; i++) if (this.sState[i] === 1) this.sState[i] = 2;
    }
  }

  override onKo(): void {
    for (let i = 0; i < MAX_FRAGS; i++) this.sState[i] = 0;
    this.swarmOut = 0;
  }

  override resolveVolumes(ctx: FighterTickCtx): void {
    const f = this.f;
    const cfg = this.cfg;
    if (!cfg || this.swarmOut === 0) return;
    const m = f.mv;
    const steering = m.def?.id === 'asteroid.swarm' && m.phase === 'active';
    // the flock comes home as soon as the swarm's active window closes
    if (m.def?.id === 'asteroid.swarm' && m.phase === 'recovery')
      for (let i = 0; i < MAX_FRAGS; i++) if (this.sState[i] === 1) this.sState[i] = 2;
    if (steering) {
      // the stick steers the swarm's target point (world axes), not the body
      const inp = ctx.input;
      this.swarmTx += inp.moveX * 5.2;
      this.swarmTy += inp.moveY * 4.6;
      // keep the swarm's focus within a leash of the body so it always reads as part of the fighter
      const dx = this.swarmTx - f.px;
      const dy = this.swarmTy - f.py;
      const d = Math.hypot(dx, dy);
      if (d > 330) {
        this.swarmTx = f.px + (dx / d) * 330;
        this.swarmTy = f.py + (dy / d) * 330;
      }
      const a = f.arena;
      this.swarmTx = clamp(this.swarmTx, a.minX + 20, a.maxX - 20);
      this.swarmTy = clamp(this.swarmTy, a.minY + 20, a.maxY - 20);
    }
    const t = ctx.tick;
    let alive = 0;
    for (let i = 0; i < MAX_FRAGS; i++) {
      const st = this.sState[i]!;
      if (st === 0) continue;
      alive++;
      let x = this.sx[i]!;
      let y = this.sy[i]!;
      let vx = this.svx[i]!;
      let vy = this.svy[i]!;
      if (st === 1) {
        // orbit the target on a ring, each fragment on its own phase, swirling
        const ph = (i / Math.max(1, this.swarmOut)) * 6.2832 + t * 0.09;
        const rad = cfg.orbit * (0.65 + 0.35 * Math.sin(t * 0.05 + i * 1.3));
        const dx = this.swarmTx + Math.cos(ph) * rad - x;
        const dy = this.swarmTy + Math.sin(ph) * rad * 0.8 - y;
        vx += dx * 0.02 * (cfg.steer / 5);
        vy += dy * 0.02 * (cfg.steer / 5);
        vx *= 0.9;
        vy *= 0.9;
        const sp = Math.hypot(vx, vy);
        const cap = cfg.speed / 60;
        if (sp > cap) {
          vx *= cap / sp;
          vy *= cap / sp;
        }
        this.svx[i] = vx;
        this.svy[i] = vy;
        if (this.sCd[i]! > 0) this.sCd[i]!--;
        else this.tryHit(i, x, y, vx, vy);
        vx = this.svx[i]!; // a ricochet may have changed them
        vy = this.svy[i]!;
      } else {
        // returning: home in on the body and re-merge
        const dx = f.px - x;
        const dy = f.py - y;
        const d = Math.hypot(dx, dy) || 1;
        vx += (dx / d) * 2.2;
        vy += (dy / d) * 2.2;
        vx *= 0.86;
        vy *= 0.86;
        if (d < 16) {
          this.sState[i] = 0;
          f.resource = Math.min(f.resourceMax, f.resource + 1);
          f.events.push({ t: 'resource', slot: f.slot, kind: 'gain', amount: 1 });
          alive--;
          continue;
        }
      }
      x += vx;
      y += vy;
      this.sx[i] = x;
      this.sy[i] = y;
      this.svx[i] = vx;
      this.svy[i] = vy;
      // detached threats for the AI (only a few are needed)
      if (st === 1 && i < 4) {
        const sh = this.frag;
        sh.kind = 'point';
        sh.x = x;
        sh.y = y;
        sh.r = cfg.radius;
        f.addThreat(asShape(sh) as DamageShape, 'KINETIC', cfg.energy, 0, 4, true);
      }
    }
    if (alive === 0) this.swarmOut = 0;
    // swarm time limit: fragments come home when the move's active window closes (onMoveEnd) — stragglers are collected here
    if (m.def?.id !== 'asteroid.swarm')
      for (let i = 0; i < MAX_FRAGS; i++) if (this.sState[i] === 1) this.sState[i] = 2;
  }

  private tryHit(i: number, x: number, y: number, vx: number, vy: number): void {
    const f = this.f;
    const cfg = this.cfg!;
    const sh = this.frag;
    sh.kind = 'point';
    sh.x = x;
    sh.y = y;
    sh.r = cfg.radius;
    this.dmg.energy = cfg.energy;
    const sp = Math.hypot(vx, vy);
    const hit = f.strike(
      sh,
      this.dmg,
      sp > 0.1 ? (vx / sp) * 60 : 60,
      sp > 0.1 ? (vy / sp) * 60 : 0,
      0.1,
      4,
      'signature',
      'asteroid.swarm',
      1,
    );
    if (hit) {
      this.sCd[i] = cfg.rehit;
      // ricochet
      this.svx[i] = -vx * 0.7 + (hash01(i, f.tickNo, 9) - 0.5) * 3;
      this.svy[i] = -vy * 0.7 + (hash01(i, f.tickNo, 10) - 0.5) * 3;
    }
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  per tick
   * ---------------------------------------------------------------------------------------------- */

  override leanBias(): number {
    return this.lean;
  }

  override update(_ctx: FighterTickCtx): void {
    const f = this.f;
    const m = f.mv;
    const tick = f.tickNo;
    const id = m.def?.id ?? '';

    // momentum decays when nothing lands
    this.momentumClock++;
    if (this.momentum > 0 && this.momentumClock > MOMENTUM_HOLD) {
      this.momentum--;
      this.momentumClock = MOMENTUM_HOLD - 60;
    }
    // fragments regather slowly
    const cap = Math.round(f.resourceMax * clamp(f.view.bodyStats.massFrac * 1.2, 0, 1));
    this.regenClock++;
    if (f.resource < cap && this.swarmOut === 0 && this.regenClock % 100 === 0)
      f.resource = Math.min(cap, f.resource + 1);
    if (f.resource > cap) f.resource = cap;
    f.view.parts = Math.floor(f.resource);

    // tumble: a slow idle sway, a fast spin during the Tumble surge, a heave when ramming
    this.leanPhase += m.def?.extra?.['spin'] ? 0.5 : 0.028;
    let lean = Math.sin(this.leanPhase) * (m.def?.extra?.['spin'] ? 13 : 2.6);
    if (id === 'asteroid.meteor' && m.phase === 'startup') lean = -6 * clamp01(m.phaseTick / 10);
    if (m.def?.slot === 'ultimate' && m.phase === 'startup')
      lean += Math.sin(tick * 1.9) * 2.2 * clamp01(m.phaseTick / m.startup);
    if (this.rubble) lean += Math.sin(tick * 0.31) * 0.9;
    this.lean = lean;

    // dust trail behind a fast rock; heavier with momentum
    const spd = Math.hypot(f.vx, f.vy);
    this.trailClock++;
    if (spd > 150 && this.trailClock % 2 === 0 && !f.ko) this.spawnTrail(spd);
    if (this.rubble && tick % 9 === 0) this.spawnCrumbs();

    this.draw(tick, id, m);
  }

  private spawnTrail(spd: number): void {
    const f = this.f;
    const sp = f.particleSpawn;
    sp.kind = 'dust';
    sp.x = f.px - Math.sign(f.vx || f.facing) * 26;
    sp.y = f.py + (hash01(f.tickNo, 1, 2) - 0.5) * 30;
    sp.vx = -f.vx * 0.12;
    sp.vy = -f.vy * 0.12;
    sp.spread = 28;
    sp.count = 1 + (this.momentum > 2 ? 1 : 0);
    sp.ramp = this.dustRamp;
    sp.life = [16, 34];
    sp.fieldScale = 0.3;
    sp.emissive = 0;
    sp.size = spd > 300 ? 2 : 1;
    sp.drag = 1.2;
    f.world.spawnParticles(sp);
  }

  private spawnCrumbs(): void {
    const f = this.f;
    const sp = f.particleSpawn;
    sp.kind = 'dust';
    const a = hash01(f.tickNo, 3, 4) * 6.2832;
    sp.x = f.px + Math.cos(a) * 34;
    sp.y = f.py + Math.sin(a) * 30;
    sp.vx = Math.cos(a) * 14;
    sp.vy = Math.sin(a) * 14 + 6;
    sp.spread = 12;
    sp.count = 1;
    sp.ramp = this.dustRamp;
    sp.life = [26, 50];
    sp.fieldScale = 0.5;
    sp.emissive = 0;
    sp.size = 1;
    sp.drag = 0.6;
    f.world.spawnParticles(sp);
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  drawing
   * ---------------------------------------------------------------------------------------------- */

  private draw(tick: number, id: string, m: ActiveMove): void {
    const f = this.f;
    const t = f.body.transform;
    this.back.begin(t.x, t.y);
    this.front.begin(t.x, t.y);
    this.fx.begin(t.x, t.y);
    if (!f.ko || f.stateTicks < 50) {
      this.drawPebbles(tick, id);
      this.drawSwarm(tick);
      if (m.def?.tags.includes('storm')) this.drawStorm(tick, m);
      if (id === 'asteroid.meteor') this.drawRamFlare(tick, m);
      if (m.def?.slot === 'ultimate' && m.phase === 'startup') this.drawCharge(tick, m);
      if (this.momentum >= 2) this.drawMomentum(tick);
    }
    this.back.end();
    this.front.end();
    this.fx.end();
  }

  /** Small rocks in orbit: they tighten around the body under Guard, speed up with momentum, scatter when rubble. */
  private drawPebbles(tick: number, id: string): void {
    const f = this.f;
    const t = f.body.transform;
    const R = this.rig.radius;
    const guard = f.guardUp ? 1 : 0;
    const spinUp = 1 + 0.25 * this.momentum + (id === 'asteroid.tumble' ? 2 : 0);
    const n = PEBBLES + (this.rubble ? 3 : 0);
    for (let i = 0; i < n; i++) {
      const r0 =
        R * (1.12 + 0.11 * (i % 3)) * (guard ? 0.72 : 1) * (this.rubble ? 1.15 + 0.1 * hash01(i, 1, 1) : 1);
      const w = (0.017 + 0.006 * (i % 4)) * spinUp * (i % 2 === 0 ? 1 : -0.8);
      const a = i * 1.7 + tick * w + f.slot;
      const cx = t.x + 2 + Math.cos(a) * r0 * 1.05;
      const cy = t.y - 2 + Math.sin(a) * r0 * (0.32 + 0.06 * (i % 3));
      const behind = Math.sin(a) < 0;
      const size = 2 + (i % 3 === 0 ? 1 : 0) + (i % 5 === 0 ? 1 : 0);
      this.pebble(behind ? this.back : this.front, cx, cy, size, i, behind ? 0.75 : 1);
    }
  }

  private pebble(ov: Overlay, cx: number, cy: number, size: number, seed: number, light: number): void {
    const x0 = Math.round(cx - size / 2);
    const y0 = Math.round(cy - size / 2);
    const r = this.ramp;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        // chipped corners keep it from being a square
        if (
          size >= 3 &&
          ((x === 0 && y === size - 1 && seed % 2 === 0) || (x === size - 1 && y === 0 && seed % 3 === 0))
        )
          continue;
        const lit = x + y === 0 ? 3 : x + y <= size - 2 ? 2 : x + y >= 2 * size - 3 ? 0 : 1;
        const idx = clamp(Math.round(lit * light + (seed % 2)), 0, r.length - 1);
        ov.set(x0 + x, y0 + y, r[idx]!);
      }
  }

  private drawSwarm(tick: number): void {
    const cfg = this.cfg;
    if (!cfg || this.swarmOut === 0) return;
    const ov = this.front;
    for (let i = 0; i < MAX_FRAGS; i++) {
      if (this.sState[i] === 0) continue;
      const x = this.sx[i]!;
      const y = this.sy[i]!;
      const vx = this.svx[i]!;
      const vy = this.svy[i]!;
      // motion streak
      const steps = clamp(Math.round(Math.hypot(vx, vy) * 0.7), 0, 5);
      for (let s = 1; s <= steps; s++) {
        const k = 1 - s / (steps + 1);
        this.fx.add(Math.round(x - vx * s * 0.8), Math.round(y - vy * s * 0.8), 120 * k, 95 * k, 60 * k);
      }
      this.pebble(ov, x, y, 4, i, 1);
      if ((tick + i * 3) % 11 < 2) ov.set(Math.round(x - 1), Math.round(y - 1), this.ice[5]!, 255);
      this.fx.glow(x, y, 6, 200, 150, 80, 0.35);
    }
    // the swarm's focus point
    if (this.f.mv.def?.id === 'asteroid.swarm') {
      const a = this.swarmTx;
      const b = this.swarmTy;
      const p = 0.6 + 0.4 * Math.sin(tick * 0.25);
      for (let k = 0; k < 4; k++) {
        const th = k * 1.5708 + tick * 0.07;
        this.fx.add(
          Math.round(a + Math.cos(th) * 9),
          Math.round(b + Math.sin(th) * 9),
          210 * p,
          180 * p,
          120 * p,
        );
      }
    }
  }

  /** The storm: fragments stream out of the body across the arena; deterministic from the tick, no state. */
  private drawStorm(tick: number, m: ActiveMove): void {
    const cfg = m.def?.extra?.['cascade'] as CascadeCfg | undefined;
    if (!cfg) return;
    const f = this.f;
    const t = f.body.transform;
    const dir = f.facing;
    const at = m.phase === 'active' ? m.phaseTick - 1 : -1;
    // a hot haze along the whole sweep so the storm reads as one attack, then the individual rocks on top of it
    if (at >= cfg.sweepFrom - 4 && at <= cfg.sweepTo + 10) {
      const k = clamp01(
        1 - Math.abs(at - (cfg.sweepFrom + cfg.sweepTo) * 0.5) / (cfg.sweepTo - cfg.sweepFrom),
      );
      for (let g = 0; g < 6; g++)
        this.fx.glow(
          t.x + dir * (40 + g * 46),
          t.y + Math.sin(tick * 0.2 + g) * 10,
          34,
          230,
          130,
          60,
          0.12 * k,
        );
    }
    // twice as many rocks as the damage model has hits: the storm should look like a wall, the hitboxes are what count
    for (let i = 0; i < cfg.count * 2; i++) {
      const launch = cfg.sweepFrom + ((i * 0.69) % (cfg.sweepTo - cfg.sweepFrom - 20));
      const age = at - launch;
      if (age < 0 || age > 34) continue;
      const spread = ((i * 37) % 100) / 100 - 0.5;
      const x = t.x + dir * (26 + age * 10.5);
      const y = t.y + spread * 120 * (0.25 + age / 30) + Math.sin(age * 0.5 + i) * 6;
      const size = 3 + (i % 4);
      for (let s = 1; s <= 8; s++) {
        const q = 1 - s / 9;
        this.fx.add(Math.round(x - dir * s * 3), Math.round(y), 255 * q, 170 * q, 80 * q);
        if (size >= 5) this.fx.add(Math.round(x - dir * s * 3), Math.round(y + 1), 200 * q, 120 * q, 50 * q);
      }
      this.pebble(this.front, x, y, size, i, 1);
      this.fx.glow(x, y, age < 4 ? 10 : 6, 255, 210, 130, age < 4 ? 0.7 : 0.3);
    }
  }

  private drawRamFlare(tick: number, m: ActiveMove): void {
    const f = this.f;
    localToWorld(f.body.transform, this.rig.prow.x + 0.5, this.rig.prow.y + 0.5, this.xy);
    let k = 0;
    if (m.phase === 'startup') k = 0.15 + 0.5 * clamp01(m.phaseTick / m.startup);
    else if (m.phase === 'active') k = 1;
    else k = Math.max(0, 0.5 - m.phaseTick / 24);
    if (k <= 0.05) return;
    const pulse = 1 + 0.15 * Math.sin(tick * 0.7);
    this.fx.glow(this.xy.x, this.xy.y, (14 + 26 * k) * pulse, 255, 140, 60, 0.6 * k);
    this.fx.glow(this.xy.x, this.xy.y, 8 * k * pulse, 255, 230, 170, 0.8 * k);
    if (m.phase === 'active') {
      // heat streaks behind the prow
      const dir = f.facing;
      for (let s = 0; s < 9; s++) {
        const len = 30 + 26 * hash01(s, tick >> 1, 3);
        const oy = (s - 4) * 6 + (hash01(s, tick, 4) - 0.5) * 4;
        for (let d = 0; d < len; d += 1.5) {
          const q = 1 - d / len;
          this.fx.add(
            Math.round(this.xy.x - dir * (8 + d)),
            Math.round(this.xy.y + oy),
            210 * q,
            110 * q,
            40 * q,
          );
        }
      }
    }
  }

  /** Kessler startup: fragments break off and circle the rock faster and wider as the storm builds. */
  private drawCharge(tick: number, m: ActiveMove): void {
    const f = this.f;
    const t = f.body.transform;
    const k = clamp01(m.phaseTick / m.startup);
    const cfg = m.def?.extra?.['cascade'] as CascadeCfg | undefined;
    const n = Math.round((cfg?.count ?? 40) * (0.3 + 0.7 * k));
    for (let i = 0; i < n; i++) {
      const a = i * 2.399 + tick * (0.05 + 0.16 * k) * (i % 2 === 0 ? 1 : -1);
      const rad = (46 + (i % 7) * 6) * (0.7 + 0.6 * k);
      const x = t.x + Math.cos(a) * rad * 1.1;
      const y = t.y + Math.sin(a) * rad * 0.55;
      this.pebble(Math.sin(a) < 0 ? this.back : this.front, x, y, 2 + (i % 3), i, 1);
      if (k > 0.5 && i % 4 === 0) this.fx.glow(x, y, 4, 255, 190, 100, 0.4 * k);
    }
    this.fx.glow(t.x, t.y, 30 + 30 * k, 255, 150, 70, 0.25 * k);
  }

  private drawMomentum(tick: number): void {
    const f = this.f;
    const t = f.body.transform;
    const k = this.momentum / MOMENTUM_MAX;
    // ember sparks streaming off the rock
    for (let i = 0; i < this.momentum * 2; i++) {
      const a = hash01(i, tick >> 2, 21) * 6.2832;
      const r = 30 + 26 * hash01(i, tick >> 2, 22);
      const life = (tick + i * 5) % 12;
      const x = t.x + Math.cos(a) * r - f.vx * 0.02 * life;
      const y = t.y + Math.sin(a) * r * 0.85 - life * 0.6;
      const e = this.emberRamp[clamp(Math.floor(life / 3), 0, 3)]!;
      this.fx.set(Math.round(x), Math.round(y), e, 220 * k);
    }
  }

  override renderLayers(_view: ViewRect, _alpha: number, out: RenderLayer[]): void {
    out.push(this.back.layer, this.front.layer, this.fx.layer);
  }

  override debugShapes(out: DebugShape[]): void {
    for (let i = 0; i < MAX_FRAGS; i++) {
      if (this.sState[i] !== 1) continue;
      const sh = makeFatShape();
      sh.kind = 'point';
      sh.x = this.sx[i]!;
      sh.y = this.sy[i]!;
      sh.r = this.cfg?.radius ?? 4;
      out.push({ shape: asShape(sh), color: 0xff40a0ff, label: 'fragment' });
    }
  }

  /** Test/AI access: number of fragments out in the world. */
  get fragmentsOut(): number {
    let n = 0;
    for (let i = 0; i < MAX_FRAGS; i++) if (this.sState[i] !== 0) n++;
    return n;
  }
}
