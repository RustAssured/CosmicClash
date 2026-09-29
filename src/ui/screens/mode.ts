import { LOGICAL_W, REACTION_MS, type Difficulty } from '@/contracts';
import { DIFFICULTY_LABELS, difficultyNote } from '../labels';
import { C, accentRamp, alpha } from '../pixel/palette';
import { drawIcon, meterBar, panel, pips } from '../pixel/shapes';
import { drawText, wrapText } from '../pixel/text';
import {
  Menu,
  confirmBack,
  drawCentreMenu,
  footer,
  header,
  scrim,
  vignette,
  type Screen,
  backdrop,
} from './kit';

const ACCENT = accentRamp('#a8bdb2');

/** Match setup for VS AI: pick the difficulty (1–6). The AI reads only public state and reacts 180–350 ms late. */
export function createModeScreen(): Screen {
  const menu = new Menu(
    DIFFICULTY_LABELS.map((d) => ({
      id: String(d.level),
      en: `${d.level}  ${d.name.toUpperCase()}`,
      ko: d.nameKo,
    })),
  );
  return {
    enter(ctx) {
      menu.set(ctx.setup.aiLevel - 1);
    },
    update(ctx) {
      const n = ctx.nav;
      if (menu.step(n)) ctx.sound('move');
      if (n.back) {
        ctx.sound('back');
        ctx.pop();
      } else if (n.confirm) {
        ctx.setup.aiLevel = (menu.index + 1) as Difficulty;
        ctx.sound('confirm');
        ctx.push('assign');
      }
    },
    draw(ctx) {
      const cv = ctx.cv;
      backdrop(cv, 'bg:0.72:0.6:0.78:', (bg) => {
        scrim(bg, 0.72, 0.6, 0.78);
        vignette(bg);
      });
      header(ctx, 'VS AI', '난이도');
      const level = (menu.index + 1) as Difficulty;
      const lab = DIFFICULTY_LABELS[level - 1]!;
      // list on the left
      menu.items.forEach((it, i) => {
        const y = 62 + i * 30;
        const focus = i === menu.index;
        const col = focus ? C.white : C.mid;
        panel(cv, 40, y - 6, 232, 26, {
          fill: alpha(focus ? C.ink2 : C.ink0, focus ? 0.9 : 0.55),
          border: focus ? ACCENT.dim : C.line0,
          accent: focus ? ACCENT.base : undefined,
          shade: false,
        });
        drawText(cv, it.en, 58, y - 1, { color: col, tracking: 2 });
        if (it.ko) drawText(cv, it.ko, 256, y - 1, { color: focus ? ACCENT.light : C.dim, align: 'right' });
        if (focus) drawIcon(cv, 'chevron', 46, y + 3, ACCENT.base);
      });
      // detail on the right
      panel(cv, 300, 56, 300, 192, { accent: ACCENT.dim });
      drawText(cv, lab.name.toUpperCase(), 318, 70, {
        color: C.white,
        tracking: 2,
        scale: 2,
        shadow: alpha(C.void, 0.85),
      });
      drawText(cv, lab.nameKo, 318, 96, { color: ACCENT.light });
      let y = 116;
      for (const line of wrapText(difficultyNote(level), 262)) {
        drawText(cv, line, 318, y, { color: C.soft });
        y += 13;
      }
      const ms = REACTION_MS[level];
      const frac = (350 - ms) / (350 - 180);
      drawText(cv, 'REACTION TIME', 318, 176, { color: C.dim, font: 'micro', tracking: 1 });
      drawText(cv, `${ms} MS`, 582, 176, { color: C.text, font: 'micro', tracking: 1, align: 'right' });
      meterBar(cv, 318, 186, 264, 6, frac, ACCENT, { ticks: true });
      drawText(cv, 'SLOW', 318, 198, { color: C.line2, font: 'micro' });
      drawText(cv, 'INSTANT', 582, 198, { color: C.line2, font: 'micro', align: 'right' });
      pips(cv, 318, 218, 6, level, ACCENT.light, C.line1, 4);
      drawText(cv, 'It reads only what a player can see.', 318, 232, {
        color: C.dim,
        font: 'micro',
        tracking: 1,
      });
      footer(ctx, confirmBack(ctx, 'CONTINUE', 'BACK'));
      void drawCentreMenu;
      void LOGICAL_W;
    },
  };
}
