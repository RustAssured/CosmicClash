import { buildVfxInstances, type VfxImpact } from '@/render/vfx';
import { VFX_RAMPS } from '@/render/master';
import { hex } from '@/contracts';
import { BAYER4 } from './palette';

/**
 * The game's shared impact VFX (src/render/vfx.ts, VFX_SPEC) drawn into a native buffer. The elements and their timing are
 * the game's own (`buildVfxInstances`: anticipation pin and pull ring, the stepped star flash, sparks, dust, the shock
 * edge); this file is a CPU port of the fragment shader's shapes (VFX_FRAG), so a weld in the genesis throws exactly the
 * sparks a blow throws in a fight. Rock debris is not drawn: 우리's matter has none (the game skips it for 'uri' too).
 */

const FL = VFX_RAMPS.flash.map((h) => hex(h));
const DUST = VFX_RAMPS.dust.map((h) => hex(h));
/** The pale blue-white of 우리's break-apart ring (the shader's uPal[37]): the top of the field ramp. */
const SNAP = hex('#b0ccff');

const h1 = (a: number, b: number): number => {
  const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

const scratch = new Float32Array(1024 * 12);

export function drawImpacts(
  buf: { w: number; h: number; pixels: Uint32Array; emissive: Uint8Array },
  impacts: readonly VfxImpact[],
): void {
  if (!impacts.length) return;
  const { count } = buildVfxInstances(impacts, 0, 0, scratch);
  const { w: W, h: H, pixels, emissive } = buf;
  const put = (x: number, y: number, c: number, glow: boolean): void => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    pixels[y * W + x] = c;
    emissive[y * W + x] = glow ? 255 : 0;
  };
  for (let n = 0; n < count; n++) {
    const o = n * 12;
    const kind = Math.round(scratch[o]!);
    const cx = scratch[o + 1]!;
    const cy = scratch[o + 2]!;
    const s = scratch[o + 3]!;
    const B = [scratch[o + 4]!, scratch[o + 5]!, scratch[o + 6]!, scratch[o + 7]!];
    const C0 = scratch[o + 8]!;
    const ext = Math.ceil(s + 3);
    for (let py = -ext; py <= ext; py++)
      for (let px = -ext; px <= ext; px++) {
        const X = cx + px;
        const Y = cy + py;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const ox = px;
        const oy = py;
        const th = BAYER4[((Y & 3) << 2) | (X & 3)]!;
        if (kind === 0) {
          if (Math.abs(ox) + Math.abs(oy) > s + 0.1 || (Math.abs(ox) > 0.6 && Math.abs(oy) > 0.6)) continue;
          put(X, Y, FL[5]!, true);
        } else if (kind === 1) {
          if (Math.abs(Math.hypot(ox, oy) - s) > 0.55 || ((X + Y) & 1) === 1) continue;
          put(X, Y, FL[4]!, true);
        } else if (kind === 2) {
          const K = B[0]!;
          const r = Math.hypot(ox, oy);
          const a = Math.atan2(oy, ox) - C0;
          const sector = (Math.PI * 2) / K;
          const sa = ((((a + 0.5 * sector) % sector) + sector) % sector) - 0.5 * sector;
          const idx = Math.floor((a + 0.5 * sector) / sector);
          const ki = ((idx % K) + K) % K;
          const L = 0.55 + 0.45 * h1(B[1]!, ki);
          const wid = 0.55 + 0.45 * h1(B[1]! + 7, ki);
          const lean = (h1(B[1]! + 3, ki) - 0.5) * 0.35 * sector;
          const tri = 1 - Math.abs(sa - lean) / (0.5 * sector * wid);
          const rr = s * (0.26 + (L - 0.26) * Math.pow(Math.max(tri, 0), 2.6));
          if (r > rr + 0.3) continue;
          const f = r / Math.max(rr, 1);
          if (f > 0.78 && th < (f - 0.78) / 0.22) continue;
          const steps = B[3]!;
          const band = Math.floor(f * (steps - 1) * 0.9 + B[2]! * 0.75);
          let ci = 5 - Math.max(0, Math.min(steps - 1, band));
          ci = Math.max(ci, 6 - steps);
          put(X, Y, FL[ci]!, true);
        } else if (kind === 4) {
          const dx = B[0]!;
          const dy = B[1]!;
          const t = ox * -dx + oy * -dy;
          const side = Math.abs(ox * dy - oy * dx);
          if (t < -0.5 || t > s + 0.5 || side > 0.55) continue;
          const ci = 5 - Math.max(0, Math.min(3, Math.floor(B[2]! * 4 + t / Math.max(s, 1))));
          put(X, Y, FL[ci]!, true);
        } else if (kind === 5) {
          const r = Math.hypot(ox, oy) / Math.max(s, 1);
          if (r > 1) continue;
          if (th >= B[0]! * (1 - r * r)) continue;
          put(X, Y, DUST[Math.round(B[1]!)]!, false);
        } else if (kind === 6 || kind === 7) {
          const r = Math.hypot(ox, oy / B[1]!);
          if (Math.abs(r - s) > (kind === 7 ? 1.5 : 0.55) || th >= B[0]!) continue;
          put(X, Y, kind === 7 ? SNAP : FL[3]!, true);
        }
      }
  }
}

export type { VfxImpact };
