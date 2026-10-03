import { describe, expect, it } from 'vitest';
import { getTitanDef } from '@/titans/defs';
import { balancePower, presentationEnergy } from './balance';

const power = (id: 'lastone' | 'planet'): number =>
  (getTitanDef(id) as unknown as { balance?: { power?: number } }).balance?.power ?? 1;

describe('presentation energy (balance-free)', () => {
  it("takes the attacker's balance.power out of a blow's energy, so balance knobs never change the mix", () => {
    for (const id of ['lastone', 'planet'] as const) {
      expect(balancePower(id)).toBeCloseTo(Math.min(3, Math.max(0.3, power(id))), 9);
      // the same move dealt at any power reads the same
      expect(presentationEnergy(900 * balancePower(id), id)).toBeCloseTo(900, 6);
    }
  });
});
