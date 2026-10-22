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
import { DMath, sq } from '@/contracts/dmath';
import { fcos, fsin } from '@/contracts/ftrig';
import {
  SIGNATURE,
  SIG_ROLE,
  makeSignature,
  type RenderLayerSig,
  type SignatureFx,
} from '@/render/signature';

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
 *  - Animation (docs/SIGNATURE.md): the signature pass turns the disk itself (inner gas faster, the Doppler side fixed on screen)
 *    and streams its lensed far side round the horizon; the overlay adds the photon ring's flicker, photons escaping the ring,
 *    jet knots streaking outward and motes falling in. Without the pass (`?sig=0`) the overlay's brightness wave fakes the
 *    rotation as before. Sets `lensRadius/lensStrength` for the renderer (the scenery bends round the hole).
 */
export class BlackHoleBehaviour extends Behaviour {
  private rig!: BlackHoleRig;
  private fx!: Overlay;
  private disk = new Int32Array(0);
  private ang = new Float32Array(0);
  private rad = new Float32Array(0);
  /** Per disk cell: (diskIn / max(20, rad))^1.4, how much faster it orbits (constant: S19, was a DMath.pow per cell per tick). */
  private orbitK = new Float32Array(0);
  private drawStale = false;
  private drawTick = 0;
  private drawMass = 1;
  private drawHolding = false;
  /** The signature animation's parameters (render-only), and the ticks spent holding a Well (it spins the disk faster). */
  private sig!: SignatureFx;
  private heldTicks = 0;
  private drawHeld = 0;
  private well: WellCfg | null = null;
  private ult: WellCfg | null = null;
  private wellOn = false;
  private eatenAcc = 0;
  private lastFoeMass = 0;
  private lastGrow = -1000;
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
    this.orbitK = new Float32Array(list.length);
    const ct = DMath.cos(this.rig.tilt);
    const st = DMath.sin(this.rig.tilt);
    list.forEach((i, k) => {
      const x = (i % map.w) + 0.5 - this.rig.core.x;
      const y = Math.floor(i / map.w) + 0.5 - this.rig.core.y;
      const u = x * ct + y * st;
      const v = (-x * st + y * ct) / this.rig.squash;
      this.ang[k] = DMath.atan2(v, u);
      this.rad[k] = DMath.hypot(u, v);
      this.orbitK[k] = DMath.pow(this.rig.diskIn / Math.max(20, this.rad[k]!), 1.4);
    });
    this.sig = this.buildSignature(map.w, map.h);
    this.fx = new Overlay('blackhole-fx', 20, 280, 240, 'add', true);
    this.well = (f.slotMoves.signature?.extra?.['well'] as WellCfg | undefined) ?? null;
    this.ult = (f.slotMoves.ultimate?.extra?.['well'] as WellCfg | undefined) ?? null;
    f.resourceMax = f.def.resource.max;
    f.resource = f.def.resource.start;
  }

  /**
   * The disk's signature: roles from the painter's own geometry (art/blackhole.ts), so the flow region is the whole disk
   * annulus (its ragged edge and any hole in it turn with it), the horizon and photon ring are the occluder, the near band
   * crossing the horizon flows over it, and the arcs over and under the horizon are the lensed far side.
   */
  private buildSignature(w: number, h: number): SignatureFx {
    const rg = this.rig;
    const s = makeSignature(w, h);
    const ct = DMath.cos(rg.tilt);
    const st = DMath.sin(rg.tilt);
    const hz = rg.horizon;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const dx = x + 0.5 - rg.core.x;
        const dy = y + 0.5 - rg.core.y;
        const r = DMath.hypot(dx, dy);
        const u = dx * ct + dy * st;
        const v = -dx * st + dy * ct;
        const q = DMath.hypot(u, v / rg.squash);
        const frontBand =
          v > 0 && r < hz + rg.ring && q >= rg.diskIn - 1 && q <= rg.diskIn + (rg.diskOut - rg.diskIn) * 0.28;
        const rr = r - (hz + rg.ring);
        const taper = Math.sqrt(Math.max(0, 1 - sq(dx / (hz * 1.15))));
        const arc = (dy < 0 && rr >= 0.2 && rr < 12 * taper) || (dy > 0 && rr >= 0.2 && rr < 6 * taper);
        const inDisk = q >= rg.diskIn && q <= rg.diskOut + 1 && !(v < 0 && r < hz + rg.ring + 1);
        s.roles[y * w + x] = frontBand
          ? SIG_ROLE.flow
          : r < hz + rg.ring
            ? SIG_ROLE.occluder
            : inDisk
              ? SIG_ROLE.flow
              : arc
                ? SIG_ROLE.lensed
                : SIG_ROLE.still;
      }
    s.cx = rg.core.x;
    s.cy = rg.core.y;
    s.tilt = rg.tilt;
    s.squash = rg.squash;
    s.rIn = rg.diskIn;
    s.rOut = rg.diskOut;
    s.shearRate = 0.8;
    s.shearK = 1.5;
    s.shearPeriod = 3;
    // the painter's beaming (0.6 + 0.75 · dopp, dopp = 0.5 − u / 2·diskOut) is ∝ 1 − 0.385 · u / diskOut: approaching on the left
    s.doppler = 0.385;
    s.dopplerX = -1;
    s.dopplerY = 0;
    // two bright spiral arms riding the gas (the old overlay's wave, now moving with the matter)
    s.streak = 0.45;
    s.streakArms = 2;
    s.streakWind = 0.07;
    s.hole = hz;
    s.lensRing = hz + rg.ring;
    s.lensSpin = 2.5;
    s.lensGain = 1.1;
    return s;
  }

  override decorateBodyLayer(layer: RenderLayer): void {
    (layer as RenderLayerSig).signature = this.sig;
  }

  override reset(_heal: number): void {
    this.f.world.setGravitySource(this.f.slot, null);
    this.wellOn = false;
    this.lastFoeMass = (this.f.foe.view.bodyStats as { mass: number }).mass;
    this.eatenAcc = 0;
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
        creditBodyId: -1,
      });
      this.wellOn = true;
      // the foe is drawn in too, in proportion to how deep in the well it is
      const foe = f.foe as unknown as { vx: number; vy: number; ko: boolean; view: { x: number; y: number } };
      const dx = t.x - foe.view.x;
      const dy = t.y - foe.view.y;
      const d = DMath.hypot(dx, dy);
      if (!foe.ko && d < radius && d > 20) {
        const a = cfg.pullFoe * (1 - d / radius) * grow * TICK_DT;
        foe.vx += (dx / d) * a;
        foe.vy += (dy / d) * a * 0.5;
      }
    } else if (this.wellOn) {
      f.world.setGravitySource(f.slot, null);
      this.wellOn = false;
    }
    // accretion: what the foe loses while the hole feeds fills the Accreted bar; the bar rebuilds the disk
    const foeMass = (f.foe.view.bodyStats as { mass: number }).mass;
    const eaten = this.lastFoeMass - foeMass;
    this.lastFoeMass = foeMass;
    if (eaten > 0 && !f.ko) {
      f.resource = Math.min(f.resourceMax, f.resource + eaten * 0.02);
      this.eatenAcc += eaten;
      if (this.eatenAcc > 600) {
        f.events.push({
          t: 'cue',
          slot: f.slot,
          titan: f.def.id,
          id: 'consume',
          x: t.x,
          y: t.y,
          amount: this.eatenAcc,
        });
        this.eatenAcc = 0;
      }
    }
    const missing = st.initialCells * 0.97 - st.cells;
    if (tick - this.lastGrow >= 20 && !f.ko && missing > 40 && f.resource > 6) {
      const cells = Math.min(40, Math.floor(missing));
      const a = hash01(tick, 7, 3) * 6.2832;
      const added = f.world.grow(f.body.id, {
        cells,
        materialKey: this.matGrow,
        nearX: t.x + DMath.cos(a) * 70,
        nearY: t.y + DMath.sin(a) * 20,
      });
      this.lastGrow = tick;
      f.resource = Math.max(0, f.resource - added * 0.15);
    }
    f.view.parts = Math.floor(f.resource / 10);
    // lensing follows the horizon and the accreted mass; a dying hole lets the light back
    const low = clamp01((st.massFrac - 0.22) / 0.5);
    f.view.lensRadius = this.rig.horizon * (0.6 + 0.4 * low);
    f.view.lensStrength = clamp(0.35 + 0.5 * Math.max(0, st.massFrac - 1), 0, 1.5) * (0.3 + 0.7 * low);
    this.lean = DMath.sin(tick * 0.017 + f.slot) * 1.2;
    // the Hawking cue is sim output: it stays in the tick; the drawing is done at render time (S19)
    if (st.massFrac < 0.5 && tick % 45 === 0 && !f.ko)
      f.events.push({
        t: 'cue',
        slot: f.slot,
        titan: f.def.id,
        id: 'hawking',
        x: t.x,
        y: t.y,
        amount: 0.5 - st.massFrac,
      });
    this.drawStale = true;
    this.drawTick = tick;
    this.drawMass = st.massFrac;
    this.drawHolding = holding;
    if (holding) this.heldTicks++;
    this.drawHeld = this.heldTicks;
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
    // without the signature pass, the disk's turning is faked: brightness rides an angle- and radius-dependent wave (inner gas
    // orbits faster), hot on the approaching side
    // (with the pass the disk really turns: what stays is the beaming glow, fixed on screen, over the disk's region; the gas
    // moving through it is the pass's)
    const sig = SIGNATURE.on;
    for (let k = 0; k < this.disk.length; k++) {
      const i = this.disk[k]!;
      if (!sig && map.material[i] === 0) continue;
      const w = spin * this.orbitK[k]!;
      const b = sig ? 0.62 : 0.5 + 0.5 * fcos(this.ang[k]! * 2 - w);
      const dop = 0.5 - 0.5 * fcos(this.ang[k]! - 0.0);
      const e = b * b * (0.35 + 0.65 * (1 - dop)) * (sig ? 30 : 46) * gain;
      if (e < 4) continue;
      const lx = i % map.w;
      localToWorld(t, lx + 0.5, (i - lx) / map.w + 0.5, this.xy);
      fx.add(Math.floor(this.xy.x), Math.floor(this.xy.y), e, e * 0.5, e * 0.16);
    }
    // photon ring flicker and a soft halo
    const hz = this.rig.horizon;
    fx.glow(t.x, t.y, hz + 12, 255, 170, 70, 0.1 + 0.05 * DMath.sin(tick * 0.31) + (holding ? 0.12 : 0));
    // jet knots travelling outward along the axis, each with a streak behind it (it accelerates: the streak lengthens)
    const jl = this.rig.jetLen;
    const jx = this.rig.jetX;
    const jy = this.rig.jetY;
    for (let s = 0; s < 2; s++) {
      const sg = s ? -1 : 1;
      for (let k = 0; k < 3; k++) {
        const u = (tick * 0.02 + k / 3) % 1;
        const d = hz + 4 + u * jl;
        const px = t.x + jx * d * sg;
        const py = t.y + jy * d * sg;
        fx.glow(px, py, 3.2 * (1 - u * 0.5), 140, 200, 255, 0.85 * (1 - u));
        const tail = Math.floor(3 + u * 9);
        for (let j = 1; j <= tail; j++) {
          const e = 150 * (1 - u) * (1 - j / (tail + 1));
          fx.add(Math.floor(px - jx * j * sg), Math.floor(py - jy * j * sg), e * 0.6, e * 0.85, e);
        }
      }
    }
    // photons escaping the photon ring: each leaves at its own angle, bent round the hole as it climbs out (its path curls in
    // the direction the disk turns), a short bright streak fading with distance
    const ring = hz + this.rig.ring;
    for (let k = 0; k < 7; k++) {
      const ph = tick * 0.022 + hash01(k, 3, 9);
      const cyc = Math.floor(ph);
      const u = ph - cyc;
      const a0 = hash01(k, cyc, 11) * 6.2832;
      for (let j = 0; j < 6; j++) {
        const uu = u - j * 0.012;
        if (uu < 0) break;
        const r = ring + 1 + uu * 64;
        const a = a0 + 0.9 * sq(1 - uu);
        const e = (255 - j * 40) * (1 - uu) * (holding ? 1.3 : 1);
        fx.add(Math.round(t.x + fcos(a) * r), Math.round(t.y + fsin(a) * r), e, e * 0.88, e * 0.62);
      }
    }
    // infalling motes; and Hawking sparkle when the hole is dying
    for (let k = 0; k < 6; k++) {
      const u = (tick * 0.013 + k * 0.17) % 1;
      const a = k * 1.9 + hash01(k, 1, 1) * 6;
      const r = hz + 6 + (1 - u) * 60;
      fx.add(
        Math.round(t.x + DMath.cos(a + u * 3) * r),
        Math.round(t.y + DMath.sin(a + u * 3) * r * 0.4),
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
        fx.add(Math.round(t.x + DMath.cos(a) * r), Math.round(t.y + DMath.sin(a) * r), 255, 240, 200);
      }
    }
    fx.end();
  }

  override renderLayers(view: ViewRect, alpha: number, out: RenderLayer[]): void {
    // the signature's clock: the snapshotted tick (+ the frame's alpha, so it turns smoothly between ticks); a held Well spins it
    // faster without a jump (the held ticks are counted, not a rate swapped)
    const s = this.sig;
    const tt = this.drawTick + alpha;
    s.t = tt * TICK_DT;
    s.spin = tt * 0.0062 + (this.drawHeld + (this.drawHolding ? alpha : 0)) * 0.012;
    // (a fighter that has not met its foe yet has nothing to draw: drawing starts with the first tick)
    if ((this.fx.limitToView(view) || this.drawStale) && this.f.foe) {
      this.drawStale = false;
      this.draw(this.drawTick, this.drawMass, this.drawHolding);
    }
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
