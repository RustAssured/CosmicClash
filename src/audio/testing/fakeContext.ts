/**
 * A minimal, STRICT fake of the Web Audio API for Node tests. It does no DSP; it enforces the rules the real API throws on
 * (exponential ramps to ≤ 0, non-finite values, negative times, start/stop misuse, connecting to a foreign context's node) and
 * records what was built, so wiring bugs surface in unit tests instead of in a browser at 2 a.m.
 */
export class WebAudioViolation extends Error {}

/**
 * Every violation is BOTH thrown and recorded here. The engine deliberately swallows exceptions from a misbehaving voice (one
 * bad sound must not take the frame down), which would also hide the very bugs this fake exists to find; tests therefore
 * assert `takeViolations()` is empty rather than relying on a throw reaching them.
 */
const recorded: string[] = [];
export const takeViolations = (): string[] => recorded.splice(0, recorded.length);

const fail = (msg: string): never => {
  recorded.push(msg);
  throw new WebAudioViolation(msg);
};
const finite = (v: number, what: string): void => {
  if (!Number.isFinite(v)) fail(`${what} must be finite, got ${v}`);
};

export class FakeParam {
  private v0: number;
  readonly events: { type: string; v: number; t: number; tc?: number }[] = [];
  constructor(
    private readonly ctx: FakeContext,
    readonly name: string,
    v = 0,
  ) {
    this.v0 = v;
  }
  /** The intrinsic value. Like the real `AudioParam.value` (a WebIDL `float`), a non-finite value throws a TypeError. */
  get value(): number {
    return this.v0;
  }
  set value(v: number) {
    finite(v, `${this.name}.value`);
    this.v0 = v;
  }
  /**
   * The value the automation timeline gives at time `t` (s), evaluated the way the spec does for the event kinds the voices use
   * (set, linear and exponential ramps, setTarget, value curves start value). Lets tests check where a param ENDS UP, e.g. that a
   * duck comes back to 1, without rendering audio.
   */
  valueAt(t: number): number {
    let v = this.v0;
    let prevT = 0;
    let prevV = this.v0;
    const ev = this.events;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]!;
      if (e.type === 'lin' || e.type === 'exp') {
        // a ramp runs from the previous event (time and value) to its own
        if (t >= e.t) {
          v = e.v;
        } else {
          const k = e.t > prevT ? Math.max(0, (t - prevT) / (e.t - prevT)) : 1;
          if (e.type === 'lin') v = prevV + (e.v - prevV) * k;
          else v = prevV > 0 && e.v > 0 ? prevV * Math.pow(e.v / prevV, k) : prevV;
          return v;
        }
        prevT = e.t;
        prevV = v;
        continue;
      }
      if (e.t > t) return v;
      if (e.type === 'target') {
        const next = ev[i + 1];
        const until = next && next.type !== 'lin' && next.type !== 'exp' ? Math.min(t, next.t) : t;
        const start = v;
        v = e.v + (start - e.v) * Math.exp(-(until - e.t) / Math.max(1e-9, e.tc ?? 0));
      } else v = e.v;
      prevT = e.t;
      prevV = v;
    }
    return v;
  }
  private chk(v: number, t: number, what: string): void {
    finite(v, `${this.name}.${what} value`);
    finite(t, `${this.name}.${what} time`);
    if (t < 0) fail(`${this.name}.${what}: negative time ${t}`);
  }
  /**
   * Insert in time order (stable for equal times, like the real timeline) and reject an event that lands strictly INSIDE an
   * existing ramp's span. Chromium evaluates a ramp from whichever event precedes it, so a later-inserted event in the
   * middle silently re-bases the ramp; with many overlapping exponential ramps the value diverges (measured: gain 1e8+, then
   * NaN in every filter downstream). The spec calls it undefined; the fake makes it a test failure.
   */
  private insert(type: string, v: number, t: number, what: string, tc?: number): void {
    const ev = this.events;
    let i = ev.length;
    while (i > 0 && ev[i - 1]!.t > t) i--;
    for (let k = i; k < ev.length; k++) {
      const r = ev[k]!;
      if (r.type !== 'lin' && r.type !== 'exp') continue;
      const start = k > 0 ? ev[k - 1]!.t : -Infinity;
      if (t > start && t < r.t)
        fail(
          `${this.name}.${what} at ${t.toFixed(4)} lands inside a ${r.type} ramp (${start.toFixed(4)} → ${r.t.toFixed(4)}): overlapping automation`,
        );
    }
    ev.splice(i, 0, tc === undefined ? { type, v, t } : { type, v, t, tc });
  }
  setValueAtTime(v: number, t: number): this {
    this.chk(v, t, 'setValueAtTime');
    this.insert('set', v, t, 'setValueAtTime');
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.chk(v, t, 'linearRamp');
    this.insert('lin', v, t, 'linearRamp');
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    this.chk(v, t, 'exponentialRamp');
    if (v <= 0) fail(`${this.name}.exponentialRampToValueAtTime target must be > 0, got ${v}`);
    this.insert('exp', v, t, 'exponentialRamp');
    return this;
  }
  setTargetAtTime(v: number, t: number, tc: number): this {
    this.chk(v, t, 'setTarget');
    if (!(tc > 0) && tc !== 0) fail(`${this.name}.setTargetAtTime timeConstant invalid ${tc}`);
    // Chromium: a second setTargetAtTime at the very instant of another, with a different time constant, restarts from the
    // parameter's intrinsic value (measured: an oscillator retargeted to 55 Hz twice at t = 0 glided down from its default
    // 440 Hz over several seconds). Same target and time constant twice is harmless (a per-frame call in one audio quantum).
    for (const e of this.events)
      if (e.type === 'target' && e.t === t && e.tc !== tc)
        fail(
          `${this.name}.setTargetAtTime at ${t.toFixed(4)} repeats an instant with a different time constant: it re-bases from the default value`,
        );
    this.insert('target', v, t, 'setTarget', tc);
    return this;
  }
  setValueCurveAtTime(curve: ArrayLike<number>, t: number, dur: number): this {
    if (curve.length < 2) fail(`${this.name}.setValueCurveAtTime needs ≥ 2 points`);
    for (let i = 0; i < curve.length; i++) finite(curve[i]!, `${this.name} curve[${i}]`);
    this.chk(curve[0]!, t, 'setValueCurve');
    if (!(dur > 0)) fail(`${this.name}.setValueCurveAtTime duration must be > 0`);
    this.insert('curve', curve[0]!, t, 'setValueCurve');
    return this;
  }
  cancelScheduledValues(t: number): this {
    finite(t, 'cancelScheduledValues time');
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i]!.t >= t) this.events.splice(i, 1);
    return this;
  }
  get context(): FakeContext {
    return this.ctx;
  }
}

