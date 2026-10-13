import { makeOut, noiseHit, tone } from './synth';
import { bubbles, scrape } from './kit';
import { boom, crackle, rumble, swell } from './epic';
import type { TitanVoice, VoiceCtx } from './types';

/**
 * THE CRADLE's voice (brief "Sound"): "listening to something alive through the wall of an impossible body". Low and wet,
 * never a roar and never a whistle (D34):
 *  - wet sail tension: the membrane creaks as it loads (a slow, low scrape of brown noise);
 *  - a subsonic whale pulse: very low sine swells in slow beats (felt more than heard; the harmonics carry it on a laptop);
 *  - distant ultrasound-like clicking: a regular train of short, muffled clicks (band-passed low enough never to whistle);
 *  - cartilage cracking under pressure: dry crackle;
 *  - fluid shifting through pipes hundreds of kilometres wide: slow, low bubbling;
 *  - when it attacks, a deep CONTRACTION (a closing sub swell and a squeeze of the membrane), not a roar.
 */
const F = 34;

/** Muffled clicks in a slow, regular train (the ultrasound heard through tissue). */
function clicks(c: VoiceCtx, pan: number, t: number, n: number, every: number, gain: number): void {
  const o = makeOut(c, pan, 0.45);
  for (let i = 0; i < n; i++)
    noiseHit(c, o, t + i * every + c.rand() * 0.008, {
      dur: 0.012,
      gain: gain * (0.7 + 0.3 * c.rand()),
      attack: 0.001,
      filter: { type: 'bandpass', f0: 1300, q: 3 },
      filter2: { type: 'lowpass', f0: 1900, q: 0.5 },
    });
}

/** A whale pulse: `beats` slow swells of a sub sine with a growl an octave and a fifth up so small speakers hear it. */
function whale(c: VoiceCtx, pan: number, t: number, beats: number, gain: number): void {
  const o = makeOut(c, pan, 0.35);
  for (let b = 0; b < beats; b++) {
    const at = t + b * 0.62;
    tone(c, o, at, { f0: F * 1.1, f1: F * 0.9, dur: 0.55, gain, attack: 0.18 });
    tone(c, o, at, { type: 'triangle', f0: F * 3, f1: F * 2.7, dur: 0.5, gain: gain * 0.3, attack: 0.15 });
  }
}

/** The contraction: a closing sub swell and the membrane squeezed (a creak that falls). */
function contraction(c: VoiceCtx, pan: number, t: number, size: number): void {
  const o = makeOut(c, pan, 0.4);
  swell(c, o, t, {
    dur: 0.35 + 0.5 * size,
    gain: 0.1 + 0.12 * size,
    f0: 420,
    f1: 110,
    sub: 0.1 + 0.1 * size,
    subHz: F * 1.5,
  });
  scrape(c, o, t, {
    dur: 0.3 + 0.4 * size,
    f0: 190,
    f1: 95,
    gain: 0.05 + 0.06 * size,
    rate: 9,
    kind: 'brown',
  });
}

interface Bed {
  whale: OscillatorNode;
  growl: OscillatorNode;
  pulse: OscillatorNode;
  pulseGain: GainNode;
  body: GainNode;
  sail: AudioBufferSourceNode;
  sailFilter: BiquadFilterNode;
  sailGain: GainNode;
  pan: StereoPannerNode;
}

