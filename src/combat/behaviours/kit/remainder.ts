import type { EffectiveStats } from '@/contracts';
import type { ActiveMove } from '../../move';
import { KitBehaviour } from './base';

/**
 * Remainder's behaviour (titan kit, blob template). ONE signature mechanic hook: `onSignature` runs when its signature move
 * (remainder.swell) goes active. The placeholder: it swells for two seconds and every blow it lands hits 20 % harder.
 *
 * Replace it with the creature's own idea (docs/TITAN_GUIDE.md, "The signature move"). Keep the sim deterministic: state in
 * fields, changed only in these hooks, folded into `hashState`.
 */
export class RemainderBehaviour extends KitBehaviour {
  protected override onSignature(_m: ActiveMove): void {
    this.signatureLeft = 120; // ticks (60 = one second)
  }

  protected override signatureStats(s: EffectiveStats): void {
    s.damageMul *= 1.2;
  }
}
