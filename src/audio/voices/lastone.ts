import type { TitanId } from '@/contracts';
import { clamp, clamp01 } from '../dsp/math';
import { BELL, gravel, makeOut, pick, tone } from './synth';
import { subOut } from './kit';
import type { TitanVoice, VoiceCtx } from './types';
import { boom, catastrophe, crackle, lowBell, roar, rumble, saturator, swell, whoosh } from './epic';
import {
  ceramicFracture,
  filamentSnap,
  resonance,
  stoneShear,
  strainedMetal,
  wrongHarmonics,
} from './materials';

/**
 * The temple voice, shared by the two titans that grew from the Last One (D36):
 *
 * THE LAST ONE (id `colossus`): a cathedral-sized colossus of sacred ceramic, stone and bronze around a single eye of
 * white-gold light. D34 rebuilt it from struck glass (587–1480 Hz bells, 2–7 kHz tinks and shards) into a temple bell struck
 * by a mountain:
 *  - its body rings as colossal BRONZE (`BELL` partials on D1–D3, none above ~1.4 kHz), slowly beating, wronger when hollowed;
 *  - it breaks as fired clay and stone (dark cracks, low clay plates, grinding slabs);
 *  - its sacred frame strains like bowed metal;
 *  - the Gaze is not a whine but a pressure: a low choir on D whose filter opens as the eye fills, and a beam that ROARS;
 *  - its bed is a low choir (D2 A2 D3) that breathes with its motion.
 *  Tuning: everything sits on D (D F♯ A), so any two bells that overlap are consonant.
 *
 * THE WITNESS (id `lastone`, the returning tendril titan with five eyes): the same temple, a semitone lower and in MINOR (C♯
 * E G♯): its choir and its gaze lean on the minor third, its bronze always rings a little out of its series (five eyes, one
 * voice that is not quite one), and its tendrils (cables the size of ridges, a LOW plucked snap) are the loudest part of it.
 */
interface Tune {
  titan: TitanId;
  /** Pitch factor on every authored frequency (1 = D). */
  k: number;
  bells: readonly number[];
  low: readonly number[];
  /** The gaze choir's ratios over the root (first is the sine root). */
  choir: readonly number[];
  /** A floor of wrongness on every struck bell (0 = pure). */
  wrong: number;
  /** Gain on the tendril snaps. */
  snap: number;
}

const COLOSSUS: Tune = {
  titan: 'colossus',
  k: 1,
  bells: [73.42, 92.5, 110, 146.83],
  low: [73.42, 110, 146.83],
  choir: [1, 1.5, 2, 3],
  wrong: 0,
  snap: 1,
};
const K_WITNESS = 69.3 / 73.42;
const WITNESS: Tune = {
  titan: 'lastone',
  k: K_WITNESS,
  // C♯2 E2 G♯2 C♯3: the minor third is the Witness's colour
  bells: [69.3, 82.41, 103.83, 138.59],
  low: [69.3, 103.83, 138.59],
  choir: [1, 1.2, 1.5, 2],
  wrong: 0.35,
  snap: 1.25,
};

interface Charging {
  gain: GainNode;
  oscs: OscillatorNode[];
  noise: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  frac: number;
}
interface Pad {
  gain: GainNode;
  filter: BiquadFilterNode;
  oscs: OscillatorNode[];
  breath: AudioBufferSourceNode;
  breathGain: GainNode;
  pan: StereoPannerNode;
}

/** The Last One (the colossus, D36). */
export const createColossusVoice = (): TitanVoice => createTempleVoice(COLOSSUS);
/** The Witness (the returning tendril titan, D36). */
export const createLastOneVoice = (): TitanVoice => createTempleVoice(WITNESS);

