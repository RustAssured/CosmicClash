import { clamp } from '../dsp/math';
import { envelope, makeOut, noiseSource, tone, type Out } from './synth';
import type { VoiceCtx } from './types';

/**
 * Building blocks for the titans' voices (the continuous beds, scrapes, bubbles), on top of the primitives in synth.ts; the
 * cataclysm kit (booms, swells, whooshes, roars) is `epic.ts`. The same rules
 * apply: every envelope is scheduled up front in time order (no event may land inside a pending ramp), long-lived nodes start
 * silent through `.value` and are only ever retargeted with `setTargetAtTime`.
 */

/** Noise through a sweeping band-pass with amplitude modulation at `rate` Hz: chain drag, ratcheting, grinding, tearing. */
export function scrape(
  c: VoiceCtx,
  o: Out,
  t: number,
  s: {
    dur: number;
    f0: number;
    f1: number;
    q?: number;
    gain: number;
    rate: number;
    depth?: number;
    attack?: number;
    kind?: 'white' | 'brown';
  },
): void {
  const ac = c.ac;
  const src = noiseSource(c, s.kind ?? 'white');
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = s.q ?? 2;
  bp.frequency.setValueAtTime(s.f0, t);
  bp.frequency.exponentialRampToValueAtTime(Math.max(20, s.f1), t + s.dur);
  const env = ac.createGain();
  envelope(env, t, s.gain, s.attack ?? 0.03, s.dur);
  const depth = clamp(s.depth ?? 0.8, 0, 1);
  const am = ac.createGain();
  am.gain.value = 1 - depth * 0.5; // the LFO swings it ± depth/2 around this
  const lfo = ac.createOscillator();
  lfo.type = 'triangle';
  lfo.frequency.value = s.rate;
  const lg = ac.createGain();
  lg.gain.value = depth * 0.5;
  lfo.connect(lg);
  lg.connect(am.gain);
  src.connect(bp);
  bp.connect(env);
  env.connect(am);
  am.connect(o.input);
  const off = c.rand() * Math.max(0, 2 - s.dur - 0.05);
  src.start(t, off);
  src.stop(t + s.dur + 0.05);
  lfo.start(t);
  lfo.stop(t + s.dur + 0.05);
}

/** Bubbles: short sine blurps rising in pitch at random moments (keep `f` low: magma, a boiling ocean). */
export function bubbles(
  c: VoiceCtx,
  o: Out,
  t: number,
  s: { dur: number; count: number; f: number; gain: number },
): void {
  for (let i = 0; i < s.count; i++) {
    const ts = t + c.rand() * s.dur;
    const f = s.f * (0.6 + 0.9 * c.rand());
    tone(c, o, ts, {
      f0: f,
      f1: f * (1.5 + c.rand()),
      dur: 0.035 + 0.05 * c.rand(),
      gain: s.gain * (0.4 + 0.6 * c.rand()),
      attack: 0.003,
    });
  }
}

/**
 * The plumbing every continuous voice repeats: one panner into the dry bus and a reverb send, plus a registry of the sources it
 * started so `dispose()` can stop them all. Started sources are silent until the voice raises a gain: gains start at 0 through
 * their `.value`.
 */
export interface Bed {
  readonly input: AudioNode;
  readonly pan: StereoPannerNode;
  /** Start `node` now and remember it. */
  run<T extends AudioScheduledSourceNode>(node: T): T;
  dispose(): void;
}

export function createBed(c: VoiceCtx, wetLevel: number): Bed {
  const ac = c.ac;
  const pan = ac.createStereoPanner();
  pan.connect(c.dry);
  const wet = ac.createGain();
  wet.gain.value = wetLevel;
  pan.connect(wet);
  wet.connect(c.wet);
  const running: AudioScheduledSourceNode[] = [];
  return {
    input: pan,
    pan,
    run(node) {
      node.start();
      running.push(node);
      return node;
    },
    dispose() {
      for (const n of running) {
        try {
          n.stop();
        } catch {
          /* already stopped */
        }
      }
      running.length = 0;
      pan.disconnect();
      wet.disconnect();
    },
  };
}

/** A looping noise source (white or brown) through one filter, into `dest`: the "air", "roar" or "rumble" of a bed. */
export function noiseBand(
  c: VoiceCtx,
  bed: Bed,
  dest: AudioNode,
  s: { kind: 'white' | 'brown'; type: BiquadFilterType; f: number; q: number },
): { filter: BiquadFilterNode; source: AudioBufferSourceNode } {
  const src = noiseSource(c, s.kind, true);
  const f = c.ac.createBiquadFilter();
  f.type = s.type;
  f.frequency.value = s.f;
  f.Q.value = s.q;
  src.connect(f);
  f.connect(dest);
  bed.run(src);
  return { filter: f, source: src };
}

/** Convenience: a gain node feeding `dest`, silent to start. */
export function silentGain(c: VoiceCtx, dest: AudioNode): GainNode {
  const g = c.ac.createGain();
  g.gain.value = 0;
  g.connect(dest);
  return g;
}

/** An LFO oscillator whose output (± `depth`) is added to `param`. Returns the oscillator (its `frequency` can be retargeted). */
export function lfoInto(
  c: VoiceCtx,
  bed: Bed,
  param: AudioParam,
  rate: number,
  depth: number,
  type: OscillatorType = 'sine',
): { osc: OscillatorNode; depth: GainNode } {
  const osc = c.ac.createOscillator();
  osc.type = type;
  osc.frequency.value = rate;
  const d = c.ac.createGain();
  d.gain.value = depth;
  osc.connect(d);
  d.connect(param);
  bed.run(osc);
  return { osc, depth: d };
}

/** A tap for one-shots that should not pan (sub-bass): a dry-only `Out`. */
export const subOut = (c: VoiceCtx, pan = 0): Out => makeOut(c, pan * 0.3, 0);
