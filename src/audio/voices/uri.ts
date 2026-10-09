import { clamp, clamp01 } from '../dsp/math';
import { createBed, lfoInto, noiseBand, silentGain, subOut, type Bed } from './kit';
import { IRON, gravel, makeOut, type PartialSet } from './synth';
import type { TitanVoice, VoiceCtx } from './types';
import { boom, catastrophe, crackle, grind, lowBell, roar, rumble, saturator, swell, whoosh } from './epic';
import { filamentSnap, resonance } from './materials';

/**
 * 우리 (URI): a war-body built from two dismantled worlds, held together by an infinity loop (its health). It sounds like what it
 * is made of:
 *  - the MEGASTRUCTURE: hull plates and girders, a struck hull rings like a colossal low plate (`HULL`) and grinds when it moves;
 *  - the CIVILISATION: a hum of a dead world's machinery, a low saw chord (A1, E2, A2) that flickers;
 *  - the CORES: the two worlds' cores thrumming a hair apart (41 / 43.5 Hz, a slow 2.5 Hz beat), saturated so a laptop hears them;
 *  - the LOOP: as the loop (its resource) gives, a bowed-metal strain rises under everything, and when it snaps the world flies apart.
 * Blows are fists of planetary matter: a tectonic drop, rock crunch and a hull clang. No tone in this voice sits above ~1 kHz.
 */
const HULL: PartialSet = {
  // a thick plate: dense, slightly stretched modes that die from the top down
  ratios: [1, 1.48, 2.13, 2.87, 3.92],
  amps: [1, 0.75, 0.55, 0.38, 0.22],
  decays: [1, 0.85, 0.6, 0.42, 0.28],
};
/** A1 and its fifth and octave: the dead civilisation's hum. */
const HUM = [55, 82.41, 110];

interface Body {
  bed: Bed;
  hum: GainNode;
  humLp: BiquadFilterNode;
  cores: GainNode;
  strain: GainNode;
  strainBand: BiquadFilterNode;
  grind: GainNode;
}

