import { pa, pb, pg, pr, rgba, type SimEvent } from '@/contracts';
import type { Overlay } from './overlay';
import { DMath } from '@/contracts/dmath';

/** Blows below this energy (continuous beams, light pokes) leave the attack overlay alone. */
const MIN_ENERGY = 300;
/** Radius (px) of the cleared disc round the wound, and the soft rim outside it. */
const CLEAR_R = 38;
const RIM = 10;
/** Frames after the hit-stop the wound stays clear, then the frames over which the overlay comes back. */
const HOLD_TICKS = 30;
const RETURN_TICKS = 20;
const MAX_WOUNDS = 4;

/**
 * Lets a struck wound READ (proposal 168): an attacker's own additive overlay (beams, trails, glows) is at full strength on
 * the impact frame, which is what the hit-stop holds, and is cleared from a disc round the wound on the first frame after
 * it, for half a second, then comes back over a third of a second. Presentation only: it reads the hit events and edits the overlay's pixels.
 */
export class WoundVeil {
  private readonly dx = new Float64Array(MAX_WOUNDS);
  private readonly dy = new Float64Array(MAX_WOUNDS);
  private readonly tick = new Int32Array(MAX_WOUNDS).fill(-1_000_000);
  /** Unfrozen frames drawn since the blow (the hit-stop does not count: it holds the impact frame). */
  private readonly age = new Int32Array(MAX_WOUNDS).fill(1_000_000);
  private cursor = 0;

  /** Call from `Behaviour.onDealt`: notes the wound of the blow just landed (the newest 'hit' event of `slot`). */
  note(
    events: readonly SimEvent[],
    slot: number,
    energy: number,
    foeX: number,
    foeY: number,
    tick: number,
  ): void {
    if (energy < MIN_ENERGY) return;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.t !== 'hit' || e.attacker !== slot) continue;
      const k = this.cursor;
      this.cursor = (k + 1) % MAX_WOUNDS;
      // foe-relative: the wound travels with the struck body
      this.dx[k] = e.x - foeX;
      this.dy[k] = e.y - foeY;
      this.tick[k] = tick;
      this.age[k] = 0;
      return;
    }
  }

  /** Call between drawing and `Overlay.end()`, once per drawn frame: dims the overlay over every recent wound. */
  apply(fx: Overlay, foeX: number, foeY: number, tick: number, frozen: boolean): void {
    for (let k = 0; k < MAX_WOUNDS; k++) {
      if (!frozen && tick !== this.tick[k] && this.age[k]! < 1_000_000) this.age[k]!++;
      const age = this.age[k]!;
      // the impact frame itself (age 0) is the peak and is held by the hit-stop; from the next frame the disc is clear
      if (age < 1 || age > HOLD_TICKS + RETURN_TICKS) continue;
      const g = Math.max(0, (age - HOLD_TICKS) / RETURN_TICKS);
      const cx = foeX + this.dx[k]! - fx.ox;
      const cy = foeY + this.dy[k]! - fx.oy;
      const R = CLEAR_R + RIM;
      const x0 = Math.max(0, Math.floor(cx - R));
      const x1 = Math.min(fx.w - 1, Math.ceil(cx + R));
      const y0 = Math.max(0, Math.floor(cy - R));
      const y1 = Math.min(fx.h - 1, Math.ceil(cy + R));
      const px = fx.pixels;
      const em = fx.emissiveBuf;
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const i = y * fx.w + x;
          const c = px[i]!;
          if (pa(c) === 0) continue;
          const d = DMath.hypot(x + 0.5 - cx, y + 0.5 - cy);
          if (d >= R) continue;
          const s = d <= CLEAR_R ? g : g + (1 - g) * ((d - CLEAR_R) / RIM);
          px[i] =
            s <= 0.01 ? 0 : rgba(Math.round(pr(c) * s), Math.round(pg(c) * s), Math.round(pb(c) * s), 255);
          if (em) em[i] = Math.round(em[i]! * s);
        }
      fx.markRect(x0, y0, x1 + 1, y1 + 1);
    }
  }

  reset(): void {
    this.tick.fill(-1_000_000);
    this.age.fill(1_000_000);
  }
}
