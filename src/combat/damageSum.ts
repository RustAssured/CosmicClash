import type { DamageResult } from '@/contracts';

/**
 * A mutable `DamageResult` that sums the results of one blow applied to several bodies (a multi-body fighter: the Witness's
 * region bodies, or a behaviour's front-to-back routing). Summed: cells and masses, impulse. Weighted by cells touched:
 * the contact point and the on-damaged share. Copy the world's result into it at once: the world may reuse its object.
 */
export type DamageSum = { -readonly [K in keyof DamageResult]: DamageResult[K] };

export function makeDamageSum(): DamageSum {
  const s = {} as DamageSum;
  resetDamageSum(s);
  return s;
}

export function resetDamageSum(s: DamageSum): void {
  s.cellsTouched = 0;
  s.cellsRemoved = 0;
  s.massRemoved = 0;
  s.massTransferred = 0;
  s.contactX = NaN;
  s.contactY = NaN;
  s.impulseX = 0;
  s.impulseY = 0;
  s.onDamagedFraction = 0;
  s.revealedInterior = false;
}

/** Add one body's result for the blow to the sum. */
export function addDamageResult(s: DamageSum, r: Readonly<DamageResult>): void {
  const n0 = s.cellsTouched;
  const n1 = r.cellsTouched;
  if (n1 > 0 && Number.isFinite(r.contactX)) {
    if (n0 > 0 && Number.isFinite(s.contactX)) {
      s.contactX = (s.contactX * n0 + r.contactX * n1) / (n0 + n1);
      s.contactY = (s.contactY * n0 + r.contactY * n1) / (n0 + n1);
    } else {
      s.contactX = r.contactX;
      s.contactY = r.contactY;
    }
  }
  if (n0 + n1 > 0) s.onDamagedFraction = (s.onDamagedFraction * n0 + r.onDamagedFraction * n1) / (n0 + n1);
  s.cellsTouched = n0 + n1;
  s.cellsRemoved += r.cellsRemoved;
  s.massRemoved += r.massRemoved;
  s.massTransferred += r.massTransferred;
  s.impulseX += r.impulseX;
  s.impulseY += r.impulseY;
  s.revealedInterior = s.revealedInterior || r.revealedInterior;
}
