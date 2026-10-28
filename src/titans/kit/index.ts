import type { TitanDef, TitanId } from '@/contracts';
import type { KitTitan } from './types';
import cradleKit from './cradle';
import cradlechildKit from './cradlechild';
import remainderKit from './remainder';
// new:titan imports (the scaffold adds `import <name> from './<id>';` above this line)

/**
 * The titans built with the titan kit, one folder each (src/titans/kit/<id>/: <id>.json + index.ts). `npm run new:titan`
 * registers a new one here and in src/contracts/roster.ts; `npm run new:titan -- --remove <id>` takes it out again.
 */
export const KIT_TITANS: readonly KitTitan[] = [
  cradleKit,
  cradlechildKit,
  remainderKit,
  // new:titan (the scaffold adds entries above this line)
];

const BY_ID = new Map<string, KitTitan>(KIT_TITANS.map((k) => [k.def.id, k]));

export const kitTitan = (id: TitanId): KitTitan | undefined => BY_ID.get(id);
export const kitDefs = (): TitanDef[] => KIT_TITANS.map((k) => k.def);
export type { KitTitan } from './types';
