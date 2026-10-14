import { LOGICAL_W, type TitanId } from '@/contracts';
import { DIFFICULTY_LABELS } from '../labels';
import {
  CLEARED,
  DIFFICULTY_NAMES,
  LADDER_DIFFICULTIES,
  LADDER_FINAL,
  LADDER_HUNTER,
  LADDER_MODES,
  MODE_LABELS,
  aiRamp,
  classicFoes,
  cosmicCount,
  cosmicFoes,
  isNewTitan,
  loadLadder,
  runOf,
  saveLadder,
  type LadderDifficulty,
  type LadderMode,
  type LadderSave,
  type LadderTitan,
} from '../ladder';
import { drawCosmicBadge, drawCosmicWordmark } from '../pixel/cosmicLogo';
import { type PixelCanvas } from '../pixel/canvas';
import { C, accentRamp, alpha } from '../pixel/palette';
import { drawIcon, panel } from '../pixel/shapes';
import { drawText, measureText, wrapText } from '../pixel/text';
import { resolveStore } from '../settings';
import {
  backdrop,
  confirmBack,
  footer,
  header,
  ladderRosterOf,
  portraitSprite,
  scrim,
  settled,
  vignette,
  type Screen,
  type UICtx,
} from './kit';

/** What opens the tourney screen (dev / screenshots): which step to show. */
export interface TourneyParams {
  phase?: 'mode' | 'difficulty';
}

const CLASSIC_ACCENT = accentRamp('#ecc98a');
const COSMIC_ACCENT = accentRamp('#c070e0');
const accentOf = (m: LadderMode): ReturnType<typeof accentRamp> =>
  m === 'cosmic' ? COSMIC_ACCENT : CLASSIC_ACCENT;

const CARD_Y = 46;
const CARD_W = 296;
const CARD_H = 246;
const cardX = (i: number): number => (i === 0 ? 16 : LOGICAL_W - 16 - CARD_W);

const DIFF_NOTE: Record<LadderDifficulty, string> = {
  easy: 'The AI stays gentle: it never climbs past the middle level. The Mouth waits at the top as its normal self.',
  normal:
    'The tournament as it was built: the AI starts at the middle level and reaches the top near the end. The boss Mouth waits.',
  titan: 'No warm-up. The AI fights at the top level from the second rung on, and the boss Mouth waits.',
};

/** A small "NEW" tag (a newly shipped titan in the COSMIC CLASH lineup). Returns its width. */
export function drawNewTag(cv: PixelCanvas, x: number, y: number, t = 0): number {
  const w = measureText('NEW', { font: 'micro', tracking: 1 }) + 5;
  const on = Math.floor(t * 2) % 4 !== 0;
  cv.rect(x, y, w, 9, on ? C.danger : C.dangerDeep);
  cv.frame(x, y, w, 9, alpha(C.void, 0.8));
  drawText(cv, 'NEW', x + 3, y + 2, { color: C.white, font: 'micro', tracking: 1 });
  return w;
}

/**
 * TOURNAMENT, before the titan pick: first the MODE (CLASSIC, COSMIC CLASH with its living wordmark and titan count), then
 * the DIFFICULTY (EASY / NORMAL / TITAN, with the AI ramp it gives that ladder). Confirming resumes that mode and
 * difficulty's stored run on the tower, or goes on to pick a titan.
 */
