import { LOGICAL_H, LOGICAL_W, type SimEvent } from '@/contracts';
import { computeViewport } from '@/render/viewport';

/**
 * Motion strips taken DURING a real-time run: when a trigger event fires, the displayed frame is grabbed at logical
 * resolution (exact pixels: the integer upscale is undone by nearest sampling) every `every` sim ticks, `count` times,
 * starting `lead` ticks BEFORE the trigger is known (a small ring of recent frames covers the lead-in).
 * Frames stay on the GPU as ImageBitmaps (resized there, no synchronous read-back); the capture tool reads them back and
 * encodes them after the run, so neither ever stalls a frame.
 */
export interface StripTrigger {
  /** Event type to wait for (e.g. 'move', 'hit', 'ko', 'detach'). 'detach' matches matter detach events. */
  event: string;
  slot?: 0 | 1;
  /** For 'move': the move slot ('crush', 'signature', …). */
  moveSlot?: string;
  /** For 'hit': minimum energy. */
  minEnergy?: number;
}

export interface StripRequest {
  name: string;
  trigger: StripTrigger;
  every: number;
  count: number;
  /** Frames to include from before the trigger (taken from the ring; spaced `every` ticks apart). */
  lead: number;
  /** Skip the first `skip` matches of the trigger. */
  skip?: number;
}

export interface StripFrame {
  tick: number;
  wallMs: number;
  rgba: Uint8ClampedArray;
}

interface Grab {
  tick: number;
  wallMs: number;
  bmp: Promise<ImageBitmap | null>;
  /** Used by a strip: never closed by ring eviction. */
  keep: boolean;
}

interface Active {
  req: StripRequest;
  frames: Grab[];
  next: number;
  armedTick: number;
  skipped: number;
  done: boolean;
}

const RING = 24;

export class StripRecorder {
  private readonly active: Active[] = [];
  private readonly ring: Grab[] = [];
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private needRing = false;

  arm(req: StripRequest): void {
    this.active.push({ req, frames: [], next: -1, armedTick: -1, skipped: 0, done: false });
    if (req.lead > 0) this.needRing = true;
  }

  private matches(t: StripTrigger, e: SimEvent): boolean {
    if (t.event === 'detach')
      return e.t === 'matter' && e.kind === 'detach' && (t.slot === undefined || e.slot === t.slot);
    if (e.t !== t.event) return false;
    if (t.slot !== undefined) {
      const s = 'slot' in e ? e.slot : 'attacker' in e ? e.attacker : undefined;
      if (s !== t.slot) return false;
    }
    if (t.moveSlot && (!('moveSlot' in e) || e.moveSlot !== t.moveSlot)) return false;
    if (t.minEnergy !== undefined && (!('energy' in e) || e.energy < t.minEnergy)) return false;
    return true;
  }

  /** After each sim tick. */
  onTick(tick: number, events: readonly SimEvent[]): void {
    for (const a of this.active) {
      if (a.done || a.armedTick >= 0) continue;
      for (const e of events) {
        if (!this.matches(a.req.trigger, e)) continue;
        if (a.skipped < (a.req.skip ?? 0)) {
          a.skipped++;
          break;
        }
        a.armedTick = tick;
        a.next = tick;
        // lead-in from the ring: frames at tick - k*every
        for (let k = a.req.lead; k >= 1; k--) {
          const want = tick - k * a.req.every;
          let best: Grab | null = null;
          for (const f of this.ring) if (f.tick <= want && (!best || f.tick > best.tick)) best = f;
          if (best) {
            best.keep = true;
            a.frames.push(best);
          }
        }
        break;
      }
    }
  }

  /** After each rendered frame. `tick` is the sim tick that frame shows. */
  onFrame(tick: number, wallMs: number, canvas: HTMLCanvasElement): void {
    const want = this.active.some((a) => !a.done && a.armedTick >= 0 && tick >= a.next);
    if (!want && !this.needRing) return;
    const lastRing = this.ring[this.ring.length - 1];
    if (lastRing && lastRing.tick === tick && !want) return;
    const f: Grab = { tick, wallMs, bmp: this.snapshot(canvas), keep: false };
    if (this.needRing) {
      this.ring.push(f);
      if (this.ring.length > RING) {
        const old = this.ring.shift()!;
        if (!old.keep) void old.bmp.then((b) => b?.close());
      }
    }
    for (const a of this.active) {
      if (a.done || a.armedTick < 0 || tick < a.next) continue;
      f.keep = true;
      a.frames.push(f);
      a.next = tick + a.req.every;
      if (a.frames.length >= a.req.count + a.req.lead) a.done = true;
    }
    if (this.active.every((a) => a.done)) this.needRing = false;
  }

  /** GPU-side snapshot of the displayed frame at logical size (nearest): no read-back, so the frame never stalls. */
  private snapshot(canvas: HTMLCanvasElement): Promise<ImageBitmap | null> {
    const L = computeViewport(canvas.width, canvas.height);
    return createImageBitmap(canvas, L.x, L.y, L.w, L.h, {
      resizeWidth: LOGICAL_W,
      resizeHeight: LOGICAL_H,
      resizeQuality: 'pixelated',
    }).catch(() => null);
  }

  private async pixels(g: Grab): Promise<Uint8ClampedArray> {
    this.ctx ??= new OffscreenCanvas(LOGICAL_W, LOGICAL_H).getContext('2d', { willReadFrequently: true });
    const bmp = await g.bmp;
    if (!this.ctx || !bmp) return new Uint8ClampedArray(LOGICAL_W * LOGICAL_H * 4);
    this.ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);
    this.ctx.drawImage(bmp, 0, 0);
    return this.ctx.getImageData(0, 0, LOGICAL_W, LOGICAL_H).data;
  }

  /** Finished (or partially filled) strips, read back to RGBA (call after the run). */
  async take(): Promise<{ name: string; frames: StripFrame[]; armedTick: number }[]> {
    const out: { name: string; frames: StripFrame[]; armedTick: number }[] = [];
    for (const a of this.active) {
      const frames: StripFrame[] = [];
      for (const g of a.frames) frames.push({ tick: g.tick, wallMs: g.wallMs, rgba: await this.pixels(g) });
      out.push({ name: a.req.name, frames, armedTick: a.armedTick });
    }
    return out;
  }

  get pending(): number {
    return this.active.filter((a) => !a.done).length;
  }
}
