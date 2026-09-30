import { clamp } from '@/contracts';
import type { ParticleKind, TitanDef } from '@/contracts';
import { hex } from '@/contracts';

/**
 * Per-titan "body weight and presence" tuning. Everything has a default derived from the titan's MASS attribute, so a new titan needs
 * nothing; an optional top-level `feel` block in its JSON overrides any field (see docs/ADDING_A_TITAN.md for the semantics).
 */
export interface FeelFx {
  kind: ParticleKind;
  /** Packed colours bright to dark (hex strings in the JSON). */
  ramp: number[];
  /** Particles per 100 px travelled (times the mass factor); a wake, not a fountain. */
  perHundredPx: number;
  /** Extra particles per second while hovering still (0 = none). */
  idleRate: number;
  size: number;
  life: [number, number];
  emissive: number;
  /** Spread (px/s) and how far behind the body (facing-relative px) the wake starts. */
  spread: number;
  behind: number;
  /** Upward drift (px/s, negative = up) so heat and gas rise while dust falls. */
  rise: number;
}

export interface Feel {
  /** Multiplier on the stick response time constant (heavier = laggier). */
  accelMul: number;
  /** Multiplier on the glide half-life after the stick is released (heavier = longer slow drift). */
  glideMul: number;
  /** Damping ratio of the stick filter: below 1 the body overshoots its target speed a little. */
  zeta: number;
  /** Idle breathing bob: amplitude (px) and period (s); sway is the slower sideways drift. */
  bobAmp: number;
  bobPeriod: number;
  swayAmp: number;
  swayPeriod: number;
  /** Multiplier on knockback velocity received (1 = the mass-ratio result). */
  knockMul: number;
  /** Multiplier on the lean/shear recoil kick when hit. */
  recoil: number;
  /** Multiplier on the victim's hit vibration and the attacker's follow-through. */
  shudder: number;
  /** Multiplier on the low-frequency thud shake of a heavy release. */
  thud: number;
  fx: FeelFx | null;
}

const FX_KINDS: readonly ParticleKind[] = [
  'spark',
  'ember',
  'dust',
  'gas',
  'ash',
  'glint',
  'plasma',
  'shard',
  'mote',
];

interface FeelJson extends Partial<Omit<Feel, 'fx'>> {
  bob?: { amp?: number; period?: number };
  sway?: { amp?: number; period?: number };
  fx?: {
    kind?: string;
    ramp?: string[];
    perHundredPx?: number;
    idleRate?: number;
    size?: number;
    life?: [number, number];
    emissive?: number;
    spread?: number;
    behind?: number;
    rise?: number;
  } | null;
}

/** Resolve a titan's feel: defaults from mass, then the JSON `feel` block on top. */
export function resolveFeel(def: TitanDef): Feel {
  const mass = def.attributes.mass;
  const m = mass / 5;
  const j = (def as unknown as { feel?: FeelJson }).feel ?? {};
  let fx: FeelFx | null = null;
  const jf = j.fx;
  if (jf) {
    const kind = FX_KINDS.includes(jf.kind as ParticleKind) ? (jf.kind as ParticleKind) : 'dust';
    fx = {
      kind,
      ramp: (jf.ramp ?? ['#ffffff', '#aaaaaa', '#555555']).map(hex),
      perHundredPx: jf.perHundredPx ?? 3,
      idleRate: jf.idleRate ?? 0,
      size: jf.size ?? 1,
      life: jf.life ?? [16, 34],
      emissive: jf.emissive ?? 0,
      spread: jf.spread ?? 30,
      behind: jf.behind ?? 30,
      rise: jf.rise ?? 0,
    };
  }
  return {
    accelMul: j.accelMul ?? clamp(Math.pow(m, 0.55), 0.7, 1.9),
    glideMul: j.glideMul ?? clamp(Math.pow(m, 0.35), 0.8, 1.5),
    zeta: j.zeta ?? clamp(0.9 - 0.045 * mass, 0.5, 0.85),
    bobAmp: j.bob?.amp ?? j.bobAmp ?? clamp(0.6 + 0.25 * mass, 0, 4),
    bobPeriod: j.bob?.period ?? j.bobPeriod ?? 3.6,
    swayAmp: j.sway?.amp ?? j.swayAmp ?? clamp(0.15 * mass, 0, 2),
    swayPeriod: j.sway?.period ?? j.swayPeriod ?? 5.3,
    knockMul: j.knockMul ?? 1,
    recoil: j.recoil ?? 1,
    shudder: j.shudder ?? 1,
    thud: j.thud ?? 1,
    fx,
  };
}
