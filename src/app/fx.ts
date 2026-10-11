import {
  TICK_HZ,
  clamp,
  type AudioScene,
  type DamageType,
  type FrameFx,
  type LensFx,
  type LightFx,
  type TitanId,
  type MatchApi,
  type CometFx,
  type ShockwaveFx,
  type WellFx,
  type SimEvent,
  type StageImpulseFx,
} from '@/contracts';
import { presentationEnergy } from '@/audio/balance';
import { MAX_COMETS, MAX_WELLS } from '@/stages/types';
import {
  MAX_VFX_IMPACTS,
  VFX_MAX_AGE,
  type FrameFxVfx,
  type VfxImpact,
  type VfxMatter,
  type VfxWeight,
} from '@/render/vfx';

/**
 * Turns the sim's event stream into the non-pixel per-frame inputs of the renderer: expanding shockwave rings, scenery
 * impulses (nebulae swirl, dust ripples), lensing sources, body and IMPACT lights, local wound refraction and the smoothed
 * fight intensity. Pure and deterministic; advanced once per sim tick, sampled once per rendered frame.
 *
 * D5 (no full-screen washes): a `flash`, a heavy hit and a KO become a LOCAL impact light at the wound (plus a local lens
 * refraction for heavy blows and the KO), never a whitening of the frame. Impact lights:
 *  - start at most every ONSET_GAP seconds (≤ 3 onsets per second); events inside the gap merge into the current light;
 *  - decay in WALL time (a tick lasts 1 / (60 × timeScale) s), so KO slow-motion does not stretch a light into a held wash;
 *  - are scaled by the comfort setting (`flashScale`), as is the refraction.
 * The intensity handed to the renderer (stage brightness, flow) is slew-limited so a hit can never step the frame's brightness.
 *
 * Arena comets (src/sim/hazards.ts): a comet-warn becomes a warning entry (an edge glint and the planned line), a
 * comet-enter a live comet read back every tick from the world's chunk state (so gravity bends it and a capture shows),
 * dropped on comet-retire or when the chunk is gone. Handed to the renderer as FrameFx.comets (proposal 165).
 * Gravity wells: each slot's world gravity source (MatterWorld.gravitySourceOf: the Planet's well and Tidal Draw, a Black
 * Hole's well) becomes FrameFx.wells, its pull mapped to 0..1 (WELL_FULL px/s² = 1), so the scenery's matter bends toward it.
 */
interface CometTrack {
  /** Matter chunk id; −1 while it is still a warning. */
  id: number;
  /** Warning: ticks elapsed and the warning's length. */
  age: number;
  life: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  captured: number;
}

interface Ring {
  x: number;
  y: number;
  age: number; // ticks
  life: number;
  radius: number;
  strength: number;
  hue: number;
  scenery: boolean;
}

interface ImpactLight {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  radius: number;
  /** Peak intensity (renderer units, ≈ 0..2). */
  peak: number;
  /** Peak local refraction strength 0..1. */
  refr: number;
  /** Wall seconds since onset, and the decay time constant. */
  age: number;
  tau: number;
  live: boolean;
}

/** Per-titan light: [r,g,b] 0..1, falloff radius px, base intensity. Bright bodies light the scenery and the other sprite. */
const TITAN_LIGHT: Partial<Record<TitanId, { c: [number, number, number]; radius: number; base: number }>> = {
  supernova: { c: [1, 0.72, 0.38], radius: 280, base: 0.95 },
  blackhole: { c: [1, 0.6, 0.32], radius: 210, base: 0.5 },
  // D36: the colossus (The Last One) keeps the celadon light; the Witness (id 'lastone') glows in its five eyes' violet
  colossus: { c: [0.62, 0.95, 0.88], radius: 120, base: 0.28 },
  lastone: { c: [0.82, 0.5, 1], radius: 110, base: 0.26 },
  nexus: { c: [1, 0.3, 0.42], radius: 130, base: 0.3 },
  planet: { c: [0.55, 0.72, 1], radius: 150, base: 0.16 },
  asteroid: { c: [0.75, 0.9, 1], radius: 70, base: 0.08 },
};
/**
 * Titans outside TITAN_LIGHT (우리, and any newcomer before its own entry): 우리 carries its hot core's light (uri hot ramp
 * #f49a48) at the Witness's reach and strength, a titan of the same scale.
 */
