import {
  clamp01,
  localToWorld,
  type DamageEvent,
  type EffectiveStats,
  type FighterTickCtx,
  type RenderLayer,
  type ViewRect,
} from '@/contracts';
import { DMath } from '@/contracts/dmath';
import type { HitInfo, InterceptResult } from '../../behaviour';
import type { ActiveMove } from '../../move';
import { asShape, makeFatShape } from '../../shapes';
import { idleSeed } from '../../fx/idle';
import { KitBehaviour } from './base';
import { RemainderFx, type RemainderMoveView } from './remainderFx';
import { RemainderIdle, type RemainderAct } from './remainderIdle';

/**
 * THE REMAINDER's behaviour (titan kit; body imported from key art; design: docs/titans/remainder/BRIEF.md). A rigid shell
 * with violence inside: the body never swings, every attack erupts out of the vortex. The moves' data (frame data,
 * hitboxes) are in its JSON, written by tools/titans/author/remainder.ts; what this class adds:
 *
 *  - HOARD (passive): what the foe loses while Snap, Inhale or Loosening runs, and the blows it swallows while it Holds
 *    Shut, become Mass (the resource, 5 pips).
 *  - INHALE: for its first ticks the foe is yanked toward the eye and loose debris is pulled in with it.
 *  - COMPACTION: on release the charge decides how many pips it crushes (1–3, never more than it has): aimed forward or up
 *    the slug flies as a real chunk of matter (one KINETIC blow on contact); aimed down it grows bone plates over the front
 *    of its shell.
 *  - LOOSENING: while open, a gravity well drags the foe and the debris in; the core is exposed (a blow that reaches it
 *    lands twice); the wound snaps shut with a shockwave.
 *  - CANNIBAL (failure mode): below a third of its mass it eats its own shell to keep the core alive: every so often a bite
 *    of shell crumbles inward and core matter grows; faster (tempo), but its Hold Shut weakens.
 *
 * Determinism: sim state in fields, changed only on the tick, folded into `hashState`. Everything drawn is recorded on the
 * tick for the render side (RemainderIdle, RemainderFx) and never read back.
 */

const SNAP = 'remainder.snap';
const INHALE = 'remainder.inhale';
const FOLD = 'remainder.fold';
const COMPACTION = 'remainder.compaction';
const LOOSENING = 'remainder.loosening';
/** Mass pips gained per share of the foe's mass it tears off (4 % of a foe ≈ one pip). */
const HOARD_GAIN = 25;
/** Mass pips a swallowed blow gives while it Holds Shut. */
const ABSORB_GAIN = 0.3;
/** Cannibal: below this mass fraction; one bite every CANNIBAL_EVERY ticks. */
const CANNIBAL_AT = 0.34;
const CANNIBAL_EVERY = 45;
/** Slugs stay on the field this long (ticks), at most this many. */
const SLUG_TICKS = 300;
const SLUG_MAX = 3;

interface InhaleCfg {
  radius: number;
  pullFoe: number;
  strength: number;
  ticks: number;
}
interface WellCfg {
  radius: [number, number];
  strength: [number, number];
  consume: number;
  pullFoe: number;
}
interface CompactionCfg {
  speed: number;
  size: [number, number];
  pips: [number, number];
  plateCells: number;
  slugMass: number;
}

export class RemainderBehaviour extends KitBehaviour {
  /* ---- sim state (hashed) ---- */
  private prevFoeMass = -1;
  private wellOn = false;
  private cannibalAt = 0;
  private slugs: { id: number; until: number }[] = [];

  /* ---- render-side records (written on the tick, read when drawing; never fed back) ---- */
  private idle: RemainderIdle | null = null;
  private fx: RemainderFx | null = null;
  private drawTick = 0;
  private readonly view: RemainderMoveView = {
    id: '',
    phase: '',
    phaseTick: 0,
    moveTick: 0,
    startup: 1,
    active: 1,
    recovery: 1,
    charge: 0,
    aim: 'forward',
    facing: 1,
    snapHitAt: -999,
    snapHitX: 0,
    snapHitY: 0,
    foldFromX: 0,
    foldFromY: 0,
    foldAt: -999,
    foldToAt: -999,
    slugAt: -999,
    slugPips: 0,
    platesAt: -999,
    absorbAt: -999,
    absorbX: 0,
    absorbY: 0,
    shutAt: -999,
    biteAt: -999,
    cannibalAt: -999,
    cannibal: false,
    guard: false,
    guardAt: -999,
    foeColors: new Uint32Array(16),
    foeColorsN: 0,
  };

