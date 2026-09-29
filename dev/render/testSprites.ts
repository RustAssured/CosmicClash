import { hueShiftRamp, rgba, type RenderLayer, makeLayer } from '@/contracts';
import { Noise2 } from '@/stages/toolkit/noise';

/**
 * Procedural stand-in bodies for exercising the compositor (mirror, lean, emissive, dirty rects). These are TEST
 * fixtures for the sandbox — real titans come from other builders through RenderLayer.
 */

export interface TestBody {
  layer: RenderLayer;
  /** Pulse the glowing core; returns the dirty rect it touched. */
  pulse(t: number): void;
}

const LIGHT = (() => {
  const l = Math.hypot(-0.55, -0.55, 0.63);
  return [-0.55 / l, -0.55 / l, 0.63 / l] as const;
})();

export function makeRockBody(id: string, seed: number, size = 128): TestBody {
  const noise = new Noise2(seed);
  const layer = makeLayer(id, 'world', 0, size, size);
  layer.anchorX = size >> 1;
  layer.anchorY = size >> 1;
  layer.emissive = new Uint8Array(size * size);
  const ramp = hueShiftRamp(0.07, 0.35, 8, { lMin: 0.08, lMax: 0.85, shadowHue: -0.02, lightHue: 0.11 });
  const glow = hueShiftRamp(0.04, 0.95, 6, { lMin: 0.35, lMax: 0.95, shadowHue: -0.01, lightHue: 0.13 });
  const R = size * 0.4;
  const c = size / 2;
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      // lumpy silhouette
      const ang = Math.atan2(dy, dx);
      const rr = R * (0.86 + 0.28 * noise.fbm(Math.cos(ang) * 1.3 + 4, Math.sin(ang) * 1.3 + 4, 4));
      const d = Math.hypot(dx, dy);
      if (d > rr) continue;
      const dome = Math.sqrt(Math.max(0, 1 - (d / rr) ** 2));
      height[y * size + x] = dome * 0.6 + noise.fbm(x / 14, y / 14, 5) * 0.5;
    }
  const core = { x: c - 6, y: c + 4, r: 14 };
  const paint = (): void => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const h = height[i]!;
        if (h === 0) {
          layer.pixels[i] = 0;
          layer.emissive![i] = 0;
          continue;
        }
        const hx = (height[i + 1] ?? h) - (height[i - 1] ?? h);
        const hy = (height[i + size] ?? h) - (height[i - size] ?? h);
        const nx = -hx * 5;
        const ny = -hy * 5;
        const nl = Math.hypot(nx, ny, 1);
        const lam = Math.max(0, (nx * LIGHT[0] + ny * LIGHT[1] + LIGHT[2]) / nl);
        const cell = Math.min(
          ramp.length - 1,
          Math.floor(lam * lam * (ramp.length - 0.01) + (noise.noise(x / 3, y / 3) > 0.35 ? 1 : 0)),
        );
        layer.pixels[i] = ramp[Math.max(0, cell)]!;
        layer.emissive![i] = 0;
      }
  };
  paint();
  const pulse = (t: number): void => {
    const k = 0.5 + 0.5 * Math.sin(t * 2.2);
    const r = core.r + 2;
    const x0 = Math.max(0, Math.floor(core.x - r));
    const y0 = Math.max(0, Math.floor(core.y - r));
    const x1 = Math.min(size, Math.ceil(core.x + r));
    const y1 = Math.min(size, Math.ceil(core.y + r));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = y * size + x;
        if (height[i] === 0) continue;
        const d = Math.hypot(x - core.x, y - core.y);
        if (d < core.r) {
          const f = (1 - d / core.r) * (0.55 + 0.45 * k);
          const gi = Math.min(glow.length - 1, Math.floor(f * glow.length));
          layer.pixels[i] = glow[gi]!;
          layer.emissive![i] = Math.floor(255 * f);
        } else if (layer.emissive![i] !== 0) {
          layer.emissive![i] = 0;
        }
      }
    layer.dirty = { x0, y0, x1, y1 };
    layer.version++;
  };
  return { layer, pulse };
}

export function makeStarBody(id: string, seed: number, size = 128): TestBody {
  const noise = new Noise2(seed);
  const layer = makeLayer(id, 'world', 0, size, size);
  layer.anchorX = size >> 1;
  layer.anchorY = size >> 1;
  layer.emissive = new Uint8Array(size * size);
  const ramp = hueShiftRamp(0.09, 0.9, 9, { lMin: 0.25, lMax: 0.97, shadowHue: -0.01, lightHue: 0.15 });
  const c = size / 2;
  const R = size * 0.34;
  const paint = (t: number): void => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const dx = x - c;
        const dy = y - c;
        const d = Math.hypot(dx, dy);
        if (d > R * 1.35) {
          layer.pixels[i] = 0;
          layer.emissive![i] = 0;
          continue;
        }
        if (d <= R) {
          const gran = noise.fbm(x / 6 + t * 0.3, y / 6 - t * 0.2, 4);
          const limb = Math.sqrt(1 - (d / R) ** 2);
          const f = Math.min(1, 0.25 + 0.55 * limb + 0.35 * (gran - 0.5));
          layer.pixels[i] = ramp[Math.max(0, Math.min(ramp.length - 1, Math.floor(f * ramp.length)))]!;
          layer.emissive![i] = Math.floor(120 + 135 * f);
        } else {
          // prominence-ish halo: sparse, dithered
          const fall = 1 - (d - R) / (R * 0.35);
          const n = noise.fbm(x / 4 - t * 0.4, y / 4, 3);
          if (n * fall > 0.42) {
            layer.pixels[i] = rgba(255, 170 + Math.floor(60 * fall), 60, 255);
            layer.emissive![i] = Math.floor(200 * fall);
          } else {
            layer.pixels[i] = 0;
            layer.emissive![i] = 0;
          }
        }
      }
  };
  paint(0);
  let last = 0;
  const pulse = (t: number): void => {
    if (t - last < 0.1) return;
    last = t;
    paint(t);
    layer.dirty = null; // whole layer changed → full upload path
    layer.version++;
  };
  return { layer, pulse };
}

