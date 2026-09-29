import { LOGICAL_W } from '@/contracts';
import { KEY_LAYOUTS, keyLabel, type Action } from '@/input';
import { ACTION_TEXT } from '../labels';
import { C, alpha } from '../pixel/palette';
import { chip, meterBar, panel } from '../pixel/shapes';
import { accentRamp } from '../pixel/palette';
import { drawText, measureText, wrapText } from '../pixel/text';
import { backdrop, footer, header, scrim, vignette, type UICtx } from './kit';

/**
 * HOW TO PLAY (설명): three pages, readable in half a minute, skippable at any moment. It is an overlay of the title screen
 * (the title owns it), shown once on first launch and again whenever HOW TO PLAY is chosen from the title menu.
 *
 *   1  Your body is your health: the portrait shows what you have lost.
 *   2  The moves, each with the REAL button of the controller the player last touched (Nintendo, Xbox, PlayStation, keyboard).
 *   3  Hold to charge, aim with the stick, and the ultimate meter fills from dealing AND taking damage.
 */
export interface HowTo {
  readonly active: boolean;
  open(): void;
  update(ctx: UICtx): void;
  draw(ctx: UICtx): void;
}

const PAGES = 3;
const ACCENT = accentRamp('#a8bdb2');

/** What each move is, in a few plain words (English; the Hangeul name comes from `ACTION_TEXT`). */
const MOVE_ROWS: readonly { action: Action; note: string }[] = [
  { action: 'strike', note: 'Quick blow. Hold to charge it.' },
  { action: 'crush', note: 'Slow and heavy. Hold to charge it.' },
  { action: 'surge', note: 'A burst of movement.' },
  { action: 'signature', note: "Your titan's own trick." },
  { action: 'ultimate', note: 'Needs a full meter.' },
  { action: 'guard', note: 'Hold to block. A Crush breaks it.' },
  { action: 'feint', note: 'Cancel a wind-up.' },
];

/** The label of the stick for a device: WASD on the first keyboard, arrows on the second, the left stick on a pad. */
export function aimLabel(ctx: UICtx): string {
  const dev = ctx.promptDevice();
  if (dev && dev.kind === 'keyboard') {
    const l = KEY_LAYOUTS.find((k) => k.id === dev.id) ?? KEY_LAYOUTS[0]!;
    return l.move.up.map(keyLabel).join('') === 'W' ? 'WASD' : 'ARROWS';
  }
  return 'L STICK';
}

/** The chip label of `action` on the device the player last touched. */
export const moveLabel = (ctx: UICtx, action: Action): string =>
  ctx.input.actionLabel(ctx.promptDevice()?.id ?? null, action);

export function createHowTo(): HowTo {
  let page = -1;
  return {
    get active() {
      return page >= 0;
    },
    open() {
      page = 0;
    },
    update(ctx) {
      if (page < 0) return;
      const n = ctx.nav;
      if (n.back || n.start) {
        ctx.sound('back');
        page = -1;
      } else if (n.confirm || n.right || n.down) {
        if (page === PAGES - 1) {
          ctx.sound('confirm');
          page = -1;
        } else {
          ctx.sound('move');
          page++;
        }
      } else if ((n.left || n.up) && page > 0) {
        ctx.sound('move');
        page--;
      }
    },
    draw(ctx) {
      if (page < 0) return;
      const cv = ctx.cv;
      backdrop(cv, 'bg:0.8:0.7:0.85:howto', (bg) => {
        scrim(bg, 0.8, 0.7, 0.85);
        vignette(bg);
      });
      const titles = [
        ['HOW TO PLAY', '설명 · 몸이 곧 생명'],
        ['HOW TO PLAY', '설명 · 기술'],
        ['HOW TO PLAY', '설명 · 모으기 · 조준 · 궁극기'],
      ] as const;
      header(ctx, titles[page]![0], titles[page]![1], `${page + 1} / ${PAGES}`);
      if (page === 0) drawBody(ctx);
      else if (page === 1) drawMoves(ctx);
      else drawTechnique(ctx);
      // page dots
      for (let i = 0; i < PAGES; i++)
        cv.rect(LOGICAL_W / 2 - 14 + i * 12, 300, 6, 3, i === page ? ACCENT.light : C.line1);
      const p = ctx.input;
      const dev = ctx.promptDevice()?.id ?? null;
      footer(ctx, [
        { chip: p.confirmLabel(dev), text: page === PAGES - 1 ? 'DONE' : 'NEXT' },
        { chip: p.backLabel(dev), text: 'SKIP' },
      ]);
    },
  };
}

