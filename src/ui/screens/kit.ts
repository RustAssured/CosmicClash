import {
  LOGICAL_H,
  LOGICAL_W,
  type Difficulty,
  type HudState,
  type StageId,
  type TitanId,
  type UIAction,
  type UiSoundId,
  type UIScreenId,
} from '@/contracts';
import type { DeviceInfo, InputManager, NavFrame } from '@/input';
import { KEY_LAYOUTS, Pad, keyLabel, padButtonLabel } from '@/input';
import type { AdvantageTracker } from '../advantage';
import { PixelCanvas, type Sprite } from '../pixel/canvas';
import { C, accentRamp, alpha, type AccentRamp } from '../pixel/palette';
import { alphaBounds, samplePortrait } from '../portrait';
import { chip, drawIcon, iconSize, meterBar } from '../pixel/shapes';
import { drawText, measureText } from '../pixel/text';
import type { UISettings } from '../settings';
import type { TitanInfo, UIDeps } from '../types';

/** Training-mode UI state (mirrors what the UI last asked the app for). */
export interface TrainingState {
  view: 'off' | 'hitboxes' | 'matter';
  dummy: 'idle' | 'guard' | 'ai';
}

export interface MatchSetup {
  mode: 'versus' | 'vsai' | 'training';
  aiLevel: Difficulty;
  p1: TitanId;
  p2: TitanId;
  stage: StageId;
}

/** Everything a screen may use. Implemented by the UI runtime. */
export interface UICtx {
  readonly cv: PixelCanvas;
  readonly deps: UIDeps;
  readonly input: InputManager;
  /** Seconds since the UI started (animation clock) and since the previous update. */
  readonly t: number;
  readonly dt: number;
  /** Seconds since the current screen was entered. */
  readonly screenTime: number;
  /** Updates since the current screen was entered (a slow machine may show only a few frames per second). */
  readonly screenFrames: number;
  /** True while the very first match ever started on this device is running (the in-match hint strip uses it). */
  readonly firstMatch: boolean;
  /** Merged nav frame from every device, and per-slot frames. */
  readonly nav: Readonly<NavFrame>;
  navFor(slot: 0 | 1): Readonly<NavFrame>;
  readonly settings: UISettings;
  saveSettings(): void;
  readonly setup: MatchSetup;
  readonly training: TrainingState;
  /** Last HudState given to `draw`. */
  hud: HudState | null;
  readonly advantage: AdvantageTracker;
  emit(a: UIAction): void;
  sound(id: UiSoundId): void;
  go(id: UIScreenId, params?: unknown): void;
  push(id: UIScreenId, params?: unknown): void;
  pop(): void;
  resetIdle(): void;
  titan(id: TitanId): TitanInfo;
  isTitanReady(id: TitanId): boolean;
  isStageReady(id: StageId): boolean;
  /** The device the player last touched (for prompt glyphs). */
  promptDevice(): DeviceInfo | null;
  startMatch(): void;
}

export interface Screen {
  enter?(ctx: UICtx, params?: unknown): void;
  update(ctx: UICtx): void;
  draw(ctx: UICtx, hud: HudState | null): void;
}

/* ------------------------------------------------------------------------------------------------ *
 *  backdrops
 * ------------------------------------------------------------------------------------------------ */
/** Darken the whole frame with a vertical alpha gradient so text reads over any scenery; edges darker than the middle. */
export function scrim(
  cv: PixelCanvas,
  topA: number,
  midA: number,
  botA: number,
  color: number = C.void,
): void {
  const h = cv.h;
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    const a = t < 0.5 ? topA + (midA - topA) * (t / 0.5) : midA + (botA - midA) * ((t - 0.5) / 0.5);
    cv.rect(0, y, cv.w, 1, alpha(color, Math.min(1, a)));
  }
}

const backdrops = new Map<string, Uint32Array>();

/**
 * Static backdrops (scrims, vignettes, pillars) are expensive per pixel but never change: build once into a scratch canvas
 * and copy the pixels in each frame. The canvas is always cleared first, so a copy is exactly what drawing would produce.
 */
export function backdrop(cv: PixelCanvas, key: string, build: (c: PixelCanvas) => void): void {
  let px = backdrops.get(key);
  if (!px) {
    const tmp = new PixelCanvas(cv.w, cv.h);
    build(tmp);
    px = tmp.pixels;
    backdrops.set(key, px);
  }
  cv.copyFrom(px);
}

