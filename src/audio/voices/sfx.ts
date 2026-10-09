import type { DamageType } from '@/contracts';
import { clamp, clamp01 } from '../dsp/math';
import { BELL, IRON, gravel, makeOut, noiseHit, pick, tone } from './synth';
import { boom, catastrophe, crackle, grind, lowBell, roar, rumble, swell, whoosh } from './epic';
import type { GuardEvent, HitEvent, KoEvent, MatterEvent, UltimateEvent, VoiceCtx } from './types';

/**
 * Titan-neutral sounds: the impact itself, the damage-type layers, guard, shockwave, KO, matter and ultimate cues. Titan voices
 * ADD their own material and character on top of these; a titan without a voice still sounds like a fight.
 *
 * D34: every layer here is built for bodies the size of moons. Impacts are three layers (a pitch-dropping, saturated body; a
 * low-passed mid crunch; a dark tail into the cavern), heavy blows add a deeper second drop and a rumble that lingers, and
 * nothing tonal sits above ~1 kHz (no pings, no whistles, no hiss).
 */

/** 0..1 loudness class of a blow from its energy (150 … 9000): logarithmic, like hearing. */
export const magnitude = (energy: number, heavy: boolean): number =>
  clamp01((Math.log10(Math.max(50, energy)) - 2.0) / 1.9 + (heavy ? 0.12 : 0));

/**
 * The impact itself: the tectonic drop (a saturated body that falls in pitch, its knock and a dark contact), a low-passed crunch,
 * and a wet tail whose length grows with the blow. Heavy blows drop lower, add a second deeper drop and a rumble that lingers in
 * the cavern. A blocked blow is duller and quieter.
 */
export function playImpact(c: VoiceCtx, t: number, ev: HitEvent, mag: number, pan: number): void {
  const open = 1 - clamp01(ev.blocked) * 0.6;
  const sub = makeOut(c, pan * 0.3, 0.12);
  // light blows stay light (mag^1.5): the catastrophes are what stand out — contrast, not loudness
  const g = (0.14 + 0.7 * Math.pow(mag, 1.5)) * open;
  const dur = 0.3 + 0.7 * mag + (ev.heavy ? 0.5 : 0);
  boom(c, sub, t, { f0: 104 - 38 * mag, f1: 30 + 8 * (1 - mag), dur, gain: g, drive: 2 + 1.6 * mag });
  const body = makeOut(c, pan, 0.25 + 0.4 * mag);
  // the crunch: mass breaking against mass, low-passed (it closes from 1.6 kHz to 220 Hz: body, not hiss)
  noiseHit(c, body, t, {
    dur: 0.12 + 0.2 * mag,
    gain: 0.36 * (0.5 + mag) * open,
    filter: { type: 'lowpass', f0: 1600 - 600 * ev.blocked, f1: 220, q: 0.8 },
    attack: 0.001,
  });
  // the deep drop for the big ones; the cavern answering for seconds only for the truly heavy (a dense exchange of medium blows
  // must not fill every gap with tails: the silence between catastrophes is part of their size)
  if (ev.heavy || mag > 0.6)
    boom(c, sub, t + 0.03, { f0: 62, f1: 24, dur: dur * 1.6, gain: g * 0.6 * open, drive: 3, knock: 0.4 });
  if (ev.heavy) {
    const tail = makeOut(c, pan * 0.5, 0.8);
    rumble(c, tail, t + 0.02, {
      dur: 1.2 + 1.8 * mag,
      gain: 0.12 * mag * open,
      f0: 520,
      f1: 100,
      rate: 1.3,
    });
    // and what it threw up comes down: rubble raining for a second or two
    gravel(c, tail, t + 0.08, {
      dur: 0.7 + 1.0 * mag,
      grains: 24 + Math.round(30 * mag),
      f: 520,
      spread: 2.2,
      gain: 0.2 * mag * open,
      q: 1.1,
      decayShape: 1.3,
      lowpass: 1700,
    });
  }
}

