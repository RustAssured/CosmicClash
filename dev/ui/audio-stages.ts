import { Rng, STAGE_IDS, type StageId } from '@/contracts';
import { midiToHz } from '@/audio/dsp/math';
import { MODES, STAGE_FEEL, STAGE_MUSIC, fifthOf } from '@/audio/dsp/scales';
import { STEPS_PER_BAR, planStep, stepSeconds } from '@/audio/score/plan';
import { bandShare, envelopeDb, peakFrequency, spectralCentroid } from '@/audio/dsp/analysis';
import { SR, peak, render, rms, scene, settle, toDb, type Rendered } from './audio-render';

/**
 * Stage scores, in numbers. Each stage's score is rendered alone (no fighters, no effects, no limiter) in a calm menu and in a
 * full-intensity fight, and described by how loud, how bright and how low it sits, how much rhythm the planner gives it, whether
 * what it plays is IN KEY (the drone's dominant pitch against the stage's root and fifth, the pad's against its scale) and
 * whether the rhythm layers keep time with the bar. Rhythm is counted from the planner (the same `planStep` the engine runs,
 * seeded the same way) rather than guessed from the waveform: onset detection on a sustained pad is noise, the planner is exact.
 *
 * It is the evidence that the five stages differ in character and that intensity adds MUSIC (layers, in key, on the beat) rather
 * than just gain. Whether they are beautiful is for ears.
 */
export interface StageMetrics {
  stage: StageId;
  bpm: number;
  calmRmsDb: number;
  hotRmsDb: number;
  calmPeakDb: number;
  hotPeakDb: number;
  /** Spectral centroid (Hz) of the calm menu score and of the full fight: how bright each sits. */
  calmCentroidHz: number;
  hotCentroidHz: number;
  /** Share of the score's power below 150 Hz, calm and hot. */
  calmLowShare: number;
  hotLowShare: number;
  /** Rhythmic events (sub pulses, taiko, percussion, heartbeat) the planner schedules per bar, calm menu and full fight. */
  calmHitsPerBar: number;
  hotHitsPerBar: number;
  /** Bell notes (glass motes) per minute of stage time in the calm menu and in a full fight. */
  calmMotesPerMin: number;
  hotMotesPerMin: number;
  /** How many of the five rhythm layers (sub, taiko, percussion, heartbeat, bell) the planner uses in the calm menu / the fight. */
  calmLayers: number;
  hotLayers: number;
  /** Distance in cents from the calm score's dominant low pitch (30-200 Hz) to the nearest of the stage's root and fifth (its drone). */
  calmBassFitCents: number;
  /** Frequency and distance in cents from the calm pad's dominant pitch (150-1500 Hz) to the nearest degree of the scale. */
  padPeakHz: number;
  padFitCents: number;
  /** The same for the full fight's dominant pitch in 100-800 Hz (drone, pad, taiko bodies; below that the sub pulse sweeps). */
  hotFitCents: number;
  /** Low-band attacks found in the fight (rises of 6 dB in 10 ms) and the share of them within 25 ms of a 16th-note line. */
  gridOnsets: number;
  onGridShare: number;
}

export interface StageReport {
  stages: StageMetrics[];
  /** The smallest distance between any two stages in a normalised descriptor space (tempo, level, brightness, weight, rhythm). */
  minPairDistance: number;
  /** For the Nursery, as intensity climbs 0 → 1 in five steps: how many layers the planner uses and how many hits a bar. */
  layersByIntensity: number[];
  hitsPerBarByIntensity: number[];
}

const SECONDS = 14;
const FROM = SR * 2;

/** One-pole low-pass. */
function lowpass(x: Float32Array, hz: number): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * hz) / SR);
  const y = new Float32Array(x.length);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += a * (x[i]! - s);
    y[i] = s;
  }
  return y;
}

/** Distance in cents from `hz` to the nearest pitch class in `classes` (semitones above `rootHz`, mod 12). */
function centsToClasses(hz: number, rootHz: number, classes: readonly number[]): number {
  if (hz <= 0) return Infinity;
  const semis = 12 * Math.log2(hz / rootHz);
  let best = Infinity;
  for (const c of classes) {
    const d = (((semis - c) % 12) + 18) % 12; // 6..18
    best = Math.min(best, Math.abs(d - 6) * 100);
  }
  return best;
}

/**
 * Attacks in the low band of `x` (below 250 Hz: sub pulses and taiko), and how many fall on the sixteenth-note grid the score
 * plans on (steps `stepSec` apart, the first at 20 ms): the evidence that the rhythm layers keep time with the bar.
 */
function gridAlignment(x: Float32Array, stepSec: number): { onsets: number; onGrid: number } {
  const win = Math.round(SR * 0.01);
  const env = envelopeDb(lowpass(x, 250), win);
  const first = Math.ceil(FROM / win);
  let onsets = 0;
  let onGrid = 0;
  let last = -1;
  for (let i = first + 1; i < env.length; i++) {
    if (env[i]! - env[i - 1]! < 6 || env[i]! < -70 || i - last < 6) continue;
    last = i;
    onsets++;
    const t = ((i + 0.5) * win) / SR - 0.02;
    const off = Math.abs(t / stepSec - Math.round(t / stepSec)) * stepSec;
    if (off <= 0.025) onGrid++;
  }
  return { onsets, onGrid };
}