const lightOf = (id: TitanId): { c: [number, number, number]; radius: number; base: number } =>
  TITAN_LIGHT[id] ?? { c: [0xf4 / 255, 0x9a / 255, 0x48 / 255], radius: 120, base: 0.28 };
/** Colour of the light a blow of each damage type strikes from the wound. */
const TYPE_LIGHT: Record<DamageType, [number, number, number]> = {
  FRACTURE: [0.78, 0.95, 1],
  CRUSH: [1, 0.8, 0.55],
  KINETIC: [1, 0.9, 0.74],
  THERMAL: [1, 0.64, 0.34],
  TIDAL: [0.72, 0.64, 1],
  ASSIMILATION: [1, 0.42, 0.52],
};
/** The colossus's (The Last One's, D36) wounds glow white-gold at the core of a heavy blow and cyan otherwise (D27). */
const WITNESS_HEAVY: [number, number, number] = [1, 0.93, 0.72];
const WITNESS_LIGHT: [number, number, number] = [0.74, 0.95, 1];
const FLASH_LIGHT: [number, number, number] = [1, 0.93, 0.82];

const MAX_RINGS = 10;
const WAKE_SPEED = 150;
/** Bodies moving faster than this (px/s) push the stage dust. */
const RING_LIFE = 54;
const IMPULSE_LIFE = 130;
/** Impact-light slots (the renderer has 4 light slots: 2 bodies + these). */
export const IMPACT_SLOTS = 2;
/** Shortest wall time between two impact-light onsets (s): ≤ 3 onsets per second (D5). */
export const ONSET_GAP = 1 / 3;
/** Events this close (wall s) to the newest onset belong to the same burst (a hit, its flash and its KO on one tick). */
const SAME_BURST = 0.05;
/**
 * Screen-wide flash (D34): peak by blow weight [light, medium, heavy, catastrophic] (fraction of the flash colour added over the
 * frame; the original game's washes reached a 0.32 luminance change) and its decay time constant (s, wall).
 */
const WASH_PEAK = [0, 0, 0.18, 0.32];
const WASH_TAU = 0.075;
const WASH_WHITE: readonly [number, number, number] = [1, 0.96, 0.88];
/** A light is dropped once its envelope falls below this. */
const LIGHT_CUTOFF = 0.02;
/** Intensity slew (per wall second) for what the renderer sees: rising and falling. */
const SLEW_UP = 0.5;
const SLEW_DOWN = 0.25;
/** Blows below this energy (and not heavy) strike no light. */
const LIGHT_MIN_ENERGY = 900;

/**
 * Gravity pull (px/s² at half radius) that bends the scenery fully: the Planet's full Tidal Draw (~26 + 150, plus 140 while
 * shepherding a comet) reaches it; its ambient well (12–26) only stirs nearby debris.
 */
const WELL_FULL = 300;

