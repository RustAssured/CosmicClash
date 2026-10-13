import type { TitanId } from '@/contracts';
import type { Behaviour } from '../../behaviour';
import type { FighterImpl } from '../../fighter';
import { CradleBehaviour } from './cradle';
// new:titan imports (the scaffold adds `import { <Name>Behaviour } from './<id>';` above this line)

/**
 * The behaviours of the titans built with the titan kit (src/titans/kit/), one file each: src/combat/behaviours/kit/<id>.ts.
 * `npm run new:titan` registers a new one here. A kit titan without an entry fights with the default behaviour.
 */
export const KIT_BEHAVIOURS: Readonly<Partial<Record<TitanId, (f: FighterImpl) => Behaviour>>> = {
  cradle: (f) => new CradleBehaviour(f),
  // new:titan (the scaffold adds entries above this line)
};
