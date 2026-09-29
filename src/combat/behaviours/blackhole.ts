import {
  TICK_DT,
  clamp,
  clamp01,
  localToWorld,
  type DebugShape,
  type EffectiveStats,
  type FighterTickCtx,
  type RenderLayer,
  type ViewRect,
} from '@/contracts';
import { hash01, type BlackHoleRig } from '@/titans';
import { Behaviour } from '../behaviour';
import { Overlay } from '../fx/overlay';
import type { ActiveMove } from '../move';
import { asShape, makeFatShape } from '../shapes';

interface WellCfg {
  radius: [number, number];
  strength: [number, number];
  consume: number;
  pullFoe: number;
}

/**
 * THE BLACK HOLE. The horizon is `horizon` matter (immune to everything); the disk is gas that can be torn, shed and stripped.
 *  - Accretion: mass credited by TIDAL streams is built into new disk cells; the hole gets heavier and stronger and SLOWER as
 *    `massFrac` rises above 1 (the usual stats-from-mass rule is inverted there).
 *  - Gravity Well / Spaghettification: a world gravity source at the hole (radius and strength grow with the charge) that pulls
 *    debris and, through the fighter, the foe; matter reaching its consume radius is credited to this body.
 *  - Failure mode: a disrupted disk sheds mass; at low mass the hole sparkles away (Hawking) as the lens shrinks.
 *  - Animation: the disk rotates (angle- and radius-dependent Doppler shimmer over the live disk cells), the photon ring flickers,
 *    jet knots travel outward and motes fall in. Sets `lensRadius/lensStrength` for the renderer.
 */
export class BlackHoleBehaviour extends Behaviour {
  private rig!: BlackHoleRig;
  private fx!: Overlay;
  private disk = new Int32Array(0);
  private ang = new Float32Array(0);
  private rad = new Float32Array(0);
  private well: WellCfg | null = null;
  private ult: WellCfg | null = null;
  private wellOn = false;
  private grownMass = 0;
  private lastGrow = -1000;
  private lastGain = 0;
  private lean = 0;
  private readonly xy = { x: 0, y: 0 };
  private readonly shape = makeFatShape();
  private matGrow = 'diskmid';

  override attach(): void {
    const f = this.f;
    this.rig = f.rig as BlackHoleRig;
    const map = f.body.map;
    const ids = this.rig.ids;
    const list: number[] = [];
    for (let i = 0; i < map.w * map.h; i++) {
      const m = map.material[i]!;
      if (m === ids.diskhot || m === ids.diskmid || m === ids.diskdim || m === ids.photon) list.push(i);
    }
    this.disk = Int32Array.from(list);
    this.ang = new Float32Array(list.length);
    this.rad = new Float32Array(list.length);
    const ct = Math.cos(this.rig.tilt);
    const st = Math.sin(this.rig.tilt);
    list.forEach((i, k) => {
      const x = (i % map.w) + 0.5 - this.rig.core.x;
      const y = Math.floor(i / map.w) + 0.5 - this.rig.core.y;
      const u = x * ct + y * st;
      const v = (-x * st + y * ct) / this.rig.squash;
      this.ang[k] = Math.atan2(v, u);
      this.rad[k] = Math.hypot(u, v);
    });
    this.fx = new Overlay('blackhole-fx', 20, 280, 240, 'add', true);
    this.well = (f.slotMoves.signature?.extra?.['well'] as WellCfg | undefined) ?? null;
    this.ult = (f.slotMoves.ultimate?.extra?.['well'] as WellCfg | undefined) ?? null;
    f.resourceMax = f.def.resource.max;
    f.resource = 0;
  }

  override reset(_heal: number): void {
    this.f.world.setGravitySource(this.f.slot, null);
    this.wellOn = false;
    this.lastGain = this.f.view.bodyStats.massGained;
  }

  override adjustStats(s: EffectiveStats, massFrac: number): void {
    // inverted: what it has eaten makes it stronger and heavier, and slower
    const over = Math.max(0, massFrac - 1);
    if (over > 0) {
      s.speedMul = 1 / (1 + 0.9 * over);
      s.tempoMul = 1 / (1 + 0.6 * over);
      s.damageMul *= 1 + 0.6 * over;
      s.mass *= 1 + over;
    }
    s.reachMul *= 1 + 0.25 * over;
  }