export function createTourneyScreen(): Screen {
  let phase: 'mode' | 'difficulty' = 'mode';
  let mode = 0;
  let diff = 1;
  let save: LadderSave | null = null;

  const roster = (ctx: UICtx): LadderTitan[] => ladderRosterOf(ctx);
  const today = (ctx: UICtx): number => ctx.deps.today?.() ?? Date.now();
  /** The lineup 우리 would meet (the preview strips and the ramp's length). */
  const lineup = (ctx: UICtx, m: LadderMode): TitanId[] =>
    m === 'classic' ? classicFoes(LADDER_HUNTER) : cosmicFoes(LADDER_HUNTER, roster(ctx), 1);

  return {
    enter(ctx, params) {
      const p = (params ?? {}) as TourneyParams;
      save = loadLadder(resolveStore(ctx.deps.storage));
      mode = Math.max(0, LADDER_MODES.indexOf(ctx.setup.ladderMode));
      diff = Math.max(0, LADDER_DIFFICULTIES.indexOf(ctx.setup.ladderDifficulty));
      phase = p.phase ?? 'mode';
    },

    update(ctx) {
      const n = ctx.nav;
      if (!settled(ctx, 0.15)) return;
      if (phase === 'mode') {
        if (n.left || n.right || n.up || n.down) {
          mode = 1 - mode;
          ctx.sound('move');
        }
        if (n.back) {
          ctx.sound('back');
          ctx.pop();
        } else if (n.confirm) {
          ctx.sound('confirm');
          phase = 'difficulty';
        }
        return;
      }
      if (n.up || n.down) {
        diff = (diff + (n.up ? -1 : 1) + LADDER_DIFFICULTIES.length) % LADDER_DIFFICULTIES.length;
        ctx.sound('move');
      }
      if (n.back) {
        ctx.sound('back');
        phase = 'mode';
      } else if (n.confirm) {
        const m = LADDER_MODES[mode]!;
        const d = LADDER_DIFFICULTIES[diff]!;
        ctx.setup.ladderMode = m;
        ctx.setup.ladderDifficulty = d;
        const s = save ?? loadLadder(resolveStore(ctx.deps.storage));
        s.last = { mode: m, difficulty: d };
        saveLadder(resolveStore(ctx.deps.storage), s);
        ctx.sound('confirm');
        // a stored run resumes on the tower; otherwise pick a titan
        if (runOf(s, m, d)) ctx.push('ladder');
        else ctx.push('select');
      }
    },

    draw(ctx) {
      const cv = ctx.cv;
      backdrop(cv, 'bg:0.74:0.62:0.8:', (bg) => {
        scrim(bg, 0.74, 0.62, 0.8);
        vignette(bg);
      });
      if (phase === 'mode') {
        header(ctx, 'TOURNAMENT', '토너먼트', 'CHOOSE A MODE');
        LADDER_MODES.forEach((m, i) => drawModeCard(ctx, m, i, i === mode));
        footer(ctx, confirmBack(ctx, 'SELECT', 'BACK'));
      } else {
        const m = LADDER_MODES[mode]!;
        header(ctx, 'DIFFICULTY', '난이도', MODE_LABELS[m].en);
        drawDifficulty(ctx, m);
        footer(ctx, confirmBack(ctx, 'CONTINUE', 'BACK'));
      }
    },
  };

  function runNote(m: LadderMode): string {
    if (!save) return '';
    const parts = LADDER_DIFFICULTIES.filter((d) => runOf(save!, m, d)).map(
      (d) => `${DIFFICULTY_NAMES[d].en} RUNG ${runOf(save!, m, d)!.rung}`,
    );
    return parts.length ? `IN PROGRESS: ${parts.join(' · ')}` : '';
  }

  function clearedCount(m: LadderMode): number {
    return save ? Object.values(save.best[m]).filter((b) => (b ?? 0) >= CLEARED).length : 0;
  }

  function drawModeCard(ctx: UICtx, m: LadderMode, i: number, focus: boolean): void {
    const cv = ctx.cv;
    const x = cardX(i);
    const acc = accentOf(m);
    panel(cv, x, CARD_Y, CARD_W, CARD_H, {
      fill: alpha(focus ? C.ink2 : C.ink0, focus ? 0.94 : 0.75),
      border: focus ? acc.dim : C.line0,
      accent: focus ? acc.base : undefined,
    });
    if (focus) {
      const o = Math.floor(ctx.t * 4) % 2;
      cv.corners(x - 2 - o, CARD_Y - 2 - o, CARD_W + 4 + o * 2, CARD_H + 4 + o * 2, acc.light, 6);
    }
    const cx = x + CARD_W / 2;
    let y = CARD_Y + 12;
    if (m === 'cosmic') {
      drawCosmicWordmark(cv, cx, y - 4, focus ? ctx.t : 0.6);
      y += 32;
      drawText(cv, '우주 대결', cx, y, { color: focus ? acc.light : C.dim, align: 'center', tracking: 2 });
      y += 18;
      drawCosmicBadge(cv, cx, y, cosmicCount(roster(ctx)), ctx.t);
      y += 18;
    } else {
      drawText(cv, 'CLASSIC', cx, y + 2, {
        color: focus ? C.white : C.mid,
        scale: 2,
        tracking: 2,
        align: 'center',
        shadow: alpha(C.void, 0.85),
      });
      y += 32;
      drawText(cv, '클래식', cx, y, { color: focus ? acc.light : C.dim, align: 'center', tracking: 2 });
      y += 18;
      const tag = 'THE STORY LADDER';
      const tw = measureText(tag, { font: 'micro', tracking: 1 }) + 12;
      cv.rect(Math.round(cx - tw / 2), y, tw, 11, alpha(C.ink0, 0.9));
      cv.frame(Math.round(cx - tw / 2), y, tw, 11, alpha(acc.dim, 0.9));
      drawText(cv, tag, cx, y + 3, { color: C.soft, font: 'micro', align: 'center', tracking: 1 });
      y += 18;
    }
    // what it is
    const blurb =
      m === 'cosmic'
        ? 'Every titan there is, dealt in a new order each run. The Last One and the Mouth wait at the top. It grows with every titan that arrives.'
        : `The tournament as it was told: ${classicFoes(LADDER_HUNTER).length} rungs in a set order, from the stones to the Mouth.`;
    for (const l of wrapText(blurb, CARD_W - 28).slice(0, 4)) {
      drawText(cv, l, x + 14, y, { color: focus ? C.soft : C.dim });
      y += 13;
    }
    // the lineup, as portraits (the order for COSMIC CLASH is a shuffle: shown here in its catalogue order)
    const ids = m === 'classic' ? lineup(ctx, m) : cosmicPreview(ctx);
    const size = Math.min(22, Math.floor((CARD_W - 28 - (ids.length - 1) * 3) / ids.length));
    const rowW = ids.length * size + (ids.length - 1) * 3;
    const sy = CARD_Y + CARD_H - 62;
    let sx = Math.round(cx - rowW / 2);
    const now = today(ctx);
    const r = roster(ctx);
    for (const id of ids) {
      cv.rect(sx, sy, size, size, alpha(C.void, 0.55));
      const veiled = id === LADDER_FINAL && !ctx.isTitanReady(LADDER_FINAL);
      const spr = portraitSprite(ctx, id, size, false, veiled ? 1 : focus ? 0 : 0.6);
      if (spr) cv.blit(spr, sx, sy);
      if (
        m === 'cosmic' &&
        isNewTitan(
          r.find((t) => t.id === id),
          now,
        )
      )
        drawNewTag(cv, sx + size - 12, sy - 5, ctx.t);
      sx += size + 3;
    }
    const note = runNote(m);
    const cleared = clearedCount(m);
    drawText(
      cv,
      note || (cleared ? `CLEARED WITH ${cleared} TITAN${cleared > 1 ? 'S' : ''}` : 'NO RUN YET'),
      cx,
      sy + size + 10,
      {
        color: note ? acc.light : cleared ? C.gold : C.line2,
        font: 'micro',
        align: 'center',
        tracking: 1,
      },
    );
    drawText(cv, m === 'cosmic' ? 'ALWAYS GROWING' : 'NINE RUNGS', cx, sy + size + 22, {
      color: C.line2,
      font: 'micro',
      align: 'center',
      tracking: 1,
    });
  }

  /** COSMIC CLASH's card strip: the shipped titans in catalogue order, the Last One and the Mouth at the end. */
  function cosmicPreview(ctx: UICtx): TitanId[] {
    const r = roster(ctx).filter((t) => !t.wip);
    const ids = r
      .slice()
      .sort((a, b) => (a.catalogue ?? 999) - (b.catalogue ?? 999))
      .map((t) => t.id)
      .filter((id) => id !== 'colossus');
    return [...ids, ...(r.some((t) => t.id === 'colossus') ? (['colossus'] as TitanId[]) : []), LADDER_FINAL];
  }

  function drawDifficulty(ctx: UICtx, m: LadderMode): void {
    const cv = ctx.cv;
    const acc = accentOf(m);
    // the mode's emblem
    if (m === 'cosmic') {
      const r = drawCosmicWordmark(cv, 168, 44, ctx.t);
      drawCosmicBadge(cv, r.x + 6, 78, cosmicCount(roster(ctx)), ctx.t, 'left');
    } else {
      drawText(cv, 'CLASSIC', 40, 50, { color: C.white, scale: 2, tracking: 2, shadow: alpha(C.void, 0.85) });
      drawText(cv, '클래식', 40, 76, { color: acc.light, tracking: 1 });
    }
    // the three difficulties
    LADDER_DIFFICULTIES.forEach((d, i) => {
      const y = 112 + i * 34;
      const focus = i === diff;
      panel(cv, 40, y - 7, 232, 28, {
        fill: alpha(focus ? C.ink2 : C.ink0, focus ? 0.92 : 0.55),
        border: focus ? acc.dim : C.line0,
        accent: focus ? acc.base : undefined,
        shade: false,
      });
      if (focus) drawIcon(cv, 'chevron', 46, y + 3, acc.base);
      drawText(cv, DIFFICULTY_NAMES[d].en, 58, y - 1, { color: focus ? C.white : C.mid, tracking: 2 });
      drawText(cv, DIFFICULTY_NAMES[d].ko, 256, y - 1, { color: focus ? acc.light : C.dim, align: 'right' });
      if (save && runOf(save, m, d))
        drawText(cv, `RUN AT RUNG ${runOf(save, m, d)!.rung}`, 58, y + 11, {
          color: acc.light,
          font: 'micro',
          tracking: 1,
        });
    });
    // the detail: what it means, and the AI ramp across this mode's rungs
    const d = LADDER_DIFFICULTIES[diff]!;
    const px = 296;
    panel(cv, px, 104, 316, 196, { accent: acc.dim });
    drawText(cv, DIFFICULTY_NAMES[d].en, px + 16, 116, {
      color: C.white,
      scale: 2,
      tracking: 2,
      shadow: alpha(C.void, 0.85),
    });
    drawText(cv, DIFFICULTY_NAMES[d].ko, px + 300, 122, { color: acc.light, align: 'right' });
    let y = 146;
    for (const l of wrapText(DIFF_NOTE[d], 284)) {
      drawText(cv, l, px + 16, y, { color: C.soft });
      y += 13;
    }
    const foes = lineup(ctx, m);
    const ramp = aiRamp(d, foes.length);
    drawText(cv, 'AI LEVEL PER RUNG', px + 16, 206, { color: C.dim, font: 'micro', tracking: 1 });
    const bw = Math.max(4, Math.min(20, Math.floor((284 - (foes.length - 1) * 3) / foes.length)));
    ramp.forEach((lvl, k) => {
      const bx = px + 16 + k * (bw + 3);
      const h = lvl * 9;
      const top = k === ramp.length - 1;
      cv.rect(bx, 270 - 54, bw, 54, alpha(C.ink0, 0.8));
      cv.rect(bx, 270 - h, bw, h, top ? C.danger : k === ramp.length - 2 ? C.gold : acc.base);
      cv.hline(bx, 270 - h, bw, top ? C.white : acc.glow);
      drawText(cv, String(lvl), bx + bw / 2, 274, { color: C.mid, font: 'micro', align: 'center' });
    });
    const lab = DIFFICULTY_LABELS[ramp[ramp.length - 1]! - 1]!;
    drawText(
      cv,
      `${foes.length} RUNGS · TOP ${lab.name.toUpperCase()} · ${d === 'easy' ? 'THE MOUTH' : 'THE BOSS MOUTH'}`,
      px + 16,
      286,
      { color: C.line2, font: 'micro', tracking: 1 },
    );
  }
}
