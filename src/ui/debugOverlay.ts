import { LOGICAL_H, LOGICAL_W, makeLayer, type RenderLayer, type ViewRect } from '@/contracts';
import { tuning, type DiagCtx, type TuningRegistry } from '@/debug/tuning';
import type { DebugInputFrame } from '@/input/types';
import { PixelCanvas } from './pixel/canvas';
import { C, alpha } from './pixel/palette';
import { drawText } from './pixel/text';

/**
 * The in-game debug overlay (MASTER_PROMPT Phase 1): every registered knob as a slider in a panel on the left, and every
 * registered diagnostics layer drawn in screen space over the fight. Keyboard ` (Backquote) or a pad's R3 cycles
 * off → panel + diagnostics → diagnostics only → off. Panel: [ ] select, - = adjust (; ' ×10), \ resets the knob; on a pad
 * the right stick selects (↑↓) and adjusts (←→, ×10 pushed fully).
 *
 * Presentation only: it reads the registry and the camera view; the one thing it changes is a knob, on a player's press.
 */
export type DebugMode = 'off' | 'panel' | 'diag';

const PANEL_X = 4;
const PANEL_Y = 56;
const PANEL_W = 196;
const ROW = 8;
const MAX_ROWS = 28;
const SLIDER_W = 46;

export class DebugOverlay {
  mode: DebugMode = 'off';
  /** Selected knob (index into the registry's list). */
  sel = 0;
  readonly layer: RenderLayer = makeLayer('debug-overlay', 'screen', 106, LOGICAL_W, LOGICAL_H);
  private readonly cv = new PixelCanvas(LOGICAL_W, LOGICAL_H, this.layer.pixels);
  private view: ViewRect = { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H };
  private readonly ctx: DiagCtx;

  constructor(private readonly reg: TuningRegistry = tuning) {
    const cv = this.cv;
    this.ctx = {
      sx: (x) => Math.round(x - this.view.x0),
      sy: (y) => Math.round(y - this.view.y0),
      line: (x0, y0, x1, y1, c) => line(cv, x0, y0, x1, y1, c),
      arrow: (x, y, dx, dy, c) => {
        const x1 = Math.round(x + dx);
        const y1 = Math.round(y + dy);
        line(cv, x, y, x1, y1, c);
        const l = Math.hypot(dx, dy);
        if (l < 3) return;
        const ux = dx / l;
        const uy = dy / l;
        line(cv, x1, y1, Math.round(x1 - ux * 4 - uy * 3), Math.round(y1 - uy * 4 + ux * 3), c);
        line(cv, x1, y1, Math.round(x1 - ux * 4 + uy * 3), Math.round(y1 - uy * 4 - ux * 3), c);
      },
      box: (x, y, w, h, c) => {
        cv.hline(x, y, w, c);
        cv.hline(x, y + h - 1, w, c);
        cv.vline(x, y, h, c);
        cv.vline(x + w - 1, y, h, c);
      },
      bar: (x, y, w, h, frac, c) => {
        cv.rect(x, y, w, h, alpha(C.ink0, 0.8));
        cv.rect(x, y, Math.round(w * Math.min(1, Math.max(0, frac))), h, c);
      },
      circle: (cx, cy, r, c) => circle(cv, Math.round(cx), Math.round(cy), Math.round(r), c),
      text: (x, y, s, c) => {
        drawText(cv, s.toUpperCase(), Math.round(x), Math.round(y), {
          color: c,
          font: 'micro',
          shadow: C.void,
        });
      },
    };
  }

  /** Apply one frame of debug controls. */
  handle(inp: Readonly<DebugInputFrame>): void {
    if (inp.toggle) this.mode = this.mode === 'off' ? 'panel' : this.mode === 'panel' ? 'diag' : 'off';
    if (this.mode !== 'panel') return;
    const n = this.reg.list().length;
    if (n === 0) return;
    this.sel = (((this.sel + inp.select) % n) + n) % n;
    if (inp.adjust !== 0) this.reg.adjust(this.sel, inp.adjust);
    if (inp.reset) this.reg.reset(this.sel);
  }

  /** Draw for this frame; null when the overlay is off. */
  draw(view: ViewRect): RenderLayer | null {
    if (this.mode === 'off') return null;
    this.view = view;
    const cv = this.cv;
    cv.clear(0);
    for (const [, fn] of this.reg.diagnostics()) fn(this.ctx);
    if (this.mode === 'panel') this.drawPanel();
    this.layer.version++;
    this.layer.dirty = null;
    return this.layer;
  }