export class FxState {
  private readonly rings: Ring[] = [];
  private heat = 0;
  private lowIntegrity = 0;
  private timeScale = 1;
  /** Slew-limited intensity for the renderer. */
  private visI = 0.12;
  /** Wall-clock seconds of sim time seen so far (ticks / (60 × timeScale)). */
  private wall = 0;
  private lastOnset = -1e9;
  /** Index of the newest impact light (bursts merge into it). */
  private newest = -1;
  private readonly impacts: ImpactLight[] = [];
  /** Comfort scale (0..1) applied to impact lights and refraction at sample time (1 = full; the D5 limits hold at 1). */
  flashScale = 1;
  private readonly out: FrameFx = {
    shockwaves: [],
    lenses: [],
    impulses: [],
    flash: 0,
    aberration: 0,
    intensity: 0,
    timeScale: 1,
  };
  private readonly lightPool: LightFx[] = [];
  private readonly lightSrc: { titan: TitanId; x: number; y: number; k: number }[] = [
    { titan: 'lastone', x: 0, y: 0, k: 0 },
    { titan: 'lastone', x: 0, y: 0, k: 0 },
  ];
  private readonly lensPool: LensFx[] = [
    { x: 0, y: 0, horizonR: 0, strength: 0 },
    { x: 0, y: 0, horizonR: 0, strength: 0 },
  ];
  private readonly wavePool: ShockwaveFx[] = [];
  private readonly impPool: StageImpulseFx[] = [];
  private readonly lightsOut: LightFx[] = [];
  private readonly cometTracks: CometTrack[] = [];
  /** Shared impact VFX (VFX_SPEC): one per landed blow, keyed on the blow's weight (hit.weight, proposal 171). */
  private readonly impactsVfx: VfxImpact[] = [];
  /** The screen-wide flash (D34): colour, peak, centre (world), and the wall time it struck. */
  private readonly wash = { r: 1, g: 1, b: 1, peak: 0, x: 0, y: 0, at: -1e9 };
  private readonly washOut = { r: 1, g: 1, b: 1, a: 0, x: 0, y: 0 };
  private readonly vfxOut: VfxImpact[] = [];
  /** Wall time of each attacker's last light-weight VFX (continuous slices land every few ticks: one spark burst per 0.1 s). */
  private readonly lastLight = [-1, -1];
  private readonly cometPool: CometFx[] = [];
  private readonly cometsOut: CometFx[] = [];
  private readonly wellPool: WellFx[] = [];
  private readonly wellsOut: WellFx[] = [];
  private readonly chunk = {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    spin: 0,
    mass: 0,
    radius: 0,
    mode: 0,
    owner: -1,
    origin: -1,
    temp: 0,
  };

  constructor() {
    for (let i = 0; i < MAX_RINGS; i++) {
      this.wavePool.push({ x: 0, y: 0, age: 0, radius: 0, strength: 0 });
      this.impPool.push({ x: 0, y: 0, strength: 0, radius: 0, age: 0, hue: -1 });
    }
    for (let i = 0; i < 2 + IMPACT_SLOTS; i++)
      this.lightPool.push({
        x: 0,
        y: 0,
        radius: 1,
        r: 1,
        g: 1,
        b: 1,
        intensity: 0,
        slot: i < 2 ? i : -1,
        kind: i < 2 ? 'body' : 'impact',
      });
    for (let i = 0; i < MAX_WELLS; i++) this.wellPool.push({ x: 0, y: 0, radius: 0, strength: 0 });
    for (let i = 0; i < MAX_COMETS; i++)
      this.cometPool.push({ x: 0, y: 0, vx: 0, vy: 0, r: 0, captured: 0, warn: 0 });
    for (let i = 0; i < IMPACT_SLOTS; i++)
      this.impacts.push({
        x: 0,
        y: 0,
        r: 1,
        g: 1,
        b: 1,
        radius: 1,
        peak: 0,
        refr: 0,
        age: 0,
        tau: 1,
        live: false,
      });
  }

  reset(): void {
    this.rings.length = 0;
    this.heat = this.lowIntegrity = 0;
    this.visI = 0.12;
    this.timeScale = 1;
    this.wall = 0;
    this.lastOnset = -1e9;
    this.newest = -1;
    for (const l of this.impacts) l.live = false;
    this.cometTracks.length = 0;
    this.impactsVfx.length = 0;
    this.wash.peak = 0;
    this.wash.at = -1e9;
    this.lastLight[0] = this.lastLight[1] = -1;
    this.wellsOut.length = 0;
  }

  private addRing(
    x: number,
    y: number,
    radius: number,
    strength: number,
    hue: number,
    scenery: boolean,
  ): void {
    if (this.rings.length >= MAX_RINGS) this.rings.shift();
    this.rings.push({
      x,
      y,
      age: 0,
      life: scenery ? IMPULSE_LIFE : RING_LIFE,
      radius,
      strength,
      hue,
      scenery,
    });
  }

  /** Current envelope 0..1 of an impact light. */
  private static env(l: ImpactLight): number {
    return l.live ? Math.exp(-l.age / l.tau) : 0;
  }

