import type { DamageResult } from '@/contracts';
import type { Body } from './body';
import type { WorldCore } from './core';
import type { DamageCtx } from './dmg';

export function applyTidal(_ctx: DamageCtx, _res: DamageResult): void {}
export function stepTidal(_core: WorldCore, _body: Body): void {}
