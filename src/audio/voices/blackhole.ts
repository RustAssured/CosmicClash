import { clamp, clamp01 } from '../dsp/math';
import { cueKind } from './cues';
import { createBed, glitter, lfoInto, noiseBand, silentGain, subOut, type Bed } from './kit';
import { GLASS, makeOut, noiseHit, partials, riser, thump, tone, whistlePass } from './synth';
import type { TitanVoice, VoiceCtx } from './types';

/**
 * THE BLACK HOLE: a true-black horizon, a photon ring, an accretion disk. It is barely a sound at all: a sub drone whose pitch
 * bends with its mass, gravity that pulls other sounds toward it, and silence.
 *
 * - The drone is continuous: heavier is LOWER and STRONGER (the design says it grows heavier as it feeds), the mass it has
 *   accreted (`resource`) thickens it with beating partials, and slow pockets of near-silence open and close in it, like the
 *   horizon swallowing the sound itself. When it is nearly out of mass a glitter of Hawking radiation crackles above it.
 * - Tidal pull is a rising spiral shimmer converging into the sub; consumption is a gulp with a pitch drop; a Surge is a
 *   Doppler bend; the Ultimate inhales, goes silent, and then lands.
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
}

export function createBlackHoleVoice(): TitanVoice {
  const drones = new Map<number, Drone>();

  /** Something swallowed: a sine that falls away in pitch with a suction of noise behind it. */
  const gulp = (c: VoiceCtx, t: number, pan: number, mag: number, wet = 0.3): void => {
    const o = makeOut(c, pan, wet);
    tone(c, o, t, {
      f0: 340 - 100 * mag,
      f1: 46,
      dur: 0.22 + 0.4 * mag,
      gain: 0.1 + 0.06 * mag,
      attack: 0.008,
      glide: 0.2 + 0.36 * mag,
    });
    noiseHit(c, o, t, {
      dur: 0.3 + 0.3 * mag,
      gain: 0.14,
      filter: { type: 'bandpass', f0: 1300, f1: 120, q: 1.1 },
      attack: 0.03,
    });
    thump(c, subOut(c, pan), t + 0.05, 74, 26, 0.4 + 0.5 * mag, 0.3 + 0.3 * mag);
  };

  /** Tidal pull: a shimmer that RISES while it converges from both sides into the centre, ending in a sub thump. */
  const spiral = (c: VoiceCtx, t: number, pan: number, dur: number, gain: number, sub = 0.35): void => {
    for (const side of [-1, 1] as const) {
      whistlePass(c, t, {
        f: 520,
        dur,
        gain,
        panFrom: clamp(pan + side * 0.9, -1, 1),
        panTo: clamp(pan * 0.3, -1, 1),
        wet: 0.4,
        approach: 0.5,
        recede: 3.4,
      });
    }
    thump(c, subOut(c, pan), t + dur * 0.9, 66, 26, 0.5, sub);
  };

  /** Hawking radiation: dense bright glitter over a thin high hiss. */
  const hawking = (
    c: VoiceCtx,
    t: number,
    pan: number,
    dur: number,
    amount: number,
    level = 1,
    f = 2300,
  ): void => {
    const o = makeOut(c, pan, 0.5);
    glitter(c, o, t, { dur, count: Math.round(14 + 40 * amount), f, spread: 1.2, gain: 0.05 * level });
    noiseHit(c, o, t, {
      dur,
      gain: 0.03 * amount * level,
      filter: { type: 'highpass', f0: 5500 },
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
          tone(c, makeOut(c, pan * 0.4, 0.3), t, { f0: 70, f1: 120, dur: 0.3, gain: 0.08, attack: 0.15 });
          break;
        }
        case 'crush': {
          // the well deepens: an inhale of falling noise
          noiseHit(c, makeOut(c, pan * 0.4, 0.5), t, {
            dur: 0.6,
            gain: 0.5,
            filter: { type: 'lowpass', f0: 2400, f1: 200, q: 0.7 },
            attack: 0.35,
          });
          break;
        }
        case 'signature': {
          spiral(c, t, pan, 0.5, 0.03, 0.06);
          break;
        }
        case 'ultimate': {
          tone(c, makeOut(c, 0, 0.5), t, { f0: 60, f1: 32, dur: 1.2, gain: 0.25, attack: 0.6 });
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
        thump(c, subOut(c, pan), t, 64, 22, 1.1, 0.55 + 0.25 * p);
        gulp(c, t, pan, 0.8, 0.5);
      } else if (ev.moveSlot === 'signature') {
        spiral(c, t, pan, 0.45, 0.06);
      } else {
        const o = makeOut(c, pan, 0.3);
        tone(c, o, t, { f0: 260, f1: 60, dur: 0.3, gain: 0.09, attack: 0.004 });
        thump(c, subOut(c, pan), t, 80, 30, 0.35, 0.3 + 0.2 * p);
      }
    },

    onSurge(c, t, ev) {
      // a Doppler bend: the pitch falls hard as it passes, and the sub leans with it
      const pan = c.panOf(ev.x);
      const dir = Math.sign(ev.dirX || 1);
      whistlePass(c, t, {
        f: 240,
        dur: 0.6,
        gain: 0.11,
        panFrom: clamp(pan - 0.7 * dir, -1, 1),
        panTo: clamp(pan + 0.7 * dir, -1, 1),
        wet: 0.4,
        approach: 1.7,
        recede: 0.42,
      });
      tone(c, makeOut(c, pan * 0.3, 0), t, { f0: 70, f1: 38, dur: 0.6, gain: 0.12, attack: 0.1 });
    },

    onHitDealt(c, t, ev, mag) {
      const pan = c.panOf(ev.x);
      if (ev.type === 'TIDAL') spiral(c, t, pan, 0.35 + 0.25 * mag, 0.035 + 0.02 * mag, 0.2);
      else thump(c, subOut(c, pan), t + 0.01, 58, 24, 0.4 + 0.4 * mag, 0.18 + 0.2 * mag);
    },

    onHitTaken(c, t, ev, mag) {
      // hits vanish into it: a gulp, and only the disk rings (the horizon cannot be struck)
      const pan = c.panOf(ev.x);
      const open = 1 - clamp01(ev.blocked) * 0.7;
      gulp(c, t, pan, mag * open, 0.4);
      if (ev.onDamaged > 0.3)
        partials(c, makeOut(c, pan, 0.6), t + 0.02, 880, GLASS, {
          decay: 0.3,
          gain: 0.05 * open,
          maxHz: 9000,
        });
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
      // it evaporates: the drone rises and thins away into a storm of Hawking glitter
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan * 0.3, 0.8);
      tone(c, o, t, { f0: 38, f1: 190, dur: 2.2, gain: 0.11, attack: 0.05, glide: 1.8 });
      thump(c, subOut(c, pan), t, 60, 20, 2.0, 0.5);
      hawking(c, t + 0.1, pan, 2.4, 1, 0.5, 1600);
    },

    onUltimate(c, t, ev) {
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan * 0.3, 0.7);
      if (ev.phase === 'start') {
        // the inhale: everything falls inward for two seconds, then a held breath of near-silence, then the landing
        riser(c, o, t, 2.0, 0.16, 5200, 120);
        spiral(c, t, pan, 2.0, 0.05);
        tone(c, o, t, { f0: 120, f1: 30, dur: 2.1, gain: 0.12, attack: 1.4 });
        thump(c, subOut(c, 0), t + 2.35, 56, 18, 2.2, 0.95);
        noiseHit(c, o, t + 2.35, {
          dur: 0.6,
          gain: 0.2,
          filter: { type: 'lowpass', f0: 500, f1: 60, q: 1 },
          kind: 'brown',
          attack: 0.004,
        });
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
          hawking(c, t, pan, 0.8, 0.3 + 0.5 * m, 2.5);
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
          // the disk sheds mass: an airy rush of shimmer flung outward
          const o = makeOut(c, pan, 0.6);
          for (const side of [-1, 1] as const)
            whistlePass(c, t, {
              f: 1400,
              dur: 0.6,
              gain: 0.15 + 0.1 * a,
              panFrom: pan * 0.3,
              panTo: clamp(pan + side * 0.9, -1, 1),
              wet: 0.5,
              approach: 2.4,
              recede: 0.8,
            });
          noiseHit(c, o, t, {
            dur: 0.6,
            gain: 0.2,
            filter: { type: 'bandpass', f0: 3000, f1: 8000, q: 0.8 },
            attack: 0.1,
          });
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
            dur: 0.25,
            gain: 0.1,
            filter: { type: 'bandpass', f0: 2800, f1: 500, q: 1.6 },
            attack: 0.002,
          });
          gulp(c, t + 0.03, pan, 0.25, 0.4);
          return;
        case 'collapse':
          hawking(c, t, pan, 2.0, 1, 4);
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
          partials(c, makeOut(c, pan, 0.6), t, 660, GLASS, {
            decay: 0.4,
            gain: 0.03 + 0.03 * a,
            maxHz: 9000,
          });
          gulp(c, t, pan, 0.25, 0.3);
      }
    },

    update(c, scene, slot) {
      const ac = c.ac;
      let d = drones.get(slot);
      if (!d) {
        const bed = createBed(c, 0.3);
        const lp = ac.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 220;
        lp.Q.value = 0.5;
        // two sines a hair apart (they beat), plus an octave that only speaks when it has fed
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
        // the accretion disk: a low band of rushing noise
        const disk = silentGain(c, bed.input);
        const { filter: diskBand } = noiseBand(c, bed, disk, {
          kind: 'white',
          type: 'bandpass',
          f: 700,
          q: 0.7,
        });
        d = { bed, a, b, h2, level, partials: partialsGain, pocketA, pocketB, disk, diskBand };
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
      const g = 0.013 + 0.009 * clamp(mass, 0.3, 2);
      d.level.gain.setTargetAtTime(g * 0.55, now, 0.4);
      d.pocketA.gain.setTargetAtTime(g * 0.24, now, 0.4);
      d.pocketB.gain.setTargetAtTime(g * 0.24, now, 0.4);
      d.partials.gain.setTargetAtTime(0.08 + 0.5 * fed, now, 0.5);
      const move = clamp01(scene.speed / 700);
      d.disk.gain.setTargetAtTime(0.002 + 0.012 * fed + 0.008 * move, now, 0.4);
      d.diskBand.frequency.setTargetAtTime(500 + 900 * move, now, 0.4);
      d.bed.pan.pan.setTargetAtTime(clamp(c.panOf(scene.x), -1, 1), now, 0.1);
      // nearly out of mass: Hawking glitter, more of it the less is left
      const thin = clamp01((0.4 - scene.massFrac) / 0.3);
      if (thin > 0 && c.rand() < 0.12 * thin)
        partials(
          c,
          makeOut(c, c.panOf(scene.x) * 0.6 + (c.rand() - 0.5) * 0.6, 0.5),
          now + 0.005,
          2800 * Math.pow(2, c.rand() * 1.5),
          GLASS,
          {
            decay: 0.05 + 0.08 * c.rand(),
            gain: 0.03 * thin,
            maxHz: 12000,
          },
        );
    },

    stop(slot) {
      for (const s of slot === 'all' ? [...drones.keys()] : [slot]) {
        drones.get(s)?.bed.dispose();
        drones.delete(s);
      }
    },
  };
}