/**
 * A dark, soft-edged plate behind a block of centred content (the title menu): alpha `a` in the middle, feathering to zero
 * over `feather` px on every side, so text reads over any scenery without a visible box.
 */
export function pillar(
  cv: PixelCanvas,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  a: number,
  feather = 46,
  color: number = C.void,
): void {
  const sm = (t: number): number => {
    const u = Math.max(0, Math.min(1, t));
    return u * u * (3 - 2 * u);
  };
  const col = new Float32Array(x1 - x0);
  for (let x = x0; x < x1; x++) col[x - x0] = sm((x - x0) / feather) * sm((x1 - 1 - x) / feather);
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = alpha(color, i / 255);
  for (let y = y0; y < y1; y++) {
    const vy = sm((y - y0) / feather) * sm((y1 - 1 - y) / feather);
    for (let x = x0; x < x1; x++) {
      const al = Math.round(a * col[x - x0]! * vy * 255);
      if (al > 4) cv.px(x, y, lut[al]!);
    }
  }
}

/** A horizontal band of shade fading from `a0` at y0 to `a1` at y1 (HUD top/bottom). */
export function band(
  cv: PixelCanvas,
  y0: number,
  y1: number,
  a0: number,
  a1: number,
  color: number = C.void,
): void {
  const n = Math.max(1, y1 - y0);
  for (let y = y0; y < y1; y++) cv.rect(0, y, cv.w, 1, alpha(color, a0 + ((a1 - a0) * (y - y0)) / n));
}

/** Soft dithered vignette on the left/right edges. */
export function vignette(cv: PixelCanvas, strength = 1): void {
  const w = 56;
  for (let i = 0; i < w; i++) {
    const lvl = Math.round((1 - i / w) ** 2 * 9 * strength);
    cv.dither(i, 0, 1, cv.h, alpha(C.void, 0.9), lvl);
    cv.dither(cv.w - 1 - i, 0, 1, cv.h, alpha(C.void, 0.9), lvl);
  }
}

/* ------------------------------------------------------------------------------------------------ *
 *  header / footer
 * ------------------------------------------------------------------------------------------------ */
export function header(ctx: UICtx, en: string, ko: string, right?: string): void {
  const cv = ctx.cv;
  drawText(cv, en, 24, 14, { color: C.text, tracking: 2, shadow: alpha(C.void, 0.8) });
  const w = measureText(en, { tracking: 2 });
  drawIcon(cv, 'diamondSm', 24 + w + 10, 21, C.celadonDeep);
  drawText(cv, ko, 24 + w + 22, 14, { color: C.celadonDeep });
  cv.hline(24, 34, LOGICAL_W - 48, C.line0);
  cv.hline(24, 34, 28, C.celadon);
  if (right) drawText(cv, right, LOGICAL_W - 24, 18, { color: C.dim, font: 'micro', align: 'right' });
}

export interface PromptItem {
  /** Chip label(s): a button, key or combination. */
  chip: string | string[];
  text: string;
  dim?: boolean;
}

/** Bottom prompt bar: chips + text, left aligned, with an optional right-hand note. */
export function footer(ctx: UICtx, items: PromptItem[], right?: string): void {
  const cv = ctx.cv;
  const y = LOGICAL_H - 24;
  cv.hline(24, y - 6, LOGICAL_W - 48, C.line0);
  let x = 24;
  for (const it of items) {
    const chips = Array.isArray(it.chip) ? it.chip : [it.chip];
    for (const c of chips)
      x += chip(cv, x, y, c, { color: it.dim ? C.line1 : C.mid, text: it.dim ? C.dim : C.text }) + 2;
    x += 2;
    x += drawText(cv, it.text, x, y - 2, { color: it.dim ? C.dim : C.soft, tracking: 1 }) + 16;
  }
  if (right) drawText(cv, right, LOGICAL_W - 24, y + 1, { color: C.dim, font: 'micro', align: 'right' });
}

