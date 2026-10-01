/**
 * Asynchronous read-back of the luminance governor's 1×1 float state (D5 / D24: telemetry needs the frame's mean luminance
 * every frame, and the old canvas snapshot cost ≈ 12 fps on WJ's machine).
 *
 * Each frame the renderer asks for one 16-byte `readPixels` into a PIXEL_PACK_BUFFER (the GPU copies it whenever it gets
 * there; the call itself does not wait) and drops a fence behind it. Later frames poll the fences in order and only copy a
 * buffer out once its fence has signalled, so nothing ever stalls the pipeline. A small ring (4) bounds the frames in flight;
 * if all are busy the frame is skipped (and counted) rather than waiting.
 */
export interface LumaSample {
  /** Renderer frame number and sim tick of the measured frame. */
  frame: number;
  tick: number;
  /** The governor's 300 ms average, the raw mean, the gain applied and the displayed mean (relative luminance 0..1). */
  avg: number;
  raw: number;
  gain: number;
  mean: number;
}

interface Slot {
  buf: WebGLBuffer;
  sync: WebGLSync | null;
  ready: boolean;
  frame: number;
  tick: number;
}

export const LUMA_RING = 6;
/** Frames a read waits before it is collected (the browser's fast read-back path needs the fence to be seen as passed). */
const READ_AFTER = 3;

export class LumaReadback {
  private readonly slots: Slot[] = [];
  /** Indices of slots in flight, oldest first. */
  private readonly order: number[] = [];
  private readonly px = new Float32Array(4);
  /** Frames whose sample was dropped because every slot was still in flight. */
  skipped = 0;
  /** Diagnostics (verification only): when true, GL errors after each call are recorded in `errors`. */
  diag = false;
  readonly errors: string[] = [];
  private err(what: string): void {
    if (!this.diag) return;
    const e = this.gl.getError();
    if (e !== 0 && this.errors.length < 20) this.errors.push(`${what}: 0x${e.toString(16)}`);
  }

  private constructor(private readonly gl: WebGL2RenderingContext) {
    // storage is allocated on a slot's first use, right before its first write (an allocation followed by another fence and
    // then a write reads to Chromium as "written, fenced, written again" and costs a performance warning)
    for (let i = 0; i < LUMA_RING; i++)
      this.slots.push({ buf: gl.createBuffer(), sync: null, frame: 0, tick: 0, ready: false });
  }

  /** Null where WebGL2 fences are unavailable (never in practice: they are core WebGL2). */
  static create(gl: WebGL2RenderingContext | null): LumaReadback | null {
    if (!gl || typeof gl.fenceSync !== 'function') return null;
    return new LumaReadback(gl);
  }

  /**
   * Queue a read of pixel (0,0) of the CURRENTLY BOUND read framebuffer (an RGBA32F target: the caller binds it first).
   * Returns false when the ring is full (the sample is skipped, never waited for).
   */
  capture(frame: number, tick: number): boolean {
    const gl = this.gl;
    let idx = -1;
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i]!.sync === null) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      this.skipped++;
      return false;
    }
    const s = this.slots[idx]!;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.buf);
    if (!s.ready) {
      // COPY, not READ, usage: Chromium shadows READ-usage buffers on every fence and warns each time one is rewritten without
      // its shadow being the copy that was read; a 16-byte read after the fence has passed costs nothing measurable either way
      gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_COPY);
      s.ready = true;
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
    this.err('readPixels');
    // never leave a pack buffer bound: three's own readPixels (captureLogical) would write into it
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    s.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    this.err('fenceSync');
    if (this.diag && !s.sync && this.errors.length < 20) this.errors.push('fenceSync returned null');
    s.frame = frame;
    s.tick = tick;
    this.order.push(idx);
    return true;
  }

  /** Move every completed read (oldest first, stopping at the first that is still in flight) into `out`. */
  poll(out: LumaSample[], frameNow: number): void {
    const gl = this.gl;
    while (this.order.length) {
      const idx = this.order[0]!;
      const s = this.slots[idx]!;
      if (!s.sync) {
        this.order.shift();
        continue;
      }
      if (frameNow - s.frame < READ_AFTER) return;
      const st = gl.clientWaitSync(s.sync, 0, 0);
      if (st !== gl.ALREADY_SIGNALED && st !== gl.CONDITION_SATISFIED) return;
      // read BEFORE deleting the fence: Chromium's fast read-back path ties the buffer's shadow copy to it
      gl.bindBuffer(gl.COPY_READ_BUFFER, s.buf);
      gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, this.px);
      this.err('getBufferSubData');
      gl.bindBuffer(gl.COPY_READ_BUFFER, null);
      gl.deleteSync(s.sync);
      s.sync = null;
      this.order.shift();
      const p = this.px;
      out.push({ frame: s.frame, tick: s.tick, avg: p[0]!, raw: p[1]!, gain: p[2]!, mean: p[3]! });
    }
  }

  dispose(): void {
    const gl = this.gl;
    for (const s of this.slots) {
      if (s.sync) gl.deleteSync(s.sync);
      gl.deleteBuffer(s.buf);
    }
    this.slots.length = 0;
    this.order.length = 0;
  }
}
