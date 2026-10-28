import {
  Btn,
  CellFlag,
  DamageFlag,
  TICK_DT,
  clamp,
  clamp01,
  hex,
  smoothstep,
  type DamageEvent,
  type DamageShape,
  type DebugShape,
  type EffectiveStats,
  type FighterTickCtx,
  type MatterBody,
  type OverlapResult,
  type RenderLayer,
  type StageLighting,
  type TitanDef,
  type ViewRect,
} from '@/contracts';
import { generateCometBody } from '@/titans/art/comet';
import { generateMoonBody, paintPlanet } from '@/titans/art/planet';
import type { PlanetRig } from '@/titans';
import { Behaviour, type HitInfo, type InterceptResult } from '../behaviour';
import type { FighterImpl } from '../fighter';
import { BodyOverlay } from '../fx/bodyOverlay';
import { TrackedBodyLayer } from '../fx/bodyLayer';
import { GlowSprite } from '../fx/glowSprite';
import { idleSeed } from '../fx/idle';
import { PlanetIdle, type PlanetIdleInput } from './planetIdle';
import { bayer, glowD, rampAt, ribbon, ringBand, streak, tn } from '../fx/lib';
import { Overlay } from '../fx/overlay';
import type { ActiveMove } from '../move';
import { spinKeysOf } from '../pose';
import { asShape, makeFatShape, shapeIntersectsDisc } from '../shapes';
import { DMath, sq } from '@/contracts/dmath';

/** Moon modes. */
const ORBIT = 0;
const SLAM = 1;
const RETURN = 2;
const DRIFT = 3;
const GONE = 4;

/** Comet modes: none, falling in under the shepherd's pull, captured and spun up, slung at the foe, let go. */
const C_NONE = 0;
const C_INBOUND = 1;
const C_ORBIT = 2;
const C_FLY = 3;
const C_LOOSE = 4;

/** Share of a blow a moon in its way takes for the planet, and the most all moons together can soak. */
const MOON_SHARE = 0.22;
const SOAK_MAX = 0.3;
/** A moon shoved harder than this (impulse per unit of its remaining mass) is knocked out of orbit; below this mass fraction it breaks up. */
const KNOCK_LIMIT = 170;
const BREAK_FRAC = 0.28;
/** A drifting moon further than this from the planet is lost for good. */
const LOST_RADIUS = 300;

/*
 * SCALE (D28, docs/briefs/scale-spec.md). Everything here moves like weather and orbit: slow, continuous, lagging. Springs on
 * parts stay at ω ≤ 4 rad/s with ζ ≥ 0.45, impulses are ramped over IMPULSE_TICKS, no pattern changes per tick (dither masks
 * are fixed in space; shimmer runs below 0.5 Hz). Commands still change a pixel on their accept tick: through light (an aurora
 * flare, the debris ring brightening), never through a jump of anything big.
 */
/** Ticks over which an angular impulse (a blow's torque, a move's spin key, the world's own kicks) is fed into the spin. */
const IMPULSE_TICKS = 10;

/*
 * SPIN. The world turns about its tilted polar axis: ω (rad/s) and the surface phase θ (rad, FighterView.angle). Spin is never
 * coupled to travel (it is the world's own day, always prograde), so it cannot read as a rolling ball. It is shown by what turns
 * with the world: cloud bands (dragged behind the surface), aurora, the moons (which lag a spin-up) and the debris ring. A
 * commanded change is a target the spin is pulled toward by an under-damped spring, so a hard stop overshoots below the day rate
 * before the day carries on; blows add angular impulse through their lever arm (the fighter's impact model).
 */
/**
 * World sense of the Planet's own rotation, in the sign convention of the fighters' angular state (+ = clockwise on screen; for the
 * Planet, whose axis lies in the screen plane, + reads as its visible face moving toward +x): prograde with its moons, whose near
 * halves move toward −x. Facing the other way is a mirror, not a new rotation, so the sense does not depend on the foe's side.
 */
const PROGRADE = -1;
/** The world's own day (rad/s): clouds drift even when nothing happens. */
const SPIN_BASE = 0.14;
/** Spin a committed Tidal Rush winds up to (without authored spin keys), and the Cataclysm's / Core Pulse's. */
const SPIN_COMMIT = 2.4;
const SPIN_MAX = 4;
/** Spring of ω toward its target: ω0 = 2 rad/s (0.32 Hz), ζ 0.75 (one slow overshoot on stops). */
const SPIN_K = 4;
const SPIN_ZETA = 0.75;
/** How fast the atmosphere catches up with the surface (1/s): cloud bands lag a spin-up and trail a stop by ~0.7 s. */
const CLOUD_DRAG = 1.4;
/** Moons lag behind a spinning-up world (rad of orbit per rad/s² of spin acceleration) on a slow spring (ω0 1.7 rad/s). */
const MOON_LAG_GAIN = 0.03;
const MOON_LAG_K = 3;
const MOON_LAG_ZETA = 0.6;
/** Rotational Brace: a half-turn (with a counter-swing first) takes this many ticks; only if the far face is this much better. */
const TURN_TICKS = 36;
const BRACE_MARGIN = 0.04;
/** The shell swap starts this many ticks into the half-turn and runs over SWAP_TICKS (the cover is above 70 % throughout). */
const SWAP_AT = 9;
const SWAP_TICKS = 18;
/** How fast the moons swing into the Guard's shield position and back: a critically damped spring of this ω (rad/s; ~0.7 s). */
const GUARD_OMEGA = 3;
/** Cloud-texture px of smear per rad/s of atmospheric spin (bands streak), capped. */
const SMEAR_PER_SPIN = 2.6;
const SMEAR_MAX = 14;
/** The cloud deck's edge while the air is whole (the middle of the dithered band a thinning deck uses). */
const CLOUD_EDGE = 0.395;
/** Debris ring: motes (more as the crust breaks), radius (planet radii) slack and tight, flattening, tilt (the moons' plane). */
const RING_MOTES = 44;
const RING_LOOSE = 2.05;
const RING_TIGHT = 1.3;
const RING_FLAT = 0.26;
/** Aurora ovals: angular radius about each pole and samples around the oval. */
const AURORA_BETA = 0.4;
const AURORA_STEPS = 72;
/** Aurora colours from faint to bright: violet fringe, blue, green body, pale-green crest, white-hot. */
const AURORA_RAMP = ['#2a1a58', '#3048b0', '#28b888', '#78f0a8', '#e0fff0'].map(hex);
const AURORA_TOP = AURORA_RAMP.length - 1;

/*
 * DAMAGE PHASES (geological, monotonic within a round). 1 Intact World; 2 Fractured Crust (craters and faults; a bigger debris
 * ring = more Tidal Draw ammunition; the axis starts to wander); 3 Exposed Mantle (magma shows, the air is torn; Magma Vent; hotter,
 * harder blows; the Brace holds less); 4 Core Crisis (the moons are shaken loose, the core glows through; Core Pulse; fragile).
 * The wounded world is MORE dangerous: outgoing damage rises with the phase.
 */
const PHASE_POWER = [1, 1, 1.01, 1.05, 1.08];
const PHASE_BRACE = [1, 1, 0.94, 0.8, 0.64];
const PHASE_GRAVITY = [12, 12, 18, 22, 26];
/** Axis wander (precession wobble of aurora/ring, rad) per phase: a fractured world no longer turns true. */
const PHASE_WANDER = [0, 0, 0.05, 0.08, 0.12];
/** Most extra ticks a Moon Slam whip may run past its windup while it waits for its path to point at the foe. */
const WHIP_EXTRA = 50;
/** Ticks over which a moon caught back into orbit settles onto it (a slow glide instead of a snap). */
const SETTLE_TICKS = 40;
/** Holding Crush this many ticks into Tidal Rush turns it into the phase move. */
const HOLD_TICKS = 10;

/** Tidal Draw (R1): extra pull while held (px/s² at half radius), reach, and the armour it builds from what it draws in. */
const DRAW_PULL = 150;
const DRAW_REACH = 90;
const DRAW_IN = 0.5;
const DRAW_OUT = 0.8;
/**
 * The debris ring (matter capture, proposal 142): its radius (planet radii), the most chunks it holds, how often Tidal Draw
 * reaches for more, the share of a blow each ring chunk in its way soaks (armour), and the speed a ring chunk is thrown at
 * (Moon Slam with no moon in orbit: the world throws its debris).
 */
const RING_R = 1.75;
const RING_CAP = 12;
const CAPTURE_EVERY = 6;
const RING_SOAK = 0.1;
const RING_THROW = 540;

/** Failure (KO): the 2–4 s process, in ticks after the KO. */
const FAIL_VENT_END = 96;
const FAIL_MOONS_AT = 14;
const FAIL_SLAB_FROM = 40;
const FAIL_SLAB_EVERY = 14;
const FAIL_SLABS = 8;
const FAIL_CORE_FROM = 110;
const FAIL_CORE_OUT = 196;

