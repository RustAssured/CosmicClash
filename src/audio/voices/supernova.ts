import { clamp, clamp01 } from '../dsp/math';
import { cueKind } from './cues';
import { createBed, lfoInto, noiseBand, silentGain, subOut, type Bed } from './kit';
import { makeOut, noiseHit, tone, type Out } from './synth';
import type { TitanVoice, VoiceCtx } from './types';
import { boom, catastrophe, crackle, roar, rumble, swell, whoosh } from './epic';

/**
 * THE SUPERNOVA: a dying star. D34 took the hiss out of its fire (a constant 4.2 kHz hiss, 3.2 kHz highpassed windups, crackle
 * grains at 2–7 kHz, a rising 420 Hz Doppler flare): it is now a FURNACE — a deep roar that never settles, convection heaving in
 * it, embers crackling low, shock rings arriving as whumps with long sub tails, and, when it finally goes, a breath in and a blast
 * that rolls on for seconds.
 *
 * The roar is continuous: brown noise in a low band whose centre and level drift on slow, unrelated convection cycles, louder the
 * more fuel it has left; ember crackle is scattered over it at a rate that follows the fuel (a guttering star sputters).
 */
interface Roar {
  bed: Bed;
  band: BiquadFilterNode;
  roar: GainNode;
  boom: GainNode;
  flame: GainNode;
  convection: GainNode;
  /** The panned tap that ember crackle is scattered into. */
  crackle: Out;
}

