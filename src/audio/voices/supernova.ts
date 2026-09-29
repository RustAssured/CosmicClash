import { clamp, clamp01 } from '../dsp/math';
import { cueKind } from './cues';
import { createBed, lfoInto, noiseBand, silentGain, subOut, type Bed } from './kit';
import { gravel, makeOut, noiseHit, riser, thump, tone, whistlePass, type Out } from './synth';
import type { TitanVoice, VoiceCtx } from './types';

/**
 * THE SUPERNOVA: a dying star. A broadband roar that never quite settles, crackle and sizzle riding on it, shock rings that
 * arrive as whumps with long sub tails, the hiss of fuel being burned, and, when it finally goes, a breath in and a blast.
 *
 * The roar is continuous: filtered noise whose centre and level drift on slow, unrelated convection cycles, louder the more fuel
 * it has left; crackle grains are scattered over it at a rate that follows the fuel (a guttering star sputters).
 */
interface Roar {
  bed: Bed;
  band: BiquadFilterNode;
  roar: GainNode;
  boom: GainNode;
  hiss: GainNode;
  convection: GainNode;
  /** The panned tap that crackle grains are scattered into. */
  crackle: Out;
}

export function createSupernovaVoice(): TitanVoice {
  const roars = new Map<number, Roar>();

  /** A blast of hot gas: a sub drop, a falling low-pass burst and a wide roar; `mag` 0..1. */
  const whump = (c: VoiceCtx, t: number, pan: number, mag: number, wet = 0.5): void => {
    const o = makeOut(c, pan, wet);
    thump(c, subOut(c, pan), t, 64 - 10 * mag, 24, 0.6 + 1.2 * mag, 0.4 + 0.4 * mag);
    noiseHit(c, o, t, {
      dur: 0.25 + 0.5 * mag,
      gain: 0.16 + 0.08 * mag,
      filter: { type: 'lowpass', f0: 2600, f1: 140, q: 0.9 },
      kind: 'brown',
      attack: 0.004,
    });
    noiseHit(c, o, t, {
      dur: 0.15 + 0.3 * mag,
      gain: 0.1,
      filter: { type: 'bandpass', f0: 500, f1: 2200, q: 0.7 },
      attack: 0.01,
    });
  };

  /** Crackle and sizzle: a shower of tiny bright grains. */
  const sizzle = (c: VoiceCtx, t: number, pan: number, dur: number, amount: number, f = 3200): void => {
    gravel(c, makeOut(c, pan, 0.3), t, {
      dur,
      grains: Math.max(4, Math.round(26 * Math.min(amount, 1.5))),
      f,
      spread: 1.6,
      gain: 0.1 * amount,
      q: 1.8,
      decayShape: 1.2,
    });
  };

  /** The breath before a blast: noise sucked inward, its filter closing. */
  const inhale = (c: VoiceCtx, t: number, pan: number, dur: number): void => {
    const o = makeOut(c, pan * 0.4, 0.5);
    riser(c, o, t, dur, 0.16, 5200, 260);
    tone(c, o, t, { f0: 260, f1: 70, dur, gain: 0.07, attack: dur * 0.7, type: 'triangle' });
  };

  return {
    titan: 'supernova',

    onMove(c, t, ev) {
      const pan = c.panOf(ev.x);
      // moves burn fuel: a hiss of escaping gas that swells into the move; heavier moves roar underneath it
      const o = makeOut(c, pan, 0.3);
      const heavy = ev.moveSlot === 'crush' || ev.moveSlot === 'ultimate';
      noiseHit(c, o, t, {
        dur: heavy ? 0.5 : 0.24,
        gain: 0.09,
        filter: { type: 'highpass', f0: 3200, q: 0.6 },
        attack: heavy ? 0.25 : 0.1,
      });
      if (heavy)
        noiseHit(c, o, t, {
          dur: 0.55,
          gain: 0.12,
          filter: { type: 'bandpass', f0: 200, f1: 900, q: 0.8 },
          kind: 'brown',
          attack: 0.3,
        });
    },

    onRelease(c, t, ev) {
      const pan = c.panOf(ev.x);
      const p = clamp01(ev.power);
      if (ev.moveSlot === 'crush') whump(c, t, pan, 0.8 + 0.2 * p, 0.6);
      else {
        whump(c, t, pan, 0.3 + 0.3 * p, 0.4);
        sizzle(c, t + 0.02, pan, 0.3, 0.6);
      }
    },

    onSurge(c, t, ev) {
      // a flare streaking past: rising filtered noise and a bent tone, sparks in its wake
      const pan = c.panOf(ev.x);
      const dir = Math.sign(ev.dirX || 1);
      whistlePass(c, t, {
        f: 420,
        dur: 0.5,
        gain: 0.1,
        panFrom: clamp(pan - 0.6 * dir, -1, 1),
        panTo: clamp(pan + 0.6 * dir, -1, 1),
        wet: 0.4,
        approach: 0.7,
        recede: 1.9,
      });
      noiseHit(c, makeOut(c, pan, 0.3), t, {
        dur: 0.5,
        gain: 0.22,
        filter: { type: 'bandpass', f0: 400, f1: 3200, q: 0.9 },
        attack: 0.12,
      });
      sizzle(c, t + 0.15, pan, 0.4, 0.5);
    },

    onHitDealt(c, t, ev, mag) {
      const pan = c.panOf(ev.x);
      sizzle(c, t, pan, 0.25 + 0.3 * mag, ev.type === 'THERMAL' ? 0.8 : 0.5);
      if (ev.type === 'THERMAL')
        noiseHit(c, makeOut(c, pan, 0.3), t, {
          dur: 0.3,
          gain: 0.08,
          filter: { type: 'highpass', f0: 4200 },
          attack: 0.05,
        });
    },

    onHitTaken(c, t, ev, mag) {
      // the body is plasma: a hit splashes it, the gas roars and settles
      const pan = c.panOf(ev.x);
      const open = 1 - clamp01(ev.blocked) * 0.7;
      const o = makeOut(c, pan, 0.4);
      noiseHit(c, o, t, {
        dur: 0.2 + 0.4 * mag,
        gain: (0.14 + 0.1 * mag) * open,
        filter: { type: 'bandpass', f0: 900, f1: 180, q: 1.1 },
        attack: 0.004,
      });
      if (mag > 0.5) whump(c, t + 0.01, pan, mag * open, 0.5);
      if (ev.onDamaged > 0.3) sizzle(c, t + 0.03, pan, 0.4, 0.5 * open, 2200);
    },

    onGuard(c, t, ev) {
      // a plasma shield: hiss with a slow tremble, and a thud when it takes the blow
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.4);
      noiseHit(c, o, t, {
        dur: ev.broke ? 0.8 : 0.4,
        gain: ev.broke ? 0.18 : 0.12,
        filter: { type: 'bandpass', f0: 1300, f1: 600, q: 1.2 },
        attack: 0.02,
      });
      thump(c, subOut(c, pan), t, 100, 42, ev.broke ? 0.7 : 0.3, ev.broke ? 0.55 : 0.28);
      if (ev.broke) sizzle(c, t + 0.03, pan, 0.6, 1);
    },

    onKo(c, t, ev) {
      // the star gives out: it breathes in, then blows apart, and the embers crackle on for a long time
      const pan = c.panOf(ev.x);
      inhale(c, t, pan, 0.7);
      whump(c, t + 0.7, pan, 0.7, 0.8);
      thump(c, subOut(c, 0), t + 0.7, 48, 16, 2.6, 0.45);
      sizzle(c, t + 0.8, pan, 2.2, 0.8, 2400);
    },

    onUltimate(c, t, ev) {
      const pan = c.panOf(ev.x);
      if (ev.phase === 'start') {
        // the final nova: a long inhale as the star gathers itself, then the blast and a shock ring
        inhale(c, t, pan, 1.8);
        noiseHit(c, makeOut(c, pan * 0.3, 0.6), t, {
          dur: 1.9,
          gain: 0.1,
          filter: { type: 'lowpass', f0: 300, f1: 1400, q: 0.8 },
          kind: 'brown',
          attack: 1.5,
        });
        whump(c, t + 1.8, pan, 0.75, 0.9);
        thump(c, subOut(c, 0), t + 1.8, 44, 14, 3.2, 0.6);
      } else {
        sizzle(c, t, pan, 1.6, 0.8);
      }
    },

    onMatter(c, t, ev) {
      const pan = c.panOf(ev.x);
      const m = clamp01(Math.log10(Math.max(1, ev.mass)) / 3);
      switch (ev.kind) {
        case 'ignite':
          whump(c, t, pan, 0.15 + 0.3 * m, 0.4);
          sizzle(c, t + 0.03, pan, 0.4, 0.5 + 0.4 * m);
          return true;
        case 'evaporate':
        case 'boil':
          noiseHit(c, makeOut(c, pan, 0.3), t, {
            dur: 0.7,
            gain: 0.08 + 0.05 * m,
            filter: { type: 'highpass', f0: 3600, q: 0.6 },
            attack: 0.15,
          });
          return true;
        default:
          return false;
      }
    },

    onCue(c, t, ev) {
      const pan = c.panOf(ev.x);
      const a = clamp01(ev.amount);
      switch (cueKind(ev.id)) {
        case 'shed':
        case 'blow':
        case 'break':
          // outer layers blow off: a whump and a burst of crackle
          whump(c, t, pan, 0.5 + 0.3 * a, 0.6);
          sizzle(c, t + 0.02, pan, 0.8, 1);
          return;
        case 'burn':
          // fuel burning: a hiss that flares and a rising whoosh of heat
          sizzle(c, t, pan, 0.9, 1.3, 4200);
          tone(c, makeOut(c, pan, 0.4), t, {
            f0: 90,
            f1: 260,
            dur: 0.7,
            gain: 0.2,
            attack: 0.08,
            type: 'triangle',
          });
          return;
        case 'collapse':
          inhale(c, t, pan, 0.8);
          whump(c, t + 0.8, pan, 1, 0.8);
          return;
        case 'lost':
        case 'dark': {
          // fuel running out: the crackle gutters and thins
          sizzle(c, t, pan, 1.0, 2.2, 2600);
          tone(c, makeOut(c, pan, 0.4), t, {
            f0: 220,
            f1: 60,
            dur: 0.9,
            gain: 0.22,
            attack: 0.05,
            type: 'triangle',
          });
          return;
        }
        default:
          whump(c, t, pan, 0.25 + 0.2 * a, 0.4);
          sizzle(c, t + 0.02, pan, 0.3, 0.5);
      }
    },

    update(c, scene, slot, dt) {
      const ac = c.ac;
      let r = roars.get(slot);
      if (!r) {
        const bed = createBed(c, 0.35);
        // the roar: white noise band-passed near 650 Hz whose centre and level breathe on two slow, unrelated convection cycles
        const roar = silentGain(c, bed.input);
        const { filter: band } = noiseBand(c, bed, roar, { kind: 'white', type: 'bandpass', f: 650, q: 0.5 });
        lfoInto(c, bed, band.frequency, 0.11, 240);
        const convection = lfoInto(c, bed, roar.gain, 0.17, 0).depth;
        // a deep boil underneath, and a high hiss on top
        const boom = silentGain(c, bed.input);
        noiseBand(c, bed, boom, { kind: 'brown', type: 'lowpass', f: 170, q: 0.7 });
        const hiss = silentGain(c, bed.input);
        noiseBand(c, bed, hiss, { kind: 'white', type: 'highpass', f: 4200, q: 0.6 });
        const crackle: Out = { input: bed.input, close: () => undefined };
        r = { bed, band, roar, boom, hiss, convection, crackle };
        roars.set(slot, r);
      }
      const now = ac.currentTime;
      const fuel = clamp01(scene.resource);
      const move = clamp01(scene.speed / 600);
      const g = 0.025 + 0.03 * fuel + 0.012 * move;
      r.roar.gain.setTargetAtTime(g * 0.7, now, 0.35);
      r.convection.gain.setTargetAtTime(g * 0.3, now, 0.35);
      r.boom.gain.setTargetAtTime(0.03 + 0.05 * fuel, now, 0.4);
      r.hiss.gain.setTargetAtTime(0.002 + 0.006 * fuel + 0.004 * move, now, 0.3);
      r.bed.pan.pan.setTargetAtTime(clamp(c.panOf(scene.x), -1, 1), now, 0.1);
      // crackle: a Poisson scatter of tiny bright grains, about 5 a second when starved and 20 when full of fuel
      if (c.rand() < (5 + 15 * fuel) * dt) {
        noiseHit(c, r.crackle, now + 0.004, {
          dur: 0.006 + 0.03 * c.rand(),
          gain: 0.02 + 0.05 * c.rand(),
          filter: { type: 'highpass', f0: 2200 + 4500 * c.rand(), q: 0.7 },
          attack: 0.0006,
        });
      }
    },

    stop(slot) {
      for (const s of slot === 'all' ? [...roars.keys()] : [slot]) {
        roars.get(s)?.bed.dispose();
        roars.delete(s);
      }
    },
  };
}
