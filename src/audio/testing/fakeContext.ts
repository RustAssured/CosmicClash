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
  value: number;
  readonly events: { type: string; v: number; t: number }[] = [];
  constructor(
    private readonly ctx: FakeContext,
    readonly name: string,
    v = 0,
  ) {
    this.value = v;
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
  private insert(type: string, v: number, t: number, what: string): void {
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
    ev.splice(i, 0, { type, v, t });
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
    this.insert('target', v, t, 'setTarget');
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
    this.events.length = 0;
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
export class FakeOsc extends FakeNode {
  type: OscillatorType = 'sine';
  frequency: FakeParam;
  detune: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx, 'oscillator');
    this.frequency = P(ctx, 'frequency', 440);
    this.detune = P(ctx, 'detune', 0);
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
  constructor(ctx: FakeContext) {
    super(ctx, 'bufferSource');
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
  constructor(ctx: FakeContext) {
    super(ctx, 'analyser');
  }
  getFloatTimeDomainData(a: Float32Array): void {
    a.fill(0);
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
