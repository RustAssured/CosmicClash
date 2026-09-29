import { LOGICAL_H, LOGICAL_W } from '@/contracts';

/** Entry point. The Lead replaces this with the app shell (src/app) once the vertical slice modules land. */
const canvas = document.getElementById('game') as HTMLCanvasElement;
canvas.width = LOGICAL_W;
canvas.height = LOGICAL_H;
