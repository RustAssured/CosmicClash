import { LOGICAL_W } from '@/contracts';
import { drawLogo } from '../pixel/logo';
import { C, accentRamp, alpha } from '../pixel/palette';
import { rule } from '../pixel/shapes';
import { drawText } from '../pixel/text';
import { createHowTo } from './howto';
import {
  Menu,
  drawCentreMenu,
  footer,
  confirmBack,
  pillar,
  scrim,
  vignette,
  type Screen,
  backdrop,
} from './kit';

const ACCENT = accentRamp('#a8bdb2');

/** Title: logotype, 아득, and the five-item menu. Idle time here starts the AI-vs-AI attract mode (see runtime). */
export function createTitleScreen(): Screen {
  const menu = new Menu([
    { id: 'versus', en: 'VERSUS', ko: '대전' },
    { id: 'vsai', en: 'VS AI', ko: '인공지능' },
    { id: 'training', en: 'TRAINING', ko: '연습' },
    { id: 'howto', en: 'HOW TO PLAY', ko: '설명' },
    { id: 'controller', en: 'CONTROLLER CHECK', ko: '조작 확인' },
    { id: 'options', en: 'OPTIONS', ko: '설정' },
  ]);
  const howto = createHowTo();
  return {
    enter(ctx) {
      ctx.resetIdle();
      // a new player is shown the pages once, by themselves; everyone can reopen them from the menu
      if (!ctx.settings.seenHowTo) {
        ctx.settings.seenHowTo = true;
        ctx.saveSettings();
        howto.open();
      }
    },
    update(ctx) {
      if (howto.active) {
        ctx.resetIdle();
        howto.update(ctx);
        return;
      }
      const n = ctx.nav;
      if (menu.step(n)) ctx.sound('move');
      if (!n.confirm) return;
      ctx.sound('confirm');
      switch (menu.current.id) {
        case 'versus':
          ctx.setup.mode = 'versus';
          ctx.push('assign');
          break;
        case 'vsai':
          ctx.setup.mode = 'vsai';
          ctx.push('mode');
          break;
        case 'training':
          ctx.setup.mode = 'training';
          ctx.push('assign');
          break;
        case 'howto':
          howto.open();
          break;
        case 'controller':
          ctx.push('controller');
          break;
        case 'options':
          ctx.push('options');
          break;
      }
    },
    draw(ctx) {
      if (howto.active) {
        howto.draw(ctx);
        return;
      }
      const cv = ctx.cv;
      backdrop(cv, 'bg:0.42:0.22:0.62:p', (bg) => {
        scrim(bg, 0.42, 0.22, 0.62);
        vignette(bg);
        pillar(bg, 96, 18, 544, 300, 0.74, 70);
      });
      drawLogo(cv, LOGICAL_W / 2, 44, ctx.t);
      drawText(cv, '아득', LOGICAL_W / 2, 92, {
        color: C.celadon,
        align: 'center',
        scale: 2,
        tracking: 6,
        shadow: alpha(C.void, 0.85),
      });
      rule(cv, LOGICAL_W / 2 - 110, 130, 220, C.line1);
      drawText(cv, 'COLOSSAL ENTITIES  ·  WORN DOWN PIXEL BY PIXEL', LOGICAL_W / 2, 137, {
        color: C.dim,
        font: 'micro',
        align: 'center',
        tracking: 1,
      });
      drawCentreMenu(ctx, menu, LOGICAL_W / 2, 168, 22, ACCENT);
      footer(ctx, confirmBack(ctx, 'SELECT', 'BACK'), ctx.deps.version);
    },
  };
}
