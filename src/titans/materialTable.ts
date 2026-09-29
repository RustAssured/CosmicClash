import type { MaterialDef, MaterialSpec } from '@/contracts';
import { buildMaterialTable } from '@/matter';

/**
 * Resolve a titan's JSON materials into the packed table the matter world uses: index 0 is the reserved EMPTY material,
 * `specs[i]` gets id `i + 1`, `ashTo` targets are appended after the authored ones. This module is the single place the
 * titans package depends on the matter library.
 */
export const resolveMaterials = (specs: readonly MaterialSpec[]): MaterialDef[] =>
  buildMaterialTable([...specs]);
