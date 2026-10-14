import type { MatterMap } from '@/contracts';
import type { CradleRegion, CradleRig } from '@/titans/kit/cradle/paint';
import { DMath } from '@/contracts/dmath';
import { fsin } from '@/contracts/ftrig';

/**
 * THE LIVING SAIL (WJ feedback round 1: "the sail should visibly FLAP and ripple … the disc should slowly convulse / pulse
 * … even though it looks fast for us, every pulse takes years to fully flesh out"). Presentation only: when the disc's
 * matter is copied into the rig's atlas for drawing, it is copied through a slow, deep warp and a travelling light:
 *  - CONTRACTION waves run from the hub to the rim (a breath every ~8 s): the membrane draws toward the hub and darkens as a
 *    wave passes, then eases out lit;
 *  - the panels FLAP: a long swell travels round the disc (~13 s a turn), lifting the panels and the rim by a few px;
 *  - the hem RIPPLES: shorter waves run along the rim (~7 s).
 * Everything is tick-driven (deterministic, no wall clock), slow and large; never jittery. The matter itself (what is hit)
 * does not move: the warp is at most a few px at the rim.
 */

const TAU = Math.PI * 2;
/** Periods in ticks (60 = 1 s): slow, deep, cosmic. */
const BREATH = 480;
const FLAP = 780;
const HEM = 420;

export class SailSkin {
  private w = 0;
  private h = 0;
  /** Per map cell: disc-space radius (0 hub … 1 rim) and angle; and which cells are membrane-like (they flex). */
  private rho!: Float32Array;
  private phi!: Float32Array;
  /** min(1, rho)^1.6: how much of the swell the cell takes (constant per cell: S19, was a DMath.pow per cell per draw). */
  private reach!: Float32Array;
  /** Unit vector from the cell toward the hub (map px), for the contraction pull. */
  private hx!: Float32Array;
  private hy!: Float32Array;
  /** Lit ramp per material id and each cell's step in its ramp (from its pristine colour). */
  private ramps: readonly (readonly number[])[] = [];
  private rank!: Int8Array;
  private flex!: Uint8Array;
  ready = false;

  prepare(R: CradleRig, disc: CradleRegion): void {
    const m = disc.map;
    this.w = m.w;
    this.h = m.h;
    const n = m.w * m.h;
    this.rho = new Float32Array(n);
    this.phi = new Float32Array(n);
    this.reach = new Float32Array(n);
    this.hx = new Float32Array(n);
    this.hy = new Float32Array(n);
    this.rank = new Int8Array(n).fill(-1);
    this.flex = new Uint8Array(n);
    this.ramps = R.ramps;
    const D = R.disc;
    const cr = DMath.cos(D.roll);
    const sr = DMath.sin(D.roll);
    const ids = R.ids;
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        const dx = x + 0.5 + disc.ox - D.cx;
        const dy = y + 0.5 + disc.oy - D.cy;
        const u = (dx * cr + dy * sr) / D.rx;
        const v = (-dx * sr + dy * cr) / D.ry;
        this.rho[i] = Math.min(1.3, DMath.hypot(u, v));
        this.phi[i] = DMath.atan2(v, u);
        this.reach[i] = DMath.pow(Math.min(1, this.rho[i]!), 1.6);
        const l = DMath.hypot(dx, dy) || 1;
        this.hx[i] = -dx / l;
        this.hy[i] = -dy / l;
        const mat = m.material[i]!;
        if (mat === 0) continue;
        this.flex[i] =
          mat === ids.membrane || mat === ids.sac || mat === ids.vessel || mat === ids.lumen ? 1 : 0;
        this.rank[i] = nearestStep(R.ramps[mat]!, m.baseColor[i]!);
      }
    this.ready = true;
  }

  /**
   * Draw the disc map into the atlas at (sx, sy) through the living warp at tick `t`, with amplitude `amp` (1 = calm and
   * floating; less under attack). Pixels the matter world has changed (wounds, char, cracks) are carried as they are.
   */
  draw(m: MatterMap, out: Uint32Array, outW: number, sx: number, sy: number, t: number, amp: number): void {
    const w = this.w;
    const h = this.h;
    if (m.w !== w || m.h !== h) return;
    const px = m.pixels;
    const base = m.baseColor;
    const mat = m.material;
    const br = (t / BREATH) * TAU;
    const fl = (t / FLAP) * TAU;
    const hm = (t / HEM) * TAU;
    for (let y = 0; y < h; y++) {
      const row = (sy + y) * outW + sx;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const r = this.rho[i]!;
        const a = this.phi[i]!;
        // the swell lifts the panels and the rim (screen-up), growing toward the rim
        // (S19: presentation trig, `fsin`: this runs for every disc cell every other frame)
        const s3 = fsin(3 * a - fl);
        const lift = s3 * 2.6 + fsin(2 * a + fl * 0.6 + 1.3) * 1.2;
        const hem = r > 0.82 ? fsin(9 * a - hm) * 1.4 * (r - 0.82) * 5.5 : 0;
        const k = amp * this.reach[i]!;
        // the contraction wave: a ring travelling hub → rim pulls the tissue toward the hub as it passes
        const wave = fsin(r * 5 - br);
        const pull = Math.max(0, wave) * 1.6 * amp * Math.min(1, r);
        const dy = Math.round(-(lift + hem) * k + this.hy[i]! * pull);
        const dx = Math.round(this.hx[i]! * pull);
        const sxx = x - dx;
        const syy = y - dy;
        let c = 0;
        if (sxx >= 0 && syy >= 0 && sxx < w && syy < h) {
          const j = syy * w + sxx;
          c = px[j]!;
          // the travelling light: the passing contraction darkens what it squeezes, the release after it is lit
          if (c !== 0 && this.flex[j] && c === base[j]) {
            const ramp = this.ramps[mat[j]!]!;
            const s = this.rank[j]!;
            if (s >= 0) {
              const shift = wave > 0.72 ? -1 : wave < -0.8 ? 1 : 0;
              const lit = s3 > 0.85 ? 1 : 0;
              const q = Math.max(0, Math.min(ramp.length - 1, s + shift + lit));
              if (q !== s) c = ramp[q]!;
            }
          }
        }
        out[row + x] = c;
      }
    }
  }
}

/** The step of a ramp nearest a colour. */
function nearestStep(ramp: readonly number[], c: number): number {
  let best = 0;
  let bd = Infinity;
  for (let k = 0; k < ramp.length; k++) {
    const r = ramp[k]!;
    const d =
      Math.abs((r & 255) - (c & 255)) +
      Math.abs(((r >>> 8) & 255) - ((c >>> 8) & 255)) +
      Math.abs(((r >>> 16) & 255) - ((c >>> 16) & 255));
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  return best;
}
