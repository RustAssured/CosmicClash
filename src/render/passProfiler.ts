/**
 * Per-pass frame profiler (S21, perf tooling only). Off by default and then free: every `mark()` is one branch.
 *
 * Turned on by the page URL `?prof=1` (tools/perf/frameprof.ts). Then each frame is cut into named sections:
 *  - CPU: performance.now() between consecutive marks (main thread, including GL command submission),
 *  - GPU: one EXT_disjoint_timer_query_webgl2 TIME_ELAPSED query per section (sections never overlap, so the queries
 *    never nest), collected a few frames later without blocking. A disjoint event drops the frame's GPU samples.
 * `window.__ADEUK_PROF__` exposes `report()` / `reset()` for the tool. Presentation only: the sim never sees it.
 */

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

export interface SectionStats {
  name: string;
  n: number;
  cpuMean: number;
  cpuP95: number;
  gpuN: number;
  gpuMean: number;
  gpuP95: number;
}

const heap = (): number =>
  (typeof performance !== 'undefined' &&
    (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize) ||
  0;
/** A frame whose main-thread CPU reaches this is kept whole in `report().spikes`. */
const SPIKE_MS = 12;
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class PassProfiler {
  /** Sections (marks) and GPU queries. */
  on = false;
  /** Whole-loop CPU per rendered frame only (ticks since the last frame + the frame): `?prof=lite` or `?prof=1`. */
  lite = false;
  private loopAcc = 0;
  private loopTicks = 0;
  private readonly loopFrames: number[] = [];
  /** Sim ticks run before each rendered frame (1 at a steady 60 Hz; 0 / 2 = judder). */
  private readonly loopTickCounts: number[] = [];

  /** The app reports each sim tick's and each rendered frame's main-thread ms (no-op unless profiling). */
  loopTick(ms: number): void {
    if (!this.lite) return;
    this.loopAcc += ms;
    this.loopTicks++;
  }
  loopFrame(ms: number): void {
    if (!this.lite) return;
    this.loopFrames.push(this.loopAcc + ms);
    this.loopTickCounts.push(this.loopTicks);
    this.loopAcc = 0;
    this.loopTicks = 0;
  }
  /** CPU ms per rendered frame recorded since the last reset (ticks folded into the frame they precede). */
  loopReport(): number[] {
    return this.loopFrames.slice();
  }
  loopTicksReport(): number[] {
    return this.loopTickCounts.slice();
  }

  private gl: WebGL2RenderingContext | null = null;
  private ext: TimerExt | null = null;
  private cur: string | null = null;
  private curAt = 0;
  private curQuery: WebGLQuery | null = null;
  private readonly cpu = new Map<string, number[]>();
  private readonly gpu = new Map<string, number[]>();
  private pending: { name: string; q: WebGLQuery }[] = [];
  private readonly free: WebGLQuery[] = [];
  /** Whole frames (first mark → `end()`), CPU. */
  private readonly frames: number[] = [];
  private frameAt = -1;
  private heapAt = 0;
  /** This frame's sections (CPU ms), and the slowest frames kept whole (`spikes`, CPU ≥ SPIKE_MS). */
  private readonly curFrame: [string, number][] = [];
  private readonly spikes: {
    at: number;
    ms: number;
    sections: [string, number][];
    counts: Record<string, number>;
  }[] = [];
  private counts: Record<string, number> = {};

  /** Count something this frame (texture creations, uploaded texels ?); kept with a spike's record. */
  count(name: string, n = 1): void {
    if (this.on) this.counts[name] = (this.counts[name] ?? 0) + n;
  }

  /** Use this context's timer queries for the GPU side (null: CPU only). */
  attach(gl: WebGL2RenderingContext | null): void {
    this.gl = gl;
    this.ext = gl ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null) : null;
    this.pending = [];
    this.free.length = 0;
  }

  get gpuAvailable(): boolean {
    return this.ext !== null;
  }

  /** End the open section (if any) and open `name` (null: just close). */
  mark(name: string | null): void {
    if (!this.on) return;
    const t = now();
    if (this.frameAt < 0) {
      this.frameAt = t;
      this.heapAt = heap();
    }
    if (this.cur !== null) {
      push(this.cpu, this.cur, t - this.curAt);
      this.curFrame.push([this.cur, t - this.curAt]);
      if (this.curQuery && this.gl && this.ext) {
        this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
        this.pending.push({ name: this.cur, q: this.curQuery });
      }
      this.curQuery = null;
    }
    this.cur = name;
    this.curAt = t;
    if (name !== null && this.gl && this.ext && this.pending.length < 256) {
      const q = this.free.pop() ?? this.gl.createQuery();
      if (q) {
        this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
        this.curQuery = q;
      }
    }
  }

  /** Close the frame: the open section ends, finished GPU queries are collected. */
  end(): void {
    if (!this.on) return;
    this.mark(null);
    if (this.frameAt >= 0) {
      const ms = now() - this.frameAt;
      this.frames.push(ms);
      // a heap that shrank inside the frame = a garbage collection ran in it (Edge with --enable-precise-memory-info)
      const drop = this.heapAt - heap();
      if (drop > 256 * 1024) this.counts['gcMB'] = +(drop / 1048576).toFixed(1);
      if (ms >= SPIKE_MS && this.spikes.length < 60)
        this.spikes.push({
          at: this.frameAt,
          ms,
          sections: this.curFrame.filter((x) => x[1] >= 0.5).map((x) => [x[0], +x[1].toFixed(2)]),
          counts: this.counts,
        });
    }
    this.curFrame.length = 0;
    this.counts = {};
    this.frameAt = -1;
    this.poll();
  }

  private poll(): void {
    const gl = this.gl;
    const ext = this.ext;
    if (!gl || !ext) return;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
    let i = 0;
    for (; i < this.pending.length; i++) {
      const p = this.pending[i]!;
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!disjoint) push(this.gpu, p.name, (gl.getQueryParameter(p.q, gl.QUERY_RESULT) as number) / 1e6);
      this.free.push(p.q);
    }
    if (i > 0) this.pending.splice(0, i);
  }

  reset(): void {
    this.cpu.clear();
    this.gpu.clear();
    this.frames.length = 0;
    this.spikes.length = 0;
    this.curFrame.length = 0;
    this.loopFrames.length = 0;
    this.loopTickCounts.length = 0;
    this.loopAcc = 0;
    this.loopTicks = 0;
  }

  report(): {
    sections: SectionStats[];
    frame: { n: number; mean: number; p95: number };
    gpu: boolean;
    spikes: { at: number; ms: number; sections: [string, number][]; counts: Record<string, number> }[];
  } {
    const sections: SectionStats[] = [];
    for (const [name, a] of this.cpu) {
      const g = this.gpu.get(name) ?? [];
      sections.push({
        name,
        n: a.length,
        cpuMean: mean(a),
        cpuP95: pct(a, 0.95),
        gpuN: g.length,
        gpuMean: mean(g),
        gpuP95: pct(g, 0.95),
      });
    }
    return {
      sections,
      frame: { n: this.frames.length, mean: mean(this.frames), p95: pct(this.frames, 0.95) },
      gpu: this.ext !== null,
      spikes: this.spikes.slice(),
    };
  }
}

function push(m: Map<string, number[]>, k: string, v: number): void {
  let a = m.get(k);
  if (!a) m.set(k, (a = []));
  a.push(v);
}
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
function pct(a: number[], q: number): number {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

/** The one profiler (app + renderer sections share a frame). */
export const PROF = new PassProfiler();

if (typeof location !== 'undefined') {
  const p = new URLSearchParams(location.search).get('prof');
  if (p === '1' || p === 'lite') {
    PROF.on = p === '1';
    PROF.lite = true;
    (window as unknown as { __ADEUK_PROF__: PassProfiler }).__ADEUK_PROF__ = PROF;
  }
}
