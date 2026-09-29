import { LOGICAL_W, hex, pb, pg, pr, rgbToHsl, rgba, type StageInfo } from '@/contracts';
import { BAYER4, PixelCanvas, type Sprite } from '../pixel/canvas';
import { C, accentRamp, alpha } from '../pixel/palette';
import { panel } from '../pixel/shapes';
import { drawText, measureText, wrapText } from '../pixel/text';
import { comingSoon, confirmBack, footer, header, scrim, vignette, type Screen, backdrop } from './kit';

const CARD_W = 112;
const CARD_H = 154;
const GAP = 8;
const X0 = (LOGICAL_W - (5 * CARD_W + 4 * GAP)) / 2;
const CARD_Y = 54;
const PW = CARD_W - 8;
const PH = 76;

/* ------------------------------------------------------------------------------------------------ *
 *  procedural stage previews, built from each stage's own curated palette
 * ------------------------------------------------------------------------------------------------ */
function hash(x: number, y: number, s: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, s);
  const b = hash(xi + 1, yi, s);
  const c = hash(xi, yi + 1, s);
  const d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x: number, y: number, s: number): number =>
  vnoise(x, y, s) * 0.55 + vnoise(x * 2.1, y * 2.1, s + 7) * 0.3 + vnoise(x * 4.3, y * 4.3, s + 13) * 0.15;

interface PaletteSplit {
  dark: number[];
  glow: number[];
  light: number[];
  all: number[];
}

/** Split a palette into a dark sky ramp, a saturated gas ramp and a light star ramp. */
export function splitPalette(palette: readonly string[]): PaletteSplit {
  const cols = palette.map((h) => {
    const c = hex(h);
    const [hh, ss, ll] = rgbToHsl(pr(c), pg(c), pb(c));
    return { c, h: hh, s: ss, l: ll };
  });
  const byL = [...cols].sort((a, b) => a.l - b.l);
  const dark = byL.slice(0, 4).map((x) => x.c);
  const light = byL.slice(-4).map((x) => x.c);
  const mid = byL.slice(4, -4).filter((x) => x.s > 0.25 && x.l > 0.14 && x.l < 0.8);
  const glow = [...mid].sort((a, b) => a.l - b.l);
  const pick: number[] = [];
  const n = Math.min(9, glow.length);
  for (let i = 0; i < n; i++) pick.push(glow[Math.floor((i * (glow.length - 1)) / Math.max(1, n - 1))]!.c);
  const all = [...cols].sort((a, b) => a.h - b.h || a.l - b.l).map((x) => x.c);
  return { dark, glow: pick.length ? pick : dark, light, all };
}

const previews = new Map<string, Sprite>();

export function stagePreview(info: StageInfo, w = PW, h = PH, grey = 0): Sprite {
  const key = `${info.id}:${w}x${h}:${grey}`;
  const hit = previews.get(key);
  if (hit) return hit;
  if (grey > 0) {
    const base = stagePreview(info, w, h, 0);
    const cv = new PixelCanvas(w, h);
    cv.blit(base, 0, 0, { grey });
    const g = cv.toSprite();
    previews.set(key, g);
    return g;
  }
  const sp = splitPalette(info.palette);
  const px = new Uint32Array(w * h);
  const seed = info.index * 101 + 7;
  const ramp = (arr: number[], t: number, x: number, y: number): number => {
    const f = Math.max(0, Math.min(1, t)) * (arr.length - 1);
    const k = Math.min(arr.length - 2, Math.floor(f));
    return arr.length === 1 ? arr[0]! : (f - k) * 16 > BAYER4[(y & 3) * 4 + (x & 3)]! ? arr[k + 1]! : arr[k]!;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = ramp(sp.dark, 0.15 + (y / h) * 0.85, x, y);
      // a diagonal band of gas with fractal edges
      const u = (x / w - 0.5) * 0.9 + (y / h - 0.5) * 0.55;
      const env = Math.exp(-(u * u) / 0.045);
      const n = fbm(x * 0.07 + seed, y * 0.09 + seed * 0.3, seed);
      const v = env * (0.35 + n * 0.9) - 0.2 + (fbm(x * 0.2, y * 0.2, seed + 5) - 0.5) * 0.25;
      if (v > 0.06)
        c = ramp(sp.glow, Math.min(1, (v - 0.06) * 2.1) * (0.45 + 0.55 * (1 - y / h) * 0.6 + 0.3), x, y);
      // stars
      const sr = hash(x, y, seed + 31);
      if (sr > 0.985) c = sp.light[Math.floor(hash(x, y, 9) * sp.light.length)]!;
      px[y * w + x] = c;
    }
  }
  // one bright flare star with a cross
  const fx = Math.floor(w * (0.2 + hash(seed, 1, 3) * 0.6));
  const fy = Math.floor(h * (0.15 + hash(seed, 2, 3) * 0.4));
  const star = sp.light[sp.light.length - 1]!;
  px[fy * w + fx] = star;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const)
    px[(fy + dy) * w + fx + dx] = sp.light[sp.light.length - 2]!;
  const spr = { pixels: px, w, h };
  previews.set(key, spr);
  return spr;
}