  /**
   * A local burst of light at (x, y). `force` (the KO) may open a new onset inside the gate only if nothing started in this
   * burst; otherwise a gated event merges into the newest light: it may move its refraction up, but adds no new brightening
   * step unless that light is still in its own burst (same tick).
   */
  private impact(
    x: number,
    y: number,
    c: readonly [number, number, number],
    peak: number,
    radius: number,
    tau: number,
    refr: number,
    force = false,
  ): void {
    const since = this.wall - this.lastOnset;
    const cur = this.newest >= 0 ? this.impacts[this.newest]! : null;
    if (cur && cur.live && since <= SAME_BURST) {
      // same burst: one light, the strongest of its parts
      if (peak > cur.peak) {
        cur.x = x;
        cur.y = y;
        cur.r = c[0];
        cur.g = c[1];
        cur.b = c[2];
        cur.peak = peak;
      }
      cur.radius = Math.max(cur.radius, radius);
      cur.tau = Math.max(cur.tau, tau);
      cur.refr = Math.max(cur.refr, refr);
      return;
    }
    if (since < ONSET_GAP && !force) {
      if (cur && cur.live) cur.refr = Math.max(cur.refr, refr * FxState.env(cur));
      return;
    }
    // a new onset: the free slot, else the weaker of the two
    let idx = 0;
    let weakest = Infinity;
    for (let i = 0; i < this.impacts.length; i++) {
      const l = this.impacts[i]!;
      const v = l.live ? l.peak * FxState.env(l) : -1;
      if (v < weakest) {
        weakest = v;
        idx = i;
      }
    }
    const l = this.impacts[idx]!;
    l.x = x;
    l.y = y;
    l.r = c[0];
    l.g = c[1];
    l.b = c[2];
    l.peak = peak;
    l.radius = radius;
    l.tau = tau;
    l.refr = refr;
    l.age = 0;
    l.live = true;
    this.newest = idx;
    this.lastOnset = this.wall;
  }

