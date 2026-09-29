import type { DamageParams, DamageType } from './damage';
import type { MaterialSpec } from './matter';

export const TITAN_IDS = ['lastone', 'nexus', 'blackhole', 'supernova', 'planet', 'asteroid'] as const;
export type TitanId = (typeof TITAN_IDS)[number];

/** Shared attributes, integers 1–10 (data-driven, /src/titans/*.json). Effective values update live from remaining mass. */
export interface TitanAttributes {
  /** Inertia and knockback resistance. */
  mass: number;
  /** Bond strength of its matter (scales material bonds). */
  cohesion: number;
  /** Heat tolerance (scales ignition/vaporise thresholds, thermal resistance). */
  heat: number;
  /** Pull on debris and opponent. */
  gravity: number;
  /** Move reach (px scale: reach × ~12 px beyond the body edge). */
  reach: number;
  /** Windup/recovery speed and movement agility. */
  tempo: number;
}

export type ResourceId = 'tendrils' | 'nodes' | 'accreted' | 'fuel' | 'moons' | 'fragments';

export interface ResourceDef {
  id: ResourceId;
  name: string;
  nameKo: string;
  max: number;
  start: number;
  /** How the HUD reads it: discrete pips (tendrils, moons, nodes) or a continuous bar (fuel, accreted mass). */
  display: 'pips' | 'bar';
}

/* ------------------------------------------------------------------------------------------------ *
 *  MOVES & FRAME DATA — everything in TICKS (60 Hz). Lives in data files, shown in Training mode.
 *  Feel targets (validated by tests/titan-validate.test.ts):
 *    Strike   total 30–48 ticks (0.5–0.8 s)
 *    Crush    total 72–120 ticks (1.2–2.0 s), startup (anticipation) 21–42 ticks (0.35–0.7 s)
 *    Ultimate total 180–300 ticks (3–5 s)
 *    Windups cancellable into Guard/Surge during the first `cancelWindow` (default 0.4) of startup.
 * ------------------------------------------------------------------------------------------------ */

export type MoveSlot = 'strike' | 'crush' | 'surge' | 'signature' | 'ultimate' | 'guard';
export type AimDir = 'up' | 'forward' | 'down';
export const AIM_DIRS: readonly AimDir[] = ['up', 'forward', 'down'];

export interface FrameData {
  /** Ticks from input to the first active tick — the anticipation pose is visible from tick 1. */
  startup: number;
  /** Ticks the hitboxes are live. */
  active: number;
  /** Ticks of recovery after the active phase. */
  recovery: number;
  /** Fraction (0..1) of startup during which the move may be feinted/cancelled into Guard or Surge. Default 0.4. */
  cancelWindow: number;
  /** Extra hold ticks allowed for hold-to-charge moves (0 = not chargeable). Charge scales energy/range. */
  chargeMax: number;
  /** Base hit-stop ticks on hit (scaled by energy and masses, clamped 60–220 ms). */
  hitstop: number;
}

/** A shape in ATTACKER-relative space: origin = attacker anchor, +x = forward (facing), +y = down. Lengths in px at REACH 5; `reachScale` multiplies lengths by (reach/5)^reachScale. */
export type ShapeTemplate =
  | { kind: 'point'; ox: number; oy: number; r: number }
  | { kind: 'line'; ox0: number; oy0: number; ox1: number; oy1: number; width: number }
  | { kind: 'cone'; ox: number; oy: number; angle: number; range: number; halfAngle: number }
  | { kind: 'ring'; ox: number; oy: number; r0: number; r1: number }
  | { kind: 'field'; ox: number; oy: number; r: number; falloff: number };

