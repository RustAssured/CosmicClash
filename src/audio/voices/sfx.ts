import type { DamageType } from '@/contracts';
import { clamp, clamp01 } from '../dsp/math';
import { GLASS, IRON, gravel, makeOut, noiseHit, partials, riser, thump, tone, pick } from './synth';
import type { GuardEvent, HitEvent, KoEvent, MatterEvent, UltimateEvent, VoiceCtx } from './types';

/**
 * Titan-neutral sounds: the damage-type layers, guard, shockwave, KO, matter and ultimate cues, and the impact sub-bass.
 * Titan voices ADD their own material and character on top of these; a titan without a voice still sounds like a fight.
 */

/** 0..1 loudness class of a blow from its energy (150 … 9000): logarithmic, like hearing. */
export const magnitude = (energy: number, heavy: boolean): number =>
  clamp01((Math.log10(Math.max(50, energy)) - 2.0) / 1.9 + (heavy ? 0.12 : 0));

/**
 * The impact itself: sub-bass thump (never sent to the reverb), a mid body knock, and a wet tail whose length grows with
 * the blow. Heavier blows drop lower and ring longer; a blocked blow is duller and quieter.
 */
export function playImpact(c: VoiceCtx, t: number, ev: HitEvent, mag: number, pan: number): void {
  const open = 1 - clamp01(ev.blocked) * 0.6;
  const sub = makeOut(c, pan * 0.3, 0);
  const g = (0.22 + 0.62 * mag) * open;
  const dur = 0.2 + 0.55 * mag + (ev.heavy ? 0.35 : 0);
  thump(c, sub, t, 92 - 34 * mag, 30 + 8 * (1 - mag), dur, g);
  if (ev.heavy || mag > 0.6) thump(c, sub, t + 0.012, 58, 26, dur * 1.4, g * 0.55);
  const body = makeOut(c, pan, 0.22 + 0.4 * mag);
  noiseHit(c, body, t, {
    dur: 0.09 + 0.14 * mag,
    gain: 0.16 * (0.5 + mag) * open,
    filter: { type: 'lowpass', f0: 1500 - 500 * ev.blocked, f1: 180, q: 0.8 },
    kind: 'brown',
    attack: 0.001,
  });
}

/** The damage-type flavour (what KIND of destruction this blow is). */
export function playTypeLayer(
  c: VoiceCtx,
  t: number,
  type: DamageType,
  mag: number,
  pan: number,
  scale = 1,
): void {
  const g = (0.1 + 0.3 * mag) * scale;
  switch (type) {
    case 'FRACTURE': {
      const o = makeOut(c, pan, 0.3);
      // crack: two-three ultra-short bright clicks, then the shear
      for (let i = 0; i < 2 + Math.round(mag * 2); i++)
        noiseHit(c, o, t + i * (0.006 + c.rand() * 0.03), {
          dur: 0.012,
          gain: g * 1.2,
          filter: { type: 'highpass', f0: 3500 + c.rand() * 3500, q: 0.7 },
          attack: 0.0005,
        });
      noiseHit(c, o, t + 0.004, {
        dur: 0.13 + 0.06 * mag,
        gain: g * 0.9,
        filter: { type: 'bandpass', f0: 7000, f1: 1600, q: 1.6 },
      });
      break;
    }
    case 'KINETIC': {
      const o = makeOut(c, pan, 0.2);
      noiseHit(c, o, t, {
        dur: 0.14 + 0.1 * mag,
        gain: g * 1.3,
        filter: { type: 'lowpass', f0: 1700, f1: 260, q: 1 },
        kind: 'white',
      });
      gravel(c, o, t + 0.01, {
        dur: 0.25 + 0.15 * mag,
        grains: 10 + Math.round(mag * 14),
        f: 1100,
        spread: 2.5,
        gain: g * 0.9,
      });
      break;
    }
    case 'CRUSH': {
      const o = makeOut(c, pan * 0.6, 0.35);
      noiseHit(c, o, t, {
        dur: 0.35 + 0.35 * mag,
        gain: g * 1.4,
        filter: { type: 'lowpass', f0: 420, f1: 70, q: 1.2 },
        kind: 'brown',
        attack: 0.01,
      });
      tone(c, o, t, { type: 'sawtooth', f0: 75, f1: 38, dur: 0.6 + 0.4 * mag, gain: g * 0.35, attack: 0.02 });
      break;
    }
    case 'THERMAL': {
      const o = makeOut(c, pan, 0.28);
      noiseHit(c, o, t, {
        dur: 0.22 + 0.15 * mag,
        gain: g * 1.1,
        filter: { type: 'bandpass', f0: 700, f1: 3400, q: 0.9 },
        attack: 0.02,
      });
      gravel(c, o, t + 0.05, {
        dur: 0.5 + 0.3 * mag,
        grains: 16 + Math.round(mag * 16),
        f: 4200,
        spread: 1.4,
        gain: g * 0.7,
        q: 3,
      });
      break;
    }
    case 'TIDAL': {
      const o = makeOut(c, pan * 0.5, 0.4);
      tone(c, o, t, { f0: 240, f1: 52, dur: 0.6 + 0.3 * mag, gain: g * 0.9, attack: 0.015 });
      noiseHit(c, o, t, {
        dur: 0.5,
        gain: g * 0.7,
        filter: { type: 'bandpass', f0: 2400, f1: 200, q: 2 },
        attack: 0.02,
      });
      break;
    }
    case 'ASSIMILATION': {
      const o = makeOut(c, pan, 0.3);
      partials(c, o, t, 330, IRON, { decay: 0.3 + 0.2 * mag, gain: g * 0.55 });
      gravel(c, o, t + 0.02, { dur: 0.2, grains: 9, f: 3200, spread: 1, gain: g * 0.6, q: 6 });
      break;
    }
  }
}

