import { LOGICAL_H, LOGICAL_W } from '@/contracts';
import { drawHud } from '../hud';
import { drawLogo } from '../pixel/logo';
import { C, alpha } from '../pixel/palette';
import { drawText } from '../pixel/text';
import type { Screen } from './kit';

/** Attract overlay: the HUD of an AI-vs-AI match plus a watermark; any input ends it. */
export function createAttractScreen(): Screen {
  return {
    update(ctx) {
      const n = ctx.nav;
      if (ctx.screenTime > 0.4 && (n.any || n.confirm || n.start || n.back)) {
        ctx.emit({ type: 'attractStop' });
        ctx.sound('confirm');
        ctx.go('title');
      }
    },
    draw(ctx, hud) {
      const cv = ctx.cv;
      if (hud) drawHud(ctx, hud, { compact: true });
      drawLogo(cv, LOGICAL_W / 2, LOGICAL_H - 62, ctx.t, { glint: false });
      const blink = 0.5 + 0.5 * Math.sin(ctx.t * 3);
      drawText(cv, 'PRESS ANY BUTTON', LOGICAL_W / 2, LOGICAL_H - 20, {
        color: alpha(C.soft, 0.4 + blink * 0.6),
        align: 'center',
        tracking: 2,
        shadow: alpha(C.void, 0.9),
      });
    },
  };
}