  private drawPanel(): void {
    const cv = this.cv;
    const list = this.reg.list();
    const n = list.length;
    if (this.sel >= n) this.sel = Math.max(0, n - 1);
    // rows: an owner header whenever the owner changes, then its knobs; scrolled to keep the selection in view
    const rows: { owner?: string; index?: number }[] = [];
    let last = '';
    for (let i = 0; i < n; i++) {
      if (list[i]!.owner !== last) rows.push({ owner: (last = list[i]!.owner) });
      rows.push({ index: i });
    }
    const selRow = rows.findIndex((r) => r.index === this.sel);
    const first = Math.max(0, Math.min(selRow - (MAX_ROWS >> 1), rows.length - MAX_ROWS));
    const shown = rows.slice(first, first + MAX_ROWS);
    const h = (shown.length + 5) * ROW + 4;
    cv.rect(PANEL_X, PANEL_Y, PANEL_W, h, alpha(C.ink0, 0.82));
    cv.hline(PANEL_X, PANEL_Y, PANEL_W, C.line1);
    const t = (x: number, y: number, s: string, c: number): void => {
      drawText(cv, s.toUpperCase(), x, y, { color: c, font: 'micro' });
    };
    t(
      PANEL_X + 4,
      PANEL_Y + 3,
      `TUNING  ${this.reg.edits ? `${this.reg.edits} EDITS` : 'UNTOUCHED'}`,
      C.gold,
    );
    let y = PANEL_Y + 3 + ROW + 2;
    if (n === 0) t(PANEL_X + 4, y, 'NOTHING REGISTERED', C.mid);
    for (const r of shown) {
      if (r.owner !== undefined) {
        t(PANEL_X + 4, y, r.owner.replace(/^match\./, ''), C.celadon);
      } else {
        const e = list[r.index!]!;
        const k = e.knob;
        const v = k.get();
        const on = r.index === this.sel;
        if (on) cv.rect(PANEL_X + 2, y - 1, PANEL_W - 4, ROW, alpha(C.line1, 0.9));
        const changed = Math.abs(v - e.initial) > k.step * 0.5;
        t(PANEL_X + 8, y, k.label, on ? C.white : C.soft);
        const val = fmt(v, k.step);
        t(PANEL_X + PANEL_W - SLIDER_W - 10 - val.length * 4, y, val, changed ? C.gold : C.text);
        const sx = PANEL_X + PANEL_W - SLIDER_W - 6;
        cv.rect(sx, y + 2, SLIDER_W, 1, C.line2);
        const u = (v - k.min) / Math.max(1e-9, k.max - k.min);
        const ui = (e.initial - k.min) / Math.max(1e-9, k.max - k.min);
        cv.rect(sx + Math.round(ui * (SLIDER_W - 1)), y + 1, 1, 3, C.dim);
        cv.rect(sx + Math.round(u * (SLIDER_W - 1)) - 1, y, 3, 5, on ? C.gold : C.text);
      }
      y += ROW;
    }
    t(PANEL_X + 4, y + 2, "[ ] PICK  - = ADJUST  ; ' X10", C.dim);
    t(PANEL_X + 4, y + 2 + ROW, 'BACKSLASH RESET  BACKQUOTE NEXT VIEW', C.dim);
    t(PANEL_X + 4, y + 2 + ROW * 2, 'PAD: R3 NEXT VIEW  R-STICK PICK / ADJUST', C.dim);
  }
}

function fmt(v: number, step: number): string {
  const d = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return v.toFixed(d);
}

function line(cv: PixelCanvas, x0: number, y0: number, x1: number, y1: number, c: number): void {
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  x1 = Math.round(x1);
  y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const stx = x0 < x1 ? 1 : -1;
  const sty = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 4096; guard++) {
    cv.px(x0, y0, c);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += stx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sty;
    }
  }
}

function circle(cv: PixelCanvas, cx: number, cy: number, r: number, c: number): void {
  let x = r;
  let y = 0;
  let d = 1 - r;
  while (x >= y) {
    for (const [a, b] of [
      [x, y],
      [y, x],
      [-y, x],
      [-x, y],
      [-x, -y],
      [-y, -x],
      [y, -x],
      [x, -y],
    ] as const)
      cv.px(cx + a, cy + b, c);
    y++;
    if (d < 0) d += 2 * y + 1;
    else {
      x--;
      d += 2 * (y - x) + 1;
    }
  }
}