  override leanBias(): number {
    return this.lean;
  }

  override onDamaged(energy: number, _dx: number, _dy: number): void {
    // a disrupted disk sheds mass, and the hole shrinks a little with it
    const f = this.f;
    const mass = Math.min(6, energy * 0.012);
    if (mass > 0.5 && f.view.bodyStats.massFrac > 0.3) {
      f.events.push({
        t: 'cue',
        slot: f.slot,
        titan: f.def.id,
        id: 'disk-shed',
        x: f.px,
        y: f.py,
        amount: mass,
      });
    }
  }

  override onKo(): void {
    this.f.world.setGravitySource(this.f.slot, null);
    this.wellOn = false;
  }

  private cfgFor(m: ActiveMove): WellCfg | null {
    const id = m.def?.id;
    if (id === 'blackhole.well') return this.well;
    if (id === 'blackhole.spaghetti') return this.ult;
    return null;
  }

  override update(_ctx: FighterTickCtx): void {
    const f = this.f;
    const tick = f.tickNo;
    const t = f.body.transform;
    const m = f.mv;
    const st = f.view.bodyStats;
    const cfg = this.cfgFor(m);
    const holding = !!cfg && (m.phase === 'charge' || m.phase === 'active') && !m.feint && !f.ko;
    if (holding && cfg) {
      const c =
        m.def?.id === 'blackhole.well'
          ? clamp01(m.chargeTicks / Math.max(1, m.chargeMax))
          : m.phase === 'active'
            ? 1
            : 0.4;
      const grow = m.phase === 'charge' ? c * 0.6 : 0.6 + 0.4 * clamp01(m.phaseTick / 20);
      const radius = cfg.radius[0] + (cfg.radius[1] - cfg.radius[0]) * grow;
      const strength = cfg.strength[0] + (cfg.strength[1] - cfg.strength[0]) * grow;
      f.world.setGravitySource(f.slot, {
        x: t.x,
        y: t.y,
        strength,
        radius,
        consumeRadius: cfg.consume,
        creditBodyId: f.body.id,
      });
      this.wellOn = true;
      // the foe is drawn in too, in proportion to how deep in the well it is
      const foe = f.foe as unknown as { vx: number; vy: number; ko: boolean; view: { x: number; y: number } };
      const dx = t.x - foe.view.x;
      const dy = t.y - foe.view.y;
      const d = Math.hypot(dx, dy);
      if (!foe.ko && d < radius && d > 20) {
        const a = cfg.pullFoe * (1 - d / radius) * grow * TICK_DT;
        foe.vx += (dx / d) * a;
        foe.vy += (dy / d) * a * 0.5;
      }
    } else if (this.wellOn) {
      f.world.setGravitySource(f.slot, null);
      this.wellOn = false;
    }
    // accretion: build credited mass into new disk
    const gained = st.massGained;
    if (gained > this.lastGain + 4) {
      f.events.push({
        t: 'cue',
        slot: f.slot,
        titan: f.def.id,
        id: 'consume',
        x: t.x,
        y: t.y,
        amount: gained - this.lastGain,
      });
      this.lastGain = gained;
    }
    if (tick - this.lastGrow >= 45 && !f.ko) {
      const idx = f.body.materials.findIndex((mm) => mm.key === this.matGrow);
      const per = idx >= 0 ? f.body.materials[idx]!.density : 1;
      const pool = gained - this.grownMass;
      const cells = Math.min(60, Math.floor((pool * 0.9) / Math.max(0.03, per)));
      if (idx >= 0 && cells >= 12) {
        const a = hash01(tick, 7, 3) * 6.2832;
        const added = f.world.grow(f.body.id, {
          cells,
          materialKey: this.matGrow,
          nearX: t.x + Math.cos(a) * 70,
          nearY: t.y + Math.sin(a) * 20,
        });
        this.lastGrow = tick;
        this.grownMass += added * per;
      }
    }
    f.resource = clamp((100 * (gained * 0.9)) / Math.max(1, st.initialMass * 0.25), 0, 100);
    f.view.parts = Math.floor(f.resource / 10);
    // lensing follows the horizon and the accreted mass; a dying hole lets the light back
    const low = clamp01((st.massFrac - 0.22) / 0.5);
    f.view.lensRadius = this.rig.horizon * (0.6 + 0.4 * low);
    f.view.lensStrength = clamp(0.35 + 0.5 * Math.max(0, st.massFrac - 1), 0, 1.5) * (0.3 + 0.7 * low);
    this.lean = Math.sin(tick * 0.017 + f.slot) * 1.2;
    this.draw(tick, st.massFrac, holding);
  }

