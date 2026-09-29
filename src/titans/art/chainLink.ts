import { clamp } from '@/contracts';

/**
 * One link of a forged chain, rasterised with hand shading: a face-on link is a ring with a real hole (a torus seen from above),
 * an edge-on link is a bar (a capsule). Shared by the Nexus painter (which stamps links into its matter map) and the Nexus
 * behaviour (which draws live chains into an overlay), so painted and animated chains match exactly.
 */

/** Key light for the links, upper left and toward the camera. */
const LX = -0.55;
const LY = -0.7;
const LZ = 0.62;

/** Receives every covered pixel: its integer cell and the light on it, −0.6 … 1 (turn it into a ramp index with `linkIndex`). */
export type LinkSink = (px: number, py: number, light: number) => void;

const sdStadium = (u: number, v: number, a: number, b: number): number => {
  const q = Math.max(Math.abs(u) - (a - b), 0);
  return Math.hypot(q, v) - b;
};

/** Half-lengths and radii of the two link kinds (px). */
export const LINK = { ringA: 5.3, ringB: 3.6, barA: 4.5, barB: 2.2, pitch: 7 } as const;

/**
 * Rasterise a link centred on (x,y) with the chain running along the unit vector (tx,ty). `ring` selects face-on (with the hole)
 * or edge-on. Calls `sink` once per covered pixel.
 */
export function rasterLink(
  x: number,
  y: number,
  tx: number,
  ty: number,
  ring: boolean,
  sink: LinkSink,
): void {
  const a = ring ? LINK.ringA : LINK.barA;
  const b = ring ? LINK.ringB : LINK.barB;
  const R = Math.ceil(a) + 2;
  const e = 0.35;
  const cA = a - 1.1;
  const cB = b - 1.0;
  for (let yy = Math.floor(y - R); yy <= Math.ceil(y + R); yy++) {
    for (let xx = Math.floor(x - R); xx <= Math.ceil(x + R); xx++) {
      const dx = xx + 0.5 - x;
      const dy = yy + 0.5 - y;
      const u = dx * tx + dy * ty;
      const v = -dx * ty + dy * tx;
      if (sdStadium(u, v, a, b) >= 0) continue;
      let wx: number;
      let wy: number;
      if (ring) {
        if (sdStadium(u, v, a - 2.2, b - 2.0) < 0) continue; // the hole
        // torus: the tube's centre curve is a stadium half a wall thickness inside the outer one
        const dC = sdStadium(u, v, cA, cB);
        const gu = (sdStadium(u + e, v, cA, cB) - sdStadium(u - e, v, cA, cB)) / (2 * e);
        const gv = (sdStadium(u, v + e, cA, cB) - sdStadium(u, v - e, cA, cB)) / (2 * e);
        const w = clamp(dC / 1.15, -1, 1);
        const gl = Math.hypot(gu, gv) || 1;
        wx = ((gu * tx - gv * ty) / gl) * w;
        wy = ((gu * ty + gv * tx) / gl) * w;
      } else {
        // capsule: the normal leans away from the axis segment
        const cu = clamp(u, -(a - b), a - b);
        const ox = (u - cu) / b;
        const oy = v / b;
        wx = ox * tx - oy * ty;
        wy = ox * ty + oy * tx;
      }
      const z = Math.sqrt(Math.max(0, 1 - wx * wx - wy * wy));
      sink(xx, yy, wx * LX + wy * LY + z * LZ);
    }
  }
}

/** Ramp index (0 … n−1) for a light value from `rasterLink`; the brightest cells take the specular index. */
export function linkIndex(light: number, toneBias: number, n: number): number {
  if (light > 0.92) return n - 2;
  return clamp(Math.round(1.1 + (light + 0.35) * 3.7 + toneBias), 0, n - 1);
}

/** Pixel offsets of the two rivets of a face-on link (along the chain axis), for the caller to stamp. */
export const RIVET_OFFSET = LINK.ringA - 1.4;