export class FakeNode {
  readonly outputs = new Set<FakeNode | FakeParam>();
  readonly inputs = new Set<FakeNode>();
  started = false;
  stopped = false;
  onended: (() => void) | null = null;
  constructor(
    readonly ctx: FakeContext,
    readonly kind: string,
  ) {
    ctx.nodes.push(this);
  }
  connect<T extends FakeNode | FakeParam>(dest: T): T {
    if (dest instanceof FakeNode && dest.ctx !== this.ctx) fail('connect across contexts');
    if (dest instanceof FakeParam && dest.context !== this.ctx) fail('connect to a param of another context');
    this.outputs.add(dest);
    if (dest instanceof FakeNode) dest.inputs.add(this);
    return dest;
  }
  disconnect(): void {
    for (const o of this.outputs) if (o instanceof FakeNode) o.inputs.delete(this);
    this.outputs.clear();
  }
  start(when = 0, offset = 0, duration?: number): void {
    if (this.started) fail(`${this.kind}.start called twice`);
    finite(when, `${this.kind}.start when`);
    finite(offset, `${this.kind}.start offset`);
    if (when < 0 || offset < 0) fail(`${this.kind}.start negative argument`);
    if (duration !== undefined && duration < 0) fail(`${this.kind}.start negative duration`);
    this.started = true;
    this.startAt = when;
  }
  stop(when = 0): void {
    if (!this.started) fail(`${this.kind}.stop before start`);
    finite(when, `${this.kind}.stop when`);
    if (when < 0) fail(`${this.kind}.stop negative time`);
    this.stopped = true;
    this.stopAt = when;
  }
  startAt = -1;
  stopAt = -1;
}

const P = (ctx: FakeContext, name: string, v = 0): FakeParam => new FakeParam(ctx, name, v);

