import { clamp, clamp01 } from '../dsp/math';
import { IRON, gravel, makeOut, noiseHit, pick } from './synth';
import { subOut } from './kit';
import type { TitanVoice, VoiceCtx } from './types';
import { boom, catastrophe, crackle, grind, lowBell, rumble, swell, whoosh } from './epic';

/**
 * ASTEROID — a tumbling mountain of iron-nickel rock. D34 took out its whistle (the 1.15 kHz Doppler pass when it tumbles) and its
 * shrapnel pings (0.8–3.2 kHz iron): it is now all stone and anvil — a rock crunch under 1.8 kHz, granular rubble, a deep drop on
 * every blow, iron veins that ring like a struck anvil the size of a city (IRON partials on 70–120 Hz), and a rolling,
 * grinding rumble under it that speeds up with its tumble.
 */
const ANVIL_HZ = [69.3, 77.78, 92.5, 103.83, 116.54];

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

  /** A mountain striking: the drop, a low-passed crunch, rubble. */
  const crunch = (c: VoiceCtx, t: number, pan: number, mag: number, wet = 0.3): void => {
    const o = makeOut(c, pan, wet);
    noiseHit(c, o, t, {
      dur: 0.14 + 0.2 * mag,
      gain: 0.3 + 0.2 * mag,
      filter: { type: 'lowpass', f0: 1000, f1: 200, q: 1 },
    });
    gravel(c, o, t + 0.008, {
      dur: 0.3 + 0.3 * mag,
      grains: 12 + Math.round(mag * 22),
      f: 400,
      spread: 2.2,
      gain: 0.36 + 0.16 * mag,
      lowpass: 1200,
    });
    boom(c, subOut(c, pan), t, {
      f0: 86 - 22 * mag,
      f1: 28,
      dur: 0.35 + 0.6 * mag,
      gain: 0.3 + 0.38 * mag,
      drive: 2.6,
    });
  };

  return {
    titan: 'asteroid',

    onMove(c, t, ev) {
      const pan = c.panOf(ev.x);
      const id = ev.moveId;
      if (id.endsWith('shoulder')) {
        // stone grinding against stone as it turns its shoulder in
        const o = makeOut(c, pan, 0.25);
        grind(c, o, t, { dur: 0.28, gain: 0.11, f0: 220, f1: 420, rate: 9, attack: 0.08 });
        swell(c, o, t, { dur: 0.25, gain: 0.07, f0: 110, f1: 500 });
      } else if (id.endsWith('meteor')) {
        // the big one gathers: a rising rumble and the pressure in front of it (no whistle)
        const o = makeOut(c, pan, 0.45);
        swell(c, o, t, { dur: 0.55, gain: 0.18, f0: 80, f1: 700, sub: 0.1, subHz: 38 });
        grind(c, o, t, { dur: 0.55, gain: 0.07, f0: 140, f1: 300, rate: 6, attack: 0.3 });
      } else if (id.endsWith('swarm')) {
        gravel(c, makeOut(c, pan, 0.3), t, {
          dur: 0.35,
          grains: 20,
          f: 600,
          spread: 1.6,
          gain: 0.3,
          q: 1.4,
          lowpass: 1600,
        });
      }
    },

    onRelease(c, t, ev) {
      const pan = c.panOf(ev.x);
      const id = ev.moveId;
      const p = clamp01(ev.power);
      if (id.endsWith('meteor')) {
        crunch(c, t, pan, 0.9 + 0.1 * p, 0.5);
        boom(c, subOut(c, 0), t, { f0: 60, f1: 22, dur: 1.4, gain: 0.6, drive: 3 });
        rumble(c, makeOut(c, pan * 0.5, 0.7), t, { dur: 2, gain: 0.12, f0: 260, f1: 60 });
      } else if (id.endsWith('shoulder')) {
        crunch(c, t, pan, 0.45, 0.25);
      } else if (id.endsWith('swarm')) {
        // a hail of boulders let loose: a scatter of rock impacts, each with its own small drop
        const o = makeOut(c, pan, 0.45);
        for (let i = 0; i < 7; i++) {
          const at = t + c.rand() * 0.4;
          const pp = clamp(pan + (c.rand() - 0.5) * 0.6, -1, 1);
          boom(c, subOut(c, pp), at, { f0: 110 + 30 * c.rand(), f1: 50, dur: 0.18, gain: 0.12, knock: 1.1 });
        }
        gravel(c, o, t, { dur: 0.45, grains: 24, f: 520, spread: 1.8, gain: 0.22, q: 1.2, lowpass: 1500 });
      }
    },

    onSurge(c, t, ev) {
      // a mountain tumbling past: the air it shoves aside and the grit of it rolling (it was a 1.15 kHz Doppler whistle)
      const pan = c.panOf(ev.x);
      const dir = Math.sign(ev.dirX || 1);
      whoosh(c, t, {
        dur: 0.55,
        gain: 0.1,
        panFrom: clamp(pan - 0.6 * dir, -1, 1),
        panTo: clamp(pan + 0.6 * dir, -1, 1),
        wet: 0.35,
        f0: 650,
        f1: 120,
        body: 1.2,
      });
      grind(c, makeOut(c, pan, 0.15), t, { dur: 0.5, gain: 0.05, f0: 260, f1: 160, rate: 5, attack: 0.1 });
    },

    onHitDealt(c, t, ev, mag) {
      // kinetic accent: the anvil ring of its iron veins and spalling rock
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.35);
      lowBell(c, o, t, pick(c, ANVIL_HZ), IRON, { decay: 0.4 + 0.6 * mag, gain: 0.06 + 0.06 * mag });
      gravel(c, o, t + 0.005, {
        dur: 0.25,
        grains: 8 + Math.round(mag * 8),
        f: 700,
        spread: 1.6,
        gain: 0.08,
        lowpass: 1600,
      });
    },

    onHitTaken(c, t, ev, mag) {
      // the body is rock: it CRUNCHES (and the nickel-iron veins ring when a blow lands on damaged matter)
      const pan = c.panOf(ev.x);
      const open = 1 - clamp01(ev.blocked) * 0.7;
      crunch(c, t, pan, mag * open, 0.25);
      if (ev.onDamaged > 0.3)
        lowBell(c, makeOut(c, pan, 0.4), t + 0.005, pick(c, ANVIL_HZ) * 1.5, IRON, {
          decay: 0.6,
          gain: 0.07 * open,
        });
    },

    onGuard(c, t, ev) {
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.4);
      lowBell(c, o, t, 92.5, IRON, { decay: ev.broke ? 1.2 : 0.6, gain: ev.broke ? 0.16 : 0.12 });
      boom(c, subOut(c, pan), t, {
        f0: 100,
        f1: 42,
        dur: ev.broke ? 0.9 : 0.35,
        gain: ev.broke ? 0.6 : 0.32,
      });
      if (ev.broke) gravel(c, o, t, { dur: 0.6, grains: 30, f: 520, spread: 2.4, gain: 0.22, lowpass: 1500 });
    },

    onKo(c, t, ev) {
      // the mountain gives up: the hush, the drop, then a long landslide of falling stone and anvil tolls
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.75);
      const at = catastrophe(c, subOut(c, pan), o, t, { size: 1, f0: 60 });
      gravel(c, o, at, {
        dur: 2.6,
        grains: 90,
        f: 420,
        spread: 3,
        gain: 0.26,
        q: 1,
        decayShape: 1.1,
        lowpass: 1500,
      });
      for (let i = 0; i < 5; i++)
        lowBell(c, o, at + 0.2 + i * 0.32, pick(c, ANVIL_HZ) * 0.8, IRON, { decay: 1, gain: 0.05 });
    },

    onUltimate(c, t, ev) {
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan * 0.3, 0.7);
      if (ev.phase === 'start') {
        // Kessler: a storm of debris builds around it, boulders striking boulders, then everything lands at once
        swell(c, o, t, { dur: 2.4, gain: 0.26, f0: 80, f1: 900, sub: 0.12, subHz: 36 });
        for (let i = 0; i < 18; i++) {
          const at = t + 0.3 + Math.pow(c.rand(), 0.7) * 2.0;
          boom(c, subOut(c, (c.rand() - 0.5) * 1.6), at, {
            f0: 100 + 40 * c.rand(),
            f1: 46,
            dur: 0.16,
            gain: 0.07,
          });
        }
        crackle(c, o, t + 0.4, { dur: 2, count: 30, gain: 0.08, f: 800 });
        catastrophe(c, subOut(c, 0), o, t + 2.4, { pre: 0, size: 0.7, gain: 0.9, f0: 55 });
      } else {
        gravel(c, o, t, {
          dur: 1.6,
          grains: 50,
          f: 500,
          spread: 2.6,
          gain: 0.2,
          decayShape: 1.2,
          lowpass: 1400,
        });
      }
    },

    onCue(c, t, ev) {
      const pan = c.panOf(ev.x);
      if (ev.id === 'fragment-lost') {
        // a piece of the mountain breaks away: a low anvil clank and the rubble of it
        const o = makeOut(c, pan, 0.4);
        lowBell(c, o, t, 103.83 + 30 * clamp01(ev.amount), IRON, { decay: 0.5, gain: 0.08 });
        gravel(c, o, t, { dur: 0.25, grains: 8, f: 600, spread: 1.4, gain: 0.08, lowpass: 1500 });
      } else if (ev.id === 'rubble-pile') {
        noiseHit(c, makeOut(c, pan, 0.5), t, {
          dur: 1.2,
          gain: 0.2,
          filter: { type: 'lowpass', f0: 260, f1: 60 },
          kind: 'brown',
          attack: 0.05,
        });
      } else if (ev.id === 'momentum') {
        boom(c, subOut(c, pan), t, { f0: 120, f1: 64, dur: 0.14, gain: 0.1 });
      }
    },

    onMatter(c, t, ev) {
      const pan = c.panOf(ev.x);
      if (ev.kind !== 'detach') return false; // fire, cracks, harvest…: the generic matter sounds
      gravel(c, makeOut(c, pan, 0.25), t, {
        dur: 0.45,
        grains: 20,
        f: 480,
        spread: 2.4,
        gain: 0.12,
        lowpass: 1400,
      });
      boom(c, subOut(c, pan), t, {
        f0: 88,
        f1: 38,
        dur: 0.3,
        gain: 0.16 + 0.2 * clamp01(Math.log10(Math.max(1, ev.mass)) / 3),
      });
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
        wet.gain.value = 0.3;
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
      r.gain.gain.setTargetAtTime(0.03 + 0.18 * sp, now, 0.15);
      r.lfoGain.gain.setTargetAtTime(0.07 * sp, now, 0.15);
      r.lfo.frequency.setTargetAtTime(1.0 + 2.6 * sp, now, 0.2);
      r.filter.frequency.setTargetAtTime((150 + 300 * sp) * (0.8 + 0.4 * (1.2 - mf)), now, 0.2);
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
