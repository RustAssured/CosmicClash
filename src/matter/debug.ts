import type { DebugOverlayMode, RenderLayer } from '@/contracts';
import type { Body } from './body';
import type { WorldCore } from './core';

export function debugOverlay(_core: WorldCore, _body: Body, _mode: DebugOverlayMode, _cache: Map<string, RenderLayer>): RenderLayer | null {
  return null;
}
