import { LOGICAL_W, ROUNDS_TO_WIN, type MatchConfig, type TitanId } from '@/contracts';
import { DIFFICULTY_LABELS } from '../labels';
import {
  CLEARED,
  DIFFICULTY_NAMES,
  LADDER_FINAL,
  MODE_LABELS,
  abandonRun,
  emptyLadder,
  isNewTitan,
  loadLadder,
  recordLoss,
  recordWin,
  runOf,
  runRungs,
  saveLadder,
  startRun,
  type LadderDifficulty,
  type LadderMode,
  type LadderRun,
  type LadderSave,
  type Rung,
} from '../ladder';
import { ENDING_LINES, MOUTH_ENDING_LINES, storyCard, type StoryTone } from '../ladderStory';
import { drawNewTag } from './tourney';
import { PixelCanvas, type Sprite } from '../pixel/canvas';
import { C, accentRamp, alpha } from '../pixel/palette';
import { drawIcon, panel, pips } from '../pixel/shapes';
import { drawText, measureText, wrapText } from '../pixel/text';
import { resolveStore } from '../settings';
import {
  Menu,
  backdrop,
  footer,
  header,
  portraitSprite,
  drawTitanPortrait,
  ladderRosterOf,
  promptLabels,
  scrim,
  settled,
  vignette,
  type MenuItem,
  type Screen,
  type UICtx,
} from './kit';

/** What opens the ladder screen. No params = resume the stored run (or go pick a titan when there is none). */
export interface LadderParams {
  /** A fresh run for this titan (from the select). */
  start?: TitanId;
  /** COSMIC CLASH: the seed of that run's shuffle (the select previews the lineup it deals). */
  seed?: number;
  /** The fight that just ended (the runtime routes a tournament match's end here instead of the results screen). */
  result?: 'win' | 'lose';
  /** Dev flag `?ladder=N`: a run for `player` at rung N (persisted, like a real run). */
  dev?: { player: TitanId; rung: number };
  /** Which view to open (dev / screenshots): the tower (default), a story card, the defeat menu, the ending. */
  view?: 'tower' | 'card' | 'lose' | 'ending';
  /** Dev: the ending as `player`, with the unlock message (nothing is unlocked by viewing it). */
  ending?: { player: TitanId; unlocked: boolean };
}

type View = 'tower' | 'card' | 'lose' | 'ending' | 'empty';

const TONE: Record<StoryTone, number> = { white: C.text, gold: C.gold, red: C.danger };
const ACCENT = accentRamp('#a8bdb2');

/*
 * tower geometry: rung 1 at the bottom, the final boss on top. Eight rungs fit 34 px rows; a taller tower (CLASSIC's nine,
 * a growing COSMIC CLASH) shrinks its rows to fit between the header and the plinth, and narrows its taper.
 */
const TX = 314;
const BASE = 321;
const TOWER_TOP = 42;
let ROW = 34;
let RUNG_H = 32;
let TAPER = 8;
function towerFor(n: number): void {
  ROW = Math.min(34, Math.floor((BASE - TOWER_TOP) / Math.max(1, n)));
  RUNG_H = ROW - 2;
  TAPER = n > 1 ? Math.min(8, Math.floor(80 / (n - 1))) : 8;
}
const rungW = (i: number): number => 198 - i * TAPER;
const rungTop = (i: number): number => BASE - (i + 1) * ROW + 2;
/** Room for a second line (RUNG n, the boss tag) under the name. */
const twoLines = (): boolean => RUNG_H >= 28;
const LEFT_X = 14;
const LEFT_W = 158;
const RIGHT_X = 428;
const RIGHT_W = 198;
const PANEL_Y = 44;
const PANEL_H = 278;
/** Seconds: the beaten rung cracks, then the player's marker climbs. */
const CRACK_SEC = 0.45;
const CLIMB_SEC = 0.8;

/**
 * The tournament ladder: a vertical pixel tower of portraits (the current rung lit, beaten rungs dimmed and cracked), a
 * one-line story card before each fight, CONTINUE / QUIT after a defeat, and the ending (which unlocks the Mouth). Progress
 * lives in localStorage (src/ui/ladder.ts), so a closed tab resumes at the current rung.
 */