  /** Advance one sim tick with the events it produced. */
  tick(events: readonly SimEvent[], match: MatchApi): void {
    // a tick lasts 1/60 s of SIM time; under KO slow motion fewer ticks run per wall second, so a tick is longer in wall time
    const dtw = 1 / (TICK_HZ * clamp(match.timeScale || 1, 0.05, 1));
    this.wall += dtw;
    for (const l of this.impacts) {
      if (!l.live) continue;
      l.age += dtw;
      if (FxState.env(l) < LIGHT_CUTOFF) l.live = false;
    }
    const v0 = match.fighters[0].view;
    const v1 = match.fighters[1].view;
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      switch (e.t) {
        case 'shockwave':
          this.addRing(e.x, e.y, e.radius, e.strength, e.hue, false);
          this.addRing(e.x, e.y, e.radius * 1.6, e.strength, e.hue, true);
          this.heat += e.strength * 0.6;
          break;
        case 'hit': {
          this.vfxHit(e, match);
          // the move's energy, not the balance knobs (the attacker's balance.power out): lights, rings and heat stay put
          const en = presentationEnergy(e.energy, match.fighters[e.attacker].view.titan);
          this.heat += Math.min(1.5, en / 1500) * (1 - e.blocked * 0.6);
          if (en > 800) this.addRing(e.x, e.y, 60 + en * 0.04, 0.35, -1, true);
          if (e.heavy || en >= LIGHT_MIN_ENERGY) {
            const k = clamp((en - 600) / 3000, 0, 1);
            const open = 1 - 0.6 * clamp(e.blocked, 0, 1);
            const c = e.titan === 'colossus' ? (e.heavy ? WITNESS_HEAVY : WITNESS_LIGHT) : TYPE_LIGHT[e.type];
            this.impact(
              e.x,
              e.y,
              c,
              (0.45 + 0.8 * k) * open,
              60 + 90 * k,
              0.1 + 0.08 * k,
              e.heavy ? (0.25 + 0.45 * k) * open : 0,
            );
          }
          break;
        }
        case 'matter':
          if (e.mass > 2)
            this.addRing(
              e.x,
              e.y,
              40 + e.mass,
              clamp(e.mass / 60, 0.1, 0.6),
              e.kind === 'ignite' ? 0.06 : -1,
              true,
            );
          break;
        case 'flash': {
          const a = clamp(e.amount, 0, 1);
          // no position: the middle of the fight (the contract's "frame centre" for presentation)
          const x = e.x ?? (v0.x + v1.x) / 2;
          const y = e.y ?? (v0.y + v1.y) / 2;
          this.impact(x, y, FLASH_LIGHT, 0.6 + a, 90 + 110 * a, 0.16 + 0.2 * a, 0.5 * a);
          this.washAt(x, y, FLASH_LIGHT, 0.12 + 0.2 * a);
          break;
        }
        case 'ko': {
          const victim = match.fighters[e.slot].view.titan;
          // capped core (Gate B: a 1.6 / 200 px KO light blew a ~150 px area out): bright, local, the wound stays legible
          this.impact(e.x, e.y, lightOf(victim).c, 1.2, 130, 0.45, 1, true);
          this.washAt(e.x, e.y, WASH_WHITE, WASH_PEAK[3]!);
          this.heat += 3;
          break;
        }
        case 'ultimate':
          if (e.phase === 'start') this.heat += 2;
          break;
        case 'cue':
          // 우리's break-apart: the catastrophic recipe plus its snapping ring (S2 emits the cue)
          if (e.id === 'break-apart') this.pushVfx(e.x, e.y, 3, 0, 1, 'uri', true, match);
          break;
        case 'hazard':
          this.hazard(e, match);
          break;
      }
    }
    this.trackComets(match);
    this.trackWells(match);
    for (let i = this.impactsVfx.length - 1; i >= 0; i--) {
      const v = this.impactsVfx[i]!;
      v.age += dtw;
      if (v.age > VFX_MAX_AGE) this.impactsVfx.splice(i, 1);
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]!;
      if (++r.age >= r.life) this.rings.splice(i, 1);
    }
    this.heat *= 0.985;
    const low = 1 - Math.min(v0.integrityPct, v1.integrityPct) / 100;
    this.lowIntegrity += (low - this.lowIntegrity) * 0.02;
    this.timeScale = match.timeScale;
    // the renderer's intensity follows the fight's at a bounded rate: a heavy hit can no longer step the stage brightness
    const target = this.intensity();
    const d = target - this.visI;
    this.visI += d > 0 ? Math.min(d, SLEW_UP * dtw) : Math.max(d, -SLEW_DOWN * dtw);
    this.lensSrc[0] = { x: v0.x, y: v0.y, r: v0.lensRadius, s: v0.lensStrength };
    this.lensSrc[1] = { x: v1.x, y: v1.y, r: v1.lensRadius, s: v1.lensStrength };
    for (let i = 0; i < 2; i++) {
      const v = i === 0 ? v0 : v1;
      const src = this.lightSrc[i]!;
      src.titan = v.titan;
      src.x = v.x;
      src.y = v.y;
      // brighter while charging or striking, dimmer as its matter/fuel is spent
      const body = clamp(v.bodyStats.massFrac, 0.3, 1.2);
      const burst = (v.phase === 'active' ? 0.7 : 0) + v.chargeFrac * 0.8;
      src.k = clamp(
        body *
          (0.55 + 0.45 * (v.resourceMax > 0 && v.titan === 'supernova' ? v.resource / v.resourceMax : 1)) +
          burst,
        0,
        2,
      );
      // a heavy body moving through dust drags it along: gentle scenery wakes, rate-limited so shockwaves keep their slots
      const speed = Math.hypot(v.vx, v.vy);
      if (speed > WAKE_SPEED && (match.tick + i * 3) % 7 === 0 && this.rings.length < MAX_RINGS - 4) {
        const w = clamp((speed - WAKE_SPEED) / 260, 0, 1) * clamp(v.stats.mass / 8, 0.4, 1.3);
        this.addRing(v.x - Math.sign(v.vx || 1) * 30, v.y, 70 + w * 90, 0.08 + w * 0.22, -1, true);
      }
    }
  }
  private hazard(e: Extract<SimEvent, { t: 'hazard' }>, match: MatchApi): void {
    const tr = this.cometTracks;
    if (e.kind === 'comet-warn') {
      if (tr.length >= MAX_COMETS) return;
      const life = Math.max(1, match.arena.comets?.warn ?? 90);
      tr.push({ id: -1, age: 0, life, x: e.x, y: e.y, vx: e.vx, vy: e.vy, r: 0, captured: 0 });
    } else if (e.kind === 'comet-enter') {
      // the comet replaces its warning (the oldest one still pending)
      const w = tr.findIndex((c) => c.id < 0);
      if (w >= 0) tr.splice(w, 1);
      if (tr.length >= MAX_COMETS) return;
      tr.push({ id: e.id, age: 0, life: 0, x: e.x, y: e.y, vx: e.vx, vy: e.vy, r: 8, captured: 0 });
    } else {
      const i = tr.findIndex((c) => c.id === e.id);
      if (i >= 0) tr.splice(i, 1);
    }
  }

  /** Age the warnings, re-read the live comets from the world (gravity bends them, a capture pins them). */
  private trackComets(match: MatchApi): void {
    const tr = this.cometTracks;
    for (let i = tr.length - 1; i >= 0; i--) {
      const c = tr[i]!;
      if (c.id < 0) {
        // a warning outlives its entry tick only if the comet never came (round end): drop it then
        if (++c.age > c.life + 30) tr.splice(i, 1);
        continue;
      }
      const st = this.chunk;
      if (!match.world.chunkState?.(c.id, st)) {
        tr.splice(i, 1);
        continue;
      }
      c.x = st.x;
      c.y = st.y;
      c.vx = st.vx;
      c.vy = st.vy;
      c.r = st.radius;
      c.captured = st.mode === 1 || st.owner >= 0 ? 1 : 0;
    }
  }

  /** Each slot's gravity source this tick (positions are sim state, so no sub-tick extrapolation). */
  /**
   * A landed blow → one shared impact VFX at its weight (VFX_SPEC; `hit.weight` from the sim, proposal 171: guarded one step
   * lighter, a KO blow catastrophic). Events from before proposal 171 fall back to the sim's heavy flag. The debris matter
   * follows the STRUCK titan (the Witness's gold, the Planet's rock and magma).
   */
  /**
   * A screen-wide flash (D34: WJ wants the original's washes back). A stronger one replaces the current; a weaker one inside the
   * current's envelope is ignored. Peaks on its own frame, gone in ≈ 0.25 s (wall) so the wound reads right after.
   */
  private washAt(x: number, y: number, c: readonly [number, number, number], peak: number): void {
    const w = this.wash;
    if (peak < this.washLevel()) return;
    w.r = c[0];
    w.g = c[1];
    w.b = c[2];
    w.peak = peak;
    w.x = x;
    w.y = y;
    w.at = this.wall;
  }
  private washLevel(alphaSec = 0): number {
    const age = this.wall + alphaSec - this.wash.at;
    return age < 0 ? 0 : this.wash.peak * Math.exp(-age / WASH_TAU);
  }

  private vfxHit(e: Extract<SimEvent, { t: 'hit' }>, match: MatchApi): void {
    const w = e.weight ?? (e.heavy ? 'heavy' : e.energy >= 400 ? 'medium' : 'light');
    const weight = (['light', 'medium', 'heavy', 'catastrophic'] as const).indexOf(w) as VfxWeight;
    // heavy and catastrophic blows go screen-wide (D34), in the blow's own light
    if (weight >= 2) {
      const c = e.titan === 'colossus' ? WITNESS_HEAVY : (TYPE_LIGHT[e.type] ?? WASH_WHITE);
      this.washAt(e.x, e.y, c, WASH_PEAK[weight]! * (1 - 0.5 * clamp(e.blocked, 0, 1)));
    }
    if (weight === 0) {
      if (this.wall - this.lastLight[e.attacker]! < 0.1) return;
      this.lastLight[e.attacker] = this.wall;
    }
    const titan = match.fighters[e.target].view.titan;
    const matter: VfxMatter =
      titan === 'colossus'
        ? 'witness'
        : titan === 'planet'
          ? 'planet'
          : (titan as string) === 'uri'
            ? 'uri'
            : 'rock';
    this.pushVfx(e.x, e.y, weight, e.dirX, e.dirY, matter, false, match, e.attacker);
  }

  private pushVfx(
    x: number,
    y: number,
    weight: VfxWeight,
    dirX: number,
    dirY: number,
    matter: VfxMatter,
    snap: boolean,
    match: MatchApi,
    salt = 2,
  ): void {
    if (this.impactsVfx.length >= MAX_VFX_IMPACTS) this.impactsVfx.shift();
    this.impactsVfx.push({
      x,
      y,
      weight,
      age: 0,
      dirX,
      dirY,
      seed: (Math.imul(match.tick, 2654435761) ^ (salt * 7919 + this.impactsVfx.length)) >>> 0,
      matter,
      ...(snap ? { snap: true } : {}),
    });
  }

  private trackWells(match: MatchApi): void {
    const ws = this.wellsOut;
    ws.length = 0;
    for (let s = 0; s < 2 && ws.length < MAX_WELLS; s++) {
      const g = match.world.gravitySourceOf?.(s as 0 | 1);
      if (!g || !(g.radius > 1) || !(g.strength > 0)) continue;
      const w = this.wellPool[ws.length]!;
      w.x = g.x;
      w.y = g.y;
      w.radius = g.radius;
      w.strength = clamp(g.strength / WELL_FULL, 0, 1);
      ws.push(w);
    }
  }

  private readonly lensSrc: { x: number; y: number; r: number; s: number }[] = [
    { x: 0, y: 0, r: 0, s: 0 },
    { x: 0, y: 0, r: 0, s: 0 },
  ];

  /** Smoothed 0..1 fight intensity (damage rate, proximity to defeat). Drives the score; the renderer gets a slew-limited copy. */
  intensity(): number {
    return clamp(0.12 + this.heat * 0.18 + this.lowIntegrity * 0.45, 0, 1);
  }

  /** Frame fx for render alpha (sub-tick interpolation of ring ages). The returned object is reused every call. */
  sample(alpha: number): FrameFx {
    const o = this.out;
    o.shockwaves = [];
    o.impulses = [];
    o.lenses = [];
    let w = 0;
    let p = 0;
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i]!;
      const age = clamp((r.age + alpha) / r.life, 0, 1);
      if (r.scenery) {
        const im = this.impPool[p++ % MAX_RINGS]!;
        im.x = r.x;
        im.y = r.y;
        im.strength = r.strength * (1 - age * 0.7);
        im.radius = r.radius * (0.3 + 0.7 * Math.sqrt(age));
        im.age = age;
        im.hue = r.hue;
        o.impulses.push(im);
      } else {
        const sw = this.wavePool[w++ % MAX_RINGS]!;
        const ease = 1 - Math.pow(1 - age, 2.2);
        sw.x = r.x;
        sw.y = r.y;
        sw.age = age;
        sw.radius = r.radius * ease;
        sw.strength = r.strength * Math.pow(1 - age, 1.6);
        o.shockwaves.push(sw);
      }
    }
    const lights = this.lightsOut;
    lights.length = 0;
    for (let i = 0; i < 2; i++) {
      const src = this.lightSrc[i]!;
      const t = lightOf(src.titan);
      const lf = this.lightPool[i]!;
      lf.x = src.x;
      lf.y = src.y;
      lf.radius = t.radius * (0.85 + 0.15 * src.k);
      lf.r = t.c[0];
      lf.g = t.c[1];
      lf.b = t.c[2];
      lf.intensity = t.base * src.k;
      if (lf.intensity > 0.02) lights.push(lf);
    }
    // impact lights: newest first (the renderer keeps the first ones if it runs out of slots)
    const comfort = clamp(this.flashScale, 0, 1);
    const lightK = 0.3 + 0.7 * comfort;
    let flash = 0;
    let refr = 0;
    for (let n = 0; n < IMPACT_SLOTS; n++) {
      const idx = (this.newest - n + IMPACT_SLOTS * 2) % IMPACT_SLOTS;
      const l = this.impacts[idx]!;
      const e = FxState.env(l);
      if (e < LIGHT_CUTOFF) continue;
      const lf = this.lightPool[2 + n]!;
      lf.x = l.x;
      lf.y = l.y;
      lf.radius = l.radius;
      lf.r = l.r;
      lf.g = l.g;
      lf.b = l.b;
      lf.intensity = l.peak * e * lightK;
      lights.push(lf);
      flash = Math.max(flash, (l.peak * e) / 1.6);
      refr = Math.max(refr, l.refr * e);
    }
    o.lights = lights;
    let l = 0;
    for (let i = 0; i < 2; i++) {
      const s = this.lensSrc[i]!;
      if (s.r > 0) {
        const lf = this.lensPool[l++]!;
        lf.x = s.x;
        lf.y = s.y;
        lf.horizonR = s.r;
        lf.strength = s.s;
        o.lenses.push(lf);
      }
    }
    // `flash` is informational now (the renderer never whitens); `aberration` is the strongest local wound refraction
    o.flash = clamp(flash, 0, 1) * comfort;
    // the screen-wide flash: the renderer applies it scaled by the comfort setting (D5's limits are the comfort mode)
    const wo = this.washOut;
    wo.r = this.wash.r;
    wo.g = this.wash.g;
    wo.b = this.wash.b;
    wo.x = this.wash.x;
    wo.y = this.wash.y;
    wo.a = this.washLevel(alpha / TICK_HZ);
    (o as FrameFxVfx).wash = wo;
    o.aberration = clamp(refr, 0, 1) * comfort;
    o.intensity = this.visI;
    o.timeScale = this.timeScale;
    // arena comets: positions extrapolated by the render alpha (chunk velocities are px/s)
    const cs = this.cometsOut;
    cs.length = 0;
    for (let i = 0; i < this.cometTracks.length && i < MAX_COMETS; i++) {
      const c = this.cometTracks[i]!;
      const cf = this.cometPool[i]!;
      const live = c.id >= 0;
      cf.x = c.x + (live ? (c.vx * alpha) / TICK_HZ : 0);
      cf.y = c.y + (live ? (c.vy * alpha) / TICK_HZ : 0);
      cf.vx = c.vx;
      cf.vy = c.vy;
      cf.r = c.r;
      cf.captured = c.captured;
      cf.warn = live ? 0 : clamp((c.age + alpha) / c.life, 0.01, 1);
      cs.push(cf);
    }
    o.comets = cs;
    // shared impact VFX (ages in wall seconds, advanced per tick: the effects keep playing through hit-stop)
    const vo = this.vfxOut;
    vo.length = 0;
    for (const v of this.impactsVfx) vo.push(v);
    (o as FrameFxVfx).vfx = vo;
    o.wells = this.wellsOut;
    return o;
  }

  get ticksPerSecond(): number {
    return TICK_HZ;
  }
}

/** Continuous audio state for the adaptive score and per-titan drones. */
export function buildAudioScene(
  match: MatchApi,
  phase: AudioScene['phase'],
  intensity: number,
  listenerX: number,
): AudioScene {
  const f = (s: 0 | 1): NonNullable<AudioScene['fighters']>[0] => {
    const v = match.fighters[s].view;
    return {
      titan: v.titan,
      x: v.x,
      speed: Math.hypot(v.vx, v.vy),
      massFrac: v.bodyStats.massFrac,
      charge: v.chargeFrac,
      resource: v.resourceMax > 0 ? v.resource / v.resourceMax : 0,
      meter: v.meter,
      state: v.state,
    };
  };
  return {
    phase,
    stage: match.stage,
    intensity,
    listenerX,
    fighters: [f(0), f(1)],
    lowestIntegrity: Math.min(match.fighters[0].view.integrityPct, match.fighters[1].view.integrityPct) / 100,
    timeScale: match.timeScale,
  };
}
