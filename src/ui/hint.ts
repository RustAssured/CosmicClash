import { LOGICAL_H, LOGICAL_W, ROUND_INTRO_TICKS, TICK_HZ, type HudState } from '@/contracts';
import type { Action } from '@/input';
import { ACTION_TEXT } from './labels';
import { C, alpha } from './pixel/palette';
import { chip } from './pixel/shapes';
import { drawText, measureText } from './pixel/text';
import type { UICtx } from './screens/kit';

/**
 * The first-match hint strip: during round one of the very first match ever started on this device, a compact reminder of the
 * buttons (the REAL ones of each human player's controller) and the three ideas that matter, which fades away by itself. It
 * never appears in later matches, in attract mode, or between AI fighters.
 */
const SHOW_SECONDS = 16;
const FADE_SECONDS = 2.5;
const ACTIONS: readonly Action[] = ['strike', 'crush', 'surge', 'signature', 'ultimate', 'guard', 'feint'];

/** 0..1 visibility of the hint for this HUD state (0 = not shown). Pure, so it is unit-tested. */
export function hintVisibility(firstMatch: boolean, hud: HudState): number {
  if (!firstMatch || hud.round !== 1 || hud.phase === 'roundend' || hud.phase === 'matchend') return 0;
  const cfg = hud.match.config;
  if (cfg.mode === 'attract' || cfg.mode === 'aivai') return 0;
  if (!cfg.slots.some((s) => s.controller === 'human')) return 0;
  const shown = (hud.match.tick - ROUND_INTRO_TICKS * 0.4) / TICK_HZ; // starts a moment into the intro
  if (shown < 0) return 0;
  if (shown < 0.6) return shown / 0.6;
  if (shown > SHOW_SECONDS) return 0;
  return Math.min(1, (SHOW_SECONDS - shown) / FADE_SECONDS);
}

const stickLabel = (ctx: UICtx, deviceId: string | null): string => {
  const dev = ctx.input.devices().find((d) => d.id === deviceId);
  if (dev && dev.kind === 'keyboard') return dev.id === 'kb2' ? 'ARROWS' : 'WASD';
  return 'L STICK';
};

export function drawHint(ctx: UICtx, hud: HudState): void {
  const a = hintVisibility(ctx.firstMatch, hud);
  if (a <= 0) return;
  const cv = ctx.cv;
  const cfg = hud.match.config;
  const rows = ([0, 1] as const).filter((s) => cfg.slots[s].controller === 'human');
  const rowH = 14;
  const h = 22 + rows.length * rowH;
  const y0 = LOGICAL_H - 36 - h;
  const x0 = 20;
  const w = LOGICAL_W - 40;
  cv.rect(x0, y0, w, h, alpha(C.void, 0.72 * a));
  cv.hline(x0, y0, w, alpha(C.celadonDeep, a));
  drawText(
    cv,
    'YOUR BODY IS YOUR HEALTH  ·  HOLD A MOVE TO CHARGE IT  ·  THE ULTIMATE FILLS FROM DEALING AND TAKING DAMAGE',
    LOGICAL_W / 2,
    y0 + 5,
    { color: alpha(C.celadonLight, a), font: 'micro', align: 'center', tracking: 1 },
  );
  rows.forEach((slot, i) => {
    const y = y0 + 20 + i * rowH;
    const dev = ctx.input.assignment()[slot] ?? ctx.promptDevice()?.id ?? null;
    let x = x0 + 8;
    drawText(cv, `P${slot + 1}`, x, y + 1, { color: alpha(slot === 0 ? C.p1 : C.p2, a), font: 'micro' });
    x += 16;
    x += chip(cv, x, y - 1, stickLabel(ctx, dev), { color: alpha(C.mid, a), text: alpha(C.text, a) }) + 3;
    x += drawText(cv, 'AIM', x, y + 1, { color: alpha(C.soft, a), font: 'micro' }) + 10;
    for (const act of ACTIONS) {
      const label = ctx.input.actionLabel(dev, act);
      const name = ACTION_TEXT[act].en;
      if (x + measureText(name, { font: 'micro' }) + 34 > x0 + w) break;
      x += chip(cv, x, y - 1, label, { color: alpha(C.mid, a), text: alpha(C.text, a) }) + 3;
      x += drawText(cv, name, x, y + 1, { color: alpha(C.soft, a), font: 'micro' }) + 9;
    }
  });
}
