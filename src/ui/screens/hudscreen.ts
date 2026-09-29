import { drawHud } from '../hud';
import type { Screen } from './kit';

/** In-fight HUD: pure presentation. Pause is driven by the app (`showPause`). */
export function createHudScreen(): Screen {
  return {
    update() {
      /* nothing to do: the HUD has no input of its own */
    },
    draw(ctx, hud) {
      if (hud) drawHud(ctx, hud);
    },
  };
}
