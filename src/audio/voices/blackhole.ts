import { clamp, clamp01 } from '../dsp/math';
import { cueKind } from './cues';
import { createBed, lfoInto, noiseBand, silentGain, subOut, type Bed } from './kit';
import { BELL, makeOut, noiseHit, tone } from './synth';
import type { TitanVoice, VoiceCtx } from './types';
import { boom, catastrophe, crackle, lowBell, roar, rumble, swell, whoosh } from './epic';

/**
 * THE BLACK HOLE: a true-black horizon, a photon ring, an accretion disk. It is gravity itself: a sub drone whose pitch bends with
 * its mass (saturated, so its harmonics reach a laptop), an accretion disk that roars low, everything pulled INWARD, and silence.
 *
 * - The drone is continuous: heavier is LOWER and STRONGER, the mass it has accreted (`resource`) thickens it with an octave, and
 *   slow pockets of near-silence open and close in it, like the horizon swallowing the sound itself. When it is nearly out of
 *   mass it evaporates: a dark crackle of Hawking radiation (low-passed grains, not glitter) frays its edges.
 * - Tidal pull is pressure converging from both sides and sinking into the sub (it was a rising 0.5→1.8 kHz whistle pair);
 *   consumption is a gulp with a pitch drop; a Surge is a mass bending the air; the disk shedding is a roar flung outward (it was a
 *   3.4 kHz whistle and 3–8 kHz hiss); the Ultimate inhales, goes silent, and then lands.
 */
interface Drone {
  bed: Bed;
  a: OscillatorNode;
  b: OscillatorNode;
  h2: OscillatorNode;
  level: GainNode;
  partials: GainNode;
  pocketA: GainNode;
  pocketB: GainNode;
  disk: GainNode;
  diskBand: BiquadFilterNode;
  /** The evaporation: dark crackle as it runs out of mass. */
  fray: GainNode;
}

