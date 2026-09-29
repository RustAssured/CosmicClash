import { LOGICAL_W } from '@/contracts';
import { drawHud } from '../hud';
import { C, accentRamp, alpha } from '../pixel/palette';
import { drawIcon, panel } from '../pixel/shapes';
import { drawText, measureText } from '../pixel/text';
import { Menu, confirmBack, footer, scrim, type MenuItem, type Screen, type UICtx } from './kit';

const ACCENT = accentRamp('#a8bdb2');
const VIEWS = ['off', 'hitboxes', 'matter'] as const;
const DUMMIES = ['idle', 'guard', 'ai'] as const;

/** Pause: resume, (training tools), controller check, options, quit. Closing is driven by `resume` + the app's `showPause(false)`. */
export function createPauseScreen(): Screen {
  let menu = new Menu([]);
  const build = (ctx: UICtx): MenuItem[] => {
    const training = ctx.hud?.match.config.mode === 'training' || ctx.setup.mode === 'training';
    const items: MenuItem[] = [{ id: 'resume', en: 'RESUME', ko: '계속' }];
    if (training) {
      items.push(
        { id: 'view', en: 'OVERLAY', ko: '표시', value: ctx.training.view.toUpperCase() },
        { id: 'framedata', en: 'FRAME DATA', ko: '프레임', value: ctx.hud?.training ? 'ON' : 'OFF' },
        { id: 'dummy', en: 'DUMMY', ko: '더미', value: ctx.training.dummy.toUpperCase() },
        { id: 'reset', en: 'RESET POSITIONS', ko: '위치 초기화' },
        { id: 'heal', en: 'HEAL BOTH', ko: '회복' },
      );
    } else {
      items.push({ id: 'restart', en: 'RESTART ROUND', ko: '라운드 재시작' });
    }
    items.push(
      { id: 'controller', en: 'CONTROLLER CHECK', ko: '조작 확인' },
      { id: 'options', en: 'OPTIONS', ko: '설정' },
      { id: 'quit', en: 'QUIT TO TITLE', ko: '종료' },
    );
    return items;
  };
  const refresh = (ctx: UICtx): void => {
    const idx = menu.index;
    menu.items = build(ctx);
    menu.set(idx);
  };
  return {
    enter(ctx) {
      menu = new Menu(build(ctx));
    },
    update(ctx) {
      const n = ctx.nav;
      // Any player may drive the pause menu.
      if (menu.step(n)) ctx.sound('move');
      const cur = menu.current;
      if (n.start || n.back) {
        ctx.emit({ type: 'resume' });
        ctx.pop();
        return;
      }
      const dir = n.left ? -1 : n.right ? 1 : 0;
      if ((dir !== 0 || n.confirm) && (cur.id === 'view' || cur.id === 'dummy' || cur.id === 'framedata')) {
        const d = dir || 1;
        if (cur.id === 'view') {
          const i = VIEWS.indexOf(ctx.training.view);
          ctx.training.view = VIEWS[(i + d + VIEWS.length) % VIEWS.length]!;
          ctx.emit({ type: 'setTrainingView', overlay: ctx.training.view });
        } else if (cur.id === 'dummy') {
          const i = DUMMIES.indexOf(ctx.training.dummy);
          ctx.training.dummy = DUMMIES[(i + d + DUMMIES.length) % DUMMIES.length]!;
          ctx.deps.onExtra?.({ type: 'setDummy', mode: ctx.training.dummy });
        } else ctx.emit({ type: 'toggleTraining' });
        ctx.sound('tick');
        // the frame-data flag lives in the HudState the app owns; show the flip immediately
        if (cur.id === 'framedata' && ctx.hud) ctx.hud = { ...ctx.hud, training: !ctx.hud.training };
        refresh(ctx);
        return;
      }
      if (!n.confirm) return;
      ctx.sound('confirm');
      switch (cur.id) {
        case 'resume':
          ctx.emit({ type: 'resume' });
          ctx.pop();
          break;
        case 'restart':
          ctx.emit({ type: 'restartRound' });
          ctx.emit({ type: 'resume' });
          ctx.pop();
          break;
        case 'reset':
          ctx.emit({ type: 'restartRound' });
          ctx.deps.onExtra?.({ type: 'resetPositions' });
          ctx.emit({ type: 'resume' });
          ctx.pop();
          break;
        case 'heal':
          ctx.deps.onExtra?.({ type: 'healBoth' });
          ctx.emit({ type: 'resume' });
          ctx.pop();
          break;
        case 'controller':
          ctx.push('controller');
          break;
        case 'options':
          ctx.push('options');
          break;
        case 'quit':
          ctx.emit({ type: 'quitToTitle' });
          ctx.go('title');
          break;
      }
    },
    draw(ctx, hud) {
      const cv = ctx.cv;
      if (hud) drawHud(ctx, hud, { compact: true });
      scrim(cv, 0.6, 0.62, 0.7);
      const items = menu.items;
      const rowH = items.length > 7 ? 21 : 26;
      const h = 60 + items.length * rowH;
      const w = 300;
      const x = (LOGICAL_W - w) / 2;
      const y = Math.round((360 - h) / 2) - 6;
      panel(cv, x, y, w, h, { accent: ACCENT.base, fill: alpha(C.ink1, 0.92) });
      drawText(cv, 'PAUSED', LOGICAL_W / 2 - 20, y + 12, {
        color: C.white,
        tracking: 3,
        align: 'center',
        shadow: alpha(C.void, 0.9),
      });
      drawText(cv, '일시정지', LOGICAL_W / 2 + 36, y + 12, { color: C.celadonDeep, align: 'center' });
      cv.hline(x + 20, y + 32, w - 40, C.line1);
      items.forEach((it, i) => {
        const ry = y + 44 + i * rowH;
        const focus = i === menu.index;
        if (focus) {
          cv.rect(x + 10, ry - 4, w - 20, rowH - 3, alpha(C.ink3, 0.95));
          cv.frame(x + 10, ry - 4, w - 20, rowH - 3, ACCENT.dim);
          drawIcon(cv, 'chevron', x + 16, ry + 3, ACCENT.base);
        }
        drawText(cv, it.en, x + 30, ry, { color: focus ? C.white : C.mid, tracking: 1 });
        if (it.value) {
          drawText(cv, it.value, x + w - 22, ry, {
            color: focus ? ACCENT.light : C.dim,
            align: 'right',
            tracking: 1,
          });
          if (focus) {
            drawIcon(
              cv,
              'arrowL',
              x + w - 22 - measureText(it.value, { tracking: 1 }) - 9,
              ry + 2,
              ACCENT.base,
            );
            drawIcon(cv, 'arrowR', x + w - 17, ry + 2, ACCENT.base);
          }
        } else if (it.ko && !focus) drawText(cv, it.ko, x + w - 22, ry, { color: C.line2, align: 'right' });
        else if (it.ko) drawText(cv, it.ko, x + w - 22, ry, { color: ACCENT.light, align: 'right' });
      });
      footer(ctx, confirmBack(ctx, 'SELECT', 'RESUME'));
    },
  };
}
