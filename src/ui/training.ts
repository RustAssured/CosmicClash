import {
  LOGICAL_H,
  LOGICAL_W,
  type FighterView,
  type HudState,
  type MoveDef,
  type FrameData,
} from '@/contracts';
import { C, accentRamp, alpha, mixRgb } from './pixel/palette';
import { panel } from './pixel/shapes';
import { drawText, measureText } from './pixel/text';
import type { UICtx } from './screens/kit';

/** Frame data for the move currently executing: the variant for the aim the move was started with. */
export function frameDataFor(move: MoveDef, aim: FighterView['aim']): FrameData {
  const v = move.variants[aim ?? 'forward'];
  return { ...move.frame, ...(v?.frame ?? {}) };
}

const PW = 200;

/**
 * Training overlay: for each fighter, the current move's startup / active / recovery as a proportional timeline with a
 * playhead, the phase counter, and frame advantage from the last exchange (derived from public views — see advantage.ts).
 */
export function drawTraining(ctx: UICtx, hud: HudState): void {
  const cv = ctx.cv;
  for (const slot of [0, 1] as const) {
    const f = hud.match.fighters[slot];
    const view = f.view;
    const right = slot === 1;
    const x = right ? LOGICAL_W - 8 - PW : 8;
    const y = 66;
    const ramp = accentRamp(f.def.ui.accent);
    panel(cv, x, y, PW, 64, { accent: ramp.dim, fill: alpha(C.ink0, 0.88), shade: false });
    const move = view.moveId ? f.moveById(view.moveId) : undefined;
    drawText(cv, 'FRAME DATA', x + 8, y + 5, { color: C.dim, font: 'micro', tracking: 1 });
    drawText(cv, move ? move.name.toUpperCase() : view.state.toUpperCase(), x + PW - 8, y + 4, {
      color: move ? C.text : C.dim,
      align: 'right',
    });
    if (move) {
      const fd = frameDataFor(move, view.aim);
      const total = Math.max(1, fd.startup + fd.active + fd.recovery);
      const bw = PW - 16;
      const by = y + 22;
      const seg = [
        { n: fd.startup, c: mixRgb(C.gold, C.ink1, 0.15), label: 'S' },
        { n: fd.active, c: ramp.light, label: 'A' },
        { n: fd.recovery, c: C.line2, label: 'R' },
      ];
      let sx = x + 8;
      for (const s of seg) {
        const w = Math.max(s.n > 0 ? 2 : 0, Math.round((bw * s.n) / total));
        cv.rect(sx, by, w, 8, s.c);
        cv.hline(sx, by, w, mixRgb(s.c, C.white, 0.25));
        sx += w;
      }
      const head = x + 8 + Math.round((bw * Math.min(view.moveTick, total)) / total);
      cv.vline(head, by - 3, 14, C.white);
      cv.rect(head - 1, by - 3, 3, 1, C.white);
      const line = `S${fd.startup}  A${fd.active}  R${fd.recovery}  =  ${total}F`;
      drawText(cv, line, x + 8, y + 34, { color: C.soft, font: 'micro', tracking: 1 });
      const phase = view.phase ? view.phase.toUpperCase() : '-';
      drawText(cv, `${phase} ${view.moveTick}/${view.moveTotal || total}`, x + PW - 8, y + 34, {
        color: ramp.light,
        font: 'micro',
        tracking: 1,
        align: 'right',
      });
    } else {
      drawText(cv, 'no move active', x + 8, y + 22, { color: C.line2, font: 'micro', tracking: 1 });
      if (view.hitstunTicks > 0)
        drawText(cv, `HITSTUN ${view.hitstunTicks}`, x + 8, y + 34, {
          color: C.danger,
          font: 'micro',
          tracking: 1,
        });
    }
    // advantage: shown on the ATTACKER's panel
    const ex = ctx.advantage.last;
    if (ex && ex.attacker === slot && hud.match.tick - ex.tick < 60 * 8) {
      const txt = ex.kind === 'block' ? 'BLOCKED' : `${ex.advantage! >= 0 ? '+' : ''}${ex.advantage} ON HIT`;
      const col = ex.kind === 'block' ? C.mid : ex.advantage! >= 0 ? C.ok : C.danger;
      drawText(cv, `ADV ${txt}`, x + 8, y + 48, { color: col, font: 'micro', tracking: 1 });
    } else {
      drawText(cv, 'ADV  -', x + 8, y + 48, { color: C.line2, font: 'micro', tracking: 1 });
    }
  }
  // status badge, bottom centre
  const t = ctx.training;
  const parts = [`TRAINING`, `OVERLAY ${t.view.toUpperCase()}`, `DUMMY ${t.dummy.toUpperCase()}`];
  const text = parts.join('   ·   ');
  const w = measureText(text, { font: 'micro', tracking: 1 });
  const cx = LOGICAL_W / 2;
  cv.rect(cx - w / 2 - 8, LOGICAL_H - 30, w + 16, 11, alpha(C.ink0, 0.92));
  cv.frame(cx - w / 2 - 8, LOGICAL_H - 30, w + 16, 11, C.line0);
  drawText(cv, text, cx, LOGICAL_H - 27, { color: C.mid, font: 'micro', align: 'center', tracking: 1 });
}