/** The damage-type flavour (what KIND of destruction this blow is), every one of them low and heavy. */
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
      // a continent splitting: a dark crack, then the shear grinding down
      const o = makeOut(c, pan, 0.35);
      for (let i = 0; i < 2 + Math.round(mag * 2); i++)
        noiseHit(c, o, t + i * (0.01 + c.rand() * 0.03), {
          dur: 0.03,
          gain: g * 0.9,
          filter: { type: 'bandpass', f0: 900 + c.rand() * 500, q: 1.1 },
          filter2: { type: 'lowpass', f0: 2000 },
          attack: 0.0008,
        });
      grind(c, o, t + 0.01, {
        dur: 0.3 + 0.3 * mag,
        gain: g * 0.9,
        f0: 700,
        f1: 160,
        rate: 13,
        attack: 0.01,
      });
      break;
    }
    case 'KINETIC': {
      const o = makeOut(c, pan, 0.25);
      noiseHit(c, o, t, {
        dur: 0.16 + 0.12 * mag,
        gain: g * 1.3,
        filter: { type: 'lowpass', f0: 1200, f1: 200, q: 1 },
        kind: 'brown',
      });
      gravel(c, o, t + 0.01, {
        dur: 0.3 + 0.2 * mag,
        grains: 10 + Math.round(mag * 14),
        f: 480,
        spread: 2.2,
        gain: g * 0.9,
        lowpass: 1400,
      });
      break;
    }
    case 'CRUSH': {
      const o = makeOut(c, pan * 0.6, 0.4);
      noiseHit(c, o, t, {
        dur: 0.45 + 0.4 * mag,
        gain: g * 1.4,
        filter: { type: 'lowpass', f0: 380, f1: 60, q: 1.2 },
        kind: 'brown',
        attack: 0.01,
      });
      roar(c, o, t, { f: 38, f1: 28, dur: 0.7 + 0.5 * mag, gain: g * 0.5, attack: 0.02, lp0: 260, lp1: 120 });
      break;
    }
    case 'THERMAL': {
      // a firestorm: a roar of burning gas and embers (no sizzle)
      const o = makeOut(c, pan, 0.35);
      noiseHit(c, o, t, {
        dur: 0.35 + 0.2 * mag,
        gain: g * 1.3,
        kind: 'brown',
        filter: { type: 'bandpass', f0: 240, f1: 700, q: 0.8 },
        attack: 0.02,
      });
      crackle(c, o, t + 0.04, {
        dur: 0.6 + 0.3 * mag,
        count: 8 + Math.round(10 * mag),
        gain: g * 0.6,
        f: 900,
      });
      break;
    }
    case 'TIDAL': {
      // gravity wrenching: a pull that sinks, pressure over it
      const o = makeOut(c, pan * 0.5, 0.45);
      tone(c, o, t, { f0: 160, f1: 40, dur: 0.7 + 0.3 * mag, gain: g * 0.8, attack: 0.015 });
      noiseHit(c, o, t, {
        dur: 0.6,
        gain: g * 0.8,
        kind: 'brown',
        filter: { type: 'bandpass', f0: 700, f1: 110, q: 1.2 },
        attack: 0.03,
      });
      break;
    }
    case 'ASSIMILATION': {
      // being absorbed: a hull clank and machinery grinding it in
      const o = makeOut(c, pan, 0.35);
      lowBell(c, o, t, 82, IRON, { decay: 0.4 + 0.3 * mag, gain: g * 0.5 });
      grind(c, o, t + 0.02, {
        dur: 0.3,
        gain: g * 0.6,
        f0: 260,
        f1: 520,
        rate: 16,
        metal: true,
        attack: 0.02,
      });
      break;
    }
  }
}

/** Generic guard: a dull thud and a low ring; when it breaks, the shell gives way with a drop and debris. */
export function playGuard(c: VoiceCtx, t: number, ev: GuardEvent, pan: number, ringHz = 110): void {
  const o = makeOut(c, pan, 0.35);
  boom(c, makeOut(c, pan * 0.3, 0), t, {
    f0: 110,
    f1: 46,
    dur: ev.broke ? 0.8 : 0.35,
    gain: ev.broke ? 0.6 : 0.38,
    drive: 2,
  });
  lowBell(c, o, t, ringHz, ev.type === 'FRACTURE' || ev.type === 'THERMAL' ? BELL : IRON, {
    decay: ev.broke ? 1.1 : 0.45,
    gain: ev.broke ? 0.16 : 0.11,
  });
  if (ev.broke) {
    tone(c, o, t + 0.02, { f0: 260, f1: 40, dur: 0.6, gain: 0.18 });
    gravel(c, o, t + 0.02, { dur: 0.5, grains: 22, f: 420, spread: 2, gain: 0.2, lowpass: 1400 });
  }
}

/** Expanding ring: a low pressure wave whose pitch falls with radius, and the air it pushes across the field. */
export function playShockwave(c: VoiceCtx, t: number, strength: number, radius: number, pan: number): void {
  const s = clamp01(strength);
  const f0 = 72 - clamp(radius / 40, 0, 30) * 0.5;
  boom(c, makeOut(c, pan * 0.2, 0), t + 0.02, {
    f0,
    f1: 24,
    dur: 0.6 + s * 1.0,
    gain: 0.18 + 0.36 * s,
    drive: 2.4,
    knock: 0.6,
  });
  whoosh(c, t + 0.03, {
    dur: 0.6 + s * 0.8,
    gain: 0.07 + 0.11 * s,
    panFrom: pan * 0.3,
    panTo: clamp(pan * 1.6, -1, 1),
    wet: 0.6,
    f0: 600,
    f1: 80,
  });
}

