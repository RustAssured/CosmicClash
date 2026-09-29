import type { StageId } from '@/contracts';
import { NurseryScenery } from './nursery/nursery';
import { QuasarScenery } from './quasar/quasar';
import { RedGiantScenery } from './redgiant/redgiant';
import { RimScenery } from './rim/rim';
import { TussenruimteScenery } from './tussenruimte/tussenruimte';
import type { StageScenery } from './types';

/** Every stage now has bespoke, showpiece scenery. */
const FACTORIES: Readonly<Record<StageId, () => StageScenery>> = {
  nursery: () => new NurseryScenery(),
  rim: () => new RimScenery(),
  redgiant: () => new RedGiantScenery(),
  quasar: () => new QuasarScenery(),
  tussenruimte: () => new TussenruimteScenery(),
};

/** True when the stage has its own scenery (all five do; kept so callers written against the earlier partial roster keep working). */
export const isStageImplemented = (id: StageId): boolean => id in FACTORIES;

/** Create the scenery for a stage (GL resources are built in `init` / `prepare`). */
export function createScenery(id: StageId): StageScenery {
  return FACTORIES[id]();
}
