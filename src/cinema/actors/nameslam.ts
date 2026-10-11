import type { Actor, CineContext, NativeBuffer } from '../types';
import { registerActor } from './index';
import { blit, textSprite, type Sprite } from '../p6/text';

/**
 * NAME SLAM (P6, TRAILER_V3 0:48–1:02): every opponent gets a 6-frame name slam, e.g. `행성 PLANET`, in the game's pixel
 * font with a 1 px outline. Frame 0 lands big and white-hot, frame 1 one step smaller, frames 2–5 settle in the
 * opponent's accent colour with a one-pixel recoil; then it is gone (a cut, no fade). The Korean and English names are the
 * site's (the roster cards), the accents the titans' own (src/titans/*.json ui.accent).
 *
 * params: titan ('planet' | 'blackhole' | 'supernova' | 'nexus' | 'asteroid' | 'lastone' | 'witness' | 'uri'), or name + ko +
 * accent ('lastone' and 'colossus' are the big-eye colossus, The Last One; 'witness' is the five-eyed tendril titan: D36);
 * at (shot seconds of the first frame, default 0), x (centre, default 320), y (top, default 150).
 */
export const NAMES: Record<string, { ko: string; name: string; accent: string }> = {
  planet: { ko: '행성', name: 'PLANET', accent: '#58a6d8' },
  blackhole: { ko: '블랙홀', name: 'BLACK HOLE', accent: '#ff9a3a' },
  supernova: { ko: '초신성', name: 'SUPERNOVA', accent: '#ff9a3c' },
  nexus: { ko: '넥서스', name: 'THE NEXUS', accent: '#d63a4e' },
  asteroid: { ko: '소행성', name: 'THE ASTEROID', accent: '#c9b399' },
  // D36: the colossus is The Last One; the returning tendril titan is The Witness
  lastone: { ko: '마지막 하나', name: 'THE LAST ONE', accent: '#a8bdb2' },
  colossus: { ko: '마지막 하나', name: 'THE LAST ONE', accent: '#a8bdb2' },
  witness: { ko: '목격자', name: 'THE WITNESS', accent: '#c27ae0' },
  uri: { ko: '우리', name: 'URI', accent: '#ffb060' },
};
export const SLAM_FRAMES = 6;

const num = (p: Readonly<Record<string, unknown>>, k: string, d: number): number =>
  typeof p[k] === 'number' ? (p[k] as number) : d;
const str = (p: Readonly<Record<string, unknown>>, k: string): string | undefined =>
  typeof p[k] === 'string' ? (p[k] as string) : undefined;

export function nameslamActor(id: string, depth: number, params: Readonly<Record<string, unknown>>): Actor {
  const d = NAMES[str(params, 'titan') ?? ''] ?? { ko: '', name: '', accent: '#ffffff' };
  const text = `${str(params, 'ko') ?? d.ko} ${str(params, 'name') ?? d.name}`.trim();
  const accent = str(params, 'accent') ?? d.accent;
  const at = num(params, 'at', 0);
  const cx = num(params, 'x', 320);
  const top = num(params, 'y', 150);
  let hot: Sprite | null = null;
  let calm: Sprite | null = null;
  return {
    id,
    depth,
    draw(buf: NativeBuffer, ctx: CineContext) {
      const f = Math.floor((ctx.shotT - at) * 60 + 1e-6);
      if (f < 0 || f >= SLAM_FRAMES) return;
      hot ??= textSprite(text, '#fff4d6', 1);
      calm ??= textSprite(text, accent, 1);
      const scale = f === 0 ? 4 : f === 1 ? 3 : 2;
      const s = f < 2 ? hot : calm;
      const recoil = f === 2 ? 1 : 0;
      const w = s.w * scale;
      blit(buf, s, Math.round(cx - w / 2) + recoil, top - recoil - (scale - 2) * 7, f < 2 ? 255 : 120, scale);
    },
  };
}

registerActor('nameslam', nameslamActor);
