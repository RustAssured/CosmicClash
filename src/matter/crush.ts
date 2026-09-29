import type { DamageResult } from '@/contracts';
import type { WorldCore } from './core';
import { applyKinetic } from './kinetic';
import type { DamageCtx } from './dmg';

export function applyCrush(ctx: DamageCtx, res: DamageResult): void {
  applyKinetic(ctx, res);
}
export function stepWaves(_core: WorldCore): void {}
