import { clamp, clamp01 } from '../dsp/math';
import { fourierCoefficients, heartbeatWave } from '../dsp/waves';
import { cueKind } from './cues';
import { createBed, noiseBand, silentGain, subOut, type Bed } from './kit';
import { CHAIN, makeOut, noiseHit, pick } from './synth';
import type { TitanVoice, VoiceCtx } from './types';
import { boom, catastrophe, grind, lowBell, roar, rumble, saturator, swell, whoosh } from './epic';

/**
 * THE NEXUS: a crimson graph of nodes and hardened chains around a crystalline hub. Metal, machinery and a slow pulse.
 *
 * D34 scaled every link up to the size of a moon's orbit: a chain link is a colossal hollow ring (`CHAIN` modes on 69–139 Hz,
 * none above ~1.6 kHz) with a dark knock, a drag is a band of grinding metal under 1.2 kHz chopped by a slow ratchet (clunks, not
 * clicks), a latch is a bolt the size of a tower seating home, a snap is a cable crack and a drop, and a node going dark is a bell
 * tolling DOWN. Under everything a 43–55 Hz heartbeat throbs (saturated, so a laptop hears it), faster the more of the graph is
 * alive (`resource`). The chain whips (2.2 kHz cracks), 0.9–3.4 kHz drags, 3.3 kHz rattle and the 880 Hz Doppler streak are gone.
 *
 * Tuning: the rings sit on a minor-ish cluster (C♯ E G A♯ C♯) so overlapping clanks are dark but never harsh.
 */
const NODES = [69.3, 82.41, 98, 116.54, 138.59];

interface Pulse {
  bed: Bed;
  sub: OscillatorNode;
  lfo: OscillatorNode;
  beat: GainNode;
  beatDepth: GainNode;
  hum: GainNode;
  rattle: GainNode;
}

/** One pulse period: lub at 0, dub at 0.3; band-limited to 48 harmonics (at 2.5 Hz that is 120 Hz, far above the carrier). */
const HEART = ((): { real: Float32Array; imag: Float32Array } =>
  fourierCoefficients(heartbeatWave(512, 0.3, 0.6), 48))();

