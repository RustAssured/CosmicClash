import { LOGICAL_H, LOGICAL_W } from '@/contracts';
import { C, alpha } from '../pixel/palette';
import { rule } from '../pixel/shapes';
import { drawText } from '../pixel/text';
import { drawWordmark } from '../pixel/wordmark';
import { pillar, scrim, type Screen, backdrop, wordmarkPortraits } from './kit';

/** First screen: the wordmark and "press any button". The press is also the user gesture that unlocks WebAudio. */
export function createBootScreen(): Screen {
  let unlocked = false;
  return {
    enter() {
      unlocked = false;
    },
    update(ctx) {
      const n = ctx.nav;
      if (!unlocked && (n.any || n.confirm || n.start)) {
        unlocked = true;
        ctx.emit({ type: 'unlockAudio' });
        const s = ctx.settings;
        ctx.emit({ type: 'setVolume', master: s.master / 10, music: s.music / 10, sfx: s.sfx / 10 });
        ctx.emit({ type: 'setQuality', quality: s.quality });
        ctx.sound('confirm');
        ctx.go('title');
      }
    },
    draw(ctx) {
      const cv = ctx.cv;
      backdrop(cv, 'bg:0.5:0.3:0.6:b', (bg) => {
        scrim(bg, 0.5, 0.3, 0.6);
        pillar(bg, 110, 100, 530, 280, 0.72, 60);
      });
      const { h } = drawWordmark(cv, LOGICAL_W / 2, 46, ctx.t, {
        size: 'medium',
        portraits: wordmarkPortraits(ctx),
      });
      const y = 46 + h;
      drawText(cv, '아득', LOGICAL_W / 2, y + 6, {
        color: C.celadon,
        align: 'center',
        scale: 2,
        tracking: 6,
        shadow: alpha(C.void, 0.8),
      });
      rule(cv, LOGICAL_W / 2 - 90, y + 40, 180, C.line1);
      const blink = 0.55 + 0.45 * Math.sin(ctx.t * 3.2);
      const col = alpha(C.soft, blink);
      drawText(cv, 'PRESS ANY BUTTON', LOGICAL_W / 2, y + 52, { color: col, align: 'center', tracking: 2 });
      drawText(cv, '아무 버튼이나 누르세요', LOGICAL_W / 2, y + 68, {
        color: alpha(C.dim, 0.5 + blink * 0.5),
        align: 'center',
      });
      drawText(cv, ctx.deps.version ?? '', LOGICAL_W - 12, LOGICAL_H - 12, {
        color: C.line2,
        font: 'micro',
        align: 'right',
      });
    },
  };
}
