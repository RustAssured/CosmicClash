import { LOGICAL_W } from '@/contracts';
import { ATTRIBUTE_LABELS, DAMAGE_BLURB } from '../labels';
import { C, accentRamp, alpha, greyed } from '../pixel/palette';
import { chip, drawIcon, panel, segBar } from '../pixel/shapes';
import { drawText, measureText, wrapClamp } from '../pixel/text';
import {
  comingSoon,
  confirmBack,
  drawTitanPortrait,
  footer,
  header,
  portraitSprite,
  scrim,
  vignette,
  type Screen,
  type UICtx,
  backdrop,
} from './kit';

const SLOT_COL = [C.p1, C.p2] as const;
const TILE = 56;
const GAP = 8;
const GRID_X = (LOGICAL_W - (3 * TILE + 2 * GAP)) / 2;
const GRID_Y = 84;
const PANEL_W = 214;
const PANEL_Y = 44;
const PANEL_H = 278;

/**
 * Titan select. Versus: two cursors, each driven by that player's own device. VS AI / Training: one picker chooses your
 * titan, then the opponent's. Unimplemented titans can be inspected but not chosen ("coming soon").
 */
export function createSelectScreen(): Screen {
  let cur: [number, number] = [0, 1];
  let locked: [boolean, boolean] = [false, false];
  let phase: 0 | 1 = 0;
  let advanceAt = -1;

  const two = (ctx: UICtx): boolean => ctx.setup.mode === 'versus';
  const idx = (ctx: UICtx, id: string): number =>
    Math.max(
      0,
      ctx.deps.titans.findIndex((t) => t.id === id),
    );

  const move = (ctx: UICtx, s: 0 | 1, dx: number, dy: number): void => {
    const n = ctx.deps.titans.length;
    let i = cur[s];
    if (dx) i = (i + dx + n) % n;
    if (dy) {
      const j = i + dy * 3;
      i = j >= 0 && j < n ? j : i;
    }
    if (i !== cur[s]) {
      cur[s] = i;
      ctx.sound('move');
    }
  };

  const tryLock = (ctx: UICtx, s: 0 | 1): boolean => {
    const t = ctx.deps.titans[cur[s]]!;
    if (!ctx.isTitanReady(t.id)) {
      ctx.sound('error');
      return false;
    }
    locked[s] = true;
    ctx.sound('select');
    return true;
  };

  return {
    enter(ctx) {
      cur = [idx(ctx, ctx.setup.p1), idx(ctx, ctx.setup.p2)];
      locked = [false, false];
      phase = 0;
      advanceAt = -1;
    },
    update(ctx) {
      if (advanceAt >= 0) {
        if (ctx.t >= advanceAt) {
          ctx.setup.p1 = ctx.deps.titans[cur[0]]!.id;
          ctx.setup.p2 = ctx.deps.titans[cur[1]]!.id;
          advanceAt = -1;
          ctx.push('stage');
        }
        return;
      }
      if (two(ctx)) {
        for (const s of [0, 1] as const) {
          const n = ctx.navFor(s);
          if (locked[s]) {
            if (n.back) {
              locked[s] = false;
              ctx.sound('back');
            }
            continue;
          }
          if (n.left) move(ctx, s, -1, 0);
          else if (n.right) move(ctx, s, 1, 0);
          else if (n.up) move(ctx, s, 0, -1);
          else if (n.down) move(ctx, s, 0, 1);
          if (n.confirm) tryLock(ctx, s);
          if (n.back) {
            ctx.sound('back');
            ctx.pop();
            return;
          }
        }
        // a pad-less second player: let the merged nav still drive P2 when P2 has no device of its own
        if (locked[0] && locked[1]) advanceAt = ctx.t + 0.55;
        return;
      }
      // single picker
      const n = ctx.nav;
      const s = phase;
      if (n.left) move(ctx, s, -1, 0);
      else if (n.right) move(ctx, s, 1, 0);
      else if (n.up) move(ctx, s, 0, -1);
      else if (n.down) move(ctx, s, 0, 1);
      if (n.back) {
        ctx.sound('back');
        if (phase === 1) {
          phase = 0;
          locked[0] = false;
        } else ctx.pop();
        return;
      }
      if (n.confirm && tryLock(ctx, s)) {
        if (phase === 0) phase = 1;
        else advanceAt = ctx.t + 0.5;
      }
    },
    draw(ctx) {
      const cv = ctx.cv;
      backdrop(cv, 'bg:0.74:0.62:0.8:', (bg) => {
        scrim(bg, 0.74, 0.62, 0.8);
        vignette(bg);
      });
      const titans = ctx.deps.titans;
      const modeText = two(ctx) ? 'VERSUS' : ctx.setup.mode === 'vsai' ? 'VS AI' : 'TRAINING';
      header(ctx, 'SELECT TITAN', '타이탄 선택', modeText);

      drawSide(ctx, 0, cur[0], locked[0]);
      drawSide(ctx, 1, cur[1], locked[1]);

      // roster grid
      titans.forEach((t, i) => {
        const x = GRID_X + (i % 3) * (TILE + GAP);
        const y = GRID_Y + Math.floor(i / 3) * (TILE + GAP + 14);
        const ready = ctx.isTitanReady(t.id);
        const ramp = accentRamp(t.accent);
        panel(cv, x, y, TILE, TILE, { fill: alpha(C.ink0, 0.85), border: C.line0, shade: false });
        const spr = portraitSprite(ctx, t.id, TILE - 8, false, ready ? 0 : 0.9);
        if (spr) cv.blit(spr, x + 4, y + 4);
        if (!ready) drawIcon(cv, 'lock', x + TILE - 10, y + TILE - 9, C.dim);
        const hovered0 = cur[0] === i;
        const hovered1 = cur[1] === i;
        if (hovered0 || hovered1) {
          const pulse = Math.floor(ctx.t * 4) % 2;
          if (hovered0) cursor(ctx, x, y, TILE, SLOT_COL[0], locked[0], pulse, hovered1 ? 0 : 0);
          if (hovered1) cursor(ctx, x, y, TILE, SLOT_COL[1], locked[1], pulse, hovered0 ? 3 : 0);
        }
        void ramp;
        drawText(cv, t.name.replace('The ', '').toUpperCase(), x + TILE / 2, y + TILE + 4, {
          color: hovered0 || hovered1 ? C.white : C.dim,
          font: 'micro',
          align: 'center',
          tracking: 1,
        });
      });
      // instruction line under the grid
      const single = !two(ctx);
      const who = single
        ? phase === 0
          ? 'CHOOSE YOUR TITAN'
          : 'CHOOSE YOUR OPPONENT'
        : locked[0] && locked[1]
          ? 'BOTH READY'
          : 'CHOOSE YOUR TITANS';
      drawText(cv, who, LOGICAL_W / 2, 268, {
        color: single && phase === 1 ? C.p2 : C.soft,
        align: 'center',
        tracking: 2,
      });
      drawText(cv, single ? (phase === 0 ? '타이탄 선택' : '상대 선택') : '타이탄 선택', LOGICAL_W / 2, 284, {
        color: C.celadonDeep,
        align: 'center',
      });
      footer(ctx, confirmBack(ctx, 'LOCK IN', 'BACK'));
    },
  };

  function cursor(
    ctx: UICtx,
    x: number,
    y: number,
    s: number,
    color: number,
    lock: boolean,
    pulse: number,
    inset: number,
  ): void {
    const cv = ctx.cv;
    const o = inset - 2 + (lock ? 0 : pulse);
    cv.corners(
      x - 2 - o + inset,
      y - 2 - o + inset,
      s + 4 + (o - inset) * 2,
      s + 4 + (o - inset) * 2,
      color,
      lock ? 7 : 5,
    );
    if (lock) {
      cv.frame(x - 1, y - 1, s + 2, s + 2, color);
      drawIcon(cv, 'check', x + s - 8, y + 3, color);
    }
  }

  function drawSide(ctx: UICtx, s: 0 | 1, i: number, lock: boolean): void {
    const cv = ctx.cv;
    const t = ctx.deps.titans[i]!;
    const ready = ctx.isTitanReady(t.id);
    const ramp = accentRamp(t.accent);
    const x = s === 0 ? 8 : LOGICAL_W - 8 - PANEL_W;
    const col = SLOT_COL[s];
    const active = two(ctx) || phase === s;
    panel(cv, x, PANEL_Y, PANEL_W, PANEL_H, {
      accent: active ? col : C.line1,
      border: lock ? col : C.line1,
      fill: alpha(C.ink1, active ? 0.9 : 0.7),
    });
    // slot tag
    cv.rect(x + 8, PANEL_Y + 8, 22, 12, alpha(col, lock ? 1 : 0.22));
    drawText(cv, `P${s + 1}`, x + 19, PANEL_Y + 9, {
      color: lock ? C.void : col,
      font: 'micro',
      align: 'center',
    });
    if (lock) drawText(cv, 'LOCKED', x + 36, PANEL_Y + 11, { color: col, font: 'micro', tracking: 1 });

    // portrait
    const ps = 86;
    cv.rect(x + 10, PANEL_Y + 26, ps + 4, ps + 4, alpha(C.ink0, 0.75));
    cv.frame(x + 10, PANEL_Y + 26, ps + 4, ps + 4, C.line0);
    drawTitanPortrait(ctx, t.id, x + 12, PANEL_Y + 28, ps, {
      flip: s === 1,
      grey: ready ? 0 : 0.9,
      phase: s * 1.7,
    });
    if (!ready) comingSoon(ctx, x + 12 + ps / 2, PANEL_Y + 28 + ps / 2);

    // identity column
    const ix = x + 108;
    drawText(cv, t.name.toUpperCase(), ix, PANEL_Y + 24, {
      color: ready ? C.white : C.dim,
      tracking: 1,
      shadow: alpha(C.void, 0.85),
    });
    drawText(cv, t.nameKo, ix, PANEL_Y + 38, { color: ready ? ramp.light : C.dim });
    drawText(cv, t.epithet.toUpperCase(), ix, PANEL_Y + 54, { color: C.dim, font: 'micro', tracking: 1 });
    const dmg = DAMAGE_BLURB[t.destruction];
    const cw = measureText(dmg.name, { font: 'micro', tracking: 1 }) + 8;
    cv.rect(ix, PANEL_Y + 66, cw, 10, alpha(ramp.deep, 0.9));
    cv.frame(ix, PANEL_Y + 66, cw, 10, ramp.dim);
    drawText(cv, dmg.name, ix + 4, PANEL_Y + 68, { color: ramp.glow, font: 'micro', tracking: 1 });
    drawText(cv, `${t.resource.name.toUpperCase()}`, ix, PANEL_Y + 84, {
      color: C.dim,
      font: 'micro',
      tracking: 1,
    });
    drawText(cv, t.resource.display === 'bar' ? 'CONTINUOUS' : `${t.resource.max} UNITS`, ix, PANEL_Y + 94, {
      color: C.line2,
      font: 'micro',
      tracking: 1,
    });

    // tagline
    let y = PANEL_Y + 122;
    for (const line of wrapClamp(t.tagline, PANEL_W - 24, 2)) {
      drawText(cv, line, x + 12, y, { color: C.soft });
      y += 12;
    }
    // attributes: 2 columns × 3 rows
    const ay = PANEL_Y + 150;
    ATTRIBUTE_LABELS.forEach((a, k) => {
      const cx = x + 12 + (k % 2) * 102;
      const cy = ay + Math.floor(k / 2) * 12;
      const v = t.attributes[a.key];
      drawText(cv, a.en, cx, cy, { color: C.dim, font: 'micro', tracking: 1 });
      segBar(cv, cx + 44, cy, 10, v, ramp, { segW: 3, segH: 5, gap: 1 });
    });
    // signature + failure
    cv.hline(x + 12, PANEL_Y + 190, PANEL_W - 24, C.line0);
    drawText(cv, 'DESTRUCTION', x + 12, PANEL_Y + 197, { color: ramp.light, font: 'micro', tracking: 1 });
    // Both texts come from the titan definitions and run long (the Supernova's failure mode is 221 characters): the micro face
    // keeps every one of them whole (at most five lines) instead of cutting the sentence off.
    let ty = PANEL_Y + 206;
    for (const line of wrapClamp(dmg.text, PANEL_W - 24, 2, { font: 'micro' })) {
      drawText(cv, line, x + 12, ty, { color: C.soft, font: 'micro' });
      ty += 7;
    }
    drawText(cv, `FAILURE  ${t.failureMode.name.toUpperCase()}`, x + 12, PANEL_Y + 224, {
      color: C.danger,
      font: 'micro',
      tracking: 1,
    });
    ty = PANEL_Y + 234;
    for (const line of wrapClamp(t.failureMode.text, PANEL_W - 24, 5, { font: 'micro' })) {
      drawText(cv, line, x + 12, ty, { color: C.mid, font: 'micro' });
      ty += 7;
    }
    void chip;
    void greyed;
  }
}
