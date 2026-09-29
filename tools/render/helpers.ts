export { STAGE_IDS, hex, rgba } from '../../src/contracts';
export type { StageId } from '../../src/contracts';
import { rgba as pack } from '../../src/contracts';

export const linearToRgbaBytes = (r: number, g: number, b: number): number => pack(r, g, b, 255);
