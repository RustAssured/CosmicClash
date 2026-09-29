import { clamp, clamp01 } from '../dsp/math';
import { IRON, gravel, makeOut, noiseHit, partials, pick, riser, thump, tone, whistlePass } from './synth';
import type { TitanVoice, VoiceCtx } from './types';

/**
 * ASTEROID — iron-nickel rock. Small, fast, still heavy. The sound is stone and metal: rock crunch (filtered noise plus
 * granular gravel), the whistle of a tumbling body passing (Doppler), iron ringing off ejecta and shrapnel, and dense thuds.
 */
const IRON_HZ = [392, 466, 523, 622, 698];

interface Roll {
  gain: GainNode;
  lfoGain: GainNode;
  filter: BiquadFilterNode;
  src: AudioBufferSourceNode;
  lfo: OscillatorNode;
  pan: StereoPannerNode;
}

export function createAsteroidVoice(): TitanVoice {
  const rolls = new Map<number, Roll>();

  /** A rock striking: lowpassed noise crunch + gravel grains + a low boom. */
  const crunch = (c: VoiceCtx, t: number, pan: number, mag: number, wet = 0.25): void => {
    const o = makeOut(c, pan, wet);
    noiseHit(c, o, t, {
      dur: 0.12 + 0.16 * mag,
      gain: 0.2 + 0.15 * mag,
      filter: { type: 'lowpass', f0: 1500, f1: 240, q: 1 },
    });
    gravel(c, o, t + 0.008, {
      dur: 0.22 + 0.25 * mag,
      grains: 12 + Math.round(mag * 22),
      f: 700,
      spread: 2.4,
      gain: 0.2 + 0.1 * mag,
      lowpass: 1800,
    });
    thump(c, makeOut(c, pan * 0.3, 0), t, 74 - 20 * mag, 28, 0.25 + 0.4 * mag, 0.3 + 0.35 * mag);
  };

  return {
    titan: 'asteroid',

    onMove(c, t, ev) {
      const pan = c.panOf(ev.x);
      const id = ev.moveId;
      if (id.endsWith('shoulder')) {
        // stone grinding against stone
        const o = makeOut(c, pan, 0.2);
        noiseHit(c, o, t, {
          dur: 0.22,
          gain: 0.09,
          filter: { type: 'bandpass', f0: 380, f1: 1100, q: 1.3 },
          attack: 0.05,
        });
        tone(c, o, t, { f0: 170, f1: 110, dur: 0.25, gain: 0.08, type: 'triangle', attack: 0.06 });
      } else if (id.endsWith('meteor')) {
        // the big one gathers: a rising rumble with a thin whistle underneath
        const o = makeOut(c, pan, 0.45);
        noiseHit(c, o, t, {
          dur: 0.55,
          gain: 0.2,
          filter: { type: 'lowpass', f0: 90, f1: 800, q: 1.4 },
          kind: 'brown',
          attack: 0.3,
        });
        tone(c, o, t, { f0: 260, f1: 900, dur: 0.55, gain: 0.03, attack: 0.3 });
      } else if (id.endsWith('swarm')) {
        gravel(c, makeOut(c, pan, 0.3), t, { dur: 0.3, grains: 20, f: 2600, spread: 1.6, gain: 0.32, q: 2 });
      }
    },

    onRelease(c, t, ev) {
      const pan = c.panOf(ev.x);
      const id = ev.moveId;
      const p = clamp01(ev.power);
      if (id.endsWith('meteor')) {
        crunch(c, t, pan, 0.9 + 0.1 * p, 0.5);
        thump(c, makeOut(c, 0, 0), t, 60, 24, 1.1, 0.7);
      } else if (id.endsWith('shoulder')) {
        crunch(c, t, pan, 0.45, 0.25);
      } else if (id.endsWith('swarm')) {
        // a cloud of iron shards let loose: a fast scatter of small pings
        const o = makeOut(c, pan, 0.45);
        for (let i = 0; i < 14; i++)
          partials(c, o, t + c.rand() * 0.35, 800 + c.rand() * 2400, IRON, {
            decay: 0.09 + c.rand() * 0.12,
            gain: 0.07 + c.rand() * 0.06,
            maxHz: 9000,
          });
        gravel(c, o, t, { dur: 0.3, grains: 16, f: 3000, spread: 1.4, gain: 0.22, q: 4 });
      }
    },

    onSurge(c, t, ev) {
      // tumbling past: the whistle of a spinning body plus the grit of it rolling
      const pan = c.panOf(ev.x);
      const dir = Math.sign(ev.dirX || 1);
      whistlePass(c, t, {
        f: 1150,
        dur: 0.55,
        gain: 0.09,
        panFrom: clamp(pan - 0.6 * dir, -1, 1),
        panTo: clamp(pan + 0.6 * dir, -1, 1),
        wet: 0.35,
        approach: 1.45,
        recede: 0.62,
      });
      gravel(c, makeOut(c, pan, 0.15), t, { dur: 0.5, grains: 18, f: 500, spread: 2, gain: 0.1 });
    },

    onHitDealt(c, t, ev, mag) {
      // kinetic accent: an iron ring off the impact and spalling rock
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.35);
      partials(c, o, t, pick(c, IRON_HZ), IRON, { decay: 0.25 + 0.4 * mag, gain: 0.06 + 0.06 * mag });
      gravel(c, o, t + 0.005, {
        dur: 0.2,
        grains: 8 + Math.round(mag * 8),
        f: 2200,
        spread: 1.6,
        gain: 0.08,
      });
    },

    onHitTaken(c, t, ev, mag) {
      // the body is rock: it CRUNCHES (and the nickel-iron veins ring when a blow lands on damaged matter)
      const pan = c.panOf(ev.x);
      const open = 1 - clamp01(ev.blocked) * 0.7;
      crunch(c, t, pan, mag * open, 0.2);
      if (ev.onDamaged > 0.3)
        partials(c, makeOut(c, pan, 0.4), t + 0.005, pick(c, IRON_HZ) * 1.5, IRON, {
          decay: 0.35,
          gain: 0.07 * open,
        });
    },

    onGuard(c, t, ev) {
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.4);
      partials(c, o, t, 420, IRON, { decay: ev.broke ? 1.0 : 0.5, gain: ev.broke ? 0.18 : 0.13 });
      thump(c, makeOut(c, pan * 0.3, 0), t, 105, 44, ev.broke ? 0.8 : 0.3, ev.broke ? 0.65 : 0.32);
      if (ev.broke) gravel(c, o, t, { dur: 0.6, grains: 30, f: 1100, spread: 2.6, gain: 0.22 });
    },

    onKo(c, t, ev) {
      // the rock gives up: a long cascade of falling stones over a deep rumble
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.7);
      gravel(c, o, t, { dur: 2.3, grains: 90, f: 700, spread: 3.4, gain: 0.26, q: 1, decayShape: 1.1 });
      noiseHit(c, o, t, {
        dur: 2.2,
        gain: 0.2,
        filter: { type: 'lowpass', f0: 500, f1: 60, q: 1.2 },
        kind: 'brown',
        attack: 0.02,
      });
      for (let i = 0; i < 6; i++)
        partials(c, o, t + 0.2 + i * 0.28, pick(c, IRON_HZ) * 0.7, IRON, { decay: 0.6, gain: 0.05 });
    },

    onUltimate(c, t, ev) {
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan * 0.3, 0.7);
      if (ev.phase === 'start') {
        // Kessler: a storm of debris builds around it
        noiseHit(c, o, t, {
          dur: 2.4,
          gain: 0.3,
          filter: { type: 'lowpass', f0: 250, f1: 3200, q: 0.9 },
          kind: 'brown',
          attack: 2.0,
        });
        riser(c, o, t, 2.4, 0.12, 400, 6000);
        for (let i = 0; i < 26; i++)
          partials(c, o, t + 0.3 + c.rand() * 2.0, 600 + c.rand() * 2600, IRON, {
            decay: 0.12,
            gain: 0.03,
            maxHz: 9000,
          });
        thump(c, makeOut(c, 0, 0), t + 2.4, 55, 22, 1.8, 0.9);
      } else {
        gravel(c, o, t, { dur: 1.6, grains: 50, f: 900, spread: 3, gain: 0.2, decayShape: 1.2 });
      }
    },

    onCue(c, t, ev) {
      const pan = c.panOf(ev.x);
      if (ev.id === 'fragment-lost') {
        const o = makeOut(c, pan, 0.4);
        partials(c, o, t, 1300 + 900 * clamp01(ev.amount), IRON, { decay: 0.2, gain: 0.09 });
        gravel(c, o, t, { dur: 0.15, grains: 6, f: 2200, spread: 1.4, gain: 0.08 });
      } else if (ev.id === 'rubble-pile') {
        noiseHit(c, makeOut(c, pan, 0.5), t, {
          dur: 1.0,
          gain: 0.18,
          filter: { type: 'lowpass', f0: 240, f1: 60 },
          kind: 'brown',
          attack: 0.05,
        });
      } else if (ev.id === 'momentum') {
        thump(c, makeOut(c, pan * 0.3, 0), t, 130, 70, 0.1, 0.1);
      }
    },

    onMatter(c, t, ev) {
      const pan = c.panOf(ev.x);
      if (ev.kind !== 'detach') return false; // fire, cracks, harvest…: the generic matter sounds
      gravel(c, makeOut(c, pan, 0.25), t, { dur: 0.4, grains: 20, f: 1000, spread: 2.6, gain: 0.12 });
      thump(
        c,
        makeOut(c, pan * 0.3, 0),
        t,
        90,
        40,
        0.25,
        0.16 + 0.2 * clamp01(Math.log10(Math.max(1, ev.mass)) / 3),
      );
      return true;
    },

    update(c, scene, slot) {
      const ac = c.ac;
      let r = rolls.get(slot);
      if (!r) {
        const src = ac.createBufferSource();
        src.buffer = c.brown;
        src.loop = true;
        const filter = ac.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 220;
        filter.Q.value = 1.1;
        const gain = ac.createGain();
        gain.gain.value = 0;
        // the roll: amplitude modulated at the tumble rate
        const lfo = ac.createOscillator();
        lfo.frequency.value = 1.6;
        const lfoGain = ac.createGain();
        lfoGain.gain.value = 0;
        lfo.connect(lfoGain);
        lfoGain.connect(gain.gain);
        const pan = ac.createStereoPanner();
        src.connect(filter);
        filter.connect(gain);
        gain.connect(pan);
        pan.connect(c.dry);
        const wet = ac.createGain();
        wet.gain.value = 0.25;
        pan.connect(wet);
        wet.connect(c.wet);
        src.start();
        lfo.start();
        r = { gain, lfoGain, filter, src, lfo, pan };
        rolls.set(slot, r);
      }
      const now = ac.currentTime;
      const sp = clamp01(scene.speed / 700);
      const mf = clamp(scene.massFrac, 0.1, 1.2);
      r.gain.gain.setTargetAtTime(0.02 + 0.16 * sp, now, 0.15);
      r.lfoGain.gain.setTargetAtTime(0.06 * sp, now, 0.15);
      r.lfo.frequency.setTargetAtTime(1.0 + 2.6 * sp, now, 0.2);
      r.filter.frequency.setTargetAtTime((140 + 380 * sp) * (0.8 + 0.4 * (1.2 - mf)), now, 0.2);
      r.pan.pan.setTargetAtTime(clamp(c.panOf(scene.x), -1, 1), now, 0.1);
    },

    stop(slot) {
      for (const s of slot === 'all' ? [...rolls.keys()] : [slot]) {
        const r = rolls.get(s);
        if (!r) continue;
        try {
          r.src.stop();
          r.lfo.stop();
        } catch {
          /* already stopped */
        }
        r.pan.disconnect();
        r.gain.disconnect();
        rolls.delete(s);
      }
    },
  };
}