/** A titan falls (titan-neutral): the hush, the catastrophic drop, a lingering cavern and debris coming down for seconds. */
export function playKo(c: VoiceCtx, t: number, _ev: KoEvent, pan: number): void {
  const wet = makeOut(c, pan * 0.4, 0.9);
  const at = catastrophe(c, makeOut(c, 0, 0.1), wet, t, { size: 1 });
  roar(c, wet, at, { f: 36, f1: 22, dur: 3, gain: 0.12, attack: 0.05, lp0: 500, lp1: 90 });
  gravel(c, wet, at + 0.05, { dur: 1.8, grains: 40, f: 380, spread: 2.6, gain: 0.24, lowpass: 1200 });
}

/** Matter-world happenings, scaled by mass moved. */
export function playMatter(c: VoiceCtx, t: number, ev: MatterEvent, pan: number): void {
  const m = clamp01(Math.log10(Math.max(1, ev.mass)) / 3);
  const g = 0.06 + 0.22 * m;
  const o = makeOut(c, pan, 0.3);
  switch (ev.kind) {
    case 'detach':
      boom(c, makeOut(c, pan * 0.4, 0), t, { f0: 84, f1: 36, dur: 0.35 + 0.35 * m, gain: 0.16 + 0.28 * m });
      gravel(c, o, t + 0.02, {
        dur: 0.3 + 0.3 * m,
        grains: 8 + Math.round(m * 14),
        f: 520,
        spread: 2.2,
        gain: g,
        lowpass: 1500,
      });
      break;
    case 'crack':
      noiseHit(c, o, t, {
        dur: 0.04,
        gain: g * 1.1,
        filter: { type: 'bandpass', f0: 900 + c.rand() * 400, q: 1 },
        filter2: { type: 'lowpass', f0: 1800 },
        attack: 0.0008,
      });
      tone(c, o, t, { f0: 180 + c.rand() * 60, f1: 70, dur: 0.18, gain: g * 0.5 });
      break;
    case 'ignite':
      // a world catching fire: a low whoomph, embers
      noiseHit(c, o, t, {
        dur: 0.45,
        gain: g * 1.2,
        kind: 'brown',
        filter: { type: 'bandpass', f0: 160, f1: 520, q: 0.8 },
        attack: 0.05,
      });
      crackle(c, o, t + 0.05, { dur: 0.5, count: 8, gain: g * 0.5, f: 800 });
      break;
    case 'consume':
      tone(c, o, t, { f0: 300, f1: 45, dur: 0.6, gain: g * 1.2, attack: 0.02 });
      break;
    case 'harvest':
      tone(c, o, t, { f0: 90, f1: 220, dur: 0.4, gain: g * 0.9, type: 'triangle', attack: 0.03 });
      break;
    case 'impact':
      boom(c, makeOut(c, pan * 0.4, 0), t, { f0: 96, f1: 40, dur: 0.3 + 0.3 * m, gain: 0.14 + 0.26 * m });
      noiseHit(c, o, t, { dur: 0.1, gain: g, kind: 'brown', filter: { type: 'lowpass', f0: 1200, f1: 250 } });
      break;
    case 'evaporate':
      // matter boiling off into space: a rushing exhale of steam, low
      noiseHit(c, o, t, {
        dur: 0.9,
        gain: g * 0.9,
        filter: { type: 'bandpass', f0: 700, f1: 300, q: 0.7 },
        filter2: { type: 'lowpass', f0: 1500 },
        attack: 0.15,
      });
      break;
    case 'boil':
      gravel(c, o, t, { dur: 0.7, grains: 22, f: 260, spread: 1.6, gain: g, q: 2, lowpass: 900 });
      break;
  }
}

/** Ultimate start/end (titan-neutral): a pressure swell into a catastrophic boom, and a resolving fall. */
export function playUltimate(c: VoiceCtx, t: number, ev: UltimateEvent, pan: number): void {
  const o = makeOut(c, pan * 0.4, 0.7);
  if (ev.phase === 'start') {
    swell(c, o, t, { dur: 1.4, gain: 0.3, f0: 90, f1: 900, sub: 0.2, subHz: 40 });
    roar(c, o, t, { f: 41, f1: 55, dur: 1.5, gain: 0.16, attack: 1.2, lp0: 160, lp1: 700 });
    catastrophe(c, makeOut(c, 0, 0.1), o, t + 1.4, { pre: 0, size: 0.6, gain: 0.85 });
  } else {
    roar(c, o, t, { f: 55, f1: 30, dur: 1.6, gain: 0.12, attack: 0.05, lp0: 700, lp1: 120 });
    rumble(c, o, t, { dur: 1.8, gain: 0.12, f0: 260, f1: 60 });
  }
}

/** Unknown / generic cue: a struck low bell so nothing is silent. */
export function playCueGeneric(c: VoiceCtx, t: number, amount: number, pan: number): void {
  const o = makeOut(c, pan, 0.35);
  lowBell(c, o, t, pick(c, [110, 130.81, 146.83, 164.81]), BELL, {
    decay: 0.6,
    gain: 0.06 + 0.1 * clamp01(amount),
  });
}