interface Rhythm {
  hitsPerBar: number;
  motesPerMin: number;
  layers: number;
}

/** What the planner does with a stage at an intensity: run 96 bars of it and count. */
function planned(stage: StageId, phase: 'menu' | 'fight', intensity: number, lowIntegrity = 0): Rhythm {
  const feel = STAGE_FEEL[stage];
  const music = STAGE_MUSIC[stage];
  const rng = new Rng(7);
  const bars = 96;
  let hits = 0;
  let bells = 0;
  const used = new Set<string>();
  for (let step = 0; step < bars * STEPS_PER_BAR; step++) {
    const p = planStep(
      step,
      { intensity, lowIntegrity, phase, density: feel.density, motes: feel.motes },
      rng,
    );
    if (p.sub > 0) used.add('sub');
    if (p.taiko > 0) used.add('taiko');
    if (p.perc > 0) used.add('perc');
    if (p.pulse > 0) used.add('pulse');
    if (p.bell >= 0) {
      used.add('bell');
      bells++;
    }
    hits += (p.sub > 0 ? 1 : 0) + (p.taiko > 0 ? 1 : 0) + (p.perc > 0 ? 1 : 0) + (p.pulse > 0 ? 1 : 0);
  }
  const barSeconds = stepSeconds(music.bpm, intensity) * STEPS_PER_BAR;
  return { hitsPerBar: hits / bars, motesPerMin: (bells / (bars * barSeconds)) * 60, layers: used.size };
}

async function stageRender(stage: StageId, phase: 'menu' | 'fight', intensity: number): Promise<Rendered> {
  return render(
    SECONDS,
    (eng) => {
      settle(eng, scene({ stage, phase, intensity, lowestIntegrity: 1, fighters: null }), SECONDS);
    },
    { unsafeBypassLimiter: true },
  );
}

async function measure(stage: StageId): Promise<StageMetrics> {
  const music = STAGE_MUSIC[stage];
  const calm = await stageRender(stage, 'menu', 0);
  const hot = await stageRender(stage, 'fight', 1);
  const rootHz = midiToHz(music.root);
  const scaleClasses = MODES[music.mode] as readonly number[];

  const grid = gridAlignment(hot.mono, stepSeconds(music.bpm, 1));
  const droneClasses = [0, (fifthOf(music) - music.root) % 12];

  const padPeak = peakFrequency(calm.mono, SR, 150, 1500, FROM, 131072);
  const calmPlan = planned(stage, 'menu', 0);
  const hotPlan = planned(stage, 'fight', 1);
  return {
    stage,
    bpm: music.bpm,
    calmRmsDb: toDb(rms(calm.mono, FROM, calm.mono.length)),
    hotRmsDb: toDb(rms(hot.mono, FROM, hot.mono.length)),
    calmPeakDb: toDb(peak(calm.mono, FROM)),
    hotPeakDb: toDb(peak(hot.mono, FROM)),
    calmCentroidHz: spectralCentroid(calm.mono, SR, FROM, 65536),
    hotCentroidHz: spectralCentroid(hot.mono, SR, FROM, 65536),
    calmLowShare: bandShare(calm.mono, SR, 20, 150, FROM, 131072),
    hotLowShare: bandShare(hot.mono, SR, 20, 150, FROM, 131072),
    calmHitsPerBar: calmPlan.hitsPerBar,
    hotHitsPerBar: hotPlan.hitsPerBar,
    calmMotesPerMin: calmPlan.motesPerMin,
    hotMotesPerMin: hotPlan.motesPerMin,
    calmLayers: calmPlan.layers,
    hotLayers: hotPlan.layers,
    calmBassFitCents: centsToClasses(
      peakFrequency(calm.mono, SR, 30, 200, FROM, 131072),
      rootHz,
      droneClasses,
    ),
    padPeakHz: padPeak,
    padFitCents: centsToClasses(padPeak, rootHz, scaleClasses),
    hotFitCents: centsToClasses(peakFrequency(hot.mono, SR, 100, 800, FROM, 131072), rootHz, scaleClasses),
    gridOnsets: grid.onsets,
    onGridShare: grid.onsets >= 3 ? grid.onGrid / grid.onsets : Number.NaN,
  };
}

export async function runStageVerification(): Promise<StageReport> {
  const stages: StageMetrics[] = [];
  for (const id of STAGE_IDS) stages.push(await measure(id));
  // a crude but honest separation test: are any two stages close in the space of the things a listener hears first?
  const vec = (m: StageMetrics): number[] => [
    m.bpm / 12,
    m.calmRmsDb / 6,
    m.hotRmsDb / 6,
    m.calmCentroidHz / 250,
    m.hotLowShare * 4,
    Math.log2(1 + m.hotHitsPerBar) * 1.5,
  ];
  let min = Infinity;
  for (let i = 0; i < stages.length; i++)
    for (let j = i + 1; j < stages.length; j++) {
      const a = vec(stages[i]!);
      const b = vec(stages[j]!);
      min = Math.min(min, Math.hypot(...a.map((v, k) => v - b[k]!)));
    }
  const ramp = [0, 0.25, 0.5, 0.75, 1].map((i) => planned('nursery', i > 0 ? 'fight' : 'menu', i));
  return {
    stages,
    minPairDistance: min,
    layersByIntensity: ramp.map((r) => r.layers),
    hitsPerBarByIntensity: ramp.map((r) => r.hitsPerBar),
  };
}
