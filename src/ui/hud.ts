import {
  LOGICAL_H,
  LOGICAL_W,
  ROUND_INTRO_TICKS,
  ROUNDS_TO_WIN,
  TICK_HZ,
  type FighterView,
  type HudState,
} from '@/contracts';
import type { Sprite } from './pixel/canvas';
import { setAlpha } from './pixel/canvas';
import { C, accentRamp, alpha, mixRgb, type AccentRamp } from './pixel/palette';
import { alphaBounds, samplePortrait, silhouette, type Bounds } from './portrait';
import { drawIcon, meterBar, panel, pips } from './pixel/shapes';
import { drawText, measureText } from './pixel/text';
import { band, type UICtx } from './screens/kit';
import { drawTraining } from './training';

/**
 * In-fight HUD. Minimal and never over the fight: portraits + integrity at the top corners, the round clock top-centre,
 * a slim strip at the bottom for the ultimate meter. Each titan's portrait is a LIVE area-sample of its remaining body, so
 * matter that has been carved away is visibly missing from the HUD too — over a dim ghost of the intact silhouette.
 */
export const PORTRAIT_PX = 52;
const REFRESH_TICKS = 6;
const INTEGRITY_W = 166;
const PLATE_W = 224;

interface PortraitCache {
  bounds: Bounds | null;
  ghost: Sprite;
  live: Sprite;
  version: number;
  tick: number;
  /** Trailing "recent damage" fraction (0..1) that decays toward the true value. */
  trail: number;
  lastFrac: number;
}

const caches = new WeakMap<object, PortraitCache>();

function cacheFor(view: FighterView, slot: 0 | 1, tick: number): PortraitCache {
  const map = view.body.map;
  let c = caches.get(map);
  const size = PORTRAIT_PX - 2;
  if (!c) {
    const base: Sprite = { pixels: map.baseColor, w: map.w, h: map.h };
    const bounds = alphaBounds(map.baseColor, map.w, map.h) ?? { x0: 0, y0: 0, x1: map.w, y1: map.h };
    c = {
      bounds,
      ghost: silhouette(
        samplePortrait(base, size, size, { crop: bounds, flipX: slot === 1, threshold: 0.3 }),
        alpha(C.dim, 0.32),
      ),
      live: { pixels: new Uint32Array(size * size), w: size, h: size },
      version: -1,
      tick: -1e9,
      trail: -1,
      lastFrac: -1,
    };
    caches.set(map, c);
  }
  if (tick < c.tick || (map.version !== c.version && tick - c.tick >= REFRESH_TICKS) || c.version < 0) {
    samplePortrait(
      { pixels: map.pixels, w: map.w, h: map.h },
      size,
      size,
      { crop: c.bounds ?? undefined, flipX: slot === 1 },
      c.live,
    );
    c.version = map.version;
    c.tick = tick;
  }
  return c;
}

export interface HudOptions {
  /** Attract mode: no announcer, no training overlay. */
  compact?: boolean;
}

export function drawHud(ctx: UICtx, hud: HudState, opts: HudOptions = {}): void {
  const cv = ctx.cv;
  const m = hud.match;
  const views = [m.fighters[0].view, m.fighters[1].view] as const;
  band(cv, LOGICAL_H - 30, LOGICAL_H, 0, 0.55);
  for (const slot of [0, 1] as const) drawSide(ctx, hud, slot, views[slot]);
  drawClock(ctx, hud);
  if (!opts.compact) {
    drawAnnouncer(ctx, hud);
    if (hud.training) drawTraining(ctx, hud);
  }
}

