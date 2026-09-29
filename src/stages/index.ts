import type { StageId, StageInfo } from '@/contracts';
import { STAGE_INFO } from './info';

/** Static data (arena, lighting, palette) for every stage. Available immediately, no GL required. */
export const STAGES: Record<StageId, StageInfo> = STAGE_INFO;
export { STAGE_INFO };
export { createScenery, isStageImplemented } from './scenery';
export type {
  StageScenery,
  SceneryInit,
  SceneryFrame,
  SceneryLook,
  SceneryForces,
  QualityTier,
} from './types';