  private draw(tick: number, massFrac: number, holding: boolean): void {
    const f = this.f;
    const t = f.body.transform;
    const fx = this.fx;
    const map = f.body.map;
    fx.begin(t.x, t.y);
    if (f.ko && f.stateTicks > 60) {
      fx.end();
      return;
    }
    const spin = tick * (holding ? 0.09 : 0.055);
    const gain = holding ? 1.5 : 1;
    // the disk turns: brightness rides an angle- and radius-dependent wave (inner gas orbits faster), hot on the approaching side
    for (let k = 0; k < this.disk.length; k++) {
      const i = this.disk[k]!;
      if (map.material[i] === 0) continue;
      const q = this.rad[k]!;
      const w = spin * Math.pow(this.rig.diskIn / Math.max(20, q), 1.4);
      const b = 0.5 + 0.5 * Math.cos(this.ang[k]! * 2 - w);
      const dop = 0.5 - 0.5 * Math.cos(this.ang[k]! - 0.0);
      const e = b * b * (0.35 + 0.65 * (1 - dop)) * 46 * gain;
      if (e < 4) continue;
      const lx = i % map.w;
      localToWorld(t, lx + 0.5, (i - lx) / map.w + 0.5, this.xy);
      fx.add(Math.floor(this.xy.x), Math.floor(this.xy.y), e, e * 0.5, e * 0.16);
    }
    // photon ring flicker and a soft halo
    const hz = this.rig.horizon;
    fx.glow(t.x, t.y, hz + 12, 255, 170, 70, 0.1 + 0.05 * Math.sin(tick * 0.31) + (holding ? 0.12 : 0));
    // jet knots travelling outward along the axis
    const jl = this.rig.jetLen;
    for (let s = 0; s < 2; s++) {
      for (let k = 0; k < 3; k++) {
        const u = (tick * 0.02 + k / 3) % 1;
        const d = hz + 4 + u * jl;
        const px = t.x + this.rig.jetX * d * (s ? -1 : 1);
        const py = t.y + this.rig.jetY * d * (s ? -1 : 1);
        fx.glow(px, py, 3.2 * (1 - u * 0.5), 140, 200, 255, 0.85 * (1 - u));
      }
    }
    // infalling motes; and Hawking sparkle when the hole is dying
    for (let k = 0; k < 6; k++) {
      const u = (tick * 0.013 + k * 0.17) % 1;
      const a = k * 1.9 + hash01(k, 1, 1) * 6;
      const r = hz + 6 + (1 - u) * 60;
      fx.add(
        Math.round(t.x + Math.cos(a + u * 3) * r),
        Math.round(t.y + Math.sin(a + u * 3) * r * 0.4),
        200 * u,
        120 * u,
        50 * u,
      );
    }
    if (massFrac < 0.5) {
      const n = Math.round((0.5 - massFrac) * 30);
      for (let k = 0; k < n; k++) {
        const a = hash01(tick, k, 5) * 6.2832;
        const r = hz * (0.9 + 0.5 * hash01(tick, k, 6));
        fx.add(Math.round(t.x + Math.cos(a) * r), Math.round(t.y + Math.sin(a) * r), 255, 240, 200);
      }
    }
    fx.end();
  }

  override renderLayers(_view: ViewRect, _alpha: number, out: RenderLayer[]): void {
    out.push(this.fx.layer);
  }

  override debugShapes(out: DebugShape[]): void {
    if (!this.wellOn) return;
    const src = this.f.mv;
    const cfg = this.cfgFor(src);
    if (!cfg) return;
    const sh = this.shape;
    sh.kind = 'point';
    sh.x = this.f.px;
    sh.y = this.f.py;
    sh.r = cfg.radius[0];
    out.push({ shape: asShape(sh), color: 0xff7a3aff, label: 'well' });
  }

  get wellActive(): boolean {
    return this.wellOn;
  }
}
