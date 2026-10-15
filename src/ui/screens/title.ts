import { LOGICAL_W } from '@/contracts';
import { C, accentRamp, alpha } from '../pixel/palette';
import { drawText } from '../pixel/text';
import { drawWordmark } from '../pixel/wordmark';
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
  wordmarkPortraits,
} from './kit';

const ACCENT = accentRamp('#a8bdb2');

/** Title: the wordmark, 아득, and the menu. Idle time here starts the AI-vs-AI attract mode (see runtime). */
export function createTitleScreen(): Screen {
  const menu = new Menu([
    { id: 'versus', en: 'VERSUS', ko: '대전' },
    { id: 'vsai', en: 'VS AI', ko: '인공지능' },
    { id: 'ladder', en: 'TOURNAMENT', ko: '토너먼트' },
    { id: 'training', en: 'TRAINING', ko: '연습' },
    { id: 'howto', en: 'HOW TO PLAY', ko: '설명' },
    { id: 'controller', en: 'CONTROLLER CHECK', ko: '조작 확인' },
    { id: 'options', en: 'OPTIONS', ko: '설정' },
    // last, so every older position (tests count downs from VERSUS) stays put; UP from VERSUS wraps straight to it
    { id: 'online', en: 'ONLINE', ko: '온라인' },
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
        case 'ladder':
          // the tournament: claim a device, then resume the stored run or pick a titan (src/ui/screens/ladder.ts)
          ctx.setup.mode = 'ladder';
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
        case 'online':
          // CHALLENGE A FRIEND (src/ui/screens/online.ts): its own screen, driven by the app's online session
          ctx.deps.online?.openMenu();
          ctx.push('online');
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
      // the wordmark (logo D) fills the top; 아득 sits under it, then the tagline, then the menu
      drawWordmark(cv, LOGICAL_W / 2, 6, ctx.t, { size: 'medium', portraits: wordmarkPortraits(ctx) });
      drawText(cv, '아득', LOGICAL_W / 2, 135, {
        color: C.celadon,
        align: 'center',
        tracking: 4,
        shadow: alpha(C.void, 0.85),
      });
      drawText(cv, 'COLOSSAL ENTITIES  ·  WORN DOWN PIXEL BY PIXEL', LOGICAL_W / 2, 150, {
        color: C.dim,
        font: 'micro',
        align: 'center',
        tracking: 1,
      });
      // eight rows: a little tighter than the original seven so the last clears the prompt bar
      drawCentreMenu(ctx, menu, LOGICAL_W / 2, 162, 20, ACCENT);
      footer(ctx, confirmBack(ctx, 'SELECT', 'BACK'), ctx.deps.version);
    },
  };
}
