import { LOGICAL_H, LOGICAL_W, localToWorld, type RenderLayer, type ViewRect } from '@/contracts';

/**
 * Minimal software compositor for RenderLayers (pure TS, no DOM): world layers are placed with the same space.ts maths the
 * game uses (facing mirror + integer lean shear), 'add' layers add light, 'normal' layers alpha-composite. It is the sandbox's
 * and the PNG tools' stand-in for the real renderer, so what the sandbox shows is what the layers contain.
 */
const T = { x: 0, y: 0, anchorX: 0, anchorY: 0, facing: 1 as 1 | -1, lean: 0 };
const P = { x: 0, y: 0 };

export function makeFrame(w = LOGICAL_W, h = LOGICAL_H, bg = 0xff1a0c08): Uint32Array {
  return new Uint32Array(w * h).fill(bg);
}

export function blitLayers(
  frame: Uint32Array,
  layers: readonly RenderLayer[],
  view: ViewRect,
  alpha: number,
  fw = LOGICAL_W,
  fh = LOGICAL_H,
): void {
  const sorted = layers.slice().sort((a, b) => a.z - b.z);
  for (const L of sorted) {
    if (!L.visible) continue;
    if (L.space === 'screen') {
      blitScreen(frame, L, fw, fh);
      continue;
    }
    T.x = Math.round(L.prevX + (L.x - L.prevX) * alpha);
    T.y = Math.round(L.prevY + (L.y - L.prevY) * alpha);
    T.anchorX = L.anchorX;
    T.anchorY = L.anchorY;
    T.facing = L.facing;
    T.lean = L.lean;
    const add = L.blend === 'add';
    const la = L.alpha;
    // cheap reject: layer bounds against the view
    const cx = T.x - view.x0;
    const cy = T.y - view.y0;
    if (cx + L.w < -L.anchorX - 400 || cx - L.w > fw + 400 || cy + L.h < -L.anchorY - 400 || cy - L.h > fh + 400) continue;
    for (let ly = 0; ly < L.h; ly++) {
      const row = ly * L.w;
      for (let lx = 0; lx < L.w; lx++) {
        const c = L.pixels[row + lx]!;
        if (c >>> 24 === 0) continue;
        localToWorld(T, lx, ly, P);
        const wx = T.facing === 1 ? Math.round(P.x) : Math.round(P.x) - 1;
        const wy = Math.round(P.y);
        const sx = wx - view.x0;
        const sy = wy - view.y0;
        if (sx < 0 || sy < 0 || sx >= fw || sy >= fh) continue;
        const di = sy * fw + sx;
        const d = frame[di]!;
        if (add) {
          const r = Math.min(255, (d & 255) + (c & 255) * la);
          const g = Math.min(255, ((d >>> 8) & 255) + ((c >>> 8) & 255) * la);
          const b = Math.min(255, ((d >>> 16) & 255) + ((c >>> 16) & 255) * la);
          frame[di] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
        } else {
          const a = ((c >>> 24) / 255) * la;
          if (a >= 0.999) frame[di] = c | 0xff000000;
          else {
            const r = (c & 255) * a + (d & 255) * (1 - a);
            const g = ((c >>> 8) & 255) * a + ((d >>> 8) & 255) * (1 - a);
            const b = ((c >>> 16) & 255) * a + ((d >>> 16) & 255) * (1 - a);
            frame[di] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
          }
        }
      }
    }
  }
}

function blitScreen(frame: Uint32Array, L: RenderLayer, fw: number, fh: number): void {
  const n = Math.min(frame.length, L.pixels.length, fw * fh);
  for (let i = 0; i < n; i++) {
    const c = L.pixels[i]!;
    const a = (c >>> 24) / 255;
    if (a === 0) continue;
    const d = frame[i]!;
    if (L.blend === 'add') {
      frame[i] =
        ((255 << 24) |
          (Math.min(255, ((d >>> 16) & 255) + ((c >>> 16) & 255) * L.alpha) << 16) |
          (Math.min(255, ((d >>> 8) & 255) + ((c >>> 8) & 255) * L.alpha) << 8) |
          Math.min(255, (d & 255) + (c & 255) * L.alpha)) >>>
        0;
    } else {
      const k = a * L.alpha;
      const r = (c & 255) * k + (d & 255) * (1 - k);
      const g = ((c >>> 8) & 255) * k + ((d >>> 8) & 255) * (1 - k);
      const b = ((c >>> 16) & 255) * k + ((d >>> 16) & 255) * (1 - k);
      frame[i] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
  }
}

/** A dusky nebula-ish backdrop so silhouettes read like they do in game. */
export function paintBackdrop(frame: Uint32Array, w = LOGICAL_W, h = LOGICAL_H, tint = 0): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = y / h;
      const g = Math.sin(x * 0.011 + tint) * 0.5 + Math.sin(y * 0.02 + x * 0.004) * 0.5;
      const r = 18 + 22 * t + 6 * g;
      const gr = 10 + 8 * t + 3 * g;
      const b = 34 + 26 * (1 - t) + 10 * g;
      frame[y * w + x] = ((255 << 24) | (Math.max(0, b) << 16) | (Math.max(0, gr) << 8) | Math.max(0, r)) >>> 0;
    }
  }
  // a few stars
  for (let i = 0; i < 90; i++) {
    const x = (i * 7919 + 131) % w;
    const y = (i * 104729 + 17) % h;
    frame[y * w + x] = 0xff9fa8c8;
  }
}
