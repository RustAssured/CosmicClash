import { LOGICAL_W, type TitanId } from '@/contracts';
import { ATTRIBUTE_LABELS, DAMAGE_BLURB } from '../labels';
import { CLEARED, LADDER_HUNTER, LADDER_RUNGS, ladderFor, loadLadder } from '../ladder';
import { resolveStore } from '../settings';
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
const PANEL_W = 214;
const PANEL_Y = 44;
const PANEL_H = 278;
/** The column between the two side panels (196 px), less a few px so the cursor corners clear the panels' borders. */
const GRID_W = 188;
/** Room under each tile for its name: the Hangeul face (우리) is 12 px tall, the micro face 5. */
const LABEL_H = 14;
/** The prompt under the grid: "CHOOSE YOUR TITAN" (10 px) and its Korean gloss (12 px). */
const PROMPT_H = 10;
const GLOSS_H = 12;

/** Where everything in the middle column goes for a roster of `n` tiles. */
interface GridLayout {
  cols: number;
  rows: number;
  tile: number;
  /** tile i's top-left corner */
  pos(i: number): { x: number; y: number };
  /** the prompt line's y, and the gloss's (null: no room for it) */
  promptY: number;
  glossY: number | null;
}

/**
 * The roster grid, laid out as one block (tiles, their names, then the prompt) centred in the middle column between the
 * panels' top and bottom edges, so nothing can run into anything else:
 *  - up to nine titans, three columns of 56 px tiles (the original look);
 *  - 10–12, four columns of 42 px; 13–20, five of 32 px;
 *  - a short last row is centred under the full ones (so ten titans end on a centred pair, not a lone pair at the left).
 * Every tile reserves a full name row (LABEL_H), so a Hangeul name never reaches the next row or the prompt.
 */
export function gridOf(n: number): GridLayout {
  const cols = n <= 9 ? 3 : n <= 12 ? 4 : 5;
  const gap = cols === 3 ? 8 : 6;
  const tile = cols === 3 ? 56 : Math.floor((GRID_W - (cols - 1) * gap) / cols);
  const rows = Math.max(1, Math.ceil(n / cols));
  const stride = tile + LABEL_H + (cols === 3 ? 4 : 3);
  const gridH = (rows - 1) * stride + tile + LABEL_H;
  const withGloss = gridH + 6 + PROMPT_H + 3 + GLOSS_H <= PANEL_H - 8;
  const block = gridH + 6 + PROMPT_H + (withGloss ? 3 + GLOSS_H : 0);
  const top = PANEL_Y + Math.max(2, Math.floor((PANEL_H - block) / 2));
  const promptY = top + gridH + 6;
  return {
    cols,
    rows,
    tile,
    pos(i) {
      const r = Math.floor(i / cols);
      const inRow = Math.min(cols, n - r * cols);
      const rowW = inRow * tile + (inRow - 1) * gap;
      const x0 = Math.floor((LOGICAL_W - rowW) / 2);
      return { x: x0 + (i % cols) * (tile + gap), y: top + r * stride };
    },
    promptY,
    glossY: withGloss ? promptY + PROMPT_H + 3 : null,
  };
}

/** The tile reached from `i` by moving `dy` rows: the one in that row nearest `i` horizontally, or `i` at the edge. */
export function gridStep(n: number, i: number, dy: number): number {
  const g = gridOf(n);
  const r = Math.floor(i / g.cols) + dy;
  if (r < 0 || r >= g.rows) return i;
  const cx = g.pos(i).x;
  let best = i;
  let bd = Infinity;
  for (let j = r * g.cols; j < Math.min(n, (r + 1) * g.cols); j++) {
    const d = Math.abs(g.pos(j).x - cx);
    if (d < bd) {
      bd = d;
      best = j;
    }
  }
  return best;
}