export class FakeGain extends FakeNode {
  gain: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx, 'gain');
    this.gain = P(ctx, 'gain', 1);
  }
}
export class FakePeriodicWave {
  constructor(
    readonly real: Float32Array,
    readonly imag: Float32Array,
  ) {}
}
export class FakeOsc extends FakeNode {
  type: OscillatorType = 'sine';
  frequency: FakeParam;
  detune: FakeParam;
  wave: FakePeriodicWave | null = null;
  constructor(ctx: FakeContext) {
    super(ctx, 'oscillator');
    this.frequency = P(ctx, 'frequency', 440);
    this.detune = P(ctx, 'detune', 0);
  }
  setPeriodicWave(w: FakePeriodicWave): void {
    this.wave = w;
    this.type = 'custom';
  }
}
export class FakeBiquad extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  frequency: FakeParam;
  Q: FakeParam;
  gain: FakeParam;
  detune: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx, 'biquad');
    this.frequency = P(ctx, 'frequency', 350);
    this.Q = P(ctx, 'Q', 1);
    this.gain = P(ctx, 'gain', 0);
    this.detune = P(ctx, 'detune', 0);
  }
}
export class FakePanner extends FakeNode {
  pan: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx, 'panner');
    this.pan = P(ctx, 'pan', 0);
  }
}
export class FakeBufferSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  loop = false;
  playbackRate: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx, 'bufferSource');
    this.playbackRate = P(ctx, 'playbackRate', 1);
  }
  override start(when = 0, offset = 0, duration?: number): void {
    if (!this.buffer) fail('bufferSource.start without a buffer');
    if (offset > this.buffer!.duration)
      fail(`bufferSource offset ${offset} beyond buffer ${this.buffer!.duration}`);
    super.start(when, offset, duration);
  }
}
export class FakeConvolver extends FakeNode {
  buffer: FakeBuffer | null = null;
  normalize = true;
  constructor(ctx: FakeContext) {
    super(ctx, 'convolver');
  }
}
export class FakeShaper extends FakeNode {
  curve: Float32Array | null = null;
  oversample: OverSampleType = 'none';
  constructor(ctx: FakeContext) {
    super(ctx, 'waveshaper');
  }
}
export class FakeCompressor extends FakeNode {
  threshold = P(this.ctx, 'threshold', -24);
  knee = P(this.ctx, 'knee', 30);
  ratio = P(this.ctx, 'ratio', 12);
  attack = P(this.ctx, 'attack', 0.003);
  release = P(this.ctx, 'release', 0.25);
  constructor(ctx: FakeContext) {
    super(ctx, 'compressor');
  }
}
export class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  /**
   * What the analyser "hears" (the fake renders no audio): silence unless a test sets this, e.g. `(a) => a.fill(NaN)` to stand
   * for a filter upstream that has gone NaN, or a constant for a live mix.
   */
  feed: ((a: Float32Array) => void) | null = null;
  constructor(ctx: FakeContext) {
    super(ctx, 'analyser');
  }
  getFloatTimeDomainData(a: Float32Array): void {
    a.fill(0);
    this.feed?.(a);
  }
}
export class FakeBuffer {
  readonly duration: number;
  private readonly data: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    if (length < 1 || sampleRate < 8000) fail('createBuffer: bad length/sampleRate');
    this.duration = length / sampleRate;
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(c: number): Float32Array {
    return this.data[c]!;
  }
  copyToChannel(src: Float32Array, c: number): void {
    this.data[c]!.set(src);
  }
}

export class FakeContext {
  readonly nodes: FakeNode[] = [];
  currentTime = 0;
  sampleRate = 48000;
  state: 'suspended' | 'running' | 'closed' = 'running';
  baseLatency = 0.01;
  outputLatency = 0.02;
  readonly destination = new FakeNode(this, 'destination');
  createGain(): FakeGain {
    return new FakeGain(this);
  }
  createOscillator(): FakeOsc {
    return new FakeOsc(this);
  }
  createBiquadFilter(): FakeBiquad {
    return new FakeBiquad(this);
  }
  createStereoPanner(): FakePanner {
    return new FakePanner(this);
  }
  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource(this);
  }
  createConvolver(): FakeConvolver {
    return new FakeConvolver(this);
  }
  createWaveShaper(): FakeShaper {
    return new FakeShaper(this);
  }
  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor(this);
  }
  createAnalyser(): FakeAnalyser {
    return new FakeAnalyser(this);
  }
  createBuffer(ch: number, len: number, sr: number): FakeBuffer {
    return new FakeBuffer(ch, len, sr);
  }
  createPeriodicWave(real: Float32Array, imag: Float32Array): FakePeriodicWave {
    if (real.length !== imag.length || real.length < 2)
      fail('createPeriodicWave: real/imag must match and have length >= 2');
    for (let i = 0; i < real.length; i++) {
      finite(real[i]!, `periodicWave.real[${i}]`);
      finite(imag[i]!, `periodicWave.imag[${i}]`);
    }
    return new FakePeriodicWave(real, imag);
  }
  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
  /** Sources that were started but never given a stop (leaks that would play forever). */
  leakedSources(): FakeNode[] {
    return this.nodes.filter(
      (n) =>
        (n instanceof FakeOsc || n instanceof FakeBufferSource) &&
        n.started &&
        !n.stopped &&
        !(n instanceof FakeBufferSource && n.loop === false && false),
    );
  }
  count(kind: string): number {
    return this.nodes.filter((n) => n.kind === kind).length;
  }
}

/** Cast helper: hand a FakeContext to code typed against `BaseAudioContext`. */
export const asBase = (c: FakeContext): BaseAudioContext => c as unknown as BaseAudioContext;
