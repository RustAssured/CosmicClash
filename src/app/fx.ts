import {
  TICK_HZ,
  clamp,
  type AudioScene,
  type FrameFx,
  type LensFx,
  type LightFx,
  type TitanId,
  type MatchApi,
  type ShockwaveFx,
  type SimEvent,
  type StageImpulseFx,
} from '@/contracts';

/**
 * Turns the sim's event stream into the non-pixel per-frame inputs of the renderer: expanding shockwave rings, scenery
 * impulses (nebulae swirl, dust ripples), lensing sources, flash / aberration decay and the smoothed fight intensity.
 * Pure and deterministic; advanced once per sim tick, sampled once per rendered frame.
 */
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

/** Per-titan light: [r,g,b] 0..1, falloff radius px, base intensity. Bright bodies light the scenery and the other sprite. */
const TITAN_LIGHT: Record<TitanId, { c: [number, number, number]; radius: number; base: number }> = {
  supernova: { c: [1, 0.72, 0.38], radius: 280, base: 0.95 },
  blackhole: { c: [1, 0.6, 0.32], radius: 210, base: 0.5 },
  lastone: { c: [0.62, 0.95, 0.88], radius: 120, base: 0.28 },
  nexus: { c: [1, 0.3, 0.42], radius: 130, base: 0.3 },
  planet: { c: [0.55, 0.72, 1], radius: 150, base: 0.16 },
  asteroid: { c: [0.75, 0.9, 1], radius: 70, base: 0.08 },
};
const MAX_RINGS = 10;
const WAKE_SPEED = 150;
/** Bodies moving faster than this (px/s) push the stage dust. */
const RING_LIFE = 54;
const IMPULSE_LIFE = 130;

export class FxState {
  private readonly rings: Ring[] = [];
  private flash = 0;
  private aberration = 0;
  private heat = 0;
  private lowIntegrity = 0;
  private timeScale = 1;
  /** Comfort scale (0..1) applied to flash and chromatic aberration at sample time. */
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
  private readonly lightPool: LightFx[] = [
    { x: 0, y: 0, radius: 1, r: 1, g: 1, b: 1, intensity: 0, slot: 0 },
    { x: 0, y: 0, radius: 1, r: 1, g: 1, b: 1, intensity: 0, slot: 1 },
  ];
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

  constructor() {
    for (let i = 0; i < MAX_RINGS; i++) {
      this.wavePool.push({ x: 0, y: 0, age: 0, radius: 0, strength: 0 });
      this.impPool.push({ x: 0, y: 0, strength: 0, radius: 0, age: 0, hue: -1 });
    }
  }

  reset(): void {
    this.rings.length = 0;
    this.flash = this.aberration = this.heat = this.lowIntegrity = 0;
    this.timeScale = 1;
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

  /** Advance one sim tick with the events it produced. */
  tick(events: readonly SimEvent[], match: MatchApi): void {
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      switch (e.t) {
        case 'shockwave':
          this.addRing(e.x, e.y, e.radius, e.strength, e.hue, false);
          this.addRing(e.x, e.y, e.radius * 1.6, e.strength, e.hue, true);
          this.heat += e.strength * 0.6;
          break;
        case 'hit':
          this.heat += Math.min(1.5, e.energy / 1500) * (1 - e.blocked * 0.6);
          if (e.heavy) this.aberration = Math.max(this.aberration, clamp(e.energy / 4000, 0.15, 0.7));
          if (e.energy > 800) this.addRing(e.x, e.y, 60 + e.energy * 0.04, 0.35, -1, true);
          break;
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
        case 'flash':
          this.flash = Math.max(this.flash, clamp(e.amount, 0, 1));
          break;
        case 'ko':
          this.flash = Math.max(this.flash, 0.9);
          this.aberration = Math.max(this.aberration, 1);
          this.heat += 3;
          break;
        case 'ultimate':
          if (e.phase === 'start') this.heat += 2;
          break;
      }
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]!;
      if (++r.age >= r.life) this.rings.splice(i, 1);
    }
    this.flash *= 0.86;
    this.aberration *= 0.93;
    this.heat *= 0.985;
    const v0 = match.fighters[0].view;
    const v1 = match.fighters[1].view;
    const low = 1 - Math.min(v0.integrityPct, v1.integrityPct) / 100;
    this.lowIntegrity += (low - this.lowIntegrity) * 0.02;
    this.timeScale = match.timeScale;
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
  private readonly lensSrc: { x: number; y: number; r: number; s: number }[] = [
    { x: 0, y: 0, r: 0, s: 0 },
    { x: 0, y: 0, r: 0, s: 0 },
  ];

  /** Smoothed 0..1 fight intensity (damage rate, proximity to defeat). */
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
    o.lights = [];
    for (let i = 0; i < 2; i++) {
      const src = this.lightSrc[i]!;
      const t = TITAN_LIGHT[src.titan];
      const lf = this.lightPool[i]!;
      lf.x = src.x;
      lf.y = src.y;
      lf.radius = t.radius * (0.85 + 0.15 * src.k);
      lf.r = t.c[0];
      lf.g = t.c[1];
      lf.b = t.c[2];
      lf.intensity = t.base * src.k;
      lf.slot = i;
      if (lf.intensity > 0.02) o.lights.push(lf);
    }
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
    o.flash = this.flash * this.flashScale;
    o.aberration = this.aberration * this.flashScale;
    o.intensity = this.intensity();
    o.timeScale = this.timeScale;
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
