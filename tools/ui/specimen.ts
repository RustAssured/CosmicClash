/** Type + toolkit specimen: logotype, both Latin faces, Hangeul, icons, chips, bars. `npx tsx tools/ui/specimen.ts [scale]` */
import { writePng } from '../lead/png';
import { PixelCanvas } from '../../src/ui/pixel/canvas';
import { drawLogo } from '../../src/ui/pixel/logo';
import { C, accentRamp, alpha } from '../../src/ui/pixel/palette';
import { chip, drawIcon, meterBar, panel, pips, rule, segBar } from '../../src/ui/pixel/shapes';
import { drawText } from '../../src/ui/pixel/text';

const cv = new PixelCanvas(640, 360);
cv.clear(0xff1a0c08);
cv.gradientV(0, 0, 640, 360, [C.void, C.ink1, C.ink2]);
drawLogo(cv, 320, 10, 1.0);
drawText(cv, '아득', 320, 52, { color: C.celadon, align: 'center', scale: 2, tracking: 4 });
rule(cv, 200, 86, 240, C.line2);
const t = { color: C.text };
drawText(cv, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789', 16, 96, t);
drawText(cv, 'abcdefghijklmnopqrstuvwxyz .,:;!?()[]+-=/%', 16, 108, t);
drawText(cv, 'The quick brown fox jumps over the lazy dog 1234', 16, 120, { color: C.soft });
drawText(cv, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 +-:/%()', 16, 136, { color: C.mid, font: 'micro' });
drawText(cv, '아득  마지막 하나  넥서스  블랙홀  초신성  행성  소행성', 16, 146, { color: C.celadon });
drawText(cv, 'VERSUS · vs AI · TRAINING  대전 · 연습 · 설정', 16, 160, { color: C.text, tracking: 1 });
drawText(cv, 'PRESS ANY BUTTON', 16, 176, { color: C.gold, scale: 2 });
let x = 16;
for (const l of ['A', 'B', 'X', 'Y', 'L', 'R', 'ZL', 'ZR', '+', '−', 'SPACE', '', '', '', ''])
  x += chip(cv, x, 200, l) + 3;
const ramp = accentRamp('#a8bdb2');
segBar(cv, 16, 220, 10, 7, ramp);
meterBar(cv, 16, 234, 140, 6, 0.62, ramp, { ticks: true, ghost: 0.8 });
pips(cv, 16, 248, 3, 2, ramp.light, C.line2);
for (const [i, n] of ['chevron', 'arrowR', 'diamond', 'check', 'lock', 'star', 'bolt', 'cross'].entries())
  drawIcon(cv, n, 200 + i * 12, 220, C.soft);
panel(cv, 360, 200, 120, 60, { accent: C.celadon });
drawText(cv, 'PANEL', 370, 210, { color: C.text });
panel(cv, 490, 200, 120, 60, { accent: C.p1 });
drawText(cv, 'P1 · 플레이어', 500, 210, { color: C.p1 });
cv.dither(16, 280, 200, 20, alpha(C.celadon, 1), 8);
cv.gradientV(230, 280, 200, 20, [C.celadonDeep, C.celadon, C.celadonLight]);
writePng('.scratch/ui/specimen.png', cv.pixels, 640, 360, parseInt(process.argv[2] ?? '2', 10));
console.log('ok');
