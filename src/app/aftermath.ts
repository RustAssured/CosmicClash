import { Btn, LOGICAL_H, LOGICAL_W, makeLayer, rgba, type InputFrame, type RenderLayer } from '@/contracts';
import { PixelCanvas, drawText, measureText } from '@/ui';

/**
 * The AFTERMATH screen (SLICE_PLAN §8, D27): when the deciding KO has played for 1 s the arena freezes and the player can
 * pan, zoom (whole-number, pixel-exact), orbit (screen-plane rotation) and save the image. The match itself is untouched:
 * the app stops stepping it while this is open and resumes it on exit (then the normal results follow).
 *
 * Controls come from the player's own InputFrame (pad or keyboard layout), plus mouse drag / wheel:
 *   stick pan · Y zoom in · X zoom out · ZR / ZL orbit · A save PNG · − show/hide HUD and hints · B or + leave.
 */
export interface AftermathActions {
  save: boolean;
  exit: boolean;
  toggleHud: boolean;
}

const PAN_SPEED = 260; // logical px/s at zoom 1
const ORBIT_SPEED = 0.9; // rad/s
const MAX_ZOOM = 4;

export class Aftermath {
  x: number;
  y: number;
  zoom = 1;
  roll = 0;
  hud = false;
  /** Seconds the "saved" note stays up. */
  private savedFor = 0;
  /** Frames during which hints are hidden (the save frame itself). */
  hideHintsOnce = false;
  private readonly bounds: { minX: number; maxX: number; minY: number; maxY: number };
  /** Drawn as the frame's UI layer (composited after the inspect zoom/orbit, so it never moves). */
  readonly layer: RenderLayer = makeLayer('aftermath-hint', 'screen', 103, LOGICAL_W, LOGICAL_H);
  private readonly cv = new PixelCanvas(LOGICAL_W, LOGICAL_H, this.layer.pixels);

  constructor(x: number, y: number, bounds: { minX: number; maxX: number; minY: number; maxY: number }) {
    this.x = x;
    this.y = y;
    this.bounds = bounds;
  }

  /** One frame of input. `pressed` edges come from the same frame. */
  update(
    input: InputFrame,
    dtSec: number,
    extra: { dragX: number; dragY: number; wheel: number },
  ): AftermathActions {
    const dt = Math.min(0.1, Math.max(0, dtSec));
    const z = this.zoom;
    // pan in screen space: rotate the stick by the view's roll so "up" is always up on screen
    const cs = Math.cos(this.roll);
    const sn = Math.sin(this.roll);
    const sx = input.moveX * PAN_SPEED * dt + extra.dragX;
    const sy = input.moveY * PAN_SPEED * dt + extra.dragY;
    this.x += (cs * sx + sn * sy) / z;
    this.y += (-sn * sx + cs * sy) / z;
    this.x = Math.min(this.bounds.maxX, Math.max(this.bounds.minX, this.x));
    this.y = Math.min(this.bounds.maxY, Math.max(this.bounds.minY, this.y));
    if (input.pressed & Btn.STRIKE || extra.wheel < 0) this.zoom = Math.min(MAX_ZOOM, this.zoom + 1);
    if (input.pressed & Btn.CRUSH || extra.wheel > 0) this.zoom = Math.max(1, this.zoom - 1);
    if (input.held & Btn.ULTIMATE) this.roll += ORBIT_SPEED * dt;
    if (input.held & Btn.GUARD) this.roll -= ORBIT_SPEED * dt;
    this.savedFor = Math.max(0, this.savedFor - dt);
    return {
      save: (input.pressed & Btn.SIGNATURE) !== 0,
      exit: (input.pressed & (Btn.SURGE | Btn.PAUSE)) !== 0,
      toggleHud: (input.pressed & Btn.TRAINING) !== 0,
    };
  }

  noteSaved(): void {
    this.savedFor = 1.6;
  }

  /** Redraw the hint strip; returns false when nothing should be shown (HUD-off still shows the one-line hint). */
  drawHints(): boolean {
    const cv = this.cv;
    cv.clear(0);
    if (this.hideHintsOnce) {
      this.hideHintsOnce = false;
      this.layer.version++;
      return false;
    }
    const line = this.hud
      ? 'STICK PAN  Y/X ZOOM  ZR/ZL ORBIT  A SAVE PNG  - HUD  B BACK'
      : 'AFTERMATH  A SAVE  - HINTS  B BACK';
    const w = measureText(line, { font: 'micro' });
    const y = LOGICAL_H - 10;
    cv.rect((LOGICAL_W - w) / 2 - 4, y - 2, w + 8, 9, rgba(4, 6, 10, 150));
    drawText(cv, line, LOGICAL_W / 2, y, { color: rgba(214, 226, 214), font: 'micro', align: 'center' });
    if (this.savedFor > 0) {
      drawText(cv, 'SAVED', LOGICAL_W / 2, 10, {
        color: rgba(240, 226, 170),
        outline: rgba(0, 0, 0),
        align: 'center',
      });
    }
    this.layer.version++;
    this.layer.dirty = null;
    return true;
  }
}
