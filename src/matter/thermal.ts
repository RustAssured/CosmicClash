import type { DamageResult } from '@/contracts';
import type { Body } from './body';
import type { WorldCore } from './core';
import type { DamageCtx } from './dmg';

export function applyThermal(_ctx: DamageCtx, _res: DamageResult): void {}
export function stepThermal(_core: WorldCore, _body: Body): void {}