/** Generic guard: a dull thud and a short ring whose tone depends on `type`. */
export function playGuard(c: VoiceCtx, t: number, ev: GuardEvent, pan: number, ringHz = 900): void {
  const o = makeOut(c, pan, 0.3);
  thump(c, makeOut(c, pan * 0.3, 0), t, 120, 50, ev.broke ? 0.7 : 0.3, ev.broke ? 0.7 : 0.4);
  partials(c, o, t, ringHz, ev.type === 'FRACTURE' || ev.type === 'THERMAL' ? GLASS : IRON, {
    decay: ev.broke ? 0.9 : 0.35,
    gain: ev.broke ? 0.2 : 0.14,
  });
  if (ev.broke) {
    // the shell gives way: a downward sweep and a burst of debris
    tone(c, o, t + 0.02, { f0: 900, f1: 90, dur: 0.5, gain: 0.22 });
    gravel(c, o, t + 0.02, { dur: 0.45, grains: 22, f: 2400, spread: 2, gain: 0.22 });
  }
}

/** Expanding ring: a low pressure wave whose pitch falls with radius. */
export function playShockwave(c: VoiceCtx, t: number, strength: number, radius: number, pan: number): void {
  const s = clamp01(strength);
  const f0 = 70 - clamp(radius / 40, 0, 30) * 0.4;
  thump(c, makeOut(c, pan * 0.2, 0), t + 0.02, f0, 24, 0.5 + s * 0.9, 0.18 + 0.4 * s);
  noiseHit(c, makeOut(c, pan, 0.6), t + 0.04, {
    dur: 0.6 + s * 0.9,
    gain: 0.08 + 0.12 * s,
    filter: { type: 'bandpass', f0: 500, f1: 90, q: 0.7 },
    attack: 0.03,
    kind: 'brown',
  });
}

/** The weight of a KO: a long two-stage sub drop. Titan voices add their own material on top of this. */
export function playKoSub(c: VoiceCtx, t: number, _pan: number): void {
  const sub = makeOut(c, 0, 0);
  thump(c, sub, t, 68, 22, 1.8, 0.95);
  thump(c, sub, t + 0.05, 44, 20, 2.4, 0.6);
}

/** A titan falls (titan-neutral). Enormous, low, long: sub drop, a lowpassed rumble that closes down, falling debris. */
export function playKo(c: VoiceCtx, t: number, _ev: KoEvent, pan: number): void {
  playKoSub(c, t, pan);
  const wet = makeOut(c, pan * 0.4, 0.9);
  noiseHit(c, wet, t, {
    dur: 2.2,
    gain: 0.28,
    filter: { type: 'lowpass', f0: 1800, f1: 70, q: 0.9 },
    kind: 'brown',
    attack: 0.01,
  });
  tone(c, wet, t, { f0: 180, f1: 30, dur: 2.0, gain: 0.3, type: 'triangle', attack: 0.02 });
  gravel(c, wet, t + 0.05, { dur: 1.4, grains: 40, f: 900, spread: 3, gain: 0.3 });
}