/** Standard prompts using the labels of whichever device the player last used. */
export function promptLabels(ctx: UICtx): {
  confirm: string;
  back: string;
  tab: string[];
  keyboard: boolean;
} {
  const dev = ctx.promptDevice();
  const id = dev?.id ?? null;
  const keyboard = !!dev && dev.kind === 'keyboard';
  let tab: string[];
  if (keyboard) {
    const l = KEY_LAYOUTS.find((k) => k.id === dev!.id) ?? KEY_LAYOUTS[0]!;
    tab = [keyLabel(l.nav.tab[1] ?? 'KeyQ'), keyLabel(l.nav.tab[2] ?? 'KeyE')];
  } else {
    const fam = ctx.input.promptFamily();
    tab = [padButtonLabel(fam, Pad.L1), padButtonLabel(fam, Pad.R1)];
  }
  return { confirm: ctx.input.confirmLabel(id), back: ctx.input.backLabel(id), tab, keyboard };
}

export const confirmBack = (ctx: UICtx, confirmText = 'SELECT', backText = 'BACK'): PromptItem[] => {
  const p = promptLabels(ctx);
  return [
    { chip: p.confirm, text: confirmText },
    { chip: p.back, text: backText },
  ];
};

/* ------------------------------------------------------------------------------------------------ *
 *  menu list
 * ------------------------------------------------------------------------------------------------ */
export interface MenuItem {
  id: string;
  en: string;
  ko?: string;
  enabled?: boolean;
  /** Right-aligned current value (options rows). */
  value?: string;
  note?: string;
}

export class Menu {
  index = 0;
  constructor(public items: MenuItem[]) {}

  get current(): MenuItem {
    return this.items[this.index]!;
  }

  /** Move the cursor from a nav frame; returns the vertical delta applied (for sounds). */
  step(nav: Readonly<NavFrame>): number {
    let d = 0;
    if (nav.up) d = -1;
    else if (nav.down) d = 1;
    if (d === 0) return 0;
    const n = this.items.length;
    for (let k = 0; k < n; k++) {
      this.index = (this.index + d + n) % n;
      if (this.items[this.index]!.enabled !== false) break;
    }
    return d;
  }

  set(index: number): void {
    this.index = Math.max(0, Math.min(this.items.length - 1, index));
  }
}

/**
 * Two-column, centred menu: English label right-aligned to the axis, Hangeul gloss left-aligned, a hairline diamond between
 * them. The focused row gets the accent colour, chevrons and an underline that draws in.
 */
export function drawCentreMenu(
  ctx: UICtx,
  menu: Menu,
  cx: number,
  y: number,
  rowH: number,
  accent: AccentRamp,
): void {
  const cv = ctx.cv;
  menu.items.forEach((it, i) => {
    const ry = y + i * rowH;
    const focus = i === menu.index;
    const enabled = it.enabled !== false;
    const col = !enabled ? C.line2 : focus ? C.white : C.mid;
    const ko = !enabled ? C.line1 : focus ? accent.light : C.dim;
    const tr = 2;
    drawText(cv, it.en, cx - 12, ry, {
      color: col,
      tracking: tr,
      align: 'right',
      shadow: focus ? alpha(C.void, 0.9) : undefined,
    });
    if (it.ko) drawText(cv, it.ko, cx + 12, ry, { color: ko });
    drawIcon(cv, 'diamondSm', cx - 1, ry + 5, focus ? accent.base : enabled ? C.line1 : C.ink3);
    if (focus) {
      const pulse = Math.sin(ctx.t * 5) > 0 ? 1 : 0;
      const w = measureText(it.en, { tracking: tr });
      const wk = it.ko ? measureText(it.ko) : 0;
      const lx = cx - 12 - w - 14 - pulse;
      drawIcon(cv, 'chevron', lx, ry + 2, accent.base);
      const rx = cx + 12 + wk + 8 + pulse;
      if (it.ko) drawIcon(cv, 'chevronL', rx, ry + 2, accent.base);
      // underline draws in from the middle of the row
      const full = w + 24 + wk;
      const span = Math.round(full * menuFocusTime(menu, ctx.t));
      cv.hline(cx - 12 - w + Math.round((full - span) / 2), ry + 13, span, accent.dim);
    }
  });
}

const focusStamp = new WeakMap<Menu, { index: number; at: number }>();
function menuFocusTime(menu: Menu, t: number): number {
  let s = focusStamp.get(menu);
  if (!s || s.index !== menu.index) {
    s = { index: menu.index, at: t };
    focusStamp.set(menu, s);
  }
  return Math.min(1, (t - s.at) / 0.18);
}