export interface HitboxDef {
  id: string;
  /** Active-window tick range relative to the FIRST active tick: [from, to) . */
  from: number;
  to: number;
  shape: ShapeTemplate;
  /** Optional: shape at the END of the window; the live shape interpolates (sweeps) from `shape`. */
  sweepTo?: ShapeTemplate;
  reachScale?: number;
  /** Damage applied on contact. */
  damage: {
    type: DamageType;
    energy: number;
    duration: number;
    flags: number;
    params: DamageParams;
  };
  /** Re-hit interval in ticks for continuous hitboxes (0 = hits once per move). */
  rehit?: number;
  /** Knockback in px/s at MASS-neutral: divided by target mass. */
  knockback: { x: number; y: number };
  /** Guard interaction: 0..1 how much sustained pressure this adds to the shell. */
  guardPressure: number;
}

export interface MovementKey {
  /** Tick relative to move start. */
  at: number;
  /** Impulse px/s facing-relative (+x forward). */
  ix: number;
  iy: number;
  /** Velocity damping factor per second applied from this key on (optional). */
  damp?: number;
}

export interface MoveVariant {
  hitboxes: HitboxDef[];
  movement: MovementKey[];
  /** Override any FrameData fields for this aim. */
  frame?: Partial<FrameData>;
}

export interface MoveDef {
  id: string;
  slot: MoveSlot;
  name: string;
  nameKo?: string;
  /** Default frame data; variants may override. */
  frame: FrameData;
  /** Hitboxes/movement per stick aim at press time (up / forward = neutral or toward foe / down). */
  variants: Record<AimDir, MoveVariant>;
  /** Titan resource spent (tendrils severed-in-use, fuel, fragments…) and meter cost (0..1, ultimate = 1). */
  resourceCost: number;
  meterCost: number;
  /** [from,to) ticks from move start during which the titan is intangible (Surge). */
  intangible?: [number, number];
  /** Tags: 'beam','projectile','grab','unblockable','charge','ultimate','enclose', etc. */
  tags: string[];
  /** Free-form extension for titan-specific behaviour keyed by the combat module. */
  extra?: Record<string, unknown>;
}

/** Recipe for the procedural body generator. Schema is owned by the titan art module (src/titans/art). */
export interface TitanArtRecipe {
  /** Map dimensions in cells (bodies are 90–180 px across; map may exceed the intact body to leave room to grow). */
  w: number;
  h: number;
  /** Core anchor in map cells. */
  coreX: number;
  coreY: number;
  coreRadius: number;
  /** Generator-specific parameters. */
  params: Record<string, unknown>;
}

export interface AiPersonality {
  /** Free-form weights consumed by src/ai (aggression, patience, zoning, retreat, trap, …), 0..1. */
  weights: Record<string, number>;
  /** One-line intent, shown in docs/AI.md. */
  style: string;
}

export interface TitanDef {
  id: TitanId;
  name: string;
  nameKo: string;
  epithet: string;
  attributes: TitanAttributes;
  resource: ResourceDef;
  /** Its destruction signature (primary damage type). */
  destruction: DamageType;
  passive: { name: string; text: string };
  failureMode: { name: string; text: string };
  materials: MaterialSpec[];
  art: TitanArtRecipe;
  moves: MoveDef[];
  ai: AiPersonality;
  /** UI accent colours (hex). */
  ui: { accent: string; accent2: string; tagline: string };
}

/** Attributes as modified live by the body's remaining mass (see FighterView.stats). */
export interface EffectiveStats {
  /** Multipliers relative to nominal (1 = as authored). Lighter → faster, weaker; the Black Hole inverts (heavier → stronger, slower). */
  speedMul: number;
  damageMul: number;
  /** Effective mass in the units used by DamageEvent.sourceMass and knockback divisions. */
  mass: number;
  reachMul: number;
  tempoMul: number;
}

export const MOVE_SLOTS: readonly MoveSlot[] = ['strike', 'crush', 'surge', 'signature', 'ultimate', 'guard'];

/** Total ticks of a variant (startup + active + recovery). */
export const totalTicks = (f: FrameData): number => f.startup + f.active + f.recovery;
