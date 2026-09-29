import type { Rng } from '@/contracts';
import { clamp, clamp01 } from '../dsp/math';

/**
 * The adaptive score's brain — pure and deterministic (seeded RNG), so it is unit-tested in Node. The Web Audio side
 * (`engine.ts` in this folder) only turns a `StepPlan` into sound.
 *
 * Time is a 16-step bar. Rhythm layers fade in with fight intensity: sparse sub pulses first, then low taiko-like hits, then
 * airy percussion. Low integrity adds a heartbeat and a tense pad; menus get an occasional bell instead of any rhythm.
 */
export interface ScoreParams {
  /** 0..1 smoothed fight intensity. */
  intensity: number;
  /** 0..1, 1 = the worst-off titan is about to fall. */
  lowIntegrity: number;
  phase: 'menu' | 'fight' | 'pause' | 'results' | 'attract';
}

export interface StepPlan {
  /** Sub-bass pulse strength 0..1 (0 = none). */
  sub: number;
  /** Taiko-like hit velocity 0..1 and which of three tunings (0 low … 2 high). */
  taiko: number;
  taikoTune: 0 | 1 | 2;
  /** Airy percussion tick 0..1. */
  perc: number;
  /** Heartbeat thump 0..1 (the "lub" and softer "dub"). */
  pulse: number;
  /** Scale degree of a bell note to strike, or −1. */
  bell: number;
}

export const STEPS_PER_BAR = 16;

const EMPTY: StepPlan = { sub: 0, taiko: 0, taikoTune: 0, perc: 0, pulse: 0, bell: -1 };

/** Duration in seconds of one 16th-note step. Tempo runs from 0.92× (calm) to 1.2× (full intensity) the stage BPM; slow-motion stretches time. */
export function stepSeconds(bpm: number, intensity: number, timeScale = 1): number {
  const tempo = bpm * (0.92 + 0.28 * clamp01(intensity));
  const ts = clamp(timeScale, 0.35, 1);
  return 60 / (tempo * ts) / 4;
}

export function planStep(step: number, p: ScoreParams, rng: Rng): StepPlan {
  const s = ((step % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR;
  const out: StepPlan = { ...EMPTY };
  const I = clamp01(p.intensity);

  if (p.phase === 'menu' || p.phase === 'results') {
    // calm: a sparse bell on the pentatonic, roughly one every two bars
    if (s % 4 === 0 && rng.next() < 0.11) out.bell = Math.floor(rng.next() * 5);
    return out;
  }
  if (p.phase === 'pause') return out;

  if (I > 0.12) {
    if (s === 0) out.sub = 0.5 + 0.5 * I;
    else if (s === 8 && I > 0.35) out.sub = 0.35 + 0.4 * I;
    else if ((s === 6 || s === 14) && I > 0.6 && rng.next() < 0.5) out.sub = 0.3 + 0.3 * I;
  }
  if (I > 0.3) {
    if (s === 0) setTaiko(out, 0.9, 0, rng);
    else if (s === 10) setTaiko(out, 0.6, 1, rng);
    else if ((s === 4 || s === 12) && I > 0.5 && rng.next() < 0.6) setTaiko(out, 0.42, 1, rng);
    else if ((s === 2 || s === 14 || s === 7) && I > 0.75 && rng.next() < 0.35) setTaiko(out, 0.34, 2, rng);
  }
  if (I > 0.5) {
    if (s % 4 === 2) out.perc = 0.3 + 0.35 * I;
    else if (I > 0.75 && s % 2 === 1 && rng.next() < 0.4) out.perc = 0.18 + 0.2 * I;
  }
  // heartbeat: independent of intensity gating — being nearly dead is felt even in a lull
  if (p.lowIntegrity > 0.5) {
    const k = clamp01((p.lowIntegrity - 0.5) * 2);
    if (s === 0 || s === 8) out.pulse = 0.4 + 0.5 * k;
    else if (s === 2 || s === 10) out.pulse = 0.25 + 0.35 * k;
  }
  return out;
}

function setTaiko(out: StepPlan, v: number, base: 0 | 1 | 2, rng: Rng): void {
  out.taiko = v;
  const r = rng.next();
  out.taikoTune = base === 0 ? 0 : r < 0.6 ? base : r < 0.85 ? 1 : 2;
}

/** Number of bars between pad chord changes. */
export const CHORD_BARS = 4;

/** Next chord index (deterministic random walk that never repeats immediately). */
export function nextChord(current: number, count: number, rng: Rng): number {
  if (count <= 1) return 0;
  let n = Math.floor(rng.next() * count);
  if (n === current) n = (n + 1) % count;
  return n;
}
