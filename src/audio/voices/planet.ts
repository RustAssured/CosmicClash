import { clamp, clamp01 } from '../dsp/math';
import { cueKind } from './cues';
import { bubbles, createBed, lfoInto, noiseBand, scrape, silentGain, subOut, type Bed } from './kit';
import {
  BELL,
  envelope,
  gravel,
  makeOut,
  noiseHit,
  partials,
  riser,
  thump,
  tone,
  whistlePass,
  type Out,
} from './synth';
import type { TitanVoice, VoiceCtx } from './types';
import { atmosphericTear, magmaVent, resonance, subPressure, tectonicCrack } from './materials';

/**
 * THE PLANET: tectonic rumble and wind. Slow, vast, low. The body is rock under an atmosphere, so the sound is the ground
 * grinding, crust groaning under strain, and air moving over it; a moon slam is a huge low impact with a bell-like orbital ring
 * that outlasts it; boiling oceans hiss and bubble; a stripped atmosphere is wind fading away for good.
 *
 * The bed is continuous: a brown-noise tremor that grinds on a slow cycle, three layers of wind (low, mid, high) drifting
 * independently, and now and then a crust groan. Wind is the atmosphere: `atmosphere stripped` cues wear it down for the rest
 * of the fight.
 */
interface Ground {
  bed: Bed;
  rumble: GainNode;
  grind: GainNode;
  winds: { gain: GainNode; band: BiquadFilterNode; base: number; weight: number }[];
  /** How far the slow LFOs swing the rumble and the grind (a fraction of their level). */
  rumbleSwing: GainNode;
  grindSwing: GainNode;
  /** Crust groans go through this low-pass into the bed. */
  groan: Out;
}