function createTempleVoice(tune: Tune): TitanVoice {
  const { k, bells: BELLS, low: LOW, choir: CHOIR } = tune;
  const charging = new Map<number, Charging>();
  const pads = new Map<number, Pad>();
  /** Remaining mass per slot: a hollowed titan rings lower, longer and further out of tune. */
  const massBy: [number, number] = [1, 1];

  const startGaze = (c: VoiceCtx, t: number, slot: number, pan: number): void => {
    stopGaze(slot, c.ac.currentTime);
    const ac = c.ac;
    const gain = ac.createGain();
    // Start silent through the param's own value, NOT `setValueAtTime(0, t)`: a setTarget scheduled at the same instant takes
    // its starting point from the value BEFORE that event (the node default, 1.0), not from the set that sits beside it. The
    // charge then began at full scale and decayed to its level (measured: −1 dB peak click at the very first sample).
    gain.gain.value = 0;
    // setTarget, not a ramp: `hold` events keep retargeting this gain every tick for as long as the charge lasts, and an event
    // that lands inside a pending ramp is undefined behaviour (it produced a full-scale click; see `gravel` in synth.ts)
    gain.gain.setTargetAtTime(0.07, t, 0.1);
    const p = ac.createStereoPanner();
    p.pan.value = clamp(pan * 0.5, -1, 1);
    gain.connect(p);
    p.connect(c.dry);
    const wg = ac.createGain();
    wg.gain.value = 0.5;
    p.connect(wg);
    wg.connect(c.wet);
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 260;
    filter.Q.value = 1.4;
    const sh = saturator(c, 1.8);
    sh.connect(filter);
    filter.connect(gain);
    const oscs: OscillatorNode[] = [];
    // a low choir on the root: root and its chord; saws and a sine, slowly beating
    for (const [i, ratio] of CHOIR.entries()) {
      const o = ac.createOscillator();
      o.type = i === 0 ? 'sine' : 'sawtooth';
      o.frequency.setValueAtTime(LOW[0]! * ratio, t);
      o.detune.value = (i - 1.5) * 7;
      const og = ac.createGain();
      og.gain.value = [0.6, 0.22, 0.18, 0.1][i]!;
      o.connect(og);
      og.connect(sh);
      o.start(t);
      oscs.push(o);
    }
    // the eye gathering: a slow throb, not a tremble
    const lfo = ac.createOscillator();
    lfo.frequency.value = 2.2;
    const lg = ac.createGain();
    lg.gain.value = 0.025;
    lfo.connect(lg);
    lg.connect(gain.gain);
    lfo.start(t);
    oscs.push(lfo);
    const noise = ac.createBufferSource();
    noise.buffer = c.brown;
    noise.loop = true;
    const nf = ac.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 220;
    nf.Q.value = 0.8;
    const ng = ac.createGain();
    ng.gain.value = 0.5;
    noise.connect(nf);
    nf.connect(ng);
    ng.connect(filter);
    noise.start(t);
    charging.set(slot, { gain, oscs, noise, filter, frac: 0 });
  };

  const stopGaze = (slot: number, t: number): void => {
    const ch = charging.get(slot);
    if (!ch) return;
    ch.gain.gain.cancelScheduledValues(t);
    ch.gain.gain.setTargetAtTime(0, t, 0.05);
    for (const o of ch.oscs) o.stop(t + 0.4);
    ch.noise.stop(t + 0.4);
    charging.delete(slot);
  };

  /** The sacred body struck: a colossal bronze bell (low, beating), and the clay and stone around it. */
  const struck = (
    c: VoiceCtx,
    t: number,
    pan: number,
    mag: number,
    ring: number,
    onDamaged: number,
    slot: 0 | 1,
  ): void => {
    const o = makeOut(c, pan, 0.6);
    const res = resonance(massBy[slot], onDamaged);
    const f = pick(c, BELLS) * (1.15 - 0.35 * mag) * res.pitch;
    ceramicFracture(c, o, t, mag * ring, res);
    lowBell(c, o, t, f, BELL, {
      decay: (0.9 + 2.2 * mag) * res.decay,
      gain: (0.08 + 0.1 * mag) * ring,
      shimmer: 0.4,
      maxHz: 1400,
    });
    const wrong = Math.max(res.spread, tune.wrong);
    if (wrong > 0.3) wrongHarmonics(c, o, t + 0.02, f, 0.05 * wrong * ring, res);
  };

  return {
    titan: tune.titan,

    onMove(c, t, ev) {
      const pan = c.panOf(ev.x);
      const id = ev.moveId;
      if (id.endsWith('lash')) {
        // a tendril the size of a ridge draws back: air gathering, low
        swell(c, makeOut(c, pan, 0.3), t, { dur: 0.22, gain: 0.09, f0: 140, f1: 700 });
      } else if (id.endsWith('lunge')) {
        swell(c, makeOut(c, pan, 0.25), t, { dur: 0.2, gain: 0.1, f0: 110, f1: 800, sub: 0.05 });
      } else if (id.endsWith('shatter')) {
        // the heavy blow gathers: a reversed swell into the blow, the choir leaning in, the sacred frame straining
        const o = makeOut(c, pan, 0.5);
        swell(c, o, t, { dur: 0.6, gain: 0.14, f0: 90, f1: 800, sub: 0.1, subHz: 37 * k });
        roar(c, o, t, { f: 73.42 * k, dur: 0.6, gain: 0.05, attack: 0.45, lp0: 200, lp1: 600, noise: 0 });
        strainedMetal(c, o, t, 0.6, 98 * k, 0.03, resonance(massBy[ev.slot]));
      } else if (!id.endsWith('gaze') && !id.endsWith('lastlight') && !id.endsWith('sidestep')) {
        swell(c, makeOut(c, pan, 0.2), t, { dur: 0.18, gain: 0.07, f0: 120, f1: 600 });
      }
    },

    onCharge(c, t, ev) {
      if (!ev.moveId.endsWith('gaze') && !ev.moveId.endsWith('lastlight')) return;
      const slot = ev.slot;
      if (ev.phase === 'start') startGaze(c, t, slot, 0);
      const ch = charging.get(slot);
      if (!ch) return;
      if (ev.phase === 'hold' || ev.phase === 'start') {
        const f = clamp01(ev.frac);
        ch.frac = f;
        // the eye fills: the choir rises only a fourth while its filter OPENS (260 Hz → 1.3 kHz) and it swells: the
        // pressure of light gathering, not a whine. The gain stays modest: it is held for seconds.
        const base = LOW[0]! * Math.pow(2, (5 * f) / 12);
        ch.oscs
          .slice(0, CHOIR.length)
          .forEach((o, i) => o.frequency.setTargetAtTime(base * CHOIR[i]!, t, 0.08));
        ch.filter.frequency.setTargetAtTime(260 + 1040 * f, t, 0.08);
        ch.gain.gain.setTargetAtTime(0.07 + 0.09 * f, t, 0.1);
      } else if (ev.phase === 'release') {
        stopGaze(slot, t);
      }
    },

    onRelease(c, t, ev) {
      const pan = c.panOf(ev.x);
      const p = clamp01(ev.power);
      const id = ev.moveId;
      const res = resonance(massBy[ev.slot]);
      if (id.endsWith('gaze')) {
        // the beam: a roar of light — the choir at full voice through an opening filter, a pressure drop, a bronze bloom
        const o = makeOut(c, pan, 0.6);
        roar(c, o, t, {
          f: 73.42 * k,
          f1: 69.3 * k,
          dur: 0.8 + 0.5 * p,
          gain: 0.13 + 0.06 * p,
          attack: 0.02,
          lp0: 1200,
          lp1: 320,
          detune: 12,
        });
        boom(c, subOut(c, pan), t, { f0: 92 * k, f1: 36 * k, dur: 0.8, gain: 0.35 + 0.2 * p, drive: 2.8 });
        lowBell(c, o, t, 146.83 * k, BELL, { decay: 1.4, gain: 0.07, shimmer: 0.4 });
      } else if (id.endsWith('lash')) {
        // a cable the size of a ridge cracks like a whip: a low snap and a dark crack
        const o = makeOut(c, pan, 0.35);
        filamentSnap(c, o, t, 110 * k, (0.5 + 0.5 * p) * tune.snap, res);
        whoosh(c, t, {
          dur: 0.22,
          gain: 0.12,
          panFrom: clamp(pan - 0.3, -1, 1),
          panTo: clamp(pan + 0.3, -1, 1),
          wet: 0.3,
          f0: 900,
          f1: 200,
        });
      } else if (id.endsWith('shatter')) {
        const o = makeOut(c, pan, 0.55);
        boom(c, subOut(c, pan), t, { f0: 88 * k, f1: 28 * k, dur: 1.1, gain: 0.6, drive: 3 });
        gravel(c, o, t, { dur: 0.8, grains: 30, f: 900, spread: 1.6, gain: 0.14, q: 1.6, lowpass: 2000 });
        lowBell(c, o, t, 73.42 * k, BELL, { decay: 1.8, gain: 0.08, shimmer: 0.35 });
        stoneShear(c, o, t + 0.02, p, res);
      } else if (id.endsWith('lunge')) {
        whoosh(c, t, {
          dur: 0.3,
          gain: 0.18,
          panFrom: clamp(pan - 0.4, -1, 1),
          panTo: clamp(pan + 0.4, -1, 1),
          wet: 0.25,
          f0: 800,
          f1: 140,
        });
      }
    },

    onSurge(c, t, ev) {
      // "charge, and sidestep": a colossus moving through the air, and its frame settling with a soft bronze note
      const pan = c.panOf(ev.x);
      const dir = Math.sign(ev.dirX || 1);
      whoosh(c, t, {
        dur: 0.4,
        gain: 0.09,
        panFrom: clamp(pan - 0.4 * dir, -1, 1),
        panTo: clamp(pan + 0.4 * dir, -1, 1),
        wet: 0.4,
        f0: 700,
        f1: 150,
      });
      lowBell(c, makeOut(c, pan, 0.5), t + 0.32, pick(c, BELLS) * 2, BELL, { decay: 0.6, gain: 0.03 });
    },

    onHitDealt(c, t, ev, mag) {
      // fracture accent: a dark crack riding the shear, and the stone it throws
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.35);
      ceramicFracture(c, o, t, 0.4 + 0.4 * mag, resonance(1));
      if (ev.heavy) crackle(c, o, t + 0.02, { dur: 0.6, count: 14, gain: 0.12, f: 1000 });
    },

    onHitTaken(c, t, ev, mag) {
      // the body is sacred ceramic around bronze: it RINGS, low. Heavier blows ring lower and longer; blocked blows barely ring.
      const pan = c.panOf(ev.x);
      const ring = 1 - clamp01(ev.blocked) * 0.85;
      struck(c, t, pan, mag, ring, ev.onDamaged, ev.target);
      if (ev.heavy)
        stoneShear(c, makeOut(c, pan, 0.5), t + 0.01, mag * ring, resonance(massBy[ev.target], ev.onDamaged));
    },

    onGuard(c, t, ev) {
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.5);
      lowBell(c, o, t, pick(c, BELLS.slice(1)), BELL, {
        decay: ev.broke ? 1.8 : 0.7,
        gain: ev.broke ? 0.12 : 0.09,
        shimmer: 0.3,
      });
      boom(c, subOut(c, pan), t, {
        f0: 104 * k,
        f1: 44 * k,
        dur: ev.broke ? 0.9 : 0.35,
        gain: ev.broke ? 0.55 : 0.3,
      });
      if (ev.broke)
        gravel(c, o, t, { dur: 0.7, grains: 28, f: 800, spread: 1.6, gain: 0.16, q: 1.6, lowpass: 1800 });
    },

    onKo(c, t, ev) {
      // the colossus falls: the hush, the drop, its bronze tolling down out of tune, a landslide of clay and stone
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.9);
      const at = catastrophe(c, subOut(c, pan), o, t, { size: 1, f0: 58 * k });
      gravel(c, o, at, {
        dur: 2.2,
        grains: 70,
        f: 700,
        spread: 1.8,
        gain: 0.3,
        q: 1.4,
        decayShape: 1.2,
        lowpass: 1800,
      });
      // its last sound is wrong: a sacred chord with its overtones slipping out of their series
      wrongHarmonics(c, o, at + 0.3, 73.42 * k, 0.07, resonance(0.2, 1));
      for (const [i, f] of [146.83, 110, 92.5, 73.42, 55].entries())
        lowBell(c, o, at + 0.18 * i, f * k, BELL, { decay: 3, gain: 0.07, shimmer: 0.4 });
    },

    onUltimate(c, t, ev) {
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan * 0.3, 0.9);
      if (ev.phase === 'start') {
        // The Last Light: a choir of the deep swells for 2.4 s while the pressure gathers, then the light lands like a world
        for (const [i, f] of [36.71, 73.42, 110, 146.83, 185, 220].entries())
          tone(c, o, t, {
            type: i < 2 ? 'triangle' : 'sine',
            f0: f * k,
            f1: f * k * 1.01,
            dur: 2.6,
            gain: 0.06 - 0.005 * i,
            attack: 2.2,
            detune: (i - 2.5) * 5,
          });
        swell(c, o, t, { dur: 2.4, gain: 0.18, f0: 70, f1: 1000, sub: 0.14, subHz: 36.71 * k });
        catastrophe(c, subOut(c, 0), o, t + 2.4, { pre: 0, size: 0.7, gain: 0.9, f0: 55 * k });
        lowBell(c, o, t + 2.4, 73.42 * k, BELL, { decay: 3.2, gain: 0.12, shimmer: 0.5 });
      } else {
        for (const [i, f] of [220, 146.83, 110, 73.42].entries())
          lowBell(c, o, t + i * 0.14, f * k, BELL, { decay: 2.2, gain: 0.06 });
        rumble(c, o, t, { dur: 2, gain: 0.08, f0: 220 * k, f1: 60 * k });
      }
    },

    onCue(c, t, ev) {
      const pan = c.panOf(ev.x);
      const a = clamp01(ev.amount);
      if (ev.id.includes('sever')) {
        // a tendril the size of a ridge is severed: the cable snaps low, the stump grinds, the ground takes its weight
        const o = makeOut(c, pan, 0.45);
        filamentSnap(c, o, t, (70 + 50 * a) * k, a * tune.snap, resonance(massBy[ev.slot]));
        boom(c, subOut(c, pan), t + 0.02, { f0: 80 * k, f1: 32 * k, dur: 0.6, gain: 0.25 + 0.15 * a });
        crackle(c, o, t + 0.01, { dur: 0.5, count: 8, gain: 0.08, f: 900 });
      } else if (ev.id === 'eye-exposed') {
        // an eye laid bare: the choir draws a breath and a great bell tolls
        const o = makeOut(c, pan, 0.7);
        swell(c, o, t, { dur: 0.8, gain: 0.08 + 0.05 * a, f0: 90, f1: 700, sub: 0.06 });
        lowBell(c, o, t + 0.8, 110 * k, BELL, { decay: 2.2, gain: 0.1, shimmer: 0.5 });
      }
    },

    update(c, scene, slot, dt) {
      void dt;
      massBy[slot] = scene.massFrac;
      const ac = c.ac;
      let p = pads.get(slot);
      if (!p) {
        const gain = ac.createGain();
        gain.gain.value = 0;
        const filter = ac.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 320;
        filter.Q.value = 0.7;
        filter.connect(gain);
        const pan = ac.createStereoPanner();
        gain.connect(pan);
        pan.connect(c.dry);
        const wet = ac.createGain();
        wet.gain.value = 0.6;
        pan.connect(wet);
        wet.connect(c.wet);
        // a low choir: the root (triangle), the fifth and the octave (saws through the filter), beating against each other
        const oscs = LOW.map((f, i) => {
          const o = ac.createOscillator();
          o.type = i === 0 ? 'triangle' : 'sawtooth';
          o.frequency.value = f;
          o.detune.value = (i - 1) * 8;
          const og = ac.createGain();
          og.gain.value = [1, 0.4, 0.28][i]!;
          o.connect(og);
          og.connect(filter);
          o.start();
          return o;
        });
        const lfo = ac.createOscillator();
        lfo.frequency.value = 0.21;
        const lg = ac.createGain();
        lg.gain.value = 0.01;
        lfo.connect(lg);
        lg.connect(gain.gain);
        lfo.start();
        oscs.push(lfo);
        // its breath: a low band of air (it was a 1.9 kHz hiss)
        const breath = ac.createBufferSource();
        breath.buffer = c.noise;
        breath.loop = true;
        const bf = ac.createBiquadFilter();
        bf.type = 'bandpass';
        bf.frequency.value = 340;
        bf.Q.value = 0.9;
        const breathGain = ac.createGain();
        breathGain.gain.value = 0;
        breath.connect(bf);
        bf.connect(breathGain);
        breathGain.connect(pan);
        breath.start();
        p = { gain, filter, oscs, breath, breathGain, pan };
        pads.set(slot, p);
      }
      // the choir "breathes" in proportion to how fast the titan moves; a quiet floor keeps it alive when still
      const move = clamp01(scene.speed / 600);
      const now = ac.currentTime;
      p.gain.gain.setTargetAtTime(0.014 + 0.03 * move, now, 0.25);
      p.filter.frequency.setTargetAtTime(380 + 800 * move, now, 0.3);
      p.breathGain.gain.setTargetAtTime(0.006 + 0.03 * move, now, 0.2);
      p.pan.pan.setTargetAtTime(clamp(c.panOf(scene.x), -1, 1), now, 0.1);
    },

    stop(slot) {
      const slots = slot === 'all' ? [...pads.keys()] : [slot];
      for (const s of slots) {
        const p = pads.get(s);
        if (p) {
          p.gain.gain.cancelScheduledValues(0);
          p.gain.gain.setValueAtTime(0, 0);
          for (const o of p.oscs) {
            try {
              o.stop();
            } catch {
              /* already stopped */
            }
          }
          try {
            p.breath.stop();
          } catch {
            /* already stopped */
          }
          p.pan.disconnect();
          p.gain.disconnect();
          pads.delete(s);
        }
      }
      for (const s of slot === 'all' ? [...charging.keys()] : [slot]) {
        const ch = charging.get(s);
        if (ch) {
          try {
            for (const o of ch.oscs) o.stop();
            ch.noise.stop();
          } catch {
            /* already stopped */
          }
          charging.delete(s);
        }
      }
    },
  };
}