function drawSide(ctx: UICtx, hud: HudState, slot: 0 | 1, view: FighterView): void {
  const cv = ctx.cv;
  const def = hud.match.fighters[slot].def;
  const ramp = accentRamp(def.ui.accent);
  const right = slot === 1;
  const px0 = right ? LOGICAL_W - 8 - PORTRAIT_PX : 8;
  const py0 = 6;
  const c = cacheFor(view, slot, hud.match.tick);

  // integrity fraction 0..1 (the view already folds both KO thresholds into a percentage)
  const frac = Math.max(0, Math.min(1, view.integrityPct / 100));
  if (c.lastFrac < 0) {
    c.trail = frac;
    c.lastFrac = frac;
  }
  if (frac < c.lastFrac - 0.0005) c.trail = Math.max(c.trail, c.lastFrac);
  c.lastFrac = frac;
  c.trail = Math.max(frac, c.trail - ctx.dt * 0.28);

  // portrait frame
  cv.rect(px0, py0, PORTRAIT_PX, PORTRAIT_PX, alpha(C.ink0, 0.82));
  cv.frame(px0, py0, PORTRAIT_PX, PORTRAIT_PX, view.ko ? C.dangerDeep : C.line1);
  cv.corners(px0, py0, PORTRAIT_PX, PORTRAIT_PX, ramp.base, 4);
  cv.blit(c.ghost, px0 + 1, py0 + 1);
  const shake = view.freezeTicks > 0 ? view.freezeTicks & 1 : 0;
  cv.blit(c.live, px0 + 1 + shake, py0 + 1);
  if (frac < 0.25 && !view.ko && Math.sin(ctx.t * 12) > 0)
    cv.frame(px0 + 1, py0 + 1, PORTRAIT_PX - 2, PORTRAIT_PX - 2, alpha(C.danger, 0.7));

  // info plate: name, integrity, resource — a dark hairline plate so it reads over any scenery
  const plateX = right ? LOGICAL_W - 8 - PORTRAIT_PX - 4 - PLATE_W : 8 + PORTRAIT_PX + 4;
  panel(cv, plateX, 3, PLATE_W, 43, { fill: alpha(C.ink0, 0.66), border: C.line0, shade: false });
  const tx = right ? plateX + PLATE_W - 8 : plateX + 8;
  const align = right ? 'right' : 'left';
  const nameW = drawText(cv, def.name.toUpperCase(), tx, 5, { color: C.text, tracking: 1, align });
  drawText(cv, def.nameKo, right ? tx - nameW - 8 : tx + nameW + 8, 5, { color: ramp.light, align });

  // integrity
  const bx = right ? tx - INTEGRITY_W : tx;
  const low = frac < 0.25;
  const barRamp: AccentRamp =
    low && Math.sin(ctx.t * 10) > 0
      ? { ...ramp, base: C.danger, light: mixRgb(C.danger, C.white, 0.4), dim: C.dangerDeep }
      : ramp;
  meterBar(cv, bx, 21, INTEGRITY_W, 7, frac, barRamp, { ticks: true, ghost: c.trail, rtl: right });
  const pct = `${Math.round(view.integrityPct)}%`;
  drawText(cv, pct, right ? bx - 5 : bx + INTEGRITY_W + 5, 22, {
    color: low ? C.danger : C.soft,
    font: 'micro',
    align: right ? 'right' : 'left',
  });

  // unique resource
  drawResource(ctx, def.resource.name.toUpperCase(), def.resource.display, view, ramp, tx, 33, right);

  // ultimate meter + guard on the bottom strip
  drawStrip(ctx, view, ramp, right ? LOGICAL_W - 8 : 8, right);
}

function drawResource(
  ctx: UICtx,
  label: string,
  display: 'pips' | 'bar',
  view: FighterView,
  ramp: AccentRamp,
  x: number,
  y: number,
  right: boolean,
): void {
  const cv = ctx.cv;
  const max = Math.max(1, view.resourceMax);
  const val = Math.max(0, Math.min(max, view.resource));
  const align = right ? 'right' : 'left';
  const lw = measureText(label, { font: 'micro', tracking: 1 });
  drawText(cv, label, x, y + 1, { color: C.dim, font: 'micro', tracking: 1, align });
  const gx = right ? x - lw - 6 : x + lw + 6;
  if (display === 'pips' && max <= 12) {
    const n = max;
    const w = n * 7 - 2;
    pips(cv, right ? gx - w : gx, y - 1, n, Math.round(val), ramp.light, C.line1, 2, 'diamond', right);
  } else if (display === 'pips') {
    // many discrete units (tendrils): a fine tick bar, one column per unit
    const n = max;
    const w = Math.min(120, n * 3);
    const cell = w / n;
    const x0 = right ? gx - w : gx;
    for (let i = 0; i < n; i++) {
      const idx = right ? n - 1 - i : i;
      const cx = x0 + Math.round(i * cell);
      cv.rect(cx, y, Math.max(1, Math.floor(cell) - 1), 5, idx < Math.round(val) ? ramp.light : C.line0);
    }
  } else {
    const w = 96;
    meterBar(cv, right ? gx - w : gx, y + 1, w, 3, val / max, ramp, { rtl: right });
  }
}

