import { LOGICAL_W } from '@/contracts';
import type { DeviceInfo } from '@/input';
import { DIFFICULTY_LABELS } from '../labels';
import { deviceIconSprite } from '../pixel/controller-art';
import { C, alpha } from '../pixel/palette';
import { chip, drawIcon, panel } from '../pixel/shapes';
import { drawText } from '../pixel/text';
import {
  confirmBack,
  footer,
  header,
  promptLabels,
  settled,
  scrim,
  vignette,
  type Screen,
  type UICtx,
  backdrop,
} from './kit';

const SLOT_COL = [C.p1, C.p2] as const;

/** Player ↔ device assignment: "press any button" to join, L/R to swap, confirm when every human slot is claimed. */
export function createAssignScreen(): Screen {
  let claimed: [string | null, string | null] = [null, null];
  const tmp: DeviceInfo[] = [];

  const humans = (ctx: UICtx): number => (ctx.setup.mode === 'versus' ? 2 : 1);
  const info = (ctx: UICtx, id: string | null): DeviceInfo | null =>
    id ? (ctx.input.devices().find((d) => d.id === id) ?? null) : null;

  return {
    enter(ctx) {
      claimed = [null, null];
      // drop presses that opened this screen
      ctx.input.drainActivity(tmp);
      tmp.length = 0;
    },
    update(ctx) {
      const n = ctx.nav;
      // unplugged devices lose their seat
      for (const s of [0, 1] as const) if (claimed[s] && !info(ctx, claimed[s])) claimed[s] = null;

      let joined = false;
      ctx.input.drainActivity(tmp);
      for (const d of tmp) {
        if (claimed.includes(d.id)) continue;
        const slot: 0 | 1 | null =
          claimed[0] === null ? 0 : claimed[1] === null && humans(ctx) > 1 ? 1 : null;
        if (slot === null) continue;
        claimed[slot] = d.id;
        ctx.input.assign(slot, d.id);
        ctx.sound('select');
        joined = true;
      }
      tmp.length = 0;
      // The press that joins a device is not also a menu action (on a Nintendo pad the bottom button is Back).
      if (joined) return;

      if (n.back) {
        // back releases the last seat first, then leaves the screen
        const last = claimed[1] ? 1 : claimed[0] ? 0 : -1;
        if (last >= 0 && humans(ctx) > 1 && settled(ctx, 0.4) && last === 1) {
          claimed[1] = null;
          ctx.sound('back');
        } else {
          ctx.sound('back');
          ctx.pop();
        }
        return;
      }
      if (n.tab && claimed[0] && claimed[1]) {
        ctx.input.swapSlots();
        claimed = [claimed[1], claimed[0]];
        ctx.sound('move');
      }
      const ready = humans(ctx) === 2 ? claimed[0] !== null && claimed[1] !== null : claimed[0] !== null;
      if (n.confirm && !joined && ready) {
        ctx.sound('confirm');
        ctx.push('select');
      }
    },
    draw(ctx) {
      const cv = ctx.cv;
      backdrop(cv, 'bg:0.72:0.62:0.78:', (bg) => {
        scrim(bg, 0.72, 0.62, 0.78);
        vignette(bg);
      });
      const mode = ctx.setup.mode;
      header(
        ctx,
        'PLAYERS',
        '플레이어',
        mode === 'versus' ? 'VERSUS' : mode === 'vsai' ? 'VS AI' : 'TRAINING',
      );
      const W = 268;
      for (const s of [0, 1] as const) {
        const x = s === 0 ? 40 : LOGICAL_W - 40 - W;
        const y = 56;
        const col = SLOT_COL[s];
        const human = s === 0 || mode === 'versus';
        const dev = info(ctx, claimed[s]);
        const on = human ? dev !== null : true;
        panel(cv, x, y, W, 150, {
          accent: on ? col : C.line2,
          border: on ? col : C.line1,
          fill: alpha(C.ink1, on ? 0.9 : 0.7),
        });
        drawText(cv, `P${s + 1}`, x + 14, y + 12, {
          color: col,
          scale: 2,
          tracking: 1,
          shadow: alpha(C.void, 0.85),
        });
        drawText(cv, s === 0 ? '플레이어 1' : '플레이어 2', x + 50, y + 14, { color: alpha(col, 0.7) });
        cv.hline(x + 14, y + 36, W - 28, C.line0);
        if (human) {
          if (dev) {
            cv.blit(deviceIconSprite(dev.profile, col), x + 16, y + 52, { scale: 2 });
            drawText(cv, dev.name.toUpperCase(), x + 100, y + 50, { color: C.white, tracking: 1 });
            const sub =
              dev.kind === 'keyboard'
                ? 'KEYBOARD'
                : `${dev.family.toUpperCase()}  ${dev.mapping === 'standard' ? 'STANDARD' : dev.mapping === 'webhid' ? 'WEBHID' : 'RAW MAPPING'}`;
            drawText(cv, sub, x + 100, y + 66, { color: C.dim, font: 'micro', tracking: 1 });
            drawText(cv, dev.hasRumble ? 'RUMBLE' : 'NO RUMBLE', x + 100, y + 76, {
              color: dev.hasRumble ? C.mid : C.line2,
              font: 'micro',
              tracking: 1,
            });
            drawIcon(cv, 'check', x + 22, y + 110, C.ok);
            drawText(cv, 'READY', x + 34, y + 108, { color: C.ok, tracking: 2 });
            drawText(cv, '준비 완료', x + W - 14, y + 108, { color: C.dim, align: 'right' });
          } else {
            const blink = 0.45 + 0.55 * Math.abs(Math.sin(ctx.t * 2.6));
            drawText(cv, 'PRESS ANY BUTTON', x + W / 2, y + 68, {
              color: alpha(col, blink),
              align: 'center',
              tracking: 2,
            });
            drawText(cv, '아무 버튼이나 누르세요', x + W / 2, y + 88, {
              color: alpha(C.dim, 0.6 + 0.4 * blink),
              align: 'center',
            });
          }
        } else if (mode === 'vsai') {
          const lab = DIFFICULTY_LABELS[ctx.setup.aiLevel - 1]!;
          drawText(cv, 'AI OPPONENT', x + W / 2, y + 60, { color: C.text, align: 'center', tracking: 2 });
          drawText(cv, `LEVEL ${lab.level}  ${lab.name.toUpperCase()}`, x + W / 2, y + 80, {
            color: C.mid,
            align: 'center',
            tracking: 1,
          });
          drawText(cv, lab.nameKo, x + W / 2, y + 98, { color: C.celadonDeep, align: 'center' });
        } else {
          drawText(cv, 'TRAINING DUMMY', x + W / 2, y + 64, { color: C.text, align: 'center', tracking: 2 });
          drawText(cv, '연습 상대', x + W / 2, y + 84, { color: C.celadonDeep, align: 'center' });
        }
      }
      // detected devices
      drawText(cv, 'DETECTED', 40, 224, { color: C.dim, font: 'micro', tracking: 1 });
      let x = 40;
      for (const d of ctx.input.devices()) {
        const slot: 0 | 1 | null = claimed[0] === d.id ? 0 : claimed[1] === d.id ? 1 : null;
        const col = slot !== null ? SLOT_COL[slot] : C.line2;
        const label =
          d.kind === 'keyboard' ? d.name.replace('Keyboard ', 'KB').toUpperCase() : d.name.toUpperCase();
        const wtxt = label.length * 6 + 24;
        if (x + wtxt > LOGICAL_W - 40) break;
        cv.rect(x, 236, wtxt, 18, alpha(C.ink2, 0.92));
        cv.frame(x, 236, wtxt, 18, slot !== null ? col : C.line0);
        drawText(cv, label, x + 8, 241, { color: slot !== null ? C.white : C.mid, valign: 'cap' });
        if (slot !== null)
          drawText(cv, `P${slot + 1}`, x + wtxt / 2, 258, { color: col, font: 'micro', align: 'center' });
        x += wtxt + 8;
      }
      const p = promptLabels(ctx);
      footer(ctx, [
        ...confirmBack(ctx, 'CONTINUE', 'BACK'),
        ...(mode === 'versus' ? [{ chip: p.tab, text: 'SWAP' }] : []),
      ]);
      void chip;
    },
  };
}
