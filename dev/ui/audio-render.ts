import type { AudioEvent, AudioScene, TitanId } from '@/contracts';
import { createAudioEngine, type AudioEngineExt } from '@/audio/engine';
import { decayTime, peak, rms, spectralCentroid, toDb } from '@/audio/dsp/analysis';

/**
 * Shared machinery for the audio verification pages: render the REAL engine through an OfflineAudioContext (the same graph and
 * voices the game uses, faster than real time) and hand back samples to measure. See audio-verify.ts for what is checked.
 */
export const SR = 44100;

export interface EventMetric {
  name: string;
  /** Peak of the event ALONE (scene bed subtracted), before the compressor and limiter: how hot the voice is. */
  peakDb: number;
  rmsDb: number;
  centroidHz: number;
  tailSec: number;
}

/**
 * The score smooths intensity (rises with a 0.35 s time constant, as in play, where update() runs every frame). Offline there
 * are no frames, so feed it two seconds of them first — WITHOUT scheduling — then pre-schedule `horizon` seconds at the settled
 * intensity. One single call would plan the whole clip at ~5 % of the intensity asked for.
 */
export function settle(eng: AudioEngineExt, s: AudioScene, horizon: number): void {
  for (let i = 0; i < 120; i++) eng.updateAt(s, 1 / 60, 0);
  eng.updateAt(s, 1 / 60, horizon);
}

/** A fight scene. `resource`, `charge` and `meter` are 0..1 in the contract. */
export const scene = (
  o: Partial<AudioScene> = {},
  a: TitanId = 'lastone',
  b: TitanId = 'asteroid',
): AudioScene => ({
  phase: 'fight',
  stage: 'nursery',
  intensity: 0.6,
  listenerX: 800,
  lowestIntegrity: 0.8,
  timeScale: 1,
  fighters: [
    { titan: a, x: 700, speed: 260, massFrac: 1, charge: 0, resource: 0.6, meter: 0.3, state: 'idle' },
    { titan: b, x: 900, speed: 120, massFrac: 1, charge: 0, resource: 0.6, meter: 0.3, state: 'idle' },
  ],
  ...o,
});

export interface Rendered {
  /** Mono fold (for spectral metrics). */
  mono: Float32Array;
  /** True per-channel peak |sample|. */
  peak: number;
  /** Count of NaN / ±Infinity samples: must always be zero. */
  nonFinite: number;
}

let totalNonFinite = 0;
/** NaN / infinite samples seen by every render since the last `resetNonFinite()`. */
export const nonFiniteSamples = (): number => totalNonFinite;
export const resetNonFinite = (): void => {
  totalNonFinite = 0;
};

function fold(buf: AudioBuffer): Rendered {
  const l = buf.getChannelData(0);
  const r = buf.getChannelData(1);
  const mono = new Float32Array(l.length);
  let pk = 0;
  let bad = 0;
  for (let i = 0; i < l.length; i++) {
    const a = l[i]!;
    const b = r[i]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      bad++;
      continue;
    }
    mono[i] = 0.5 * (a + b);
    pk = Math.max(pk, Math.abs(a), Math.abs(b));
  }
  totalNonFinite += bad;
  return { mono, peak: pk, nonFinite: bad };
}

export interface RenderOpts {
  unsafeBypassLimiter?: boolean;
  seed?: number;
}

export async function render(
  seconds: number,
  setup: (eng: AudioEngineExt, ctx: OfflineAudioContext) => void,
  opts: RenderOpts = {},
): Promise<Rendered> {
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * seconds), SR);
  const eng = createAudioEngine({
    context: ctx,
    seed: opts.seed ?? 1,
    unsafeBypassLimiter: opts.unsafeBypassLimiter,
  });
  await eng.unlock();
  setup(eng, ctx);
  return fold(await ctx.startRendering());
}

/**
 * Render with the engine driven the way the game drives it: `drive(eng, t)` is called at t = 0 and then every `step` seconds of
 * AUDIO time (the render is suspended at each step), so continuous voices, the score and per-frame scheduling (crackle, groans,
 * sparkle) run for real instead of being planned in one go at t = 0.
 */
export async function renderLive(
  seconds: number,
  drive: (eng: AudioEngineExt, t: number) => void,
  opts: RenderOpts & { step?: number } = {},
): Promise<Rendered> {
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * seconds), SR);
  const eng = createAudioEngine({
    context: ctx,
    seed: opts.seed ?? 1,
    unsafeBypassLimiter: opts.unsafeBypassLimiter,
  });
  await eng.unlock();
  eng.setVolumes({ music: 0 });
  const step = opts.step ?? 1 / 30;
  drive(eng, 0);
  for (let t = step; t < seconds - step; t += step) {
    const at = t;
    void ctx.suspend(at).then(() => {
      drive(eng, at);
      void ctx.resume();
    });
  }
  return fold(await ctx.startRendering());
}

/** Metrics of the event ALONE: `x` is the event render minus the bed (the same scene without the event). */
export function metric(name: string, x: Float32Array, t0 = 0): EventMetric {
  const from = Math.floor(SR * t0);
  const seg = x.subarray(from);
  return {
    name,
    peakDb: toDb(peak(x)),
    rmsDb: toDb(rms(seg, 0, Math.min(seg.length, SR))),
    centroidHz: spectralCentroid(seg, SR, 0, 8192, 300),
    tailSec: decayTime(seg, SR, 40, 20),
  };
}

export const hit = (over: Partial<Extract<AudioEvent, { t: 'hit' }>> = {}): AudioEvent => ({
  t: 'hit',
  attacker: 0,
  target: 1,
  titan: 'asteroid',
  x: 800,
  y: 300,
  dirX: 1,
  dirY: 0,
  type: 'KINETIC',
  energy: 900,
  cellsRemoved: 40,
  massRemoved: 12,
  blocked: 0,
  heavy: false,
  onDamaged: 0,
  ...over,
});

/** Subtract the bed from a render, sample for sample: what is left is the event alone. */
export function minus(a: Float32Array, b: Float32Array): Float32Array {
  const d = new Float32Array(a.length);
  for (let i = 0; i < d.length; i++) d[i] = a[i]! - b[i]!;
  return d;
}

export { rms, peak, toDb };
