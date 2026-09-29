import {
  clamp,
  clamp01,
  hex,
  mix,
  pb,
  pg,
  pr,
  rgba,
  smoothstep,
  type MaterialSpec,
  type MatterMap,
  type StageLighting,
} from '@/contracts';
import { boxBlur, edt } from './field';
import { bayer4, bayer8 } from './noise';

/**
 * The ArtCanvas is the working surface every titan generator paints on: per-cell material ids, a relief (height) field,
 * per-cell tone offsets, and optional colour overrides. `render()` turns it into lit pixel art:
 *
 *  relief → normals → lambert against the stage key light → ambient occlusion from cavities → ramp index →
 *  ordered dither between neighbouring ramp steps → rim light on the lit silhouette edge, selective dark outline on the other →
 *  colour overrides stamped on top.
 *
 * Only ramp colours (tinted once by the stage light) ever reach the output, so the result is palette-clean like hand-made art.
 */

export interface ShadeParams {
  /** Multiplier around mid-light: >1 harder shading. */
  contrast: number;
  /** Additive offset on the light value (−0.3 … 0.3). */
  bias: number;
  /** 0 = hard bands, 1 = dither across the whole ramp. */
  dither: number;
  /** Cavity darkening strength 0..1. */
  ao: number;
  /** 0..1 rim-light strength on the lit silhouette edge. */
  rim: number;
  /** 0..1 dark selective outline on the shadow-side silhouette. */
  outline: number;
  /** Normal steepness multiplier for the relief. */
  bump: number;
  /** Use the 8×8 Bayer matrix instead of 4×4 (softer, more organic). */
  bayer8: boolean;
}

export const DEFAULT_SHADE: Readonly<ShadeParams> = Object.freeze({
  contrast: 1.15,
  bias: 0,
  dither: 0.55,
  ao: 0.7,
  rim: 1,
  outline: 1,
  bump: 1,
  bayer8: false,
});

export interface RenderConfig {
  /** Per material id: ramp dark→light (packed), already tinted. Index 0 unused. */
  ramps: readonly (readonly number[] | undefined)[];
  /** Per material id shade parameters (partial overrides of DEFAULT_SHADE). */
  params?: readonly (Partial<ShadeParams> | undefined)[];
  lighting: StageLighting;
  /** Scales the horizontal component of the light (sprites get mirrored, so a top-lit look survives both facings). Default 0.7. */
  lightXBias?: number;
  /** Rim colour blend strength toward `lighting.rim` (0..1). Default 0.55. */
  rimMix?: number;
}

