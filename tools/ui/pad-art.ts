/** Render the Pro Controller drawing with some inputs lit. `npx tsx tools/ui/pad-art.ts [scale]` */
import { writePng } from '../lead/png';
import { PixelCanvas } from '../../src/ui/pixel/canvas';
import { PRO_H, PRO_W, drawDeviceIcon, drawPro } from '../../src/ui/pixel/controller-art';
import { C } from '../../src/ui/pixel/palette';
import { Pad } from '../../src/input';

const cv = new PixelCanvas(PRO_W + 120, PRO_H + 20);
cv.clear(0xff120a08);
const b = new Float32Array(20);
b[Pad.EAST] = 1;
b[Pad.R2] = 0.6;
b[Pad.L1] = 1;
b[Pad.LEFT] = 1;
b[Pad.START] = 1;
drawPro(cv, 6, 10, { b, lx: -0.6, ly: -0.4, rx: 0.2, ry: 0.9 }, C.celadon, 'nintendo');
drawDeviceIcon(cv, PRO_W + 20, 20, 'switch-pro', C.celadon);
drawDeviceIcon(cv, PRO_W + 20, 50, 'joycon-l', C.p1);
drawDeviceIcon(cv, PRO_W + 20, 80, 'keyboard', C.p2);
writePng('.scratch/ui/pad.png', cv.pixels, cv.w, cv.h, parseInt(process.argv[2] ?? '4', 10));
