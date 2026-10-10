import type { Actor, CineContext, NativeBuffer } from '../types';
import { registerActor } from './index';
import { logoSprite } from '@/ui/pixel/logo';
import { blit, textSprite, type Sprite } from '../p6/text';
import { snap } from '../p4/palette';

/**
 * TITLE (P6, TRAILER_V3 1:31): ADEUK: TITANS · 아득 / FREE IN YOUR BROWSER / FINAL BOSS: COMING, crisp at native resolution.
 * The logotype is the game's own (src/ui/pixel/logo.ts: the same pixels as the title screen and the site), at ×2; the
 * lines are the game's pixel font with a 1 px outline. Each line cuts on at its moment (no fades: no partial alpha);
 * colours snapped to the master palette.
 *
 * params: at (shot seconds the logo lands, default 0), y (top of the logo, default 104), until (shot seconds it cuts to
 * black for the post-title sting, default none).
 */
const num = (p: Readonly<Record<string, unknown>>, k: string, d: number): number =>
  typeof p[k] === 'number' ? (p[k] as number) : d;

export function titleActor(id: string, depth: number, params: Readonly<Record<string, unknown>>): Actor {
  const at = num(params, 'at', 0);
  const top = num(params, 'y', 104);
  const until = num(params, 'until', Infinity);
  let logo: Sprite | null = null;
  let lines: { s: Sprite; t: number; scale: number; dy: number; glow: number }[] = [];
  return {
    id,
    depth,
    init() {
      const L = logoSprite();
      logo = {
        w: L.w,
        h: L.h,
        pixels: Uint32Array.from(L.pixels, (c) => (c >>> 24 ? snap(c) | 0xff000000 : 0) >>> 0),
      };
      lines = [
        { s: textSprite('아득', '#a8bdb2', 2, 6), t: 0.45, scale: 1, dy: 82, glow: 0 },
        { s: textSprite('FREE IN YOUR BROWSER', '#ffd27a', 2, 1), t: 1.1, scale: 1, dy: 124, glow: 90 },
        { s: textSprite('FINAL BOSS: COMING', '#d45e50', 1, 2), t: 1.9, scale: 1, dy: 162, glow: 60 },
      ];
    },
    draw(buf: NativeBuffer, ctx: CineContext) {
      const s = ctx.shotT - at;
      if (s < 0 || s >= until - at) return;
      if (!logo) this.init?.(ctx);
      const LG = logo!;
      blit(buf, LG, Math.round(320 - LG.w), top, 0, 2);
      for (const l of lines)
        if (s >= l.t) blit(buf, l.s, Math.round(320 - (l.s.w * l.scale) / 2), top + l.dy, l.glow, l.scale);
    },
  };
}

registerActor('title', titleActor);