/**
 * Titan select. Versus: two cursors, each driven by that player's own device. VS AI / Training: one picker chooses your
 * titan, then the opponent's. Unimplemented titans can be inspected but not chosen ("coming soon").
 */
export function createSelectScreen(): Screen {
  let cur: [number, number] = [0, 1];
  let locked: [boolean, boolean] = [false, false];
  let phase: 0 | 1 = 0;
  let advanceAt = -1;
  /** Tournament: the best rung reached per titan (shown on the tiles). */
  let best: Partial<Record<TitanId, number>> = {};

  const two = (ctx: UICtx): boolean => ctx.setup.mode === 'versus';
  /** Tournament: one pick (yours); the right panel previews that titan's ladder. */
  const ladder = (ctx: UICtx): boolean => ctx.setup.mode === 'ladder';
  const idx = (ctx: UICtx, id: string): number =>
    Math.max(
      0,
      ctx.deps.titans.findIndex((t) => t.id === id),
    );

  const move = (ctx: UICtx, s: 0 | 1, dx: number, dy: number): void => {
    const n = ctx.deps.titans.length;
    let i = cur[s];
    if (dx) i = (i + dx + n) % n;
    if (dy) i = gridStep(n, i, dy);
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
      best = {};
      if (ladder(ctx)) {
        // 우리 is the tournament's default highlight ("our Liu Kang"); any titan can be picked
        if (ctx.isTitanReady(LADDER_HUNTER)) cur[0] = idx(ctx, LADDER_HUNTER);
        best = loadLadder(resolveStore(ctx.deps.storage)).best;
      }
    },
    update(ctx) {
      if (advanceAt >= 0) {
        if (ctx.t >= advanceAt) {
          ctx.setup.p1 = ctx.deps.titans[cur[0]]!.id;
          advanceAt = -1;
          if (ladder(ctx)) {
            ctx.push('ladder', { start: ctx.setup.p1 });
            return;
          }
          ctx.setup.p2 = ctx.deps.titans[cur[1]]!.id;
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
        if (phase === 0 && !ladder(ctx)) phase = 1;
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
      const modeText = two(ctx)
        ? 'VERSUS'
        : ctx.setup.mode === 'vsai'
          ? 'VS AI'
          : ladder(ctx)
            ? 'TOURNAMENT'
            : 'TRAINING';
      header(ctx, 'SELECT TITAN', '타이탄 선택', modeText);

      drawSide(ctx, 0, cur[0], locked[0]);
      if (ladder(ctx)) drawLadderPreview(ctx, cur[0]);
      else drawSide(ctx, 1, cur[1], locked[1]);

      // roster grid
      const grid = gridOf(titans.length);
      const { cols, tile: TILE } = grid;
      titans.forEach((t, i) => {
        const { x, y } = grid.pos(i);
        const ready = ctx.isTitanReady(t.id);
        const ramp = accentRamp(t.accent);
        panel(cv, x, y, TILE, TILE, { fill: alpha(C.ink0, 0.85), border: C.line0, shade: false });
        const spr = portraitSprite(ctx, t.id, TILE - 8, false, ready ? 0 : 0.9);
        if (spr) cv.blit(spr, x + 4, y + 4);
        if (!ready) drawIcon(cv, 'lock', x + TILE - 10, y + TILE - 9, C.dim);
        const hovered0 = cur[0] === i;
        const hovered1 = cur[1] === i && !ladder(ctx);
        const b = best[t.id];
        if (b !== undefined) {
          // the best rung this titan reached in the tournament (a star once it cleared it)
          const label = b >= CLEARED ? '' : `${b}/${LADDER_RUNGS}`;
          const bw = b >= CLEARED ? 9 : measureText(label, { font: 'micro' }) + 4;
          cv.rect(x + 2, y + 2, bw, 9, alpha(C.void, 0.85));
          if (b >= CLEARED) drawIcon(cv, 'star', x + 4, y + 4, C.gold);
          else drawText(cv, label, x + 4, y + 4, { color: C.soft, font: 'micro' });
        }
        if (hovered0 || hovered1) {
          const pulse = Math.floor(ctx.t * 4) % 2;
          if (hovered0) cursor(ctx, x, y, TILE, SLOT_COL[0], locked[0], pulse, hovered1 ? 0 : 0);
          if (hovered1) cursor(ctx, x, y, TILE, SLOT_COL[1], locked[1], pulse, hovered0 ? 3 : 0);
        }
        void ramp;
        drawText(cv, t.name.replace('The ', '').toUpperCase(), x + TILE / 2, y + TILE + 3, {
          color: hovered0 || hovered1 ? C.white : C.dim,
          font: 'micro',
          align: 'center',
          // the narrower tiles of a big roster: tighter letters so neighbouring names do not run together
          tracking: cols === 3 ? 1 : 0,
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
      // the prompt closes the grid's block (gridOf keeps it clear of the names and inside the panels' height)
      drawText(cv, who, LOGICAL_W / 2, grid.promptY, {
        color: single && phase === 1 ? C.p2 : C.soft,
        align: 'center',
        tracking: 2,
      });
      if (grid.glossY !== null)
        drawText(
          cv,
          single ? (phase === 0 ? '타이탄 선택' : '상대 선택') : '타이탄 선택',
          LOGICAL_W / 2,
          grid.glossY,
          {
            color: C.celadonDeep,
            align: 'center',
          },
        );
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

  /** Tournament: the eight rungs the hovered titan would climb (top = the final boss), in the P2 panel's place. */
  function drawLadderPreview(ctx: UICtx, i: number): void {
    const cv = ctx.cv;
    const t = ctx.deps.titans[i]!;
    const x = LOGICAL_W - 8 - PANEL_W;
    panel(cv, x, PANEL_Y, PANEL_W, PANEL_H, { accent: C.gold, border: C.line1, fill: alpha(C.ink1, 0.9) });
    drawText(cv, 'THE LADDER', x + 10, PANEL_Y + 9, { color: C.gold, tracking: 2 });
    drawText(cv, '사다리', x + PANEL_W - 10, PANEL_Y + 9, { color: C.dim, align: 'right' });
    const rungs = ladderFor(t.id);
    const b = best[t.id] ?? 0;
    const rowH = 28;
    rungs
      .slice()
      .reverse()
      .forEach((r, k) => {
        const y = PANEL_Y + 28 + k * rowH;
        const info = ctx.titan(r.foe);
        const veiled = r.foe === 'mouth' && !ctx.isTitanReady('mouth');
        const reached = b >= r.n;
        const roleCol = r.role === 'final' ? C.danger : r.role === 'subboss' ? C.gold : C.line1;
        cv.rect(x + 8, y, PANEL_W - 16, rowH - 3, alpha(C.ink0, 0.7));
        cv.frame(x + 8, y, PANEL_W - 16, rowH - 3, r.role === 'fight' ? C.line0 : alpha(roleCol, 0.6));
        const spr = portraitSprite(ctx, r.foe, 21, false, veiled ? 1 : reached ? 0 : 0.5);
        if (spr) cv.blit(spr, x + 10, y + 2);
        drawText(cv, String(r.n), x + 40, y + 7, { color: C.line2, font: 'micro' });
        drawText(cv, veiled ? '???' : info.name.replace(/^The /, '').toUpperCase(), x + 50, y + 3, {
          color: reached ? C.text : C.mid,
          tracking: 1,
        });
        const tag = r.role === 'final' ? 'FINAL BOSS' : r.role === 'subboss' ? 'SUB-BOSS' : '';
        if (tag) drawText(cv, tag, x + 50, y + 16, { color: roleCol, font: 'micro', tracking: 1 });
        if (b > r.n) drawIcon(cv, 'check', x + PANEL_W - 18, y + 9, C.celadonDeep);
      });
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