export function createBlackHoleVoice(): TitanVoice {
  const drones = new Map<number, Drone>();

  /** Something swallowed: a body that falls away in pitch with a suction of air behind it, and the drop. */
  const gulp = (c: VoiceCtx, t: number, pan: number, mag: number, wet = 0.3): void => {
    const o = makeOut(c, pan, wet);
    tone(c, o, t, {
      f0: 220 - 70 * mag,
      f1: 36,
      dur: 0.3 + 0.5 * mag,
      gain: 0.1 + 0.06 * mag,
      attack: 0.008,
      glide: 0.25 + 0.4 * mag,
    });
    noiseHit(c, o, t, {
      dur: 0.35 + 0.35 * mag,
      gain: 0.3,
      filter: { type: 'bandpass', f0: 900, f1: 90, q: 1.1 },
      filter2: { type: 'lowpass', f0: 1600 },
      attack: 0.03,
    });
    boom(c, subOut(c, pan), t + 0.05, {
      f0: 70,
      f1: 24,
      dur: 0.5 + 0.6 * mag,
      gain: 0.3 + 0.3 * mag,
      drive: 3,
    });
  };

  /** Tidal pull: pressure converging from both sides into the centre and sinking, ending in the drop. */
  const spiral = (c: VoiceCtx, t: number, pan: number, dur: number, gain: number, sub = 0.35): void => {
    for (const side of [-1, 1] as const)
      whoosh(c, t, {
        dur,
        gain,
        panFrom: clamp(pan + side * 0.9, -1, 1),
        panTo: clamp(pan * 0.3, -1, 1),
        wet: 0.45,
        f0: 600,
        f1: 70,
      });
    boom(c, subOut(c, pan), t + dur * 0.9, { f0: 66, f1: 24, dur: 0.6, gain: sub, drive: 3 });
  };

  /** Hawking radiation: the horizon fraying — dark crackle over a low exhale (no glitter, no hiss). */
  const hawking = (c: VoiceCtx, t: number, pan: number, dur: number, amount: number, level = 1): void => {
    const o = makeOut(c, pan, 0.5);
    crackle(c, o, t, { dur, count: Math.round(10 + 30 * amount), gain: 0.4 * level, f: 1300 });
    noiseHit(c, o, t, {
      dur,
      gain: 0.35 * amount * level,
      filter: { type: 'bandpass', f0: 500, f1: 200, q: 0.8 },
      attack: dur * 0.3,
    });
  };

  return {
    titan: 'blackhole',

    onMove(c, t, ev) {
      const pan = c.panOf(ev.x);
      switch (ev.moveSlot) {
        case 'strike': {
          // gravity gathers: a low swelling pull
          swell(c, makeOut(c, pan * 0.4, 0.3), t, {
            dur: 0.3,
            gain: 0.09,
            f0: 80,
            f1: 400,
            sub: 0.08,
            subHz: 36,
          });
          break;
        }
        case 'crush': {
          // the well deepens: an inhale of falling air
          noiseHit(c, makeOut(c, pan * 0.4, 0.5), t, {
            dur: 0.6,
            gain: 0.5,
            kind: 'brown',
            filter: { type: 'lowpass', f0: 900, f1: 120, q: 0.9 },
            attack: 0.35,
          });
          break;
        }
        case 'signature': {
          spiral(c, t, pan, 0.5, 0.05, 0.08);
          break;
        }
        case 'ultimate': {
          roar(c, makeOut(c, 0, 0.5), t, {
            f: 41,
            f1: 30,
            dur: 1.2,
            gain: 0.14,
            attack: 0.6,
            lp0: 300,
            lp1: 120,
          });
          break;
        }
        case 'guard':
        case 'surge':
          break;
      }
    },

    onRelease(c, t, ev) {
      const pan = c.panOf(ev.x);
      const p = clamp01(ev.power);
      if (ev.moveSlot === 'crush') {
        boom(c, subOut(c, pan), t, { f0: 64, f1: 20, dur: 1.4, gain: 0.55 + 0.25 * p, drive: 3.2 });
        gulp(c, t, pan, 0.8, 0.5);
      } else if (ev.moveSlot === 'signature') {
        spiral(c, t, pan, 0.45, 0.09);
      } else {
        const o = makeOut(c, pan, 0.3);
        tone(c, o, t, { f0: 180, f1: 50, dur: 0.35, gain: 0.09, attack: 0.004 });
        boom(c, subOut(c, pan), t, { f0: 80, f1: 30, dur: 0.45, gain: 0.3 + 0.2 * p });
      }
    },

    onSurge(c, t, ev) {
      // a mass that bends space passing by: the air pulled after it, the sub leaning with it
      const pan = c.panOf(ev.x);
      const dir = Math.sign(ev.dirX || 1);
      whoosh(c, t, {
        dur: 0.6,
        gain: 0.1,
        panFrom: clamp(pan - 0.7 * dir, -1, 1),
        panTo: clamp(pan + 0.7 * dir, -1, 1),
        wet: 0.4,
        f0: 500,
        f1: 70,
        body: 1.3,
      });
      tone(c, makeOut(c, pan * 0.3, 0), t, { f0: 70, f1: 38, dur: 0.6, gain: 0.12, attack: 0.1 });
    },

    onHitDealt(c, t, ev, mag) {
      const pan = c.panOf(ev.x);
      if (ev.type === 'TIDAL') spiral(c, t, pan, 0.35 + 0.25 * mag, 0.06 + 0.03 * mag, 0.2);
      else
        boom(c, subOut(c, pan), t + 0.01, { f0: 58, f1: 22, dur: 0.5 + 0.5 * mag, gain: 0.18 + 0.2 * mag });
    },

    onHitTaken(c, t, ev, mag) {
      // hits vanish into it: a gulp, and only the photon ring answers, low (the horizon cannot be struck)
      const pan = c.panOf(ev.x);
      const open = 1 - clamp01(ev.blocked) * 0.7;
      gulp(c, t, pan, mag * open, 0.4);
      if (ev.onDamaged > 0.3)
        lowBell(c, makeOut(c, pan, 0.6), t + 0.02, 110, BELL, { decay: 0.9, gain: 0.05 * open });
    },

    onGuard(c, t, ev) {
      // a gravity shell: a dense low hum that swells and falls
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan * 0.4, 0.5);
      tone(c, o, t, {
        f0: 96,
        f1: 64,
        dur: ev.broke ? 0.9 : 0.45,
        gain: ev.broke ? 0.2 : 0.22,
        attack: 0.02,
      });
      tone(c, o, t, {
        f0: 96.7,
        f1: 64.4,
        dur: ev.broke ? 0.9 : 0.45,
        gain: ev.broke ? 0.18 : 0.2,
        attack: 0.02,
      });
      if (ev.broke) gulp(c, t + 0.05, pan, 0.9, 0.5);
    },

    onKo(c, t, ev) {
      // the horizon collapses: the hush (everything falls in), the drop, then the drone climbs and frays away into crackle
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan * 0.3, 0.8);
      const at = catastrophe(c, subOut(c, pan), o, t, { pre: 0.42, size: 1, f0: 52 });
      roar(c, o, at, { f: 32, f1: 64, dur: 2.6, gain: 0.1, attack: 0.08, lp0: 200, lp1: 420 });
      hawking(c, at + 0.3, pan, 2.4, 1, 0.8);
    },

    onUltimate(c, t, ev) {
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan * 0.3, 0.7);
      if (ev.phase === 'start') {
        // the inhale: everything falls inward for two seconds, then a held breath of near-silence, then the landing
        spiral(c, t, pan, 2.0, 0.08, 0);
        roar(c, o, t, { f: 55, f1: 27, dur: 2.1, gain: 0.12, attack: 1.4, lp0: 600, lp1: 120 });
        catastrophe(c, subOut(c, 0), o, t + 2.35, { pre: 0, size: 0.7, gain: 0.95, f0: 48 });
      } else {
        hawking(c, t, pan, 1.4, 0.6);
      }
    },

    onMatter(c, t, ev) {
      const pan = c.panOf(ev.x);
      const m = clamp01(Math.log10(Math.max(1, ev.mass)) / 3);
      switch (ev.kind) {
        case 'consume':
        case 'harvest':
          gulp(c, t, pan, 0.3 + 0.6 * m, 0.3);
          return true;
        case 'evaporate':
          hawking(c, t, pan, 0.8, 0.3 + 0.5 * m, 1.5);
          return true;
        default:
          return false;
      }
    },

    onCue(c, t, ev) {
      const pan = c.panOf(ev.x);
      const a = clamp01(ev.amount);
      switch (cueKind(ev.id)) {
        case 'shed': {
          // the disk sheds mass: a roar of matter flung outward both ways, and the drop of losing it
          for (const side of [-1, 1] as const)
            whoosh(c, t, {
              dur: 0.7,
              gain: 0.12 + 0.08 * a,
              panFrom: pan * 0.3,
              panTo: clamp(pan + side * 0.9, -1, 1),
              wet: 0.5,
              f0: 300,
              f1: 900,
            });
          boom(c, subOut(c, pan), t, { f0: 72, f1: 30, dur: 0.7, gain: 0.3 + 0.15 * a });
          return;
        }
        case 'lost':
          tone(c, makeOut(c, pan * 0.3, 0.4), t, {
            f0: 44,
            f1: 96,
            dur: 1.0,
            gain: 0.5,
            attack: 0.05,
            glide: 0.9,
          });
          return;
        case 'break':
          noiseHit(c, makeOut(c, pan, 0.5), t, {
            dur: 0.3,
            gain: 0.12,
            filter: { type: 'bandpass', f0: 900, f1: 200, q: 1.2 },
            filter2: { type: 'lowpass', f0: 1600 },
            attack: 0.002,
          });
          gulp(c, t + 0.03, pan, 0.25, 0.4);
          return;
        case 'collapse':
          hawking(c, t, pan, 2.0, 1, 2.5);
          rumble(c, makeOut(c, pan, 0.6), t, { dur: 2.4, gain: 0.3, f0: 400, f1: 70 });
          boom(c, subOut(c, pan), t, { f0: 70, f1: 30, dur: 1.4, gain: 0.35 });
          return;
        case 'hawking':
          hawking(c, t, pan, 1.6, 0.4 + 0.5 * a, 1.2);
          return;
        case 'consume':
          gulp(c, t, pan, 0.6 + 0.4 * a, 0.4);
          hawking(c, t + 0.15, pan, 0.6, 0.3, 0.6);
          return;
        case 'strip':
        case 'harvest':
        case 'merge':
          gulp(c, t, pan, 0.4 + 0.4 * a, 0.35);
          return;
        default:
          lowBell(c, makeOut(c, pan, 0.6), t, 82.41, BELL, { decay: 0.8, gain: 0.03 + 0.03 * a });
          gulp(c, t, pan, 0.25, 0.3);
      }
    },

    update(c, scene, slot, dt) {
      const ac = c.ac;
      let d = drones.get(slot);
      if (!d) {
        const bed = createBed(c, 0.3);
        const lp = ac.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 300;
        lp.Q.value = 0.5;
        // two sines a hair apart (they beat), plus an octave that only speaks when it has fed. Kept PURE: its pitch is the
        // titan's mass (heavier = lower) and must stay the strongest thing in the bed; a laptop hears it through the master's
        // weight stage (its 4th harmonic) and the disk's roar
        const a = bed.run(ac.createOscillator());
        const b = bed.run(ac.createOscillator());
        const h2 = bed.run(ac.createOscillator());
        for (const o of [a, b, h2]) o.type = 'sine';
        a.frequency.value = 50;
        b.frequency.value = 50.4;
        h2.frequency.value = 100;
        a.connect(lp);
        b.connect(lp);
        const partialsGain = silentGain(c, lp);
        h2.connect(partialsGain);
        // the drone level, and two slow incommensurate LFOs that open pockets of near-silence in it
        const level = silentGain(c, bed.input);
        lp.connect(level);
        const pocketA = lfoInto(c, bed, level.gain, 0.13, 0).depth;
        const pocketB = lfoInto(c, bed, level.gain, 0.19, 0).depth;
        // the accretion disk: a low roar of matter falling in
        const disk = silentGain(c, bed.input);
        const { filter: diskBand } = noiseBand(c, bed, disk, {
          kind: 'brown',
          type: 'bandpass',
          f: 260,
          q: 0.7,
        });
        const fray = silentGain(c, bed.input);
        d = { bed, a, b, h2, level, partials: partialsGain, pocketA, pocketB, disk, diskBand, fray };
        drones.set(slot, d);
      }
      const now = ac.currentTime;
      // massFrac can exceed 1 (it grows as it feeds): heavier = lower and stronger
      const mass = clamp(scene.massFrac, 0.15, 2.2);
      const fed = clamp01(scene.resource);
      const f = 50 * Math.pow(mass, -0.42);
      d.a.frequency.setTargetAtTime(f, now, 0.35);
      d.b.frequency.setTargetAtTime(f * (1.006 + 0.006 * fed), now, 0.35);
      d.h2.frequency.setTargetAtTime(f * 2, now, 0.35);
      const g = 0.016 + 0.01 * clamp(mass, 0.3, 2);
      d.level.gain.setTargetAtTime(g * 0.55, now, 0.4);
      d.pocketA.gain.setTargetAtTime(g * 0.24, now, 0.4);
      d.pocketB.gain.setTargetAtTime(g * 0.24, now, 0.4);
      d.partials.gain.setTargetAtTime(0.05 + 0.25 * fed, now, 0.5);
      const move = clamp01(scene.speed / 700);
      d.disk.gain.setTargetAtTime(0.01 + 0.04 * fed + 0.03 * move, now, 0.4);
      d.diskBand.frequency.setTargetAtTime(200 + 300 * move, now, 0.4);
      d.bed.pan.pan.setTargetAtTime(clamp(c.panOf(scene.x), -1, 1), now, 0.1);
      // nearly out of mass: it evaporates, a dark crackle at its edges, more of it the less is left
      const thin = clamp01((0.4 - scene.massFrac) / 0.3);
      if (thin > 0 && c.rand() < 6 * thin * dt)
        noiseHit(c, { input: d.fray, close: () => undefined }, now + 0.005, {
          dur: 0.015 + 0.03 * c.rand(),
          gain: 0.6 * thin * (0.4 + 0.6 * c.rand()),
          filter: { type: 'bandpass', f0: 1800 + 2400 * c.rand(), q: 1.2 },
          filter2: { type: 'lowpass', f0: 5000 },
          attack: 0.001,
        });
      d.fray.gain.setTargetAtTime(0.06 * thin, now, 0.3);
    },

    stop(slot) {
      for (const s of slot === 'all' ? [...drones.keys()] : [slot]) {
        drones.get(s)?.bed.dispose();
        drones.delete(s);
      }
    },
  };
}