interface SlamCfg {
  speed: number;
  accel: number;
  windup: number;
  turn: number;
  curve: number;
  energy: number;
  crater: number;
  compress: number;
  shock: number;
  recoil: number;
  life: number;
  breakFrac: number;
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
interface CometCfg {
  spawnDist: number;
  spawnRise: number;
  entrySpeed: number;
  orbit: number;
  w0: number;
  w1: number;
  spinUp: number;
  vRef: number;
  energy: number;
  life: number;
  /** Mass of a called-in nucleus (the throw's energy follows from it and the launch speed). */
  mass: number;
}
interface DriftCfg {
  curve: number;
  spin: number;
}

class Moon {
  body!: MatterBody;
  layer!: TrackedBodyLayer;
  mode = ORBIT;
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  /** Orbit angle. */
  ang = 0;
  age = 0;
  radius = 12;
  slamHit = false;
  /** Trail of recent positions for the flight ribbon. */
  readonly tx = new Float32Array(14);
  readonly ty = new Float32Array(14);
  spec!: PlanetRig['moons'][number];
  back = false;
  /** Phase offset from the nominal orbit (rad): the moon lags a spin-up, swings ahead when called on; a spring brings it home. */
  lag = 0;
  lagV = 0;
  /* the strike in flight: whip-round ticks left (and total), top speed, curve side, blow */
  windup = 0;
  windupMax = 1;
  speedMax = 9;
  accel = 0.45;
  turn = 0.07;
  curve = 0;
  energy = 0;
  crater = 14;
  compress = 8;
  shock = 1.2;
  life = 70;
  /** Set free by the world's failure: it drifts off and never comes home. */
  free = false;
  /** Ticks left of the glide back onto the orbit after a capture. */
  settle = 0;
}

/**
 * The comet: a debris chunk of the matter world (a nucleus the Planet calls in; later an arena comet), moved by the world's
 * gravity well while it falls in, by the Planet's capture ring once caught, and thrown with `launchChunk`.
 */
class Comet {
  /** Chunk id in the matter world (−1 = none). */
  id = -1;
  mode = C_NONE;
  /** Last read position and velocity (px, px/s). */
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  /** Ring spin while it is held in orbit (rad/s, prograde). */
  w = 0;
  age = 0;
  r = 10;
  /** Released: it will leave its orbit where its path points at the foe; ticks waited for that. */
  sling = false;
  slingWait = 0;
}

/** What `chunkState` reports (MatterWorldEx, proposal 142). `mode`: 0 free, 1 captured, 2 launched. */
interface ChunkInfo {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  mass: number;
  radius: number;
  mode: number;
  owner: number;
  origin: number;
  temp: number;
}

/** The far face of the shell, as it will be drawn after the next half-turn (map-sized arrays). */
interface FarFace {
  material: Uint8Array;
  density: Uint8Array;
  height: Uint8Array;
  baseColor: Uint32Array;
}

/**
 * The matter world's shell and capture API (MatterWorldEx, proposal 142; the far-face argument is proposal 135). Optional: the
 * combat test double has none of it, and then the Planet turns its sky only and keeps no ring.
 */
interface WorldExtras {
  defineShell?(bodyId: number, shell: number | Uint8Array, far?: FarFace): boolean;
  swapShell?(bodyId: number, ticks?: number): boolean;
  shellFace?(bodyId: number): number;
  setOrbit?(
    slot: 0 | 1,
    spec: { x: number; y: number; radius: number; omega: number; flatten?: number } | null,
  ): void;
  chunksInShape?(shape: DamageShape, out: Int32Array): number;
  chunkState?(id: number, out: ChunkInfo): boolean;
  captureChunk?(id: number, slot: 0 | 1): boolean;
  releaseChunk?(id: number): boolean;
  strikeChunk?(id: number, x: number, y: number, energy: number, dirX: number, dirY: number): boolean;
  launchChunk?(id: number, vx: number, vy: number, creditBodyId: number, slot?: 0 | 1 | -1): boolean;
}

/** The far side of the world, painted once per seed and light (paintPlanet with the world turned by π). */
const FAR_CACHE = new Map<string, FarFace>();
function farFaceOf(def: TitanDef, seed: number, lighting: StageLighting): FarFace {
  const key = `${seed >>> 0}|${lighting.dir.join(',')}|${lighting.color}|${lighting.ambient}`;
  let hit = FAR_CACHE.get(key);
  if (!hit) {
    const { map } = paintPlanet(def, seed, lighting, Math.PI);
    hit = { material: map.material, density: map.density, height: map.height, baseColor: map.baseColor };
    if (FAR_CACHE.size > 4) FAR_CACHE.delete(FAR_CACHE.keys().next().value as string);
    FAR_CACHE.set(key, hit);
  }
  return hit;
}

/**
 * Per-cell constants of the skin painter (static noise, dither thresholds, cloud-band rates, limb foreshortening), computed once
 * per rig and shared by every fighter on it: the skin loop then reads tables instead of calling noise per cell per redraw.
 */
interface SkinTables {
  /** Exposed crust value, dead-strata value, mantle band (static part), 4×4 Bayer threshold. */
  crustV: Float64Array;
  deadV: Float64Array;
  mantleB: Float64Array;
  bay: Float64Array;
  /** Cloud deck: latitude band rate, limb foreshortening, longitude in texture px, row offset (lat·256). */
  band: Float64Array;
  fore: Float64Array;
  lon: Float64Array;
  row: Int32Array;
}
const SKIN_TABLES = new Map<string, SkinTables>();
function skinTablesOf(rig: PlanetRig, w: number, h: number): SkinTables {
  // the rig's geometry (sphere, tilt, core) is the def's, not the seed's: one table set serves every match of the same world
  const key = `${w}x${h}|${rig.radius}|${rig.tilt}|${rig.core.x},${rig.core.y}`;
  let t = SKIN_TABLES.get(key);
  if (t) return t;
  const n = w * h;
  t = {
    crustV: new Float64Array(n),
    deadV: new Float64Array(n),
    mantleB: new Float64Array(n),
    bay: new Float64Array(n),
    band: new Float64Array(n),
    fore: new Float64Array(n),
    lon: new Float64Array(n),
    row: new Int32Array(n),
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      t.crustV[i] = 0.25 + 0.5 * tn(x * 0.5, y * 0.9 + 3) + 0.15 * (((x + y) & 3) === 0 ? 1 : 0);
      t.deadV[i] = 0.12 + 0.2 * tn(x * 0.4, y * 0.4);
      t.mantleB[i] =
        0.5 +
        0.5 * DMath.sin(DMath.hypot(x - rig.core.x, y - rig.core.y) * 0.55 + 2.2 * tn(x * 0.3, y * 0.3));
      t.bay[i] = bayer(x, y);
      const lat = rig.lat[i]!;
      // latitude bands turn at slightly different rates (the equator leads)
      t.band[i] = 1 + 0.5 * DMath.cos((lat / 127 - 0.5) * Math.PI);
      const nz = rig.nz[i]!;
      t.fore[i] = (0.45 + 0.55 * (nz / 255)) * Math.min(1, Math.max(0, (nz - 70) / 90));
      t.lon[i] = rig.lon[i]! / 256;
      t.row[i] = lat * 256;
    }
  if (SKIN_TABLES.size > 3) SKIN_TABLES.delete(SKIN_TABLES.keys().next().value as string);
  SKIN_TABLES.set(key, t);
  return t;
}

/** A full-circle arc for `ringBand` (shared: the default argument would allocate one per call). */
const FULL_ARC: [number, number] = [0, Math.PI * 2];

const INTERIOR = (r: PlanetRig['ids'], m: number): boolean =>
  m === r.crust || m === r.mantle || m === r.magma || m === r.core;
const DEEP = (r: PlanetRig['ids'], m: number): boolean => m === r.mantle || m === r.magma || m === r.core;

/** Half-turn ease with a counter-swing: the face first rocks back a little, then comes round and settles (0 → 1). */
function turnEase(u: number): number {
  const s = smoothstep(0, 1, u);
  return s - 0.3 * DMath.sin(Math.PI * u) * (1 - u) * (1 - u);
}

/** Weight of tick `k` (0..IMPULSE_TICKS−1) of a ramped impulse: a sin² bump that sums to 1. */
const RAMP_W = Array.from(
  { length: IMPULSE_TICKS },
  (_, k) => (2 / IMPULSE_TICKS) * sq(DMath.sin((Math.PI * (k + 0.5)) / IMPULSE_TICKS)),
);

/**
 * THE PLANET. A real world fighting: no face, no limbs, no shear. It weaponises orbit, rotation, gravity, moons and geology.
 *
 *  - Its moons are separate matter bodies on visible orbits (in front of and behind the world): Moon Slam (Strike) whips one round
 *    its orbit and curves it onto the foe; a broken moon shatters and its fragments carry on. Blows that reach a moon hurt the moon.
 *  - Tidal Rush (Crush) is the fighter's choreography; held, it becomes the move the world's damage phase allows: Crust Breaker,
 *    Magma Vent or Core Pulse. Orbital Drift (Surge) bends the dash around the foe and builds spin. Comet Shepherd (Signature,
 *    hold) calls a comet in, captures it into orbit, spins it up and slings it (Slingshot). Tidal Draw (R1) deepens the gravity
 *    well and packs what it draws back onto the world as crust. Rotational Brace (Guard) turns the more intact face to the foe.
 *  - It turns at its own day rate, is committed into spin by its moves and twisted by blows (see SPIN_*); the sky answers every
 *    command on its input tick (aurora, debris ring, moons, cloud deck), slowly, like weather.
 *  - Four geological damage phases change what it can do (see PHASE_*); at KO it fails over ~3 s: the air vents, the moons drift
 *    off, the crust slabs away, the core goes out last.
 * The two-face shell (a far hemisphere that exists as matter and swaps in on a half-turn) needs the matter API of proposal 132;
 * until then the Brace turns the mirror (the same map seen from its other side) under a cloud cover.
 */
export class PlanetBehaviour extends Behaviour {
  private rig!: PlanetRig;
  /** D31-6: the world's size against the authored one (`art.params.scale`, 1 = 121 px); the behaviour's own reaches scale with it. */
  private sc = 1;
  private moons: Moon[] = [];
  private readonly comet = new Comet();
  private skin!: BodyOverlay;
  private glow!: BodyOverlay;
  private halo!: GlowSprite;
  private haloCore!: GlowSprite;
  private fx!: Overlay;
  /** The living idle (planetIdle.ts): the turning, living face, the gravity pull, the ring of rubble behind and before the globe. */
  private idle!: PlanetIdle;
  private idleIn!: PlanetIdleInput;
  private rubBack!: Overlay;
  private rubFront!: Overlay;
  private cfg!: SlamCfg;
  private cometCfg!: CometCfg;
  private driftCfg: DriftCfg = { curve: 760, spin: 1.2 };
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
  private aimY = 0;
  private guardBlend = 0;
  private guardBlendV = 0;
  private guardIn = 0;
  private guardInV = 0;
  /* spin (see SPIN_*): surface ω / acceleration / phase, the atmosphere's lagging ω and phase, the commanded target */
  private omega = PROGRADE * SPIN_BASE;
  private alpha = 0;
  private theta = 0;
  private omegaAir = PROGRADE * SPIN_BASE;
  private thetaAir = 0;
  private spinCmd = 0;
  /** Spin as last published, to tell the impulse the fighter added since (its impact model, a move's authored spin keys). */
  private spinOut = PROGRADE * SPIN_BASE;
  /** Angular impulses being fed in over IMPULSE_TICKS: amount and age per slot. */
  private readonly impAmt = new Float64Array(8);
  private readonly impAge = new Int32Array(8).fill(-1);
  /** The drawn facing the cloud phase was last advanced with (+1 / −1): the local sense of the world's spin. */
  private airSense = 1;
  /** The matter world's shell and capture API (absent on test doubles), and whether this world has its two-face shell. */
  private wx!: WorldExtras;
  private shellOn = false;
  /** Half-turn progress in ticks (−1 = not turning) and this tick's extra phase rate from it (rad/s). */
  private turnTick = -1;
  private turnRate = 0;
  private wasGuard = false;
  /** Pristine live cells of the near face (all, and its shell only), and the near face's shell integrity now (0..1). */
  private nearPristineAll = 1;
  private nearPristineShell = 1;
  private nearIntegrity = 1;
  /** The debris ring's captured chunks (ids), and scratch for chunk queries. */
  private readonly ringIds: number[] = [];
  private readonly idsTmp = new Int32Array(64);
  private readonly info: ChunkInfo = {
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
  /** Debris ring: phase (rad), tightness 0..1 and its target, brightness pulse; aurora pulse; axis wander phase. */
  private ringPhase = 0;
  private ringTight = 0;
  private ringTarget = 0;
  private ringGlow = 0;
  private auroraPulse = 0;
  private wander = 0;
  /** The command this behaviour answered on its input tick (feel `respond`), and that tick. */
  private respondCmd = '';
  private respondTick = -1;
  private forceSkin = false;
  /** Damage phase 1..4 (monotonic within a round), and the deep strata currently exposed (cells). */
  private phase = 1;
  private expoDeep = 0;
  /* Tidal Draw */
  private drawT = 0;
  private wasDraw = false;
  /* Orbital Drift: which side the dash bends to */
  private driftSide = 1;
  /* failure: ticks since the KO (−1 = standing) */
  private failT = -1;
  private coreOut = 0;
  /* monitoring */
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
    this.cfg = f.movesById.get('planet.moonslam')!.extra!['slam'] as SlamCfg;
    this.cometCfg = f.movesById.get('planet.comet')!.extra!['comet'] as CometCfg;
    this.driftCfg =
      (f.movesById.get('planet.shift')?.extra?.['drift'] as DriftCfg | undefined) ?? this.driftCfg;
    this.barrage = (f.slotMoves.ultimate?.extra?.['barrage'] as BarrageCfg | undefined) ?? null;
    const map = f.body.map;
    this.skin = new BodyOverlay('planet-skin', 0.2, map.w, map.h, 'normal', true);
    this.glow = new BodyOverlay('planet-glow', 0.3, map.w, map.h, 'add', true);
    this.sc = (f.def.art.params as { scale?: number }).scale ?? 1;
    // the prototype's halo at 80 % (WJ 2026-10-18): out to 1.7 R, full at the limb, its colour [90,170,255] × 0.16 × 0.8
    // over the alpha the halo rests at (≈ 0.78)
    this.halo = new GlowSprite(
      'planet-halo',
      -0.5,
      Math.round(1.7 * r.radius * this.sc),
      [15, 28, 42],
      0.59,
      6,
    );
    this.haloCore = new GlowSprite(
      'planet-halo-core',
      -0.4,
      Math.round(96 * this.sc),
      [190, 64, 20],
      0.35,
      6,
    );
    this.fx = new Overlay('planet-fx', 20, 800, 560, 'add', true);
    this.expo = new Uint8Array(map.w * map.h);
    // the skin painter's per-cell constants, built here (match creation) rather than on the first painted frame
    this.skinT = skinTablesOf(r, map.w, map.h);
    // light on every face cell (0..255), from the same key the painter used
    const L = f.lighting;
    const kx = L.dir[0] * 0.8;
    const ky = L.dir[1];
    const kz = L.dir[2];
    const kn = DMath.hypot(kx, ky, kz) || 1;
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
    // the living idle: the rubble ring's two halves on either side of the globe (normal blend), the idle on the skin
    const rw = Math.ceil(r.radius * 7.4) + 16;
    const rh = Math.ceil(r.radius * 5.6) + 16;
    this.rubBack = new Overlay(
      'planet-rubble-back',
      -0.6,
      Math.max(rw, 480),
      Math.max(rh, 360),
      'normal',
      false,
    );
    this.rubFront = new Overlay(
      'planet-rubble-front',
      0.6,
      Math.max(rw, 480),
      Math.max(rh, 360),
      'normal',
      true,
    );
    // loose rocks, as the prototype draws them: no titan outline round each pebble
    this.rubBack.layer.outline = false;
    this.rubFront.layer.outline = false;
    this.idle = new PlanetIdle(
      f.def,
      f.seed,
      f.lighting,
      map,
      r,
      { x: f.def.art.coreX + 0.5, y: f.def.art.coreY + 0.5 },
      { magma: this.magma, crust: this.crustR },
      idleSeed(f.seed, f.slot),
    );
    this.idleIn = {
      omega: 0,
      turnRate: 0,
      omegaAir: 0,
      facing: 1,
      rest: true,
      ko: false,
      swapping: false,
      phase: 1,
      ringTight: 0,
      ringGlow: 0,
      coreOut: 0,
      x: 0,
      y: 0,
      m0x: 0,
      m0y: 0,
      m0back: false,
      m0on: false,
      m0r: 12,
      m1x: 0,
      m1y: 0,
      m1back: false,
      m1on: false,
      m1r: 12,
    };
    // the two-face world: the shell outside the magma exists twice; its far face is the far side of the world, painted (other
    // continents, the same sun). The census of the near face as it was made is the Brace's reference.
    this.wx = f.world as unknown as WorldExtras;
    this.censusNear();
    this.nearPristineAll = Math.max(1, this.nearAll);
    this.nearPristineShell = Math.max(1, this.nearShell);
    this.shellOn =
      typeof this.wx.defineShell === 'function' &&
      this.wx.defineShell(f.body.id, r.magmaR + 2, farFaceOf(f.def, f.seed, f.lighting));
    // the debris ring: chunks the world captures ride it (ammunition and armour)
    this.ringIds.length = 0;
    // the moons: real bodies
    this.moons = [];
    const specs = r.moons;
    for (let i = 0; i < specs.length; i++) this.spawnMoon(i);
    f.resourceMax = specs.length;
    f.resource = specs.length;
    this.resetSpin();
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
        m.free = false;
      } else {
        if (m) m.layer.layer.visible = false;
        this.spawnMoon(i);
      }
    }
    this.dropComet();
    f.resource = this.moons.length;
    f.resourceMax = this.moons.length;
    this.barrageNext = 0;
    this.quaked = false;
    this.atmoCue = 0;
    this.phase = 1;
    this.failT = -1;
    this.coreOut = 0;
    this.drawT = 0;
    this.wasDraw = false;
    this.clearRing();
    this.resetSpin();
    this.updateOrbit(f.tickNo, true);
    this.idle.reset();
  }

  /** A new round: the world turns at its own day rate, its near face toward the foe, ring slack. */
  private resetSpin(): void {
    this.omega = PROGRADE * SPIN_BASE;
    this.alpha = 0;
    this.theta = 0;
    this.omegaAir = this.omega;
    this.thetaAir = 0;
    this.spinCmd = 0;
    this.impAge.fill(-1);
    this.turnTick = -1;
    this.turnRate = 0;
    this.wasGuard = false;
    this.ringPhase = 0;
    this.ringTight = 0;
    this.ringTarget = 0;
    this.ringGlow = 0;
    this.auroraPulse = 0;
    this.wander = 0;
    this.respondCmd = '';
    this.respondTick = -1;
    for (const m of this.moons) {
      m.lag = 0;
      m.lagV = 0;
    }
    this.writeAngular();
  }

  /**
   * Publish the angular state (FighterView.angle/spin, hashed by the match): the surface phase (every half-turn included, wrapped to
   * ±π) and its rate, in the world sense of the fighter's angular model (+ = clockwise on screen). The fighter's own free-spin state
   * (`ang`, where its impact model adds the angular impulse of blows) is set to the same values, so what the fighter publishes after
   * this behaviour has run is this state, and the next tick's difference is exactly the impulse it added (see `stepSpin`).
   */
  private writeAngular(): void {
    const TAU = Math.PI * 2;
    let a = this.theta - Math.floor(this.theta / TAU) * TAU;
    if (a > Math.PI) a -= TAU;
    this.theta = a;
    const spin = this.omega + this.turnRate;
    const v = this.f.view;
    v.angle = a;
    v.spin = spin;
    const ang = (this.f as unknown as { ang?: { angle: number; spin: number } }).ang;
    if (ang) {
      ang.angle = a;
      ang.spin = spin;
    }
    this.spinOut = spin;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  spin and orientation
   * ---------------------------------------------------------------------------------------------- */

  /** Surface spin (rad/s, world sense, a half-turn in progress included) and the cloud deck's, which drags behind it. */
  get spin(): number {
    return this.omega + this.turnRate;
  }
  get cloudSpin(): number {
    return this.omegaAir + this.turnRate;
  }
  /** True while the world's other face (not the one it began the round with) is toward the viewer and the foe. */
  get bracedFace(): boolean {
    return this.shellOn && (this.wx.shellFace?.(this.f.body.id) ?? 0) === 1;
  }
  /** True when the world has its two-face shell (the real matter world; the test double has none). */
  get twoFaced(): boolean {
    return this.shellOn;
  }
  get turning(): boolean {
    return this.turnTick >= 0;
  }
  /** The world's damage phase, 1 (intact) … 4 (core crisis). */
  get damagePhase(): number {
    return this.phase;
  }
  /** 0..1 how far Tidal Draw has deepened the well, and the chunks riding the debris ring. */
  get drawLevel(): number {
    return this.drawT;
  }
  get ringCount(): number {
    return this.ringIds.length;
  }
  /** Ticks since the KO (−1 while standing) and how far the core light has gone out (0..1). */
  get failure(): number {
    return this.failT;
  }
  get coreLight(): number {
    return 1 - this.coreOut;
  }
  /** Comet state: mode (0 none, 1 inbound, 2 orbit, 3 slung, 4 let go), position, speed (px/s). */
  get cometMode(): number {
    return this.comet.mode;
  }
  get cometPos(): { x: number; y: number; speed: number } {
    const c = this.comet;
    return { x: c.x, y: c.y, speed: DMath.hypot(c.vx, c.vy) };
  }

  /**
   * Integrity (0..1 of pristine, live shell cells) of the face toward the viewer and the foe, and of the face turned away. The far
   * face is the world's whole count minus the near face (stats count both faces and the shared core once).
   */
  faceIntegrity(out: { near: number; far: number }): void {
    this.censusNear();
    out.near = this.nearShell / this.nearPristineShell;
    if (!this.shellOn) {
      out.far = out.near;
      return;
    }
    // stats count the world as one: the near face plus the far face's LOSSES (cells = near + farCells − farInitialCells, against
    // the near face's initial count), so a turn never changes the world's health; the far face's integrity is what it has lost
    // against its pristine shell (the same shell, seen from the other side)
    const s = this.f.world.stats(this.f.body.id);
    out.far = clamp01(1 + (s.cells - this.nearAll) / this.nearPristineShell);
  }

  /** Live cells of the near face: all of them, and those of its shell (outside the shared magma and core). */
  private nearAll = 0;
  private nearShell = 0;
  private censusNear(): void {
    this.refreshCensus();
  }

  /* ---- the census by dirty rows (D31-6 perf: the 220 px world has 3.3× the cells) ---------------------------------------- *
   * One pass keeps every per-cell count the behaviour needs — the near face's cells and shell (the Brace, the phases), the air
   * and the seas (`monitor`), the exposure marks and the deep strata they show (the Exposed Mantle phase, the skin) — per ROW.
   * A refresh compares the map against a snapshot four cells at a time (material, and the SURFACE bit the exposure reads) and
   * recounts only the rows that changed; the exposure marks are redone only in the band those rows can reach (±3 cells). The
   * results are exactly those of a full scan of the current map; a quiet world costs one word compare per 4 cells. */
  private cenMat: Uint8Array | null = null;
  private cenViewOf: Uint8Array | null = null;
  private cenM32: Uint32Array | null = null;
  private cenF32: Uint32Array | null = null;
  private cenS32: Uint32Array | null = null;
  private cenSS32: Uint32Array | null = null;
  private cenSnapM = new Uint8Array(0);
  private cenSnapS = new Uint8Array(0);
  private cenDirty = new Uint8Array(0);
  private rowAll = new Int32Array(0);
  private rowShell = new Int32Array(0);
  private rowAir = new Int32Array(0);
  private rowSea = new Int32Array(0);
  private rowDeep = new Int32Array(0);
  private rowExpo = new Int32Array(0);
  private airCells = 0;
  private seaCells = 0;
  private expoCells = 0;

  private refreshCensus(): void {
    const map = this.f.body.map;
    const W = map.w;
    const H = map.h;
    const n = W * H;
    const mat = map.material;
    const fl = map.flags;
    const dirty = this.cenDirty.length === H ? this.cenDirty : (this.cenDirty = new Uint8Array(H));
    if (this.cenMat !== mat || this.cenSnapM.length !== n) {
      // a new map (or the first census): every row is dirty
      this.cenMat = mat;
      this.cenViewOf = null;
      this.cenSnapM = new Uint8Array(n);
      this.cenSnapS = new Uint8Array(n);
      this.rowAll = new Int32Array(H);
      this.rowShell = new Int32Array(H);
      this.rowAir = new Int32Array(H);
      this.rowSea = new Int32Array(H);
      this.rowDeep = new Int32Array(H);
      this.rowExpo = new Int32Array(H);
      if (this.expo.length !== n) this.expo = new Uint8Array(n);
      this.expo.fill(0);
      this.airCells = this.seaCells = this.expoCells = 0;
      this.nearAll = this.nearShell = this.expoDeep = 0;
      dirty.fill(1);
    } else {
      dirty.fill(0);
      const snapM = this.cenSnapM;
      const snapS = this.cenSnapS;
      const surf = CellFlag.SURFACE;
      const words = n >> 2;
      // word views of the map and the snapshot (built once per map, so a refresh allocates nothing)
      if (this.cenViewOf !== mat) {
        this.cenViewOf = mat;
        this.cenM32 = mat.byteOffset % 4 === 0 ? new Uint32Array(mat.buffer, mat.byteOffset, words) : null;
        this.cenF32 = fl.byteOffset % 4 === 0 ? new Uint32Array(fl.buffer, fl.byteOffset, words) : null;
        this.cenS32 = new Uint32Array(snapM.buffer, 0, words);
        this.cenSS32 = new Uint32Array(snapS.buffer, 0, words);
      }
      const m32 = this.cenM32;
      const s32 = this.cenS32!;
      const aligned = m32 !== null;
      const surfMask = surf * 0x01010101;
      const f32 = this.cenF32;
      const ss32 = this.cenSS32!;
      let any = false;
      for (let k = 0; k < words; k++) {
        const changed = aligned
          ? m32[k] !== s32[k] || f32 === null || (f32[k]! & surfMask) >>> 0 !== ss32[k]
          : true;
        if (!changed) continue;
        // a word that differs (or an unaligned map, checked cell by cell below) marks its rows
        const c0 = k << 2;
        for (let c = c0; c < c0 + 4; c++)
          if (mat[c] !== snapM[c] || (fl[c]! & surf) !== snapS[c]) {
            dirty[(c / W) | 0] = 1;
            any = true;
          }
      }
      for (let c = words << 2; c < n; c++)
        if (mat[c] !== snapM[c] || (fl[c]! & surf) !== snapS[c]) {
          dirty[(c / W) | 0] = 1;
          any = true;
        }
      if (!any) return;
    }
    const ids = this.rig.ids;
    const cx = map.coreX + 0.5;
    const cy = map.coreY + 0.5;
    const r2 = sq(this.rig.magmaR + 2);
    const snapM = this.cenSnapM;
    const snapS = this.cenSnapS;
    const surf = CellFlag.SURFACE;
    // 1. counts of the dirty rows; the snapshot catches up with them
    let y0 = H;
    let y1 = -1;
    for (let y = 0; y < H; y++) {
      if (dirty[y] === 0) continue;
      if (y < y0) y0 = y;
      y1 = y;
      const row = y * W;
      const dy = y + 0.5 - cy;
      let all = 0;
      let shell = 0;
      let air = 0;
      let sea = 0;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        const mm = mat[i]!;
        snapM[i] = mm;
        snapS[i] = fl[i]! & surf;
        if (mm === 0) continue;
        all++;
        const dx = x + 0.5 - cx;
        if (dx * dx + dy * dy > r2) shell++;
        if (mm === ids.atmosphere || mm === ids.cloud) air++;
        else if (mm === ids.ocean) sea++;
      }
      this.nearAll += all - this.rowAll[y]!;
      this.nearShell += shell - this.rowShell[y]!;
      this.airCells += air - this.rowAir[y]!;
      this.seaCells += sea - this.rowSea[y]!;
      this.rowAll[y] = all;
      this.rowShell[y] = shell;
      this.rowAir[y] = air;
      this.rowSea[y] = sea;
    }
    if (y1 < 0) return;
    // 2. exposure marks: a change in rows y0..y1 can only move marks in rows y0−3..y1+3, which come from surface cells in rows
    // y0−6..y1+6 (each surface cell marks the interior cells within 3 of it). Clear that band, re-mark it from its sources.
    const expo = this.expo;
    const b0 = Math.max(0, y0 - 3);
    const b1 = Math.min(H - 1, y1 + 3);
    expo.fill(0, b0 * W, (b1 + 1) * W);
    const s0 = Math.max(3, y0 - 6);
    const s1 = Math.min(H - 4, y1 + 6);
    for (let y = s0; y <= s1; y++)
      for (let x = 3; x < W - 3; x++) {
        const i = y * W + x;
        if (mat[i] === 0 || (fl[i]! & surf) === 0) continue;
        const ya = Math.max(b0, y - 3);
        const yb = Math.min(b1, y + 3);
        for (let yy = ya; yy <= yb; yy++)
          for (let dx = -3; dx <= 3; dx++) {
            const j = yy * W + x + dx;
            if (mat[j] !== 0 && INTERIOR(ids, mat[j]!)) expo[j] = 1;
          }
      }
    for (let y = b0; y <= b1; y++) {
      let e = 0;
      let deep = 0;
      const row = y * W;
      for (let x = 0; x < W; x++)
        if (expo[row + x] === 1) {
          e++;
          if (DEEP(ids, mat[row + x]!)) deep++;
        }
      this.expoCells += e - this.rowExpo[y]!;
      this.expoDeep += deep - this.rowDeep[y]!;
      this.rowExpo[y] = e;
      this.rowDeep[y] = deep;
    }
    this.expoAny = this.expoCells > 0;
  }

  /** Queue angular impulse (rad/s, world sense), scaled up by how light the wounded world has become; fed in over IMPULSE_TICKS. */
  private kickSpin(dw: number): void {
    const inertia = Math.max(0.45, this.f.view.bodyStats.massFrac);
    this.queueImpulse(dw / inertia);
  }

  private queueImpulse(dw: number): void {
    // a free slot, else the youngest busy one (the new impulse then rides its schedule, scaled so none of it is lost)
    let slot = -1;
    let young = 0;
    for (let k = 0; k < this.impAge.length; k++) {
      if (this.impAge[k]! < 0) {
        slot = k;
        break;
      }
      if (this.impAge[k]! < this.impAge[young]!) young = k;
    }
    if (slot >= 0) {
      this.impAmt[slot] = dw;
      this.impAge[slot] = 0;
      return;
    }
    let left = 0;
    for (let a = this.impAge[young]!; a < IMPULSE_TICKS; a++) left += RAMP_W[a]!;
    this.impAmt[young] = this.impAmt[young]! + dw / Math.max(0.05, left);
  }

  /** This tick's share of every queued impulse (rad/s). */
  private drainImpulses(): number {
    let dw = 0;
    for (let k = 0; k < this.impAge.length; k++) {
      const age = this.impAge[k]!;
      if (age < 0) continue;
      dw += this.impAmt[k]! * RAMP_W[age]!;
      this.impAge[k] = age + 1 >= IMPULSE_TICKS ? -1 : age + 1;
    }
    return dw;
  }

  /**
   * The commanded spin for the current move (rad/s above the day rate, in the prograde sense): Tidal Rush winds the world up over
   * its windup and lets go after the blow (unless its choreography authors spin keys, which the fighter applies and `stepSpin`
   * folds in), the Cataclysm and the Core Pulse spin it to the limit, Crust Breaker winds it hard, Moon Slam and the Comet
   * Shepherd wind up with the hold, Orbital Drift carries spin through the dash, Tidal Draw slows the surface a little.
   */
  private spinTarget(m: ActiveMove): number {
    const id = m.def?.id ?? '';
    if (this.failT >= 0) return -SPIN_BASE * 0.6;
    if (this.drawT > 0) return -0.08 * this.drawT;
    if (!m.def || m.feint || spinKeysOf(m)) return 0;
    const q = m.phase === 'startup' ? smoothstep(0, 1, m.phaseTick / Math.max(1, m.startup)) : 1;
    switch (id) {
      case 'planet.impact':
        return m.phase === 'recovery' ? 0 : (SPIN_COMMIT - SPIN_BASE) * q;
      case 'planet.cataclysm':
        if (m.phase === 'startup') return (SPIN_MAX - SPIN_BASE) * q;
        return m.phase === 'active' && m.phaseTick - 1 < 52 ? SPIN_MAX - SPIN_BASE : 0;
      case 'planet.corepulse':
        return m.phase === 'recovery' ? 0 : (SPIN_MAX - SPIN_BASE) * q;
      case 'planet.crustbreaker':
        return m.phase === 'recovery' ? 0 : 1.8 * q;
      case 'planet.magmavent':
        return m.phase === 'recovery' ? 0 : 0.5;
      case 'planet.moonslam':
        if (m.phase === 'startup') return 0.4 * q;
        return m.phase === 'charge' ? 0.4 + 0.8 * clamp01(m.chargeTicks / Math.max(1, m.chargeMax)) : 0;
      case 'planet.comet':
        return m.phase === 'charge' ? 0.7 * clamp01(m.chargeTicks / 60) : 0;
      case 'planet.shift':
        return 0.9;
      default:
        return 0;
    }
  }

  /**
   * One tick of the angular state: queue the impulse the fighter's own angular state received since we last published it (a
   * blow's torque from the impact model, or a move's authored spin key) and feed every queued impulse in on its ramp, spring toward
   * the commanded spin, drag the atmosphere, advance the phases and the Brace half-turn, swing the moons, the ring and the aurora.
   */
  private stepSpin(m: ActiveMove): void {
    const dt = TICK_DT;
    const f = this.f;
    const before = this.omega;
    const ang = (f as unknown as { ang?: { spin: number } }).ang;
    const ext = ang ? ang.spin - this.spinOut : 0;
    if (Math.abs(ext) > 1e-6) this.queueImpulse(ext);
    this.omega = clamp(this.omega + this.drainImpulses(), -SPIN_MAX, SPIN_MAX);

    this.spinCmd = this.spinTarget(m);
    const target = PROGRADE * (SPIN_BASE + this.spinCmd);
    const w0 = Math.sqrt(SPIN_K);
    const acc = SPIN_K * (target - this.omega) - 2 * SPIN_ZETA * w0 * this.alpha;
    this.alpha += acc * dt;
    this.omega = clamp(this.omega + this.alpha * dt, -SPIN_MAX, SPIN_MAX);
    const angAcc = (this.omega - before) / dt;
    this.omegaAir += (this.omega - this.omegaAir) * Math.min(1, CLOUD_DRAG * dt);
    // the Brace half-turn: an eased π of extra phase (a counter-swing first) in the sense the world already turns; the mirror
    // swaps where the ease crosses half-way, under the cloud cover
    this.turnRate = 0;
    if (this.turnTick >= 0) {
      const k = this.turnTick;
      const e0 = turnEase(k / TURN_TICKS);
      const e1 = turnEase((k + 1) / TURN_TICKS);
      this.turnRate = ((this.omega >= 0 ? 1 : -1) * Math.PI * (e1 - e0)) / dt;
      // the faces change over in row bands (matter time-slices the swap over SWAP_TICKS) while the cloud cover is thickest
      if (k === SWAP_AT && this.shellOn) this.wx.swapShell?.(f.body.id, SWAP_TICKS);
      if (++this.turnTick >= TURN_TICKS) {
        this.turnTick = -1;
        // the stop overshoots: the world swings on past its day rate, then the spring settles it
        this.kickSpin(PROGRADE * 0.7);
      }
    }
    // the cloud deck turns in map coordinates: the world sense seen through the drawn facing
    const rf = f.facing;
    this.theta += (this.omega + this.turnRate) * dt;
    this.thetaAir += (this.omegaAir + this.turnRate) * rf * dt;
    this.airSense = rf;
    // moons lag a spin-up (and swing ahead of a spin-down), each on its own slow spring; their orbits run prograde
    const lk = MOON_LAG_K;
    const lc = 2 * MOON_LAG_ZETA * Math.sqrt(lk);
    for (const mo of this.moons) {
      const a = -lk * mo.lag - lc * mo.lagV - MOON_LAG_GAIN * lk * PROGRADE * angAcc;
      mo.lagV += a * dt;
      mo.lag += mo.lagV * dt;
    }
    // the ring: debris orbits with the world, slower than its surface, and is drawn in by commitment and by Tidal Draw
    // (its drift follows the spin smoothly through zero: a reversal of the world never snaps the ring)
    this.ringPhase -= (0.3 * DMath.tanh(this.omega / 0.15) + 0.5 * this.omega) * dt;
    this.ringTarget = Math.max(this.ringGoal(m), this.drawT);
    this.ringTight += (this.ringTarget - this.ringTight) * 0.035;
    this.ringGlow *= 0.97;
    this.auroraPulse *= 0.985;
    this.wander += dt * (0.35 + 0.15 * Math.abs(this.omega));
    this.writeAngular();
  }

  /** How tight the debris ring is drawn for the current move (0 = slack). */
  private ringGoal(m: ActiveMove): number {
    const id = m.def?.id ?? '';
    if (this.turnTick >= 0) return 0.7;
    if (!m.def || m.phase === 'recovery') return 0;
    const q = m.phase === 'startup' ? clamp01(m.phaseTick / Math.max(1, m.startup)) : 1;
    switch (id) {
      case 'planet.impact':
      case 'planet.crustbreaker':
        return q;
      case 'planet.cataclysm':
        return m.phase === 'active' && m.phaseTick >= 52 ? 0 : 1;
      case 'planet.corepulse':
        return 1;
      case 'planet.moonslam':
        return m.phase === 'charge' ? 0.4 + 0.5 * clamp01(m.chargeTicks / Math.max(1, m.chargeMax)) : 0;
      case 'planet.comet':
        return m.phase === 'charge' ? 0.5 : 0;
      default:
        return 0;
    }
  }

  /**
   * Answer a command on its input tick, with no anatomy: the aurora flares and the debris ring brightens at once (light), the ring
   * then draws in, the moon that will act swings ahead along its orbit, the cloud deck redraws. Recorded for the feel `respond`.
   */
  private telegraph(cmd: string, strength: number, moon: Moon | null): void {
    this.auroraPulse = Math.max(this.auroraPulse, 0.55 * strength);
    this.ringGlow = Math.max(this.ringGlow, Math.min(1, strength));
    this.ringTight = Math.min(1, this.ringTight + 0.06 * strength);
    if (moon) moon.lagV += 0.7 * strength;
    else for (const mo of this.moons) mo.lagV += 0.35 * strength;
    this.forceSkin = true;
    this.respondCmd = cmd;
    this.respondTick = this.f.tickNo;
  }

  /**
   * Feel instrumentation: the channel through which `cmd` (a move slot, 'guard' or 'gravity') is answered on THIS tick, or null.
   * Valid from the moment the fighter accepted the command: a move's telegraph is armed in `onMoveStart`, a raised Guard and a
   * pressed Gravity are answered in this tick's `update`. The Planet answers with light and detached fx (aurora, ring, moons,
   * cloud deck), never with a lean.
   */
  override feelRespond(cmd: string): 'fx' | null {
    const f = this.f;
    if (cmd === 'guard') return f.guardUp && (!this.wasGuard || this.respondTick === f.tickNo) ? 'fx' : null;
    if (cmd === 'gravity')
      return (f.input.held & Btn.GRAVITY) !== 0 && (!this.wasDraw || this.respondTick === f.tickNo)
        ? 'fx'
        : null;
    return this.respondTick === f.tickNo && this.respondCmd === cmd ? 'fx' : null;
  }

  /**
   * Rotational Brace: raising Guard turns the more intact face toward the foe (a half-turn under a cloud-streak cover). Nothing
   * turns when the near face is already the better one, or while a turn is under way.
   */
  private brace(): void {
    if (this.turnTick >= 0 || this.f.ko) return;
    const o = this.faceTmp;
    this.faceIntegrity(o);
    if (o.far > o.near + BRACE_MARGIN) this.turnTick = 0;
  }
  private readonly faceTmp = { near: 1, far: 1 };

  /* ---------------------------------------------------------------------------------------------- *
   *  damage phases
   * ---------------------------------------------------------------------------------------------- */

  /** The phase the world's wounds put it in now (the round's phase never goes back: see `monitor`). */
  private phaseNow(): number {
    const s = this.f.view.bodyStats;
    // what is left of the world (its total loss, wherever it is) and of the face toward the viewer: the worse of the two
    const near = Math.min(s.massFrac, this.nearAll / this.nearPristineAll);
    if (near < 0.42 || s.coreIntegrity < 0.62 || s.exposedCoreFrac > 0.2) return 4;
    if (this.expoDeep > 260 || near < 0.64) return 3;
    if (s.crackedCells > 1500 || near < 0.86 || this.atmoFrac < 0.7) return 2;
    return 1;
  }

  /**
   * The world enters a new phase: the sky marks it (aurora, ring, a slow shock ring and a cue for sound), and Core Crisis shakes
   * the moons: the outer one is torn from its orbit, the inner one is cracked.
   */
  private enterPhase(p: number): void {
    const f = this.f;
    this.phase = p;
    const t = f.body.transform;
    this.auroraPulse = Math.max(this.auroraPulse, 0.6);
    this.ringGlow = 1;
    this.forceSkin = true;
    f.events.push(
      { t: 'cue', slot: f.slot, titan: f.def.id, id: `world-phase-${p}`, x: t.x, y: t.y, amount: p / 4 },
      {
        t: 'shockwave',
        x: t.x,
        y: t.y,
        strength: 0.18 + 0.08 * p,
        radius: 90 + 20 * p,
        hue: p >= 3 ? 0.06 : 0.55,
      },
    );
    if (p === 4) {
      let outer: Moon | null = null;
      for (const m of this.moons) if (m.mode === ORBIT && (!outer || m.spec.a > outer.spec.a)) outer = m;
      if (outer) this.knockOut(outer, (outer.x - f.px) * 0.01, -0.6);
      for (const m of this.moons) {
        if (m === outer || m.mode === GONE) continue;
        const e2 = this.ev;
        const s2 = this.evShape;
        s2.kind = 'point';
        s2.x = m.x;
        s2.y = m.y;
        s2.r = m.radius * 0.8;
        e2.shape = asShape(s2);
        e2.type = 'KINETIC';
        e2.energy = 160;
        e2.dirX = 0;
        e2.dirY = 1;
        e2.flags = 0;
        e2.params = { crater: 4 };
        e2.sourceMass = 3;
        e2.sourceBodyId = -1;
        e2.originX = m.x;
        e2.originY = m.y - 20;
        f.world.applyDamage(m.body.id, e2);
      }
    }
  }

  /** The wounded world hits harder (PHASE_POWER). */
  override adjustStats(s: EffectiveStats, _massFrac: number): void {
    s.damageMul *= PHASE_POWER[this.phase]!;
  }

  /**
   * The Brace shell is as strong as the atmosphere that remains, the moons standing in front of it, the integrity of the face that
   * takes the blows (damage geography is tactics: brace with the better face) and the world's phase (a broken world braces worse).
   */
  override guardMultiplier(): number {
    let shield = 0;
    for (const m of this.moons) if (m.mode === ORBIT) shield += 0.12;
    const face = 0.55 + 0.45 * clamp01(this.nearIntegrity);
    return (0.4 + 0.6 * this.atmoFrac + shield) * face * PHASE_BRACE[this.phase]!;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  moons: orbits
   * ---------------------------------------------------------------------------------------------- */

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

  /** Where moon `m` sits on its orbit right now, blended toward the shield position while Guard is up. */
  private orbitPos(m: Moon, out: { x: number; y: number }, back: { v: boolean }, slotIdx: number): void {
    const f = this.f;
    const s = m.spec;
    const ang = m.ang + m.lag;
    const ex = DMath.cos(ang) * s.a;
    const ey = DMath.sin(ang) * s.b;
    const tilt = s.tilt + PHASE_WANDER[this.phase]! * DMath.sin(this.wander);
    const ct = DMath.cos(tilt);
    const st = DMath.sin(tilt);
    let x = ex * ct - ey * st;
    let y = ex * st + ey * ct;
    back.v = DMath.sin(ang) < 0;
    const gb = clamp01(this.guardBlend);
    if (gb > 0.01) {
      // shield: stand in front of the planet on the foe's side, one above the other. The side is where the foe IS, not the
      // body's facing: the Brace half-turn swaps the mirror mid-guard, and a shield that followed it would jump across the world
      // (a step of 2·radius, the 2.5 Hz content the scale spec forbids, and twice as big on the enlarged world)
      const side = f.foe.view.x >= f.px ? 1 : -1;
      const sc = this.sc;
      const sx = side * (this.rig.radius + (16 + slotIdx * 6) * sc);
      const sy = (slotIdx - (this.moons.length - 1) / 2) * 40 * sc;
      x += (sx - x) * gb;
      y += (sy - y) * gb;
      if (gb > 0.5) back.v = false;
    }
    out.x = f.px + x;
    out.y = f.py + y;
  }

  private readonly orbP = { x: 0, y: 0 };
  private readonly orbB = { v: false };

  private updateOrbit(_tick: number, snap: boolean): void {
    const f = this.f;
    const p = this.orbP;
    const b = this.orbB;
    for (let i = 0; i < this.moons.length; i++) {
      const m = this.moons[i]!;
      if (m.mode === GONE) continue;
      if (m.mode === ORBIT) {
        // a faster-turning world drags its moons along a little faster (tidal coupling)
        const w = ((Math.PI * 2) / m.spec.period) * (1 + 0.6 * Math.max(0, Math.abs(this.omega) - SPIN_BASE));
        m.ang += w;
        this.orbitPos(m, p, b, i);
        m.back = b.v;
        if (snap) {
          m.x = p.x;
          m.y = p.y;
        } else {
          // follow the orbit through a light low-pass, so a blend never steps; a moon just caught back glides onto it slowly
          const k = m.settle > 0 ? 0.04 + 0.31 * sq(1 - m.settle / SETTLE_TICKS) : 0.35;
          if (m.settle > 0) m.settle--;
          m.x += (p.x - m.x) * k;
          m.y += (p.y - m.y) * k;
        }
        m.vx = 0;
        m.vy = 0;
      }
      const t = m.body.transform;
      t.x = Math.round(m.x);
      t.y = Math.round(m.y);
      m.layer.tickStart();
    }
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
    // a world in core crisis is fragile: its shaken moons soak less of what comes at it
    const share = this.phase >= 4 ? MOON_SHARE * 0.55 : MOON_SHARE;
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
      e2.energy = ev.energy * share;
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
      const push = DMath.hypot(r.impulseX, r.impulseY) / Math.max(0.2, frac);
      if (frac < BREAK_FRAC) this.loseMoon(m, ev.dirX * 90, ev.dirY * 90, true);
      else if (push > KNOCK_LIMIT && m.mode !== DRIFT)
        this.knockOut(m, ev.dirX * Math.min(8, push * 0.012), ev.dirY * Math.min(8, push * 0.012) - 1);
    }
    // the debris ring is armour too: chunks in the blow's path take part of it and are struck loose
    const ring = this.ringSoak(ev);
    if (n > 0 || ring > 0) {
      res.touched = true;
      res.partsHit += n;
      res.absorbed = Math.max(res.absorbed, Math.min(SOAK_MAX, share * n + ring));
    }
  }

  /** A moon is knocked out of its orbit (px/tick): it drifts, and wobbles home only if it was not thrown far. */
  private knockOut(m: Moon, vx: number, vy: number): void {
    const f = this.f;
    m.mode = DRIFT;
    m.age = 0;
    m.vx = vx + (m.x - f.px) * 0.004;
    m.vy = vy;
    f.events.push({ t: 'shake', dirX: Math.sign(vx) || 1, dirY: 0, amp: 4 });
  }

  /** A moon is lost: what is left of it drifts off as a debris chunk, and the pip goes out. */
  private loseMoon(m: Moon, vx: number, vy: number, broke: boolean): void {
    const f = this.f;
    if (m.mode === GONE) return;
    const wasBound = m.mode !== DRIFT;
    const map = m.body.map;
    const mass = f.world.stats(m.body.id).mass;
    if (mass > 0.5)
      f.world.spawnChunk({
        pixels: new Uint32Array(map.pixels),
        emissive: new Uint8Array(map.emissive),
        w: map.w,
        h: map.h,
        x: m.x + map.w / 2 - m.body.transform.anchorX,
        y: m.y + map.h / 2 - m.body.transform.anchorY,
        vx: vx || m.vx * 60,
        vy: vy || m.vy * 60,
        spin: broke ? 1.6 : 0.5,
        mass,
      });
    this.retireMoon(m, wasBound);
  }

  /**
   * A broken moon shatters on its target: its matter splits into three wedges about its core, which carry the moon's momentum on
   * toward the foe (debris that hits a body hits it as a blow), and the pip goes out.
   */
  private shatterMoon(m: Moon, vx: number, vy: number): void {
    const f = this.f;
    const map = m.body.map;
    const w = map.w;
    const h = map.h;
    const mass = f.world.stats(m.body.id).mass;
    const cx = m.body.transform.anchorX + 0.5;
    const cy = m.body.transform.anchorY + 0.5;
    const heading = DMath.atan2(vy, vx);
    let total = 0;
    for (let i = 0; i < w * h; i++) if (map.pixels[i]! >>> 24 !== 0) total++;
    for (let k = 0; k < 3; k++) {
      const px = new Uint32Array(w * h);
      const em = new Uint8Array(w * h);
      let n = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (map.pixels[i]! >>> 24 === 0) continue;
          const a = DMath.atan2(y + 0.5 - cy, x + 0.5 - cx) - heading;
          const sector = Math.floor((((a / (Math.PI * 2)) % 1) + 1) * 3) % 3;
          if (sector !== k) continue;
          px[i] = map.pixels[i]!;
          em[i] = map.emissive[i]!;
          n++;
        }
      if (n === 0 || total === 0) continue;
      const spread = (k - 1) * 0.28;
      const c = DMath.cos(spread);
      const s = DMath.sin(spread);
      const sp = 0.85 + 0.1 * k;
      f.world.spawnChunk({
        pixels: px,
        emissive: em,
        w,
        h,
        x: m.x + w / 2 - m.body.transform.anchorX,
        y: m.y + h / 2 - m.body.transform.anchorY,
        vx: (vx * c - vy * s) * 60 * sp,
        vy: (vx * s + vy * c) * 60 * sp,
        spin: 1.2 * (k - 1) + 0.4,
        mass: (mass * n) / total,
      });
    }
    f.events.push({ t: 'cue', slot: f.slot, titan: f.def.id, id: 'moon-shatter', x: m.x, y: m.y, amount: 1 });
    this.retireMoon(m, m.mode !== DRIFT);
  }

  private retireMoon(m: Moon, wasBound: boolean): void {
    const f = this.f;
    f.world.removeBody(m.body.id);
    m.mode = GONE;
    m.layer.layer.visible = false;
    f.events.push({ t: 'cue', slot: f.slot, titan: f.def.id, id: 'moon-lost', x: m.x, y: m.y, amount: 1 });
    f.events.push({ t: 'resource', slot: f.slot, kind: 'spend', amount: 1 });
    f.events.push({ t: 'shockwave', x: m.x, y: m.y, strength: 0.3, radius: 110, hue: 0.6 });
    if (wasBound && f.resource > this.moonsAlive) f.resource = this.moonsAlive;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  moons: the slam and the barrage
   * ---------------------------------------------------------------------------------------------- */

  /**
   * The moon to sling: the one whose orbital path already points most nearly at the foe (it needs the shortest whip before it can
   * let go on its tangent).
   */
  private pickSlamMoon(): Moon | null {
    const f = this.f;
    let best: Moon | null = null;
    let bd = 1e9;
    for (const m of this.moons) {
      if (m.mode !== ORBIT) continue;
      const s = m.spec;
      const ang = m.ang + m.lag;
      const tx = -DMath.sin(ang) * s.a;
      const ty = DMath.cos(ang) * s.b;
      const head = DMath.atan2(
        tx * DMath.sin(s.tilt) + ty * DMath.cos(s.tilt),
        tx * DMath.cos(s.tilt) - ty * DMath.sin(s.tilt),
      );
      let off = DMath.atan2(f.foe.view.y - m.y, f.foe.view.x - m.x) - head;
      while (off > Math.PI) off -= Math.PI * 2;
      while (off < -Math.PI) off += Math.PI * 2;
      // it can only swing forward along its orbit: a path that is just past the foe needs most of a turn
      const need = off >= 0 ? off : off + Math.PI * 2;
      if (need < bd) {
        bd = need;
        best = m;
      }
    }
    return best;
  }

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

  /**
   * Send moon `m` at the foe: it first whips round its orbit for `windup` ticks (the delay that makes it a moon, not a bullet), then
   * leaves on its tangent, accelerates toward `speed` and curves onto the foe (`curve` −1 over, +1 under, 0 straight).
   */
  private launchMoon(
    m: Moon,
    o: {
      windup: number;
      speed: number;
      accel: number;
      turn: number;
      curve: number;
      energy: number;
      crater: number;
      compress: number;
      shock: number;
      life: number;
    },
  ): void {
    m.mode = SLAM;
    m.age = 0;
    m.slamHit = false;
    m.windup = o.windup;
    m.windupMax = Math.max(1, o.windup);
    m.speedMax = o.speed;
    m.accel = o.accel;
    m.turn = o.turn;
    m.curve = o.curve;
    m.energy = o.energy;
    m.crater = o.crater;
    m.compress = o.compress;
    m.shock = o.shock;
    m.life = o.life;
    m.vx = 0;
    m.vy = 0;
    m.tx.fill(m.x);
    m.ty.fill(m.y);
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  moves
   * ---------------------------------------------------------------------------------------------- */

  /** Every command is answered on its input tick (see `telegraph`); the moon (or comet) that will act is the one that moves. */
  override onMoveStart(m: ActiveMove): void {
    const f = this.f;
    const id = m.def?.id ?? '';
    const slot = m.def?.slot ?? '';
    switch (id) {
      case 'planet.moonslam':
        this.telegraph(slot, 1, this.pickSlamMoon());
        break;
      case 'planet.shift': {
        this.telegraph(slot, 0.8, null);
        this.kickSpin(PROGRADE * this.driftCfg.spin);
        // the dash bends around the foe: toward the side the foe lies on, relative to the push
        const tx = f.foe.view.x - f.px;
        const ty = f.foe.view.y - f.py;
        const cross = m.dirX * ty - m.dirY * tx;
        this.driftSide = cross >= 0 ? 1 : -1;
        break;
      }
      case 'planet.comet':
        this.telegraph(slot, 1, null);
        this.takeComet(f.ctx);
        break;
      case 'planet.impact':
      case 'planet.cataclysm':
      case 'planet.crustbreaker':
      case 'planet.magmavent':
      case 'planet.corepulse':
        this.telegraph(slot, 1.2, null);
        break;
      default:
        this.telegraph(slot, 0.7, null);
    }
  }

  override onRelease(m: ActiveMove): void {
    const f = this.f;
    const id = m.def?.id;
    if (id === 'planet.moonslam') {
      const moon = this.pickSlamMoon();
      const cf = m.chargeMax > 0 ? m.chargeTicks / m.chargeMax : 0;
      // no moon in orbit: the world throws the heaviest chunk of its debris ring; with none, its own tidal shove (the hitbox)
      if (!moon) {
        this.throwRingChunk(1 + 0.35 * cf);
        return;
      }
      const cfg = this.cfg;
      // aim: the stick bends the path over (up) or under (down) the foe
      const curve = this.aimY < -0.3 ? -1 : this.aimY > 0.3 ? 1 : 0;
      this.launchMoon(moon, {
        windup: cfg.windup,
        // lengths per tick grow with the world (D31-6): the same flight in the same time over sc× the distance
        speed: cfg.speed * (1 + 0.35 * cf) * this.sc,
        accel: cfg.accel * this.sc,
        turn: cfg.turn,
        curve: curve * cfg.curve,
        energy: cfg.energy * m.power,
        crater: cfg.crater,
        compress: cfg.compress,
        shock: cfg.shock,
        life: cfg.life,
      });
      f.resource = Math.max(0, f.resource - 1);
      f.events.push({ t: 'resource', slot: f.slot, kind: 'spend', amount: 1 });
      // the throw's reaction: the world lurches on its axis and the other moon swings back
      this.kickSpin(PROGRADE * (0.5 + 0.6 * cf));
      for (const mo of this.moons) if (mo !== moon && mo.mode === ORBIT) mo.lagV -= 0.6;
    } else if (id === 'planet.comet') this.slingshot();
    else if (id === 'planet.cataclysm') this.quaked = false;
    else if (id === 'planet.magmavent') {
      // the vent is the world's own wound: it bleeds a little of itself
      const shed = (m.def?.extra?.['vent'] as { shed: number } | undefined)?.shed ?? 0.004;
      f.world.shed(f.body.id, shed * f.view.bodyStats.initialMass, 'burn');
      this.forceSkin = true;
    } else if (id === 'planet.corepulse') {
      const shed = (m.def?.extra?.['pulse'] as { shed: number } | undefined)?.shed ?? 0.03;
      f.world.shed(f.body.id, shed * f.view.bodyStats.initialMass, 'blow');
      const t = f.body.transform;
      f.events.push(
        { t: 'flash', amount: 0.5, x: t.x, y: t.y },
        { t: 'shockwave', x: t.x, y: t.y, strength: 1, radius: 260, hue: 0.08 },
        { t: 'shake', dirX: f.facing, dirY: 0.3, amp: 11 },
        { t: 'cue', slot: f.slot, titan: f.def.id, id: 'core-pulse', x: t.x, y: t.y, amount: 1 },
      );
    }
  }

  override onMoveEnd(m: ActiveMove, interrupted: boolean): void {
    const id = m.def?.id;
    if (id === 'planet.cataclysm') this.barrageNext = 0;
    // a shepherded comet that was never slung (the hold was broken) is let go along its path
    if (
      id === 'planet.comet' &&
      interrupted &&
      (this.comet.mode === C_INBOUND || this.comet.mode === C_ORBIT)
    )
      this.comet.mode = C_LOOSE;
  }

  /**
   * Crush HELD: holding through the first HOLD_TICKS of Tidal Rush turns it into the move the world's phase allows. Phases 1–2:
   * Crust Breaker. Phase 3: Magma Vent. Phase 4: Core Pulse, which spends a full meter (else Magma Vent).
   * (Proposal 133 asks the fighter for a declarative hold-alternative; this is the behaviour side of it.)
   */
  private holdCrush(): void {
    const f = this.f;
    let id = 'planet.crustbreaker';
    if (this.phase >= 4 && f.meter >= 1 - 1e-6) id = 'planet.corepulse';
    else if (this.phase >= 3) id = 'planet.magmavent';
    const def = f.movesById.get(id);
    if (!def) return;
    if (id === 'planet.corepulse') f.meter = Math.max(0, f.meter - def.meterCost);
    f.startMove(def, Btn.CRUSH);
  }

  /** Per-tick move mechanics the move data cannot express: the hold-swap, Orbital Drift's curve. */
  private stepMoves(ctx: FighterTickCtx): void {
    const f = this.f;
    const m = f.mv;
    if (!m.def || !f.live || f.ko) return;
    if (
      m.def.id === 'planet.impact' &&
      m.phase === 'startup' &&
      !m.feint &&
      m.phaseTick === HOLD_TICKS &&
      (ctx.input.held & Btn.CRUSH) !== 0
    ) {
      this.holdCrush();
      return;
    }
    if (m.def.id === 'planet.shift' && m.phase === 'active') {
      // a perpendicular pull, ramped in and out over the dash: the path is an arc, not a line
      const k = DMath.sin(Math.PI * clamp01((m.phaseTick - 0.5) / Math.max(1, m.active)));
      const a = this.driftCfg.curve * k * this.driftSide;
      f.vx += -m.dirY * a * TICK_DT;
      f.vy += m.dirX * a * TICK_DT;
    }
  }

  override onKo(): void {
    for (const mo of this.moons) if (mo.mode === SLAM) mo.mode = RETURN;
    if (this.comet.mode === C_INBOUND || this.comet.mode === C_ORBIT) this.comet.mode = C_LOOSE;
    this.failT = 0;
  }

  override resolveVolumes(ctx: FighterTickCtx): void {
    const f = this.f;
    const m = f.mv;
    // stick aim, remembered for the slam
    this.aimY = ctx.input.moveY;
    // cataclysm: after the quake the moons rain on the foe one after another
    if (m.def?.id === 'planet.cataclysm' && this.barrage && m.phase === 'active') {
      const at = m.phaseTick - 1;
      const b = this.barrage;
      if (at >= b.from && at >= this.barrageNext) {
        const moon = this.pickMoon();
        if (moon)
          this.launchMoon(moon, {
            windup: 6,
            speed: b.speed * this.sc,
            accel: 0.6 * this.sc,
            turn: 0.09,
            curve: 0,
            energy: b.energy,
            crater: b.crater,
            compress: b.compress,
            shock: b.shock,
            life: 60,
          });
        this.barrageNext = at + b.gap;
      }
    }
    if (m.def?.id === 'planet.cataclysm' && m.phase === 'active' && !this.quaked && m.phaseTick - 1 >= 52) {
      this.quaked = true;
      const t = f.body.transform;
      // the quake's light is local to its epicentre (an impact light, never a screen wash)
      f.events.push(
        { t: 'flash', amount: 0.45, x: f.foe.view.x, y: f.foe.view.y },
        { t: 'shake', dirX: f.facing, dirY: 0.4, amp: 13 },
        { t: 'shockwave', x: f.foe.view.x, y: f.foe.view.y, strength: 1, radius: 300, hue: 0.08 },
        { t: 'zoom', amount: 0.04 },
        { t: 'cue', slot: f.slot, titan: f.def.id, id: 'crust-crack', x: t.x, y: t.y, amount: 1 },
      );
    }
    for (const mo of this.moons) {
      if (mo.mode === SLAM) this.flyMoon(mo);
      else if (mo.mode === RETURN) this.returnMoon(mo);
      else if (mo.mode === DRIFT) this.driftMoon(mo);
      if (mo.mode !== ORBIT && mo.mode !== GONE) {
        const t = mo.body.transform;
        t.x = Math.round(mo.x);
        t.y = Math.round(mo.y);
        mo.layer.tickStart();
        // a moon slung from behind the world stays behind it until it has cleared the disc (no pop through the planet)
        const clear = DMath.hypot(mo.x - f.px, mo.y - f.py) > this.rig.radius + this.rig.atmo + mo.radius;
        if (!(mo.mode === SLAM && mo.back && !clear)) mo.back = false;
      }
    }
    this.stepComet();
  }

  /** One tick of a moon strike: the whip round the orbit, then the accelerating, curving flight and the blow. */
  private flyMoon(mo: Moon): void {
    const f = this.f;
    if (mo.windup > 0) {
      // the whip: the moon races round its own orbit, gathering speed, and lets go where its path points at the foe (after at
      // least `windupMax` ticks, at most WHIP_EXTRA more): it leaves exactly on its orbital tangent, so the path has no corner
      mo.age++;
      const u = clamp01(mo.age / mo.windupMax);
      const w = ((Math.PI * 2) / mo.spec.period) * (1 + 2.6 * smoothstep(0, 1, u));
      mo.ang += w;
      this.orbitPos(mo, this.orbP, this.orbB, this.moons.indexOf(mo));
      const nx = this.orbP.x;
      const ny = this.orbP.y;
      mo.vx = nx - mo.x;
      mo.vy = ny - mo.y;
      mo.x = nx;
      mo.y = ny;
      mo.back = this.orbB.v;
      let off =
        DMath.atan2(f.foe.view.y - mo.y, f.foe.view.x - mo.x) + mo.curve * 0.7 - DMath.atan2(mo.vy, mo.vx);
      while (off > Math.PI) off -= Math.PI * 2;
      while (off < -Math.PI) off += Math.PI * 2;
      if ((mo.age >= mo.windupMax && Math.abs(off) < 0.45) || mo.age >= mo.windupMax + WHIP_EXTRA) {
        mo.windup = 0;
        mo.age = 0;
      }
    } else {
      mo.age++;
      const tx = f.foe.view.x - mo.x;
      const ty = f.foe.view.y - mo.y;
      const d = DMath.hypot(tx, ty) || 1;
      // desired heading: at the foe, bent to one side while far (the arc), straight at the end
      const bend = mo.curve * clamp01((d - 60 * this.sc) / (220 * this.sc));
      const des = DMath.atan2(ty, tx) + bend;
      let head = DMath.atan2(mo.vy, mo.vx);
      let dh = des - head;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      head += clamp(dh, -mo.turn, mo.turn);
      const sp = Math.min(mo.speedMax, DMath.hypot(mo.vx, mo.vy) + mo.accel);
      mo.vx = DMath.cos(head) * sp;
      mo.vy = DMath.sin(head) * sp;
      mo.x += mo.vx;
      mo.y += mo.vy;
    }
    for (let k = 13; k > 0; k--) {
      mo.tx[k] = mo.tx[k - 1]!;
      mo.ty[k] = mo.ty[k - 1]!;
    }
    mo.tx[0] = mo.x;
    mo.ty[0] = mo.y;
    if (mo.windup > 0) return;
    if (!mo.slamHit && f.live) {
      const sh = this.tmp;
      sh.kind = 'point';
      sh.x = mo.x;
      sh.y = mo.y;
      sh.r = mo.radius + 2;
      this.dmg.energy = mo.energy;
      this.dmg.params.crater = mo.crater;
      this.dmg.params.compress = mo.compress;
      this.dmg.params.shock = mo.shock;
      const hit = f.strike(sh, this.dmg, mo.vx * 50, mo.vy * 50, 0.6, 12, 'strike', 'planet.moonslam', 1);
      if (hit) {
        mo.slamHit = true;
        if (f.world.stats(mo.body.id).massFrac < this.cfg.breakFrac) {
          // a broken moon does not come home: it shatters, and its fragments carry on
          this.shatterMoon(mo, mo.vx, mo.vy);
          return;
        }
        // the moon pays for the blow: a KINETIC bruise where it struck
        const e2 = this.ev;
        const s2 = this.evShape;
        s2.kind = 'point';
        s2.x = mo.x + Math.sign(mo.vx) * mo.radius * 0.6;
        s2.y = mo.y;
        s2.r = mo.radius * 0.7;
        e2.shape = asShape(s2);
        e2.type = 'KINETIC';
        // a bigger world's moon has sc² the matter: it pays the same share of itself per blow
        e2.energy = mo.energy * this.cfg.recoil * this.sc * this.sc;
        e2.dirX = -Math.sign(mo.vx || 1);
        e2.dirY = 0;
        e2.flags = 0;
        e2.params = { crater: 3 };
        e2.sourceMass = 4;
        e2.sourceBodyId = f.body.id;
        e2.originX = mo.x;
        e2.originY = mo.y;
        f.world.applyDamage(mo.body.id, e2);
        if (f.world.stats(mo.body.id).massFrac < BREAK_FRAC) this.loseMoon(mo, mo.vx * 30, mo.vy * 30, true);
        else {
          // it does not bounce back in one tick: the blow brakes it over the next ticks (see `returnMoon`) and the world reels it in
          mo.mode = RETURN;
          mo.age = 0;
        }
        return;
      }
    }
    if (mo.mode === SLAM) {
      f.addThreat(asShape(this.moonShape(mo)), 'CRUSH', mo.energy, 0, 4, true);
      if (mo.age > mo.life || DMath.hypot(mo.x - f.px, mo.y - f.py) > 470 * this.sc) mo.mode = RETURN;
    }
  }

  /** Home: pulled back toward the planet with drag, captured into orbit when it reaches its ring. */
  private returnMoon(mo: Moon): void {
    const f = this.f;
    const dx = f.px - mo.x;
    const dy = f.py - mo.y;
    const d = DMath.hypot(dx, dy) || 1;
    mo.age++;
    const sc = this.sc;
    mo.vx += (dx / d) * 0.45 * sc;
    mo.vy += (dy / d) * 0.45 * sc;
    // quadratic drag (terminal ~6.7·sc px/tick), plus the impact's braking over the first ticks after a blow
    const sp = DMath.hypot(mo.vx, mo.vy);
    const drag = (1 - (0.01 / sc) * sp) * (mo.slamHit && mo.age < 10 ? 0.86 : 1);
    mo.vx *= drag;
    mo.vy *= drag;
    mo.x += mo.vx;
    mo.y += mo.vy;
    const orb = DMath.hypot(mo.spec.a, mo.spec.b) * 0.9;
    if (d < orb) {
      mo.mode = ORBIT;
      mo.lag = 0;
      mo.lagV = 0;
      mo.settle = SETTLE_TICKS;
      // the orbit point nearest where it is: undo the orbit's tilt, then read the ellipse parameter
      const ct = DMath.cos(mo.spec.tilt);
      const st = DMath.sin(mo.spec.tilt);
      const rx = mo.x - f.px;
      const ry = mo.y - f.py;
      mo.ang = DMath.atan2(
        (-rx * st + ry * ct) / Math.max(1, mo.spec.b),
        (rx * ct + ry * st) / Math.max(1, mo.spec.a),
      );
      if (f.resource < this.moonsAlive) {
        f.resource = Math.min(this.moonsAlive, f.resource + 1);
        f.events.push({ t: 'resource', slot: f.slot, kind: 'gain', amount: 1 });
      }
    }
  }

  /** Knocked out of orbit: the planet's gravity tugs at it; it wobbles home only if it was not thrown far (never once freed). */
  private driftMoon(mo: Moon): void {
    const f = this.f;
    mo.age++;
    const dx = f.px - mo.x;
    const dy = f.py - mo.y;
    const d = DMath.hypot(dx, dy) || 1;
    if (!mo.free) {
      const g = 0.028 * this.sc * (1 / Math.max(0.6, d / (160 * this.sc)));
      mo.vx += (dx / d) * g * 4;
      mo.vy += (dy / d) * g * 4;
    }
    mo.x += mo.vx;
    mo.y += mo.vy;
    if (d > LOST_RADIUS * this.sc || mo.age > (mo.free ? 400 : 260))
      this.loseMoon(mo, mo.vx * 60, mo.vy * 60, false);
    else if (!mo.free && mo.age > 90 && d < 190 * this.sc && DMath.hypot(mo.vx, mo.vy) < 2.2 * this.sc)
      mo.mode = RETURN;
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
   *  Comet Shepherd → Slingshot
   * ---------------------------------------------------------------------------------------------- */

  /**
   * Take a comet to shepherd: a free arena comet within reach (the Lead's hazard module), else call one in from the far edge of
   * the arena, high on the side away from the foe, heading to pass the world below its orbit. Either way it is a debris chunk of the
   * matter world; the deepened well bends its path. One comet at a time.
   */
  private takeComet(ctx: FighterTickCtx): void {
    const f = this.f;
    const c = this.comet;
    if (c.mode === C_INBOUND || c.mode === C_ORBIT || c.mode === C_FLY) return;
    this.dropComet();
    let best = -1;
    // reach for a free arena comet: ~400 px at the authored size, growing with the world (its ring and well grow with it)
    let bd = 400 * this.sc;
    for (const ac of ctx.comets ?? []) {
      if (ac.mode !== 0) continue;
      const d = DMath.hypot(ac.x - f.px, ac.y - f.py);
      if (d < bd) {
        bd = d;
        best = ac.id;
      }
    }
    if (best >= 0) {
      c.id = best;
      c.mode = C_INBOUND;
      c.age = 0;
      c.w = 0;
      c.sling = false;
      c.slingWait = 0;
      this.readComet();
      f.events.push({ t: 'cue', slot: f.slot, titan: f.def.id, id: 'comet-call', x: c.x, y: c.y, amount: 1 });
      return;
    }
    this.summonComet();
  }

  /** Call a comet nucleus in (a chunk of ice and rock painted by art/comet.ts) when the arena offers none. */
  private summonComet(): void {
    const f = this.f;
    const c = this.comet;
    const cfg = this.cometCfg;
    const a = f.arena;
    const sx = clamp(f.px - f.facing * cfg.spawnDist, a.minX + 20, a.maxX - 20);
    const sy = clamp(f.py - cfg.spawnRise, a.minY + 20, a.maxY - 20);
    const g = generateCometBody(f.def, f.seed + 977, f.lighting);
    const map = g.map;
    const px = new Uint32Array(map.w * map.h);
    for (let i = 0; i < px.length; i++)
      if (map.material[i] !== 0) px[i] = (map.baseColor[i]! | 0xff000000) >>> 0;
    // aim to pass below the world at about its orbit, so the well has a path to bend
    const tx = f.px - (sx - f.px) * 0.2;
    const ty = f.py + cfg.orbit * 0.55;
    const d = DMath.hypot(tx - sx, ty - sy) || 1;
    const id = f.world.spawnChunk({
      pixels: px,
      w: map.w,
      h: map.h,
      x: sx,
      y: sy,
      vx: ((tx - sx) / d) * cfg.entrySpeed,
      vy: ((ty - sy) / d) * cfg.entrySpeed,
      spin: 0.4,
      mass: cfg.mass,
    }) as number | undefined;
    if (typeof id !== 'number' || id < 0) return;
    c.id = id;
    c.mode = C_INBOUND;
    c.age = 0;
    c.w = 0;
    c.sling = false;
    c.slingWait = 0;
    c.r = Math.max(map.w, map.h) * 0.35;
    this.readComet();
    f.events.push({ t: 'cue', slot: f.slot, titan: f.def.id, id: 'comet-call', x: sx, y: sy, amount: 1 });
  }

  /** Read the comet chunk's state; false (and the comet forgotten) if the chunk is gone. */
  private readComet(): boolean {
    const c = this.comet;
    const s = this.info;
    if (c.id < 0 || !this.wx.chunkState?.(c.id, s)) {
      c.mode = C_NONE;
      c.id = -1;
      return false;
    }
    c.x = s.x;
    c.y = s.y;
    c.vx = s.vx;
    c.vy = s.vy;
    c.r = Math.max(4, s.radius * 0.8);
    return true;
  }

  /** Let the comet go: it stays in the arena as ordinary debris. */
  private dropComet(): void {
    const c = this.comet;
    if (c.mode === C_NONE) return;
    if (c.id >= 0) this.wx.releaseChunk?.(c.id);
    c.mode = C_NONE;
    c.id = -1;
  }

  /** Release: a captured comet leaves at the next point where its orbit points at the foe; one still falling in is let go. */
  private slingshot(): void {
    const c = this.comet;
    if (c.mode === C_INBOUND) {
      this.dropComet();
      return;
    }
    if (c.mode !== C_ORBIT) return;
    c.sling = true;
    c.slingWait = 0;
  }

  /**
   * Throw it now, along its orbit (aimed the last few degrees at the foe), with the speed the orbit gave it. The blow it lands is
   * the matter world's (½·m·(v/60)²); the launch speed is set so that energy is `energy`·(v/vRef)² whatever the comet's mass.
   */
  private letGo(): void {
    const f = this.f;
    const c = this.comet;
    const cfg = this.cometCfg;
    const speed = DMath.hypot(c.vx, c.vy);
    const mass = this.wx.chunkState?.(c.id, this.info) ? Math.max(1, this.info.mass) : cfg.mass;
    const v = 60 * Math.sqrt((2 * cfg.energy) / mass) * (speed / cfg.vRef);
    const dx = f.foe.view.x - c.x;
    const dy = f.foe.view.y - c.y;
    const dl = DMath.hypot(dx, dy) || 1;
    c.sling = false;
    if (!this.wx.launchChunk?.(c.id, (dx / dl) * v, (dy / dl) * v, f.body.id, f.slot)) {
      this.dropComet();
      return;
    }
    c.mode = C_FLY;
    c.age = 0;
    this.kickSpin(PROGRADE * 0.6);
    f.events.push({
      t: 'cue',
      slot: f.slot,
      titan: f.def.id,
      id: 'comet-sling',
      x: c.x,
      y: c.y,
      amount: speed / cfg.vRef,
    });
  }

  /**
   * One tick of the comet: falling in under the deepened well until it swings close enough to be caught; riding the ring while the
   * shepherd spins it up; waiting, once released, for the point where its orbit points at the foe; then the throw.
   */
  private stepComet(): void {
    const f = this.f;
    const c = this.comet;
    if (c.mode === C_NONE) return;
    if (!this.readComet()) return;
    const cfg = this.cometCfg;
    const dt = TICK_DT;
    c.age++;
    const holding = f.mv.def?.id === 'planet.comet' && f.mv.phase === 'charge';
    if (c.mode === C_INBOUND) {
      const d = DMath.hypot(c.x - f.px, c.y - f.py);
      if (d < cfg.orbit * 1.3 || (c.age > 120 && d < 300 * this.sc)) {
        if (this.wx.captureChunk?.(c.id, f.slot)) {
          c.mode = C_ORBIT;
          c.w = cfg.w0;
          f.events.push({
            t: 'cue',
            slot: f.slot,
            titan: f.def.id,
            id: 'comet-capture',
            x: c.x,
            y: c.y,
            amount: 1,
          });
        } else this.dropComet();
      } else if (c.age > 180) this.dropComet();
    } else if (c.mode === C_ORBIT) {
      // caught: the ring (and the comet on it) is spun up for as long as the shepherd holds it, like a flywheel
      if (holding) c.w = Math.min(cfg.w1, c.w + cfg.spinUp * dt);
      if (c.sling) {
        let off = DMath.atan2(f.foe.view.y - c.y, f.foe.view.x - c.x) - DMath.atan2(c.vy, c.vx);
        while (off > Math.PI) off -= Math.PI * 2;
        while (off < -Math.PI) off += Math.PI * 2;
        const front = c.y >= f.py;
        if ((Math.abs(off) < 0.3 && front) || ++c.slingWait > 90) this.letGo();
      } else if (!holding && f.mv.def?.id !== 'planet.comet') this.dropComet();
    } else if (c.mode === C_FLY) {
      // slung: the world's matter carries the blow; the comet is spent when it has struck (or slowed to debris)
      if (this.info.mode !== 2 || c.age > cfg.life) {
        f.events.push({
          t: 'cue',
          slot: f.slot,
          titan: f.def.id,
          id: 'comet-spent',
          x: c.x,
          y: c.y,
          amount: 1,
        });
        c.mode = C_NONE;
        c.id = -1;
      }
    }
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  the debris ring and Tidal Draw (Gravity, R1); the passive Gravity Well
   * ---------------------------------------------------------------------------------------------- */

  /** Let the ring go (KO, new round): its chunks keep their speed and are ordinary debris again. */
  private clearRing(): void {
    if (this.f.slot === 0 || this.f.slot === 1) this.wx?.setOrbit?.(this.f.slot, null);
    this.ringIds.length = 0;
  }

  /** Forget ring chunks that are gone, thrown, struck loose or taken by someone else. */
  private pruneRing(): void {
    const s = this.info;
    for (let k = this.ringIds.length - 1; k >= 0; k--) {
      const id = this.ringIds[k]!;
      if (!this.wx.chunkState?.(id, s) || s.mode !== 1 || s.owner !== this.f.slot) this.ringIds.splice(k, 1);
    }
  }

  /**
   * The well and the ring. The gravity source deepens while Gravity is held (ramped in over DRAW_IN s, out over DRAW_OUT s) and
   * grows with the phase (a broken world has more debris about it); while the draw is deep, free debris within its reach is
   * captured into the ring (severed enemy matter included) up to RING_CAP chunks: ammunition (Moon Slam throws it when no moon is
   * in orbit) and armour (ring chunks in a blow's path soak part of it). The ring rides the world's spin; a held comet spins it up.
   * The world slows while drawing (it is concentrating).
   */
  private stepDraw(ctx: FighterTickCtx): void {
    const f = this.f;
    const dt = TICK_DT;
    const held = (ctx.input.held & Btn.GRAVITY) !== 0 && f.live && !f.ko && !f.guardUp;
    if (held && !this.wasDraw) this.telegraph('gravity', 1, null);
    this.wasDraw = held;
    this.drawT = clamp01(this.drawT + (held ? dt / DRAW_IN : -dt / DRAW_OUT));
    if (this.drawT > 0.05) f.applyStatus(1 - 0.35 * this.drawT, 2);
    const R = this.rig.radius;
    const shepherd =
      this.comet.mode === C_INBOUND || (f.mv.def?.id === 'planet.comet' && f.mv.phase === 'charge');
    const reach = (250 + DRAW_REACH * this.drawT + (shepherd ? 170 : 0)) * this.sc;
    f.world.setGravitySource(
      f.slot,
      f.ko
        ? null
        : {
            x: f.px,
            y: f.py,
            // the world's pull is ∝ strength / distance: at sc× the distances, sc² the strength bends paths the same way in the
            // same time (a bigger world is not a weaker well)
            strength:
              (PHASE_GRAVITY[this.phase]! + DRAW_PULL * this.drawT + (shepherd ? 140 : 0)) *
              this.sc *
              this.sc,
            radius: reach,
          },
    );
    if (f.ko) {
      if (this.ringIds.length > 0 || this.comet.mode !== C_NONE) {
        this.dropComet();
        this.clearRing();
      }
      return;
    }
    // the ring: in the moons' plane, turning prograde with the world; widened to the comet's orbit while one rides it
    // (a chunk keeps the lane it was caught on, so the ring is widened before the comet arrives, not after)
    const comet = this.comet.mode === C_ORBIT || this.comet.mode === C_INBOUND;
    this.wx.setOrbit?.(f.slot, {
      x: f.px,
      y: f.py,
      radius: comet ? this.cometCfg.orbit : R * RING_R * (1 - 0.15 * this.ringTight),
      omega: this.comet.mode === C_ORBIT ? this.comet.w : 0.55 + 0.3 * Math.abs(this.omega),
      flatten: RING_FLAT,
    });
    if (f.tickNo % 30 === 0) this.pruneRing();
    if (
      this.drawT > 0.4 &&
      f.tickNo % CAPTURE_EVERY === 0 &&
      this.ringIds.length < RING_CAP &&
      this.wx.chunksInShape
    ) {
      const sh = this.tmp;
      sh.kind = 'point';
      sh.x = f.px;
      sh.y = f.py;
      sh.r = reach * 0.85;
      const n = this.wx.chunksInShape(asShape(sh), this.idsTmp);
      for (let k = 0; k < n && this.ringIds.length < RING_CAP; k++) {
        const id = this.idsTmp[k]!;
        if (id === this.comet.id || !this.wx.chunkState?.(id, this.info) || this.info.mode !== 0) continue;
        if (this.wx.captureChunk?.(id, f.slot)) {
          this.ringIds.push(id);
          f.events.push({
            t: 'cue',
            slot: f.slot,
            titan: f.def.id,
            id: 'ring-capture',
            x: this.info.x,
            y: this.info.y,
            amount: this.info.mass,
          });
        }
      }
    }
  }

  /** Moon Slam with no moon in orbit: the world throws the heaviest chunk of its ring at the foe. False if the ring is empty. */
  private throwRingChunk(power: number): boolean {
    const f = this.f;
    this.pruneRing();
    let best = -1;
    let bm = 0;
    for (const id of this.ringIds)
      if (this.wx.chunkState?.(id, this.info) && this.info.mass > bm) {
        bm = this.info.mass;
        best = id;
      }
    if (best < 0 || !this.wx.chunkState?.(best, this.info)) return false;
    const dx = f.foe.view.x - this.info.x;
    const dy = f.foe.view.y - this.info.y;
    const dl = DMath.hypot(dx, dy) || 1;
    const v = RING_THROW * power;
    if (!this.wx.launchChunk?.(best, (dx / dl) * v, (dy / dl) * v, f.body.id, f.slot)) return false;
    this.ringIds.splice(this.ringIds.indexOf(best), 1);
    f.events.push({
      t: 'cue',
      slot: f.slot,
      titan: f.def.id,
      id: 'ring-throw',
      x: this.info.x,
      y: this.info.y,
      amount: bm,
    });
    return true;
  }

  /** Ring armour: ring chunks in a blow's path take part of it (they are struck loose, and break if hit hard). Returns the share. */
  private ringSoak(ev: DamageEvent): number {
    if (this.ringIds.length === 0 || !this.wx.chunksInShape) return 0;
    const n = this.wx.chunksInShape(ev.shape, this.idsTmp);
    let soak = 0;
    for (let k = 0; k < n; k++) {
      const id = this.idsTmp[k]!;
      const at = this.ringIds.indexOf(id);
      if (at < 0 || !this.wx.chunkState?.(id, this.info)) continue;
      this.wx.strikeChunk?.(id, this.info.x, this.info.y, ev.energy * RING_SOAK, ev.dirX, ev.dirY);
      this.ringIds.splice(at, 1);
      soak += RING_SOAK;
    }
    return soak;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  failure: the world dies over ~3 s
   * ---------------------------------------------------------------------------------------------- */

  /**
   * After the KO: the atmosphere vents (tidal tears off the air, round the limb), the moons drift off their orbits for good, the crust
   * separates into slabs (fractures seeded round the limb that shear over the following ticks), and the core's light goes out last.
   */
  private stepFailure(): void {
    const f = this.f;
    const t = this.failT;
    const R = this.rig.radius;
    const e = this.ev;
    const s = this.evShape;
    if (t === 0)
      f.events.push({
        t: 'cue',
        slot: f.slot,
        titan: f.def.id,
        id: 'atmo-vent',
        x: f.px,
        y: f.py,
        amount: 1,
      });
    if (t < FAIL_VENT_END && t % 3 === 0) {
      const a = this.thetaAir * 0.7 + t * 0.05;
      s.kind = 'ring';
      s.x = f.px;
      s.y = f.py;
      s.r0 = R - 3;
      s.r1 = R + this.rig.atmo + 4;
      e.shape = asShape(s);
      e.type = 'TIDAL';
      e.energy = 70;
      e.dirX = DMath.cos(a);
      e.dirY = DMath.sin(a);
      e.duration = 1;
      e.flags = 0;
      e.params = { pull: 1.6 };
      e.sourceMass = 4;
      e.sourceBodyId = -1;
      e.originX = f.px + DMath.cos(a) * 260;
      e.originY = f.py + DMath.sin(a) * 260;
      f.world.applyDamage(f.body.id, e);
    }
    if (t === FAIL_MOONS_AT) {
      f.events.push({
        t: 'cue',
        slot: f.slot,
        titan: f.def.id,
        id: 'moons-drift',
        x: f.px,
        y: f.py,
        amount: 1,
      });
      for (const mo of this.moons) {
        if (mo.mode === DRIFT) mo.free = true;
        if (mo.mode !== ORBIT && mo.mode !== RETURN) continue;
        // let go along the orbit: the tangent of their prograde motion, a little outward, slowly
        const ox = mo.x - f.px;
        const oy = mo.y - f.py;
        const ol = DMath.hypot(ox, oy) || 1;
        mo.mode = DRIFT;
        mo.free = true;
        mo.age = 0;
        mo.vx = (oy / ol) * 1.4 + (ox / ol) * 0.5;
        mo.vy = (-ox / ol) * 0.5 + (oy / ol) * 0.5;
      }
    }
    if (t >= FAIL_SLAB_FROM && (t - FAIL_SLAB_FROM) % FAIL_SLAB_EVERY === 0) {
      const k = (t - FAIL_SLAB_FROM) / FAIL_SLAB_EVERY;
      if (k < FAIL_SLABS) {
        if (k === 0)
          f.events.push({
            t: 'cue',
            slot: f.slot,
            titan: f.def.id,
            id: 'crust-slab',
            x: f.px,
            y: f.py,
            amount: 1,
          });
        const a = k * 2.399 + 0.6;
        const ca = DMath.cos(a);
        const sa = DMath.sin(a);
        s.kind = 'point';
        s.x = f.px + ca * (R - 4);
        s.y = f.py + sa * (R - 4);
        s.r = 12;
        e.shape = asShape(s);
        e.type = 'FRACTURE';
        e.energy = 260;
        e.dirX = -ca;
        e.dirY = -sa;
        e.duration = 1;
        e.flags = DamageFlag.SEED_CRACK;
        e.params = { crackSeeds: 3, crackStress: 200, penetration: 30 };
        e.sourceMass = 4;
        e.sourceBodyId = -1;
        e.originX = f.px + ca * (R + 40);
        e.originY = f.py + sa * (R + 40);
        f.world.applyDamage(f.body.id, e);
      }
    }
    this.coreOut = smoothstep(FAIL_CORE_FROM, FAIL_CORE_OUT, t);
    if (t === FAIL_CORE_OUT)
      f.events.push({ t: 'cue', slot: f.slot, titan: f.def.id, id: 'core-out', x: f.px, y: f.py, amount: 1 });
    this.forceSkin = this.forceSkin || (t >= FAIL_CORE_FROM && t <= FAIL_CORE_OUT + 2);
    this.failT++;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  per tick
   * ---------------------------------------------------------------------------------------------- */

  override update(ctx: FighterTickCtx): void {
    const f = this.f;
    const tick = ctx.tick;
    this.tickLast = tick;
    this.stepMoves(ctx);
    const m = f.mv;
    // the moons' swing into the shield: two critically damped springs in cascade (ω = 2·GUARD_OMEGA, then GUARD_OMEGA). One
    // spring starts without a corner but with a jump in acceleration, which on the enlarged world's ~300 px swing still put
    // 0.5 px of motion above 2.5 Hz; the cascade makes the acceleration continuous too (D28 scale spec, D31-6)
    const gi = 2 * GUARD_OMEGA;
    this.guardInV += (gi * gi * ((f.guardUp ? 1 : 0) - this.guardIn) - 2 * gi * this.guardInV) * TICK_DT;
    this.guardIn += this.guardInV * TICK_DT;
    const gw = GUARD_OMEGA;
    this.guardBlendV += (gw * gw * (this.guardIn - this.guardBlend) - 2 * gw * this.guardBlendV) * TICK_DT;
    this.guardBlend += this.guardBlendV * TICK_DT;
    // Guard answers on its input tick, and turns the better face toward the foe (Rotational Brace)
    if (f.guardUp && !this.wasGuard && f.live) {
      this.telegraph('guard', 0.9, null);
      this.brace();
    }
    this.wasGuard = f.guardUp;
    this.stepDraw(ctx);
    this.stepSpin(m);
    // a world neither shears nor leans: the body is drawn (and hit) upright
    f.body.transform.lean = 0;
    this.updateOrbit(tick, false);
    if (this.failT >= 0) this.stepFailure();

    // monitors (cheap: every few ticks)
    if (tick % 6 === 0) this.monitor();
    f.resource = clamp(f.resource, 0, this.moonsAlive);
    f.view.parts = this.moonsAlive;

    this.drawGate(tick);
    this.recordIdle(tick);
  }

  /** The living idle's inputs this tick (render-side data: nothing here is read back by the sim). */
  private recordIdle(tick: number): void {
    const f = this.f;
    const t = f.body.transform;
    const inp = this.idleIn;
    inp.omega = this.omega;
    inp.turnRate = this.turnRate;
    inp.omegaAir = this.omegaAir;
    inp.facing = t.facing;
    inp.rest =
      (f.state === 'idle' || f.state === 'intro') &&
      !f.mv.def &&
      !f.guardUp &&
      this.drawT < 0.05 &&
      this.turnTick < 0 &&
      this.failT < 0 &&
      this.comet.mode === C_NONE;
    inp.ko = f.ko;
    inp.swapping = this.turnTick >= SWAP_AT && this.turnTick <= SWAP_AT + SWAP_TICKS;
    inp.phase = this.phase;
    inp.ringTight = this.ringTight;
    inp.ringGlow = this.ringGlow;
    inp.coreOut = this.coreOut;
    inp.x = t.x;
    inp.y = t.y;
    for (let i = 0; i < 2; i++) {
      const mo = this.moons[i];
      const on = !!mo && (mo.mode === ORBIT || mo.mode === RETURN);
      if (i === 0) {
        inp.m0on = on;
        inp.m0x = mo?.x ?? 0;
        inp.m0y = mo?.y ?? 0;
        inp.m0back = mo?.back ?? false;
        inp.m0r = mo?.radius ?? 12;
      } else {
        inp.m1on = on;
        inp.m1x = mo?.x ?? 0;
        inp.m1y = mo?.y ?? 0;
        inp.m1back = mo?.back ?? false;
        inp.m1r = mo?.radius ?? 12;
      }
    }
    this.idle.record(tick, inp);
  }

  private monitor(): void {
    const f = this.f;
    // one census by dirty rows: the air and the seas, the face toward the foe (the Brace's strength), the exposure
    this.refreshCensus();
    this.atmoFrac = clamp01(this.airCells / this.atmoCells0);
    this.oceanFrac = clamp01(this.seaCells / this.oceanCells0);
    this.nearIntegrity = this.nearShell / this.nearPristineShell;
    // the damage phase only ever advances within a round
    if (f.live && !f.ko) {
      const p = this.phaseNow();
      if (p > this.phase) this.enterPhase(p);
    }
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

  /**
   * The sim side of drawing (runs in `update`): decide whether the skin and glow are due this tick and refresh the exposure scan
   * there, because the Exposed Mantle phase reads it. The pixels themselves are painted at render time (`paint`, from
   * `renderLayers`), once per sim tick that a frame shows — purely visual work stays out of the tick.
   */
  private drawGate(tick: number): void {
    const map = this.f.body.map;
    // skin + glow every third tick while the day drifts calmly; every tick while the cloud deck streaks (spin, a half-turn), on a
    // command's input tick and while the core goes out; the reveal only changes with the map
    const fast = Math.abs(this.cloudSpin) > 0.6 || this.forceSkin;
    if (fast || tick % 3 === 0 || map.version !== this.lastVer) {
      if (fast || tick % 3 === 0 || this.redraw++ % 2 === 0) {
        this.stampExposure();
        this.skinDue = true;
        if (!fast || tick % 3 === 0 || map.version !== this.lastVer || this.failT >= 0) this.glowDue = true;
        this.lastVer = map.version;
      }
    }
    this.forceSkin = false;
  }
  private skinDue = true;
  private faceVer = -1;
  private readonly faceDraw = (): void => {
    this.faceVer = this.f.body.map.version;
    this.idle.drawFace(this.f.body.map, this.expo);
  };
  private glowDue = true;
  private paintedTick = -1;

  /** Render side: paint what the last sim tick made due (skin, glow) and the fx overlay; nothing here feeds the sim. */
  private paint(): void {
    const tick = this.tickLast;
    if (tick === this.paintedTick) return;
    this.paintedTick = tick;
    // the living idle steps once per sim tick and redraws its face on even steps (planetIdle `advance`), and at once when
    // the map changed under it (only pristine cells take the idle's colours); otherwise the skin reuses the face it has
    const idle = this.idle;
    const map = this.f.body.map;
    if (idle.advance(tick, this.faceDraw)) this.skinDue = true;
    if (map.version !== this.faceVer) {
      this.faceVer = map.version;
      idle.drawFace(map, this.expo);
      this.skinDue = true;
    }
    if (this.skinDue) this.drawSkin(tick);
    if (this.glowDue) this.drawGlow(tick);
    this.skinDue = false;
    this.glowDue = false;
    this.drawFx(tick, this.f.mv);
  }

  /** Interior cells that damage has brought within 3 cells of the surface (`expo`): refreshed by dirty rows per map version. */
  private stampExposure(): boolean {
    const map = this.f.body.map;
    if (map.version !== this.expoVer) {
      this.expoVer = map.version;
      this.refreshCensus();
      this.expoAny = this.expoCells > 0;
    }
    return this.expoAny;
  }
  private expoVer = -1;
  private expoAny = false;

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
    // the exposure scan is the sim's (drawGate): the painter only reads it
    const anyExpo = this.expoAny;
    const expo = this.expo;
    const T = this.skinT;
    const crustV = T.crustV;
    const deadV = T.deadV;
    const mantleB = T.mantleB;
    const bay = T.bay;
    const bandT = T.band;
    const foreT = T.fore;
    const lonT = T.lon;
    const rowT = T.row;
    const nzT = rig.nz;
    const latT = rig.lat;
    const lit = this.lit;
    const clouds = rig.clouds;
    const px = S.px;
    const em = S.emis!;
    // the cloud deck turns with the atmosphere's phase (+ = toward local +x); it streaks along the motion when the world spins hard,
    // and during a half-turn it closes over the face (the cover under which the far face comes round)
    const phase = ((this.thetaAir - this.idle.cloudLag) * 256) / (Math.PI * 2);
    const faceBuf = this.idle.faceBuf;
    const faceEm = this.idle.faceEm;
    const ws = this.cloudSpin * this.airSense;
    const smear = Math.min(SMEAR_MAX, Math.abs(ws) * SMEAR_PER_SPIN);
    const sdir = ws >= 0 ? 1 : -1;
    const cover = this.turnTick >= 0 ? DMath.sin((Math.PI * (this.turnTick + 0.5)) / TURN_TICKS) : 0;
    const density = Math.max(this.atmoFrac, cover);
    const cn = this.cloudC;
    // the core going out: the exposed deep strata darken and stop glowing, dithered in from the outside
    const out = this.coreOut;
    const heat = 1 - out;
    const crustR = this.crustR;
    const mantleR = this.mantle;
    const magmaR = this.magma;
    const coreC = rampAt(magmaR, (0.92 + 0.08 * DMath.sin(tick * 0.035)) * heat);
    const emMantle = Math.round(80 * heat);
    const emMagma = Math.round(190 * heat);
    const emCore = Math.round(240 * heat);
    const mx = tick * 0.012;
    const my = -tick * 0.008;
    const cTop = cn.length - 1;
    const clouded = density >= 0.05;
    const streaks = smear >= 1;
    const sk = (sdir * smear) / 3;
    const crust = ids.crust;
    const mantle = ids.mantle;
    const magma = ids.magma;
    const atmo = ids.atmosphere;
    const cloud = ids.cloud;
    let any = false;
    // rows with no matter (the census keeps the counts per row) are skipped: the margin above and below the world, and what a
    // broken world has lost
    const rowAll = this.rowAll.length === H ? this.rowAll : null;
    for (let y = 0; y < H; y++)
      for (let x = rowAll !== null && rowAll[y] === 0 ? W : 0; x < W; x++) {
        const i = y * W + x;
        const mm = mat[i]!;
        if (mm === 0) continue;
        if (anyExpo && expo[i] === 1) {
          // the strata the damage exposed: crust, banded mantle, slowly flowing magma, white-hot core
          // ordered-dither ramp lookups inlined (lib `rampDither`, same threshold): no call per exposed cell
          let ramp: readonly number[] | null = null;
          let v = 0;
          if (mm === crust) {
            ramp = crustR;
            v = crustV[i]!;
            em[i] = 0;
          } else if (out > 0 && out >= bay[i]!) {
            ramp = crustR;
            v = deadV[i]!;
            em[i] = 0;
          } else if (mm === mantle) {
            ramp = mantleR;
            v = 0.45 + 0.5 * mantleB[i]! * heat;
            em[i] = emMantle;
          } else if (mm === magma) {
            ramp = magmaR;
            v = (0.45 + 0.5 * tn(x * 0.35 + mx, y * 0.35 + my)) * heat + 0.1;
            em[i] = emMagma;
          }
          if (ramp !== null) {
            const top = ramp.length - 1;
            const s = (v < 0 ? 0 : v > 1 ? 1 : v) * top;
            const fl = Math.floor(s);
            const idx = fl + (s - fl > bay[i]! ? 1 : 0);
            px[i] = ramp[idx < top ? idx : top]!;
          } else {
            px[i] = coreC;
            em[i] = emCore;
          }
          any = true;
          continue;
        }
        // the living idle's face (the turning world, its quakes, tides and craters), under the cloud deck
        const fc = faceBuf[i]!;
        if (fc !== 0) {
          px[i] = fc;
          em[i] = faceEm[i]!;
          any = true;
        }
        if (!clouded || nzT[i] === 0) continue;
        if (mm === atmo || mm === cloud) continue;
        // drifting clouds over the face, lit like the surface, thinning as the atmosphere is stripped
        const band = bandT[i]!;
        const lx = lonT[i]! - phase * band;
        const row = rowT[i]!;
        // cloudAt, inlined: the deck is a wrapping 256-wide texture row
        let l0 = Math.floor(lx);
        let lf = lx - l0;
        let d = (clouds[row + (l0 & 255)]! * (1 - lf) + clouds[row + ((l0 + 1) & 255)]! * lf) / 255;
        if (streaks) {
          // motion streak: what passed over this point in the last moment still shows, fading along the band
          for (let k = 1; k <= 3; k++) {
            const lk = lx + sk * band * k;
            l0 = Math.floor(lk);
            lf = lk - l0;
            const s =
              ((clouds[row + (l0 & 255)]! * (1 - lf) + clouds[row + ((l0 + 1) & 255)]! * lf) / 255) *
              (1 - 0.18 * k);
            if (s > d) d = s;
          }
        }
        if (cover > 0) d += (1 - d) * cover * (0.55 + 0.35 * tn(lx * 0.07, latT[i]! * 0.21));
        const a = d * density * foreT[i]! * 0.72;
        // solid cloud shapes, as the prototype draws them (WJ 2026-10-18: "not so jittery"): one threshold, the middle of the
        // old dithered band, so a drifting deck no longer crawls with checkerboard; a thinning deck still breaks up at the edge
        if (a <= (density < 0.95 ? 0.12 + 0.55 * bay[i]! : CLOUD_EDGE)) continue;
        const v = 0.2 + 0.75 * (lit[i]! / 255) * (0.6 + 0.4 * a);
        const vc = v < 0 ? 0 : v > 1 ? 1 : v;
        px[i] = 0xff000000 | (cn[Math.min(cTop, Math.round(vc * cTop))]! & 0xffffff);
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
    // a hotter world (exposed mantle, core crisis) glows harder through its cracks; a dead one not at all
    const gain = (this.phase >= 3 ? 1.25 : 1) * (1 - this.coreOut);
    let any = false;
    const rowAll = this.rowAll.length === H ? this.rowAll : null;
    if (gain > 0.01)
      for (let y = 0; y < H; y++)
        for (let x = rowAll !== null && rowAll[y] === 0 ? W : 0; x < W; x++) {
          const i = y * W + x;
          const mm = mat[i]!;
          if (mm === 0) continue;
          if ((fl[i]! & CellFlag.CRACKED) !== 0) {
            // magma light leaking through the fissures: brighter the deeper the crack runs, breathing slowly
            const deep = mm === ids.crust ? 1 : mm === ids.mantle ? 1.3 : 0.55;
            const flick = 0.55 + 0.45 * tn(x * 0.4 + tick * 0.008, y * 0.4);
            const a = deep * flick * gain;
            px[i] =
              0xff000000 |
              (Math.min(255, 14 * a) << 16) |
              (Math.min(255, 70 * a) << 8) |
              Math.min(255, 130 * a);
            em[i] = Math.min(255, 130 * a);
            any = true;
          }
        }
    if (any) G.mark();
    G.commit();
  }

  /**
   * Aurora ovals about both poles of the tilted (wandering) axis: curtains standing out of the limb and over the face, shimmering
   * slowly, brighter the faster the world turns and on every command; they need an atmosphere to light.
   */
  private drawAurora(X: Overlay, tick: number): void {
    const t = this.f.body.transform;
    const R = this.rig.radius;
    const level =
      clamp01(0.08 + (0.55 * Math.abs(this.spin)) / SPIN_MAX + this.auroraPulse + 0.2 * this.idle.aurora) *
      (0.35 + 0.65 * this.atmoFrac) *
      (1 - this.coreOut);
    if (level < 0.06) return;
    const rf = t.facing;
    const tilt = this.rig.tilt + PHASE_WANDER[this.phase]! * DMath.cos(this.wander);
    const s = DMath.sin(tilt);
    const c = DMath.cos(tilt);
    const cb = DMath.cos(AURORA_BETA);
    const sb = DMath.sin(AURORA_BETA);
    const height = 2 + 7 * level;
    for (let pole = 0; pole < 2; pole++) {
      const sg = pole === 0 ? 1 : -1;
      // pole direction (screen plane, local), its in-plane perpendicular, and the view axis
      const px = s * sg;
      const py = -c * sg;
      for (let k = 0; k < AURORA_STEPS; k++) {
        const ph = (k / AURORA_STEPS) * Math.PI * 2 + this.thetaAir * 0.5 * sg;
        const cp = DMath.cos(ph);
        const sp = DMath.sin(ph);
        // a point on the oval: pole·cosβ + (e1·cos φ + view·sin φ)·sinβ, with e1 = (c, s) in the plane
        const ox = px * cb + c * cp * sb;
        const oy = py * cb + s * cp * sb;
        const oz = sp * sb;
        if (oz < -0.12) continue;
        // curtains drift and breathe below 0.5 Hz
        const shimmer = tn(k * 0.37 + tick * 0.012, pole * 7 + tick * 0.006);
        const v = level * (0.45 + 0.75 * shimmer);
        const ol = DMath.hypot(ox, oy) || 1;
        const ux = ox / ol;
        const uy = oy / ol;
        const h = height * (0.5 + 0.5 * shimmer);
        const sx = ux * rf;
        for (let j = 0; j < h; j++) {
          const r = R * ol + j;
          const fade = v * (1 - j / (h + 1));
          // dithered per curtain sample (k, j), so the pattern travels with the curtain instead of flickering on the screen
          if (fade <= ((((k * 5 + j * 11) % 16) + 0.5) / 16) * 0.85) continue;
          const fc = fade > 1 ? 1 : fade;
          // int32 arguments (| 0): a rounded double handed to a call is boxed per pixel
          X.set(
            Math.floor(t.x + sx * r + 0.5) | 0,
            Math.floor(t.y + uy * r + 0.5) | 0,
            AURORA_RAMP[(fc * AURORA_TOP + 0.5) | 0]!,
            (200 * fc + 0.5) | 0,
          );
        }
      }
    }
  }

  /** The comet's tails: a pale ion tail straight back along its motion, a warmer dust tail curving after it. */
  private drawComet(X: Overlay): void {
    const c = this.comet;
    if (c.mode === C_NONE) return;
    const sp = DMath.hypot(c.vx, c.vy);
    if (sp < 1) return;
    const ux = -c.vx / sp;
    const uy = -c.vy / sp;
    const len = clamp(18 + sp * 0.09, 18, 90);
    const glow = c.mode === C_FLY ? 1 : 0.7;
    for (let k = -2; k <= 2; k++) {
      const ox = -uy * k * 1.2;
      const oy = ux * k * 1.2;
      const g = (1 - Math.abs(k) * 0.3) * glow;
      streak(X, c.x + ox, c.y + oy, c.x + ox + ux * len, c.y + oy + uy * len, 120, 190, 255, g * 0.55);
    }
    // the dust tail lags the turn: it points back along where the comet was heading a moment ago
    const bx = ux * 0.8 - uy * 0.25;
    const by = uy * 0.8 + ux * 0.25;
    streak(X, c.x, c.y, c.x + bx * len * 0.7, c.y + by * len * 0.7, 255, 210, 150, 0.4 * glow);
    glowD(X, c.x, c.y, c.r * 2, 170, 220, 255, 0.35 * glow);
  }

  // drawFx's scratch: its own shape (the sim's `tmp` is never touched at render time) and the ribbon paths, bound once
  private readonly fxTmp = makeFatShape();
  private skinT!: SkinTables;
  private ribMoon: Moon | null = null;
  private readonly moonPath = (u: number, out: { x: number; y: number }): void => {
    const mo = this.ribMoon!;
    const q = clamp(u, 0, 1) * 12;
    const k = Math.min(12, Math.floor(q));
    const fr = q - k;
    out.x = mo.tx[k]! + (mo.tx[k + 1]! - mo.tx[k]!) * fr;
    out.y = mo.ty[k]! + (mo.ty[k + 1]! - mo.ty[k]!) * fr;
  };
  /** Magma Vent jet: mouth (x, y) and full-length vector (dx, dy). */
  private readonly jet = new Float64Array(4);
  private readonly jetPath = (u: number, out: { x: number; y: number }): void => {
    const j = this.jet;
    out.x = j[0]! + j[2]! * (1 - u);
    out.y = j[1]! + j[3]! * (1 - u);
  };

  private drawFx(tick: number, m: ActiveMove): void {
    const f = this.f;
    const t = f.body.transform;
    const X = this.fx;
    X.begin(t.x, t.y);
    const id = m.def?.id ?? '';
    const at = m.phase === 'active' ? m.phaseTick - 1 : -1;
    const R = this.rig.radius;
    // the ring of rubble (the living idle): its far half behind the globe, its near half before it
    this.rubBack.begin(t.x, t.y);
    this.rubFront.begin(t.x, t.y);
    this.idle.drawRubble(this.rubBack, this.rubFront);
    this.rubBack.end();
    this.rubFront.end();
    this.drawAurora(X, tick);
    this.drawComet(X);
    // Tidal Draw: debris lanes spiralling in from the ring to the world
    if (this.drawT > 0.05) {
      const lanes = 14;
      for (let k = 0; k < lanes; k++) {
        const a0 = (k / lanes) * Math.PI * 2 + this.ringPhase * 1.6;
        for (let s = 0; s < 22; s++) {
          const u = ((s / 22 + this.wander * 0.25 + k * 0.137) % 1) * this.drawT;
          const r = R * (2.1 - 1.0 * u);
          const a = a0 + u * 1.4;
          if (((k + s) & 3) !== 0) continue;
          X.set(
            Math.round(t.x + DMath.cos(a) * r),
            Math.round(t.y + DMath.sin(a) * r * 0.42),
            rampAt(this.crustR, 0.4 + 0.5 * u),
            Math.round(60 * u),
          );
        }
      }
    }
    // moon ribbons in flight; a moon whipping round its orbit glows hotter as it gathers speed
    for (const mo of this.moons) {
      if (mo.mode !== SLAM) continue;
      if (mo.windup > 0) {
        const u = 1 - mo.windup / mo.windupMax;
        glowD(X, mo.x, mo.y, mo.radius * (1.6 + 1.2 * u), 255, 170, 90, 0.25 + 0.4 * u);
        continue;
      }
      this.ribMoon = mo;
      ribbon(X, this.moonPath, 1, 0, 60, 1, mo.radius * 0.55, tick, this.flame);
      glowD(X, mo.x, mo.y, mo.radius * 2.2, 200, 190, 230, 0.35);
    }
    if (id === 'planet.impact') {
      if (m.phase === 'startup') {
        const q = clamp01(m.phaseTick / m.startup);
        for (let i = 0; i < 26; i++) {
          const a = i * 2.399 + tick * 0.02;
          const rr = (R + 60) * (1 - q) * (0.5 + (0.5 * ((i * 37) % 10)) / 10) + R * 0.6;
          X.set(
            Math.round(t.x + DMath.cos(a) * rr),
            Math.round(t.y + DMath.sin(a) * rr * 0.8),
            rampAt(this.mantle, 0.5 + 0.5 * q),
            200,
          );
        }
      } else if (m.phase === 'active' && f.liveHitShape(0, at, this.fxTmp)) {
        const s = this.fxTmp;
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
          FULL_ARC,
          0.34,
        );
        glowD(X, s.x, s.y, 50 * (1 - q) + 10, 255, 190, 110, 0.6 * (1 - q));
      }
    }
    if (id === 'planet.crustbreaker') {
      if (m.phase === 'startup') {
        // the crust heaves: plates along the limb light up from below
        const q = clamp01(m.phaseTick / m.startup);
        for (let k = 0; k < 9; k++) {
          const a = k * 0.698 + 0.3;
          glowD(
            X,
            t.x + DMath.cos(a) * R * 0.92,
            t.y + DMath.sin(a) * R * 0.92,
            6 + 6 * q,
            255,
            150,
            70,
            0.25 + 0.4 * q,
          );
        }
      } else if (m.phase === 'active' && f.liveHitShape(0, at, this.fxTmp)) {
        const s = this.fxTmp;
        ringBand(X, s.x, s.y, s.r0, s.r1, tick, this.crustR, 1 - 0.5 * (at / 14), FULL_ARC, 0.62);
      }
    }
    if (id === 'planet.magmavent') {
      const ang = f.facing === 1 ? 0 : Math.PI;
      const aim = (m.aim === 'up' ? -0.72 : m.aim === 'down' ? 0.72 : 0) * f.facing;
      const dx = DMath.cos(ang + aim);
      const dy = DMath.sin(ang + aim);
      const mx = t.x + dx * R * 0.95;
      const my = t.y + dy * R * 0.95;
      if (m.phase === 'startup') {
        const q = clamp01(m.phaseTick / m.startup);
        glowD(X, mx, my, 8 + 14 * q, 255, 140, 50, 0.3 + 0.5 * q);
      } else if (m.phase === 'active') {
        // the jet: a tapered magma column out of the wound, its length breathing slowly
        const len = 200 * (0.85 + 0.15 * DMath.sin(tick * 0.05));
        const jet = this.jet;
        jet[0] = mx;
        jet[1] = my;
        jet[2] = dx * len;
        jet[3] = dy * len;
        ribbon(X, this.jetPath, 0, 1, len, 2, 9, tick, this.flame);
        glowD(X, mx, my, 24, 255, 160, 70, 0.55);
      }
    }
    if (id === 'planet.corepulse') {
      if (m.phase === 'startup') {
        // the core swells through the broken world
        const q = clamp01(m.phaseTick / m.startup);
        glowD(X, t.x, t.y, R * (0.4 + 1.1 * q), 255, 220, 150, 0.25 + 0.55 * q);
      } else if (m.phase === 'active' && f.liveHitShape(0, at, this.fxTmp)) {
        const s = this.fxTmp;
        ringBand(X, s.x, s.y, s.r0, s.r1, tick, this.magma, 1.3 - 0.7 * (at / 24), FULL_ARC, 0.85);
      }
    }
    if (id === 'planet.moonslam' && (m.phase === 'startup' || m.phase === 'charge')) {
      const moon = this.pickSlamMoon();
      if (moon) {
        // an aiming line of dots from the chosen moon toward the foe, bent the way the stick will curve it
        const cf = m.phase === 'charge' ? clamp01(m.chargeTicks / Math.max(1, m.chargeMax)) : 0.2;
        const curve = (this.aimY < -0.3 ? -1 : this.aimY > 0.3 ? 1 : 0) * this.cfg.curve;
        const ax = f.foe.view.x - moon.x;
        const ay = f.foe.view.y - moon.y;
        const base = DMath.atan2(ay, ax);
        const dist = DMath.hypot(ax, ay);
        for (let d = 24; d < Math.min(dist, 170 + 130 * cf); d += 7) {
          const a = base + curve * 0.5 * DMath.sin((Math.PI * d) / Math.max(1, dist));
          X.set(
            Math.round(moon.x + DMath.cos(a) * d),
            Math.round(moon.y + DMath.sin(a) * d),
            rampAt(this.magma, 0.5 + 0.5 * cf),
            180,
          );
        }
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
            FULL_ARC,
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
              FULL_ARC,
              0.7,
            );
          }
        } else if (f.liveHitShape(1, Math.min(at, 61), this.fxTmp)) {
          const s = this.fxTmp;
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
            FULL_ARC,
            0.36,
          );
          glowD(X, s.x, s.y, 80 * (1 - q) + 12, 255, 200, 120, 0.8 * (1 - q));
        }
      }
    }
    X.end();
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  plumbing
   * ---------------------------------------------------------------------------------------------- */

  /**
   * Planet-scale motion probes (tools/feel/scale.ts), in a fixed order: both moons, a marker riding the cloud deck's phase, the
   * crest of the north aurora, two debris-ring motes, the comet. Anything absent reports the planet's centre.
   */
  override trackPoints(out: number[]): number {
    const f = this.f;
    const R = this.rig.radius;
    // the sky's markers are placed on the body's SIM position, so what they show is their own motion: the drawn root adds the
    // body's hit shudder, which is the body's (the scale tool measures it on the root, in its hit window), not the sky's. At
    // 220 px (D31-6) the Planet's own blows connect inside the tool's window and that shudder leaked into every marker.
    const root = this.rootTmp;
    root.x = f.px;
    root.y = f.py;
    for (let i = 0; i < 2; i++) {
      const mo = this.moons[i];
      if (mo && mo.mode !== GONE) out.push(mo.x, mo.y);
      else out.push(root.x, root.y);
    }
    out.push(root.x + DMath.cos(this.thetaAir) * R * 0.7, root.y + DMath.sin(this.thetaAir) * R * 0.2);
    const tilt = this.rig.tilt + PHASE_WANDER[this.phase]! * DMath.cos(this.wander);
    const level = clamp01(0.08 + (0.55 * Math.abs(this.spin)) / SPIN_MAX + this.auroraPulse);
    const rf = f.body.transform.facing;
    out.push(
      root.x + DMath.sin(tilt) * (R + 2 + 7 * level) * rf,
      root.y - DMath.cos(tilt) * (R + 2 + 7 * level),
    );
    const a = R * (RING_LOOSE + (RING_TIGHT - RING_LOOSE) * this.ringTight);
    for (let k = 0; k <= 11; k += 11) {
      const phi = (k / RING_MOTES) * Math.PI * 2 + this.ringPhase;
      out.push(root.x + DMath.cos(phi) * a, root.y + DMath.sin(phi) * a * RING_FLAT);
    }
    const c = this.comet;
    if (c.mode !== C_NONE) out.push(c.x, c.y);
    else out.push(root.x, root.y);
    return 7;
  }
  private readonly rootTmp = { x: 0, y: 0, lean: 0, angle: 0 };

  override renderLayers(view: ViewRect, _alpha: number, out: RenderLayer[]): void {
    const f = this.f;
    // the fx overlay is limited to the view (S19); a camera that moved far since the last paint repaints it
    if (this.fx.limitToView(view)) this.paintedTick = -1;
    this.paint();
    const body = out[out.length - 1]!;
    const idle = this.idle;
    // the impact jolt (WJ: 1 px, drawn only): the body and everything on it
    if (idle.joltX !== 0) {
      body.x += idle.joltX;
      body.prevX += idle.joltX;
    }
    // the body as drawn: the atmosphere thin and calm, as in the prototype (render only: the matter keeps its air)
    idle.presentBody(f.body.map, body);
    this.skin.follow(body);
    this.glow.follow(body);
    const t = f.body.transform;
    const alive = 1 - this.coreOut;
    this.halo.place(
      t.x,
      t.y,
      body.prevX,
      body.prevY,
      (0.28 + 0.5 * this.atmoFrac) * (0.15 + 0.85 * alive) * (1 + 1.9 * idle.yank),
    );
    // Exposed Mantle warms the halo; Core Crisis makes it an apocalyptic glow that breathes; it dies with the core
    const core = this.phase >= 4 ? 0.3 + 0.1 * DMath.sin(this.tickLast * 0.025) : this.phase === 3 ? 0.12 : 0;
    this.haloCore.place(t.x, t.y, body.prevX, body.prevY, core * alive);
    out.push(this.rubBack.layer, this.haloCore.layer, this.halo.layer, this.skin.layer, this.glow.layer);
    for (let i = 0; i < this.moons.length; i++) {
      const mo = this.moons[i]!;
      if (mo.mode === GONE) continue;
      mo.layer.flush(mo.back ? -1 : 1);
      const L = mo.layer.layer;
      // the pull's lurch (drawn only): the orbit dips toward the world and springs back
      const k = mo.mode === ORBIT ? 0.07 * (idle.lurch[i] ?? 0) : 0;
      if (k > 0) {
        L.x -= (L.x - t.x) * k;
        L.y -= (L.y - t.y) * k;
      }
      L.visible = true;
      out.push(L);
    }
    out.push(this.rubFront.layer, this.fx.layer);
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
    const c = this.comet;
    if (c.mode !== C_NONE) {
      const s = makeFatShape();
      s.kind = 'point';
      s.x = c.x;
      s.y = c.y;
      s.r = c.r;
      out.push({ shape: asShape(s), color: 0xffffd080, label: 'comet' });
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