function drawStrip(ctx: UICtx, view: FighterView, ramp: AccentRamp, edge: number, right: boolean): void {
  const cv = ctx.cv;
  const y = LOGICAL_H - 15;
  const w = 150;
  const full = view.meter >= 0.999;
  const x = right ? edge - w : edge;
  const lab = full ? 'READY' : 'ULT';
  const lw = measureText(lab, { font: 'micro', tracking: 1 });
  const pulse = full ? 0.6 + 0.4 * Math.sin(ctx.t * 8) : 1;
  const lx = right ? x - lw - 6 : x + w + 6;
  const bx = x;
  const rampU: AccentRamp = full
    ? { ...ramp, base: mixRgb(ramp.base, C.white, 0.35 * pulse), light: C.white }
    : ramp;
  meterBar(cv, bx, y, w, 5, view.meter, rampU, { ticks: true, rtl: right });
  drawText(cv, lab, lx, y, {
    color: full ? mixRgb(C.gold, C.white, 0.3 * pulse) : C.dim,
    font: 'micro',
    tracking: 1,
    align: right ? 'right' : 'left',
  });
  if (view.guardUp) {
    const gw = 64;
    const gx = right ? edge - gw : edge;
    const gr: AccentRamp =
      view.guardHealth < 0.3
        ? { ...ramp, base: C.danger, light: mixRgb(C.danger, C.white, 0.35), dim: C.dangerDeep }
        : { ...ramp, base: mixRgb(ramp.base, C.p2, 0.3) };
    meterBar(cv, gx, y - 9, gw, 3, view.guardHealth, gr, { rtl: right });
    drawText(cv, 'GUARD', right ? gx - 5 : gx + gw + 5, y - 10, {
      color: C.dim,
      font: 'micro',
      tracking: 1,
      align: right ? 'right' : 'left',
    });
  }
}

function drawClock(ctx: UICtx, hud: HudState): void {
  const cv = ctx.cv;
  const m = hud.match;
  const cx = LOGICAL_W / 2;
  panel(cv, cx - 27, 3, 54, 43, { fill: alpha(C.ink0, 0.78), border: C.line1, shade: false });
  const infinite = m.config.infinite || m.config.mode === 'training';
  if (infinite) {
    drawIcon(cv, 'infinity', cx - 4, 14, C.soft, 1);
  } else {
    const secs = Math.max(0, Math.ceil(hud.roundTicksLeft / TICK_HZ));
    const urgent = secs <= 10 && hud.phase === 'fight';
    const col = urgent ? (Math.sin(ctx.t * 10) > 0 ? C.danger : C.gold) : C.text;
    drawText(cv, String(secs).padStart(2, '0'), cx, 8, {
      color: col,
      align: 'center',
      scale: 2,
      shadow: alpha(C.void, 0.9),
    });
  }
  // round wins toward ROUNDS_TO_WIN either side of the round label, all inside the clock plate
  const [w0, w1] = hud.wins;
  const pw = ROUNDS_TO_WIN * 7 - 2;
  pips(cv, cx - 9 - pw, 32, ROUNDS_TO_WIN, w0, C.p1, C.line2, 2, 'diamond', true);
  pips(cv, cx + 10, 32, ROUNDS_TO_WIN, w1, C.p2, C.line2, 2, 'diamond');
  drawText(cv, String(hud.round), cx, 32, { color: C.dim, font: 'micro', align: 'center' });
}

/* ------------------------------------------------------------------------------------------------ *
 *  announcer
 * ------------------------------------------------------------------------------------------------ */
interface Announce {
  en: string;
  ko: string;
  scale: number;
  /** 0..1 progress through this call-out (for the entrance). */
  age: number;
  color: number;
}