  private readonly xy = { x: 0, y: 0 };
  private readonly extraShape = makeFatShape();
  private readonly extraEv: DamageEvent = {
    type: 'TIDAL',
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
    params: {},
  };

  private cfg<T>(id: string, key: string): T | null {
    return (this.f.moveById(id)?.extra?.[key] as T | undefined) ?? null;
  }

  private cue(id: string, amount = 1): void {
    const f = this.f;
    const t = f.body.transform;
    f.events.push({ t: 'cue', slot: f.slot, titan: f.def.id, id, x: t.x, y: t.y, amount });
  }

  /** World position of the core (the eye). */
  private eye(): { x: number; y: number } {
    const m = this.f.body.map;
    localToWorld(this.f.body.transform, m.coreX + 0.5, m.coreY + 0.5, this.xy);
    return this.xy;
  }

  private massFrac(): number {
    return (this.f.view.bodyStats as { massFrac: number }).massFrac;
  }

  /* ---------------------------------------------------------------------------------------------- the moves */

  protected override onSignature(_m: ActiveMove): void {}

  override onMoveStart(m: ActiveMove): void {
    const f = this.f;
    if (m.def?.id === FOLD) {
      const e = this.eye();
      this.view.foldFromX = e.x;
      this.view.foldFromY = e.y;
      this.view.foldAt = f.tickNo;
      this.cue('fold-collapse');
      f.events.push({ t: 'shockwave', x: e.x, y: e.y, strength: 0.35, radius: 90, hue: 0.78 });
    } else if (m.def?.id === LOOSENING) {
      this.cue('loosen-tear');
      f.events.push({ t: 'zoom', amount: 0.06 });
      f.events.push({ t: 'roll', radians: 0.02 * f.facing });
    } else if (m.def?.id === INHALE) this.cue('inhale-draw');
  }

  override onRelease(m: ActiveMove): void {
    const id = m.def?.id;
    if (id === COMPACTION) this.compact(m);
    else if (id === SNAP) this.cue('snap-latch');
    else if (id === INHALE) {
      const f = this.f;
      f.events.push({ t: 'shake', dirX: f.facing, dirY: 0, amp: 4 });
    } else if (id === LOOSENING) {
      const f = this.f;
      f.events.push({ t: 'shake', dirX: 0, dirY: 1, amp: 6 });
      f.events.push({ t: 'flash', amount: 0.25 });
    }
  }

  override onMoveEnd(m: ActiveMove, _interrupted: boolean): void {
    if (m.def?.id === FOLD) {
      const e = this.eye();
      this.view.foldToAt = this.f.tickNo;
      this.cue('fold-unfold');
      this.f.events.push({ t: 'shockwave', x: e.x, y: e.y, strength: 0.4, radius: 110, hue: 0.3 });
    }
    if (m.def?.id === LOOSENING || m.def?.id === INHALE) this.dropWell();
  }

  /** Compaction's release: crush 1–3 pips (by charge) into a slug (forward / up) or into plates (down). */
  private compact(m: ActiveMove): void {
    const f = this.f;
    const c = this.cfg<CompactionCfg>(COMPACTION, 'compaction');
    if (!c) return;
    const charge = clamp01(m.chargeTicks / Math.max(1, m.chargeMax));
    // the move's own cost (one pip) is already spent; a fuller charge crushes up to two more, if it has them
    const extra = Math.min(Math.floor(f.resource + 1e-6), Math.round(charge * (c.pips[1] - c.pips[0])));
    f.resource -= extra;
    const pips = c.pips[0] + extra;
    this.view.slugPips = pips;
    if (m.aim === 'down') {
      const t = f.body.transform;
      f.world.grow(f.body.id, {
        cells: c.plateCells * pips,
        materialKey: 'bone',
        nearX: t.x + f.facing * 70,
        nearY: t.y,
      });
      this.view.platesAt = f.tickNo;
      this.cue('compaction-merge', pips);
      return;
    }
    const size = Math.round(c.size[0] + ((c.size[1] - c.size[0]) * (pips - 1)) / 2);
    const slug = this.slugSprite(size);
    const e = this.eye();
    const up = m.aim === 'up';
    const dirX = f.facing * (up ? 0.72 : 1);
    const dirY = up ? -0.7 : 0;
    const id = f.world.spawnChunk({
      pixels: slug.px,
      w: slug.n,
      h: slug.n,
      x: e.x + dirX * 70,
      y: e.y + dirY * 70,
      vx: 0,
      vy: 0,
      spin: 3 * f.facing,
      mass: c.slugMass * pips,
      plane: true,
    });
    if (typeof id !== 'number' || id < 0) return;
    const speed = c.speed * (0.85 + 0.15 * pips);
    f.world.launchChunk?.(id, dirX * speed, dirY * speed, f.body.id, f.slot);
    this.slugs.push({ id, until: f.tickNo + SLUG_TICKS });
    if (this.slugs.length > SLUG_MAX) {
      f.world.retireChunk?.(this.slugs[0]!.id);
      this.slugs.shift();
    }
    this.view.slugAt = f.tickNo;
    this.cue('compaction-crack', pips);
    f.events.push({ t: 'shake', dirX: -f.facing, dirY: 0, amp: 2 + pips });
  }