/** Choose the screen accent from a stage's brightest saturated colour. */
function stageAccent(info: StageInfo): string {
  const sp = splitPalette(info.palette);
  const c = sp.glow[Math.floor(sp.glow.length * 0.7)] ?? sp.light[0]!;
  return `#${[pr(c), pg(c), pb(c)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Stage select: five stage cards with palette-derived previews and swatches; unimplemented stages are greyed. */
export function createStageScreen(): Screen {
  let index = 0;
  return {
    enter(ctx) {
      index = Math.max(
        0,
        ctx.deps.stages.findIndex((s) => s.id === ctx.setup.stage),
      );
    },
    update(ctx) {
      const n = ctx.nav;
      const cnt = ctx.deps.stages.length;
      if (n.left) {
        index = (index - 1 + cnt) % cnt;
        ctx.sound('move');
      } else if (n.right) {
        index = (index + 1) % cnt;
        ctx.sound('move');
      }
      if (n.back) {
        ctx.sound('back');
        ctx.pop();
      } else if (n.confirm) {
        const st = ctx.deps.stages[index]!;
        if (!ctx.isStageReady(st.id)) {
          ctx.sound('error');
          return;
        }
        ctx.setup.stage = st.id;
        ctx.startMatch();
      }
    },
    draw(ctx) {
      const cv = ctx.cv;
      backdrop(cv, 'bg:0.74:0.62:0.8:', (bg) => {
        scrim(bg, 0.74, 0.62, 0.8);
        vignette(bg);
      });
      header(ctx, 'SELECT STAGE', '무대 선택');
      const stages = ctx.deps.stages;
      stages.forEach((st, i) => {
        const focus = i === index;
        const ready = ctx.isStageReady(st.id);
        const x = X0 + i * (CARD_W + GAP);
        const y = CARD_Y - (focus ? 4 : 0);
        const ramp = accentRamp(stageAccent(st));
        panel(cv, x, y, CARD_W, CARD_H, {
          accent: focus ? ramp.base : undefined,
          border: focus ? ramp.dim : C.line0,
          fill: alpha(C.ink1, 0.9),
          shade: false,
        });
        cv.blit(stagePreview(st, PW, PH, ready ? 0 : 0.92), x + 4, y + 4);
        cv.frame(x + 3, y + 3, PW + 2, PH + 2, focus ? ramp.dim : C.line0);
        if (!ready) comingSoon(ctx, x + CARD_W / 2, y + 4 + PH / 2 - 3);
        drawText(cv, st.name.toUpperCase(), x + CARD_W / 2, y + PH + 9, {
          color: focus ? C.white : ready ? C.soft : C.dim,
          align: 'center',
        });
        drawText(cv, st.nameKo, x + CARD_W / 2, y + PH + 24, {
          color: focus ? ramp.light : C.dim,
          align: 'center',
        });
        // swatches: eight evenly spaced colours of the stage palette
        const sp = splitPalette(st.palette).all;
        for (let k = 0; k < 12; k++) {
          const c = sp[Math.floor((k * (sp.length - 1)) / 11)]!;
          cv.rect(x + 8 + k * 8, y + CARD_H - 14, 7, 6, ready ? c : rgba(60, 60, 68));
        }
      });
      // detail
      const st = stages[index]!;
      const ready = ctx.isStageReady(st.id);
      const ramp = accentRamp(stageAccent(st));
      const dy = CARD_Y + CARD_H + 16;
      panel(cv, X0, dy, 5 * CARD_W + 4 * GAP, 96, { accent: ramp.dim });
      // the long names (Red Giant's Wake) do not fit at double size beside the palette: fall back to single size
      const big =
        measureText(st.name.toUpperCase(), { scale: 2, tracking: 2 }) + 14 + measureText(st.nameKo) <= 360;
      const nameScale = big ? 2 : 1;
      drawText(cv, st.name.toUpperCase(), X0 + 16, dy + (big ? 12 : 16), {
        color: C.white,
        tracking: 2,
        scale: nameScale,
        shadow: alpha(C.void, 0.85),
      });
      drawText(
        cv,
        st.nameKo,
        X0 + 16 + measureText(st.name.toUpperCase(), { scale: nameScale, tracking: 2 }) + 14,
        dy + (big ? 15 : 16),
        { color: ramp.light },
      );
      let ty = dy + 38;
      for (const line of wrapText(st.blurb, 330).slice(0, 3)) {
        drawText(cv, line, X0 + 16, ty, { color: C.soft });
        ty += 13;
      }
      drawText(
        cv,
        `${st.palette.length} COLOURS  ·  ${st.arena.maxX - st.arena.minX} × ${st.arena.maxY - st.arena.minY} ARENA`,
        X0 + 16,
        dy + 80,
        { color: C.dim, font: 'micro', tracking: 1 },
      );
      // full palette ramp on the right
      const all = splitPalette(st.palette).all;
      const bx = X0 + 384;
      const cols = 22;
      all.forEach((c, k) => {
        cv.rect(bx + (k % cols) * 9, dy + 14 + Math.floor(k / cols) * 9, 8, 8, ready ? c : rgba(60, 60, 68));
      });
      drawText(cv, 'PALETTE', bx, dy + 76, { color: C.dim, font: 'micro', tracking: 1 });
      footer(ctx, confirmBack(ctx, 'FIGHT HERE', 'BACK'));
    },
  };
}
