import type { UiSoundId } from '@/contracts';
import { GLASS, makeOut, noiseHit, partials, riser, thump, tone } from './synth';
import type { VoiceCtx } from './types';

/**
 * Per-sound level trim applied by the engine (a bus gain, so the voices below stay authored at natural levels). Measured on
 * the offline harness: the quiet blips sat below the menu score. Fast repeats (move, tick) are kept modest; the big ones
 * (start, roundwin) were already loud and stay at 1.
 */
export const UI_TRIM: Readonly<Record<UiSoundId, number>> = {
  move: 3,
  tick: 3.2,
  back: 2,
  error: 3,
  unpause: 2.6,
  pause: 1.7,
  confirm: 1.7,
  select: 1.2,
  start: 1,
  roundwin: 1,
};

/**
 * Menu sounds: short, soft, glassy and consistent with the game's celadon tonality (D pentatonic). All sit low in the mix
 * so a fast scroll through a menu never becomes fatiguing.
 */
export function playUi(c: VoiceCtx, t: number, id: UiSoundId): void {
  const o = makeOut(c, 0, 0.18);
  switch (id) {
    case 'move':
      tone(c, o, t, { type: 'triangle', f0: 880, dur: 0.07, gain: 0.07, attack: 0.002 });
      tone(c, o, t, { f0: 1760, dur: 0.04, gain: 0.025, attack: 0.001 });
      break;
    case 'confirm':
      partials(c, o, t, 587.33, GLASS, { decay: 0.22, gain: 0.08 });
      partials(c, o, t + 0.07, 880, GLASS, { decay: 0.3, gain: 0.09, shimmer: 0.3 });
      break;
    case 'back':
      partials(c, o, t, 880, GLASS, { decay: 0.16, gain: 0.07 });
      partials(c, o, t + 0.07, 587.33, GLASS, { decay: 0.24, gain: 0.07 });
      break;
    case 'select':
      partials(c, o, t, 1174.66, GLASS, { decay: 0.45, gain: 0.09, shimmer: 0.4 });
      thump(c, makeOut(c, 0, 0), t, 150, 70, 0.14, 0.14);
      break;
    case 'error':
      tone(c, o, t, { type: 'square', f0: 110, dur: 0.09, gain: 0.05 });
      tone(c, o, t + 0.11, { type: 'square', f0: 98, dur: 0.12, gain: 0.05 });
      noiseHit(c, o, t, { dur: 0.05, gain: 0.03, filter: { type: 'lowpass', f0: 600 } });
      break;
    case 'start':
      riser(c, o, t, 0.5, 0.18, 300, 4500);
      thump(c, makeOut(c, 0, 0), t + 0.5, 78, 28, 0.8, 0.55);
      partials(c, o, t + 0.5, 587.33, GLASS, { decay: 1.1, gain: 0.1, shimmer: 0.4 });
      break;
    case 'pause':
      tone(c, o, t, { f0: 740, f1: 240, dur: 0.24, gain: 0.08, attack: 0.005 });
      thump(c, makeOut(c, 0, 0), t, 110, 55, 0.14, 0.12);
      break;
    case 'unpause':
      tone(c, o, t, { f0: 240, f1: 740, dur: 0.2, gain: 0.08, attack: 0.005 });
      break;
    case 'roundwin':
      for (const [i, f] of [587.33, 739.99, 880, 1174.66].entries())
        partials(c, o, t + i * 0.09, f, GLASS, { decay: 0.9, gain: 0.08, shimmer: 0.3 });
      thump(c, makeOut(c, 0, 0), t, 73.4, 36, 1.0, 0.45);
      break;
    case 'tick':
      noiseHit(c, o, t, { dur: 0.012, gain: 0.05, filter: { type: 'highpass', f0: 3000 }, attack: 0.0005 });
      tone(c, o, t, { f0: 1900, dur: 0.03, gain: 0.03, attack: 0.001 });
      break;
  }
}