export function createNexusVoice(): TitanVoice {
  const pulses = new Map<number, Pulse>();

  /** A colossal chain link struck: a hollow ring and a dark knock. Heavier blows ring longer and lower. */
  const clank = (
    c: VoiceCtx,
    t: number,
    pan: number,
    hz: number,
    mag: number,
    open: number,
    wet = 0.35,
    level = 1,
  ): void => {
    const o = makeOut(c, pan, wet);
    lowBell(c, o, t, hz, CHAIN, {
      decay: 0.3 + 0.9 * mag,
      gain: (0.08 + 0.1 * mag) * open * level,
    });
    noiseHit(c, o, t, {
      dur: 0.07,
      gain: 0.4 * open * level,
      filter: { type: 'bandpass', f0: 700, q: 1.1 },
      filter2: { type: 'lowpass', f0: 1600 },
      attack: 0.0008,
    });
    // the metal grinding against itself as the ring dies
    grind(c, o, t + 0.01, {
      dur: 0.2 + 0.4 * mag,
      gain: 0.1 * open * level,
      f0: 600,
      f1: 300,
      rate: 14,
      metal: true,
      attack: 0.01,
    });
  };

  /** A chain the size of an orbit snapping: a dark crack, a drop and a ring that sags. */
  const snap = (c: VoiceCtx, t: number, pan: number, amount = 1): void => {
    const o = makeOut(c, pan, 0.45);
    noiseHit(c, o, t, {
      dur: 0.06,
      gain: 0.22 * amount,
      filter: { type: 'bandpass', f0: 1000, f1: 300, q: 1 },
      filter2: { type: 'lowpass', f0: 1800 },
      attack: 0.0006,
    });
    boom(c, subOut(c, pan), t, { f0: 110, f1: 36, dur: 0.5, gain: 0.18 * Math.min(2, amount) });
    lowBell(c, o, t + 0.004, pick(c, NODES) * 1.5, CHAIN, { decay: 0.8, gain: 0.08 * Math.min(2, amount) });
  };

  /** The latch: a bolt the size of a tower seating home — a clunk, a drop, three slow ratchet clunks. */
  const lock = (c: VoiceCtx, t: number, pan: number, mag: number, level = 1): void => {
    const o = makeOut(c, pan, 0.3);
    clank(c, t, pan, NODES[1]!, 0.4, 1, 0.3, 0.8 * level);
    boom(c, subOut(c, pan), t + 0.045, {
      f0: 120,
      f1: 52,
      dur: 0.25,
      gain: (0.2 + 0.14 * mag) * level,
      drive: 2.6,
    });
    grind(c, o, t + 0.09, {
      dur: 0.22,
      gain: 0.12 * level,
      f0: 380,
      f1: 260,
      rate: 13,
      metal: true,
      attack: 0.01,
    });
  };

  /** Harvesting: machinery tearing matter in — a grinding haul that speeds up, and a low rip. */
  const harvest = (c: VoiceCtx, t: number, pan: number, amount: number, level = 1): void => {
    const o = makeOut(c, pan, 0.4);
    grind(c, o, t, {
      dur: 0.5 + 0.2 * amount,
      gain: 0.2 * level,
      f0: 180,
      f1: 520,
      rate: 9 + 8 * amount,
      metal: true,
      attack: 0.03,
    });
    noiseHit(c, o, t + 0.02, {
      dur: 0.5,
      gain: 0.3 * level,
      filter: { type: 'lowpass', f0: 700, f1: 140, q: 0.8 },
      kind: 'brown',
      attack: 0.05,
    });
  };

  return {
    titan: 'nexus',

    onMove(c, t, ev) {
      const pan = c.panOf(ev.x);
      switch (ev.moveSlot) {
        case 'strike': {
          // a chain hauled back for the throw: a heavy drag
          const o = makeOut(c, pan, 0.3);
          grind(c, o, t, { dur: 0.24, gain: 0.3, f0: 220, f1: 480, rate: 16, metal: true, attack: 0.06 });
          swell(c, o, t, { dur: 0.24, gain: 0.12, f0: 120, f1: 600 });
          break;
        }
        case 'crush': {
          // heavy chain hauled tight: a low drag, a groaning tension under it
          const o = makeOut(c, pan, 0.45);
          grind(c, o, t, { dur: 0.55, gain: 0.4, f0: 140, f1: 300, rate: 8, metal: true, attack: 0.25 });
          roar(c, o, t, { f: 46, f1: 55, dur: 0.6, gain: 0.14, attack: 0.3, lp0: 180, lp1: 520, noise: 0 });
          break;
        }
        case 'signature': {
          // chains latching: a ratchet of clunks that speeds up as the trap is set
          grind(c, makeOut(c, pan, 0.3), t, {
            dur: 0.45,
            gain: 0.16,
            f0: 300,
            f1: 420,
            rate: 8,
            metal: true,
            attack: 0.02,
          });
          swell(c, makeOut(c, pan, 0.3), t, { dur: 0.45, gain: 0.16, f0: 100, f1: 500 });
          break;
        }
        case 'ultimate': {
          // the shell begins to form: links tolling inward
          const o = makeOut(c, pan * 0.3, 0.6);
          for (let i = 0; i < 4; i++)
            lowBell(c, o, t + i * 0.12, NODES[i % NODES.length]!, CHAIN, { decay: 0.8, gain: 0.05 });
          break;
        }
        case 'guard':
        case 'surge':
          break; // their own events carry the sound
      }
    },

    onRelease(c, t, ev) {
      const pan = c.panOf(ev.x);
      const p = clamp01(ev.power);
      if (ev.moveSlot === 'crush') {
        clank(c, t, pan, NODES[0]!, 1, 1, 0.5);
        boom(c, subOut(c, pan), t, { f0: 92, f1: 30, dur: 0.8, gain: 0.45 + 0.2 * p, drive: 2.8 });
      } else if (ev.moveSlot === 'signature') {
        lock(c, t, pan, p, 1.3);
      } else {
        whoosh(c, t, {
          dur: 0.22,
          gain: 0.18,
          panFrom: clamp(pan - 0.3, -1, 1),
          panTo: clamp(pan + 0.3, -1, 1),
          wet: 0.3,
          f0: 900,
          f1: 200,
        });
        clank(c, t + 0.01, pan, pick(c, NODES) * 1.5, 0.35 + 0.3 * p, 1, 0.3, 1.2);
      }
    },

    onSurge(c, t, ev) {
      // chains reeling the body along: the haul and the air it drags (it was an 880 Hz Doppler streak)
      const pan = c.panOf(ev.x);
      const dir = Math.sign(ev.dirX || 1);
      whoosh(c, t, {
        dur: 0.45,
        gain: 0.2,
        panFrom: clamp(pan - 0.5 * dir, -1, 1),
        panTo: clamp(pan + 0.5 * dir, -1, 1),
        wet: 0.3,
        f0: 700,
        f1: 140,
      });
      grind(c, makeOut(c, pan, 0.2), t, {
        dur: 0.4,
        gain: 0.1,
        f0: 380,
        f1: 200,
        rate: 12,
        metal: true,
        attack: 0.05,
      });
    },

    onHitDealt(c, t, ev, mag) {
      const pan = c.panOf(ev.x);
      if (ev.type === 'ASSIMILATION') lock(c, t, pan, mag, 0.75);
      else clank(c, t, pan, pick(c, NODES) * 2, 0.2 + 0.4 * mag, 1 - clamp01(ev.blocked) * 0.6, 0.3);
    },

    onHitTaken(c, t, ev, mag) {
      // the body is metal and chain: it CLANKS, the harder the lower and longer; a blocked blow is a dull thunk
      const pan = c.panOf(ev.x);
      const open = 1 - clamp01(ev.blocked) * 0.75;
      clank(c, t, pan, pick(c, NODES) * (1.6 - 0.6 * mag), mag, open, 0.45);
      if (ev.onDamaged > 0.3) snap(c, t + 0.02, pan, 0.6 * open);
    },

    onGuard(c, t, ev) {
      const pan = c.panOf(ev.x);
      clank(c, t, pan, NODES[1]!, ev.broke ? 1 : 0.5, 1, 0.45);
      boom(c, subOut(c, pan), t, {
        f0: 100,
        f1: 44,
        dur: ev.broke ? 0.8 : 0.35,
        gain: ev.broke ? 0.55 : 0.3,
      });
      if (ev.broke)
        for (let i = 0; i < 4; i++) snap(c, t + 0.06 + i * 0.11, pan + (c.rand() - 0.5) * 0.4, 0.5);
    },

    onKo(c, t, ev) {
      // the graph comes apart: the hush, the drop, then link after link letting go, each toll lower and lonelier
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan, 0.75);
      const at = catastrophe(c, subOut(c, pan), o, t, { size: 1, f0: 58 });
      for (let i = 0; i < 9; i++) {
        const when = at + 0.1 + i * (0.12 + 0.03 * i);
        lowBell(c, o, when, pick(c, NODES) * Math.pow(0.94, i) * 1.5, CHAIN, {
          decay: 0.9 + 0.1 * i,
          gain: 0.06 * (1 - i / 14),
        });
      }
      grind(c, o, at, { dur: 2.4, gain: 0.1, f0: 400, f1: 90, rate: 6, metal: true, attack: 0.05 });
    },

    onUltimate(c, t, ev) {
      const pan = c.panOf(ev.x);
      const o = makeOut(c, pan * 0.3, 0.7);
      if (ev.phase === 'start') {
        // the shell closes: links tolling inward faster and faster, the machinery hauling, then the crush
        let at = t;
        let gap = 0.26;
        for (let i = 0; i < 12; i++) {
          const side = i % 2 === 0 ? -1 : 1;
          const po = makeOut(c, side * (0.9 - i * 0.06), 0.5);
          lowBell(c, po, at, NODES[i % NODES.length]! * (1 + Math.floor(i / 6) * 0.5), CHAIN, {
            decay: 0.7,
            gain: 0.05 + 0.003 * i,
          });
          at += gap;
          gap *= 0.86;
        }
        grind(c, o, t, { dur: 2.4, gain: 0.12, f0: 120, f1: 420, rate: 6, metal: true, attack: 1.6 });
        swell(c, o, t, { dur: 2.4, gain: 0.16, f0: 80, f1: 900, sub: 0.1, subHz: 38 });
        catastrophe(c, subOut(c, 0), o, t + 2.4, { pre: 0, size: 0.6, gain: 0.85, f0: 55 });
        clank(c, t + 2.4, 0, NODES[0]! * 0.75, 1, 1, 0.8);
      } else {
        for (let i = 0; i < 4; i++)
          lowBell(c, o, t + i * 0.18, NODES[3 - i]!, CHAIN, { decay: 1.2, gain: 0.06 });
      }
    },

    onMatter(c, t, ev) {
      const pan = c.panOf(ev.x);
      const m = clamp01(Math.log10(Math.max(1, ev.mass)) / 3);
      switch (ev.kind) {
        case 'harvest':
          harvest(c, t, pan, m);
          return true;
        case 'consume':
          lock(c, t, pan, m);
          return true;
        case 'detach':
          snap(c, t, pan, 0.8 + 0.8 * m);
          return true;
        default:
          return false;
      }
    },

    onCue(c, t, ev) {
      const pan = c.panOf(ev.x);
      const a = clamp01(ev.amount);
      switch (cueKind(ev.id)) {
        case 'sever':
        case 'break':
          snap(c, t, pan, 1.4 + 0.6 * a);
          return;
        case 'dark': {
          // a node goes dark: its bell tolls down, three times, each lower
          const o = makeOut(c, pan, 0.55);
          for (let i = 0; i < 3; i++)
            lowBell(c, o, t + i * 0.16, NODES[4 - i]! * 1.0, CHAIN, {
              decay: 1.1,
              gain: 0.16 * (1 - i * 0.2),
            });
          rumble(c, o, t, { dur: 1.2, gain: 0.08, f0: 220, f1: 70 });
          return;
        }
        case 'harvest':
          harvest(c, t, pan, a, 1.4);
          return;
        case 'latch':
          lock(c, t, pan, 0.6 + 0.4 * a, 1.3);
          return;
        case 'merge':
          clank(c, t, pan, NODES[0]! * 1.5, 0.5, 1, 0.5, 2);
          lowBell(c, makeOut(c, pan, 0.6), t + 0.03, NODES[2]! * 1.5, CHAIN, { decay: 1, gain: 0.1 });
          return;
        default:
          clank(c, t, pan, pick(c, NODES) * 1.5, 0.35 + 0.3 * a, 1, 0.4, 1.8);
      }
    },

    update(c, scene, slot) {
      const ac = c.ac;
      let p = pulses.get(slot);
      if (!p) {
        const bed = createBed(c, 0.3);
        // the pulse: a sine at 43-55 Hz whose gain is driven by a heartbeat-shaped LFO, saturated so its harmonics carry
        const sub = bed.run(ac.createOscillator());
        sub.type = 'sine';
        sub.frequency.value = 48;
        const sh = saturator(c, 2.6);
        const shLp = ac.createBiquadFilter();
        shLp.type = 'lowpass';
        shLp.frequency.value = 360;
        const beat = silentGain(c, bed.input);
        sub.connect(sh);
        sh.connect(shLp);
        shLp.connect(beat);
        const lfo = ac.createOscillator();
        lfo.setPeriodicWave(ac.createPeriodicWave(HEART.real, HEART.imag));
        lfo.frequency.value = 0.8;
        const beatDepth = ac.createGain();
        beatDepth.gain.value = 0;
        lfo.connect(beatDepth);
        beatDepth.connect(beat.gain);
        bed.run(lfo);
        // a low metallic hum of the machinery (inharmonic) and the chains' grinding rattle that follows movement
        const humLp = ac.createBiquadFilter();
        humLp.type = 'lowpass';
        humLp.frequency.value = 520;
        const hum = silentGain(c, bed.input);
        humLp.connect(hum);
        // (an octave above the pulse's band, so it never beats against the heartbeat)
        for (const [i, f] of [138.59, 208.2, 312.6].entries()) {
          const o = bed.run(ac.createOscillator());
          o.type = i === 0 ? 'triangle' : 'sine';
          o.frequency.value = f;
          o.detune.value = (i - 1) * 6;
          const og = ac.createGain();
          og.gain.value = [0.6, 0.35, 0.22][i]!;
          o.connect(og);
          og.connect(humLp);
        }
        const rattle = silentGain(c, bed.input);
        noiseBand(c, bed, rattle, { kind: 'white', type: 'bandpass', f: 900, q: 2 });
        p = { bed, sub, lfo, beat, beatDepth, hum, rattle };
        pulses.set(slot, p);
      }
      const now = ac.currentTime;
      const alive = clamp01(scene.resource); // how much of the graph is still lit: more nodes, a faster pulse
      const move = clamp01(scene.speed / 600);
      const mass = clamp(scene.massFrac, 0.2, 1.4);
      p.lfo.frequency.setTargetAtTime(0.75 + 1.5 * alive, now, 0.4);
      p.sub.frequency.setTargetAtTime(43 + 12 * alive, now, 0.4);
      const depth = 0.04 + 0.03 * mass;
      p.beat.gain.setTargetAtTime(depth * 0.13, now, 0.2); // the LFO's DC is removed, so keep the trough at silence
      p.beatDepth.gain.setTargetAtTime(depth, now, 0.2);
      p.hum.gain.setTargetAtTime(0.006 + 0.012 * move, now, 0.3);
      p.rattle.gain.setTargetAtTime(0.003 + 0.03 * move, now, 0.15);
      p.bed.pan.pan.setTargetAtTime(clamp(c.panOf(scene.x), -1, 1), now, 0.1);
    },

    stop(slot) {
      for (const s of slot === 'all' ? [...pulses.keys()] : [slot]) {
        pulses.get(s)?.bed.dispose();
        pulses.delete(s);
      }
    },
  };
}