/* ------------------------------------------------------------------------------------------------ *
 *  page 1: the body is the health bar
 * ------------------------------------------------------------------------------------------------ */
const hash = (x: number, y: number): number => {
  let h = Math.imul(x + 374761393, 668265263) ^ Math.imul(y + 1274126177, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** A round body eroding from the right: the live matter over the ghost of what it was. */
function drawErodingBody(ctx: UICtx, cx: number, cy: number, r: number): void {
  const cv = ctx.cv;
  // the loss sweeps back and forth slowly: 20% to 60% of the body gone
  const lost = 0.4 + 0.2 * Math.sin(ctx.t * 0.7);
  const cut = cx + r - 2 * r * lost;
  for (let y = -r; y <= r; y += 1) {
    const half = Math.floor(Math.sqrt(r * r - y * y));
    for (let x = -half; x <= half; x += 1) {
      const px = cx + x;
      const py = cy + y;
      const edge = half - Math.abs(x) < 2 || Math.abs(y) > r - 2;
      const ragged = px > cut + (hash(px >> 1, py >> 1) - 0.5) * 14;
      if (ragged) {
        // the ghost: only its outline and a sparse dither, so you can see what was there
        if (edge) cv.px(px, py, C.line2);
        else if (((px + py) & 3) === 0 && hash(px, py) < 0.5) cv.px(px, py, C.line1);
      } else {
        const shade = hash(px, py) * 0.25 + (1 - (y + r) / (2 * r)) * 0.35;
        cv.px(
          px,
          py,
          edge ? C.celadonDeep : shade > 0.42 ? C.celadonLight : shade > 0.22 ? C.celadon : C.celadonDeep,
        );
      }
    }
  }
  // the eye, so it reads as a creature and not a coin
  cv.rect(cx - 12, cy - 6, 14, 12, C.ink0);
  cv.rect(cx - 9, cy - 3, 8, 6, C.gold);
  cv.rect(cx - 6, cy - 1, 3, 3, C.ink0);
}

function drawBody(ctx: UICtx): void {
  const cv = ctx.cv;
  panel(cv, 40, 52, 200, 232, { accent: ACCENT.dim });
  drawErodingBody(ctx, 140, 158, 62);
  drawText(cv, 'WHAT YOU HAVE LOST', 140, 246, { color: C.dim, font: 'micro', align: 'center', tracking: 1 });
  drawText(cv, '잃은 만큼 비어 있다', 140, 262, { color: C.celadonDeep, align: 'center' });
  const x = 268;
  let y = 60;
  const para = (en: string, ko: string, strong = false): void => {
    for (const line of wrapText(en, 320)) {
      drawText(cv, line, x, y, { color: strong ? C.white : C.soft });
      y += 13;
    }
    drawText(cv, ko, x, y, { color: C.celadonDeep });
    y += 24;
  };
  para('There is no health bar. Your BODY is the health bar.', '몸이 곧 생명입니다.', true);
  para(
    'Every blow tears real matter away. The portrait in the corner shows what you have lost.',
    '맞을수록 몸이 떨어져 나갑니다.',
  );
  para('Lose enough of it, or your core, and you fall. Take your rival apart first.', '먼저 무너뜨리세요.');
  const w = 180;
  drawText(cv, 'INTEGRITY', x, y + 2, { color: C.dim, font: 'micro', tracking: 1 });
  meterBar(cv, x, y + 12, w, 6, 0.62, ACCENT, { ticks: true });
  drawText(cv, '62%', x + w + 8, y + 10, { color: C.soft, font: 'micro' });
}

/* ------------------------------------------------------------------------------------------------ *
 *  page 2: the moves, with the real buttons
 * ------------------------------------------------------------------------------------------------ */
function drawMoves(ctx: UICtx): void {
  const cv = ctx.cv;
  const rows = MOVE_ROWS.length + 1;
  panel(cv, 40, 46, LOGICAL_W - 80, 24 * rows + 8, { accent: ACCENT.dim, fill: alpha(C.ink1, 0.82) });
  let y = 54;
  const row = (label: string, en: string, ko: string, note: string): void => {
    const w = chip(cv, 60, y, label, { color: C.celadonDeep });
    void w;
    drawText(cv, en, 128, y, { color: C.white, tracking: 1 });
    drawText(cv, ko, 128 + measureText(en, { tracking: 1 }) + 8, y, { color: C.celadonDeep });
    drawText(cv, note, 316, y, { color: C.soft });
    y += 24;
  };
  row(aimLabel(ctx), 'AIM', '조준', 'Up, forward or down: tilt before you strike.');
  for (const r of MOVE_ROWS)
    row(moveLabel(ctx, r.action), ACTION_TEXT[r.action].en, ACTION_TEXT[r.action].ko, r.note);
  drawText(cv, 'These are the buttons of the controller you used last.', LOGICAL_W / 2, 46 + 24 * rows + 16, {
    color: C.dim,
    font: 'micro',
    align: 'center',
    tracking: 1,
  });
}

/* ------------------------------------------------------------------------------------------------ *
 *  page 3: charge, aim, ultimate
 * ------------------------------------------------------------------------------------------------ */
function drawTechnique(ctx: UICtx): void {
  const cv = ctx.cv;
  const cols = [
    {
      x: 40,
      en: 'HOLD TO CHARGE',
      ko: '모으기',
      text: 'Hold a move button and it charges. Let go to strike: a longer hold hits harder.',
    },
    {
      x: 226,
      en: 'AIM WITH THE STICK',
      ko: '조준',
      text: 'Tilt up, forward or down before you strike to choose where the blow lands.',
    },
    {
      x: 412,
      en: 'ULTIMATE METER',
      ko: '궁극기',
      text: 'It fills when you deal damage AND when you take it. Full: unleash it.',
    },
  ];
  cols.forEach((c, i) => {
    const w = 188;
    panel(cv, c.x, 52, w, 196, { accent: i === 2 ? C.gold : ACCENT.dim, fill: alpha(C.ink1, 0.82) });
    drawText(cv, c.en, c.x + w / 2, 62, { color: C.white, font: 'micro', align: 'center', tracking: 1 });
    drawText(cv, c.ko, c.x + w / 2, 76, { color: C.celadonDeep, align: 'center' });
    let y = 172;
    for (const line of wrapText(c.text, w - 24)) {
      drawText(cv, line, c.x + 12, y, { color: C.soft });
      y += 13;
    }
    const mx = c.x + w / 2;
    if (i === 0) {
      // a bar filling, with the button held
      const fill = ((ctx.t * 0.5) % 1) * 0.95 + 0.05;
      chip(cv, mx - 5, 96, moveLabel(ctx, 'crush'), { color: C.gold });
      meterBar(cv, c.x + 24, 122, w - 48, 8, fill, ACCENT, { ticks: true });
      drawText(cv, 'HOLD', mx, 138, { color: C.dim, font: 'micro', align: 'center', tracking: 1 });
    } else if (i === 1) {
      // three aims: up, forward, down (arrows from a common point)
      const ox = c.x + 48;
      const oy = 126;
      const active = Math.floor(ctx.t * 1.4) % 3;
      const tips: [number, number][] = [
        [ox + 84, oy - 30],
        [ox + 92, oy],
        [ox + 84, oy + 30],
      ];
      cv.rect(ox - 8, oy - 8, 16, 16, C.celadonDeep);
      tips.forEach(([tx, ty], k) => {
        const col = k === active ? C.gold : C.line2;
        cv.line(ox + 8, oy, tx, ty, col);
        cv.rect(tx - 1, ty - 1, 3, 3, col);
      });
    } else {
      // the meter fills from BOTH directions of damage
      meterBar(cv, c.x + 24, 112, w - 48, 8, 0.25 + 0.7 * ((ctx.t * 0.35) % 1), accentRamp('#ecc98a'), {
        ticks: true,
      });
      drawText(cv, 'DEALT  +', c.x + 24, 130, { color: C.p1, font: 'micro', tracking: 1 });
      drawText(cv, 'TAKEN  +', c.x + 24, 142, { color: C.p2, font: 'micro', tracking: 1 });
    }
  });
}
