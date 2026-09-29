import { clamp01, type EffectiveStats, type TitanDef } from '@/contracts';
import { TUNING } from './tuning';

/**
 * Live stats from remaining mass: a titan that has lost matter is lighter and faster (speed/tempo up) but hits softer,
 * reaches less far and is easier to knock about. `massFrac` ≥ 1 (accretors) leaves everything at nominal; a titan's
 * behaviour may then adjust the result (the Black Hole inverts it, the Asteroid's rubble pile softens its blows).
 */
export function computeStats(def: TitanDef, massFrac: number, out: EffectiveStats): EffectiveStats {
  const light = clamp01(1 - massFrac);
  out.speedMul = 1 + TUNING.lightSpeedGain * light;
  out.tempoMul = 1 + TUNING.lightTempoGain * light;
  out.damageMul = 1 - TUNING.lightDamageLoss * light;
  out.mass = def.attributes.mass * (1 - TUNING.lightMassLoss * light);
  out.reachMul = 1 - TUNING.lightReachLoss * light;
  return out;
}

/** Top horizontal speed in px/s for a titan at the given live stats. */
export function topSpeed(def: TitanDef, s: EffectiveStats): number {
  const base = TUNING.speedBase + TUNING.speedPerTempo * def.attributes.tempo;
  const massPenalty = 1.1 - 0.02 * def.attributes.mass;
  return base * s.speedMul * massPenalty;
}