export function createPlanetVoice(): TitanVoice {
  const grounds = new Map<number, Ground>();
  /** 0 = full atmosphere, 1 = stripped bare, per fighter slot. */
  const stripped: [number, number] = [0, 0];
  /** Remaining mass per slot (from the continuous scene): damage changes how the world rings. */
  const massBy: [number, number] = [1, 1];

  /** Crust under strain: a low saw that sags in pitch with a slow tremble, closed down by a low-pass. */
  const groan = (c: VoiceCtx, t: number, o: Out, dur: number, gain: number, f = 58): void => {
    const ac = c.ac;
    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.exponentialRampToValueAtTime(f * 0.66, t + dur);
    const vib = ac.createOscillator();
    vib.frequency.value = 4.5 + 2 * c.rand();
    const vg = ac.createGain();
    vg.gain.value = f * 0.02;
    vib.connect(vg);
    vg.connect(osc.frequency);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 230;
    lp.Q.value = 2.2;
    const env = ac.createGain();
    envelope(env, t, gain, dur * 0.35, dur);
    osc.connect(lp);
    lp.connect(env);
    env.connect(o.input);
    osc.start(t);
    osc.stop(t + dur + 0.05);
    vib.start(t);
    vib.stop(t + dur + 0.05);
  };

  /** The ground taking a blow: a long sub drop, a low rock crunch and a rumble that lingers. */
  const impact = (c: VoiceCtx, t: number, pan: number, mag: number, wet = 0.5, level = 1): void => {
    const o = makeOut(c, pan, wet);
    thump(c, subOut(c, pan), t, 52 - 10 * mag, 20, 0.7 + 1.4 * mag, (0.34 + 0.3 * mag) * level);
    gravel(c, o, t + 0.006, {
      dur: 0.35 + 0.5 * mag,
      grains: 14 + Math.round(24 * mag),
      f: 300,
      spread: 2.2,
      gain: (0.13 + 0.08 * mag) * level,
      q: 0.9,
      lowpass: 700,
    });
    noiseHit(c, o, t, {
      dur: 0.5 + 0.9 * mag,
      gain: 0.14 * level,
      filter: { type: 'lowpass', f0: 380, f1: 50, q: 1 },
      kind: 'brown',
      attack: 0.01,
    });
  };

  /** A sharp crack through the crust: bright rock snap and a groan leaning down after it. */
  const crack = (c: VoiceCtx, t: number, pan: number, mag: number, level = 1): void => {
    const o = makeOut(c, pan, 0.4);
    noiseHit(c, o, t, {
      dur: 0.05,
      gain: 0.2 * level,
      filter: { type: 'highpass', f0: 1800 },
      attack: 0.0005,
    });
    gravel(c, o, t, { dur: 0.3, grains: 10, f: 1100, spread: 2.6, gain: 0.14 * level, q: 1.4 });
    groan(c, t + 0.03, o, 0.6 + 0.6 * mag, (0.05 + 0.04 * mag) * level, 78);
  };

  /** Wind over the atmosphere: a swept band with a slow flutter; `dir` mirrors the sweep. */
  const gust = (
    c: VoiceCtx,
    t: number,
    pan: number,
    dur: number,
    gain: number,
    f0 = 260,
    f1 = 1100,
    q = 0.8,
  ): void => {
    scrape(c, makeOut(c, pan, 0.4), t, { dur, f0, f1, q, gain, rate: 3.5, depth: 0.5, attack: dur * 0.4 });
  };

  /** A moon's orbital ring: a big bronze bell tone that sags a little and outlasts the impact that rang it. */
  const orbit = (c: VoiceCtx, t: number, pan: number, hz: number, mag: number): void => {
    partials(c, makeOut(c, pan * 0.5, 0.75), t, hz, BELL, {
      decay: 1.6 + 1.8 * mag,
      gain: 0.08 + 0.05 * mag,
      attack: 0.004,
      shimmer: 0.2,
      maxHz: 6000,
    });
  };

  /** Boiling water: a hiss with bubbles breaking through it. */
  const boil = (c: VoiceCtx, t: number, pan: number, dur: number, amount: number, level = 1): void => {
    const o = makeOut(c, pan, 0.4);
    noiseHit(c, o, t, {
      dur,
      gain: (0.07 + 0.05 * amount) * level,
      filter: { type: 'highpass', f0: 4200, q: 0.6 },
      attack: dur * 0.25,
    });
    bubbles(c, o, t, { dur, count: Math.round(10 + 22 * amount), f: 420, gain: 0.05 * level });
  };

  return {
    titan: 'planet',

    onMove(c, t, ev) {
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan * 0.5, 0.4);
      switch (ev.moveSlot) {
        case 'strike':
          gust(c, t, pan, 0.25, 0.38, 260, 1100, 0.5);
          break;
        case 'crush':
          // gravity compressing: a groan rising in strain and the PRESSURE building under it
          groan(c, t, o, 0.6, 0.08, 62);
          subPressure(c, t, pan, 0.6, 0.14);
          break;
        case 'signature':
          // the moon is slung: a swirl of air and a low bell note as it leaves
          whistlePass(c, t, {
            f: 240,
            dur: 0.5,
            gain: 0.12,
            panFrom: pan,
            panTo: clamp(-pan, -1, 1),
            wet: 0.5,
            approach: 1.3,
            recede: 0.8,
          });
          break;
        case 'ultimate':
          noiseHit(c, o, t, {
            dur: 1.2,
            gain: 0.45,
            filter: { type: 'lowpass', f0: 90, f1: 500, q: 0.8 },
            kind: 'brown',
            attack: 0.8,
          });
          break;
        case 'guard':
        case 'surge':
          break;
      }
    },

    onRelease(c, t, ev) {
      const pan = c.panOf(ev.x);
      const p = clamp01(ev.power);
      if (ev.moveSlot === 'crush') {
        impact(c, t, pan, 0.85 + 0.15 * p, 0.6, 0.8);
        crack(c, t + 0.02, pan, 0.8, 0.7);
      } else if (ev.moveSlot === 'signature' || /moon/i.test(ev.moveId)) {
        // moon slam: a huge low impact, and the ring of it
        impact(c, t, pan, 1, 0.7, 0.7);
        orbit(c, t + 0.01, pan, 96, 0.8);
      } else {
        impact(c, t, pan, 0.35 + 0.3 * p, 0.4);
      }
    },

    onSurge(c, t, ev) {
      // drifting through its own atmosphere: a broad wind whoosh and a sway in the sub
      const pan = c.panOf(ev.x);
      const dir = Math.sign(ev.dirX || 1);
      whistlePass(c, t, {
        f: 180,
        dur: 0.7,
        gain: 0.05,
        panFrom: clamp(pan - 0.5 * dir, -1, 1),
        panTo: clamp(pan + 0.5 * dir, -1, 1),
        wet: 0.5,
        approach: 1.25,
        recede: 0.8,
      });
      gust(c, t, pan, 0.75, 0.13, 220, 900);
      tone(c, makeOut(c, pan * 0.3, 0), t, { f0: 48, f1: 36, dur: 0.7, gain: 0.1, attack: 0.15 });
    },

    onHitDealt(c, t, ev, mag) {
      const pan = c.panOf(ev.x);
      if (ev.type === 'CRUSH' || ev.heavy)
        thump(c, subOut(c, pan), t + 0.01, 40, 18, 0.9 + 0.8 * mag, 0.2 + 0.2 * mag);
      else
        gravel(c, makeOut(c, pan, 0.3), t + 0.01, {
          dur: 0.25,
          grains: 8 + Math.round(8 * mag),
          f: 500,
          spread: 2.2,
          gain: 0.1,
        });
    },

    onHitTaken(c, t, ev, mag) {
      // the body is rock under air: a dull tectonic thud that rumbles on; a blocked blow is only the atmosphere hissing
      const pan = c.panOf(ev.x);
      const open = 1 - clamp01(ev.blocked) * 0.75;
      impact(c, t, pan, mag * open, 0.45);
      const res = resonance(massBy[ev.target], ev.onDamaged);
      if (ev.onDamaged > 0.3 || mag > 0.7) tectonicCrack(c, makeOut(c, pan, 0.45), t + 0.02, mag * open, res);
      // a hollowed world rings like a drum: a cavity mode in the 100–200 Hz band, longer and lower the more is gone
      if (res.hollow > 0.25 && open > 0.5)
        noiseHit(c, makeOut(c, pan, 0.5), t + 0.01, {
          dur: 0.4 * res.decay,
          gain: 0.12 * res.hollow * mag,
          kind: 'brown',
          filter: { type: 'bandpass', f0: 190 * res.pitch, f1: 120 * res.pitch, q: 6 },
          attack: 0.004,
        });
      if (ev.blocked > 0.3)
        noiseHit(c, makeOut(c, pan, 0.4), t, {
          dur: 0.4,
          gain: 0.08 * ev.blocked,
          filter: { type: 'bandpass', f0: 900, f1: 300, q: 0.7 },
          attack: 0.02,
        });
    },

    onGuard(c, t, ev) {
      // the atmosphere takes it: a swell of wind, a low thud; when it breaks, the crust cracks
      const pan = c.panOf(ev.x);
      gust(c, t, pan, ev.broke ? 0.9 : 0.5, ev.broke ? 0.16 : 0.1, 400, 1400);
      thump(c, subOut(c, pan), t, 90, 40, ev.broke ? 0.8 : 0.35, ev.broke ? 0.6 : 0.3);
      if (ev.broke) crack(c, t + 0.05, pan, 1);
    },

    onKo(c, t, ev) {
      // the world comes apart: a long sub drop, crust groans, a landslide of rock, magma breaking out and the air torn away
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan * 0.4, 0.85);
      tectonicCrack(c, o, t, 1, resonance(massBy[ev.slot], 1));
      magmaVent(c, o, t + 0.3, 2.2, 1);
      atmosphericTear(c, o, t + 0.6, 1);
      thump(c, subOut(c, pan), t, 50, 16, 3.0, 0.55);
      for (let i = 0; i < 4; i++) groan(c, t + 0.1 + i * 0.55, o, 1.6, 0.06, 72 - 8 * i);
      gravel(c, o, t + 0.05, {
        dur: 2.6,
        grains: 80,
        f: 260,
        spread: 2.6,
        gain: 0.16,
        q: 0.9,
        decayShape: 1.1,
        lowpass: 500,
      });
      noiseHit(c, o, t, {
        dur: 3,
        gain: 0.12,
        filter: { type: 'lowpass', f0: 600, f1: 50, q: 0.8 },
        kind: 'brown',
        attack: 0.02,
      });
      noiseHit(c, o, t, {
        dur: 2.6,
        gain: 0.07,
        filter: { type: 'bandpass', f0: 600, f1: 150, q: 0.6 },
        attack: 0.2,
      });
    },

    onUltimate(c, t, ev) {
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan * 0.3, 0.8);
      if (ev.phase === 'start') {
        // cataclysm: the ground swells, the wind rises to a howl, the crust groans, then it all lands at once
        noiseHit(c, o, t, {
          dur: 2.4,
          gain: 0.2,
          filter: { type: 'lowpass', f0: 60, f1: 520, q: 0.9 },
          kind: 'brown',
          attack: 2,
        });
        scrape(c, o, t, {
          dur: 2.4,
          f0: 250,
          f1: 1500,
          q: 0.9,
          gain: 0.14,
          rate: 4.5,
          depth: 0.6,
          attack: 1.8,
        });
        for (let i = 0; i < 3; i++) groan(c, t + 0.2 + i * 0.6, o, 1.5, 0.06, 64 + 6 * i);
        riser(c, o, t, 2.4, 0.06, 200, 2400);
        impact(c, t + 2.4, 0, 1, 0.9);
        orbit(c, t + 2.4, 0, 82, 1);
      } else {
        gust(c, t, pan, 1.6, 0.1, 900, 200);
      }
    },

    onMatter(c, t, ev) {
      const pan = c.panOf(ev.x);
      const m = clamp01(Math.log10(Math.max(1, ev.mass)) / 3);
      switch (ev.kind) {
        case 'boil':
          boil(c, t, pan, 0.9, m, 1.8);
          return true;
        case 'evaporate':
          noiseHit(c, makeOut(c, pan, 0.4), t, {
            dur: 1.0,
            gain: 0.09,
            filter: { type: 'highpass', f0: 3800, q: 0.6 },
            attack: 0.2,
          });
          return true;
        case 'crack':
          crack(c, t, pan, 0.3 + 0.5 * m, 2);
          return true;
        case 'detach':
          gravel(c, makeOut(c, pan, 0.3), t, { dur: 0.35, grains: 12, f: 480, spread: 2.4, gain: 0.14 });
          thump(c, subOut(c, pan), t, 60, 26, 0.4, 0.2 + 0.2 * m);
          return true;
        case 'impact':
          impact(c, t, pan, 0.3 + 0.5 * m, 0.4);
          return true;
        default:
          return false;
      }
    },

    onCue(c, t, ev) {
      const pan = c.panOf(ev.x);
      const a = clamp01(ev.amount);
      const o = makeOut(c, pan, 0.5);
      const res = resonance(massBy[ev.slot]);
      // the slice Planet's own ids (proposal 134 §2) first, then the keyword fallback
      switch (ev.id) {
        case 'world-phase-2':
        case 'world-phase-3':
        case 'world-phase-4':
          // the world gives a stage further: the crust cracks, pressure builds, and from phase 4 the magma shows
          tectonicCrack(c, o, t, 0.5 + 0.5 * a, res);
          subPressure(c, t, pan, 0.9, 0.1 + 0.08 * a);
          if (ev.id === 'world-phase-4') magmaVent(c, o, t + 0.25, 1.6, 0.8);
          return;
        case 'moon-shatter':
          impact(c, t, pan, 0.9, 0.6, 0.7);
          orbit(c, t + 0.01, pan, 150, 0.6);
          gravel(c, o, t + 0.02, { dur: 0.9, grains: 34, f: 1400, spread: 2.4, gain: 0.14, q: 1.4 });
          return;
        case 'comet-call':
          // the gravity reaches out: pressure, and a far bell answering
          subPressure(c, t, pan, 0.8, 0.09);
          orbit(c, t + 0.3, pan, 196, 0.4);
          return;
        case 'comet-capture':
          orbit(c, t, pan, 147, 0.7);
          gust(c, t, pan, 0.8, 0.3, 300, 900);
          return;
        case 'comet-sling':
          whistlePass(c, t, {
            f: 260 + 300 * a,
            dur: 0.7,
            gain: 0.12,
            panFrom: pan,
            panTo: clamp(-pan, -1, 1),
            wet: 0.5,
            approach: 1.4,
            recede: 0.7,
          });
          atmosphericTear(c, o, t, 0.4 + 0.6 * a);
          return;
        case 'comet-impact':
          impact(c, t, pan, 1, 0.7, 0.9);
          tectonicCrack(c, o, t + 0.02, 0.9, res);
          return;
        case 'crust-armor':
          // the crust grows back over the wound: a slow grinding of rock knitting together
          gravel(c, o, t, {
            dur: 0.8,
            grains: 18 + Math.round(20 * a),
            f: 260,
            spread: 1.8,
            gain: 0.1,
            q: 1,
            lowpass: 700,
          });
          groan(c, t, o, 0.8, 0.05, 70);
          return;
        case 'core-pulse':
          subPressure(c, t, pan, 0.5, 0.18);
          magmaVent(c, o, t + 0.1, 0.9, 0.7);
          return;
        case 'atmo-vent':
          // failure 1/4: the atmosphere vents away
          atmosphericTear(c, o, t, 1);
          gust(c, t, pan, 2.2, 0.6, 1500, 200, 0.45);
          return;
        case 'moons-drift':
          // failure 2/4: the moons' bells ring once more, lower, and recede
          orbit(c, t, pan, 98, 0.9);
          orbit(c, t + 0.5, pan, 73, 0.7);
          return;
        case 'crust-slab':
          // failure 3/4: the crust comes away in slabs
          tectonicCrack(c, o, t, 1, resonance(0.3, 1));
          gravel(c, o, t + 0.1, {
            dur: 1.4,
            grains: 50,
            f: 300,
            spread: 2.4,
            gain: 0.16,
            q: 0.9,
            lowpass: 600,
          });
          return;
        case 'core-out':
          // failure 4/4: the core goes out — the pressure falls away to nothing
          thump(c, subOut(c, pan), t, 70, 18, 2.6, 0.5);
          magmaVent(c, o, t, 2.4, 0.3);
          return;
        default:
          break;
      }
      switch (cueKind(ev.id)) {
        case 'lost': {
          // a moon knocked out of orbit: the bell rings, sags and recedes, over a low boom
          orbit(c, t, pan, 110, 0.8);
          tone(c, makeOut(c, pan, 0.6), t, { f0: 220, f1: 130, dur: 1.6, gain: 0.04, attack: 0.01 });
          thump(c, subOut(c, pan), t, 60, 24, 0.7, 0.3);
          return;
        }
        case 'strip': {
          // atmosphere torn away: a rush of wind that does not come back
          stripped[ev.slot] = clamp01(stripped[ev.slot] + 0.3 + 0.3 * a);
          gust(c, t, pan, 1.6, 0.85, 1400, 250, 0.45);
          atmosphericTear(c, makeOut(c, pan, 0.5), t, a);
          return;
        }
        case 'boil':
          boil(c, t, pan, 1.1, a, 2.8);
          return;
        case 'vent':
          magmaVent(c, makeOut(c, pan, 0.5), t, 1.4, a);
          return;
        case 'break':
        case 'crack':
        case 'collapse':
          tectonicCrack(c, makeOut(c, pan, 0.45), t, 0.6 + 0.4 * a, resonance(massBy[ev.slot]));
          impact(c, t + 0.05, pan, 0.4 + 0.3 * a, 0.5);
          return;
        case 'shed':
          gravel(c, makeOut(c, pan, 0.4), t, { dur: 0.8, grains: 30, f: 460, spread: 2.6, gain: 0.16 });
          return;
        default:
          orbit(c, t, pan, 130, 0.9 + 0.1 * a);
      }
    },

    update(c, scene, slot, dt) {
      massBy[slot] = scene.massFrac;
      const ac = c.ac;
      let g = grounds.get(slot);
      if (!g) {
        const bed = createBed(c, 0.35);
        // the tremor of the ground, grinding on a slow cycle and shivering a little faster on top
        const rumble = silentGain(c, bed.input);
        noiseBand(c, bed, rumble, { kind: 'brown', type: 'lowpass', f: 85, q: 0.9 });
        const rumbleSwing = lfoInto(c, bed, rumble.gain, 0.21, 0).depth;
        const grind = silentGain(c, bed.input);
        noiseBand(c, bed, grind, { kind: 'brown', type: 'bandpass', f: 160, q: 2.5 });
        const grindSwing = lfoInto(c, bed, grind.gain, 6.5, 0, 'triangle').depth;
        // three layers of wind, each drifting on its own slow cycle
        const winds: Ground['winds'] = [];
        for (const [base, q, weight, rate] of [
          [230, 0.8, 1, 0.07],
          [640, 0.7, 0.7, 0.11],
          [1700, 0.8, 0.4, 0.05],
        ] as const) {
          const gain = silentGain(c, bed.input);
          const { filter: band } = noiseBand(c, bed, gain, { kind: 'white', type: 'bandpass', f: base, q });
          lfoInto(c, bed, band.frequency, rate, base * 0.3);
          winds.push({ gain, band, base, weight });
        }
        const lp = ac.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 260;
        lp.connect(bed.input);
        g = {
          bed,
          rumble,
          grind,
          winds,
          rumbleSwing,
          grindSwing,
          groan: { input: lp, close: () => undefined },
        };
        grounds.set(slot, g);
      }
      const now = ac.currentTime;
      const mass = clamp(scene.massFrac, 0.2, 1.3);
      const move = clamp01(scene.speed / 500);
      const air = 1 - stripped[slot];
      const rumble = 0.045 + 0.03 * mass;
      const grind = 0.01 + 0.014 * move;
      g.rumble.gain.setTargetAtTime(rumble, now, 0.4);
      g.rumbleSwing.gain.setTargetAtTime(rumble * 0.4, now, 0.4);
      g.grind.gain.setTargetAtTime(grind, now, 0.4);
      g.grindSwing.gain.setTargetAtTime(grind * 0.5, now, 0.4);
      // (band-passed noise carries only a few percent of the noise power: the wind needs a big gain to be heard at all)
      for (const w of g.winds) w.gain.gain.setTargetAtTime((0.06 + 0.04 * move) * w.weight * air, now, 0.5);
      g.bed.pan.pan.setTargetAtTime(clamp(c.panOf(scene.x), -1, 1), now, 0.1);
      // a crust groan every four seconds or so, more often the more of the planet is gone
      if (c.rand() < (0.14 + 0.3 * (1 - clamp01(mass))) * dt)
        groan(c, now + 0.01, g.groan, 1.3 + 0.9 * c.rand(), 0.05, 50 + 20 * c.rand());
    },

    stop(slot) {
      for (const s of slot === 'all' ? [...grounds.keys()] : [slot]) {
        grounds.get(s)?.bed.dispose();
        grounds.delete(s);
      }
      if (slot === 'all') {
        stripped[0] = 0;
        stripped[1] = 0;
      } else stripped[slot] = 0;
    },
  };
}