export class ArtCanvas {
  readonly w: number;
  readonly h: number;
  /** Material ids (0 = void). */
  readonly mat: Uint8Array;
  /** Relief height in pixels (up = toward the camera). */
  readonly relief: Float32Array;
  /** Additive tone offset in ramp-step units (+ lighter). */
  readonly tone: Float32Array;
  /** Packed colour overrides (0 = none). Applied after shading and outlining. */
  readonly over: Uint32Array;
  private dCache: Float32Array | null = null;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    const n = w * h;
    this.mat = new Uint8Array(n);
    this.relief = new Float32Array(n);
    this.tone = new Float32Array(n);
    this.over = new Uint32Array(n);
  }

  /** Call after changing which cells are solid. */
  invalidate(): void {
    this.dCache = null;
  }

  /** Distance (px) from each solid cell to the nearest void (≥1 for solid cells; 0 for void). Cached until `invalidate()`. */
  distance(): Float32Array {
    if (!this.dCache) this.dCache = edt(this.mat, this.w, this.h, false);
    return this.dCache;
  }

  solidCount(): number {
    let c = 0;
    for (let i = 0; i < this.mat.length; i++) if (this.mat[i] !== 0) c++;
    return c;
  }

  /** Lit pixel art for every solid cell. Void cells are 0. */
  render(cfg: RenderConfig): Uint32Array {
    const { w, h, mat } = this;
    const n = w * h;
    const d = this.distance();
    const mf = new Float32Array(n);
    for (let i = 0; i < n; i++) mf[i] = mat[i] !== 0 ? 1 : 0;
    const mb = boxBlur(mf, w, h, 2);
    const rn = boxBlur(this.relief, w, h, 1);
    const ra = boxBlur(this.relief, w, h, 6);

    // Light: view space x right, y down, z toward camera. Tame x so mirrored sprites still read as top-lit.
    const xb = cfg.lightXBias ?? 0.7;
    let lx = cfg.lighting.dir[0] * xb;
    let ly = cfg.lighting.dir[1];
    let lz = cfg.lighting.dir[2];
    const ll = Math.hypot(lx, ly, lz) || 1;
    lx /= ll;
    ly /= ll;
    lz /= ll;
    const l2 = Math.hypot(lx, ly) || 1;
    const l2x = lx / l2;
    const l2y = ly / l2;
    const rimCol = hex(cfg.lighting.rim);
    const ambCol = hex(cfg.lighting.ambient);
    const rimMix = cfg.rimMix ?? 0.4;

    const out = new Uint32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const m = mat[i]!;
        if (m === 0) continue;
        const ramp = cfg.ramps[m];
        if (!ramp || ramp.length === 0) {
          out[i] = rgba(255, 0, 255);
          continue;
        }
        const P: ShadeParams = cfg.params?.[m] ? { ...DEFAULT_SHADE, ...cfg.params[m] } : DEFAULT_SHADE;
        const nr = ramp.length;

        // --- normal from the (slightly blurred) relief ---
        const xm = x > 0 ? x - 1 : 0;
        const xp = x < w - 1 ? x + 1 : w - 1;
        const ym = y > 0 ? y - 1 : 0;
        const yp = y < h - 1 ? y + 1 : h - 1;
        const gx = (rn[y * w + xp]! - rn[y * w + xm]!) * 0.5 * P.bump;
        const gy = (rn[yp * w + x]! - rn[ym * w + x]!) * 0.5 * P.bump;
        const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
        const diff = Math.max(0, (-gx * lx - gy * ly + lz) * inv);

        // --- light value: flat surfaces sit high-mid, away-facing slopes fall to ambient ---
        let v = 0.1 + 0.64 * diff;
        const cav = clamp01((ra[i]! - this.relief[i]!) / 5);
        v *= 1 - P.ao * cav * 0.6;
        v = (v - 0.5) * P.contrast + 0.5 + P.bias;

        const s = clamp(v, 0, 1) * (nr - 1) + this.tone[i]!;
        const sc = clamp(s, 0, nr - 1);
        const fl = Math.floor(sc);
        const fr = sc - fl;
        const dw = P.dither * 0.5;
        const t = smoothstep(0.5 - dw, 0.5 + dw + 1e-6, fr);
        const thr = P.bayer8 ? bayer8(x, y) : bayer4(x, y);
        let idx = fl + (t > thr ? 1 : 0);
        idx = idx < 0 ? 0 : idx > nr - 1 ? nr - 1 : idx;
        let col = ramp[idx]!;

        // --- silhouette: rim light on the lit edge, selective outline on the shadow edge ---
        const di = d[i]!;
        if (di <= 2.6) {
          const bx = -(mb[y * w + xp]! - mb[y * w + xm]!) * 0.5;
          const by = -(mb[yp * w + x]! - mb[ym * w + x]!) * 0.5;
          const bl = Math.hypot(bx, by);
          if (bl > 1e-4) {
            const nl = (bx * l2x + by * l2y) / bl;
            if (nl > 0.15 && P.rim > 0) {
              const k = smoothstep(0.15, 0.8, nl) * P.rim;
              const top = ramp[nr - 1]!;
              if (di <= 1.5 && k > 0.2) col = mix(top, rimCol, rimMix * (0.6 + 0.4 * k));
              else if (di <= 2.6 && k > 0.6) col = ramp[Math.max(idx, nr - 2)]!;
            } else if (nl < -0.05 && P.outline > 0 && di <= 1.5) {
              const dark = ramp[0]!;
              col = mix(dark, ambCol, 0.25 * P.outline);
              col = rgba(pr(col) * 0.82, pg(col) * 0.82, pb(col) * 0.86);
            } else if (di <= 1.5 && P.outline > 0) {
              col = mix(col, ramp[0]!, 0.45 * P.outline);
            }
          }
        }
        const ov = this.over[i]!;
        out[i] = ov !== 0 ? ov : col;
      }
    }
    return out;
  }

  /** Write material ids, densities, colours and relief into a MatterMap (bonds/integrity/pixels are matter's job). */
  writeTo(map: MatterMap, colors: Uint32Array, densityOf: (mat: number, i: number) => number): void {
    const n = this.w * this.h;
    let maxRelief = 1;
    for (let i = 0; i < n; i++) if (this.relief[i]! > maxRelief) maxRelief = this.relief[i]!;
    for (let i = 0; i < n; i++) {
      const m = this.mat[i]!;
      map.material[i] = m;
      map.density[i] = m === 0 ? 0 : clamp(Math.round(densityOf(m, i)), 1, 255);
      map.baseColor[i] = m === 0 ? 0 : colors[i]!;
      map.height[i] = m === 0 ? 0 : clamp(Math.round((this.relief[i]! / maxRelief) * 255), 0, 255);
    }
  }
}

/**
 * Build the per-material ramps used by `render`: the JSON ramp (dark→light) tinted by the stage light —
 * shadows drift toward the ambient colour, highlights toward the key light — so the same titan reads correctly
 * under every stage while keeping its identity colour.
 */
export function buildLitRamps(
  specs: readonly MaterialSpec[],
  lighting: StageLighting,
  strength = 1,
): number[][] {
  const key = hex(lighting.color);
  const amb = hex(lighting.ambient);
  const out: number[][] = [[]];
  for (const spec of specs) {
    const base = spec.visual.ramp.map(hex);
    const nr = base.length;
    out.push(
      base.map((c, k) => {
        const t = nr === 1 ? 0.5 : k / (nr - 1);
        const sh = 0.32 * Math.pow(1 - t, 1.6) * strength;
        const hi = 0.2 * Math.pow(t, 2.2) * strength;
        return mix(mix(c, amb, sh), key, hi);
      }),
    );
  }
  return out;
}

/** Packed colour with lightness scaled (used for hand-drawn overrides such as the eye). */
export function shadeColor(c: number, k: number): number {
  return rgba(clamp(pr(c) * k, 0, 255), clamp(pg(c) * k, 0, 255), clamp(pb(c) * k, 0, 255));
}
