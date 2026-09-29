import { DefaultBehaviour, type Behaviour } from '../behaviour';
import type { FighterImpl } from '../fighter';
import { AsteroidBehaviour } from './asteroid';
import { LastOneBehaviour } from './lastone';
import { NexusBehaviour } from './nexus';
import { SupernovaBehaviour } from './supernova';

/** One behaviour per titan. Titans without bespoke parts fall back to the default (no parts, nominal guard). */
export function createBehaviour(f: FighterImpl): Behaviour {
  switch (f.def.id) {
    case 'lastone':
      return new LastOneBehaviour(f);
    case 'asteroid':
      return new AsteroidBehaviour(f);
    case 'nexus':
      return new NexusBehaviour(f);
    case 'supernova':
      return new SupernovaBehaviour(f);
    default:
      return new DefaultBehaviour(f);
  }
}
