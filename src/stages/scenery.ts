import type { StageId } from '@/contracts';
import { GenericScenery } from './generic';
import { NurseryScenery } from './nursery/nursery';
import type { StageScenery } from './types';

/** Stages with bespoke, showpiece scenery. The rest render through `GenericScenery` until their content lands. */
const IMPLEMENTED: ReadonlySet<StageId> = new Set<StageId>(['nursery']);

export const isStageImplemented = (id: StageId): boolean => IMPLEMENTED.has(id);

/** Create the scenery for a stage (GL resources are built in `init`). */
export function createScenery(id: StageId): StageScenery {
  if (id === 'nursery') return new NurseryScenery();
  return new GenericScenery(id);
}