export function createUriVoice(): TitanVoice {
  const bodies = new Map<number, Body>();
  /** The loop's integrity per slot (scene.resource): a strained loop rings lower and wronger. */
  const loopBy: [number, number] = [1, 1];

  /** A fist of planetary matter landing: the drop, rock crunch, a hull clang. */
  const fist = (c: VoiceCtx, t: number, pan: number, mag: number, level = 1): void => {
    const m = clamp01(mag);
    const o = makeOut(c, pan, 0.4);
    boom(c, subOut(c, pan), t, {
      f0: 96 - 20 * m,
      f1: 30,
      dur: 0.6 + 0.9 * m,
      gain: (0.42 + 0.4 * m) * level,
      drive: 2.6 + m,
    });
    gravel(c, o, t + 0.006, {
      dur: 0.3 + 0.4 * m,
      grains: 14 + Math.round(22 * m),
      f: 420,
      spread: 2,
      gain: (0.26 + 0.14 * m) * level,
      q: 1,
      lowpass: 1300,
    });
    lowBell(c, o, t + 0.004, 62 + 8 * c.rand(), HULL, {
      decay: 0.5 + 0.8 * m,
      gain: (0.06 + 0.05 * m) * level,
    });
  };

  return {
    titan: 'uri',

    onMove(c, t, ev) {
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.35);
      switch (ev.moveSlot) {
        case 'strike':
          // the arm loads: servos the size of cities, a short pressure swell
          grind(c, o, t, { dur: 0.3, gain: 0.07, f0: 140, f1: 260, rate: 15, metal: true, attack: 0.08 });
          swell(c, o, t, { dur: 0.3, gain: 0.08, f0: 120, f1: 500, sub: 0.05, subHz: 46 });
          break;
        case 'crush':
          grind(c, o, t, { dur: 0.38, gain: 0.09, f0: 110, f1: 220, rate: 11, metal: true, attack: 0.1 });
          swell(c, o, t, { dur: 0.38, gain: 0.1, f0: 110, f1: 600, sub: 0.07, subHz: 41 });
          break;
        case 'signature':
          swell(c, o, t, { dur: 0.3, gain: 0.1, f0: 90, f1: 700, sub: 0.08, subHz: 41 });
          break;
        case 'ultimate':
          // the double slam rises: the whole war-body lifts, the hull groans, the pressure builds for ~1 s
          swell(c, o, t, { dur: 0.95, gain: 0.14, f0: 80, f1: 800, sub: 0.12, subHz: 36 });
          roar(c, o, t, { f: 41, f1: 46, dur: 1.0, gain: 0.08, attack: 0.7, lp0: 160, lp1: 600 });
          grind(c, o, t, { dur: 0.9, gain: 0.08, f0: 90, f1: 200, rate: 7, metal: true, attack: 0.3 });
          break;
        default:
          break;
      }
    },

    onRelease(c, t, ev) {
      // the fist moves a continent of air
      const pan = c.panOf(ev.x);
      const p = clamp01(ev.power);
      const heavy = ev.moveSlot === 'ultimate' || ev.moveSlot === 'crush';
      whoosh(c, t, {
        dur: heavy ? 0.35 : 0.26,
        gain: (heavy ? 0.24 : 0.18) * (0.7 + 0.3 * p),
        panFrom: clamp(pan - 0.35, -1, 1),
        panTo: clamp(pan + 0.35, -1, 1),
        wet: 0.3,
        f0: heavy ? 700 : 900,
        f1: 110,
      });
    },

    onHitDealt(c, t, ev, mag) {
      const pan = c.panOf(ev.x);
      fist(c, t, pan, mag, ev.heavy ? 1 : 0.8);
      if (ev.heavy)
        rumble(c, makeOut(c, pan * 0.5, 0.7), t, { dur: 1.8 + 1.2 * mag, gain: 0.16, f0: 280, f1: 60 });
    },

    onHitTaken(c, t, ev, mag) {
      // the megastructure is struck: a hull rings low and long, girders grind, rock spalls; a strained loop rings wronger
      const pan = c.panOf(ev.x);
      const open = 1 - clamp01(ev.blocked) * 0.7;
      const res = resonance(0.5 + 0.5 * loopBy[ev.target], ev.onDamaged);
      const o = makeOut(c, pan, 0.5);
      lowBell(c, o, t, (52 + 10 * c.rand()) * res.pitch, HULL, {
        decay: (0.7 + 1.2 * mag) * res.decay,
        gain: (0.08 + 0.08 * mag) * open,
        shimmer: 0.3,
      });
      grind(c, o, t + 0.01, {
        dur: 0.35 + 0.5 * mag,
        gain: (0.06 + 0.06 * mag) * open,
        f0: 320,
        f1: 120,
        rate: 9 + 6 * mag,
        metal: true,
        attack: 0.02,
      });
      gravel(c, o, t + 0.004, {
        dur: 0.25 + 0.35 * mag,
        grains: 10 + Math.round(16 * mag),
        f: 380,
        spread: 2,
        gain: (0.22 + 0.12 * mag) * open,
        q: 1,
        lowpass: 1200,
      });
    },

    onKo(c, t, ev) {
      // the war-body comes apart: the hush, the drop, the two cores sagging to nothing, debris falling for seconds
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan * 0.4, 0.9);
      const at = catastrophe(c, subOut(c, pan), o, t, { size: 1, f0: 55 });
      for (const [f, side] of [
        [41, -0.4],
        [43.5, 0.4],
      ] as const) {
        const core = makeOut(c, side, 0.3);
        const osc = c.ac.createOscillator();
        osc.frequency.setValueAtTime(f, at);
        osc.frequency.exponentialRampToValueAtTime(f * 0.45, at + 4.5);
        const sh = saturator(c, 2.6);
        const g = c.ac.createGain();
        g.gain.value = 0;
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(0.09, at + 0.3);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 4.5);
        osc.connect(sh);
        sh.connect(g);
        g.connect(core.input);
        osc.start(at);
        osc.stop(at + 4.6);
      }
      lowBell(c, o, at, 41, HULL, { decay: 3.2, gain: 0.12, shimmer: 0.4 });
      crackle(c, o, at + 0.1, { dur: 3, count: 40, gain: 0.12, f: 700 });
      gravel(c, o, at + 0.05, {
        dur: 2.6,
        grains: 70,
        f: 300,
        spread: 2.4,
        gain: 0.14,
        q: 0.9,
        decayShape: 1.1,
        lowpass: 900,
      });
    },

    onUltimate(c, t, ev) {
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan * 0.3, 0.7);
      if (ev.phase === 'start') {
        // a war-horn of the dead civilisation, under the slam
        roar(c, o, t, { f: 55, dur: 1.6, gain: 0.1, attack: 0.5, lp0: 200, lp1: 520, detune: 14 });
        swell(c, o, t, { dur: 0.9, gain: 0.12, f0: 90, f1: 700, sub: 0.1, subHz: 36 });
      } else {
        rumble(c, o, t, { dur: 2.2, gain: 0.12, f0: 240, f1: 60 });
      }
    },

    onCue(c, t, ev) {
      const pan = c.panOf(ev.x);
      if (ev.id === 'break-apart' || ev.id.includes('break')) {
        // the loop snaps: a cable the size of an orbit lets go, the hull tears, and everything it held flies apart
        const o = makeOut(c, pan, 0.8);
        filamentSnap(c, o, t, 55, 1, resonance(0.2, 1));
        grind(c, o, t, { dur: 1.4, gain: 0.16, f0: 420, f1: 70, rate: 18, metal: true, attack: 0.01 });
        boom(c, subOut(c, pan), t, { f0: 120, f1: 28, dur: 2.4, gain: 0.8, drive: 3.4 });
        rumble(c, o, t, { dur: 4, gain: 0.22, f0: 300, f1: 50, rate: 0.9 });
        crackle(c, o, t + 0.05, { dur: 2.4, count: 34, gain: 0.14, f: 800 });
        return;
      }
      fist(c, t, pan, 0.4 * clamp01(ev.amount), 0.7);
    },

    onMatter(c, t, ev) {
      if (ev.kind !== 'detach' && ev.kind !== 'impact') return false;
      // pieces of a world break off: rubble and a hull fragment's clank
      const pan = c.panOf(ev.x);
      const m = clamp01(Math.log10(Math.max(1, ev.mass)) / 3);
      const o = makeOut(c, pan, 0.35);
      gravel(c, o, t, { dur: 0.4 + 0.3 * m, grains: 14, f: 360, spread: 2.2, gain: 0.12, lowpass: 1100 });
      boom(c, subOut(c, pan), t, { f0: 80, f1: 34, dur: 0.4 + 0.3 * m, gain: 0.18 + 0.2 * m });
      lowBell(c, o, t + 0.01, 90 + 30 * c.rand(), IRON, { decay: 0.35, gain: 0.04 });
      return true;
    },

    update(c, scene, slot) {
      loopBy[slot] = clamp01(scene.resource);
      const ac = c.ac;
      let b = bodies.get(slot);
      if (!b) {
        const bed = createBed(c, 0.35);
        // the civilisation's hum: a low saw chord through a low-pass, flickering
        const humLp = ac.createBiquadFilter();
        humLp.type = 'lowpass';
        humLp.frequency.value = 480;
        humLp.Q.value = 0.8;
        const hum = silentGain(c, bed.input);
        humLp.connect(hum);
        HUM.forEach((f, i) => {
          const o = bed.run(ac.createOscillator());
          o.type = 'sawtooth';
          o.frequency.value = f;
          o.detune.value = (i - 1) * 7;
          const og = ac.createGain();
          og.gain.value = [0.6, 0.35, 0.3][i]!;
          o.connect(og);
          og.connect(humLp);
        });
        lfoInto(c, bed, humLp.frequency, 0.23, 60);
        // the two cores: a hair apart, beating, saturated
        const cores = silentGain(c, bed.input);
        const sh = saturator(c, 2.8);
        const coreLp = ac.createBiquadFilter();
        coreLp.type = 'lowpass';
        coreLp.frequency.value = 380;
        sh.connect(coreLp);
        coreLp.connect(cores);
        for (const f of [41, 43.5]) {
          const o = bed.run(ac.createOscillator());
          o.frequency.value = f;
          const og = ac.createGain();
          og.gain.value = 0.5;
          o.connect(og);
          og.connect(sh);
        }
        // the loop's strain: bowed metal (a narrow band of noise) that swells as the loop gives
        const strain = silentGain(c, bed.input);
        const { filter: strainBand } = noiseBand(c, bed, strain, {
          kind: 'white',
          type: 'bandpass',
          f: 190,
          q: 6,
        });
        lfoInto(c, bed, strain.gain, 0.31, 0);
        // the megastructure grinding as it moves
        const grindG = silentGain(c, bed.input);
        noiseBand(c, bed, grindG, { kind: 'brown', type: 'bandpass', f: 240, q: 1.4 });
        b = { bed, hum, humLp, cores, strain, strainBand, grind: grindG };
        bodies.set(slot, b);
      }
      const now = ac.currentTime;
      const move = clamp01(scene.speed / 500);
      const loop = clamp01(scene.resource);
      b.hum.gain.setTargetAtTime(0.014 + 0.006 * move, now, 0.4);
      b.cores.gain.setTargetAtTime(0.03 + 0.012 * (1 - loop), now, 0.4);
      // a fresh loop is silent; a failing one groans and sags in pitch
      b.strain.gain.setTargetAtTime(0.002 + 0.07 * (1 - loop) * (1 - loop), now, 0.5);
      b.strainBand.frequency.setTargetAtTime(150 + 70 * loop, now, 0.6);
      b.grind.gain.setTargetAtTime(0.004 + 0.05 * move, now, 0.2);
      b.bed.pan.pan.setTargetAtTime(clamp(c.panOf(scene.x), -1, 1), now, 0.1);
    },

    stop(slot) {
      for (const s of slot === 'all' ? [...bodies.keys()] : [slot]) {
        bodies.get(s)?.bed.dispose();
        bodies.delete(s);
      }
    },
  };
}