  /** A slug: a dense ball of its own crust and bone, dark at the rim, lit on top. */
  private slugSprite(n: number): { px: Uint32Array; n: number } {
    const f = this.f;
    const ramp = (key: string): string[] =>
      f.def.materials.find((m) => m.key === key)?.visual.ramp ?? ['#5a4a40'];
    const hex = (h: string): number => {
      const v = parseInt(h.slice(1), 16);
      return (0xff000000 | ((v & 255) << 16) | (v & 0xff00) | ((v >> 16) & 255)) >>> 0;
    };
    const bone = ramp('bone').map(hex);
    const crust = ramp('crust').map(hex);
    const px = new Uint32Array(n * n);
    const R = n / 2;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const dx = x + 0.5 - R;
        const dy = y + 0.5 - R;
        const d = DMath.hypot(dx, dy);
        if (d > R) continue;
        const lit = clamp01(0.55 - (dx + dy) / (2.2 * R) - (d > R - 1 ? 0.45 : 0));
        const L = (x * 7 + y * 3) % 5 < 2 ? crust : bone;
        px[y * n + x] = L[Math.min(L.length - 1, Math.floor(lit * L.length))]!;
      }
    return { px, n };
  }

  private dropWell(): void {
    if (!this.wellOn) return;
    this.f.world.setGravitySource(this.f.slot, null);
    this.wellOn = false;
  }

  /** Pull the foe toward the eye (and let the world pull debris in): Inhale's yank and Loosening's well. */
  private pull(radius: number, strength: number, consume: number, pullFoe: number, grow: number): void {
    const f = this.f;
    const e = this.eye();
    f.world.setGravitySource(f.slot, {
      x: e.x,
      y: e.y,
      strength: strength * grow,
      radius,
      consumeRadius: consume,
      creditBodyId: -1,
    });
    this.wellOn = true;
    const foe = f.foe as unknown as { vx: number; vy: number; ko: boolean; view: { x: number; y: number } };
    const dx = e.x - foe.view.x;
    const dy = e.y - foe.view.y;
    const d = DMath.hypot(dx, dy);
    if (!foe.ko && d < radius && d > 24) {
      const a = pullFoe * (1 - d / radius) * grow * (1 / 60);
      foe.vx += (dx / d) * a;
      foe.vy += (dy / d) * a * 0.5;
    }
  }

  /* ---------------------------------------------------------------------------------------------- the tick */

  override update(ctx: FighterTickCtx): void {
    super.update(ctx);
    const f = this.f;
    const tick = f.tickNo;
    const m = f.mv;
    const id = m.def?.id ?? '';
    this.drawTick = ctx.tick;

    // Inhale: the yank, for the intake's first ticks
    if (id === INHALE && m.phase === 'active' && !m.feint) {
      const c = this.cfg<InhaleCfg>(INHALE, 'inhale');
      if (c && m.phaseTick <= c.ticks) this.pull(c.radius, c.strength, 18, c.pullFoe, 1);
      else this.dropWell();
      if (m.phaseTick === 7) this.view.biteAt = tick;
    }
    // Loosening: the well while the wound is open (it grows over the first 20 ticks), shut for the snap
    if (id === LOOSENING && m.phase === 'active' && !m.feint) {
      const c = this.cfg<WellCfg>(LOOSENING, 'well');
      if (c && m.phaseTick < 140) {
        const g = clamp01(m.phaseTick / 20);
        this.pull(
          c.radius[0] + (c.radius[1] - c.radius[0]) * g,
          c.strength[1],
          c.consume,
          c.pullFoe,
          0.4 + 0.6 * g,
        );
      } else {
        this.dropWell();
        if (m.phaseTick === 140) {
          const e = this.eye();
          this.view.shutAt = tick;
          this.cue('loosen-break', 2);
          f.events.push({ t: 'shockwave', x: e.x, y: e.y, strength: 1, radius: 260, hue: 0.78 });
          f.events.push({ t: 'flash', amount: 0.6, x: e.x, y: e.y });
          f.events.push({ t: 'shake', dirX: f.facing, dirY: 0, amp: 9 });
          f.events.push({ t: 'timescale', scale: 0.35, ticks: 10 });
        }
      }
    }
    if (this.wellOn && id !== INHALE && id !== LOOSENING) this.dropWell();

    // Hoard: what the foe loses while it tears (Snap, Inhale, Loosening) becomes Mass
    const fs = f.foe.view.bodyStats as { mass: number; initialMass: number };
    if (this.prevFoeMass >= 0 && (id === SNAP || id === INHALE || id === LOOSENING) && !f.ko) {
      const lost = this.prevFoeMass - fs.mass;
      if (lost > 0)
        f.resource = Math.min(f.resourceMax, f.resource + (lost / Math.max(1, fs.initialMass)) * HOARD_GAIN);
    }
    this.prevFoeMass = fs.mass;

    // Cannibal: below a third of its mass it eats its own shell to keep the core alive
    if (!f.ko && f.live && this.massFrac() < CANNIBAL_AT && tick >= this.cannibalAt) {
      this.cannibalAt = tick + CANNIBAL_EVERY;
      this.cannibalBite(tick);
    }

    // slugs leave the field after a while
    while (this.slugs.length && this.slugs[0]!.until <= tick) {
      f.world.retireChunk?.(this.slugs[0]!.id);
      this.slugs.shift();
    }

    this.recordView(tick);
  }

  /** One bite of its own shell: a patch of the rim crumbles (inward, toward the eye), core matter grows at the eye. */
  private cannibalBite(tick: number): void {
    const f = this.f;
    const map = f.body.map;
    const t = f.body.transform;
    // the bite lands on the shell's outer edge, round the body (deterministic: the angle follows the tick): march in
    // from outside the body along the angle to the first matter
    const a = ((tick * 0.6180339887) % 1) * Math.PI * 2;
    const ca = DMath.cos(a);
    const sa = DMath.sin(a);
    let r = Math.max(map.w, map.h) * 0.6;
    for (; r > map.coreRadius * 3; r -= 1) {
      const x = Math.floor(map.coreX + 0.5 + ca * r);
      const y = Math.floor(map.coreY + 0.5 + sa * r);
      if (x >= 0 && y >= 0 && x < map.w && y < map.h && map.material[y * map.w + x]) break;
    }
    if (r <= map.coreRadius * 3) return;
    // a little inside the edge, so the bite takes a mouthful of shell
    r -= 6;
    localToWorld(t, map.coreX + 0.5 + ca * r, map.coreY + 0.5 + sa * r, this.xy);
    const e2 = this.extraEv;
    const sh = this.extraShape;
    sh.kind = 'point';
    sh.x = this.xy.x;
    sh.y = this.xy.y;
    sh.r = 12;
    e2.type = 'TIDAL';
    e2.energy = 2400;
    const eye = { x: 0, y: 0 };
    localToWorld(t, map.coreX + 0.5, map.coreY + 0.5, eye);
    e2.dirX = eye.x - this.xy.x;
    e2.dirY = eye.y - this.xy.y;
    e2.originX = eye.x;
    e2.originY = eye.y;
    e2.sourceBodyId = -1;
    e2.params = { pull: 2 };
    const ate = f.world.applyDamage(f.body.id, e2).cellsRemoved;
    // the core thickens with a fraction of what it ate: starving, not healing
    const grown = Math.min(6, Math.floor(ate / 4));
    if (grown > 0) f.world.grow(f.body.id, { cells: grown, materialKey: 'core', nearX: eye.x, nearY: eye.y });
    this.view.cannibalAt = tick;
    this.cue('cannibal-strip');
  }

  /* ---------------------------------------------------------------------------------------------- hits taken */

  override intercept(ev: DamageEvent, _info: HitInfo, res: InterceptResult): void {
    const f = this.f;
    const m = f.mv;
    // Loosening exposes the core: a blow that reaches it lands twice (the copy is applied to the core itself)
    if (m.def?.id !== LOOSENING || m.phase !== 'active' || m.phaseTick >= 140) return;
    const e = this.eye();
    const map = f.body.map;
    const e2 = this.extraEv;
    const sh = this.extraShape;
    sh.kind = 'point';
    sh.x = e.x;
    sh.y = e.y;
    sh.r = map.coreRadius + 4;
    e2.type = ev.type;
    e2.energy = ev.energy * (1 - res.absorbed);
    e2.dirX = ev.dirX;
    e2.dirY = ev.dirY;
    e2.sourceMass = ev.sourceMass;
    e2.sourceBodyId = ev.sourceBodyId;
    e2.originX = ev.originX;
    e2.originY = ev.originY;
    e2.params = ev.params;
    if (e2.energy >= 1) res.extraCells += f.world.applyDamage(f.body.id, e2).cellsRemoved;
  }

  override onDamaged(energy: number, hitDirX: number, hitDirY: number): void {
    const f = this.f;
    if (!f.guardUp || energy <= 0) return;
    // Hold Shut swallows the blow: a little more Mass, and the plates flash where it landed
    f.resource = Math.min(f.resourceMax, f.resource + ABSORB_GAIN);
    this.view.absorbAt = f.tickNo;
    this.view.absorbX = -hitDirX * 70 * f.facing;
    this.view.absorbY = -hitDirY * 60;
    this.cue('shut-consume');
  }

  override guardMultiplier(): number {
    // Cannibal: it has no plates to spare
    return this.massFrac() < CANNIBAL_AT ? 0.55 : 1;
  }

  override adjustStats(s: EffectiveStats, massFrac: number): void {
    super.adjustStats(s, massFrac);
    if (massFrac < CANNIBAL_AT) {
      s.tempoMul *= 1.18;
      s.speedMul *= 1.1;
    }
  }

  override reset(heal: number): void {
    super.reset(heal);
    this.dropWell();
    for (const s of this.slugs) this.f.world.retireChunk?.(s.id);
    this.slugs = [];
    this.prevFoeMass = -1;
    this.cannibalAt = 0;
    this.idle?.reset();
    this.fx?.reset();
  }

  protected override hashState(h: number): number {
    let x = Math.imul(h ^ (this.wellOn ? 1 : 0), 0x01000193) >>> 0;
    x = Math.imul(x ^ this.cannibalAt, 0x01000193) >>> 0;
    x = Math.imul(x ^ this.slugs.length, 0x01000193) >>> 0;
    for (const s of this.slugs) x = Math.imul(x ^ s.id ^ (s.until << 8), 0x01000193) >>> 0;
    return x;
  }

  /* ---------------------------------------------------------------------------------------------- drawing */

  /** The move state the render side draws from (recorded on the tick). */
  private recordView(tick: number): void {
    const f = this.f;
    const m = f.mv;
    const v = this.view;
    v.id = m.def && !m.feint ? m.def.id : '';
    v.phase = m.def ? m.phase : '';
    v.phaseTick = m.phaseTick;
    v.moveTick = m.tick;
    v.startup = m.startup;
    v.active = m.active;
    v.recovery = m.recovery;
    v.charge = m.chargeMax > 0 ? clamp01(m.chargeTicks / m.chargeMax) : 0;
    v.aim = m.aim;
    v.facing = f.facing;
    v.cannibal = this.massFrac() < CANNIBAL_AT;
    if (f.guardUp !== v.guard) v.guardAt = tick;
    v.guard = f.guardUp;
    // Snap: where the whip tip caught the foe, and the foe's own colours to carry back
    if (v.id === SNAP && m.hits > 0 && v.snapHitAt < tick - 20) {
      v.snapHitAt = tick;
      const fm = (f.foe as unknown as { body?: { map: { baseColor: Uint32Array; material: Uint8Array } } })
        .body?.map;
      v.foeColorsN = 0;
      if (fm)
        for (let i = 0, k = 0; i < fm.material.length && v.foeColorsN < v.foeColors.length; i += 97, k++)
          if (fm.material[i]) v.foeColors[v.foeColorsN++] = fm.baseColor[i]! | 0xff000000;
    }
  }

  override renderLayers(view: ViewRect, _alpha: number, out: RenderLayer[]): void {
    const f = this.f;
    const body = out[out.length - 1]!;
    const seed = idleSeed(f.seed, f.slot);
    this.idle ??= new RemainderIdle(
      f.body.map,
      f.def.materials.map((mt) => mt.key),
      seed,
    );
    this.fx ??= new RemainderFx(f.body.map, f.def.materials, seed);
    const v = this.view;
    const ko = f.ko && f.stateTicks > 50;
    const act: RemainderAct = this.fx.act(v, this.drawTick);
    this.idle.render(
      body,
      f.body.map,
      { tick: this.drawTick, sinceHit: this.drawTick - f.lastHitTick, ko, act },
      out,
    );
    if (!ko) this.fx.render(body, f.body.map, v, this.drawTick, view, out, this.idle.skin);
  }
}
