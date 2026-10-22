import type { TitanDef } from '@/contracts';
import type { KitTitan } from '../types';
import json from './cradlechild.json';
import { buildChildRig, paintChild } from './paint';

/**
 * CRADLE CHILD / 요람의 아이: made with the titan kit, with its own painter (./paint.ts). WJ's brief:
 * docs/titans/cradlechild/BRIEF.md. Gate 1 (look and silhouette) only: its moves and behaviour are still the blob's.
 * The Korean name lives in the JSON (`nameKo`, `kit.site.ko`): WJ may still switch it to 화신체.
 */
const def = json as unknown as TitanDef;
const kit: KitTitan = { def, paint: paintChild, rig: buildChildRig };
export default kit;