export function createSupernovaVoice(): TitanVoice {
  const roars = new Map<number, Roar>();

  /** A blast of stellar fire: the drop, a falling low-passed burst and a wide roar of gas; `mag` 0..1. */
  const whump = (c: VoiceCtx, t: number, pan: number, mag: number, wet = 0.5): void => {
    const o = makeOut(c, pan, wet);
    boom(c, subOut(c, pan), t, {
      f0: 70 - 12 * mag,
      f1: 22,
      dur: 0.7 + 1.3 * mag,
      gain: 0.4 + 0.4 * mag,
      drive: 3,
    });
    noiseHit(c, o, t, {
      dur: 0.35 + 0.6 * mag,
      gain: 0.2 + 0.1 * mag,
      filter: { type: 'lowpass', f0: 1400, f1: 120, q: 0.9 },
      kind: 'brown',
      attack: 0.004,
    });
    noiseHit(c, o, t, {
      dur: 0.25 + 0.4 * mag,
      gain: 0.12,
      kind: 'brown',
      filter: { type: 'bandpass', f0: 220, f1: 700, q: 0.7 },
      attack: 0.01,
    });
  };

  /** Embers: a shower of low-passed crackle (it was 3–4 kHz sizzle). */
  const embers = (c: VoiceCtx, t: number, pan: number, dur: number, amount: number): void => {
    crackle(c, makeOut(c, pan, 0.35), t, {
      dur,
      count: Math.max(4, Math.round(16 * Math.min(amount, 1.5))),
      gain: 0.1 * amount,
      f: 800,
    });
  };

  /** The breath before a blast: the furnace drawing in, its roar closing down. */
  const inhale = (c: VoiceCtx, t: number, pan: number, dur: number): void => {
    const o = makeOut(c, pan * 0.4, 0.5);
    noiseHit(c, o, t, {
      dur,
      gain: 0.22,
      kind: 'brown',
      filter: { type: 'lowpass', f0: 900, f1: 100, q: 1.2 },
      attack: dur * 0.7,
    });
    tone(c, o, t, { f0: 160, f1: 50, dur, gain: 0.08, attack: dur * 0.7, type: 'triangle' });
  };

  return {
    titan: 'supernova',

    onMove(c, t, ev) {
      const pan = c.panOf(ev.x);
      // moves burn fuel: the furnace flares into the move (a reversed swell); heavier moves roar under it
      const o = makeOut(c, pan, 0.3);
      const heavy = ev.moveSlot === 'crush' || ev.moveSlot === 'ultimate';
      swell(c, o, t, {
        dur: heavy ? 0.5 : 0.24,
        gain: heavy ? 0.36 : 0.3,
        f0: 120,
        f1: heavy ? 900 : 700,
        sub: heavy ? 0.08 : 0,
        subHz: 40,
      });
      if (heavy) roar(c, o, t, { f: 46, f1: 55, dur: 0.55, gain: 0.07, attack: 0.35, lp0: 200, lp1: 600 });
    },

    onRelease(c, t, ev) {
      const pan = c.panOf(ev.x);
      const p = clamp01(ev.power);
      if (ev.moveSlot === 'crush') whump(c, t, pan, 0.8 + 0.2 * p, 0.6);
      else {
        whump(c, t, pan, 0.3 + 0.3 * p, 0.4);
        embers(c, t + 0.02, pan, 0.4, 0.6);
      }
    },

    onSurge(c, t, ev) {
      // a flare streaking past: a roaring pass of fire, embers in its wake
      const pan = c.panOf(ev.x);
      const dir = Math.sign(ev.dirX || 1);
      whoosh(c, t, {
        dur: 0.55,
        gain: 0.14,
        panFrom: clamp(pan - 0.6 * dir, -1, 1),
        panTo: clamp(pan + 0.6 * dir, -1, 1),
        wet: 0.4,
        f0: 900,
        f1: 160,
        body: 1,
      });
      embers(c, t + 0.15, pan, 0.4, 0.5);
    },

    onHitDealt(c, t, ev, mag) {
      const pan = c.panOf(ev.x);
      embers(c, t, pan, 0.3 + 0.3 * mag, ev.type === 'THERMAL' ? 0.8 : 0.5);
      if (ev.type === 'THERMAL')
        noiseHit(c, makeOut(c, pan, 0.3), t, {
          dur: 0.4,
          gain: 0.12,
          kind: 'brown',
          filter: { type: 'bandpass', f0: 300, f1: 800, q: 0.8 },
          attack: 0.05,
        });
    },

    onHitTaken(c, t, ev, mag) {
      // the body is plasma: a hit splashes it, the gas roars and settles
      const pan = c.panOf(ev.x);
      const open = 1 - clamp01(ev.blocked) * 0.7;
      const o = makeOut(c, pan, 0.45);
      noiseHit(c, o, t, {
        dur: 0.3 + 0.5 * mag,
        gain: (0.3 + 0.2 * mag) * open,
        filter: { type: 'bandpass', f0: 800, f1: 180, q: 0.9 },
        filter2: { type: 'lowpass', f0: 1800 },
        attack: 0.004,
      });
      if (mag > 0.5) whump(c, t + 0.01, pan, mag * open, 0.5);
      if (ev.onDamaged > 0.3) embers(c, t + 0.03, pan, 0.5, 0.5 * open);
    },

    onGuard(c, t, ev) {
      // a plasma shield: a roar of gas with a slow tremble, and a thud when it takes the blow
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.4);
      noiseHit(c, o, t, {
        dur: ev.broke ? 0.8 : 0.4,
        gain: ev.broke ? 0.2 : 0.14,
        kind: 'brown',
        filter: { type: 'bandpass', f0: 500, f1: 220, q: 1 },
        attack: 0.02,
      });
      boom(c, subOut(c, pan), t, {
        f0: 100,
        f1: 42,
        dur: ev.broke ? 0.8 : 0.35,
        gain: ev.broke ? 0.55 : 0.28,
      });
      if (ev.broke) embers(c, t + 0.03, pan, 0.6, 1);
    },

    onKo(c, t, ev) {
      // the star gives out: it breathes in (the hush), blows apart, and its fire rolls on for seconds
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.85);
      inhale(c, t, pan, 0.45);
      const at = catastrophe(c, subOut(c, 0), o, t, { pre: 0.45, size: 1, f0: 50 });
      roar(c, o, at, { f: 41, f1: 30, dur: 3.2, gain: 0.12, attack: 0.04, lp0: 900, lp1: 140 });
      embers(c, at + 0.1, pan, 2.6, 0.9);
    },

    onUltimate(c, t, ev) {
      const pan = c.panOf(ev.x);
      if (ev.phase === 'start') {
        // the final nova: a long inhale as the star gathers itself, then the blast and the shock rolling outward
        const o = makeOut(c, pan * 0.3, 0.7);
        inhale(c, t, pan, 1.8);
        roar(c, o, t, { f: 55, f1: 36, dur: 1.9, gain: 0.12, attack: 1.5, lp0: 200, lp1: 800 });
        catastrophe(c, subOut(c, 0), o, t + 1.8, { pre: 0, size: 0.8, gain: 0.95, f0: 46 });
        whoosh(c, t + 1.85, {
          dur: 1.4,
          gain: 0.16,
          panFrom: 0,
          panTo: clamp(pan * 2, -1, 1),
          wet: 0.7,
          f0: 700,
        });
      } else {
        embers(c, t, pan, 1.6, 0.8);
        rumble(c, makeOut(c, pan, 0.6), t, { dur: 1.8, gain: 0.1, f0: 240, f1: 60 });
      }
    },

    onMatter(c, t, ev) {
      const pan = c.panOf(ev.x);
      const m = clamp01(Math.log10(Math.max(1, ev.mass)) / 3);
      switch (ev.kind) {
        case 'ignite':
          whump(c, t, pan, 0.15 + 0.3 * m, 0.4);
          embers(c, t + 0.03, pan, 0.4, 0.5 + 0.4 * m);
          return true;
        case 'evaporate':
        case 'boil':
          noiseHit(c, makeOut(c, pan, 0.3), t, {
            dur: 0.8,
            gain: 0.45 + 0.2 * m,
            filter: { type: 'bandpass', f0: 600, f1: 260, q: 0.7 },
            filter2: { type: 'lowpass', f0: 1400 },
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
          // outer layers blow off: a whump and a burst of embers
          whump(c, t, pan, 0.5 + 0.3 * a, 0.6);
          embers(c, t + 0.02, pan, 0.8, 1);
          return;
        case 'burn':
          // fuel burning: the furnace flares and heat rolls up out of it
          roar(c, makeOut(c, pan, 0.4), t, {
            f: 46,
            f1: 62,
            dur: 0.8,
            gain: 0.26,
            attack: 0.1,
            lp0: 220,
            lp1: 900,
          });
          embers(c, t, pan, 0.9, 1);
          return;
        case 'collapse':
          inhale(c, t, pan, 0.8);
          whump(c, t + 0.8, pan, 1, 0.8);
          rumble(c, makeOut(c, pan, 0.7), t + 0.8, { dur: 2.4, gain: 0.14, f0: 280, f1: 55 });
          return;
        case 'lost':
        case 'dark': {
          // fuel running out: the furnace gutters and sinks
          embers(c, t, pan, 1.0, 1.4);
          tone(c, makeOut(c, pan, 0.4), t, {
            f0: 140,
            f1: 45,
            dur: 1,
            gain: 0.22,
            attack: 0.05,
            type: 'triangle',
          });
          return;
        }
        default:
          whump(c, t, pan, 0.25 + 0.2 * a, 0.4);
          embers(c, t + 0.02, pan, 0.3, 0.5);
      }
    },

    update(c, scene, slot, dt) {
      const ac = c.ac;
      let r = roars.get(slot);
      if (!r) {
        const bed = createBed(c, 0.4);
        // the roar: brown noise band-passed low, whose centre and level breathe on two slow, unrelated convection cycles
        const roarG = silentGain(c, bed.input);
        const { filter: band } = noiseBand(c, bed, roarG, {
          kind: 'brown',
          type: 'bandpass',
          f: 280,
          q: 0.6,
        });
        lfoInto(c, bed, band.frequency, 0.11, 110);
        const convection = lfoInto(c, bed, roarG.gain, 0.17, 0).depth;
        // a deep boil underneath, and the flame on top (a low-mid band, not a hiss)
        const boomG = silentGain(c, bed.input);
        noiseBand(c, bed, boomG, { kind: 'brown', type: 'lowpass', f: 150, q: 0.7 });
        const flame = silentGain(c, bed.input);
        noiseBand(c, bed, flame, { kind: 'white', type: 'bandpass', f: 700, q: 0.8 });
        const crackleOut: Out = { input: bed.input, close: () => undefined };
        r = { bed, band, roar: roarG, boom: boomG, flame, convection, crackle: crackleOut };
        roars.set(slot, r);
      }
      const now = ac.currentTime;
      const fuel = clamp01(scene.resource);
      const move = clamp01(scene.speed / 600);
      const g = 0.04 + 0.1 * fuel + 0.03 * move;
      r.roar.gain.setTargetAtTime(g * 0.7, now, 0.35);
      r.convection.gain.setTargetAtTime(g * 0.3, now, 0.35);
      r.boom.gain.setTargetAtTime(0.03 + 0.05 * fuel, now, 0.4);
      r.flame.gain.setTargetAtTime(0.003 + 0.008 * fuel + 0.006 * move, now, 0.3);
      r.bed.pan.pan.setTargetAtTime(clamp(c.panOf(scene.x), -1, 1), now, 0.1);
      // embers: a Poisson scatter of low-passed crackle, about 3 a second when starved and 10 when full of fuel
      if (c.rand() < (3 + 7 * fuel) * dt) {
        noiseHit(c, r.crackle, now + 0.004, {
          dur: 0.01 + 0.03 * c.rand(),
          gain: 0.03 + 0.05 * c.rand(),
          filter: { type: 'bandpass', f0: 500 + 900 * c.rand(), q: 1.2 },
          filter2: { type: 'lowpass', f0: 2000 },
          attack: 0.0008,
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
