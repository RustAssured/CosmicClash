import { LOGICAL_H, LOGICAL_W, type MatterBody, type RenderLayer, type ViewRect } from '@/contracts';

/**
 * Pure-TS compositor used by the Node scripts and the dev sandbox to look at the matter world: draws body sprites (with
 * mirroring and lean shear exactly as space.ts defines them) between the matter debris layers.
 */
export function drawBody(dst: Uint32Array, body: MatterBody, view: ViewRect): void {
  const m = body.map;
  const t = body.transform;
  const X = Math.round(t.x);
  const Y = Math.round(t.y);
  for (let y = 0; y < m.h; y++) {
    const shift = t.lean === 0 ? 0 : Math.round((t.lean * (t.anchorY - y)) / Math.max(1, t.anchorY));
    const wy = Y + (y - t.anchorY) - view.y0;
    if (wy < 0 || wy >= LOGICAL_H) continue;
    for (let x = 0; x < m.w; x++) {
      const c = m.pixels[y * m.w + x]!;
      if (c >>> 24 === 0) continue;
      const wx = (t.facing === 1 ? X + (x - t.anchorX) : X - (x - t.anchorX) - 1) + shift - view.x0;
      if (wx < 0 || wx >= LOGICAL_W) continue;
      dst[wy * LOGICAL_W + wx] = c;
    }
  }
}

export function drawLayer(dst: Uint32Array, layer: RenderLayer): void {
  if (!layer.visible) return;
  const p = layer.pixels;
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c >>> 24 !== 0) dst[i] = c;
  }
}

/** Composite background + back debris + bodies + front fx into a logical-resolution frame. */
export function composeFrame(
  layers: RenderLayer[],
  bodies: MatterBody[],
  view: ViewRect,
  bg = 0xff1a0c08,
  emissiveGlow = true,
): Uint32Array {
  const dst = new Uint32Array(LOGICAL_W * LOGICAL_H).fill(bg);
  // subtle star field so debris reads against something
  for (let i = 0; i < 90; i++) {
    const x = (i * 7919) % LOGICAL_W;
    const y = (i * 104729) % LOGICAL_H;
    dst[y * LOGICAL_W + x] = 0xff5a4a48;
  }
  for (const l of layers) if (l.z < 0) drawLayer(dst, l);
  for (const b of bodies) drawBody(dst, b, view);
  for (const l of layers) if (l.z >= 0) drawLayer(dst, l);
  if (emissiveGlow) {
    // cheap bloom preview: brighten around emissive pixels
    const emi = layers.find((l) => l.emissive && l.z >= 0)?.emissive;
    if (emi) {
      for (let y = 1; y < LOGICAL_H - 1; y++)
        for (let x = 1; x < LOGICAL_W - 1; x++) {
          const e = emi[y * LOGICAL_W + x]!;
          if (e < 120) continue;
          for (const o of [-1, 1, -LOGICAL_W, LOGICAL_W]) {
            const i = y * LOGICAL_W + x + o;
            const c = dst[i]!;
            const r = Math.min(255, (c & 255) + (e >> 3));
            const g = Math.min(255, ((c >>> 8) & 255) + (e >> 4));
            const b = Math.min(255, ((c >>> 16) & 255) + (e >> 5));
            dst[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
          }
        }
    }
  }
  return dst;
}
