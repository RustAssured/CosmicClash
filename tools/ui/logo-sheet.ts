/** Render the logotype alone, large. `npx tsx tools/ui/logo-sheet.ts [scale]` */
import { writePng } from '../lead/png';
import { logoSprite } from '../../src/ui/pixel/logo';

const s = logoSprite();
writePng('.scratch/ui/logo.png', s.pixels, s.w, s.h, parseInt(process.argv[2] ?? '5', 10), 0xff1a0c08);
console.log('logo', s.w, s.h);
