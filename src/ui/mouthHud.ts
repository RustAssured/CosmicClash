import { hex, type FighterView } from '@/contracts';
import type { PixelCanvas } from './pixel/canvas';
import { C, alpha, mixRgb, type AccentRamp } from './pixel/palette';
import { drawText, measureText } from './pixel/text';

/**
 * The Mouth's health readout (Gate 3A §5, D37; D31-3: not a health bar): the four jaw-rings seen face-on, in the frame where
 * the others have their bar. Each ring is 25 % of the Mouth's health; it loses arc as its quarter goes and breaks when the
 * quarter is gone; every hit chips the ring of the current quarter (the body's rings chip and break in step). Under it, the
 * neck's six strands: a cut strand is a red mark (three cut at the knockout and the head comes loose). The boss's enraged last
 * ring pulses red.
 */
export interface MouthHud {
  rings: number[];
  chips: number[];
  severed: number;
  boss: boolean;
  enraged: boolean;
}

export const mouthHudOf = (v: FighterView): MouthHud | null =>
  ((v as unknown as { mouth?: MouthHud }).mouth as MouthHud | undefined) ?? null;

const BONE = [hex('#2e201e'), hex('#73594e'), hex('#bfa392'), hex('#efe2d4')];
const RED = hex('#ba3e3c');
const RAW = hex('#ff6040');

/** The four jaw-rings across `w` px at (x, y) (top-left of a 16 px tall band). Ring 0 (the first to go) sits innermost. */
export function drawJawEmblem(
  cv: PixelCanvas,
  x: number,
  y: number,
  w: number,
  m: MouthHud,
  ramp: AccentRamp,
  right: boolean,
  t: number,
): void {
  const R = 7;
  const step = w / 4;
  for (let g = 0; g < 4; g++) {
    // ring 0 goes first: on the inner end (toward the clock), like a bar's depleting end
    const slot = right ? g : 3 - g;
    const cx = Math.round(x + step * slot + step / 2);
    const cy = y + 8;
    const h = Math.max(0, Math.min(1, m.rings[g] ?? 0));
    const rage = m.enraged && h > 0;
    const pulse = rage ? 0.5 + 0.5 * Math.sin(t * 9) : 0;
    const lit = rage ? mixRgb(BONE[3]!, RED, 0.5 + 0.4 * pulse) : BONE[3]!;
    const mid = rage ? mixRgb(BONE[2]!, RED, 0.6) : BONE[2]!;
    // the arc still standing runs clockwise from the top; the rest is the dark socket of what broke away
    const n = 48;
    const chips = m.chips[g] ?? 0;
    for (let k = 0; k < n; k++) {
      const f = k / n;
      const a = -Math.PI / 2 + f * Math.PI * 2;
      const standing = f < h;
      // chips: notches at fixed places on the ring (a hash of ring and chip), only on what still stands
      let notch = false;
      for (let c = 0; c < Math.min(chips, 10); c++) {
        const at = (((g * 0.37 + c * 0.618) % 1) + 1) % 1;
        if (Math.abs(f - at * h) < 0.012) notch = true;
      }
      for (let r = R - 1; r <= R; r++) {
        const px = Math.round(cx + Math.cos(a) * r);
        const py = Math.round(cy + Math.sin(a) * r);
        if (!standing) {
          if (h <= 0 && k % 6 < 2) cv.put(px, py, alpha(BONE[1]!, 0.5));
          else if (h > 0) cv.put(px, py, alpha(BONE[0]!, 0.85));
          continue;
        }
        if (notch) continue;
        // lit from the upper left (the one sky), the ring's inner pixel a step darker
        const l = Math.cos(a + Math.PI * 0.75);
        cv.put(px, py, r === R ? (l > 0.2 ? lit : mid) : BONE[1]!);
      }
      // saw-claws inside the ring, every eighth of its turn
      if (standing && !notch && k % 6 === 0) {
        const px = Math.round(cx + Math.cos(a) * (R - 2));
        const py = Math.round(cy + Math.sin(a) * (R - 2));
        cv.put(px, py, mid);
      }
    }
    if (h <= 0) {
      // broken: a crack across the socket
      cv.put(cx - 1, cy - 1, alpha(RED, 0.8));
      cv.put(cx, cy, alpha(RED, 0.8));
      cv.put(cx + 1, cy + 1, alpha(RED, 0.8));
    } else if (h < 1) {
      // the quarter being eaten: the throat's glow at the centre
      cv.put(cx, cy, mixRgb(RAW, C.white, 0.2 * pulse));
    }
  }
  void ramp;
}

/** The six neck strands under the emblem: a red mark for each cut one. Returns the width drawn. */
export function drawStrands(cv: PixelCanvas, x: number, y: number, m: MouthHud, right: boolean): number {
  const label = m.enraged ? 'ENRAGED' : 'STRANDS';
  const lw = measureText(label, { font: 'micro', tracking: 1 });
  drawText(cv, label, x, y + 1, {
    color: m.enraged ? RED : C.dim,
    font: 'micro',
    tracking: 1,
    align: right ? 'right' : 'left',
  });
  const gx = right ? x - lw - 6 - 6 * 4 : x + lw + 6;
  for (let i = 0; i < 6; i++) {
    const cut = i < m.severed;
    const sx = gx + i * 4;
    cv.rect(sx, y, 2, 5, cut ? RAW : BONE[1]!);
    if (cut) cv.put(sx, y + 2, C.void);
  }
  return lw + 6 + 24;
}
