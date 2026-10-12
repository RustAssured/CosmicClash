import { clamp01 } from '../dsp/math';
import type { KitVoiceTuning, TitanId } from '@/contracts';
import { makeOut, noiseHit } from './synth';
import { subOut } from './kit';
import { boom, crackle, grind, rumble, swell } from './epic';
import type { TitanVoice } from './types';

/**
 * The titan kit's voice: one generic, epic-and-low voice (D34: no whistles) tuned by four numbers in the titan's JSON
 * (`kit.voice`: pitch, grit, ring, wet). A kit titan sounds like itself from day one; a bespoke voice file (like
 * asteroid.ts) can replace it later in VOICES. Every handler it leaves out falls back to the shared sounds in sfx.ts.
 */
export function createKitVoice(id: TitanId, v: KitVoiceTuning): TitanVoice {
  const f = Math.max(25, Math.min(160, v.pitch));
  const grit = clamp01(v.grit);
  const ring = clamp01(v.ring);
  const wet = 0.15 + 0.5 * clamp01(v.wet);
  return {
    titan: id,
    onMove(c, t, ev) {
      // the wind-up: a rising swell, grittier titans grind as they gather
      const o = makeOut(c, c.panOf(ev.x), wet);
      swell(c, o, t, { dur: 0.4, gain: 0.12, f0: f * 1.5, f1: f * 6, sub: 0.06, subHz: f * 0.6 });
      if (grit > 0.3)
        grind(c, o, t, { dur: 0.35, gain: 0.06 * grit, f0: f * 2, f1: f * 4, rate: 7, attack: 0.1 });
    },
    onHitDealt(c, t, ev, mag) {
      const pan = c.panOf(ev.x);
      boom(c, subOut(c, pan), t, {
        f0: f * (1.1 - 0.3 * mag),
        f1: f * 0.4,
        dur: 0.3 + 0.5 * mag,
        gain: 0.25 + 0.35 * mag,
        drive: 1.5 + 2.5 * grit,
      });
      if (grit > 0.2)
        crackle(c, makeOut(c, pan, wet), t, {
          dur: 0.25 + 0.3 * mag,
          count: Math.round(6 + 14 * grit * mag),
          gain: 0.12 * grit,
          f: 600,
        });
    },
    onHitTaken(c, t, ev, mag) {
      const o = makeOut(c, c.panOf(ev.x), wet);
      noiseHit(c, o, t, {
        dur: 0.12 + 0.2 * mag,
        gain: 0.18 + 0.15 * mag,
        filter: {
          type: ring > 0.5 ? 'bandpass' : 'lowpass',
          f0: f * (6 + 10 * ring),
          f1: f * 2,
          q: 1 + 6 * ring,
        },
      });
    },
    onKo(c, t, ev) {
      const pan = c.panOf(ev.x);
      rumble(c, makeOut(c, pan, wet + 0.2), t, { dur: 2.4, gain: 0.35, f0: f * 5, f1: f });
      boom(c, subOut(c, pan), t, { f0: f, f1: f * 0.35, dur: 1.6, gain: 0.6, drive: 3 });
    },
    onUltimate(c, t, ev) {
      const o = makeOut(c, c.panOf(ev.x), wet + 0.2);
      swell(c, o, t, { dur: 1.2, gain: 0.22, f0: f, f1: f * 10, sub: 0.12, subHz: f * 0.5 });
    },
  };
}
