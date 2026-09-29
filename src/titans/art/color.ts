import { pb, pg, pr, rgba } from '@/contracts';

/**
 * Opaque, rounded colour blend. (`mix` from the contracts blends alpha as a float and truncates it to 254 on opaque inputs,
 * which would make solid cells translucent — art code always uses this instead.)
 */
export function blend(c0: number, c1: number, t: number): number {
  const u = 1 - t;
  return rgba(
    Math.round(pr(c0) * u + pr(c1) * t),
    Math.round(pg(c0) * u + pg(c1) * t),
    Math.round(pb(c0) * u + pb(c1) * t),
    255,
  );
}