export function createCradleVoice(): TitanVoice {
  const beds = new Map<0 | 1, Bed>();
  return {
    titan: 'cradle',
    /**
     * Always there under the fight: the whale pulse (a sub sine and its growl, swelling in slow beats) and the wet sail
     * tension (low brown noise that rises as it moves). As it is hurt the pulse quickens and roughens.
     */
    update(c, scene, slot) {
      const ac = c.ac;
      let b = beds.get(slot);
      if (!b) {
        const pan = ac.createStereoPanner();
        pan.connect(c.dry);
        const wet = ac.createGain();
        wet.gain.value = 0.35;
        pan.connect(wet);
        wet.connect(c.wet);
        const body = ac.createGain();
        body.gain.value = 0;
        body.connect(pan);
        const whale = ac.createOscillator();
        whale.frequency.value = F;
        const growl = ac.createOscillator();
        growl.type = 'triangle';
        growl.frequency.value = F * 3;
        const gw = ac.createGain();
        gw.gain.value = 0.25;
        growl.connect(gw);
        // the beat: the body's level swung by a slow LFO (a pulse, not a tone)
        const pulseGain = ac.createGain();
        pulseGain.gain.value = 0;
        const pulse = ac.createOscillator();
        pulse.frequency.value = 0.3;
        pulse.connect(pulseGain);
        pulseGain.connect(body.gain);
        whale.connect(body);
        gw.connect(body);
        const sail = ac.createBufferSource();
        sail.buffer = c.brown;
        sail.loop = true;
        const sailFilter = ac.createBiquadFilter();
        sailFilter.type = 'lowpass';
        sailFilter.frequency.value = 150;
        sailFilter.Q.value = 2;
        const sailGain = ac.createGain();
        sailGain.gain.value = 0;
        sail.connect(sailFilter);
        sailFilter.connect(sailGain);
        sailGain.connect(pan);
        whale.start();
        growl.start();
        pulse.start();
        sail.start();
        b = { whale, growl, pulse, pulseGain, body, sail, sailFilter, sailGain, pan };
        beds.set(slot, b);
      }
      const now = ac.currentTime;
      const hurt = 1 - Math.max(0, Math.min(1, scene.massFrac));
      const sp = Math.max(0, Math.min(1, scene.speed / 600));
      b.body.gain.setTargetAtTime(0.05, now, 0.3);
      b.pulseGain.gain.setTargetAtTime(0.045, now, 0.3);
      b.pulse.frequency.setTargetAtTime(0.3 + 0.5 * hurt, now, 0.5);
      b.growl.frequency.setTargetAtTime(F * (3 + 0.4 * hurt), now, 0.5);
      b.sailGain.gain.setTargetAtTime(0.02 + 0.1 * sp, now, 0.2);
      b.sailFilter.frequency.setTargetAtTime(120 + 160 * sp, now, 0.2);
      b.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, c.panOf(scene.x))), now, 0.1);
    },
    stop(slot) {
      for (const s of slot === 'all' ? [...beds.keys()] : [slot]) {
        const b = beds.get(s);
        if (!b) continue;
        try {
          b.whale.stop();
          b.growl.stop();
          b.pulse.stop();
          b.sail.stop();
        } catch {
          /* already stopped */
        }
        b.pan.disconnect();
        b.body.disconnect();
        b.sailGain.disconnect();
        beds.delete(s);
      }
    },
    onMove(c, t, ev) {
      const pan = c.panOf(ev.x);
      const big =
        ev.moveSlot === 'crush' || ev.moveSlot === 'ultimate' ? 1 : ev.moveSlot === 'surge' ? 0.3 : 0.55;
      contraction(c, pan, t, big);
      if (ev.moveSlot === 'signature') clicks(c, pan, t + 0.1, 6, 0.09, 0.05);
    },
    onRelease(c, t, ev) {
      const pan = c.panOf(ev.x);
      // the sail snaps taut, wet
      noiseHit(c, makeOut(c, pan, 0.3), t, {
        dur: 0.22,
        gain: 0.12,
        kind: 'brown',
        filter: { type: 'lowpass', f0: 520, f1: 140, q: 1.1 },
        attack: 0.01,
      });
    },
    onSurge(c, t, ev) {
      // the membrane fills: tension, then fluid moving
      const pan = c.panOf(ev.x);
      scrape(c, makeOut(c, pan, 0.4), t, { dur: 0.5, f0: 140, f1: 220, gain: 0.06, rate: 6, kind: 'brown' });
      bubbles(c, makeOut(c, pan, 0.5), t + 0.1, { dur: 0.5, count: 5, f: 150, gain: 0.05 });
    },
    onHitDealt(c, t, ev, mag) {
      const pan = c.panOf(ev.x);
      // a wet, heavy thud; cartilage gives under it; something shifts inside
      boom(c, makeOut(c, pan, 0.15), t, {
        f0: 70 - 20 * mag,
        f1: 26,
        dur: 0.35 + 0.5 * mag,
        gain: 0.26 + 0.34 * mag,
        drive: 1.6,
      });
      crackle(c, makeOut(c, pan, 0.25), t + 0.02, {
        dur: 0.2 + 0.3 * mag,
        count: Math.round(4 + 10 * mag),
        gain: 0.08,
        f: 800,
      });
      bubbles(c, makeOut(c, pan, 0.5), t + 0.08, { dur: 0.4, count: 3, f: 180, gain: 0.04 * (0.5 + mag) });
    },
    onHitTaken(c, t, ev, mag) {
      const pan = c.panOf(ev.x);
      // a slap on stretched wet tissue, and the gristle under it cracks
      noiseHit(c, makeOut(c, pan, 0.35), t, {
        dur: 0.14 + 0.18 * mag,
        gain: 0.16 + 0.14 * mag,
        kind: 'brown',
        filter: { type: 'lowpass', f0: 700, f1: 160, q: 1.4 },
      });
      if (mag > 0.4) crackle(c, makeOut(c, pan, 0.3), t + 0.03, { dur: 0.3, count: 8, gain: 0.07, f: 700 });
    },
    onUltimate(c, t, ev) {
      const pan = c.panOf(ev.x);
      // FALSE BIRTH: the whale pulse under everything, the clicks quicken, the membrane spreads with a long creak
      whale(c, pan, t, 4, 0.32);
      clicks(c, pan, t + 0.2, 14, 0.11, 0.06);
      scrape(c, makeOut(c, pan, 0.5), t, { dur: 1.1, f0: 110, f1: 240, gain: 0.08, rate: 5, kind: 'brown' });
    },
    onCue(c, t, ev) {
      const pan = c.panOf(0);
      switch (ev.id) {
        case 'cord-strain':
          // the cord's root creaks on its last fibres
          scrape(c, makeOut(c, pan, 0.3), t, {
            dur: 0.7,
            f0: 160,
            f1: 90,
            gain: 0.08,
            rate: 11,
            kind: 'brown',
          });
          crackle(c, makeOut(c, pan, 0.3), t, { dur: 0.6, count: 10, gain: 0.07, f: 650 });
          break;
        case 'cord-sever':
          // it parts: a tearing rush, a deep drop, then fluid
          rumble(c, makeOut(c, pan, 0.4), t, { dur: 1.1, gain: 0.22, f0: 520, f1: 70 });
          boom(c, makeOut(c, pan, 0.1), t, { f0: 52, f1: 22, dur: 1, gain: 0.45, drive: 2 });
          bubbles(c, makeOut(c, pan, 0.6), t + 0.25, { dur: 1, count: 9, f: 140, gain: 0.06 });
          break;
        case 'cord-regrow':
          // gristle forming: dry, then a wet settle
          crackle(c, makeOut(c, pan, 0.35), t, { dur: 0.45, count: 12, gain: 0.05, f: 900 });
          break;
        case 'false-birth':
          // the membrane throws open: a huge contraction released, a wet burst, something expelled
          contraction(c, pan, t, 1.4);
          boom(c, makeOut(c, pan, 0.2), t + 0.05, { f0: 46, f1: 20, dur: 1.4, gain: 0.55, drive: 2.4 });
          noiseHit(c, makeOut(c, pan, 0.5), t + 0.05, {
            dur: 0.7,
            gain: 0.2,
            kind: 'brown',
            filter: { type: 'lowpass', f0: 900, f1: 120, q: 1 },
          });
          bubbles(c, makeOut(c, pan, 0.6), t + 0.3, { dur: 1.2, count: 12, f: 130, gain: 0.06 });
          break;
        case 'wrong-growth':
          // differentiation failure: cartilage cracking under pressure, and a click train that falters
          crackle(c, makeOut(c, pan, 0.35), t, { dur: 0.5, count: 9, gain: 0.05, f: 750 });
          clicks(c, pan, t + 0.1, 4, 0.17, 0.04);
          break;
        default:
          break;
      }
    },
    onKo(c, t, ev) {
      const pan = c.panOf(ev.x);
      // not a death cry: the whale pulse slows and stops, the fluid drains
      whale(c, pan, t, 3, 0.4);
      rumble(c, makeOut(c, pan, 0.5), t, { dur: 2.6, gain: 0.3, f0: 380, f1: 50 });
      bubbles(c, makeOut(c, pan, 0.6), t + 0.5, { dur: 2, count: 14, f: 110, gain: 0.05 });
    },
  };
}
