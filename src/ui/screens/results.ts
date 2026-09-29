import { LOGICAL_W, ROUNDS_TO_WIN } from '@/contracts';
import { bodySprites } from '../hud';
import { C, accentRamp, alpha } from '../pixel/palette';
import { drawIcon, panel, pips } from '../pixel/shapes';
import { drawText, measureText } from '../pixel/text';
import { Menu, confirmBack, drawCentreMenu, footer, scrim, vignette, type Screen, backdrop } from './kit';

/** Match results: who won, what remained of each body, the round tally, and REMATCH / TITLE. */
export function createResultsScreen(): Screen {
  let winner: 0 | 1 | -1 = -1;
  const menu = new Menu([
    { id: 'rematch', en: 'REMATCH', ko: '재대결' },
    { id: 'title', en: 'TITLE', ko: '제목 화면' },
  ]);
  return {
    enter(ctx, params) {
      winner = (params as 0 | 1 | -1 | undefined) ?? -1;
      menu.set(0);
      ctx.sound('roundwin');
    },
    update(ctx) {
      const n = ctx.nav;
      if (ctx.screenTime < 0.8) return; // don't let a mashed button skip the result
      if (menu.step(n)) ctx.sound('move');
      if (!n.confirm) return;
      ctx.sound('confirm');
      if (menu.current.id === 'rematch') ctx.emit({ type: 'rematch' });
      else {
        ctx.emit({ type: 'quitToTitle' });
        ctx.go('title');
      }
    },
    draw(ctx, hud) {
      const cv = ctx.cv;
      backdrop(cv, 'bg:0.7:0.55:0.8:', (bg) => {
        scrim(bg, 0.7, 0.55, 0.8);
        vignette(bg);
      });
      const t = Math.min(1, ctx.screenTime / 0.5);
      const cx = LOGICAL_W / 2;
      let name = 'DRAW';
      let ko = '무승부';
      let col: number = C.soft;
      if (winner !== -1 && hud) {
        const def = hud.match.fighters[winner].def;
        name = def.name.toUpperCase();
        ko = '승리!';
        col = winner === 0 ? C.p1 : C.p2;
      }
      // portraits
      if (hud) {
        for (const slot of [0, 1] as const) {
          const f = hud.match.fighters[slot];
          const size = 132;
          const sprites = bodySprites(f.view, slot, size);
          const x = slot === 0 ? 70 : LOGICAL_W - 70 - size;
          const y = 74;
          const win = winner === slot;
          const ramp = accentRamp(f.def.ui.accent);
          panel(cv, x - 8, y - 8, size + 16, size + 34, {
            accent: win ? ramp.base : C.line1,
            border: win ? ramp.dim : C.line0,
          });
          cv.blit(sprites.ghost, x, y);
          cv.blit(sprites.live, x, y, { grey: win || winner < 0 ? 0 : 0.85 });
          drawText(cv, f.def.name.toUpperCase(), x + size / 2, y + size + 4, {
            color: win ? C.white : C.dim,
            align: 'center',
            tracking: 1,
          });
          if (win) drawIcon(cv, 'star', x + size - 8, y - 2, ramp.light);
          pips(
            cv,
            x + size / 2 - (ROUNDS_TO_WIN * 7 - 2) / 2,
            y + size + 20,
            ROUNDS_TO_WIN,
            hud.wins[slot],
            slot === 0 ? C.p1 : C.p2,
            C.line1,
            2,
          );
        }
      }
      // verdict
      const y0 = 62;
      const w = measureText(name, { scale: 2, tracking: 2 });
      const reveal = Math.max(2, Math.round((w + 30) * t));
      cv.pushClip(cx - Math.floor(reveal / 2), y0 - 4, reveal, 80);
      drawText(cv, name, cx, y0, {
        color: col,
        scale: 2,
        tracking: 2,
        align: 'center',
        outline: C.void,
        shadow: alpha(C.void, 0.7),
      });
      cv.popClip();
      drawText(cv, ko, cx, y0 + 34, {
        color: col,
        scale: 2,
        align: 'center',
        tracking: 4,
        shadow: alpha(C.void, 0.8),
      });
      drawText(cv, winner >= 0 ? 'WINS THE MATCH' : 'NO WINNER', cx, y0 + 62, {
        color: C.dim,
        font: 'micro',
        align: 'center',
        tracking: 2,
      });
      drawCentreMenu(ctx, menu, cx, 232, 24, accentRamp('#a8bdb2'));
      footer(ctx, confirmBack(ctx, 'SELECT', 'BACK').slice(0, 1));
    },
  };
}
