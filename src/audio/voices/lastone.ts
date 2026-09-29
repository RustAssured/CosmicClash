import { clamp, clamp01 } from '../dsp/math';
import {
  GLASS,
  TINK,
  gravel,
  makeOut,
  noiseHit,
  partials,
  pick,
  riser,
  thump,
  tone,
  whistlePass,
} from './synth';
import type { TitanVoice, VoiceCtx } from './types';

/**
 * THE LAST ONE — glassy celadon. A single ancient eye and a halo of tendrils; the sound is struck glass and ceramic:
 * inharmonic bell partials with a detuned sine shimmer, "tink" transients, high fracture cracks, a soft breathing pad that
 * follows the tendrils' motion and an eye-flare swell while the Gaze charges.
 *
 * Tuning: everything sits on D pentatonic (D F♯ A B) so any two bells that overlap are consonant.
 */
const BELLS = [587.33, 739.99, 880, 987.77, 1174.66, 1479.98];
const LOW = [146.83, 220, 369.99];

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

export function createLastOneVoice(): TitanVoice {
  const charging = new Map<number, Charging>();
  const pads = new Map<number, Pad>();

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
    gain.gain.setTargetAtTime(0.06, t, 0.08);
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
    filter.frequency.value = 900;
    filter.Q.value = 0.9;
    filter.connect(gain);
    const oscs: OscillatorNode[] = [];
    for (const [i, ratio] of [1, 1.5, 2, 3].entries()) {
      const o = ac.createOscillator();
      o.type = i === 0 ? 'triangle' : 'sine';
      o.frequency.setValueAtTime(220 * ratio, t);
      o.detune.value = (i - 1.5) * 6;
      const og = ac.createGain();
      og.gain.value = [1, 0.5, 0.4, 0.22][i]!;
      o.connect(og);
      og.connect(filter);
      o.start(t);
      oscs.push(o);
    }
    // tremolo: the eye "trembling" as it gathers light
    const lfo = ac.createOscillator();
    lfo.frequency.value = 6;
    const lg = ac.createGain();
    lg.gain.value = 0.035;
    lfo.connect(lg);
    lg.connect(gain.gain);
    lfo.start(t);
    oscs.push(lfo);
    const noise = ac.createBufferSource();
    noise.buffer = c.noise;
    noise.loop = true;
    const nf = ac.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 3000;
    nf.Q.value = 3;
    const ng = ac.createGain();
    ng.gain.value = 0.05;
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

  return {
    titan: 'lastone',

    onMove(c, t, ev) {
      const pan = c.panOf(ev.x);
      const id = ev.moveId;
      if (id.endsWith('lash')) {
        const o = makeOut(c, pan, 0.3);
        noiseHit(c, o, t, {
          dur: 0.2,
          gain: 0.1,
          filter: { type: 'bandpass', f0: 900, f1: 2800, q: 1.4 },
          attack: 0.05,
        });
        tone(c, o, t, { f0: 780, f1: 1500, dur: 0.22, gain: 0.05, attack: 0.05 });
      } else if (id.endsWith('lunge')) {
        const o = makeOut(c, pan, 0.25);
        tone(c, o, t, { f0: 500, f1: 1800, dur: 0.2, gain: 0.07, attack: 0.03 });
        noiseHit(c, o, t, { dur: 0.16, gain: 0.08, filter: { type: 'highpass', f0: 2500 }, attack: 0.04 });
      } else if (id.endsWith('shatter')) {
        // the heavy blow gathers: a rising cluster of detuned glass and a low swell
        const o = makeOut(c, pan, 0.5);
        for (const [i, f] of [293.66, 440, 587.33, 739.99].entries())
          tone(c, o, t + i * 0.04, {
            f0: f * 0.7,
            f1: f * 1.6,
            dur: 0.55,
            gain: 0.05,
            attack: 0.3,
            detune: i * 5,
          });
        tone(c, o, t, { f0: 62, f1: 110, dur: 0.6, gain: 0.16, attack: 0.3, type: 'triangle' });
      } else if (!id.endsWith('gaze') && !id.endsWith('lastlight') && !id.endsWith('sidestep')) {
        noiseHit(c, makeOut(c, pan, 0.2), t, {
          dur: 0.15,
          gain: 0.07,
          filter: { type: 'bandpass', f0: 1200, f1: 2200, q: 1 },
          attack: 0.04,
        });
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
        // brightening and rising as the eye fills: 220 → 660 Hz fundamental, filter opening from 0.9k to 6k; the gain stays
        // modest: a sustained voice at the level of a hit would be deafening (measured −1 dB peak at first)
        const base = 220 * (1 + 2 * f);
        ch.oscs
          .slice(0, 4)
          .forEach((o, i) => o.frequency.setTargetAtTime(base * [1, 1.5, 2, 3][i]!, t, 0.06));
        ch.filter.frequency.setTargetAtTime(900 + 5100 * f, t, 0.06);
        ch.gain.gain.setTargetAtTime(0.06 + 0.075 * f, t, 0.08);
      } else if (ev.phase === 'release') {
        stopGaze(slot, t);
      }
    },

    onRelease(c, t, ev) {
      const pan = c.panOf(ev.x);
      const p = clamp01(ev.power);
      const id = ev.moveId;
      if (id.endsWith('gaze')) {
        // the beam: a searing high chord with a shimmering tail
        const o = makeOut(c, pan, 0.6);
        for (const f of [880, 1174.66, 1479.98])
          tone(c, o, t, {
            f0: f,
            f1: f * 1.02,
            dur: 0.6 + 0.4 * p,
            gain: 0.08 + 0.05 * p,
            attack: 0.01,
            detune: c.rand() * 8 - 4,
          });
        noiseHit(c, o, t, { dur: 0.4, gain: 0.08, filter: { type: 'highpass', f0: 5000 }, attack: 0.01 });
      } else if (id.endsWith('lash')) {
        const o = makeOut(c, pan, 0.3);
        noiseHit(c, o, t, { dur: 0.018, gain: 0.4, filter: { type: 'highpass', f0: 4500 }, attack: 0.0005 });
        partials(c, o, t, pick(c, BELLS) * 2, TINK, { decay: 0.16, gain: 0.11 });
      } else if (id.endsWith('shatter')) {
        const o = makeOut(c, pan, 0.55);
        thump(c, makeOut(c, pan * 0.3, 0), t, 80, 28, 0.9, 0.55);
        gravel(c, o, t, { dur: 0.7, grains: 30, f: 6000, spread: 1.6, gain: 0.16, q: 2.4 });
        partials(c, o, t, 1174.66, GLASS, { decay: 0.9, gain: 0.07, shimmer: 0.35 });
      } else if (id.endsWith('lunge')) {
        noiseHit(c, makeOut(c, pan, 0.2), t, {
          dur: 0.1,
          gain: 0.3,
          filter: { type: 'highpass', f0: 3500 },
          attack: 0.001,
        });
      }
    },

    onSurge(c, t, ev) {
      // "charge, and sidestep": a crystalline sweep that lands on a soft bell
      const pan = c.panOf(ev.x);
      whistlePass(c, t, {
        f: 1250,
        dur: 0.32,
        gain: 0.07,
        panFrom: clamp(pan - 0.4 * Math.sign(ev.dirX || 1), -1, 1),
        panTo: clamp(pan + 0.4 * Math.sign(ev.dirX || 1), -1, 1),
        wet: 0.4,
        approach: 1.6,
        recede: 0.55,
      });
      partials(c, makeOut(c, pan, 0.5), t + 0.28, pick(c, BELLS), GLASS, {
        decay: 0.4,
        gain: 0.05,
        shimmer: 0.3,
      });
    },

    onHitDealt(c, t, ev, mag) {
      // fracture accent: a bright shard tink riding the shear
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.35);
      partials(c, o, t, pick(c, BELLS) * 2, TINK, { decay: 0.12 + 0.18 * mag, gain: 0.05 + 0.07 * mag });
      if (ev.heavy) gravel(c, o, t + 0.01, { dur: 0.5, grains: 26, f: 7000, spread: 1.4, gain: 0.14, q: 3 });
    },

    onHitTaken(c, t, ev, mag) {
      // the body is glass: it RINGS. Heavier blows ring lower and longer; blocked blows barely ring.
      const pan = c.panOf(ev.x);
      const ring = 1 - clamp01(ev.blocked) * 0.85;
      const o = makeOut(c, pan, 0.55);
      const f = pick(c, BELLS.slice(0, 4)) * (1.4 - 0.5 * mag);
      partials(c, o, t, f, GLASS, {
        decay: 0.35 + 1.1 * mag,
        gain: (0.07 + 0.1 * mag) * ring,
        shimmer: 0.4,
        attack: 0.001,
      });
      // glass rings AND chips: a bright ceramic tink and a shard click ride every blow (more of it on damaged glass)
      partials(c, o, t + 0.004, f * 2.76, TINK, { decay: 0.1, gain: 0.5 * ring });
      noiseHit(c, o, t, { dur: 0.012, gain: 0.1 * ring, filter: { type: 'highpass', f0: 6000 }, attack: 0.0004 });
    },

    onGuard(c, t, ev) {
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.5);
      partials(c, o, t, pick(c, BELLS.slice(2)), GLASS, {
        decay: ev.broke ? 1.4 : 0.5,
        gain: ev.broke ? 0.14 : 0.1,
        shimmer: 0.3,
      });
      thump(c, makeOut(c, pan * 0.3, 0), t, 110, 46, ev.broke ? 0.8 : 0.3, ev.broke ? 0.6 : 0.3);
      if (ev.broke) gravel(c, o, t, { dur: 0.7, grains: 28, f: 5500, spread: 1.6, gain: 0.18, q: 2.4 });
    },

    onKo(c, t, ev) {
      // the celadon shell shatters: a shower of glass over a slow falling bell cluster
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.9);
      gravel(c, o, t, { dur: 1.8, grains: 70, f: 6500, spread: 1.8, gain: 0.55, q: 1.6, decayShape: 1.2 });
      for (const [i, f] of [987.77, 739.99, 587.33, 440, 293.66].entries())
        partials(c, o, t + 0.12 * i, f, GLASS, { decay: 2.2, gain: 0.07, shimmer: 0.4 });
    },

    onUltimate(c, t, ev) {
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan * 0.3, 0.9);
      if (ev.phase === 'start') {
        // The Last Light: a choir of glass that swells for 2.4 s, brightening, then blooms
        for (const [i, f] of [146.83, 293.66, 440, 587.33, 739.99, 1174.66].entries())
          tone(c, o, t, {
            f0: f,
            f1: f * 1.01,
            dur: 2.6,
            gain: 0.05 + 0.005 * i,
            attack: 2.2,
            detune: (i - 2.5) * 4,
          });
        riser(c, o, t, 2.4, 0.16, 800, 9000);
        thump(c, makeOut(c, 0, 0), t + 2.4, 60, 22, 1.6, 0.9);
        partials(c, o, t + 2.4, 1174.66, GLASS, { decay: 2.4, gain: 0.12, shimmer: 0.5 });
      } else {
        for (const [i, f] of [1174.66, 880, 587.33, 440].entries())
          partials(c, o, t + i * 0.1, f, GLASS, { decay: 1.8, gain: 0.06 });
      }
    },

    onCue(c, t, ev) {
      const pan = c.panOf(ev.x);
      const a = clamp01(ev.amount);
      if (ev.id === 'tendril-sever') {
        const o = makeOut(c, pan, 0.4);
        partials(c, o, t, pick(c, BELLS) * 2, TINK, { decay: 0.14, gain: 0.1 });
        tone(c, o, t + 0.01, { f0: 1800, f1: 500, dur: 0.14, gain: 0.05 });
      } else if (ev.id === 'eye-exposed') {
        const o = makeOut(c, pan, 0.7);
        partials(c, o, t, 1479.98, GLASS, { decay: 1.2, gain: 0.1, shimmer: 0.5 });
        riser(c, o, t, 0.8, 0.08 + 0.06 * a, 1200, 7000);
      }
    },

    update(c, scene, slot, dt) {
      void dt;
      const ac = c.ac;
      let p = pads.get(slot);
      if (!p) {
        const gain = ac.createGain();
        gain.gain.value = 0;
        const filter = ac.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 700;
        filter.Q.value = 0.6;
        filter.connect(gain);
        const pan = ac.createStereoPanner();
        gain.connect(pan);
        pan.connect(c.dry);
        const wet = ac.createGain();
        wet.gain.value = 0.6;
        pan.connect(wet);
        wet.connect(c.wet);
        const oscs = LOW.map((f, i) => {
          const o = ac.createOscillator();
          o.type = i === 0 ? 'triangle' : 'sine';
          o.frequency.value = f;
          o.detune.value = (i - 1) * 7;
          const og = ac.createGain();
          og.gain.value = [1, 0.7, 0.45][i]!;
          o.connect(og);
          og.connect(filter);
          o.start();
          return o;
        });
        const lfo = ac.createOscillator();
        lfo.frequency.value = 0.27;
        const lg = ac.createGain();
        lg.gain.value = 0.012;
        lfo.connect(lg);
        lg.connect(gain.gain);
        lfo.start();
        oscs.push(lfo);
        const breath = ac.createBufferSource();
        breath.buffer = c.noise;
        breath.loop = true;
        const bf = ac.createBiquadFilter();
        bf.type = 'bandpass';
        bf.frequency.value = 1900;
        bf.Q.value = 1.6;
        const breathGain = ac.createGain();
        breathGain.gain.value = 0;
        breath.connect(bf);
        bf.connect(breathGain);
        breathGain.connect(pan);
        breath.start();
        p = { gain, filter, oscs, breath, breathGain, pan };
        pads.set(slot, p);
      }
      // the tendrils "breathe" in proportion to how fast the titan moves; a quiet floor keeps it alive when still
      const move = clamp01(scene.speed / 600);
      const now = ac.currentTime;
      p.gain.gain.setTargetAtTime(0.012 + 0.03 * move, now, 0.25);
      p.filter.frequency.setTargetAtTime(500 + 1500 * move, now, 0.3);
      p.breathGain.gain.setTargetAtTime(0.004 + 0.02 * move, now, 0.2);
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
