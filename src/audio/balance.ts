import { clamp, type TitanId } from '@/contracts';
import { getTitanDef } from '@/titans/defs';

/**
 * Presentation energy of a blow: the hit event's energy WITHOUT the attacker's `balance.power`.
 *
 * Balance is a gameplay knob. The sim multiplies a titan's outgoing energy by it (Gate C: the Witness at 3.0, the Planet at
 * 0.75). Sound, lights and the score's heat must follow the MOVE, so turning a balance knob never changes the mix or the FX.
 * The bounds match combat/feel.ts (BALANCE_MIN / BALANCE_MAX).
 */
const POWER_MIN = 0.3;
const POWER_MAX = 3;
const power = new Map<TitanId, number>();

export function balancePower(titan: TitanId): number {
  let p = power.get(titan);
  if (p === undefined) {
    const bal = (getTitanDef(titan) as unknown as { balance?: { power?: number } }).balance;
    p = clamp(bal?.power ?? 1, POWER_MIN, POWER_MAX);
    power.set(titan, p);
  }
  return p;
}

export function presentationEnergy(energy: number, attacker: TitanId): number {
  return energy / balancePower(attacker);
}
