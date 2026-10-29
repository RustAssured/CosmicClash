import type { Take } from './edl';
import type { SixtyCfg } from './scan';

/** A take's fight config from its key (`a-b-stage-seed`). */
export function cfgOf(key: string): SixtyCfg {
  const [a, b, stage, seed] = key.split('-');
  return { a, b, stage, seed: Number(seed) } as SixtyCfg;
}

export const rateAt = (t: Take, frame: number): number => {
  let r = 1;
  for (const [f, v] of t.rate ?? []) if (frame >= f) r = v;
  return r;
};

/**
 * Which sim tick and interpolation `alpha` each output frame of a take shows (60 fps): `rate` ticks per frame, slow motion by
 * render-time interpolation between ticks (never held frames), as tools/press/trailer/shoot.ts does.
 */
export function schedule(t: Take, frames: number): { tick: number; alpha: number }[] {
  const out: { tick: number; alpha: number }[] = [];
  let tick = t.t0;
  let p = 0;
  for (let f = 0; f < frames; f++) {
    out.push({ tick, alpha: +p.toFixed(4) });
    p += rateAt(t, f);
    while (p >= 1 - 1e-9) {
      tick++;
      p -= 1;
    }
  }
  return out;
}

export const TAKES_DIR = 'press/sixty/takes';
