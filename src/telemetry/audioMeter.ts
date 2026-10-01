import { LoudnessAccumulator, designTruePeakFir, kWeighting, type LoudnessSample } from './loudness';
import { METER_PROCESSOR, METER_WORKLET_SOURCE } from './meterWorklet';

const loaded = new WeakSet<BaseAudioContext>();

async function ensureModule(ac: AudioContext): Promise<void> {
  if (loaded.has(ac)) return;
  const url = URL.createObjectURL(new Blob([METER_WORKLET_SOURCE], { type: 'text/javascript' }));
  try {
    await ac.audioWorklet.addModule(url);
    loaded.add(ac);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A parallel loudness/true-peak tap on any node of the live audio graph (EBU R128 readings, 10 updates/s).
 * Never in the signal path: the worklet's silent output goes to the destination through a zero gain only so the
 * browser keeps pulling it.
 */
export class AudioMeter {
  readonly acc = new LoudnessAccumulator();
  /** Wall-clock (performance.now) ms of each accumulator sample, parallel to `acc.series`. */
  readonly wallMs: number[] = [];
  private constructor(
    private readonly node: AudioWorkletNode,
    private readonly sink: GainNode,
    private readonly src: AudioNode,
  ) {
    node.port.onmessage = (e: MessageEvent<{ ms: number; tp: number }>): void => {
      this.acc.push(e.data.ms, e.data.tp);
      this.wallMs.push(performance.now());
    };
  }

  static async attach(ac: AudioContext, src: AudioNode): Promise<AudioMeter> {
    await ensureModule(ac);
    const node = new AudioWorkletNode(ac, METER_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: {
        k: kWeighting(ac.sampleRate).map((q) => [q.b0, q.b1, q.b2, q.a1, q.a2]),
        phases: designTruePeakFir().map((p) => Array.from(p)),
        blockFrames: Math.round(ac.sampleRate / 10),
      },
    });
    const sink = ac.createGain();
    sink.gain.value = 0;
    src.connect(node);
    node.connect(sink);
    sink.connect(ac.destination);
    return new AudioMeter(node, sink, src);
  }

  reset(): void {
    this.acc.reset();
    this.wallMs.length = 0;
  }

  /** Samples whose wall-clock time falls in [fromMs, toMs]. */
  between(fromMs: number, toMs: number): LoudnessSample[] {
    const out: LoudnessSample[] = [];
    for (let i = 0; i < this.wallMs.length; i++) {
      const t = this.wallMs[i]!;
      if (t >= fromMs && t <= toMs) out.push(this.acc.series[i]!);
    }
    return out;
  }

  detach(): void {
    try {
      this.src.disconnect(this.node);
    } catch {
      /* already gone */
    }
    this.node.disconnect();
    this.sink.disconnect();
  }
}
