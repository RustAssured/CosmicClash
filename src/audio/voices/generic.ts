import type { TitanId } from '@/contracts';
import { clamp01 } from '../dsp/math';
import { GLASS, IRON, gravel, makeOut, noiseHit, partials, thump, tone } from './synth';
import type { TitanVoice } from './types';

/**
 * Sonic identity for titans that do not have a dedicated voice file yet (Phase 2). Not a stub: every titan sounds
 * different, driven by a small table — Nexus metallic chains over a low pulse, Black Hole a pitch-bending sub, Supernova
 * roaring plasma and crackle, Planet tectonic rumble and wind — sitting on the shared damage-type layers.
 */
interface Flavor {
  ring: { hz: number; set: typeof GLASS };
  /** Body noise colour on a hit. */
  bodyHz: number;
  crackle: number;
  sub: number;
}

const FLAVORS: Partial<Record<TitanId, Flavor>> = {
  nexus: { ring: { hz: 300, set: IRON }, bodyHz: 1400, crackle: 3200, sub: 52 },
  blackhole: { ring: { hz: 110, set: GLASS }, bodyHz: 300, crackle: 800, sub: 34 },
  supernova: { ring: { hz: 520, set: GLASS }, bodyHz: 2600, crackle: 4800, sub: 60 },
  planet: { ring: { hz: 150, set: IRON }, bodyHz: 260, crackle: 900, sub: 40 },
};
const DEFAULT: Flavor = { ring: { hz: 400, set: IRON }, bodyHz: 900, crackle: 2400, sub: 50 };

export function createGenericVoice(titan: TitanId): TitanVoice {
  const f = FLAVORS[titan] ?? DEFAULT;
  return {
    titan,
    onMove(c, t, ev) {
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.3);
      noiseHit(c, o, t, {
        dur: 0.2,
        gain: 0.09,
        filter: { type: 'bandpass', f0: f.bodyHz * 0.6, f1: f.bodyHz * 1.6, q: 1.2 },
        attack: 0.05,
      });
      tone(c, o, t, {
        f0: f.sub * 2,
        f1: f.sub * 3.5,
        dur: 0.25,
        gain: 0.08,
        type: 'triangle',
        attack: 0.06,
      });
    },
    onRelease(c, t, ev) {
      const pan = c.panOf(ev.x);
      const p = clamp01(ev.power);
      thump(c, makeOut(c, pan * 0.3, 0), t, f.sub * 2.4, f.sub * 0.6, 0.3 + 0.4 * p, 0.2 + 0.3 * p);
      gravel(c, makeOut(c, pan, 0.3), t, {
        dur: 0.3,
        grains: 12,
        f: f.crackle,
        spread: 1.6,
        gain: 0.08,
        q: 2.4,
      });
    },
    onHitTaken(c, t, ev, mag) {
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.4);
      partials(c, o, t, f.ring.hz * (1.3 - 0.4 * mag), f.ring.set, {
        decay: 0.3 + 0.9 * mag,
        gain: 0.06 + 0.08 * mag,
      });
    },
    onGuard(c, t, ev) {
      const pan = c.panOf(ev.x);
      partials(c, makeOut(c, pan, 0.4), t, f.ring.hz * 1.5, f.ring.set, {
        decay: ev.broke ? 0.9 : 0.4,
        gain: ev.broke ? 0.16 : 0.11,
      });
      thump(c, makeOut(c, pan * 0.3, 0), t, 105, 44, ev.broke ? 0.7 : 0.3, ev.broke ? 0.6 : 0.3);
    },
  };
}
