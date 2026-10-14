/**
 * SHOW FPS (S19): a tiny frame-rate / frame-time readout in the top-left corner, for WJ to watch while playing. Toggled by
 * Options › SHOW FPS or the F3 key. A plain DOM element over the canvas (no effect on the frame it measures beyond a text
 * update four times a second); presentation only.
 *
 * Shows: frames per second over the last second, the worst frame-to-frame time in that second (a hitch shows here even
 * when the average is fine), and the main thread's mean CPU per sim tick and per rendered frame.
 */
export class FpsMeter {
  private el: HTMLDivElement | null = null;
  private on = false;
  private last = -1;
  private frames = 0;
  private worst = 0;
  private windowStart = -1;
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'F3' || e.code === 'F3') {
      e.preventDefault();
      this.set(!this.on);
    }
  };

  constructor() {
    if (typeof window !== 'undefined') window.addEventListener('keydown', this.onKey);
  }

  get visible(): boolean {
    return this.on;
  }

  set(on: boolean): void {
    this.on = on;
    if (typeof document === 'undefined') return;
    if (on && !this.el) {
      const el = document.createElement('div');
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText =
        'position:fixed;left:6px;top:6px;z-index:50;pointer-events:none;font:11px/1.25 ui-monospace,Consolas,monospace;' +
        'color:#d8f0e0;background:rgba(10,12,16,.62);padding:3px 6px;border-radius:3px;white-space:pre;';
      document.body.appendChild(el);
      this.el = el;
    }
    if (this.el) this.el.style.display = on ? 'block' : 'none';
    this.last = -1;
    this.windowStart = -1;
  }

  /** Call once per rendered frame with the frame's timestamp and the loop's rolling CPU means. */
  frame(nowMs: number, msPerTick: number, msPerFrame: number): void {
    if (!this.on || !this.el) return;
    if (this.last >= 0) this.worst = Math.max(this.worst, nowMs - this.last);
    this.last = nowMs;
    if (this.windowStart < 0) {
      this.windowStart = nowMs;
      this.frames = 0;
      this.worst = 0;
      return;
    }
    this.frames++;
    const span = nowMs - this.windowStart;
    if (span < 250) return;
    const fps = (this.frames * 1000) / span;
    this.el.textContent =
      `${fps.toFixed(0)} fps  worst ${this.worst.toFixed(1)} ms\n` +
      `sim ${msPerTick.toFixed(1)} ms/tick  frame ${msPerFrame.toFixed(1)} ms`;
    this.el.style.color = this.worst > 1000 / 55 ? '#ffb070' : '#d8f0e0';
    this.windowStart = nowMs;
    this.frames = 0;
    this.worst = 0;
  }

  dispose(): void {
    if (typeof window !== 'undefined') window.removeEventListener('keydown', this.onKey);
    this.el?.remove();
    this.el = null;
  }
}