/** A screen-space layer with world-aligned tick marks: pixel-exact alignment shows when panning (they must not shimmer). */
export function makeGridLayer(): { layer: RenderLayer; update(viewX: number, viewY: number): void } {
  const layer = makeLayer('grid', 'screen', 5, 640, 360);
  layer.alpha = 0.9;
  let lastX = NaN;
  let lastY = NaN;
  const col = rgba(120, 255, 200, 255);
  const col2 = rgba(255, 255, 255, 255);
  const update = (vx: number, vy: number): void => {
    if (vx === lastX && vy === lastY) return;
    lastX = vx;
    lastY = vy;
    layer.pixels.fill(0);
    for (let wx = Math.ceil(vx / 100) * 100; wx < vx + 640; wx += 100) {
      const sx = wx - vx;
      for (let k = 0; k < 6; k++) layer.pixels[k * 640 + sx] = wx % 500 === 0 ? col2 : col;
      for (let k = 354; k < 360; k++) layer.pixels[k * 640 + sx] = col;
    }
    for (let wy = Math.ceil(vy / 100) * 100; wy < vy + 360; wy += 100) {
      const sy = wy - vy;
      for (let k = 0; k < 6; k++) layer.pixels[sy * 640 + k] = col;
      for (let k = 634; k < 640; k++) layer.pixels[sy * 640 + k] = col;
    }
    layer.dirty = null;
    layer.version++;
  };
  return { layer, update };
}

/** Falling sparks in screen space with per-pixel emissive: exercises the debris/particle path and bloom. */
export function makeSparkLayer(): { layer: RenderLayer; step(t: number): void } {
  const layer = makeLayer('sparks', 'screen', 10, 640, 360);
  layer.emissive = new Uint8Array(640 * 360);
  layer.blend = 'add';
  const N = 260;
  const px = new Float32Array(N);
  const py = new Float32Array(N);
  const seed = new Noise2(99);
  for (let i = 0; i < N; i++) {
    px[i] = ((i * 7919) % 640) + 0.5;
    py[i] = ((i * 104729) % 360) + 0.5;
  }
  const step = (t: number): void => {
    layer.pixels.fill(0);
    layer.emissive!.fill(0);
    for (let i = 0; i < N; i++) {
      const x = Math.floor((px[i]! + 40 * Math.sin(t * 0.4 + i) + t * (10 + (i % 5) * 6)) % 640);
      const y = Math.floor((py[i]! + t * (14 + (i % 7) * 5) + 30 * seed.noise(i, t * 0.2)) % 360);
      const o = y * 640 + x;
      const hot = i % 9 === 0;
      layer.pixels[o] = hot ? rgba(255, 210, 120, 255) : rgba(255, 120, 60, 255);
      layer.emissive![o] = hot ? 255 : 160;
    }
    layer.dirty = null;
    layer.version++;
  };
  return { layer, step };
}

/** A tiny HUD-like screen layer to prove the UI composite is crisp, un-bloomed and un-aberrated. */
export function makeUiLayer(): RenderLayer {
  const layer = makeLayer('ui', 'screen', 100, 640, 360);
  const put = (x: number, y: number, w: number, h: number, c: number): void => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) layer.pixels[(y + j) * 640 + x + i] = c;
  };
  const frame = rgba(230, 240, 235, 255);
  const back = rgba(10, 14, 16, 200);
  const a = rgba(168, 189, 178, 255);
  const b = rgba(255, 120, 60, 255);
  put(16, 12, 232, 12, back);
  put(392, 12, 232, 12, back);
  put(18, 14, 170, 8, a);
  put(394, 14, 120, 8, b);
  put(16, 12, 232, 1, frame);
  put(16, 23, 232, 1, frame);
  put(392, 12, 232, 1, frame);
  put(392, 23, 232, 1, frame);
  put(296, 10, 48, 16, back);
  put(296, 10, 48, 1, frame);
  put(296, 25, 48, 1, frame);
  // "99" as blocks
  for (const ox of [304, 322]) {
    put(ox, 14, 12, 2, frame);
    put(ox, 14, 2, 8, frame);
    put(ox + 10, 14, 2, 8, frame);
    put(ox, 19, 12, 2, frame);
    put(ox, 22, 12, 2, frame);
  }
  layer.version = 1;
  return layer;
}
