import { hex, pb, pg, pr, type StageInfo } from '@/contracts';

/** Linear-light RGB triple (HDR values allowed). */
export type Rgb = readonly [number, number, number];

const toLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

/** '#rrggbb' → linear RGB. */
export function hexLinear(h: string): [number, number, number] {
  const c = hex(h);
  return [toLinear(pr(c) / 255), toLinear(pg(c) / 255), toLinear(pb(c) / 255)];
}

/** The stage palette split into its ramps, each entry as linear RGB, dark → light. */
export function paletteRamps(info: StageInfo): Rgb[][] {
  const lens = info.ramps ?? [info.palette.length];
  const out: Rgb[][] = [];
  let i = 0;
  for (const n of lens) {
    const ramp: Rgb[] = [];
    for (let k = 0; k < n; k++) ramp.push(hexLinear(info.palette[i++]!));
    out.push(ramp);
  }
  return out;
}

export const scale = (c: Rgb, k: number): [number, number, number] => [c[0] * k, c[1] * k, c[2] * k];
export const add = (a: Rgb, b: Rgb): [number, number, number] => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mixRgb = (a: Rgb, b: Rgb, t: number): [number, number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Position `t` ∈ [0,1] along a ramp, interpolated between neighbouring steps (linear light). */
export function rampAt(ramp: readonly Rgb[], t: number): [number, number, number] {
  const f = Math.min(1, Math.max(0, t)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(f));
  return mixRgb(ramp[i]!, ramp[i + 1]!, f - i);
}
