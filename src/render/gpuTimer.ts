/**
 * GPU frame timing through EXT_disjoint_timer_query_webgl2 (available in Chromium on real GPUs; absent in software GL and
 * Safari). One query in flight at a time, polled without blocking; a disjoint event discards the sample. `poll()` returns the
 * newest finished measurement in ms, or null.
 */
interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

export class GpuTimer {
  private pending: WebGLQuery[] = [];
  private open: WebGLQuery | null = null;
  /** Most recent completed measurement in ms (null until the first). */
  last: number | null = null;

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly ext: TimerExt,
  ) {}

  static create(gl: WebGL2RenderingContext): GpuTimer | null {
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
    return ext ? new GpuTimer(gl, ext) : null;
  }

  begin(): void {
    if (this.open || this.pending.length >= 4) return; // never queue up unboundedly
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q); // WebGL2: begin/end live on the context, the extension only names the target
    this.open = q;
  }

  end(): void {
    if (!this.open) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.open);
    this.open = null;
  }

  /** Collect finished queries; returns the newest valid GPU time in ms, else null. */
  poll(): number | null {
    const gl = this.gl;
    let out: number | null = null;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length > 0) {
      const q = this.pending[0]!;
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      if (!disjoint) out = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
      gl.deleteQuery(q);
    }
    if (out !== null) this.last = out;
    return out;
  }

  /** Drop everything (context lost: the query objects are gone). */
  reset(): void {
    this.pending = [];
    this.open = null;
    this.last = null;
  }
}