export function createLadderScreen(): Screen {
  let save: LadderSave = emptyLadder();
  let view: View = 'tower';
  let menu = new Menu([]);
  /** Rung index (0-based) the player just climbed from, while the climb plays; -1 = none. */
  let climbFrom = -1;
  let viewAt = 0;
  let ending: { player: TitanId; unlocked: boolean } | null = null;
  /** The tournament on screen (set from the setup on enter). */
  let mode: LadderMode = 'classic';
  let diff: LadderDifficulty = 'normal';
  let roster: ReturnType<typeof ladderRosterOf> = [];
  /** Cached rungs of the stored run (rebuilt when the run changes). */
  let cache: { run: LadderRun; rung: Rung[] } | null = null;

  const persist = (ctx: UICtx): void => saveLadder(resolveStore(ctx.deps.storage), save);
  const run = (): LadderRun | null => runOf(save, mode, diff);
  const rungs = (): Rung[] => {
    const r = run();
    if (!r) return [];
    if (cache?.run !== r) cache = { run: r, rung: runRungs(r, mode, diff, roster) };
    return cache.rung;
  };
  const current = (): Rung | null => {
    const r = run();
    return r ? (rungs()[r.rung - 1] ?? null) : null;
  };
  const total = (): number => rungs().length;

  const setView = (ctx: UICtx, v: View): void => {
    view = v;
    viewAt = ctx.t;
    const items: MenuItem[] =
      v === 'lose'
        ? [
            { id: 'continue', en: 'CONTINUE', ko: '계속' },
            { id: 'quit', en: 'QUIT', ko: '포기' },
          ]
        : [
            { id: 'fight', en: 'FIGHT', ko: '도전' },
            { id: 'new', en: 'NEW RUN', ko: '처음부터' },
            { id: 'quit', en: 'QUIT', ko: '나가기' },
          ];
    menu = new Menu(items);
  };

  const quit = (ctx: UICtx): void => {
    ctx.emit({ type: 'quitToTitle' });
    ctx.go('title');
  };

  const newSeed = (ctx: UICtx): number =>
    ctx.deps.newSeed?.() ?? ((ctx.deps.now?.() ?? Date.now()) * 1000) & 0x7fffffff;

  const fight = (ctx: UICtx): void => {
    const r = run();
    const rung = current();
    if (!r || !rung) return;
    const seed = newSeed(ctx);
    const config: MatchConfig = {
      seed: seed || 1,
      stage: ctx.isStageReady(rung.stage) ? rung.stage : ctx.setup.stage,
      mode: 'vsai',
      slots: [
        { titan: r.player, controller: 'human' },
        { titan: rung.foe, controller: 'ai', aiLevel: rung.aiLevel, ...(rung.boss ? { boss: true } : {}) },
      ],
    };
    ctx.sound('start');
    ctx.emit({ type: 'startMatch', config });
  };

  return {
    enter(ctx, params) {
      const p = (params ?? {}) as LadderParams;
      save = loadLadder(resolveStore(ctx.deps.storage));
      mode = ctx.setup.ladderMode;
      diff = ctx.setup.ladderDifficulty;
      roster = ladderRosterOf(ctx);
      cache = null;
      climbFrom = -1;
      ending = null;
      ctx.setup.mode = 'ladder';
      if (p.ending) {
        ending = p.ending;
        setView(ctx, 'ending');
        return;
      }
      const opts = { mode, difficulty: diff, roster };
      if (p.start) {
        startRun(save, p.start, { ...opts, seed: p.seed ?? newSeed(ctx) });
        persist(ctx);
      } else if (p.dev) {
        startRun(save, p.dev.player, { ...opts, rung: p.dev.rung, seed: p.seed ?? 1 });
        persist(ctx);
      } else if (p.result === 'win') {
        const before = run();
        const last = rungs()[rungs().length - 1];
        const r = recordWin(save, mode, diff, roster);
        persist(ctx);
        if (r === 'cleared' && before) {
          // beating either mode's final boss (the Mouth) unlocks it
          const unlock = last?.foe === LADDER_FINAL ? LADDER_FINAL : null;
          ending = { player: before.player, unlocked: unlock ? ctx.unlockTitan(unlock) : false };
          ctx.sound('roundwin');
          setView(ctx, 'ending');
          return;
        }
        if (r === 'next') {
          climbFrom = run()!.rung - 2;
          ctx.sound('roundwin');
        }
      } else if (p.result === 'lose') {
        recordLoss(save, mode, diff);
        persist(ctx);
        setView(ctx, run() ? 'lose' : 'empty');
        return;
      }
      const r = run();
      if (r) ctx.setup.p1 = r.player;
      setView(ctx, !r ? 'empty' : p.view === 'card' || p.view === 'lose' ? p.view : 'tower');
    },

    update(ctx) {
      const n = ctx.nav;
      if (view === 'empty') {
        // nothing stored: pick a titan
        ctx.go('select');
        return;
      }
      if (view === 'ending') {
        if (ctx.screenTime > 1.5 && settled(ctx, 1.5) && (n.confirm || n.start)) {
          ctx.sound('confirm');
          quit(ctx);
        }
        return;
      }
      if (view === 'card') {
        if (!settled(ctx, 0.4) || ctx.t - viewAt < 0.4) return;
        if (n.back) {
          ctx.sound('back');
          setView(ctx, 'tower');
        } else if (n.confirm || n.start) {
          // the first press finishes the line, the next one starts the fight
          if (cardReveal(ctx) < 1) viewAt -= 10;
          else fight(ctx);
        }
        return;
      }
      // the tower (and the defeat menu): no input while the beaten rung cracks and the marker climbs
      if (climbFrom >= 0 && ctx.t - viewAt < CRACK_SEC + CLIMB_SEC) return;
      if (!settled(ctx, 0.5)) return;
      if (menu.step(n)) ctx.sound('move');
      if (n.back) {
        ctx.sound('back');
        quit(ctx);
        return;
      }
      if (!n.confirm) return;
      ctx.sound('confirm');
      switch (menu.current.id) {
        case 'fight':
          climbFrom = -1;
          setView(ctx, 'card');
          break;
        case 'continue':
          fight(ctx);
          break;
        case 'new':
          abandonRun(save, mode, diff);
          persist(ctx);
          ctx.go('title');
          ctx.push('select');
          break;
        case 'quit':
          quit(ctx);
          break;
      }
    },

    draw(ctx) {
      const cv = ctx.cv;
      if (view === 'card') {
        drawCard(ctx);
        return;
      }
      if (view === 'ending') {
        drawEnding(ctx);
        return;
      }
      backdrop(cv, 'bg:0.8:0.7:0.86:', (bg) => {
        scrim(bg, 0.8, 0.7, 0.86);
        vignette(bg);
      });
      const r = run();
      header(
        ctx,
        'TOURNAMENT',
        '토너먼트',
        `${MODE_LABELS[mode].en} · ${DIFFICULTY_NAMES[diff].en}${r ? `  RUNG ${r.rung} / ${total()}` : ''}`,
      );
      if (!r) return;
      towerFor(total());
      drawTower(ctx);
      drawPlayer(ctx);
      drawNext(ctx);
      const p = promptLabels(ctx);
      footer(ctx, [
        { chip: p.confirm, text: 'SELECT' },
        { chip: p.back, text: 'QUIT' },
      ]);
    },
  };

  /* ---------------------------------------------------------------------------------------------- */
  function cardReveal(ctx: UICtx): number {
    const r = current();
    if (!r) return 1;
    const len = Array.from(storyCard(r).text).length;
    return Math.min(1, Math.max(0, ((ctx.t - viewAt - 0.35) * 30) / len));
  }

  /** The rung's state on the tower: beaten (below the player), current, or still ahead. */
  function stateOf(i: number): 'beaten' | 'current' | 'ahead' {
    const at = (run()?.rung ?? 1) - 1;
    return i < at ? 'beaten' : i === at ? 'current' : 'ahead';
  }

  /** The Mouth stays a red silhouette ("???") on the tower until the player reaches it or has unlocked it. */
  function hidden(ctx: UICtx, r: Rung, i: number): boolean {
    return r.foe === 'mouth' && stateOf(i) === 'ahead' && !ctx.isTitanReady('mouth');
  }

  function drawTower(ctx: UICtx): void {
    const cv = ctx.cv;
    const list = rungs();
    // plinth and spine
    cv.rect(TX - rungW(0) / 2 - 6, BASE + 1, rungW(0) + 12, 3, alpha(C.line1, 0.9));
    cv.hline(TX - rungW(0) / 2 - 10, BASE + 4, rungW(0) + 20, alpha(C.line0, 0.9));
    const since = ctx.t - viewAt;
    list.forEach((r, i) => {
      const st = stateOf(i);
      // the rung just beaten cracks in; the others already are
      const crack = st !== 'beaten' ? 0 : i === climbFrom ? Math.min(1, since / CRACK_SEC) : 1;
      drawRung(ctx, r, i, st, crack);
    });
    // the player's marker: climbs from the beaten rung to the current one
    const at = run()!.rung - 1;
    let y = rungTop(at);
    let x = TX - rungW(at) / 2;
    if (climbFrom >= 0) {
      const k = Math.min(1, Math.max(0, (since - CRACK_SEC) / CLIMB_SEC));
      const e = k * k * (3 - 2 * k);
      y = Math.round(rungTop(climbFrom) + (rungTop(at) - rungTop(climbFrom)) * e);
      x = Math.round(TX - rungW(climbFrom) / 2 + ((rungW(climbFrom) - rungW(at)) / 2) * e);
    }
    const ms = Math.min(26, RUNG_H - 4);
    const mx = x - ms - 6;
    const my = y + Math.floor((RUNG_H - ms) / 2);
    const pulse = Math.floor(ctx.t * 3) % 2;
    cv.rect(mx - 1, my, ms, ms, alpha(C.ink0, 0.9));
    cv.frame(mx - 1, my, ms, ms, C.p1);
    const spr = portraitSprite(ctx, run()!.player, ms - 4);
    if (spr) cv.blit(spr, mx + 1, my + 2);
    drawIcon(cv, 'chevron', x - 5 + pulse, y + Math.floor(RUNG_H / 2) - 4, C.p1);
  }

  function drawRung(ctx: UICtx, r: Rung, i: number, st: 'beaten' | 'current' | 'ahead', crack: number): void {
    const cv = ctx.cv;
    const w = rungW(i);
    const x = Math.round(TX - w / 2);
    const y = rungTop(i);
    const info = ctx.titan(r.foe);
    const ramp = accentRamp(info.accent);
    const veil = hidden(ctx, r, i);
    const roleCol = r.role === 'final' ? C.danger : r.role === 'subboss' ? C.gold : C.line1;
    const fill =
      st === 'beaten' ? alpha(C.ink0, 0.94) : st === 'current' ? alpha(C.ink2, 0.97) : alpha(C.ink1, 0.9);
    cv.rect(x, y, w, RUNG_H, fill);
    // stone courses: a mortar line and staggered joints, faint enough to read text over
    const mortar = alpha(C.void, st === 'beaten' ? 0.5 : 0.32);
    const half = Math.floor(RUNG_H / 2);
    cv.hline(x + 1, y + half, w - 2, mortar);
    for (let jx = x + (i % 2 ? 14 : 26); jx < x + w - 4; jx += 26) {
      cv.vline(jx, y + 1, half - 1, mortar);
      cv.vline(jx + 13, y + half + 1, RUNG_H - half - 2, mortar);
    }
    if (st === 'current') {
      const glow = 0.1 + 0.06 * Math.sin(ctx.t * 4);
      cv.rect(x + 1, y + 1, w - 2, RUNG_H - 2, alpha(ramp.base, glow));
    }
    const border =
      st === 'current'
        ? ramp.light
        : st === 'beaten'
          ? C.line0
          : r.role === 'fight'
            ? C.line1
            : alpha(roleCol, 0.7);
    cv.frame(x, y, w, RUNG_H, border);
    if (r.role === 'final') {
      // jaw teeth along the top of the final rung
      for (let tx = x + 4; tx < x + w - 4; tx += 8) {
        cv.px(tx, y - 1, alpha(roleCol, st === 'beaten' ? 0.4 : 0.85));
        cv.hline(tx - 1, y - 0, 3, alpha(roleCol, st === 'beaten' ? 0.4 : 0.85));
      }
    }
    // portrait
    const ps = Math.min(26, RUNG_H - 6);
    cv.rect(x + 3, y + 3, ps, ps, alpha(C.void, 0.6));
    if (veil) {
      const sil = silhouette(ctx, r.foe, ps);
      if (sil) cv.blit(sil, x + 3, y + 3);
    } else {
      const spr = portraitSprite(ctx, r.foe, ps, false, st === 'beaten' ? 0.92 : st === 'ahead' ? 0.55 : 0);
      if (spr) cv.blit(spr, x + 3, y + 3);
    }
    // name + Korean
    const nameCol = st === 'current' ? C.white : st === 'beaten' ? C.line2 : C.mid;
    const name = veil ? '???' : info.name.replace(/^The /, '').toUpperCase();
    const tx = x + ps + 8;
    const two = twoLines();
    const nameY = two ? y + 5 : y + Math.floor((RUNG_H - 10) / 2);
    const nw = drawText(cv, name, tx, nameY, { color: nameCol, tracking: 1 });
    // COSMIC CLASH: a newly shipped titan wears NEW (not while it is still a veiled silhouette)
    const fresh =
      mode === 'cosmic' &&
      !veil &&
      isNewTitan(
        roster.find((t) => t.id === r.foe),
        ctx.deps.today?.() ?? Date.now(),
      );
    const newW = fresh ? drawNewTag(cv, tx + nw + 4, nameY + 1, ctx.t) + 4 : 0;
    const ko = veil || info.nameKo === info.name ? '' : info.nameKo;
    const kw = measureText(ko);
    if (ko && tx + nw + newW + 8 + kw <= x + w - 6)
      drawText(cv, ko, x + w - 6, nameY - 1, {
        color: st === 'current' ? ramp.light : st === 'beaten' ? C.line1 : C.dim,
        align: 'right',
      });
    const tag = r.role === 'final' ? 'FINAL BOSS' : r.role === 'subboss' ? 'SUB-BOSS' : '';
    if (two) {
      const ly = y + RUNG_H - 11;
      drawText(cv, `RUNG ${r.n}`, tx, ly, {
        color: st === 'current' ? C.soft : C.line2,
        font: 'micro',
        tracking: 1,
      });
      if (tag)
        drawText(cv, tag, tx + 40, ly, {
          color: st === 'beaten' ? C.line2 : roleCol,
          font: 'micro',
          tracking: 1,
        });
    }
    if (st === 'beaten') drawIcon(cv, 'check', x + w - 11, y + RUNG_H - 12, C.celadonDeep);
    if (st === 'current') {
      const o = Math.floor(ctx.t * 4) % 2;
      cv.corners(x - 2 - o, y - 2 - o, w + 4 + o * 2, RUNG_H + 4 + o * 2, ramp.light, 5);
    }
    if (crack > 0) drawCrack(ctx, x, y, w, i, crack);
  }

  /** A jagged fissure down a beaten rung, drawn in segment by segment (`k` 0..1). */
  function drawCrack(ctx: UICtx, x: number, y: number, w: number, i: number, k: number): void {
    const cv = ctx.cv;
    const h = (n: number): number => {
      let v = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
      v ^= v >>> 13;
      v = Math.imul(v, 0xc2b2ae35);
      return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
    };
    const steps = 6;
    let px = x + Math.round(w * (0.42 + 0.3 * h(i * 7 + 1)));
    let py = y;
    const shown = Math.ceil(steps * k);
    for (let s = 0; s < shown; s++) {
      const nx = px + Math.round((h(i * 31 + s * 5) - 0.5) * 12);
      const ny = y + Math.round(((s + 1) * RUNG_H) / steps);
      line(cv, px, py, nx, ny, alpha(C.void, 0.95), alpha(C.line2, 0.55));
      // a short branch halfway down
      if (s === 2) line(cv, nx, ny, nx + (h(i + 99) > 0.5 ? 9 : -9), ny + 4, alpha(C.void, 0.9), 0);
      px = nx;
      py = ny;
    }
  }

  function line(
    cv: PixelCanvas,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    c: number,
    lit: number,
  ): void {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let s = 0; s <= n; s++) {
      const lx = Math.round(x0 + ((x1 - x0) * s) / n);
      const ly = Math.round(y0 + ((y1 - y0) * s) / n);
      cv.px(lx, ly, c);
      if (lit) cv.px(lx + 1, ly, lit);
    }
  }

  function drawPlayer(ctx: UICtx): void {
    const cv = ctx.cv;
    const run = runOf(save, mode, diff)!;
    const n = total();
    const info = ctx.titan(run.player);
    const ramp = accentRamp(info.accent);
    panel(cv, LEFT_X, PANEL_Y, LEFT_W, PANEL_H, { accent: C.p1, border: C.line1 });
    cv.rect(LEFT_X + 8, PANEL_Y + 8, 22, 12, alpha(C.p1, 0.25));
    drawText(cv, 'P1', LEFT_X + 19, PANEL_Y + 9, { color: C.p1, font: 'micro', align: 'center' });
    drawText(cv, 'CHALLENGER', LEFT_X + 36, PANEL_Y + 11, { color: C.dim, font: 'micro', tracking: 1 });
    const ps = 84;
    const px = LEFT_X + (LEFT_W - ps) / 2;
    cv.rect(px - 2, PANEL_Y + 26, ps + 4, ps + 4, alpha(C.ink0, 0.75));
    cv.frame(px - 2, PANEL_Y + 26, ps + 4, ps + 4, C.line0);
    drawTitanPortrait(ctx, run.player, px, PANEL_Y + 28, ps);
    const cx = LEFT_X + LEFT_W / 2;
    drawText(cv, info.name.toUpperCase(), cx, PANEL_Y + 122, {
      color: C.white,
      align: 'center',
      tracking: 1,
      shadow: alpha(C.void, 0.85),
    });
    if (info.nameKo !== info.name)
      drawText(cv, info.nameKo, cx, PANEL_Y + 136, { color: ramp.light, align: 'center' });
    cv.hline(LEFT_X + 12, PANEL_Y + 156, LEFT_W - 24, C.line0);
    const best = save.best[mode][run.player] ?? run.rung;
    const rows: [string, string][] = [
      ['RUNG', `${run.rung} / ${n}`],
      ['DEFEATS', String(run.continues)],
      ['BEST', best >= CLEARED ? 'CLEARED' : `RUNG ${best}`],
    ];
    rows.forEach(([k, v], j) => {
      const y = PANEL_Y + 166 + j * 16;
      drawText(cv, k, LEFT_X + 14, y + 2, { color: C.dim, font: 'micro', tracking: 1 });
      drawText(cv, v, LEFT_X + LEFT_W - 14, y, {
        color: k === 'BEST' && best >= CLEARED ? C.gold : C.text,
        align: 'right',
      });
    });
    // one pip per rung; a long COSMIC CLASH packs them tighter
    const gap = Math.max(1, Math.min(3, Math.floor((LEFT_W - 20) / n) - 5));
    pips(
      cv,
      LEFT_X + Math.round((LEFT_W - (n * (5 + gap) - gap)) / 2),
      PANEL_Y + 228,
      n,
      run.rung - 1,
      C.p1,
      C.line1,
      gap,
    );
    drawText(cv, `${n} TITANS  BEST OF ${ROUNDS_TO_WIN * 2 - 1}`, cx, PANEL_Y + 246, {
      color: C.line2,
      font: 'micro',
      align: 'center',
      tracking: 1,
    });
  }

  function drawNext(ctx: UICtx): void {
    const cv = ctx.cv;
    const r = current()!;
    const info = ctx.titan(r.foe);
    const ramp = accentRamp(info.accent);
    const lost = view === 'lose';
    const x = RIGHT_X;
    panel(cv, x, PANEL_Y, RIGHT_W, PANEL_H, {
      accent: lost ? C.danger : ramp.base,
      border: lost ? C.dangerDeep : C.line1,
    });
    drawText(cv, lost ? 'DEFEATED' : 'NEXT', x + 12, PANEL_Y + 9, {
      color: lost ? C.danger : C.soft,
      tracking: 2,
    });
    const hw = measureText(lost ? 'DEFEATED' : 'NEXT', { tracking: 2 });
    drawText(cv, lost ? '패배' : '다음 상대', x + 12 + hw + 8, PANEL_Y + 9, {
      color: lost ? C.dangerDeep : C.celadonDeep,
    });
    if (r.role !== 'fight') {
      const tag = r.role === 'final' ? 'FINAL BOSS' : 'SUB-BOSS';
      const tw = measureText(tag, { font: 'micro', tracking: 1 }) + 8;
      const col = r.role === 'final' ? C.danger : C.gold;
      cv.rect(x + RIGHT_W - 12 - tw, PANEL_Y + 10, tw, 10, alpha(col, 0.22));
      cv.frame(x + RIGHT_W - 12 - tw, PANEL_Y + 10, tw, 10, col);
      drawText(cv, tag, x + RIGHT_W - 8 - tw, PANEL_Y + 12, { color: col, font: 'micro', tracking: 1 });
    }
    // the opponent
    const ps = 64;
    cv.rect(x + 10, PANEL_Y + 28, ps + 4, ps + 4, alpha(C.ink0, 0.75));
    cv.frame(x + 10, PANEL_Y + 28, ps + 4, ps + 4, lost ? C.dangerDeep : ramp.dim);
    drawTitanPortrait(ctx, r.foe, x + 12, PANEL_Y + 30, ps, { flip: true, phase: 1.3 });
    const ix = x + 84;
    drawText(cv, info.name.replace(/^The /, '').toUpperCase(), ix, PANEL_Y + 32, {
      color: C.white,
      tracking: 1,
      shadow: alpha(C.void, 0.85),
    });
    if (info.nameKo !== info.name) drawText(cv, info.nameKo, ix, PANEL_Y + 46, { color: ramp.light });
    let ey = PANEL_Y + 64;
    for (const l of wrapText(info.epithet.toUpperCase(), RIGHT_W - 96, { font: 'micro', tracking: 1 }).slice(
      0,
      3,
    )) {
      drawText(cv, l, ix, ey, { color: C.dim, font: 'micro', tracking: 1 });
      ey += 7;
    }
    // where and how hard
    const stage = ctx.deps.stages.find((s) => s.id === r.stage);
    const sy = PANEL_Y + 104;
    cv.hline(x + 12, sy - 4, RIGHT_W - 24, C.line0);
    drawText(cv, 'STAGE', x + 12, sy + 2, { color: C.dim, font: 'micro', tracking: 1 });
    drawText(cv, (stage?.name ?? r.stage).toUpperCase(), x + 52, sy, { color: C.text, font: 'body' });
    if (stage) drawText(cv, stage.nameKo, x + 52, sy + 14, { color: C.dim });
    const lab = DIFFICULTY_LABELS[r.aiLevel - 1]!;
    drawText(cv, 'AI', x + 12, sy + 36, { color: C.dim, font: 'micro', tracking: 1 });
    drawText(cv, `${lab.level}  ${lab.name.toUpperCase()}`, x + 52, sy + 34, { color: C.text });
    drawText(cv, lab.nameKo, x + RIGHT_W - 12, sy + 34, { color: C.dim, align: 'right' });
    pips(cv, x + 52, sy + 50, 6, r.aiLevel, lost ? C.danger : ramp.light, C.line1, 4);
    // the menu
    const my = PANEL_Y + 182;
    menu.items.forEach((it, j) => {
      const y = my + j * 24;
      const focus = j === menu.index;
      const acc = lost ? accentRamp('#e0705f') : ACCENT;
      panel(cv, x + 10, y - 5, RIGHT_W - 20, 20, {
        fill: alpha(focus ? C.ink3 : C.ink0, focus ? 0.95 : 0.6),
        border: focus ? acc.dim : C.line0,
        accent: focus ? acc.base : undefined,
        shade: false,
      });
      if (focus) drawIcon(cv, 'chevron', x + 16, y + 1, acc.base);
      drawText(cv, it.en, x + 26, y, { color: focus ? C.white : C.mid, tracking: 1 });
      if (it.ko)
        drawText(cv, it.ko, x + RIGHT_W - 16, y - 1, { color: focus ? acc.light : C.dim, align: 'right' });
    });
  }

  function drawCard(ctx: UICtx): void {
    const cv = ctx.cv;
    const r = current();
    backdrop(cv, 'bg:card', (bg) => {
      scrim(bg, 0.95, 0.9, 0.95);
      vignette(bg, 1.4);
    });
    if (!r) return;
    const card = storyCard(r);
    const col = TONE[card.tone];
    const cx = LOGICAL_W / 2;
    const roleCol = r.role === 'final' ? C.danger : r.role === 'subboss' ? C.gold : C.dim;
    drawText(cv, `${MODE_LABELS[mode].en}  ·  RUNG ${r.n} / ${total()}`, cx, 54, {
      color: roleCol,
      font: 'micro',
      align: 'center',
      tracking: 2,
    });
    if (r.role !== 'fight')
      drawText(cv, r.role === 'final' ? 'FINAL BOSS  최종 보스' : 'SUB-BOSS  중간 보스', cx, 66, {
        color: roleCol,
        align: 'center',
        tracking: 1,
      });
    // the line, typed out
    const chars = Array.from(card.text);
    const shown = chars.slice(0, Math.floor(cardReveal(ctx) * chars.length)).join('');
    let scale = 2;
    let lines = wrapText(card.text, 600, { scale, tracking: 1 });
    if (lines.length > 2) {
      scale = 1;
      lines = wrapText(card.text, 600, { tracking: 1 });
    }
    const lh = scale === 2 ? 28 : 14;
    let y = 120 - ((lines.length - 1) * lh) / 2;
    let left = shown.length;
    for (const l of lines) {
      const part = Array.from(l).slice(0, Math.max(0, left)).join('');
      left -= Array.from(l).length + 1;
      const full = measureText(l, { scale, tracking: 1 });
      drawText(cv, part, Math.round(cx - full / 2), y, {
        color: col,
        scale,
        tracking: 1,
        shadow: alpha(C.void, 0.9),
      });
      y += lh;
    }
    // the opponent
    const info = ctx.titan(r.foe);
    const ramp = accentRamp(info.accent);
    const ps = 64;
    const k = Math.min(1, Math.max(0, (ctx.t - viewAt - 0.2) / 0.6));
    drawTitanPortrait(ctx, r.foe, cx - ps / 2, 178, ps, { grey: k < 1 ? 0.6 : 0, phase: 0.4 });
    drawText(cv, info.name.toUpperCase(), cx, 250, {
      color: C.white,
      align: 'center',
      tracking: 2,
      outline: C.void,
    });
    if (info.nameKo !== info.name) drawText(cv, info.nameKo, cx, 264, { color: ramp.light, align: 'center' });
    const stage = ctx.deps.stages.find((s) => s.id === r.stage);
    if (stage)
      drawText(cv, stage.name.toUpperCase(), cx, 284, {
        color: C.dim,
        font: 'micro',
        align: 'center',
        tracking: 1,
      });
    const p = promptLabels(ctx);
    footer(ctx, [
      { chip: p.confirm, text: 'FIGHT' },
      { chip: p.back, text: 'BACK' },
    ]);
  }

  function drawEnding(ctx: UICtx): void {
    const cv = ctx.cv;
    backdrop(cv, 'bg:card', (bg) => {
      scrim(bg, 0.95, 0.9, 0.95);
      vignette(bg, 1.4);
    });
    const e = ending!;
    const t = ctx.t - viewAt;
    const cx = LOGICAL_W / 2;
    const lines = e.player === 'mouth' ? MOUTH_ENDING_LINES : ENDING_LINES;
    lines.forEach((l, j) => {
      const at = 0.4 + j * 1.4;
      if (t < at) return;
      const chars = Array.from(l.text);
      const n = Math.min(chars.length, Math.floor((t - at) * 28));
      const full = measureText(l.text, { scale: 2, tracking: 1 });
      drawText(cv, chars.slice(0, n).join(''), Math.round(cx - full / 2), 70 + j * 30, {
        color: TONE[l.tone],
        scale: 2,
        tracking: 1,
        shadow: alpha(C.void, 0.9),
      });
    });
    const reveal = 0.4 + lines.length * 1.4 + 0.4;
    if (t < reveal) return;
    const k = Math.min(1, (t - reveal) / 0.5);
    const id: TitanId = e.unlocked ? 'mouth' : e.player;
    const ps = 72;
    drawTitanPortrait(ctx, id, cx - ps / 2, 146, ps, { grey: k < 1 ? 0.7 : 0, phase: 0.2 });
    if (e.unlocked) {
      const pulse = 0.75 + 0.25 * Math.sin(ctx.t * 3);
      drawText(cv, 'THE MOUTH IS NOW PLAYABLE', cx, 232, {
        color: alpha(C.danger, pulse),
        align: 'center',
        tracking: 2,
        outline: C.void,
      });
      drawText(cv, '아귀 해금', cx, 248, { color: C.gold, align: 'center', tracking: 2 });
      drawText(cv, 'IT JOINS THE SELECT. IT CAN CLIMB ITS OWN LADDER.', cx, 268, {
        color: C.dim,
        font: 'micro',
        align: 'center',
        tracking: 1,
      });
    } else {
      drawText(cv, `${MODE_LABELS[mode].en} CLEARED`, cx, 232, {
        color: C.gold,
        align: 'center',
        tracking: 2,
        outline: C.void,
      });
      drawText(cv, `${MODE_LABELS[mode].ko} 우승  ·  ${DIFFICULTY_NAMES[diff].en}`, cx, 248, {
        color: C.celadon,
        align: 'center',
      });
    }
    if (t > 1.5) footer(ctx, [{ chip: promptLabels(ctx).confirm, text: 'CONTINUE' }]);
  }
}

const silhouettes = new Map<string, Sprite | null>();
/** A titan's portrait as a flat dark-red shape (the Mouth, before it is reached). */
function silhouette(ctx: UICtx, id: TitanId, size: number): Sprite | null {
  const key = `${id}:${size}`;
  const hit = silhouettes.get(key);
  if (hit !== undefined) return hit;
  const base = portraitSprite(ctx, id, size);
  let out: Sprite | null = null;
  if (base) {
    const cv = new PixelCanvas(size, size);
    for (let j = 0; j < base.h; j++)
      for (let i = 0; i < base.w; i++)
        if (base.pixels[j * base.w + i]! >>> 24) cv.px(i, j, (i + j) % 7 === 0 ? C.danger : C.dangerDeep);
    out = cv.toSprite();
  }
  silhouettes.set(key, out);
  return out;
}