/** A horizontal slider drawn as a pixel bar with a notch: `frac` 0..1. */
export function slider(
  ctx: UICtx,
  x: number,
  y: number,
  w: number,
  frac: number,
  ramp: AccentRamp,
  focus: boolean,
): void {
  meterBar(ctx.cv, x, y, w, 5, frac, ramp, { ticks: true });
  const kx = x + Math.round((w - 2) * Math.max(0, Math.min(1, frac)));
  ctx.cv.rect(kx - 1, y - 2, 4, 9, focus ? ramp.glow : ramp.light);
  ctx.cv.rect(kx, y - 1, 2, 7, focus ? C.white : ramp.base);
}

/** A small "coming soon" tag. */
export function comingSoon(ctx: UICtx, cx: number, y: number): void {
  const w = measureText('COMING SOON', { font: 'micro' });
  const cv = ctx.cv;
  cv.rect(cx - Math.floor(w / 2) - 3, y - 2, w + 6, 9, alpha(C.void, 0.85));
  cv.frame(cx - Math.floor(w / 2) - 3, y - 2, w + 6, 9, C.line1);
  drawText(cv, 'COMING SOON', cx, y, { color: C.dim, font: 'micro', align: 'center' });
}

export { iconSize };

/* ------------------------------------------------------------------------------------------------ *
 *  portraits
 * ------------------------------------------------------------------------------------------------ */
const portraitCache = new Map<string, Sprite | null>();

/** Area-sampled, outlined pristine portrait of a titan at `size`×`size` (cached). Null if the provider has none. */
export function portraitSprite(ctx: UICtx, id: TitanId, size: number, flip = false, grey = 0): Sprite | null {
  if (grey > 0) {
    const gkey = `${id}:${size}:${flip ? 1 : 0}:g${grey}`;
    const cached = portraitCache.get(gkey);
    if (cached !== undefined) return cached;
    const base = portraitSprite(ctx, id, size, flip, 0);
    const px = new PixelCanvas(size, size);
    if (base) px.blit(base, 0, 0, { grey });
    const out = base ? px.toSprite() : null;
    portraitCache.set(gkey, out);
    return out;
  }
  const key = `${id}:${size}:${flip ? 1 : 0}`;
  const hit = portraitCache.get(key);
  if (hit !== undefined) return hit;
  const src = ctx.deps.portrait(id);
  let out: Sprite | null = null;
  if (src) {
    const bounds = alphaBounds(src.pixels, src.w, src.h) ?? undefined;
    const outline = accentRamp(ctx.titan(id).accent).deep;
    out = samplePortrait(src, size, size, { crop: bounds, flipX: flip, outline, margin: 1 });
  }
  portraitCache.set(key, out);
  return out;
}

/** Drop cached portraits (the app regenerated them, e.g. after a quality change). */
export function clearPortraitCache(): void {
  portraitCache.clear();
}

/** Blit a titan portrait with a gentle 1px bob and a moving sheen — "live" without leaving the pixel grid. */
export function drawTitanPortrait(
  ctx: UICtx,
  id: TitanId,
  x: number,
  y: number,
  size: number,
  o: { flip?: boolean; grey?: number; bob?: boolean; sheen?: boolean; phase?: number } = {},
): void {
  const spr = portraitSprite(ctx, id, size, o.flip, o.grey ?? 0);
  if (!spr) return;
  const t = ctx.t + (o.phase ?? 0);
  const by = o.bob === false ? 0 : Math.round(Math.sin(t * 1.6) * 0.9);
  ctx.cv.blit(spr, x, y + by);
  if (o.sheen !== false && !o.grey) {
    // a soft diagonal band of light that drifts across the sprite, clipped to its own pixels
    const band = ((t * 26) % (size * 2 + 60)) - 30;
    for (let j = 0; j < spr.h; j++) {
      for (let i = 0; i < spr.w; i++) {
        const c = spr.pixels[j * spr.w + i]!;
        if (!(c >>> 24)) continue;
        const d = i + j - band;
        if (d > -2 && d < 2) ctx.cv.px(x + i, y + by + j, alpha(C.white, 0.16 - Math.abs(d) * 0.05));
      }
    }
  }
}

/**
 * True once a screen has been up for `sec` seconds OR a few frames, whichever comes first. Input guards ("don't let a mashed
 * button skip this") use it so that on a machine running one or two frames a second they last a couple of frames, never
 * long enough to swallow a deliberate press.
 */
export const settled = (ctx: Pick<UICtx, 'screenTime' | 'screenFrames'>, sec: number): boolean =>
  ctx.screenTime >= sec || ctx.screenFrames >= 3;