export function announcement(hud: HudState): Announce | null {
  const m = hud.match;
  const pt = m.phaseTick;
  const fightCallStart = ROUND_INTRO_TICKS - 45;
  if (hud.announcer) {
    const a = hud.announcer.toUpperCase();
    return { en: a, ko: koFor(a), scale: 3, age: Math.min(1, pt / 10), color: C.text };
  }
  switch (hud.phase) {
    case 'intro':
      if (pt < fightCallStart)
        return {
          en: `ROUND ${hud.round}`,
          ko: `라운드 ${hud.round}`,
          scale: 3,
          age: Math.min(1, pt / 10),
          color: C.text,
        };
      return {
        en: 'FIGHT!',
        ko: '시작!',
        scale: 3,
        age: Math.min(1, (pt - fightCallStart) / 8),
        color: C.gold,
      };
    case 'fight':
      if (pt < 28) return { en: 'FIGHT!', ko: '시작!', scale: 3, age: 1, color: C.gold };
      return null;
    case 'ko':
      return { en: 'K.O.', ko: '', scale: 4, age: Math.min(1, pt / 8), color: C.danger };
    case 'timeover':
      return { en: 'TIME UP', ko: '시간 종료', scale: 3, age: Math.min(1, pt / 10), color: C.gold };
    case 'roundend':
    case 'matchend': {
      const w = m.winner;
      if (w === -1) return { en: 'DRAW', ko: '무승부', scale: 3, age: Math.min(1, pt / 10), color: C.soft };
      const name = m.fighters[w].def.name.toUpperCase();
      return {
        en: `${name} WINS`,
        ko: '승리!',
        scale: 2,
        age: Math.min(1, pt / 10),
        color: w === 0 ? C.p1 : C.p2,
      };
    }
  }
}

function koFor(a: string): string {
  if (a.startsWith('ROUND')) return `라운드 ${a.replace(/\D+/g, '')}`.trim();
  if (a.startsWith('FIGHT')) return '시작!';
  if (a.includes('WIN')) return '승리!';
  if (a.includes('TIME')) return '시간 종료';
  return '';
}

function drawAnnouncer(ctx: UICtx, hud: HudState): void {
  const a = announcement(hud);
  if (!a) return;
  const cv = ctx.cv;
  const cy = 108;
  const w = measureText(a.en, { scale: a.scale, tracking: 1 });
  // entrance: a hard horizontal reveal from the centre, then settle
  const reveal = Math.min(1, a.age * 1.4);
  const rw = Math.max(2, Math.round((w + 20) * reveal));
  cv.pushClip(LOGICAL_W / 2 - Math.floor(rw / 2), cy - 8, rw, 12 * a.scale + 40);
  const light = mixRgb(a.color, C.white, 0.55);
  const opts = {
    align: 'center' as const,
    scale: a.scale,
    tracking: 1,
    outline: C.void,
    shadow: alpha(C.void, 0.65),
  };
  drawText(cv, a.en, LOGICAL_W / 2, cy, { ...opts, color: light });
  // lower half in the base colour: a two-tone gradient without leaving the pixel grid
  cv.pushClip(0, cy + 6 * a.scale, LOGICAL_W, 12 * a.scale);
  drawText(cv, a.en, LOGICAL_W / 2, cy, { align: 'center', scale: a.scale, tracking: 1, color: a.color });
  cv.popClip();
  if (a.ko)
    drawText(cv, a.ko, LOGICAL_W / 2, cy + 11 * a.scale + 4, {
      color: setAlpha(a.color, 240),
      align: 'center',
      tracking: 2,
      outline: C.void,
    });
  cv.popClip();
}

/* ------------------------------------------------------------------------------------------------ *
 *  larger live body samples (results screen)
 * ------------------------------------------------------------------------------------------------ */
const bodyCache = new WeakMap<object, { size: number; version: number; ghost: Sprite; live: Sprite }>();

/** Area-sampled current body of a fighter at `size` px, plus a ghost of the intact silhouette. Cached by map version. */
export function bodySprites(view: FighterView, slot: 0 | 1, size: number): { live: Sprite; ghost: Sprite } {
  const map = view.body.map;
  let c = bodyCache.get(map);
  if (!c || c.size !== size || c.version !== map.version) {
    const bounds = alphaBounds(map.baseColor, map.w, map.h) ?? { x0: 0, y0: 0, x1: map.w, y1: map.h };
    const base: Sprite = { pixels: map.baseColor, w: map.w, h: map.h };
    const ghost = silhouette(
      samplePortrait(base, size, size, { crop: bounds, flipX: slot === 1, threshold: 0.3 }),
      alpha(C.dim, 0.3),
    );
    const live = samplePortrait({ pixels: map.pixels, w: map.w, h: map.h }, size, size, {
      crop: bounds,
      flipX: slot === 1,
    });
    c = { size, version: map.version, ghost, live };
    bodyCache.set(map, c);
  }
  return { live: c.live, ghost: c.ghost };
}
