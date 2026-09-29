import { makeLayer, rgba, type DebugOverlayMode, type RenderLayer } from '@/contracts';
import type { Body } from './body';
import type { WorldCore } from './core';
import { hash2 } from './util';

/** Debug modes supported by `debugOverlay` (all of DebugOverlayMode). */
export const DEBUG_MODES: readonly DebugOverlayMode[] = [
  'temperature',
  'integrity',
  'bonds',
  'infection',
  'islands',
  'stress',
  'materials',
];

const ramp3 = (t: number, a: number, b: number, c: number): number => {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const lerp = (x: number, y: number, u: number): number => x + (y - x) * u;
  const [p, q, u] = t < 0.5 ? [a, b, t * 2] : [b, c, (t - 0.5) * 2];
  return rgba(
    lerp(p & 255, q & 255, u),
    lerp((p >>> 8) & 255, (q >>> 8) & 255, u),
    lerp((p >>> 16) & 255, (q >>> 16) & 255, u),
    255,
  );
};

/**
 * Training-mode visualisation of one body as a WORLD-space layer (z above the titan) with the body's transform, so it lines
 * up with the sprite exactly. One layer per body is allocated on first use and refilled in place (allocation-free after that).
 */
export function debugOverlay(
  core: WorldCore,
  body: Body,
  mode: DebugOverlayMode,
  cache: Map<string, RenderLayer>,
): RenderLayer | null {
  if (!DEBUG_MODES.includes(mode)) return null;
  const key = `dbg:${body.id}`;
  let layer = cache.get(key);
  if (!layer) {
    layer = makeLayer(`debug-${body.id}`, 'world', 5, body.w, body.h);
    layer.alpha = 0.78;
    cache.set(key, layer);
  }
  const t = body.transform;
  layer.x = t.x;
  layer.y = t.y;
  layer.prevX = t.x;
  layer.prevY = t.y;
  layer.anchorX = t.anchorX;
  layer.anchorY = t.anchorY;
  layer.facing = t.facing;
  layer.lean = t.lean;
  const px = layer.pixels;
  px.fill(0);
  const map = body.map;
  const { w, h, n } = body;
  const mat = map.material;
  const black = rgba(6, 6, 12, 255);
  switch (mode) {
    case 'temperature': {
      const hot = rgba(255, 90, 20, 255);
      const white = rgba(255, 255, 230, 255);
      for (let i = 0; i < n; i++) {
        if (mat[i] === 0) continue;
        const T = map.temperature[i]!;
        px[i] = ramp3(T / 1800, black, hot, white);
      }
      break;
    }
    case 'integrity': {
      const red = rgba(230, 40, 40, 255);
      const yel = rgba(240, 210, 60, 255);
      const grn = rgba(60, 200, 90, 255);
      for (let i = 0; i < n; i++) if (mat[i] !== 0) px[i] = ramp3(map.integrity[i]! / 255, red, yel, grn);
      break;
    }
    case 'bonds': {
      const broken = rgba(255, 40, 200, 255);
      for (let i = 0; i < n; i++) {
        if (mat[i] === 0) continue;
        const x = i % w;
        const bR = x < w - 1 && mat[i + 1] !== 0 ? map.bondR[i]! : 255;
        const bL = x > 0 && mat[i - 1] !== 0 ? map.bondR[i - 1]! : 255;
        const bD = i + w < n && mat[i + w] !== 0 ? map.bondD[i]! : 255;
        const bU = i >= w && mat[i - w] !== 0 ? map.bondD[i - w]! : 255;
        const m = Math.min(bR, bL, bD, bU);
        px[i] =
          m === 0
            ? broken
            : ramp3(m / 255, rgba(200, 60, 40, 255), rgba(220, 200, 60, 255), rgba(60, 180, 220, 255));
      }
      break;
    }
    case 'infection': {
      const crimson = rgba(230, 20, 60, 255);
      for (let i = 0; i < n; i++) {
        if (mat[i] === 0) continue;
        const v = map.infection[i]!;
        px[i] =
          v === 0
            ? rgba(20, 24, 30, 255)
            : ramp3(v / 255, rgba(70, 20, 40, 255), crimson, rgba(255, 200, 200, 255));
      }
      break;
    }
    case 'islands': {
      // Label bond-connected components; colour by id, mark the anchored one (containing the core) bright green.
      const st = core.stack;
      const label = body.aux;
      label.fill(0, 0, n);
      let next = 1;
      const bR = map.bondR;
      const bD = map.bondD;
      for (let s = 0; s < n; s++) {
        if (mat[s] === 0 || label[s] !== 0) continue;
        st.clear();
        st.push(s);
        label[s] = next;
        while (st.size > 0) {
          const c = st.pop();
          const x = c % w;
          if (x < w - 1 && bR[c] !== 0 && label[c + 1] === 0) {
            label[c + 1] = next;
            st.push(c + 1);
          }
          if (x > 0 && bR[c - 1] !== 0 && label[c - 1] === 0) {
            label[c - 1] = next;
            st.push(c - 1);
          }
          if (bD[c] !== 0 && label[c + w] === 0) {
            label[c + w] = next;
            st.push(c + w);
          }
          if (c >= w && bD[c - w] !== 0 && label[c - w] === 0) {
            label[c - w] = next;
            st.push(c - w);
          }
        }
        next++;
      }
      const coreLabel = label[map.coreY * w + map.coreX] || 0;
      for (let i = 0; i < n; i++) {
        if (mat[i] === 0) continue;
        const l = label[i]!;
        if (l === coreLabel && coreLabel !== 0) px[i] = rgba(60, 200, 110, 255);
        else {
          const hh = hash2(l, 7, 1);
          px[i] = rgba(90 + (hh & 127), 90 + ((hh >> 8) & 127), 90 + ((hh >> 16) & 127), 255);
        }
      }
      label.fill(0, 0, n);
      break;
    }
    case 'stress': {
      // Weakness map: cells beside weak/broken bonds glow; crack fronts are drawn white.
      for (let i = 0; i < n; i++) {
        if (mat[i] === 0) continue;
        const x = i % w;
        const bR = x < w - 1 && mat[i + 1] !== 0 ? map.bondR[i]! : 255;
        const bD = i + w < n && mat[i + w] !== 0 ? map.bondD[i]! : 255;
        const m = Math.min(bR, bD);
        const stress = 1 - Math.min(1, m / 140);
        px[i] = ramp3(stress, rgba(20, 30, 60, 255), rgba(200, 80, 40, 255), rgba(255, 240, 120, 255));
      }
      for (let k = 0; k < body.frontCount; k++) {
        const cx = body.frontX[k]!;
        const cy = body.frontY[k]!;
        for (let dy = -1; dy <= 0; dy++)
          for (let dx = -1; dx <= 0; dx++) {
            const x = cx + dx;
            const y = cy + dy;
            if (x >= 0 && y >= 0 && x < w && y < h) px[y * w + x] = rgba(255, 255, 255, 255);
          }
      }
      break;
    }
    case 'materials': {
      for (let i = 0; i < n; i++) {
        if (mat[i] === 0) continue;
        const hh = hash2(mat[i]!, 3, 99);
        px[i] = rgba(60 + (hh & 155), 60 + ((hh >> 8) & 155), 60 + ((hh >> 16) & 155), 255);
      }
      break;
    }
  }
  layer.version++;
  layer.dirty = null;
  layer.visible = true;
  return layer;
}