/** Matter-world happenings, scaled by mass moved. */
export function playMatter(c: VoiceCtx, t: number, ev: MatterEvent, pan: number): void {
  const m = clamp01(Math.log10(Math.max(1, ev.mass)) / 3);
  const g = 0.06 + 0.22 * m;
  const o = makeOut(c, pan, 0.3);
  switch (ev.kind) {
    case 'detach':
      thump(c, makeOut(c, pan * 0.4, 0), t, 80, 38, 0.3 + 0.3 * m, 0.16 + 0.3 * m);
      gravel(c, o, t + 0.02, {
        dur: 0.3 + 0.3 * m,
        grains: 8 + Math.round(m * 14),
        f: 1500,
        spread: 2.5,
        gain: g,
      });
      break;
    case 'crack':
      noiseHit(c, o, t, {
        dur: 0.03,
        gain: g * 1.2,
        filter: { type: 'highpass', f0: 2500 + c.rand() * 3000 },
        attack: 0.0005,
      });
      tone(c, o, t, { f0: 1800 + c.rand() * 1200, f1: 900, dur: 0.05, gain: g * 0.4 });
      break;
    case 'ignite':
      noiseHit(c, o, t, {
        dur: 0.35,
        gain: g,
        filter: { type: 'bandpass', f0: 600, f1: 2600, q: 0.8 },
        attack: 0.04,
      });
      gravel(c, o, t + 0.05, { dur: 0.4, grains: 14, f: 4500, spread: 1.2, gain: g * 0.6, q: 3 });
      break;
    case 'consume':
      tone(c, o, t, { f0: 400, f1: 60, dur: 0.5, gain: g * 1.2, attack: 0.02 });
      break;
    case 'harvest':
      tone(c, o, t, { f0: 200, f1: 700, dur: 0.35, gain: g * 0.9, type: 'triangle', attack: 0.03 });
      break;
    case 'impact':
      thump(c, makeOut(c, pan * 0.4, 0), t, 100, 42, 0.25 + 0.25 * m, 0.14 + 0.28 * m);
      noiseHit(c, o, t, { dur: 0.08, gain: g, filter: { type: 'lowpass', f0: 2000, f1: 400 } });
      break;
    case 'evaporate':
      noiseHit(c, o, t, { dur: 0.9, gain: g, filter: { type: 'highpass', f0: 3000, q: 0.6 }, attack: 0.15 });
      break;
    case 'boil':
      gravel(c, o, t, { dur: 0.7, grains: 22, f: 700, spread: 2, gain: g, q: 2 });
      break;
  }
}

/** Ultimate start/end (titan-neutral): a rising swell into a boom, and a resolving fall. */
export function playUltimate(c: VoiceCtx, t: number, ev: UltimateEvent, pan: number): void {
  const o = makeOut(c, pan * 0.4, 0.7);
  if (ev.phase === 'start') {
    riser(c, o, t, 1.4, 0.3, 200, 5200);
    tone(c, o, t, { f0: 55, f1: 220, dur: 1.5, gain: 0.32, type: 'sawtooth', attack: 1.2 });
    thump(c, makeOut(c, 0, 0), t + 1.4, 70, 26, 1.6, 0.85);
  } else {
    tone(c, o, t, { f0: 440, f1: 55, dur: 1.6, gain: 0.25, type: 'triangle', attack: 0.05 });
    noiseHit(c, o, t, {
      dur: 1.6,
      gain: 0.14,
      filter: { type: 'lowpass', f0: 2600, f1: 120, q: 0.8 },
      attack: 0.05,
    });
  }
}

/** Unknown / generic cue: a small tick so nothing is silent. */
export function playCueGeneric(c: VoiceCtx, t: number, amount: number, pan: number): void {
  const o = makeOut(c, pan, 0.25);
  partials(c, o, t, pick(c, [740, 880, 987, 1174]), GLASS, {
    decay: 0.22,
    gain: 0.06 + 0.1 * clamp01(amount),
  });
}
